import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,generateKeyPairSync,createHmac} from 'node:crypto';
import pg from 'pg';
import {Store} from '../src/store.mjs';
import {ControlStripe} from '../src/control-stripe.mjs';
import {ControlPaidCredits,PAID_CREDIT_RESIDENTIAL_LIABILITY_BYTES} from '../src/control-paid-credits.mjs';
import {grantInitialCredits} from '../src/control-credits.mjs';
import {PACK_OFFERS,BROKER_PATH,RELAY_PATH,STRIPE_VERSION} from '../src/control-stripe-broker-protocol.mjs';
import {paymentWorker} from '../payments-worker/worker.mjs';

const origin='https://billing.example',brokerOrigin='https://payments.example',relayUrl='https://gateway.example'+RELAY_PATH;
const id=prefix=>prefix+'_'+randomBytes(12).toString('hex');
const now=()=>Math.floor(Date.now()/1000);
const liability=credits=>BigInt(credits)*BigInt(PAID_CREDIT_RESIDENTIAL_LIABILITY_BYTES);

test('INR UPI and legacy USD reconcile through the actual Worker into an isolated durable ledger',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const database=new URL(process.env.TEST_DATABASE_URL);assert.match(database.pathname,/^\/gateway_test_[A-Za-z0-9_]+$/);
 const schema='inr_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:database.href,max:1});
 await admin.query('CREATE SCHEMA '+schema);database.searchParams.set('options','-csearch_path='+schema);
 const store=new Store(database.href);await store.init();
 t.after(async()=>{await store.close();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();});
 const user=randomUUID();await store.pool.query('INSERT INTO control_users(id,email) VALUES($1,$2)',[user,'inr-'+user+'@example.test']);
 const projects=['cp_'+randomUUID(),'cp_'+randomUUID()];
 for(const project of projects)await store.tx(async c=>{
  await c.query("INSERT INTO control_projects(id,user_id,name,template_hash) VALUES($1,$2,'INR fixture','synthetic')",[project,user]);
  await grantInitialCredits(c,project,1000);
 });
 const {privateKey,publicKey}=generateKeyPairSync('ed25519'),secret=randomBytes(32).toString('base64url'),webhookSecret='whsec_SyntheticInrOnly';
 const catalog=Object.entries(PACK_OFFERS).map(([id,offer])=>({id,...offer,name:offer.credits.toLocaleString('en-US')+' credits',priceId:'price_'+id.replaceAll('-',''),version:'inr-v1'}));
 const stripeConfig={enabled:true,inrSalesEnabled:true,mode:'live',accountId:'acct_inrfixture',transport:'broker',commercialReviewed:true,allowedProjects:projects,
  catalog,brokerUrl:brokerOrigin+BROKER_PATH,brokerReturnOrigin:origin,brokerAuthSecret:secret,relayPublicKeys:{fixture:publicKey.export({type:'spki',format:'der'}).toString('base64')}};
 const config={controlPlane:{enabled:true,origins:[origin],stripe:stripeConfig}};
 const env={STRIPE_MODE:'live',STRIPE_ACCOUNT_ID:stripeConfig.accountId,STRIPE_API_KEY:'rk_live_SyntheticInrFixtureOnly',STRIPE_WEBHOOK_SECRET:webhookSecret,
  BROKER_AUTH_SECRET:secret,RELAY_KEY_ID:'fixture',STRIPE_RELAY_ED25519_PKCS8:privateKey.export({type:'pkcs8',format:'der'}).toString('base64'),
  STRIPE_PRICE_IDS:JSON.stringify(Object.fromEntries(catalog.map(p=>[p.id,p.priceId]))),CHECKOUT_RETURN_ORIGIN:origin,GATEWAY_RELAY_URL:relayUrl,
  BROKER_RATE_LIMIT:{limit:async()=>({success:true})},BROKER_WRITE_RATE_LIMIT:{limit:async()=>({success:true})}};
 const objects=new Map(),wire=[],sessions=[],byKey=new Map();let stripe,capacity=liability(1_000_000_000);
 const price=offer=>({id:offer.priceId,object:'price',livemode:true,active:true,currency:offer.currency,unit_amount:offer.amountMinor,type:'one_time',billing_scheme:'per_unit',recurring:null});
 const worker=paymentWorker(async(url,options)=>{
  assert.equal(options.redirect,'manual');
  if(url===relayUrl){await stripe.webhookRelay(Buffer.from(options.body),Object.fromEntries(new Headers(options.headers)));return Response.json({received:true});}
  assert.ok(url.startsWith('https://api.stripe.com/v1/'));const path=url.slice('https://api.stripe.com/v1'.length);
  assert.equal(options.headers['Stripe-Version'],STRIPE_VERSION);
  if(options.method==='GET'){
   if(path==='/account')return Response.json({object:'account',id:stripeConfig.accountId});
   const offer=catalog.find(p=>path==='/prices/'+p.priceId);if(offer)return Response.json(price(offer));
   if(path.startsWith('/checkout/sessions?')){const intent=new URLSearchParams(path.split('?')[1]).get('payment_intent');return Response.json({object:'list',has_more:false,data:sessions.filter(s=>s.payment_intent===intent)});}
   assert.ok(objects.has(path),'missing fake Stripe object '+path);return Response.json(objects.get(path));
  }
  assert.equal(options.method,'POST');const key=options.headers['Idempotency-Key'];
  if(byKey.has(key)){assert.equal(byKey.get(key).body,options.body);return Response.json(byKey.get(key).value);}
  const form=new URLSearchParams(options.body);let value;
  if(path==='/customers')value={id:id('cus'),object:'customer',livemode:true,metadata:{fetchx_customer:form.get('metadata[fetchx_customer]')}};
  else{
   assert.equal(path,'/checkout/sessions');const offer=catalog.find(p=>p.priceId===form.get('line_items[0][price]'));assert.ok(offer);
   assert.equal(form.has('payment_method_types[0]'),false);assert.equal(form.get('allowed_payment_method_types[0]'),offer.paymentMethod);
   assert.equal(form.get('adaptive_pricing[enabled]'),'false');wire.push({body:options.body,key,offer:offer.id});
   value={id:id('cs_live'),object:'checkout.session',livemode:true,mode:'payment',client_reference_id:form.get('client_reference_id'),customer:form.get('customer'),
    currency:offer.currency,amount_subtotal:offer.amountMinor,amount_total:offer.amountMinor,status:'open',payment_status:'unpaid',payment_intent:null,
    payment_method_types:[offer.paymentMethod],success_url:origin+'/app/billing?checkout=success',cancel_url:origin+'/app/billing?checkout=cancelled',
    automatic_tax:{enabled:false},allow_promotion_codes:false,total_details:{amount_tax:0,amount_discount:0,amount_shipping:0}};
   value.url='https://checkout.stripe.com/c/pay/'+value.id+'#synthetic-only';sessions.push(value);
  }
  objects.set(path+'/'+value.id,value);byKey.set(key,{body:options.body,value});return Response.json(value);
 });
 const paidCredits=new ControlPaidCredits({store,config});
 stripe=new ControlStripe({store,config,paidCredits,paidCreditReady:async(_project,{purchaseCredits=0,pendingLiabilityBytes=0n,outstandingLiabilityBytes=0n}={})=>
  liability(purchaseCredits)+BigInt(pendingLiabilityBytes)+BigInt(outstandingLiabilityBytes)<=capacity,
 fetchStripe:async(url,options)=>{assert.equal(url,brokerOrigin+BROKER_PATH);return worker.fetch(new Request(url,options),env);}});
 const start=(offer,key=randomUUID(),country,project=projects[0])=>stripe.checkout({project,key,planId:offer,origin,country});
 const deliver=async(type,object)=>{
  const event={id:id('evt'),object:'event',livemode:true,type,data:{object}},raw=JSON.stringify(event),time=now();
  const signature='t='+time+',v1='+createHmac('sha256',webhookSecret).update(time+'.'+raw).digest('hex');
  const response=await worker.fetch(new Request(brokerOrigin+'/webhooks/stripe',{method:'POST',headers:{'Content-Type':'application/json','Stripe-Signature':signature},body:raw}),env);
  assert.equal(response.status,200);return {event,result:await stripe.reconcile({eventId:event.id})};
 };
 const settle=session=>{
  const offer=catalog.find(p=>p.currency===session.currency&&p.amountMinor===session.amount_total),intentId=id('pi'),chargeId=id('ch');
  const intent={id:intentId,object:'payment_intent',livemode:true,customer:session.customer,metadata:{fetchx_checkout:session.client_reference_id},
   amount:offer.amountMinor,amount_received:offer.amountMinor,currency:offer.currency,status:'succeeded',latest_charge:chargeId};
  const charge={id:chargeId,object:'charge',livemode:true,customer:session.customer,payment_intent:intentId,amount:offer.amountMinor,amount_captured:offer.amountMinor,
   currency:offer.currency,paid:true,captured:true,created:now(),amount_refunded:0,refunded:false,disputed:false,payment_method_details:{type:offer.paymentMethod}};
  Object.assign(session,{status:'complete',payment_status:'paid',payment_intent:intentId,url:null});
  objects.set('/payment_intents/'+intentId,intent);objects.set('/charges/'+chargeId,charge);
  objects.set('/checkout/sessions/'+session.id+'/line_items?limit=2',{object:'list',has_more:false,data:[{object:'item',quantity:1,currency:offer.currency,
   amount_subtotal:offer.amountMinor,amount_total:offer.amountMinor,amount_tax:0,amount_discount:0,price:price(offer)}]});
  return {session,intent,charge};
 };
 const usage=()=>paidCredits.usage(projects[0]);const last=()=>sessions.at(-1);let usd,inr;
 await t.test('saved USD checkout and populated ledger survive INR geography and legacy constraint upgrades',async()=>{
  stripeConfig.catalog=[catalog.find(p=>p.id==='credits-10000')];const key=randomUUID();await start('credits-10000',key);
  const body=(await store.pool.query('SELECT request_body FROM control_stripe_orders')).rows[0].request_body;
  stripeConfig.catalog=catalog;assert.equal((await start('credits-10000',key,'IN')).currency,'usd');
  assert.equal((await store.pool.query('SELECT request_body FROM control_stripe_orders')).rows[0].request_body,body);
  usd=settle(last());assert.equal((await deliver('checkout.session.completed',usd.session)).result.applied,1);assert.equal((await usage()).available,10000);
  const before=(await store.pool.query('SELECT to_jsonb(g) AS row FROM paid_credit_grants g')).rows;
  await store.pool.query(`ALTER TABLE paid_credit_grants DROP CONSTRAINT paid_credit_grants_currency_check;
   ALTER TABLE paid_credit_grants ADD CONSTRAINT paid_credit_grants_currency_check CHECK(currency='usd');
   ALTER TABLE control_stripe_orders DROP CONSTRAINT control_stripe_orders_state_check;
   ALTER TABLE control_stripe_orders ADD CONSTRAINT control_stripe_orders_state_check CHECK(state IN ('creating','awaiting_payment','complete','expired'));`);
  await store.init();await store.init();assert.deepEqual((await store.pool.query('SELECT to_jsonb(g) AS row FROM paid_credit_grants g')).rows,before);
 });
 await t.test('INR UPI validates canonical evidence and grants once after actual success',async()=>{
  const india=await stripe.billing(projects[0],{country:'IN'});assert.equal(india.currency,'inr');assert.equal(india.plans.length,4);assert.ok(india.plans.every(p=>p.currency==='inr'));
  await assert.rejects(start('credits-10000',randomUUID(),'IN'),{code:'stripe_plan_invalid'});await assert.rejects(start('credits-10000-inr'),{code:'stripe_plan_invalid'});
  await start('credits-10000-inr',randomUUID(),'IN');const session=last();assert.equal(session.currency,'inr');assert.equal(session.amount_total,17500);
  Object.assign(session,{status:'complete',url:null});assert.equal((await deliver('checkout.session.completed',session)).result.applied,1);assert.equal((await usage()).available,10000);
  inr=settle(session);inr.charge.payment_method_details.type='card';const rejected=await deliver('checkout.session.async_payment_succeeded',session);assert.equal(rejected.result.pending,1);assert.equal((await usage()).available,10000);
  inr.charge.payment_method_details.type='upi';assert.equal((await stripe.reconcile({eventId:rejected.event.id})).applied,1);
  await deliver('checkout.session.completed',session);await deliver('checkout.session.async_payment_succeeded',session);assert.equal((await usage()).available,20000);
  const grant=(await store.pool.query('SELECT currency,amount_minor,credits FROM paid_credit_grants WHERE checkout_session_id=$1',[session.id])).rows[0];
  assert.deepEqual(grant,{currency:'inr',amount_minor:17500,credits:'10000'});
 });
 await t.test('mixed currency pending sales consume the same provider liability pool',async()=>{
  capacity=liability(1_020_000);
  assert.equal((await stripe.billing(projects[0],{country:'IN'})).plans.find(p=>p.id==='credits-1000000-inr').can_purchase,true);
  await start('credits-10000',randomUUID(),'US',projects[1]);
  await assert.rejects(start('credits-1000000-inr',randomUUID(),'IN'),{code:'paid_credit_capacity_unavailable'});
  const session=last();session.status='expired';session.url=null;await deliver('checkout.session.expired',session);
  assert.equal((await stripe.billing(projects[0],{country:'IN'})).plans.find(p=>p.id==='credits-1000000-inr').can_purchase,true);capacity=liability(1_000_000_000);
 });
 await t.test('UPI refund status is read fresh and clearing its hold cannot clear an existing dispute',async()=>{
  const refund={id:id('re'),object:'refund',amount:1,currency:'inr',charge:inr.charge.id,payment_intent:inr.intent.id,status:'pending'};objects.set('/refunds/'+refund.id,refund);
  await deliver('refund.created',refund);assert.equal((await usage()).payment_hold,true);assert.equal((await usage()).granted,20000);
  const dispute={id:id('dp'),object:'dispute',livemode:true,charge:usd.charge.id,status:'needs_response'};objects.set('/disputes/'+dispute.id,dispute);
  await deliver('charge.dispute.created',dispute);refund.status='failed';await deliver('refund.failed',refund);await deliver('refund.created',refund);
  assert.equal((await usage()).payment_hold,true);dispute.status='won';await deliver('charge.dispute.closed',dispute);assert.equal((await usage()).available,20000);
  const success={...refund,id:id('re'),status:'pending'};objects.set('/refunds/'+success.id,success);await deliver('refund.created',success);success.status='succeeded';
  await deliver('refund.updated',success);await deliver('refund.created',success);assert.equal((await usage()).payment_hold,false);assert.equal((await usage()).available,10000);
 });
 await t.test('INR sales can pause independently while USD sales and saved INR Checkout recovery remain available',async()=>{
  const key=randomUUID();await start('credits-10000-inr',key,'IN');const session=last();stripeConfig.inrSalesEnabled=false;
  const india=await stripe.billing(projects[0],{country:'IN'}),usa=await stripe.billing(projects[1],{country:'US'});
  assert.equal(india.currency,'inr');assert.ok(india.plans.every(p=>!p.can_purchase));assert.equal(india.can_resume_checkout,true);
  assert.equal((await start('credits-10000-inr',key,'IN')).checkout_url,session.url);assert.equal(usa.can_checkout,true);
  session.status='expired';session.url=null;await deliver('checkout.session.expired',session);
  await assert.rejects(start('credits-10000-inr',randomUUID(),'IN'),{code:'stripe_checkout_disabled'});
  assert.equal((await stripe.billing(projects[0],{country:'IN'})).checkout_unavailable_reason,'stripe_currency_unavailable');
  stripeConfig.inrSalesEnabled=true;
 });
 await t.test('UPI QR failure keeps an open Checkout recoverable until real Session expiry',async()=>{
  const key=randomUUID();await start('credits-10000-inr',key,'IN');const session=last(),intentId=id('pi');session.payment_intent=intentId;
  objects.set('/payment_intents/'+intentId,{id:intentId,object:'payment_intent',livemode:true,customer:session.customer,metadata:{fetchx_checkout:session.client_reference_id},
   amount:17500,amount_received:0,currency:'inr',status:'requires_payment_method',latest_charge:null});
  assert.equal((await deliver('payment_intent.payment_failed',{id:intentId,object:'payment_intent'})).result.applied,1);
  assert.equal((await stripe.status(projects[0],key)).state,'awaiting_payment');assert.equal((await start('credits-10000-inr',key,'IN')).checkout_url,session.url);
  session.status='expired';session.url=null;await deliver('checkout.session.expired',session);assert.equal((await stripe.status(projects[0],key)).state,'expired');
 });
 await t.test('confirmed asynchronous failed payment is terminal and grants no credits',async()=>{
  const key=randomUUID();await start('credits-10000-inr',key,'IN');const session=last(),intentId=id('pi');Object.assign(session,{status:'complete',payment_intent:intentId,url:null});
  objects.set('/payment_intents/'+intentId,{id:intentId,object:'payment_intent',livemode:true,customer:session.customer,metadata:{fetchx_checkout:session.client_reference_id},
   amount:17500,amount_received:0,currency:'inr',status:'requires_payment_method',latest_charge:null});
  assert.equal((await deliver('checkout.session.async_payment_failed',session)).result.applied,1);assert.equal((await stripe.status(projects[0],key)).state,'failed');
  assert.equal((await usage()).available,10000);assert.ok((await stripe.billing(projects[0],{country:'IN'})).can_checkout);
 });
});
