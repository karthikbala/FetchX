import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac,generateKeyPairSync,randomBytes,randomUUID} from 'node:crypto';
import {paymentWorker} from '../payments-worker/worker.mjs';
import {ControlStripe} from '../src/control-stripe.mjs';
import {StripeProvider,stripeSettings,verifiedStripeRelay} from '../src/control-stripe-provider.mjs';
import {BROKER_PATH,RELAY_PATH,STRIPE_VERSION,audience,brokerMessage,checkoutForm,customerForm,epoch} from '../src/control-stripe-broker-protocol.mjs';

const workerOrigin='https://payments.example',websiteOrigin='https://www.example',relayUrl='https://gateway.example'+RELAY_PATH;
const stripeOrigin='https://api.stripe.com/v1';
const plan={id:'credits-10000',name:'10,000 credits',version:'fixture-1',priceId:'price_fixture',amountMinor:200,currency:'usd',credits:10_000};
const makePrice=(overrides={})=>({id:plan.priceId,object:'price',active:true,livemode:false,type:'one_time',unit_amount:200,
 currency:'usd',billing_scheme:'per_unit',recurring:null,...overrides});
const digest=value=>createHash('sha256').update(value).digest('hex');
const checkoutSafety=()=>({success_url:websiteOrigin+'/app/billing?checkout=success',cancel_url:websiteOrigin+'/app/billing?checkout=cancelled',
 automatic_tax:{enabled:false},allow_promotion_codes:false,total_details:{amount_discount:0,amount_tax:0,amount_shipping:0}});

function fixture(){
 const {privateKey,publicKey}=generateKeyPairSync('ed25519'),keyId='fixture-key';
 const secret=randomBytes(32).toString('base64url'),webhookSecret='whsec_SyntheticFixtureOnly';
 const config={controlPlane:{enabled:true,origins:[websiteOrigin],stripe:{enabled:true,mode:'test',accountId:'acct_fixture',
  transport:'broker',brokerUrl:workerOrigin+BROKER_PATH,brokerReturnOrigin:websiteOrigin,brokerAuthSecret:secret,
  relayPublicKeys:{[keyId]:publicKey.export({type:'spki',format:'der'}).toString('base64')},catalog:[plan],allowedProjects:['cp_'+randomUUID()]}}};
 const env={STRIPE_MODE:'test',STRIPE_ACCOUNT_ID:'acct_fixture',STRIPE_API_KEY:'rk_test_SyntheticWorkerOnly',STRIPE_WEBHOOK_SECRET:webhookSecret,
  BROKER_AUTH_SECRET:secret,RELAY_KEY_ID:keyId,STRIPE_RELAY_ED25519_PKCS8:privateKey.export({type:'pkcs8',format:'der'}).toString('base64'),
  STRIPE_PRICE_IDS:JSON.stringify({[plan.id]:plan.priceId}),CHECKOUT_RETURN_ORIGIN:websiteOrigin,GATEWAY_RELAY_URL:relayUrl,
  BROKER_RATE_LIMIT:{limit:async()=>({success:true})},BROKER_WRITE_RATE_LIMIT:{limit:async()=>({success:true})}};
 const stripeCalls=[],relayCalls=[],stripeObjects=new Map();
 let acknowledged=true,accountId=config.controlPlane.stripe.accountId;
 const worker=paymentWorker(async(url,options)=>{
  assert.equal(options.redirect,'manual');
  if(url===relayUrl){
   relayCalls.push({body:Buffer.from(options.body),headers:Object.fromEntries(new Headers(options.headers))});
   return acknowledged?Response.json({received:true}):Response.json({received:false},{status:503});
  }
  assert.ok(url.startsWith(stripeOrigin+'/'));
  const path=url.slice(stripeOrigin.length);
  assert.equal(options.headers.Authorization,'Bearer '+env.STRIPE_API_KEY);
  assert.equal(options.headers['Stripe-Version'],STRIPE_VERSION);
  stripeCalls.push({path,method:options.method,body:options.body,key:options.headers['Idempotency-Key']});
  if(path==='/account')return Response.json({id:accountId,object:'account',email:'private-account@example.com'});
  if(path==='/prices/'+plan.priceId)return Response.json(makePrice({metadata:{private:'value'}}));
  if(path==='/customers'&&options.method==='POST'){
   const customer={id:'cus_fixture',object:'customer',livemode:false,email:'private-customer@example.com',
    metadata:{fetchx_customer:new URLSearchParams(options.body).get('metadata[fetchx_customer]'),private:'value'}};
   stripeObjects.set('/customers/'+customer.id,customer);
   return Response.json(customer);
  }
  if(path==='/checkout/sessions'&&options.method==='POST'){
   const params=new URLSearchParams(options.body),id='cs_test_fixture';
   const session={id,object:'checkout.session',livemode:false,mode:'payment',client_reference_id:params.get('client_reference_id'),
    customer:params.get('customer'),amount_subtotal:200,amount_total:200,currency:'usd',status:'open',payment_status:'unpaid',
    payment_intent:null,...checkoutSafety(),url:'https://checkout.stripe.com/c/pay/'+id+'#private-hosted-token',customer_details:{email:'private-customer@example.com'}};
   stripeObjects.set('/checkout/sessions/'+id,session);
   return Response.json(session);
  }
  assert.ok(stripeObjects.has(path),'unrecognized synthetic Stripe path '+path);
  return Response.json(stripeObjects.get(path));
 });
 const send=(path,body,headers={},options={})=>worker.fetch(new Request(workerOrigin+path,{method:'POST',body,
  headers:{'Content-Type':'application/json',...headers}}),{...env,...options});
 const broker=(command,{time=String(epoch()),body=JSON.stringify(command),signature,envOverrides}={})=>{
  const signed=signature??createHmac('sha256',secret).update(brokerMessage(audience('test','acct_fixture'),time,digest(body))).digest('hex');
  return send(BROKER_PATH,body,{'X-FetchX-Broker-Timestamp':time,'X-FetchX-Broker-Signature':signed},envOverrides);
 };
 const webhook=(raw,signature)=>{
  const time=String(epoch()),signed=signature??`t=${time},v1=${createHmac('sha256',webhookSecret).update(time+'.').update(raw).digest('hex')}`;
  return send('/webhooks/stripe',raw,{'Stripe-Signature':signed});
 };
 const gatewayRequests=[];
 const provider=new StripeProvider(async(url,options)=>{
  gatewayRequests.push({url,options});
  assert.equal(url,workerOrigin+BROKER_PATH);
  assert.equal(new Headers(options.headers).has('Authorization'),false);
  return worker.fetch(new Request(url,options),env);
 });
 return {config,env,stripeCalls,relayCalls,stripeObjects,gatewayRequests,provider,broker,webhook,
  setAcknowledged:value=>{acknowledged=value;},setAccountId:value=>{accountId=value;}};
}

