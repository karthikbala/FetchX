import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac,generateKeyPairSync,randomBytes,randomUUID} from 'node:crypto';
import {paymentWorker} from '../payments-worker/worker.mjs';
import {ControlStripe} from '../src/control-stripe.mjs';
import {stripeEventSubject} from '../src/control-stripe-events.mjs';
import {StripeProvider,stripeSettings,verifiedStripeRelay} from '../src/control-stripe-provider.mjs';
import {BROKER_PATH,RELAY_PATH,STRIPE_VERSION,audience,brokerMessage,checkoutForm,customerForm,epoch,PACK_OFFERS,billingCurrency} from '../src/control-stripe-broker-protocol.mjs';

const workerOrigin='https://payments.example',websiteOrigin='https://www.example',relayUrl='https://gateway.example'+RELAY_PATH;
const stripeOrigin='https://api.stripe.com/v1';
const plan={id:'credits-10000',name:'10,000 credits',version:'fixture-1',priceId:'price_fixture',amountMinor:200,currency:'usd',credits:10_000};
const makePrice=(overrides={})=>({id:plan.priceId,object:'price',active:true,livemode:false,type:'one_time',unit_amount:200,
 currency:'usd',billing_scheme:'per_unit',recurring:null,...overrides});
const digest=value=>createHash('sha256').update(value).digest('hex');
const checkoutSafety=()=>({success_url:websiteOrigin+'/app/billing?checkout=success',cancel_url:websiteOrigin+'/app/billing?checkout=cancelled',
 automatic_tax:{enabled:false},allow_promotion_codes:false,payment_method_types:['card'],
 total_details:{amount_discount:0,amount_tax:0,amount_shipping:0}});

