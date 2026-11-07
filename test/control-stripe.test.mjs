import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac,generateKeyPairSync,randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {ControlIdentity} from '../src/control-identity.mjs';
import {TRIAL_CREDITS_PER_ACCOUNT} from '../src/control-credits.mjs';
import {PAID_CREDIT_RESIDENTIAL_LIABILITY_BYTES} from '../src/control-paid-credits.mjs';
import {sha} from '../src/crypto.mjs';
import {Gateway} from '../src/gateway.mjs';
import {server} from '../src/main.mjs';
import {Store} from '../src/store.mjs';
import {paymentWorker} from '../payments-worker/worker.mjs';
import {BROKER_PATH,RELAY_PATH} from '../src/control-stripe-broker-protocol.mjs';

const ORIGIN='http://127.0.0.1:4331';
const WEBHOOK='/webhooks/stripe';
const API='https://api.stripe.com/v1';
const SECRET='whsec_SyntheticWebhookSecretOnly';
const AMOUNT=200,CREDITS=10_000,RESIDENTIAL_BYTES_PER_CREDIT=BigInt(PAID_CREDIT_RESIDENTIAL_LIABILITY_BYTES);
const PLAN={id:'credits-10000',name:'10,000 credits',version:'fixture-1',priceId:'price_fixture',amountMinor:AMOUNT,currency:'usd',credits:CREDITS};
const ts=()=>Math.floor(Date.now()/1000);
const signature=(raw,time=ts())=>`t=${time},v1=${createHmac('sha256',SECRET).update(time+'.').update(raw).digest('hex')}`;

function configForTest(){
 return {
  release:'stripe-offline',artifactKey:randomBytes(32).toString('hex'),projects:{},proxies:[],maxDailyFallbackCredits:0,
  v2:{accessProfiles:{'stripe-fixture@1':{
   id:'stripe-fixture',version:1,origins:['https://source.example'],paths:['^/'],methods:['GET'],headers:['accept'],proxy_classes:['direct'],countries:[],
   limits:{max_requests:10,max_encoded_bytes:8192,max_decoded_bytes:8192,max_session_encoded_bytes:16384,max_input_bytes:1024,max_tunnel_bytes:8192,max_redirects:0,max_expansion_ratio:100,timeout_ms:2000,min_interval_ms:0,ttl_seconds:900},
  }}},
  controlPlane:{enabled:true,origins:[ORIGIN],bridgeSecret:randomBytes(32).toString('hex'),sessionSecure:false,allowLoopbackDevelopment:true,
   projectTemplate:{id:'stripe-fixture',v2_access_profiles:['stripe-fixture@1'],v2_entitlement:{mode:'metered',max_daily_operations:10}},
   creditPolicy:{reviewed:true,version:'stripe-fixture',trialCredits:TRIAL_CREDITS_PER_ACCOUNT,weights:{direct:1},maxEstimatedMicroUsdPerOperation:0},
  },
 };
}

