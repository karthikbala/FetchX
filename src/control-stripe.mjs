import {randomUUID} from 'node:crypto';
import {fail} from './policy.mjs';
import {PAID_CREDIT_RESIDENTIAL_LIABILITY_BYTES,outstandingPaidCreditLiabilitySql,unifiedCreditsEnabled} from './control-paid-credits.mjs';
import {
 STRIPE_BODY_LIMIT,STRIPE_CREATE_WINDOW_MS,STRIPE_UUID,STRIPE_VERSION,StripeProvider,lockStripeSales,stripeHash,stripeHostedUrl,
 stripeId,stripeObject,stripeProjectAllowed,stripeSettings,verifiedStripeEvent,verifiedStripeRelay,
} from './control-stripe-provider.mjs';
import {StripeEvents,checkoutMatches,stripeEventSubject} from './control-stripe-events.mjs';
import {BROKER_MAX_BODY,RELAY_PATH,STRIPE_WEBHOOK_PATH,checkoutForm,customerForm} from './control-stripe-broker-protocol.mjs';

export async function initControlStripe(pool){
 await pool.query(`
  CREATE TABLE IF NOT EXISTS control_stripe_customers (
   mode text NOT NULL CHECK(mode IN ('test','live')), account_id text NOT NULL, project text NOT NULL REFERENCES control_projects(id),
   creation_key uuid NOT NULL UNIQUE, api_version text NOT NULL, request_body text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
   customer_id text, PRIMARY KEY(mode,project), UNIQUE(mode,account_id,customer_id)
  );
  CREATE TABLE IF NOT EXISTS control_stripe_orders (
   id uuid PRIMARY KEY, mode text NOT NULL, account_id text NOT NULL, project text NOT NULL, operation_key uuid NOT NULL,
   plan jsonb NOT NULL, return_origin text NOT NULL, api_version text NOT NULL, request_body text,
   created_at timestamptz NOT NULL DEFAULT now(), state text NOT NULL DEFAULT 'creating' CHECK(state IN ('creating','awaiting_payment','complete','expired')),
   session_id text, FOREIGN KEY(mode,project) REFERENCES control_stripe_customers(mode,project),
   UNIQUE(mode,project,operation_key), UNIQUE(mode,account_id,session_id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS control_stripe_one_open_checkout ON control_stripe_orders(mode,project)
   WHERE state IN ('creating','awaiting_payment');
  CREATE TABLE IF NOT EXISTS control_stripe_events (
   mode text NOT NULL CHECK(mode IN ('test','live')), account_id text NOT NULL, event_id text NOT NULL,
   event_type text NOT NULL, subject_id text NOT NULL, payload_hash text NOT NULL,
   state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','applied','ignored')),
   attempts integer NOT NULL DEFAULT 0, last_error text, next_attempt timestamptz NOT NULL DEFAULT now(),
   received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz,
   PRIMARY KEY(mode,account_id,event_id)
  );
  CREATE INDEX IF NOT EXISTS control_stripe_events_pending ON control_stripe_events(mode,account_id,next_attempt)
   WHERE state='pending';
  CREATE TABLE IF NOT EXISTS control_stripe_purchases (
   mode text NOT NULL, account_id text NOT NULL, session_id text NOT NULL, order_id uuid NOT NULL UNIQUE REFERENCES control_stripe_orders(id),
   project text NOT NULL REFERENCES control_projects(id), payment_intent_id text NOT NULL, charge_id text NOT NULL,
   state text NOT NULL CHECK(state IN ('paid','test_paid_unapplied','reversed')), paid_at timestamptz NOT NULL,
   PRIMARY KEY(mode,account_id,session_id), UNIQUE(mode,account_id,charge_id), UNIQUE(mode,account_id,payment_intent_id)
  );
  CREATE INDEX IF NOT EXISTS control_stripe_purchases_project ON control_stripe_purchases(project,mode,account_id,paid_at DESC);
  CREATE TABLE IF NOT EXISTS control_stripe_credit_reversals (
   mode text NOT NULL, account_id text NOT NULL, charge_id text NOT NULL, session_id text NOT NULL, payment_intent_id text NOT NULL,
   project text NOT NULL REFERENCES control_projects(id), reason text NOT NULL CHECK(reason IN ('refund','dispute_lost')),
   recorded_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(mode,account_id,charge_id)
  );
 `);
}

