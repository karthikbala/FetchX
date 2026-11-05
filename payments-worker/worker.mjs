import {
 BROKER_MAX_BODY,BROKER_PATH,BROKER_SECRET,BROKER_TIME_WINDOW,EVENT_SUBJECTS,KEY_ID,PACK_AMOUNTS,PACK_OFFERS,
 RELAY_PATH,RELAY_TIME_WINDOW,SHA256,STRIPE_MAX_BODY,STRIPE_VERSION,STRIPE_WEBHOOK_PATH,
 audience,brokerMessage,checkoutForm,customerForm,epoch,exact,fresh,hex,relayMessage,sessionPrefix,sha256,
 stripeId,stripeChargeId,stripeRefundId,stripeSubjectId,utf8,uuid,currencyPaymentMethod,
} from '../src/control-stripe-broker-protocol.mjs';

const STRIPE_API='https://api.stripe.com/v1';
const decode=new TextDecoder('utf-8',{fatal:true});
const COMMANDS=Object.freeze({
 account:[],
 'price.get':['price_id'],
 'customer.create':['creation_key'],
 'checkout.create':['order_id','customer_id','price_id','expires_at','return_origin'],
 'checkout.get':['session_id'],
 'checkout.line_items':['session_id'],
 'checkout.by_payment_intent':['intent_id'],
 'payment_intent.get':['intent_id'],
 'charge.get':['charge_id'],
 'dispute.get':['dispute_id'],
 'refund.get':['refund_id'],
});
const WRITES=new Set(['customer.create','checkout.create']);