test('gateway broker reconstructs exact durable forms and keeps the Stripe key at the Worker',async()=>{
 const f=fixture(),config=stripeSettings(f.config),creationKey=randomUUID(),orderId=randomUUID(),expiresAt=epoch()+3600;
 assert.ok(config);assert.equal(config.secretKey,undefined);assert.equal(config.webhookSecret,undefined);
 await f.provider.assertAccount(config);await f.provider.assertPrice(config,plan);
 const customer=await f.provider.request(config,'/customers',{body:customerForm(creationKey),key:'fetchx-customer-'+creationKey});
 assert.deepEqual(customer,{id:'cus_fixture',object:'customer',livemode:false,metadata:{fetchx_customer:creationKey}});
 const body=checkoutForm({orderId,customerId:customer.id,priceId:plan.priceId,expiresAt,returnOrigin:websiteOrigin});
 const key='fetchx-checkout-'+orderId,session=await f.provider.request(config,'/checkout/sessions',{body,key});
 assert.equal(session.client_reference_id,orderId);assert.equal(session.customer_details,undefined);
 const replay=await f.provider.request(config,'/checkout/sessions',{body,key});
 assert.deepEqual(replay,session);
 const creates=f.stripeCalls.filter(call=>call.method==='POST'&&call.path==='/checkout/sessions');
 assert.deepEqual(creates,[{path:'/checkout/sessions',method:'POST',body,key},{path:'/checkout/sessions',method:'POST',body,key}]);
 const before=f.gatewayRequests.length;
 for(const wrong of [body.replace('expires_at=','deadline='),body.replace(encodeURIComponent(websiteOrigin),encodeURIComponent('https://attacker.example')),body+'&unused=1']){
  await assert.rejects(f.provider.request(config,'/checkout/sessions',{body:wrong,key}),{code:'stripe_checkout_reconciliation_required'});
 }
 await assert.rejects(f.provider.request(config,'/checkout/sessions',{body,key,version:'2025-01-01.old'}),{code:'stripe_checkout_reconciliation_required'});
 await assert.rejects(f.provider.request(config,'/refunds'),{code:'stripe_broker_operation_invalid'});
 assert.equal(f.gatewayRequests.length,before);
});

