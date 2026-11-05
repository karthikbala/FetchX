import {createHash,createHmac,createPublicKey,timingSafeEqual,verify} from 'node:crypto';
import {fail} from './policy.mjs';
import {paidCreditPack} from './control-paid-credits.mjs';
import {
 BROKER_MAX_BODY,BROKER_PATH,BROKER_SECRET,EVENT_SUBJECTS,KEY_ID,RELAY_TIME_WINDOW,SHA256,
 STRIPE_VERSION,audience,brokerMessage,checkoutForm,customerForm,exact,fresh,relayMessage,sessionPrefix,subjectPrefix,
} from './control-stripe-broker-protocol.mjs';

export {STRIPE_VERSION};
export const STRIPE_BODY_LIMIT=128*1024;
export const STRIPE_CREATE_WINDOW_MS=60*60*1000;
export const STRIPE_UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const PRICE=/^price_[A-Za-z0-9]{1,200}$/;
const PLAN_ID=/^[a-z][a-z0-9_-]{0,39}$/;
const VERSION=/^[A-Za-z0-9_.-]{1,80}$/;
const decode=new TextDecoder('utf-8',{fatal:true});
export const stripeHash=value=>createHash('sha256').update(value).digest('hex');
export const stripeMatches=(value,pattern)=>typeof value==='string'&&pattern.test(value);
export function stripeId(value,prefix){
 return typeof value==='string'&&value.startsWith(prefix+'_')&&/^[A-Za-z0-9]{1,200}$/.test(value.slice(prefix.length+1));
}
export function stripeObject(value,object,id,config){
 return value?.object===object&&value.id===id&&value.livemode===(config.mode==='live');
}
function pinnedHttps(value,path){
 try{
  const url=new URL(value);
  if(url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname===path)return url;
 }catch{}
 return null;
}
function relayKey(value){
 if(!stripeMatches(value,/^[A-Za-z0-9+/]{40,160}={0,2}$/))return null;
 try{
  const key=createPublicKey({key:Buffer.from(value,'base64'),format:'der',type:'spki'});
  if(key.asymmetricKeyType==='ed25519')return key;
 }catch{}
 return null;
}
export function stripeSettings(config,{allowDirect=false}={}){
 const value=config.controlPlane?.stripe;
 if(!value||!['test','live'].includes(value.mode)||!stripeId(value.accountId,'acct'))return null;
 const transport=value.transport??'direct';
 let relayKeys;
 if(transport==='broker'){
  const origin=pinnedHttps(value.brokerReturnOrigin,'/');
  const keys=value.relayPublicKeys&&typeof value.relayPublicKeys==='object'&&!Array.isArray(value.relayPublicKeys)?Object.entries(value.relayPublicKeys):[];
  if(Object.hasOwn(value,'secretKey')||Object.hasOwn(value,'webhookSecret')||!pinnedHttps(value.brokerUrl,BROKER_PATH)||
   !origin||origin.origin!==value.brokerReturnOrigin||!config.controlPlane.origins?.includes(value.brokerReturnOrigin)||
   !stripeMatches(value.brokerAuthSecret,BROKER_SECRET)||keys.length<1||keys.length>2||
   keys.some(([id,key])=>!KEY_ID.test(id)||!relayKey(key)))return null;
  relayKeys=new Map(keys.map(([id,key])=>[id,relayKey(key)]));
 }else if(transport!=='direct'||!allowDirect||
  !stripeMatches(value.secretKey,new RegExp('^(?:sk|rk)_'+value.mode+'_[A-Za-z0-9_]{12,256}$'))||
  !stripeMatches(value.webhookSecret,/^whsec_[A-Za-z0-9_]{16,256}$/))return null;
 const projects=value.allowedProjects??[];
 if(!Array.isArray(projects)||!projects.every(project=>typeof project==='string'&&project.startsWith('cp_')&&STRIPE_UUID.test(project.slice(3))))return null;
 if(value.mode==='test'&&value.allowAllProjects===true)return null;
 const salesEnabled=config.controlPlane.enabled===true&&value.enabled===true;
 if(salesEnabled&&(value.mode==='test'&&!projects.length||value.mode==='live'&&(value.commercialReviewed!==true||!projects.length&&value.allowAllProjects!==true)))return null;
 const plans=value.catalog??[];
 if(!Array.isArray(plans)||salesEnabled&&!plans.length||plans.length>4)return null;
 for(const plan of plans){
  if(!stripeMatches(plan?.id,PLAN_ID)||typeof plan.name!=='string'||plan.name.length<1||plan.name.length>80||!stripeMatches(plan.version,VERSION)||!stripeMatches(plan.priceId,PRICE)||
   !approvedPaidCreditPlan(plan))return null;
 }
 if(new Set(plans.map(p=>p.id)).size!==plans.length||new Set(plans.map(p=>p.priceId)).size!==plans.length||new Set(plans.map(p=>p.amountMinor)).size!==plans.length)return null;
 return {...value,transport,relayKeys,catalog:plans,allowedProjects:projects,salesEnabled};
}
export function approvedPaidCreditPlan(plan){
 return plan?.currency==='usd'&&Number.isSafeInteger(plan.credits)&&plan.credits>0&&
  paidCreditPack(plan.amountMinor)===plan.credits&&plan.id==='credits-'+plan.credits&&
  plan.name===plan.credits.toLocaleString('en-US')+' credits';
}
export async function lockStripeSales(client,mode){
 if(mode==='live')await client.query('SELECT pg_advisory_xact_lock(170017,6)');
}
export function stripeProjectAllowed(config,project){
 return config.mode==='live'&&config.allowAllProjects===true||config.allowedProjects.includes(project);
}