class WorkerError extends Error {
 constructor(code,status){super(code);this.code=code;this.status=status;}
}
function fail(code,status=400){throw new WorkerError(code,status);}
const match=(value,pattern)=>typeof value==='string'&&pattern.test(value);
const jsonResponse=(value,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const selected=(object,keys)=>Object.fromEntries(keys.filter(key=>Object.hasOwn(object,key)).map(key=>[key,object[key]]));
const validObject=(value,object,id,settings)=>value?.object===object&&value.id===id&&value.livemode===(settings.mode==='live');

function httpsUrl(value,expectedPath){
 try{
  const url=new URL(value);
  if(url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname===expectedPath)return url;
 }catch{}
 return null;
}
function settings(env){
 const {STRIPE_MODE:mode,STRIPE_ACCOUNT_ID:accountId,STRIPE_API_KEY:apiKey,STRIPE_WEBHOOK_SECRET:webhookSecret,
  BROKER_AUTH_SECRET:brokerSecret,RELAY_KEY_ID:relayKeyId,STRIPE_RELAY_ED25519_PKCS8:relayPrivateKey}=env;
 const returnUrl=httpsUrl(env.CHECKOUT_RETURN_ORIGIN,'/'),relayUrl=httpsUrl(env.GATEWAY_RELAY_URL,RELAY_PATH);
 if(!['live','test'].includes(mode)||!stripeId(accountId,'acct')||
  !match(apiKey,new RegExp('^rk_'+mode+'_[A-Za-z0-9_]{12,256}$'))||!match(webhookSecret,/^whsec_[A-Za-z0-9_]{16,256}$/)||
  !match(brokerSecret,BROKER_SECRET)||!match(relayKeyId,KEY_ID)||!match(relayPrivateKey,/^[A-Za-z0-9+/]{40,160}={0,2}$/)||
  !returnUrl||returnUrl.origin!==env.CHECKOUT_RETURN_ORIGIN||!relayUrl)fail('worker_configuration_invalid',503);
 let prices;
 try{prices=JSON.parse(env.STRIPE_PRICE_IDS);}catch{fail('worker_configuration_invalid',503);}
 const ids=prices&&typeof prices==='object'&&!Array.isArray(prices)?Object.keys(prices):[];
 if(!ids.length||mode==='live'&&(!Object.keys(PACK_AMOUNTS).every(id=>ids.includes(id))||
  ids.length!==4&&ids.length!==8)||
  ids.some(id=>!Object.hasOwn(PACK_OFFERS,id)||!stripeId(prices[id],'price'))||new Set(Object.values(prices)).size!==ids.length)
  fail('worker_configuration_invalid',503);
 const offersByPrice=new Map(ids.map(id=>[prices[id],PACK_OFFERS[id]]));
 return {mode,accountId,apiKey,webhookSecret,brokerSecret,relayKeyId,relayPrivateKey,offersByPrice,
  returnOrigin:returnUrl.origin,relayUrl:relayUrl.href,audience:audience(mode,accountId)};
}

async function boundedBody(message,limit){
 const length=message.headers.get('content-length');
 if(length!==null&&(!/^\d+$/.test(length)||Number(length)>limit))fail('body_too_large',413);
 if(!message.body)return new Uint8Array();
 const reader=message.body.getReader(),chunks=[];
 let size=0;
 try{
  for(;;){
   const {done,value}=await reader.read();
   if(done)break;
   size+=value.byteLength;
   if(size>limit){await reader.cancel();fail('body_too_large',413);}
   chunks.push(value);
  }
 }finally{reader.releaseLock();}
 const raw=new Uint8Array(size);
 let offset=0;
 for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.length;}
 return raw;
}
function parse(raw){
 try{return JSON.parse(decode.decode(raw));}catch{fail('json_invalid');}
}
function hexBytes(value){
 return Uint8Array.from(value.match(/../g),byte=>Number.parseInt(byte,16));
}
async function hmacKey(secret){
 return crypto.subtle.importKey('raw',utf8(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
}
async function authorizeBroker(request,config,raw){
 const time=request.headers.get('x-fetchx-broker-timestamp'),signature=request.headers.get('x-fetchx-broker-signature');
 if(!fresh(time,BROKER_TIME_WINDOW)||!match(signature,SHA256))fail('broker_unauthorized',401);
 const message=brokerMessage(config.audience,time,await sha256(raw));
 if(!await crypto.subtle.verify('HMAC',await hmacKey(config.brokerSecret),hexBytes(signature),message))fail('broker_unauthorized',401);
}
async function verifiedStripeEvent(config,raw,header){
 if(!header||header.length>2048||!raw.length)fail('stripe_signature_invalid',400);
 const fields=header.split(',').map(part=>part.trim()),timestamps=fields.filter(part=>part.startsWith('t='));
 const time=timestamps[0]?.slice(2),signatures=fields.filter(part=>/^v1=[a-f0-9]{64}$/i.test(part));
 if(timestamps.length!==1||!fresh(time,RELAY_TIME_WINDOW)||!signatures.length)fail('stripe_signature_invalid',400);
 const prefix=utf8(time+'.'),message=new Uint8Array(prefix.length+raw.length),key=await hmacKey(config.webhookSecret);
 message.set(prefix);message.set(raw,prefix.length);
 const valid=await Promise.all(signatures.map(signature=>crypto.subtle.verify('HMAC',key,hexBytes(signature.slice(3)),message)));
 if(!valid.some(Boolean))fail('stripe_signature_invalid',400);
 const event=parse(raw);
 if(event?.object!=='event'||event.livemode!==(config.mode==='live')||!stripeId(event.id,'evt')||
  typeof event.type!=='string'||event.account!=null||event.context!=null)fail('stripe_event_invalid',400);
 if(!Object.hasOwn(EVENT_SUBJECTS,event.type))return null;
 const expected=EVENT_SUBJECTS[event.type],subject=event.data?.object;
 if(subject?.object!==expected||!stripeSubjectId(subject.id,expected,config.mode))fail('stripe_event_invalid',400);
 return {v:1,mode:config.mode,account_id:config.accountId,event_id:event.id,event_type:event.type,subject_id:subject.id,
  provider_payload_sha256:await sha256(raw)};
}
async function relayEvent(config,event,outbound){
 const body=JSON.stringify(event),time=String(epoch());
 const key=await crypto.subtle.importKey('pkcs8',Uint8Array.from(atob(config.relayPrivateKey),c=>c.charCodeAt(0)),'Ed25519',false,['sign']);
 const message=relayMessage(config.audience,time,config.relayKeyId,await sha256(utf8(body)));
 const signature=hex(new Uint8Array(await crypto.subtle.sign('Ed25519',key,message)));
 const response=await outbound(config.relayUrl,{method:'POST',body,redirect:'manual',signal:AbortSignal.timeout(7000),headers:{
  'Content-Type':'application/json','X-FetchX-Relay-Timestamp':time,'X-FetchX-Relay-Key-Id':config.relayKeyId,'X-FetchX-Relay-Signature':signature,
 }});
 try{
  if(!response.ok){await response.body?.cancel();fail('relay_unconfirmed',502);}
  const result=parse(await boundedBody(response,1024));
  if(!exact(result,['received'])||result.received!==true)fail('relay_unconfirmed',502);
 }catch{fail('relay_unconfirmed',502);}
}

class StripeOperations {
 constructor(config,outbound){this.config=config;this.outbound=outbound;}
 async stripe(path,body,key){
  const headers={Authorization:'Bearer '+this.config.apiKey,'Stripe-Version':STRIPE_VERSION};
  if(body){headers['Content-Type']='application/x-www-form-urlencoded';headers['Idempotency-Key']=key;}
  try{
   const response=await this.outbound(STRIPE_API+path,{method:body?'POST':'GET',headers,body,redirect:'manual',signal:AbortSignal.timeout(7000)});
   if(!response.ok){await response.body?.cancel();fail('stripe_unconfirmed',502);}
   return parse(await boundedBody(response,STRIPE_MAX_BODY));
  }catch{fail('stripe_unconfirmed',502);}
 }
 async account(){
  const value=await this.stripe('/account');
  if(value?.object!=='account'||value.id!==this.config.accountId)fail('stripe_account_mismatch',502);
  return {object:value.object,id:value.id};
 }
 priceView(value,expectedId,offer){
  if(!validObject(value,'price',expectedId,this.config)||value.currency!==offer?.currency||value.type!=='one_time'||
   value.unit_amount!==offer.amountMinor||value.billing_scheme!=='per_unit'||value.recurring!=null||value.transform_quantity!=null||
   value.custom_unit_amount!=null)fail('stripe_price_mismatch',502);
  return selected(value,['id','object','livemode','active','currency','type','unit_amount','billing_scheme','recurring','transform_quantity','custom_unit_amount']);
 }
 async price(id){
  const offer=this.config.offersByPrice.get(id);
  if(!offer)fail('stripe_price_rejected');
  const result=this.priceView(await this.stripe('/prices/'+id),id,offer);
  if(result.active!==true)fail('stripe_price_mismatch',502);
  return result;
 }
 customerView(value,id){
  if(!validObject(value,'customer',id,this.config)||!stripeId(id,'cus')||!uuid(value.metadata?.fetchx_customer))fail('stripe_customer_mismatch',502);
  return {...selected(value,['id','object','livemode']),metadata:{fetchx_customer:value.metadata.fetchx_customer}};
 }
 async customer(id){return this.customerView(await this.stripe('/customers/'+id),id);}
 async createCustomer(key){
  const value=await this.stripe('/customers',customerForm(key),'fetchx-customer-'+key);
  const result=this.customerView(value,value?.id);
  if(result.metadata.fetchx_customer!==key)fail('stripe_customer_mismatch',502);
  return result;
 }
 sessionView(value,id){
  if(!validObject(value,'checkout.session',id,this.config)||!stripeId(id,sessionPrefix(this.config.mode))||
   value.mode!=='payment'||!uuid(value.client_reference_id)||!stripeId(value.customer,'cus')||!currencyPaymentMethod(value.currency)||
   !Array.isArray(value.payment_method_types)||value.payment_method_types.length!==1||value.payment_method_types[0]!==currencyPaymentMethod(value.currency)||
   value.amount_subtotal!==value.amount_total||![...this.config.offersByPrice.values()].some(offer=>offer.currency===value.currency&&offer.amountMinor===value.amount_total)||
   !['open','complete','expired'].includes(value.status)||!['unpaid','paid'].includes(value.payment_status)||
   value.success_url!==this.config.returnOrigin+'/app/billing?checkout=success'||
   value.cancel_url!==this.config.returnOrigin+'/app/billing?checkout=cancelled'||
   value.automatic_tax?.enabled!==false||value.allow_promotion_codes===true||
   value.total_details?.amount_discount!==0||value.total_details?.amount_tax!==0||value.total_details?.amount_shipping!==0||
   value.payment_intent!=null&&!stripeId(value.payment_intent,'pi'))fail('stripe_checkout_mismatch',502);
  const result=selected(value,['id','object','livemode','mode','client_reference_id','customer','amount_subtotal','amount_total','currency','status','payment_status','payment_intent','payment_method_types']);
  if(value.status==='open'&&value.payment_status==='unpaid'&&typeof value.url==='string'&&value.url.length<=4096){
   const url=new URL(value.url);
   if(url.origin==='https://checkout.stripe.com'&&!url.username&&!url.password&&url.pathname==='/c/pay/'+id)result.url=url.href;
  }
  return result;
 }
 async session(id){
  const result=this.sessionView(await this.stripe('/checkout/sessions/'+id),id);
  await this.customer(result.customer);
  return result;
 }
 async createCheckout(input){
  if(input.return_origin!==this.config.returnOrigin||!Number.isSafeInteger(input.expires_at)||
   input.expires_at<=epoch()||input.expires_at>epoch()+3660)fail('stripe_checkout_rejected');
  const [price]=await Promise.all([this.price(input.price_id),this.customer(input.customer_id)]);
  const form=new URLSearchParams(checkoutForm({orderId:input.order_id,customerId:input.customer_id,priceId:input.price_id,
   expiresAt:input.expires_at,returnOrigin:this.config.returnOrigin,paymentMethod:currencyPaymentMethod(price.currency)}));
  // Endive removed the old create parameter. Translate only the Stripe wire
  // form; the gateway's durable canonical form and idempotency stay unchanged.
  form.delete('payment_method_types[0]');
  form.set('allowed_payment_method_types[0]',currencyPaymentMethod(price.currency));
  const value=await this.stripe('/checkout/sessions',form.toString(),'fetchx-checkout-'+input.order_id),result=this.sessionView(value,value?.id);
  if(result.client_reference_id!==input.order_id||result.customer!==input.customer_id||result.amount_total!==price.unit_amount||result.currency!==price.currency)fail('stripe_checkout_mismatch',502);
  return result;
 }
 async lineItems(id){
  const session=await this.session(id),list=await this.stripe('/checkout/sessions/'+id+'/line_items?limit=2');
  const line=list?.data?.[0];
  if(list?.object!=='list'||list.has_more!==false||list.data?.length!==1||line?.object!=='item'||!stripeId(line.price?.id,'price')||
   line.quantity!==1||line.currency!==session.currency||line.amount_subtotal!==session.amount_total||line.amount_total!==session.amount_total||
   line.amount_tax!==0||line.amount_discount!==0||this.config.offersByPrice.get(line.price.id)?.currency!==session.currency||
   this.config.offersByPrice.get(line.price.id)?.amountMinor!==session.amount_total)fail('stripe_price_mismatch',502);
  return {object:'list',has_more:false,data:[{...selected(line,['object','quantity','currency','amount_subtotal','amount_total','amount_tax','amount_discount']),
   price:this.priceView(line.price,line.price.id,this.config.offersByPrice.get(line.price.id))}]};
 }
 async intent(id){
  const value=await this.stripe('/payment_intents/'+id);
  if(!validObject(value,'payment_intent',id,this.config)||!uuid(value.metadata?.fetchx_checkout)||
   !stripeId(value.customer,'cus')||![...this.config.offersByPrice.values()].some(offer=>offer.currency===value.currency&&offer.amountMinor===value.amount)||
   value.latest_charge!=null&&!stripeChargeId(value.latest_charge))fail('stripe_payment_mismatch',502);
  await this.customer(value.customer);
  return {...selected(value,['id','object','livemode','customer','status','amount','amount_received','currency','latest_charge']),
   metadata:{fetchx_checkout:value.metadata.fetchx_checkout}};
 }
 async charge(id){
  const value=await this.stripe('/charges/'+id);
  if(!validObject(value,'charge',id,this.config)||!stripeId(value.payment_intent,'pi'))fail('stripe_charge_mismatch',502);
  const intent=await this.intent(value.payment_intent);
  if(intent.customer!==value.customer||intent.amount!==value.amount||value.currency!==intent.currency||
   value.payment_method_details?.type!==currencyPaymentMethod(value.currency))fail('stripe_charge_mismatch',502);
  return {...selected(value,['id','object','livemode','payment_intent','customer','paid','captured','amount','amount_captured',
   'currency','amount_refunded','disputed','created','refunded']),payment_method_details:{type:value.payment_method_details?.type}};
 }
 async refund(id){
  const value=await this.stripe('/refunds/'+id);
  // Refund objects do not expose livemode. The tagged Charge -> PaymentIntent
  // -> Customer chain proves the account and mode before any data is relayed.
  if(value?.object!=='refund'||value.id!==id||!stripeChargeId(value.charge)||!stripeId(value.payment_intent,'pi')||
   !Number.isSafeInteger(value.amount)||value.amount<=0||!['pending','requires_action','succeeded','failed','canceled'].includes(value.status))
   fail('stripe_refund_mismatch',502);
  const charge=await this.charge(value.charge);
  if(charge.payment_intent!==value.payment_intent||charge.currency!==value.currency||value.amount>charge.amount)
   fail('stripe_refund_mismatch',502);
  return selected(value,['id','object','amount','currency','charge','payment_intent','status']);
 }
 async dispute(id){
  const value=await this.stripe('/disputes/'+id);
  if(!validObject(value,'dispute',id,this.config)||!stripeChargeId(value.charge))fail('stripe_dispute_mismatch',502);
  await this.charge(value.charge);
  return selected(value,['id','object','livemode','charge','status']);
 }
 async sessionByIntent(id){
  const intent=await this.intent(id);
  const params=new URLSearchParams({payment_intent:id,limit:'2'});
  const list=await this.stripe('/checkout/sessions?'+params);
  if(list?.object!=='list'||list.has_more!==false||!Array.isArray(list.data)||list.data.length>1)fail('stripe_checkout_mismatch',502);
  const data=list.data.map(value=>{
   const session=this.sessionView(value,value?.id);
   if(session.customer!==intent.customer||session.payment_intent!==id||session.client_reference_id!==intent.metadata.fetchx_checkout)
    fail('stripe_checkout_mismatch',502);
   delete session.url;
   return session;
  });
  return {object:'list',has_more:false,data};
 }
}

async function broker(request,env,config,outbound,raw){
 await authorizeBroker(request,config,raw);
 const command=parse(raw);
 if(typeof command?.op!=='string'||!Object.hasOwn(COMMANDS,command.op)||!exact(command,['op',...COMMANDS[command.op]]))fail('broker_operation_rejected');
 if('price_id'in command&&!stripeId(command.price_id,'price')||'customer_id'in command&&!stripeId(command.customer_id,'cus')||
  'session_id'in command&&!stripeId(command.session_id,sessionPrefix(config.mode))||
  'intent_id'in command&&!stripeId(command.intent_id,'pi')||'charge_id'in command&&!stripeChargeId(command.charge_id)||
  'dispute_id'in command&&!stripeId(command.dispute_id,'dp')||'refund_id'in command&&!stripeRefundId(command.refund_id)||'creation_key'in command&&!uuid(command.creation_key)||
  'order_id'in command&&!uuid(command.order_id))fail('broker_operation_rejected');
 if(typeof env.BROKER_RATE_LIMIT?.limit!=='function'||typeof env.BROKER_WRITE_RATE_LIMIT?.limit!=='function')fail('broker_rate_limit_unavailable',503);
 if(!(await env.BROKER_RATE_LIMIT.limit({key:config.audience})).success||
  WRITES.has(command.op)&&!(await env.BROKER_WRITE_RATE_LIMIT.limit({key:config.audience})).success)fail('broker_rate_limited',429);
 const stripe=new StripeOperations(config,outbound),account=await stripe.account();
 switch(command.op){
 case 'account':return account;
 case 'price.get':return stripe.price(command.price_id);
 case 'customer.create':return stripe.createCustomer(command.creation_key);
 case 'checkout.create':return stripe.createCheckout(command);
 case 'checkout.get':return stripe.session(command.session_id);
 case 'checkout.line_items':return stripe.lineItems(command.session_id);
 case 'checkout.by_payment_intent':return stripe.sessionByIntent(command.intent_id);
 case 'payment_intent.get':return stripe.intent(command.intent_id);
 case 'charge.get':return stripe.charge(command.charge_id);
 case 'dispute.get':return stripe.dispute(command.dispute_id);
 case 'refund.get':return stripe.refund(command.refund_id);
 default:fail('broker_operation_rejected');
 }
}

export function paymentWorker(outbound=globalThis.fetch.bind(globalThis)){
 return {async fetch(request,env){
  const url=new URL(request.url),path=url.pathname;
  if(request.method!=='POST'||url.protocol!=='https:'||url.search||url.hash||![BROKER_PATH,STRIPE_WEBHOOK_PATH].includes(path))return jsonResponse({error:'not_found'},404);
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??''))return jsonResponse({error:'content_type_invalid'},415);
  try{
   const config=settings(env);
   const raw=await boundedBody(request,path===BROKER_PATH?BROKER_MAX_BODY:STRIPE_MAX_BODY);
   if(path===BROKER_PATH)return jsonResponse(await broker(request,env,config,outbound,raw));
   const event=await verifiedStripeEvent(config,raw,request.headers.get('stripe-signature'));
   if(event)await relayEvent(config,event,outbound);
   return jsonResponse({received:true});
  }catch(error){
   return error instanceof WorkerError?jsonResponse({error:error.code},error.status):jsonResponse({error:'worker_unconfirmed'},502);
  }
 }};
}

export default paymentWorker();