function checkKey(key){if(typeof key!=='string'||!STRIPE_UUID.test(key))fail('stripe_checkout_key_invalid',400);}
function checkOrigin(control,origin){
 if(typeof origin!=='string'||!control.origins.includes(origin)||
  !(origin.startsWith('https://')||control.allowLoopbackDevelopment===true&&/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(origin)))fail('origin_rejected',403);
}
function resumeBefore(row,limit){
 if(Date.now()-row.created_at.getTime()>=limit)fail('stripe_checkout_reconciliation_required',409);
}
function planView(plan){return {id:plan.id,name:plan.name,amount_minor:plan.amountMinor,currency:plan.currency,credits:plan.credits};}
function checkoutView(row,state=row.state){return {mode:row.mode,state,plan_id:row.plan.id};}
function savedCheckoutState(row){
 if(row.purchase_state)return row.purchase_state;
 if(row.state==='creating'&&Date.now()-row.created_at.getTime()>=STRIPE_CREATE_WINDOW_MS)return 'reconciliation_required';
 return row.state;
}

export class ControlStripe {
 constructor({store,config,paidCredits,paidCreditReady,hydrateProject,fetchStripe}){
  this.store=store;this.config=config;this.paidCredits=paidCredits;this.paidCreditReady=paidCreditReady;this.hydrateProject=hydrateProject;
  this.allowDirect=typeof fetchStripe==='function';
  this.provider=new StripeProvider(fetchStripe);
  this.events=new StripeEvents({store,provider:this.provider,paidCredits});
 }
 settings(){return stripeSettings(this.config,{allowDirect:this.allowDirect});}
 configuration(project){
  const stripe=this.settings();
  if(!stripe||project!==undefined&&(!stripe.salesEnabled||!stripeProjectAllowed(stripe,project)))fail('stripe_checkout_disabled',404);
  return stripe;
 }
 ready(){return !!this.settings();}
 webhookReady(path){return this.settings()?.transport===(path===RELAY_PATH?'broker':'direct');}
 async billing(project){
  const config=this.settings();
  if(!config)return null;
  const sales=config.salesEnabled&&stripeProjectAllowed(config,project),scope=[config.mode,config.accountId,project];
  const [drafts,history]=await Promise.all([
   this.store.pool.query(`SELECT id,operation_key,state,plan,created_at FROM control_stripe_orders
    WHERE mode=$1 AND account_id=$2 AND project=$3 AND state IN ('creating','awaiting_payment') LIMIT 1`,scope),
   this.store.pool.query(`SELECT p.state,p.paid_at,o.plan FROM control_stripe_purchases p JOIN control_stripe_orders o ON o.id=p.order_id
    WHERE p.mode=$1 AND p.account_id=$2 AND p.project=$3 ORDER BY p.paid_at DESC,p.session_id LIMIT 50`,scope),
  ]);
  if(!sales&&!drafts.rowCount&&!history.rowCount)return null;
  const held=sales&&config.mode==='live'&&await this.paidCredits.paymentHeld(project);
  const ready=sales&&!held&&await this.paidCreditReady(project,{publicOnly:true});
  const row=drafts.rows[0];
  const pending=row?{plan_id:row.plan.id,idempotency_key:row.operation_key,state:savedCheckoutState(row)}:null;
  const {plans,canResume}=await this.withSalesCapacity(config,async client=>{
   const obligations=ready&&config.mode==='live'?await this.salesObligations(client):{};
   const plans=[];
   for(const plan of sales?config.catalog:[]){
    plans.push({...planView(plan),can_purchase:ready&&await this.packageFits(project,config,plan,obligations,client)});
   }
   const canResume=!!pending&&ready&&pending.state!=='reconciliation_required'&&await this.packageFits(
    project,config,row.plan,config.mode==='live'?await this.salesObligations(client,row.id):{},client);
   return {plans,canResume};
  });
  const eligible=plans.some(plan=>plan.can_purchase);
  const purchases=history.rows.map(({plan,state,paid_at})=>({
   plan_id:plan.id,name:plan.name,amount_minor:plan.amountMinor,currency:plan.currency,credits:plan.credits,status:state,paid_at,
  }));
  return {mode:config.mode,plans,pending_checkout:pending,can_checkout:eligible&&!pending,can_manage:false,purchases,
   ...(pending?{can_resume_checkout:canResume}:{}),
   ...(sales&&!eligible&&!canResume?{checkout_unavailable_reason:held?'paid_credit_payment_hold':ready?'paid_credit_capacity_unavailable':'paid_credit_route_unavailable'}:{})};
 }
 async withSalesCapacity(config,fn){
  if(config.mode!=='live')return fn(this.store.pool);
  return this.store.tx(async c=>{
   await lockStripeSales(c,config.mode);
   return fn(c);
  });
 }
 async salesObligations(client,except=null){
  const {rows:[row]}=await client.query(`SELECT COALESCE(sum(((o.plan->>'credits')::bigint+
   CASE WHEN $3 AND u.project IS NULL THEN COALESCE(a.granted_credits,0) ELSE 0 END)*$2::bigint),0) AS pending_bytes,
   (${outstandingPaidCreditLiabilitySql}) AS outstanding_bytes FROM control_stripe_orders o
   LEFT JOIN control_credit_accounts a ON a.project=o.project LEFT JOIN control_credit_upgrades u ON u.project=o.project
   WHERE o.mode='live' AND o.state IN ('creating','awaiting_payment') AND ($1::uuid IS NULL OR o.id<>$1)`,
  [except,PAID_CREDIT_RESIDENTIAL_LIABILITY_BYTES,unifiedCreditsEnabled(this.config)]);
  const pendingLiabilityBytes=BigInt(row.pending_bytes),outstandingLiabilityBytes=BigInt(row.outstanding_bytes);
  if(pendingLiabilityBytes<0n||outstandingLiabilityBytes<0n)fail('paid_credit_capacity_unavailable',409);
  return {pendingLiabilityBytes,outstandingLiabilityBytes};
 }
 async packageFits(project,config,plan,obligations,client){
  if(config.mode==='test')return true;
  const signupCredits=unifiedCreditsEnabled(this.config)?await this.unconvertedSignupCredits(client,project):0;
  return this.paidCreditReady(project,{publicOnly:true,purchaseCredits:plan.credits+signupCredits,...obligations,client});
 }
 async unconvertedSignupCredits(client,project){
  // Reserve against the full grant so concurrent signup settlement can only
  // reduce the obligation before a Checkout opens or completes.
  const row=(await client.query(`SELECT a.granted_credits FROM control_credit_accounts a WHERE a.project=$1
   AND NOT EXISTS(SELECT 1 FROM control_credit_upgrades u WHERE u.project=a.project)`,[project])).rows[0];
  return Number(row?.granted_credits??0);
 }
 async upgradeExistingProjects(){
  if(!unifiedCreditsEnabled(this.config))return 0;
  return this.withSalesCapacity({mode:'live'},async c=>{
   const {rows}=await c.query(`SELECT DISTINCT p.project FROM control_stripe_purchases p
    JOIN control_projects cp ON cp.id=p.project AND cp.status='active'
    JOIN paid_credit_grants g ON g.project=p.project AND g.account_id=p.account_id AND g.mode=p.mode
     AND g.checkout_session_id=p.session_id AND g.payment_intent_id=p.payment_intent_id
    WHERE p.mode='live' AND p.state='paid' AND g.revoked_at IS NULL AND g.credits IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM control_credit_upgrades u WHERE u.project=p.project) ORDER BY p.project`);
   let upgraded=0;
   for(const {project} of rows){
    // Managed project policies are loaded from PostgreSQL, not the static
    // gateway config. Startup has no incoming request to hydrate them.
    if(!this.config.projects?.[project])await this.hydrateProject?.(project);
    const signupCredits=await this.unconvertedSignupCredits(c,project);
    if(signupCredits>0&&!await this.paidCreditReady(project,{publicOnly:true,purchaseCredits:signupCredits,...await this.salesObligations(c),client:c}))
     fail('unified_credit_activation_capacity_unavailable',503);
    if(await this.paidCredits.upgradeEligibleProject(c,project))upgraded++;
   }
   return upgraded;
  });
 }
 async assertCapacity(project,config,plan,client=this.store.pool,except=null){
  if(config.mode!=='live')return;
  if(await this.paidCredits.paymentHeld(project,client))fail('paid_credit_payment_hold',409);
  if(!await this.packageFits(project,config,plan,await this.salesObligations(client,except),client))fail('paid_credit_capacity_unavailable',409);
 }
 async find(project,config,key,db=this.store.pool){
  return (await db.query(`SELECT o.*,p.state AS purchase_state FROM control_stripe_orders o
   LEFT JOIN control_stripe_purchases p ON p.order_id=o.id
   WHERE o.mode=$1 AND o.account_id=$2 AND o.project=$3 AND o.operation_key=$4`,
   [config.mode,config.accountId,project,key])).rows[0];
 }
 async status(project,key){
  const config=this.configuration();checkKey(key);
  const row=await this.find(project,config,key);
  if(!row)fail('stripe_checkout_not_found',404);
  return checkoutView(row,savedCheckoutState(row));
 }
 async prepareOrder(project,config,plan,key,origin){
  return this.store.tx(async c=>{
   await lockStripeSales(c,config.mode);
   const active=(await c.query('SELECT status FROM control_projects WHERE id=$1 FOR UPDATE',[project])).rows[0];
   if(active?.status!=='active')fail('project_inactive',403);
   const prior=await this.find(project,config,key,c);
   if(prior)return prior;
   const customerKey=randomUUID();
   const customerBody=customerForm(customerKey);
   await c.query(`INSERT INTO control_stripe_customers(mode,account_id,project,creation_key,api_version,request_body)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(mode,project) DO NOTHING`,
    [config.mode,config.accountId,project,customerKey,STRIPE_VERSION,customerBody]);
   const binding=(await c.query('SELECT account_id FROM control_stripe_customers WHERE mode=$1 AND project=$2',[config.mode,project])).rows[0];
   if(binding.account_id!==config.accountId)fail('stripe_account_mismatch',409);
   const open=await c.query(`SELECT 1 FROM control_stripe_orders WHERE mode=$1 AND project=$2
    AND state IN ('creating','awaiting_payment') LIMIT 1`,[config.mode,project]);
   if(open.rowCount)fail('stripe_checkout_already_open',409);
   await this.assertCapacity(project,config,plan,c);
   return (await c.query(`INSERT INTO control_stripe_orders(id,mode,account_id,project,operation_key,plan,return_origin,api_version)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[randomUUID(),config.mode,config.accountId,project,key,plan,origin,STRIPE_VERSION])).rows[0];
  });
 }
 async customer(project,config){
  const binding=(await this.store.pool.query('SELECT * FROM control_stripe_customers WHERE mode=$1 AND account_id=$2 AND project=$3',
   [config.mode,config.accountId,project])).rows[0];
  if(!binding)fail('stripe_account_mismatch',409);
  if(binding.customer_id)return binding.customer_id;
  resumeBefore(binding,STRIPE_CREATE_WINDOW_MS);
  const customer=await this.provider.request(config,'/customers',{body:binding.request_body,key:'fetchx-customer-'+binding.creation_key,version:binding.api_version});
  if(!stripeId(customer?.id,'cus')||!stripeObject(customer,'customer',customer.id,config)||customer.metadata?.fetchx_customer!==binding.creation_key)fail('stripe_customer_mismatch',502);
  const saved=await this.store.pool.query(`UPDATE control_stripe_customers SET customer_id=$2
   WHERE creation_key=$1 AND (customer_id IS NULL OR customer_id=$2) RETURNING customer_id`,[binding.creation_key,customer.id]);
  if(!saved.rowCount)fail('stripe_customer_mismatch',502);
  return customer.id;
 }
 async checkout({project,key,planId,origin}){
  const config=this.configuration(project);checkKey(key);checkOrigin(this.config.controlPlane,origin);
  if(config.transport==='broker'&&origin!==config.brokerReturnOrigin)fail('origin_rejected',403);
  let row=await this.find(project,config,key);
  if(row&&(row.plan.id!==planId||row.return_origin!==origin))fail('stripe_checkout_conflict',409);
  if(row&&(row.state==='complete'||row.state==='expired'))return checkoutView(row,savedCheckoutState(row));
  if(!await this.paidCreditReady(project,{publicOnly:true}))fail('paid_credit_route_unavailable',409);
  if(!row){
   const plan=config.catalog.find(item=>item.id===planId);
   if(!plan)fail('stripe_plan_invalid',400);
   await this.withSalesCapacity(config,c=>this.assertCapacity(project,config,plan,c));
   await this.provider.assertAccount(config);
   await this.provider.assertPrice(config,plan);
   row=await this.prepareOrder(project,config,plan,key,origin);
  }
  if(row.plan.id!==planId||row.return_origin!==origin)fail('stripe_checkout_conflict',409);
  if(row.state==='complete'||row.state==='expired')return checkoutView(row,savedCheckoutState(row));
  if(!row.session_id)resumeBefore(row,STRIPE_CREATE_WINDOW_MS);
  await this.withSalesCapacity(config,c=>this.assertCapacity(project,config,row.plan,c,row.id));
  row=await this.find(project,config,key);
  if(row.state==='complete'||row.state==='expired')return checkoutView(row,savedCheckoutState(row));
  await this.provider.assertAccount(config);
  const customer=await this.customer(project,config);
  if(!row.request_body){
   const body=checkoutForm({orderId:row.id,customerId:customer,priceId:row.plan.priceId,
    expiresAt:Math.floor(row.created_at.getTime()/1000)+3600,returnOrigin:origin});
   row=(await this.store.pool.query(`UPDATE control_stripe_orders SET request_body=COALESCE(request_body,$2)
    WHERE id=$1 AND state='creating' AND session_id IS NULL RETURNING *`,[row.id,body])).rows[0]??await this.find(project,config,key);
  }
  if(row.state==='complete'||row.state==='expired')return checkoutView(row,savedCheckoutState(row));
  const session=row.session_id
   ?await this.provider.request(config,'/checkout/sessions/'+row.session_id,{version:row.api_version})
   :await this.provider.request(config,'/checkout/sessions',{body:row.request_body,key:'fetchx-checkout-'+row.id,version:row.api_version});
  if(!checkoutMatches(session,row,customer,config))fail('stripe_checkout_unconfirmed',502);
  if(!row.session_id){
   const result=await this.store.pool.query(`UPDATE control_stripe_orders SET session_id=$2,
    state=CASE WHEN state='creating' THEN 'awaiting_payment' ELSE state END
    WHERE id=$1 AND (session_id IS NULL OR session_id=$2) RETURNING *`,[row.id,session.id]);
   if(!result.rowCount)fail('stripe_checkout_unconfirmed',502);
   row=result.rows[0];
  }else row=await this.find(project,config,key);
  if(row.state==='complete'||row.state==='expired')return checkoutView(row,savedCheckoutState(row));
  if(session.status==='expired'){
   await this.store.pool.query("UPDATE control_stripe_orders SET state='expired' WHERE id=$1 AND state='awaiting_payment'",[row.id]);
   return checkoutView(row,'expired');
  }
  if(session.status==='complete')return checkoutView(row,'awaiting_webhook');
  const url=stripeHostedUrl(session.url,'https://checkout.stripe.com','/c/pay/'+session.id);
  if(session.status!=='open'||session.payment_status!=='unpaid'||!url)fail('stripe_checkout_unconfirmed',502);
  return {...checkoutView(row),checkout_url:url};
 }
 async webhook(body,signature){
  const config=this.configuration();
  if(config.transport!=='direct')fail('not_found',404);
  const event=verifiedStripeEvent(body,signature,config),subject=stripeEventSubject(event);
  if(subject)await this.saveEvent(config,{eventId:event.id,eventType:event.type,subject,payloadHash:stripeHash(body)});
 }
 async webhookRelay(body,headers){
  const config=this.configuration();
  if(config.transport!=='broker')fail('not_found',404);
  const event=verifiedStripeRelay(body,headers,config);
  await this.saveEvent(config,{eventId:event.event_id,eventType:event.event_type,subject:event.subject_id,payloadHash:event.provider_payload_sha256});
 }
 async saveEvent(config,{eventId,eventType,subject,payloadHash}){
  const received=await this.store.pool.query(`INSERT INTO control_stripe_events(mode,account_id,event_id,event_type,subject_id,payload_hash)
   VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(mode,account_id,event_id) DO UPDATE SET event_id=EXCLUDED.event_id
   WHERE control_stripe_events.payload_hash=EXCLUDED.payload_hash AND control_stripe_events.event_type=EXCLUDED.event_type
    AND control_stripe_events.subject_id=EXCLUDED.subject_id RETURNING event_id`,
   [config.mode,config.accountId,eventId,eventType,subject,payloadHash]);
  if(!received.rowCount)fail('stripe_event_conflict',409);
 }
 async recoverCheckout({orderId,sessionId}){
  const config=this.configuration();
  const prefix=config.mode==='live'?'cs_live':'cs_test';
  if(!stripeId(sessionId,prefix))fail('stripe_checkout_conflict',409);
  const row=await this.events.order(config,orderId);
  if(!row||!row.customer_id)fail('stripe_checkout_not_found',404);
  await this.provider.assertAccount(config);
  const session=await this.provider.request(config,'/checkout/sessions/'+sessionId);
  if(!checkoutMatches(session,row,row.customer_id,config)||session.id!==sessionId||
   !['open','complete','expired'].includes(session.status))fail('stripe_checkout_conflict',409);
  const saved=await this.store.pool.query(`UPDATE control_stripe_orders SET session_id=$2,state=CASE
   WHEN state IN ('complete','expired') THEN state WHEN $3='expired' THEN 'expired' ELSE 'awaiting_payment' END
   WHERE id=$1 AND (session_id IS NULL OR session_id=$2) RETURNING *`,[row.id,session.id,session.status]);
  if(!saved.rowCount)fail('stripe_checkout_conflict',409);
  const recovered=await this.find(row.project,config,row.operation_key);
  return checkoutView(recovered,session.status==='complete'&&recovered.state==='awaiting_payment'?'awaiting_webhook':savedCheckoutState(recovered));
 }
 async reconcile({eventId}={}){
  const config=this.configuration();
  if(eventId!==undefined){
   if(!stripeId(eventId,'evt'))fail('stripe_event_invalid',400);
   const replay=await this.store.pool.query(`UPDATE control_stripe_events SET state='pending',next_attempt=clock_timestamp()
    WHERE mode=$1 AND account_id=$2 AND event_id=$3 AND state IN ('pending','ignored')`,[config.mode,config.accountId,eventId]);
   if(!replay.rowCount)fail('stripe_event_not_replayable',409);
  }
  return this.events.drain(config,{eventId});
 }
}

export const isStripeWebhookRequest=req=>req.method==='POST'&&[STRIPE_WEBHOOK_PATH,RELAY_PATH].includes(req.url);
export function registerStripeWebhook(app,stripe,{autoProcess=true}={}){
 let timer,working;
 app.addHook('onReady',async()=>{
  if(!autoProcess)return;
  timer=setInterval(()=>{
   if(!working&&stripe.ready())working=stripe.reconcile().catch(()=>process.stderr.write('stripe_reconciliation_failed\n')).finally(()=>{working=null;});
  },2000);
  timer.unref();
 });
 app.addHook('onClose',async()=>{clearInterval(timer);await working;});
 app.register(async scope=>{
  scope.removeContentTypeParser('application/json');
  scope.addContentTypeParser('application/json',{parseAs:'buffer'},(_req,body,done)=>done(null,body));
  for(const [path,bodyLimit] of [[STRIPE_WEBHOOK_PATH,STRIPE_BODY_LIMIT],[RELAY_PATH,BROKER_MAX_BODY]]){
   scope.post(path,{bodyLimit,onRequest:async(req,reply)=>{
    reply.header('Cache-Control','no-store');
    if(!isStripeWebhookRequest(req)||!stripe.webhookReady(path))fail('not_found',404);
   }},async req=>{
    if(path===RELAY_PATH)await stripe.webhookRelay(req.body,req.headers);
    else await stripe.webhook(req.body,req.headers['stripe-signature']);
    return {received:true};
   });
  }
 });
}