export function verifiedStripeEvent(body,header,config){
 if(!Buffer.isBuffer(body)||!body.length||typeof header!=='string'||header.length>2048)fail('stripe_signature_invalid',400);
 const parts=header.split(',').map(part=>part.trim());
 const timestamps=parts.filter(part=>part.startsWith('t='));
 const signatures=parts.filter(part=>/^v1=[a-f0-9]{64}$/i.test(part));
 const time=timestamps[0]?.slice(2);
 if(timestamps.length!==1||!stripeMatches(time,/^\d{1,12}$/)||Math.abs(Math.floor(Date.now()/1000)-Number(time))>300||!signatures.length)fail('stripe_signature_invalid',400);
 const expected=createHmac('sha256',config.webhookSecret).update(time+'.').update(body).digest();
 let verified=0;
 for(const signature of signatures)verified|=Number(timingSafeEqual(expected,Buffer.from(signature.slice(3),'hex')));
 if(!verified)fail('stripe_signature_invalid',400);
 let event;
 try{event=JSON.parse(decode.decode(body));}catch{fail('stripe_event_invalid',400);}
 if(event?.object!=='event'||event.livemode!==(config.mode==='live')||!stripeId(event.id,'evt')||
  typeof event.type!=='string'||event.account!=null||event.context!=null)fail('stripe_event_invalid',400);
 return event;
}

export function verifiedStripeRelay(body,headers,config){
 const time=headers['x-fetchx-relay-timestamp'],kid=headers['x-fetchx-relay-key-id'],signature=headers['x-fetchx-relay-signature'];
 const key=stripeMatches(kid,KEY_ID)?config.relayKeys.get(kid):null;
 if(!Buffer.isBuffer(body)||!body.length||body.length>BROKER_MAX_BODY||!fresh(time,RELAY_TIME_WINDOW)||
  !key||!stripeMatches(signature,/^[a-f0-9]{128}$/))fail('stripe_relay_signature_invalid',400);
 const message=relayMessage(audience(config.mode,config.accountId),time,kid,stripeHash(body));
 if(!verify(null,message,key,Buffer.from(signature,'hex')))fail('stripe_relay_signature_invalid',400);
 let value;
 try{value=JSON.parse(decode.decode(body));}catch{fail('stripe_event_invalid',400);}
 if(!exact(value,['v','mode','account_id','event_id','event_type','subject_id','provider_payload_sha256'])||
  value.v!==1||value.mode!==config.mode||value.account_id!==config.accountId||!stripeId(value.event_id,'evt')||
  !Object.hasOwn(EVENT_SUBJECTS,value.event_type)||!stripeId(value.subject_id,subjectPrefix(EVENT_SUBJECTS[value.event_type],config.mode))||
  !stripeMatches(value.provider_payload_sha256,SHA256))fail('stripe_event_invalid',400);
 return value;
}