test('Stripe prepaid checkout and signed reconciliation through the gateway',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const url=new URL(process.env.TEST_DATABASE_URL);
 assert.ok(['postgres:','postgresql:'].includes(url.protocol));
 assert.match(decodeURIComponent(url.pathname),/^\/gateway_test_[A-Za-z0-9_]+$/,'explicit disposable gateway_test_* database required');
 const schema='stripe_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:url.href,max:1});
 let store,app;
 t.after(async()=>{
  try{await app?.close();await store?.close();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);}finally{await admin.end();}
 });
 await admin.query(`CREATE SCHEMA ${schema}`);
 url.searchParams.set('options',`-csearch_path=${schema}`);
 store=new Store(url.href);await store.init();await store.init();
 const config=configForTest(),gateway=new Gateway({store,config,profiles:{}}),mailbox=new Map();
 gateway.controlIdentity=new ControlIdentity({store,config,mail:{configured:true,sendCode:async message=>mailbox.set(message.email,message)}});
 const calls=[],byRequest=new Map(),objects=new Map(),sessions=[];
 let brokerRuntime,omitCheckoutResponse=false,routeReady=false,wrongAccount=false,capacityLiabilityBytes=1_000_000_000_000n;
 const count=async(table,where='true')=>Number((await store.pool.query(`SELECT count(*) AS n FROM ${table} WHERE ${where}`)).rows[0].n);
 const grants=(where='true')=>count('paid_credit_grants',`credits IS NOT NULL AND (${where})`);
 const stripeFetch=async(raw,options)=>{
  if(brokerRuntime&&raw===brokerRuntime.url)return brokerRuntime.worker.fetch(new Request(raw,options),brokerRuntime.env);
  assert.ok(raw.startsWith(API+'/'),'Stripe transport is entirely fixture-backed');
  const url=new URL(raw),path=url.pathname.slice('/v1'.length),configStripe=config.controlPlane.stripe,live=configStripe.mode==='live';
  assert.equal(options.headers.Authorization,'Bearer '+(configStripe.transport==='broker'?brokerRuntime.env.STRIPE_API_KEY:configStripe.secretKey));assert.equal(options.redirect,configStripe.transport==='broker'?'manual':'error');
  assert.equal(options.headers['Stripe-Version'],'2026-10-28.endive');
  const key=options.headers['Idempotency-Key'],params=new URLSearchParams(options.body),call={path,key,body:options.body,method:options.method};
  calls.push(call);
  if(options.method==='GET'){
   assert.equal(key,undefined);
   if(path==='/account')return Response.json({object:'account',id:wrongAccount?'acct_other':configStripe.accountId});
   if(path==='/prices/'+PLAN.priceId)return Response.json(price(live));
   if(path==='/checkout/sessions'){
    return Response.json({object:'list',has_more:false,data:sessions.filter(session=>session.payment_intent===url.searchParams.get('payment_intent'))});
   }
   assert.ok(objects.has(path),'missing fixture '+path);
   return Response.json(objects.get(path));
  }
  assert.equal(options.method,'POST');assert.equal(options.headers['Content-Type'],'application/x-www-form-urlencoded');
  const old=byRequest.get(key);
  if(old){
   assert.equal(old.body,call.body);
   return Response.json(old.object);
  }
  let object;
  if(path==='/customers'){
   const creationKey=params.get('metadata[fetchx_customer]');
   assert.equal((await store.pool.query('SELECT request_body FROM control_stripe_customers WHERE creation_key=$1',[creationKey])).rows[0].request_body,call.body);
   object={id:'cus_'+randomBytes(8).toString('hex'),object:'customer',livemode:live,metadata:{fetchx_customer:creationKey}};
   objects.set(path+'/'+object.id,object);
  }else{
   assert.equal(path,'/checkout/sessions');
   const orderId=params.get('client_reference_id'),id=`cs_${configStripe.mode}_${randomBytes(8).toString('hex')}`;
   const canonical=(await store.pool.query('SELECT request_body FROM control_stripe_orders WHERE id=$1',[orderId])).rows[0].request_body;
   if(configStripe.transport==='broker'){
    const wire=new URLSearchParams(canonical);
    assert.equal(wire.get('payment_method_types[0]'),'card','gateway keeps its durable canonical form');
    wire.delete('payment_method_types[0]');wire.set('allowed_payment_method_types[0]','card');
    assert.equal(call.body,wire.toString(),'Worker changes only the deprecated Stripe wire parameter');
    assert.equal(params.has('payment_method_types[0]'),false);
    assert.equal(params.get('allowed_payment_method_types[0]'),'card');
   }else assert.equal(canonical,call.body);
   assert.equal(params.get('mode'),'payment');assert.equal(params.get('line_items[0][price]'),PLAN.priceId);
   assert.equal(params.get('payment_intent_data[metadata][fetchx_checkout]'),orderId);
   const origin=configStripe.brokerReturnOrigin??ORIGIN;
   assert.equal(params.get('success_url'),origin+'/app/billing?checkout=success');assert.equal(params.get('cancel_url'),origin+'/app/billing?checkout=cancelled');
   assert.equal(params.has('customer_email'),false);assert.equal(params.has('invoice_creation[enabled]'),false);
   object={id,object:'checkout.session',livemode:live,mode:'payment',status:'open',payment_status:'unpaid',
    customer:params.get('customer'),client_reference_id:orderId,amount_subtotal:AMOUNT,amount_total:AMOUNT,currency:'usd',
    success_url:params.get('success_url'),cancel_url:params.get('cancel_url'),automatic_tax:{enabled:false},
    allow_promotion_codes:false,payment_method_types:['card'],total_details:{amount_discount:0,amount_tax:0,amount_shipping:0},
    url:`https://checkout.stripe.com/c/pay/${id}#synthetic-secret`};
   sessions.push(object);objects.set(path+'/'+id,object);
  }
  byRequest.set(key,{body:call.body,object});
  if(path==='/checkout/sessions'&&omitCheckoutResponse){omitCheckoutResponse=false;throw new Error('private Stripe transport details');}
  return Response.json(object);
 };
 function price(live){return {id:PLAN.priceId,object:'price',livemode:live,active:true,type:'one_time',unit_amount:AMOUNT,currency:'usd',billing_scheme:'per_unit',recurring:null};}
 app=server(gateway,{stripeFetch,stripeAutoProcess:false});
 app.v2.paidCreditReady=async(project,{publicOnly,purchaseCredits=0,pendingLiabilityBytes=0n,outstandingLiabilityBytes=0n}={})=>
  !!config.projects[project]&&publicOnly===true&&routeReady&&(purchaseCredits===0||BigInt(purchaseCredits)*RESIDENTIAL_BYTES_PER_CREDIT+
   BigInt(pendingLiabilityBytes)+BigInt(outstandingLiabilityBytes)<=capacityLiabilityBytes);
 const bridge={origin:ORIGIN,'x-fetchx-control-secret':config.controlPlane.bridgeSecret};
 const control=(method,path,actor={},payload,headers={})=>app.inject({method,url:'/control'+path,headers:{...bridge,...actor,...headers},
  ...(payload===undefined?{}:{payload})});
 async function account(email){
  const challenge=await control('POST','/auth/code',{}, {email});assert.equal(challenge.statusCode,200);
  const verified=await control('POST','/auth/verify',{}, {email,challenge_id:challenge.json().challenge_id,code:mailbox.get(email).code});
  assert.equal(verified.statusCode,200);
  const actor={cookie:verified.headers['set-cookie'].split(';')[0],'x-csrf-token':verified.json().csrf_token};
  const project=await control('POST','/projects',actor,{name:'Stripe fixture'});assert.equal(project.statusCode,200);
  return {actor,id:project.json().project.id};
 }
 const a=await account('stripe-a@example.com'),b=await account('stripe-b@example.com');
 const path=`/projects/${a.id}/billing`,checkout=path+'/stripe/checkout';
 const settings=mode=>({enabled:true,mode,accountId:'acct_'+mode,secretKey:`sk_${mode}_SyntheticFixtureOnly`,webhookSecret:SECRET,
  catalog:[PLAN],allowedProjects:[a.id],commercialReviewed:mode==='live'});
 const start=(key,actor=a.actor,plan=PLAN.id)=>control('POST',checkout,actor,{idempotency_key:key,plan_id:plan});
 const get=(key,actor=a.actor)=>control('GET',checkout+'/'+key,actor);
 const readBilling=async()=>{const result=await control('GET',path,a.actor);assert.equal(result.statusCode,200);return result.json();};
 const webhook=(raw,sig=signature(raw),options={})=>app.inject({method:'POST',url:WEBHOOK,headers:{'content-type':'application/json','stripe-signature':sig},payload:raw,...options});
 const event=(type,object,mode=config.controlPlane.stripe.mode)=>({id:'evt_'+randomBytes(8).toString('hex'),type,object:'event',livemode:mode==='live',data:{object}});
 async function receive(type,object,{drain=true}={}){
  const value=event(type,object),raw=JSON.stringify(value);
  assert.equal((await webhook(raw)).statusCode,200);
  if(drain)await app.stripe.reconcile();
  return value;
 }
 function paid(session,{received=AMOUNT,quantity=1}={}){
  const suffix=randomBytes(8).toString('hex'),intentId='pi_'+suffix,chargeId='ch_'+suffix,live=session.livemode;
  const line={object:'item',price:price(live),quantity,currency:'usd',amount_subtotal:AMOUNT,amount_total:AMOUNT,amount_tax:0,amount_discount:0};
  const intent={id:intentId,object:'payment_intent',livemode:live,customer:session.customer,metadata:{fetchx_checkout:session.client_reference_id},
   status:'succeeded',amount:AMOUNT,amount_received:received,currency:'usd',latest_charge:chargeId};
  const charge={id:chargeId,object:'charge',livemode:live,customer:session.customer,payment_intent:intentId,paid:true,captured:true,amount:AMOUNT,
   amount_captured:AMOUNT,currency:'usd',amount_refunded:0,refunded:false,disputed:false,created:ts(),payment_method_details:{type:'card'}};
  Object.assign(session,{status:'complete',payment_status:'paid',payment_intent:intentId,url:null,customer_details:{email:'never-persist@example.com'}});
  objects.set('/checkout/sessions/'+session.id+'/line_items',{object:'list',has_more:false,data:[line]});
  objects.set('/payment_intents/'+intentId,intent);objects.set('/charges/'+chargeId,charge);
  return {session,line,intent,charge};
 }
 const lastSession=()=>sessions.at(-1);
 const paidCredits=async()=> (await readBilling()).paid_credits;
 let sandboxKey,liveKey,first;

 await t.test('defaults, approved catalog, authorization and residential readiness are fail-closed',async()=>{
  const billing=await readBilling();assert.equal(billing.commercial_enabled,false);assert.equal(billing.stripe,undefined);assert.equal(billing.paid_credits,undefined);
  const terms={trial_target:TRIAL_CREDITS_PER_ACCOUNT,grant_scope:'account',grant_frequency:'once',eligible_routes:['direct'],max_daily_operations:10};
  assert.deepEqual(billing.trial,terms);assert.equal(billing.credits.available,TRIAL_CREDITS_PER_ACCOUNT);
  const additional=await control('POST','/projects',a.actor,{name:'Additional project'});
  assert.equal(additional.statusCode,200,additional.body);
  const additionalBilling=await control('GET',`/projects/${additional.json().project.id}/billing`,a.actor);
  assert.deepEqual(additionalBilling.json().trial,terms);assert.equal(additionalBilling.json().credits.available,0);
  const key=randomUUID();
  assert.equal((await start(key)).statusCode,404);assert.equal((await webhook('{}')).statusCode,404);
  config.controlPlane.stripe={...settings('test'),secretKey:'sk_live_SyntheticFixtureOnly'};
  assert.equal((await start(key)).statusCode,404);
  config.controlPlane.stripe={...settings('test'),catalog:[{...PLAN,credits:CREDITS+1}]};
  assert.equal((await start(key)).statusCode,404);
  config.controlPlane.stripe=settings('test');
  const unavailable=await readBilling();assert.equal(unavailable.stripe.can_checkout,false);assert.equal(unavailable.stripe.checkout_unavailable_reason,'paid_credit_route_unavailable');
  assert.equal((await start(key)).json().error.code,'paid_credit_route_unavailable');
  routeReady=true;
  assert.equal((await start(key,{})).statusCode,401);
  assert.equal((await start(key,{cookie:a.actor.cookie})).statusCode,403);
  assert.equal((await start(key,b.actor)).statusCode,404);
  assert.equal((await start(key,a.actor,'not-a-plan')).statusCode,400);
  assert.equal((await control('POST',checkout,a.actor,{idempotency_key:key,plan_id:PLAN.id,amount_minor:1})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:WEBHOOK+'?extra=true'})).statusCode,401);
  assert.equal(calls.length,0);
  wrongAccount=true;assert.equal((await start(key)).json().error.code,'stripe_account_mismatch');wrongAccount=false;
  assert.equal(await count('control_stripe_orders'),0);
  const token='fixture-legacy-token';config.projects.legacy={tokenHash:sha(token),profiles:[]};
  const headers={authorization:'Bearer '+token,'content-type':'application/json'};
  const v1=await app.inject({method:'POST',url:'/v1/workflows',headers,payload:'{"profile":"unapproved","idempotency_key":"parser-fixture"}'});
  assert.equal(v1.json().error,'profile_forbidden');
  const v2=await app.inject({method:'POST',url:'/v2/fetch',headers,payload:'{"render":true}'});
  assert.equal(v2.statusCode,409);assert.equal(v2.json().error.code,'capability_unsupported');
 });

 await t.test('control exposes paid routes only when gateway capability and profile both allow them',async()=>{
  const v2=app.v2,originalCapabilities=v2.capabilities,originalProfiles=v2.profiles;
  try{
   v2.capabilities=async()=>({proxy_classes:{direct:true,datacenter:true,residential:true},
    paid_http:{proxy_classes:{direct:false,datacenter:true,residential:false}}});
   v2.profiles=async()=>({access_profiles:[{id:'public-url-http',version:1,proxy_classes:['direct','datacenter','residential'],
    route_reservations:[{class:'datacenter'},{class:'residential'}]}]});
   const detail=await control('GET',`/projects/${a.id}`,a.actor);
   assert.equal(detail.statusCode,200);
   assert.deepEqual(detail.json().capabilities.routes,['direct','datacenter']);
   assert.deepEqual(detail.json().access_profiles[0].proxy_classes,['direct','datacenter']);
   assert.deepEqual(detail.json().access_profiles[0].route_reservations,[{class:'datacenter'}]);
  }finally{v2.capabilities=originalCapabilities;v2.profiles=originalProfiles;}
 });

 await t.test('uncertain checkout recovers only with the original key and immutable request',async()=>{
  sandboxKey=randomUUID();omitCheckoutResponse=true;
  const uncertain=await start(sandboxKey);assert.equal(uncertain.statusCode,502);assert.doesNotMatch(uncertain.body,/private Stripe/);
  assert.equal((await get(sandboxKey)).json().state,'creating');
  assert.equal((await readBilling()).stripe.pending_checkout.idempotency_key,sandboxKey);
  assert.equal((await start(randomUUID())).statusCode,409);
  const recovered=await start(sandboxKey);assert.equal(recovered.statusCode,200,recovered.body);
  assert.equal(recovered.json().state,'awaiting_payment');assert.equal(recovered.json().checkout_url,lastSession().url);
  assert.equal((await get(sandboxKey,b.actor)).statusCode,404);assert.equal((await get(sandboxKey)).json().checkout_url,undefined);
  assert.equal((await start(sandboxKey,a.actor,'other-plan')).statusCode,409);
  const creates=calls.filter(call=>call.path==='/checkout/sessions'&&call.method==='POST');
  assert.equal(creates.length,2);assert.deepEqual(creates[0],creates[1]);assert.equal(await count('control_stripe_orders'),1);
 });

 await t.test('signed raw inbox is bounded and sandbox receipts grant no paid credits',async()=>{
  const {session}=paid(lastSession()),evt=event('checkout.session.completed',session),raw=JSON.stringify(evt,null,2);
  assert.equal((await webhook(JSON.stringify(evt),signature(raw))).statusCode,400);
  for(const time of [ts()-600,ts()+600])assert.equal((await webhook(raw,signature(raw,time))).statusCode,400);
  assert.equal((await webhook(raw,signature(raw)+',t='+ts())).statusCode,400);
  assert.equal((await webhook(raw,'v1='+'0'.repeat(2050))).statusCode,400);
  assert.equal((await webhook(' '.repeat(128*1024+1))).statusCode,413);
  assert.equal((await webhook(JSON.stringify({...evt,livemode:true}))).statusCode,400);
  const duplicates=await Promise.all(Array.from({length:5},()=>webhook(raw,signature(raw)+',v1='+'a'.repeat(64))));
  assert.ok(duplicates.every(result=>result.statusCode===200));
  assert.equal((await webhook(JSON.stringify({...evt,created:1}))).statusCode,409);
  assert.equal(await count('control_stripe_events'),1);assert.equal(await count('control_stripe_purchases'),0);
  assert.equal((await start(sandboxKey)).json().state,'awaiting_webhook');
  assert.equal((await app.stripe.reconcile()).applied,1);
  assert.equal((await get(sandboxKey)).json().state,'test_paid_unapplied');
  assert.equal(await grants(),0);assert.equal((await paidCredits()).available,0);
  assert.equal((await readBilling()).credits.available,TRIAL_CREDITS_PER_ACCOUNT);
  const history=(await readBilling()).stripe.purchases;
  assert.equal(history[0].credits,CREDITS);assert.equal(history[0].status,'test_paid_unapplied');assert.match(history[0].paid_at,/Z$/);
 });

 await t.test('live checkout can reconcile a lost response and transaction failure before granting exactly once',async()=>{
  config.controlPlane.stripe={...settings('live'),commercialReviewed:false};
  assert.equal((await start(randomUUID())).statusCode,404);
  config.controlPlane.stripe=settings('live');
  liveKey=sandboxKey;omitCheckoutResponse=true;assert.equal((await start(liveKey)).statusCode,502);
  first=paid(lastSession());
  const evt=await receive('checkout.session.completed',first.session,{drain:false});
  const ledger=app.stripe.events.paidCredits,grant=ledger.grantPaidCredits;
  ledger.grantPaidCredits=async function(...args){await grant.apply(this,args);throw new Error('synthetic rollback');};
  try{
   assert.equal((await app.stripe.reconcile()).pending,1);
   assert.equal(await grants(),0);assert.equal(await count('control_stripe_purchases',"mode='live'"),0);
  }finally{ledger.grantPaidCredits=grant;}
  assert.equal((await app.stripe.reconcile({eventId:evt.id})).applied,1);
  await receive('checkout.session.async_payment_succeeded',first.session);
  assert.equal((await get(liveKey)).json().state,'paid');
  assert.equal(await grants(),1);assert.equal((await paidCredits()).available,CREDITS);
  assert.equal((await readBilling()).credits.available,TRIAL_CREDITS_PER_ACCOUNT);
  assert.equal((await readBilling()).stripe.can_checkout,true);
  const usage=await control('GET',`/projects/${a.id}/usage`,a.actor);
  assert.equal(usage.statusCode,200,usage.body);assert.equal(usage.json().paid_credits.available,CREDITS);
  assert.equal(usage.json().credits.available,TRIAL_CREDITS_PER_ACCOUNT);
  assert.equal(usage.json().trial.trial_target,TRIAL_CREDITS_PER_ACCOUNT);
  assert.equal(usage.json().trial.max_daily_operations,10);
 });

 await t.test('partial/zero collection and wrong quantity stay unapplied until canonical evidence verifies',async()=>{
  const key=randomUUID();assert.equal((await start(key)).statusCode,200);
  const fixture=paid(lastSession(),{received:0,quantity:2});
  const evt=await receive('checkout.session.completed',fixture.session);
  assert.equal(await grants(),1);
  fixture.line.quantity=1;
  assert.equal((await app.stripe.reconcile({eventId:evt.id})).pending,1);
  fixture.intent.amount_received=AMOUNT;
  assert.equal((await app.stripe.reconcile({eventId:evt.id})).applied,1);
  assert.equal(await grants(),2);assert.equal((await paidCredits()).available,2*CREDITS);
 });

 await t.test('reversal ahead of paid event creates no grant, and sales-off still processes receipts',async()=>{
  const key=randomUUID();assert.equal((await start(key)).statusCode,200);
  const fixture=paid(lastSession());fixture.charge.amount_refunded=1;
  config.controlPlane.stripe={...settings('live'),enabled:false,catalog:[]};
  assert.equal((await start(randomUUID())).statusCode,404);
  await receive('charge.refunded',fixture.charge);
  assert.equal(await count('control_stripe_credit_reversals'),1);assert.equal(await grants(),2);
  assert.equal(await count('paid_credit_grants','credits IS NULL AND revoked_at IS NOT NULL'),1);
  assert.equal((await get(key)).json().state,'awaiting_payment');
  await receive('checkout.session.completed',fixture.session);
  assert.equal((await get(key)).json().state,'reversed');assert.equal(await grants(),2);
  assert.equal((await readBilling()).stripe.can_checkout,false);
  assert.equal((await readBilling()).stripe.purchases.length,3);
 });

 await t.test('dispute holds clear on won and a later refund revokes unused credits',async()=>{
  const dispute={id:'dp_fixture',object:'dispute',livemode:true,charge:first.charge.id,status:'needs_response'};
  objects.set('/disputes/'+dispute.id,dispute);first.charge.disputed=true;
  config.controlPlane.stripe=settings('live');
  await receive('charge.dispute.created',dispute);assert.equal((await paidCredits()).payment_hold,true);
  assert.equal((await readBilling()).stripe.checkout_unavailable_reason,'paid_credit_payment_hold');
  assert.equal((await start(randomUUID())).json().error.code,'paid_credit_payment_hold');assert.equal((await paidCredits()).available,0);
  dispute.status='won';
  await receive('charge.dispute.closed',dispute);await receive('charge.dispute.created',dispute);
  assert.equal((await paidCredits()).payment_hold,false);assert.equal((await paidCredits()).available,2*CREDITS);
  first.charge.amount_refunded=1;
  await receive('charge.refunded',first.charge);
  assert.equal(await grants('revoked_at IS NOT NULL'),1);
  assert.equal(await grants(),2);assert.equal((await paidCredits()).available,CREDITS);
  assert.equal((await get(liveKey)).json().state,'reversed');
 });

 await t.test('concurrent projects cannot sell the same remaining approved capacity',async()=>{
  config.controlPlane.stripe={...settings('live'),allowedProjects:[a.id,b.id]};
  capacityLiabilityBytes=2n*BigInt(CREDITS)*RESIDENTIAL_BYTES_PER_CREDIT;
  assert.equal((await readBilling()).stripe.plans[0].can_purchase,true);
  const before=sessions.length;
  const results=await Promise.all([a,b].map(({id,actor})=>control('POST',`/projects/${id}/billing/stripe/checkout`,actor,
   {idempotency_key:randomUUID(),plan_id:PLAN.id})));
  assert.deepEqual(results.map(result=>result.statusCode).sort(),[200,409]);
  assert.equal(results.find(result=>result.statusCode===409).json().error.code,'paid_credit_capacity_unavailable');
  assert.equal(sessions.length,before+1);
  const session=lastSession();session.status='expired';session.url=null;
  const recovered=await app.stripe.recoverCheckout({orderId:session.client_reference_id,sessionId:session.id});
  assert.equal(recovered.state,'expired');
  assert.equal((await readBilling()).stripe.can_checkout,true);
  capacityLiabilityBytes=1_000_000_000_000n;
 });

 await t.test('expiry releases the purchase slot and hosted URLs and customer details stay out of storage',async()=>{
  config.controlPlane.stripe=settings('live');
  const key=randomUUID(),created=await start(key);assert.equal(created.statusCode,200,created.body);
  const expired=lastSession();expired.status='expired';expired.url=null;
  await receive('checkout.session.expired',expired);
  assert.equal((await get(key)).json().state,'expired');assert.equal((await readBilling()).stripe.can_checkout,true);
  assert.equal((await start(randomUUID())).statusCode,200);
  for(const table of ['control_stripe_events','control_stripe_orders','control_stripe_purchases','control_stripe_customers']){
   const records=(await store.pool.query('SELECT * FROM '+table)).rows;
   assert.doesNotMatch(JSON.stringify(records),/never-persist|synthetic-secret|sk_live_|whsec_/);
  }
 });
 await t.test('brokered Checkout and signed relay reach the real inbox and sandbox receipt without a Stripe key in gateway config',async()=>{
  const accountId='acct_test',workerOrigin='https://payment-broker.fixture.example',returnOrigin='https://billing.fixture.example';
  const relayUrl='https://gateway.fixture.example'+RELAY_PATH,keyId='fixture-broker-key',brokerAuthSecret=randomBytes(32).toString('base64url');
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');
  const env={STRIPE_MODE:'test',STRIPE_ACCOUNT_ID:accountId,STRIPE_API_KEY:'rk_test_SyntheticWorkerFixture',STRIPE_WEBHOOK_SECRET:SECRET,
   BROKER_AUTH_SECRET:brokerAuthSecret,RELAY_KEY_ID:keyId,STRIPE_RELAY_ED25519_PKCS8:privateKey.export({type:'pkcs8',format:'der'}).toString('base64'),
   STRIPE_PRICE_IDS:JSON.stringify({[PLAN.id]:PLAN.priceId}),CHECKOUT_RETURN_ORIGIN:returnOrigin,GATEWAY_RELAY_URL:relayUrl,
   BROKER_RATE_LIMIT:{limit:async()=>({success:true})},BROKER_WRITE_RATE_LIMIT:{limit:async()=>({success:true})}};
  const worker=paymentWorker(async(url,options)=>{
   if(url!==relayUrl)return stripeFetch(url,options);
   const response=await app.inject({method:'POST',url:RELAY_PATH,headers:options.headers,payload:options.body});
   return new Response(response.body,{status:response.statusCode,headers:{'Content-Type':'application/json'}});
  });
  brokerRuntime={url:workerOrigin+BROKER_PATH,worker,env};
  config.controlPlane.origins.push(returnOrigin);
  config.controlPlane.sessionSecure=true;
  const {secretKey:_secret,webhookSecret:_webhook,...testSettings}=settings('test');
  config.controlPlane.stripe={...testSettings,transport:'broker',brokerUrl:brokerRuntime.url,brokerReturnOrigin:returnOrigin,brokerAuthSecret,
   relayPublicKeys:{[keyId]:publicKey.export({type:'spki',format:'der'}).toString('base64')}};
  const key=randomUUID(),created=await start(key,{...a.actor,origin:returnOrigin});
  assert.equal(created.statusCode,200,created.body);assert.equal(created.json().state,'awaiting_payment');
  const {session}=paid(lastSession()),fixtureEvent=event('checkout.session.completed',session),raw=JSON.stringify(fixtureEvent,null,2);
  const deliver=payload=>worker.fetch(new Request(workerOrigin+WEBHOOK,{method:'POST',body:payload,
   headers:{'Content-Type':'application/json','Stripe-Signature':signature(payload)}}),env);
  assert.equal((await webhook(raw)).statusCode,404,'broker mode disables the direct gateway webhook');
  assert.equal((await webhook(raw,undefined,{url:RELAY_PATH})).statusCode,400,'gateway requires Worker relay proof');
  assert.equal((await deliver(raw)).status,200);
  const saved=(await store.pool.query('SELECT state,payload_hash FROM control_stripe_events WHERE event_id=$1',[fixtureEvent.id])).rows[0];
  assert.deepEqual(saved,{state:'pending',payload_hash:createHash('sha256').update(raw).digest('hex')});
  const before=await grants();
  assert.equal((await app.stripe.reconcile({eventId:fixtureEvent.id})).applied,1);
  assert.equal((await get(key)).json().state,'test_paid_unapplied');
  assert.equal(await grants(),before);
  assert.equal((await deliver(raw)).status,200);
  assert.equal((await deliver(JSON.stringify({...fixtureEvent,created:1}))).status,502,'a conflicting signed source payload receives no success acknowledgment');
  const receiptCount=(await store.pool.query('SELECT count(*)::int AS n FROM control_stripe_purchases WHERE session_id=$1',[session.id])).rows[0].n;
  assert.equal(receiptCount,1);
 });

 await t.test('verified live purchases upgrade each project once; signup credits survive a payment refund',async()=>{
  brokerRuntime=undefined;
  config.controlPlane.stripe={...settings('live'),allowedProjects:[a.id,b.id]};
  config.controlPlane.unifiedCredits={enabled:true};
  const bPath=`/projects/${b.id}/billing`,bBilling=async()=>{
   const response=await control('GET',bPath,b.actor);assert.equal(response.statusCode,200,response.body);return response.json();
  };
  assert.equal((await bBilling()).credit_balance,undefined);
  assert.equal((await bBilling()).trial.max_daily_operations,10);
  capacityLiabilityBytes=0n;
  delete config.projects[a.id]; // A fresh gateway has not served this project yet.
  await assert.rejects(app.stripe.upgradeExistingProjects(),{code:'unified_credit_activation_capacity_unavailable'});
  assert.ok(config.projects[a.id], 'activation hydrates the policy before evaluating capacity');
  assert.equal((await readBilling()).credit_balance,undefined);
  capacityLiabilityBytes=1_000_000_000_000n;
  const credits=app.v2.controlCredits,readTrial=credits.usage;
  const snapshotRead=Promise.withResolvers(),continueRead=Promise.withResolvers();
  credits.usage=async function(project,client){
   const value=await readTrial.call(this,project,client);
   if(project===a.id&&client){snapshotRead.resolve();await continueRead.promise;}
   return value;
  };
  const duringUpgrade=readBilling();
  try{
   await Promise.race([snapshotRead.promise,duringUpgrade.then(()=>{throw new Error('billing skipped the shared credit snapshot');})]);
   assert.equal(await app.stripe.upgradeExistingProjects(),1);
  }finally{credits.usage=readTrial;continueRead.resolve();}
  const beforeUpgrade=await duringUpgrade;
  assert.equal(beforeUpgrade.credit_balance,undefined);
  assert.equal(beforeUpgrade.credits.available,TRIAL_CREDITS_PER_ACCOUNT);
  assert.equal(beforeUpgrade.paid_credits.available,CREDITS);
  assert.equal(await app.stripe.upgradeExistingProjects(),0);
  const upgraded=await readBilling();
  assert.equal(upgraded.credit_balance.mode,'unified');
  assert.equal(upgraded.credit_balance.available,CREDITS+TRIAL_CREDITS_PER_ACCOUNT);
  assert.equal(upgraded.credits.available,0);assert.equal(upgraded.trial,undefined);
  assert.equal((await bBilling()).credit_balance,undefined);
  const beforePayment=await control('POST',bPath+'/stripe/checkout',b.actor,{idempotency_key:randomUUID(),plan_id:PLAN.id});
  assert.equal(beforePayment.statusCode,200,beforePayment.body);
  assert.equal((await bBilling()).credit_balance,undefined);
  const fixture=paid(lastSession());
  await receive('checkout.session.completed',fixture.session);
  await receive('checkout.session.async_payment_succeeded',fixture.session);
  assert.equal((await bBilling()).credit_balance.available,CREDITS+TRIAL_CREDITS_PER_ACCOUNT);
  const usage=await control('GET',`/projects/${b.id}/usage`,b.actor);
  assert.equal(usage.statusCode,200,usage.body);
  assert.equal(usage.json().credit_balance.available,CREDITS+TRIAL_CREDITS_PER_ACCOUNT);
  assert.equal(usage.json().trial,undefined);
  fixture.charge.amount_refunded=AMOUNT;
  await receive('charge.refunded',fixture.charge);
  assert.equal((await bBilling()).credit_balance.available,TRIAL_CREDITS_PER_ACCOUNT);
  assert.equal((await bBilling()).trial,undefined);
 });

});