function fixture({offer=plan,sessionMethods=[offer.currency==='inr'?'upi':'card']}={}){
 const plan=offer;
 const {privateKey,publicKey}=generateKeyPairSync('ed25519'),keyId='fixture-key';
 const secret=randomBytes(32).toString('base64url'),webhookSecret='whsec_SyntheticFixtureOnly';
 const config={controlPlane:{enabled:true,origins:[websiteOrigin],stripe:{enabled:true,mode:'test',accountId:'acct_fixture',
  inrSalesEnabled:true,transport:'broker',brokerUrl:workerOrigin+BROKER_PATH,brokerReturnOrigin:websiteOrigin,brokerAuthSecret:secret,
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
  if(path==='/prices/'+plan.priceId)return Response.json(makePrice({id:plan.priceId,currency:plan.currency,unit_amount:plan.amountMinor,metadata:{private:'value'}}));
  if(path==='/customers'&&options.method==='POST'){
   const customer={id:'cus_fixture',object:'customer',livemode:false,email:'private-customer@example.com',
    metadata:{fetchx_customer:new URLSearchParams(options.body).get('metadata[fetchx_customer]'),private:'value'}};
   stripeObjects.set('/customers/'+customer.id,customer);
   return Response.json(customer);
  }
  if(path==='/checkout/sessions'&&options.method==='POST'){
   const params=new URLSearchParams(options.body),id='cs_test_fixture';
   assert.equal(params.has('payment_method_types[0]'),false);
   assert.deepEqual(params.getAll('allowed_payment_method_types[0]'),[plan.currency==='inr'?'upi':'card']);
   const session={id,object:'checkout.session',livemode:false,mode:'payment',client_reference_id:params.get('client_reference_id'),
    customer:params.get('customer'),amount_subtotal:plan.amountMinor,amount_total:plan.amountMinor,currency:plan.currency,status:'open',payment_status:'unpaid',
    payment_intent:null,...checkoutSafety(),payment_method_types:sessionMethods,
    url:'https://checkout.stripe.com/c/pay/'+id+'#private-hosted-token',customer_details:{email:'private-customer@example.com'}};
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
 const wire=new URLSearchParams(body);wire.delete('payment_method_types[0]');wire.set('allowed_payment_method_types[0]','card');
 assert.equal(new URLSearchParams(body).get('payment_method_types[0]'),'card','durable canonical gateway form remains unchanged');
 assert.deepEqual(creates,[{path:'/checkout/sessions',method:'POST',body:wire.toString(),key},
  {path:'/checkout/sessions',method:'POST',body:wire.toString(),key}]);
 assert.deepEqual(f.gatewayRequests.filter(call=>JSON.parse(call.options.body).op==='checkout.create').map(call=>JSON.parse(call.options.body)),[
  {op:'checkout.create',order_id:orderId,customer_id:customer.id,price_id:plan.priceId,expires_at:expiresAt,return_origin:websiteOrigin},
  {op:'checkout.create',order_id:orderId,customer_id:customer.id,price_id:plan.priceId,expires_at:expiresAt,return_origin:websiteOrigin},
 ]);
 const before=f.gatewayRequests.length;
 for(const wrong of [body.replace('expires_at=','deadline='),body.replace(encodeURIComponent(websiteOrigin),encodeURIComponent('https://attacker.example')),body+'&unused=1']){
  await assert.rejects(f.provider.request(config,'/checkout/sessions',{body:wrong,key}),{code:'stripe_checkout_reconciliation_required'});
 }
 await assert.rejects(f.provider.request(config,'/checkout/sessions',{body,key,version:'2025-01-01.old'}),{code:'stripe_checkout_reconciliation_required'});
 await assert.rejects(f.provider.request(config,'/refunds'),{code:'stripe_broker_operation_invalid'});
 assert.equal(f.gatewayRequests.length,before);
});

test('broker refuses created sessions whose resolved payment methods are not exactly card',async()=>{
 for(const sessionMethods of [null,[],['link'],['card','link'],['card','card']]){
  const f=fixture({sessionMethods}),orderId=randomUUID();
  assert.equal((await f.broker({op:'customer.create',creation_key:randomUUID()})).status,200);
  const rejected=await f.broker({op:'checkout.create',order_id:orderId,customer_id:'cus_fixture',price_id:plan.priceId,
   expires_at:epoch()+3600,return_origin:websiteOrigin});
  assert.equal(rejected.status,502);
  assert.deepEqual(await rejected.json(),{error:'stripe_checkout_mismatch'});
  const creates=f.stripeCalls.filter(call=>call.method==='POST'&&call.path==='/checkout/sessions');
  assert.equal(creates.length,1);
  assert.equal(creates[0].key,'fetchx-checkout-'+orderId);
 }
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
  ['payment_method_types',undefined],['payment_method_types',[]],['payment_method_types',['link']],
  ['payment_method_types',['card','link']],['payment_method_types',['card','card']],
 ]){
  const saved=session[key];session[key]=value;
  const rejected=await f.broker({op:'checkout.get',session_id:'cs_test_fixture'});
  assert.equal(rejected.status,502);assert.deepEqual(await rejected.json(),{error:'stripe_checkout_mismatch'});
  session[key]=saved;
 }
 f.stripeObjects.get('/customers/cus_fixture').metadata={};
 await assert.rejects(f.provider.request(config,'/charges/ch_fixture'),{code:'stripe_provider_unconfirmed'});
});

test('UPI Payment IDs retain the complete tagged payment and signed refund chain',async()=>{
 const offer={...plan,id:'credits-10000-inr',currency:'inr',amountMinor:17500},f=fixture({offer}),config=stripeSettings(f.config);
 const orderId=randomUUID(),creationKey=randomUUID(),chargeId='py_fixture';
 f.stripeObjects.set('/customers/cus_fixture',{id:'cus_fixture',object:'customer',livemode:false,metadata:{fetchx_customer:creationKey}});
 const intent={id:'pi_fixture',object:'payment_intent',livemode:false,metadata:{fetchx_checkout:orderId},customer:'cus_fixture',
  currency:'inr',amount:17500,amount_received:17500,status:'succeeded',latest_charge:chargeId,client_secret:'private'};
 const charge={id:chargeId,object:'charge',livemode:false,payment_intent:intent.id,customer:'cus_fixture',currency:'inr',
  amount:17500,amount_captured:17500,paid:true,captured:true,disputed:false,amount_refunded:0,refunded:false,created:epoch(),
  payment_method_details:{type:'upi',upi:{vpa:'private'}}};
 f.stripeObjects.set('/payment_intents/'+intent.id,intent);f.stripeObjects.set('/charges/'+chargeId,charge);
 const refund={id:'pyr_fixture',object:'refund',amount:1,currency:'inr',charge:chargeId,payment_intent:intent.id,status:'pending'};
 f.stripeObjects.set('/refunds/'+refund.id,refund);
 assert.equal((await f.provider.request(config,'/payment_intents/'+intent.id)).latest_charge,chargeId);
 const payment=await f.provider.request(config,'/charges/'+chargeId);
 assert.equal(payment.id,chargeId);assert.deepEqual(payment.payment_method_details,{type:'upi'});assert.doesNotMatch(JSON.stringify(payment),/private/);
 assert.equal((await f.provider.request(config,'/refunds/'+refund.id)).charge,chargeId);
 for(const [type,object] of [['charge.refunded',charge],['refund.created',refund]]){
  const providerEvent={id:'evt_'+type.replaceAll('.',''),object:'event',livemode:false,type,data:{object}};
  const response=await f.webhook(JSON.stringify(providerEvent));assert.equal(response.status,200);
  const relay=f.relayCalls.at(-1),event=verifiedStripeRelay(relay.body,relay.headers,config);
  assert.equal(event.subject_id,object.id);assert.equal(stripeEventSubject(providerEvent),object.id);
 }
 for(const invalid of ['pay_fixture','py_','py_fixture_extra','py_'+ 'a'.repeat(201),'py_fixture/other']){
  const calls=f.stripeCalls.length;
  await assert.rejects(f.provider.request(config,'/charges/'+invalid),{code:'stripe_broker_operation_invalid'});
  assert.equal(f.stripeCalls.length,calls);
  assert.equal((await f.broker({op:'charge.get',charge_id:invalid})).status,400);
  const event={id:'evt_invalid',object:'event',livemode:false,type:'charge.refunded',data:{object:{...charge,id:invalid}}};
  assert.equal((await f.webhook(JSON.stringify(event))).status,400);assert.throws(()=>stripeEventSubject(event),{code:'stripe_event_invalid'});
 }
 for(const invalid of ['refund_fixture','pyr_','pyr_fixture_extra','pyr_'+ 'a'.repeat(201),'pyr_fixture/other']){
  const calls=f.stripeCalls.length;
  await assert.rejects(f.provider.request(config,'/refunds/'+invalid),{code:'stripe_broker_operation_invalid'});
  assert.equal(f.stripeCalls.length,calls);assert.equal((await f.broker({op:'refund.get',refund_id:invalid})).status,400);
  const event={id:'evt_invalidrefund',object:'event',livemode:false,type:'refund.created',data:{object:{...refund,id:invalid}}};
  assert.equal((await f.webhook(JSON.stringify(event))).status,400);assert.throws(()=>stripeEventSubject(event),{code:'stripe_event_invalid'});
 }
 for(const [object,key,wrong] of [[charge,'livemode',true],[charge,'currency','usd'],[charge,'customer','cus_other'],
  [charge,'payment_method_details',{type:'card'}],[intent,'metadata',{}],[intent,'latest_charge','pay_fixture']]){
  const saved=object[key];object[key]=wrong;
  await assert.rejects(f.provider.request(config,'/charges/'+chargeId),{code:'stripe_provider_unconfirmed'});object[key]=saved;
 }
 assert.equal((await f.provider.request(config,'/charges/'+chargeId)).id,chargeId);
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

const inrPlan={id:'credits-10000-inr',name:'10,000 credits',version:'inr-fixture-1',priceId:'price_inrfixture',amountMinor:17500,currency:'inr',credits:10000};

test('INR broker Checkout keeps rupees, UPI and the immutable request key through Stripe',async()=>{
 const f=fixture({offer:inrPlan}),config=stripeSettings(f.config),orderId=randomUUID(),expiresAt=epoch()+3600;
 const creationKey=randomUUID(),saved=await f.provider.request(config,'/customers',{body:customerForm(creationKey),key:'fetchx-customer-'+creationKey});
 await f.provider.assertPrice(config,inrPlan);
 const body=checkoutForm({orderId,customerId:saved.id,priceId:inrPlan.priceId,expiresAt,returnOrigin:websiteOrigin,paymentMethod:'upi'});
 const key='fetchx-checkout-'+orderId,result=await f.provider.request(config,'/checkout/sessions',{body,key});
 assert.equal(result.currency,'inr');assert.equal(result.amount_total,17500);assert.deepEqual(result.payment_method_types,['upi']);
 await f.provider.request(config,'/checkout/sessions',{body,key});
 const writes=f.stripeCalls.filter(call=>call.path==='/checkout/sessions'&&call.method==='POST');
 assert.equal(writes.length,2);assert.equal(writes[0].key,key);assert.deepEqual(writes[0],writes[1]);
 const wire=new URLSearchParams(writes[0].body);
 assert.equal(wire.get('allowed_payment_method_types[0]'),'upi');assert.equal(wire.has('payment_method_types[0]'),false);
 assert.equal(wire.get('adaptive_pricing[enabled]'),'false');assert.equal(wire.get('line_items[0][price]'),inrPlan.priceId);
 await assert.rejects(f.provider.request(config,'/checkout/sessions',{body:body.replace('=upi','=card'),key}),{code:'stripe_checkout_reconciliation_required'});
 for(const methods of [['card'],['upi','card'],[]]){
  const bad=fixture({offer:inrPlan,sessionMethods:methods});
  await bad.broker({op:'customer.create',creation_key:randomUUID()});
  const response=await bad.broker({op:'checkout.create',order_id:randomUUID(),customer_id:'cus_fixture',price_id:inrPlan.priceId,expires_at:expiresAt,return_origin:websiteOrigin});
  assert.equal(response.status,502);
 }
});

test('approved offer currencies cannot be substituted and country selection never falls back from India to USD',async()=>{
 const f=fixture({offer:inrPlan}),project=f.config.controlPlane.stripe.allowedProjects[0];
 f.config.controlPlane.stripe.catalog=[plan,inrPlan];
 const store={pool:{query:async()=>({rows:[],rowCount:0})}};
 const billing=new ControlStripe({store,config:f.config,paidCreditReady:async()=>true});
 const india=await billing.billing(project,{country:'IN'}),other=await billing.billing(project,{country:'US'}),unknown=await billing.billing(project);
 assert.equal(india.currency,'inr');assert.deepEqual(india.plans.map(p=>p.id),[inrPlan.id]);
 assert.equal(other.currency,'usd');assert.deepEqual(other.plans.map(p=>p.id),[plan.id]);assert.deepEqual(unknown,other);
 await assert.rejects(billing.checkout({project,key:randomUUID(),planId:plan.id,origin:websiteOrigin,country:'IN'}),{code:'stripe_plan_invalid'});
 await assert.rejects(billing.checkout({project,key:randomUUID(),planId:inrPlan.id,origin:websiteOrigin,country:'US'}),{code:'stripe_plan_invalid'});
 f.config.controlPlane.stripe.catalog=[plan];
 const missing=await billing.billing(project,{country:'IN'});assert.equal(missing.currency,'inr');assert.deepEqual(missing.plans,[]);
 assert.equal(missing.checkout_unavailable_reason,'stripe_currency_unavailable');
 assert.equal(billingCurrency('XX'),'usd');
 for(const fields of [{currency:'usd'},{amountMinor:200},{credits:50000},{id:plan.id}]){
  f.config.controlPlane.stripe.catalog=[{...inrPlan,...fields}];assert.equal(stripeSettings(f.config),null);
 }
 assert.deepEqual(Object.values(PACK_OFFERS).filter(p=>p.currency==='inr').map(p=>p.amountMinor),[17500,75000,180000,900000]);
});

test('new async checkout and refund subjects are signed and relayed without sensitive refund data',async()=>{
 const f=fixture(),config=stripeSettings(f.config);
 for(const [type,object,id] of [
  ['checkout.session.async_payment_failed','checkout.session','cs_test_failed'],
  ['payment_intent.payment_failed','payment_intent','pi_expiredqr'],
  ['refund.created','refund','re_created'],['refund.updated','refund','re_updated'],['refund.failed','refund','re_failed'],
 ]){
  const raw=JSON.stringify({id:'evt_'+randomBytes(8).toString('hex'),object:'event',livemode:false,type,data:{object:{id,object,metadata:{private:'secret'}}}});
  const response=await f.webhook(raw);assert.equal(response.status,200);
  const call=f.relayCalls.at(-1),event=verifiedStripeRelay(call.body,call.headers,config);
  assert.equal(event.event_type,type);assert.equal(event.subject_id,id);assert.doesNotMatch(call.body.toString(),/secret/);
 }
});