test('broker rejects unauthenticated, stale, arbitrary and rate-limited commands',async()=>{
 const f=fixture();
 assert.equal((await f.broker({op:'account'},{signature:'0'.repeat(64)})).status,401);
 assert.equal((await f.broker({op:'account'},{time:String(epoch()-600)})).status,401);
 assert.equal((await f.broker({op:'refund.create'})).status,400);
 assert.equal((await f.broker({op:'account',path:'/payouts'})).status,400);
 assert.equal((await f.broker({op:'checkout.get',session_id:'cs_live_other'})).status,400);
 assert.equal((await f.broker({op:'account'},{body:' '.repeat(4097)})).status,413);
 assert.equal((await f.broker({op:'account'},{envOverrides:{BROKER_RATE_LIMIT:null}})).status,503);
 assert.equal((await f.broker({op:'account'},{envOverrides:{BROKER_RATE_LIMIT:{limit:async()=>({success:false})}}})).status,429);
 assert.equal((await f.broker({op:'customer.create',creation_key:randomUUID()},
  {envOverrides:{BROKER_WRITE_RATE_LIMIT:{limit:async()=>({success:false})}}})).status,429);
 assert.equal(f.stripeCalls.length,0);
 f.setAccountId('acct_wrong');
 assert.equal((await f.broker({op:'account'})).status,502);
 assert.equal((await f.broker({op:'customer.create',creation_key:randomUUID()})).status,502);
 assert.equal(f.stripeCalls.some(call=>call.method==='POST'),false);
});

test('broker canonical reads are bounded to tagged FetchX objects and minimize data',async()=>{
 const f=fixture(),config=stripeSettings(f.config),orderId=randomUUID(),creationKey=randomUUID();
 f.stripeObjects.set('/customers/cus_fixture',{id:'cus_fixture',object:'customer',livemode:false,metadata:{fetchx_customer:creationKey}});
 const session={id:'cs_test_fixture',object:'checkout.session',livemode:false,mode:'payment',client_reference_id:orderId,
  customer:'cus_fixture',amount_subtotal:200,amount_total:200,currency:'usd',status:'complete',payment_status:'paid',payment_intent:'pi_fixture',
  customer_details:{email:'private-customer@example.com'},...checkoutSafety()};
 f.stripeObjects.set('/checkout/sessions/'+session.id,session);
 f.stripeObjects.set('/checkout/sessions/'+session.id+'/line_items?limit=2',{object:'list',has_more:false,data:[{
  object:'item',quantity:1,currency:'usd',amount_subtotal:200,amount_total:200,amount_tax:0,amount_discount:0,price:makePrice({metadata:{private:'value'}}),
 }]});
 f.stripeObjects.set('/payment_intents/pi_fixture',{id:'pi_fixture',object:'payment_intent',livemode:false,metadata:{fetchx_checkout:orderId,private:'value'},
  customer:'cus_fixture',currency:'usd',amount:200,amount_received:200,status:'succeeded',latest_charge:'ch_fixture',client_secret:'private'});
 f.stripeObjects.set('/charges/ch_fixture',{id:'ch_fixture',object:'charge',livemode:false,payment_intent:'pi_fixture',
  customer:'cus_fixture',currency:'usd',amount:200,amount_captured:200,paid:true,captured:true,disputed:false,amount_refunded:0,refunded:false,
  created:epoch(),payment_method_details:{type:'card',card:{fingerprint:'private'}},receipt_url:'https://example/private'});
 f.stripeObjects.set('/disputes/dp_fixture',{id:'dp_fixture',object:'dispute',livemode:false,charge:'ch_fixture',status:'won',evidence:{private:'value'}});
 f.stripeObjects.set('/checkout/sessions?payment_intent=pi_fixture&limit=2',{object:'list',has_more:false,data:[session]});
 for(const path of ['/checkout/sessions/cs_test_fixture','/checkout/sessions/cs_test_fixture/line_items?limit=2',
  '/payment_intents/pi_fixture','/charges/ch_fixture','/disputes/dp_fixture','/checkout/sessions?payment_intent=pi_fixture&limit=2']){
  assert.doesNotMatch(JSON.stringify(await f.provider.request(config,path)),/private/);
 }
 const lines=f.stripeObjects.get('/checkout/sessions/cs_test_fixture/line_items?limit=2');
 lines.data[0].price.id='price_unapproved';
 const unapproved=await f.broker({op:'checkout.line_items',session_id:'cs_test_fixture'});
 assert.equal(unapproved.status,502);assert.deepEqual(await unapproved.json(),{error:'stripe_price_mismatch'});
 lines.data[0].price.id=plan.priceId;
 for(const [key,value] of [
  ['success_url','https://attacker.example'],['automatic_tax',{enabled:true}],
  ['allow_promotion_codes',true],['total_details',{amount_discount:200,amount_tax:0,amount_shipping:0}],
 ]){
  const saved=session[key];session[key]=value;
  const rejected=await f.broker({op:'checkout.get',session_id:'cs_test_fixture'});
  assert.equal(rejected.status,502);assert.deepEqual(await rejected.json(),{error:'stripe_checkout_mismatch'});
  session[key]=saved;
 }
 f.stripeObjects.get('/customers/cus_fixture').metadata={};
 await assert.rejects(f.provider.request(config,'/charges/ch_fixture'),{code:'stripe_provider_unconfirmed'});
});