function brokerCreateCommand(config,path,body,key){
 if(typeof body!=='string'||body.length>BROKER_MAX_BODY)fail('stripe_checkout_reconciliation_required',409);
 const form=new URLSearchParams(body);
 if(path==='/customers'){
  const creationKey=form.get('metadata[fetchx_customer]');
  if(!stripeMatches(creationKey,STRIPE_UUID)||key!=='fetchx-customer-'+creationKey||body!==customerForm(creationKey))
   fail('stripe_checkout_reconciliation_required',409);
  return {op:'customer.create',creation_key:creationKey};
 }
 if(path!=='/checkout/sessions')fail('stripe_broker_operation_invalid',503);
 const orderId=form.get('client_reference_id'),customerId=form.get('customer'),priceId=form.get('line_items[0][price]');
 const rawExpiry=form.get('expires_at'),expiresAt=Number(rawExpiry),returnOrigin=config.brokerReturnOrigin;
 if(!stripeMatches(orderId,STRIPE_UUID)||!stripeId(customerId,'cus')||!stripeMatches(priceId,PRICE)||
  !stripeMatches(rawExpiry,/^\d{1,12}$/)||!Number.isSafeInteger(expiresAt)||key!=='fetchx-checkout-'+orderId||
  body!==checkoutForm({orderId,customerId,priceId,expiresAt,returnOrigin}))fail('stripe_checkout_reconciliation_required',409);
 return {op:'checkout.create',order_id:orderId,customer_id:customerId,price_id:priceId,expires_at:expiresAt,return_origin:returnOrigin};
}
function brokerReadCommand(config,path){
 if(path==='/account')return {op:'account'};
 const byIntent=/^\/checkout\/sessions\?payment_intent=(pi_[A-Za-z0-9]{1,200})&limit=2$/.exec(path);
 if(byIntent)return {op:'checkout.by_payment_intent',intent_id:byIntent[1]};
 const line=/^\/checkout\/sessions\/([^/?]+)\/line_items\?limit=2$/.exec(path);
 if(line&&stripeId(line[1],sessionPrefix(config.mode)))return {op:'checkout.line_items',session_id:line[1]};
 const match=/^\/(prices|checkout\/sessions|payment_intents|charges|disputes)\/([^/?]+)$/.exec(path);
 if(match){
  const [op,field,prefix]={
   prices:['price.get','price_id','price'],'checkout/sessions':['checkout.get','session_id',sessionPrefix(config.mode)],
   payment_intents:['payment_intent.get','intent_id','pi'],charges:['charge.get','charge_id','ch'],
   disputes:['dispute.get','dispute_id','dp'],
  }[match[1]];
  if(stripeId(match[2],prefix))return {op,[field]:match[2]};
 }
 fail('stripe_broker_operation_invalid',503);
}
export class StripeProvider{
 constructor(fetchStripe=fetch){this.fetchStripe=fetchStripe;}
 async request(config,path,{body,key,version=STRIPE_VERSION}={}){
  if(config.transport==='broker'){
   if(version!==STRIPE_VERSION)fail('stripe_checkout_reconciliation_required',409);
   const command=body?brokerCreateCommand(config,path,body,key):brokerReadCommand(config,path);
   const payload=JSON.stringify(command),time=String(Math.floor(Date.now()/1000));
   const message=brokerMessage(audience(config.mode,config.accountId),time,stripeHash(payload));
   const signature=createHmac('sha256',config.brokerAuthSecret).update(message).digest('hex');
   return this.json(config.brokerUrl,{method:'POST',headers:{'Content-Type':'application/json',
    'X-FetchX-Broker-Timestamp':time,'X-FetchX-Broker-Signature':signature},body:payload});
  }
  const headers={Authorization:'Bearer '+config.secretKey,'Stripe-Version':version};
  if(body){headers['Idempotency-Key']=key;headers['Content-Type']='application/x-www-form-urlencoded';}
  return this.json('https://api.stripe.com/v1'+path,{method:body?'POST':'GET',headers,body});
 }
 async json(url,options){
  try{
   const response=await this.fetchStripe(url,{...options,redirect:'error',signal:AbortSignal.timeout(12_000)});
   if(!response.ok||!response.body||Number(response.headers.get('content-length'))>STRIPE_BODY_LIMIT){await response.body?.cancel();throw new Error();}
   const chunks=[];let size=0;
   for await(const chunk of response.body){size+=chunk.byteLength;if(size>STRIPE_BODY_LIMIT)throw new Error();chunks.push(chunk);}
   return JSON.parse(decode.decode(Buffer.concat(chunks,size)));
  }catch{fail('stripe_provider_unconfirmed',502);}
 }
 async assertAccount(config){
  const account=await this.request(config,'/account');
  if(account?.object!=='account'||account.id!==config.accountId)fail('stripe_account_mismatch',503);
 }
 async assertPrice(config,plan){
  const price=await this.request(config,'/prices/'+plan.priceId);
  if(price?.active!==true||!oneTimeStripePrice(price,plan,config))fail('stripe_price_mismatch',503);
 }
}

export function oneTimeStripePrice(price,plan,config){
 return stripeObject(price,'price',plan.priceId,config)&&price.type==='one_time'&&price.unit_amount===plan.amountMinor&&
  price.currency===plan.currency&&price.billing_scheme==='per_unit'&&price.recurring==null&&price.transform_quantity==null&&price.custom_unit_amount==null;
}

export function stripeHostedUrl(value,origin,path){
 if(typeof value!=='string'||value.length>4096)return null;
 try{
  const url=new URL(value);
  if(url.origin===origin&&!url.username&&!url.password&&url.pathname===path)return url.href;
 }catch{}
 return null;
}