test('Worker verifies raw Stripe events and relay requires signature and durable acknowledgment',async()=>{
 const f=fixture(),config=stripeSettings(f.config);
 const providerEvent={id:'evt_fixture',object:'event',livemode:false,type:'checkout.session.completed',
  data:{object:{object:'checkout.session',id:'cs_test_fixture',customer_details:{email:'private-customer@example.com'}}}};
 const raw=JSON.stringify(providerEvent,null,2),valid=await f.webhook(raw);
 assert.equal(valid.status,200);assert.deepEqual(await valid.json(),{received:true});
 assert.equal(f.stripeCalls.length,0);
 const first=f.relayCalls[0],event=verifiedStripeRelay(first.body,first.headers,config);
 assert.deepEqual(event,{v:1,mode:'test',account_id:'acct_fixture',event_id:'evt_fixture',event_type:'checkout.session.completed',
  subject_id:'cs_test_fixture',provider_payload_sha256:digest(raw)});
 assert.doesNotMatch(first.body.toString(),/private-customer/);
 assert.throws(()=>verifiedStripeRelay(Buffer.from(first.body.toString().replace('evt_fixture','evt_changed')),first.headers,config),{code:'stripe_relay_signature_invalid'});
 assert.throws(()=>verifiedStripeRelay(first.body,{...first.headers,'x-fetchx-relay-key-id':'wrong'},config),{code:'stripe_relay_signature_invalid'});
 assert.throws(()=>verifiedStripeRelay(first.body,first.headers,{...config,accountId:'acct_wrong'}),{code:'stripe_relay_signature_invalid'});
 assert.equal((await f.webhook(raw,'t='+epoch()+',v1='+'a'.repeat(64))).status,400);
 assert.equal((await f.webhook(JSON.stringify({...providerEvent,livemode:true}))).status,400);
 assert.equal((await f.webhook(JSON.stringify({...providerEvent,type:'invoice.paid'}))).status,200);
 assert.equal(f.relayCalls.length,1);
 f.setAcknowledged(false);assert.equal((await f.webhook(raw)).status,502);
});

test('production settings require the broker and reject Stripe secrets in its configuration',()=>{
 const {config}=fixture(),broker=config.controlPlane.stripe;
 const direct={...config,controlPlane:{...config.controlPlane,stripe:{...broker,transport:'direct',secretKey:'sk_test_SyntheticFixtureOnly',webhookSecret:'whsec_SyntheticFixtureOnly'}}};
 assert.equal(new ControlStripe({config:direct}).ready(),false);
 assert.equal(new ControlStripe({config:direct,fetchStripe:async()=>{throw new Error('synthetic');}}).ready(),true);
 for(const fields of [{secretKey:'sk_test_SyntheticFixtureOnly'},{webhookSecret:'whsec_SyntheticFixtureOnly'},{brokerUrl:'https://payments.example/other'}]){
  const value={...config,controlPlane:{...config.controlPlane,stripe:{...broker,...fields}}};
  assert.equal(stripeSettings(value),null);
 }
});
