import {GatewayError,fail} from './policy.mjs';
import {STRIPE_UUID,approvedPaidCreditPlan,lockStripeSales,oneTimeStripePrice,stripeId,stripeObject} from './control-stripe-provider.mjs';

const SUBJECTS=new Map([
 ['checkout.session.completed','checkout.session'],
 ['checkout.session.async_payment_succeeded','checkout.session'],
 ['checkout.session.expired','checkout.session'],
 ['charge.refunded','charge'],
 ['charge.dispute.created','dispute'],
 ['charge.dispute.closed','dispute'],
]);
const sessionPrefix=mode=>mode==='live'?'cs_live':'cs_test';

export function stripeEventSubject(event){
 const object=SUBJECTS.get(event.type);
 if(!object)return null;
 const subject=event.data?.object;
 const prefix=object==='checkout.session'?sessionPrefix(event.livemode?'live':'test'):object==='charge'?'ch':'dp';
 if(subject?.object!==object||!stripeId(subject?.id,prefix))fail('stripe_event_invalid',400);
 return subject.id;
}

export function checkoutMatches(session,row,customer,config){
 return stripeId(session?.id,sessionPrefix(config.mode))&&stripeObject(session,'checkout.session',session.id,config)&&
  (!row.session_id||session.id===row.session_id)&&session.mode==='payment'&&session.client_reference_id===row.id&&session.customer===customer&&
  session.amount_subtotal===row.plan.amountMinor&&session.amount_total===row.plan.amountMinor&&session.currency===row.plan.currency&&
  approvedPaidCreditPlan(row.plan);
}

export class StripeEvents{
 constructor({store,provider,paidCredits}){this.store=store;this.provider=provider;this.paidCredits=paidCredits;}
 async drain(config,{eventId}={}){
  const scope=[config.mode,config.accountId];
  const inbox=(await this.store.pool.query(`SELECT * FROM control_stripe_events WHERE mode=$1 AND account_id=$2
   AND state='pending' AND next_attempt<=clock_timestamp() AND ($3::text IS NULL OR event_id=$3)
   ORDER BY next_attempt,received_at LIMIT 8`,[...scope,eventId??null])).rows;
  const result={applied:0,ignored:0,pending:0};
  if(!inbox.length)return result;
  await this.provider.assertAccount(config);
  for(const event of inbox){
   try{
    const applied=await this.process(config,event);
    if(!applied)await this.finish(this.store.pool,event,'ignored');
    result[applied?'applied':'ignored']++;
   }catch(error){
    const code=error instanceof GatewayError?error.code:'stripe_reconciliation_internal';
    await this.store.pool.query(`UPDATE control_stripe_events SET attempts=attempts+1,last_error=$4,
     next_attempt=clock_timestamp()+LEAST(3600,5*(2^LEAST(attempts,10))) * interval '1 second'
     WHERE mode=$1 AND account_id=$2 AND event_id=$3 AND state='pending'`,[...scope,event.event_id,code]);
    result.pending++;
   }
  }
  return result;
 }
 async finish(db,event,state){
  await db.query(`UPDATE control_stripe_events SET state=$4,last_error=NULL,processed_at=clock_timestamp()
   WHERE mode=$1 AND account_id=$2 AND event_id=$3 AND state='pending'`,[event.mode,event.account_id,event.event_id,state]);
 }
 async apply(event,fn){
  return this.store.tx(async c=>{
   const pending=await c.query(`SELECT event_id FROM control_stripe_events WHERE mode=$1 AND account_id=$2 AND event_id=$3
    AND state='pending' FOR UPDATE`,[event.mode,event.account_id,event.event_id]);
   if(!pending.rowCount)return true;
   await fn(c);
   await this.finish(c,event,'applied');
   return true;
  });
 }
 async order(config,id){
  if(typeof id!=='string'||!STRIPE_UUID.test(id))return null;
  return (await this.store.pool.query(`SELECT o.*,c.customer_id FROM control_stripe_orders o JOIN control_stripe_customers c
   ON c.mode=o.mode AND c.project=o.project AND c.account_id=o.account_id
   WHERE o.id=$1 AND o.mode=$2 AND o.account_id=$3`,[id,config.mode,config.accountId])).rows[0]??null;
 }
 async process(config,event){
  if(event.event_type.startsWith('checkout.session.'))return this.checkoutEvent(config,event);
  return this.reversalEvent(config,event);
 }
 async checkoutEvent(config,event){
  const id=event.subject_id;
  const session=await this.provider.request(config,'/checkout/sessions/'+id);
  if(!stripeObject(session,'checkout.session',id,config))fail('stripe_checkout_unconfirmed',502);
  const order=await this.order(config,session.client_reference_id);
  if(!order)return false;
  if(!order.customer_id||!checkoutMatches(session,order,order.customer_id,config))fail('stripe_checkout_conflict',409);
  if(event.event_type==='checkout.session.expired'){
   if(session.status!=='expired')return false;
   return this.apply(event,c=>c.query(`UPDATE control_stripe_orders SET state='expired',session_id=$2
    WHERE id=$1 AND state IN ('creating','awaiting_payment') AND (session_id IS NULL OR session_id=$2)`,[order.id,id]));
  }
  if(session.status!=='complete'||session.payment_status!=='paid')fail('stripe_payment_unconfirmed',502);
  const payment=await this.payment(config,session,order);
  return this.apply(event,async c=>{
   await lockStripeSales(c,config.mode);
   await c.query('SELECT id FROM control_projects WHERE id=$1 FOR UPDATE',[order.project]);
   const updated=await c.query(`UPDATE control_stripe_orders SET session_id=$2,state='complete'
    WHERE id=$1 AND (session_id IS NULL OR session_id=$2) AND state<>'expired'`,[order.id,id]);
   if(!updated.rowCount)fail('stripe_checkout_conflict',409);
   const scope=[config.mode,config.accountId,id];
   const previous=(await c.query(`SELECT * FROM control_stripe_purchases
    WHERE mode=$1 AND account_id=$2 AND session_id=$3`,scope)).rows[0];
   if(previous){
    if(previous.order_id!==order.id||previous.project!==order.project||previous.payment_intent_id!==payment.intent.id||
     previous.charge_id!==payment.charge.id)fail('stripe_payment_conflict',409);
    return;
   }
   const reversal=(await c.query(`SELECT * FROM control_stripe_credit_reversals
    WHERE mode=$1 AND account_id=$2 AND charge_id=$3`,[config.mode,config.accountId,payment.charge.id])).rows[0];
   if(reversal&&(reversal.project!==order.project||reversal.session_id!==id||reversal.payment_intent_id!==payment.intent.id))fail('stripe_payment_conflict',409);
   const state=reversal||refunded(payment.charge)?'reversed':config.mode==='live'?'paid':'test_paid_unapplied';
   await c.query(`INSERT INTO control_stripe_purchases(mode,account_id,session_id,order_id,project,payment_intent_id,charge_id,state,paid_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [...scope,order.id,order.project,payment.intent.id,payment.charge.id,state,new Date(payment.charge.created*1000)]);
   const binding={project:order.project,mode:config.mode,accountId:config.accountId};
   if(state==='paid')await this.paidCredits.grantPaidCredits(c,{...binding,checkoutSessionId:id,paymentIntentId:payment.intent.id,
    credits:order.plan.credits,amountMinor:order.plan.amountMinor,currency:order.plan.currency});
   if(config.mode==='live'&&payment.charge.disputed===true){
    await this.paidCredits.setPaymentHold(c,{...binding,holdId:'charge:'+payment.charge.id,active:true});
   }
  });
 }
 async payment(config,session,order){
  const plan=order.plan,intentId=session.payment_intent;
  if(!stripeId(intentId,'pi'))fail('stripe_payment_conflict',409);
  const lines=await this.provider.request(config,'/checkout/sessions/'+session.id+'/line_items?limit=2');
  const line=lines?.data?.[0];
  if(lines?.object!=='list'||lines.has_more!==false||lines.data?.length!==1||line?.object!=='item'||line.quantity!==1||
   line.currency!==plan.currency||line.amount_subtotal!==plan.amountMinor||line.amount_total!==plan.amountMinor||
   line.amount_tax!==0||line.amount_discount!==0||!oneTimeStripePrice(line.price,plan,config))fail('stripe_price_mismatch',409);
  const intent=await this.provider.request(config,'/payment_intents/'+intentId);
  if(!stripeObject(intent,'payment_intent',intentId,config)||intent.customer!==order.customer_id||intent.metadata?.fetchx_checkout!==order.id||
   intent.status!=='succeeded'||intent.amount!==plan.amountMinor||intent.amount_received!==plan.amountMinor||intent.currency!==plan.currency||
   !stripeId(intent.latest_charge,'ch'))fail('stripe_payment_conflict',409);
  const charge=await this.provider.request(config,'/charges/'+intent.latest_charge);
  if(!stripeObject(charge,'charge',intent.latest_charge,config)||charge.payment_intent!==intentId||charge.customer!==order.customer_id||
   charge.paid!==true||charge.captured!==true||charge.amount!==plan.amountMinor||charge.amount_captured!==plan.amountMinor||
   charge.currency!==plan.currency||charge.payment_method_details?.type!=='card'||
   !Number.isSafeInteger(charge.amount_refunded)||charge.amount_refunded<0||typeof charge.disputed!=='boolean'||
   !Number.isSafeInteger(charge.created)||charge.created<=0||charge.created>Math.floor(Date.now()/1000)+300)fail('stripe_payment_conflict',409);
  return {intent,charge};
 }
 async reversalEvent(config,event){
  const id=event.subject_id;
  const dispute=event.event_type.startsWith('charge.dispute.')?await this.provider.request(config,'/disputes/'+id):null;
  if(dispute&&!stripeObject(dispute,'dispute',id,config))fail('stripe_dispute_mismatch',409);
  const chargeId=dispute?dispute.charge:id;
  if(!stripeId(chargeId,'ch'))fail('stripe_charge_mismatch',409);
  const charge=await this.provider.request(config,'/charges/'+chargeId);
  if(!stripeObject(charge,'charge',chargeId,config)||!stripeId(charge.payment_intent,'pi'))fail('stripe_charge_mismatch',409);
  const scope=[config.mode,config.accountId,chargeId];
  const known=(await this.store.pool.query(`SELECT * FROM control_stripe_purchases
   WHERE mode=$1 AND account_id=$2 AND charge_id=$3`,scope)).rows[0];
  let project,sessionId;
  if(known){
   if(known.payment_intent_id!==charge.payment_intent)fail('stripe_charge_mismatch',409);
   ({project,session_id:sessionId}=known);
  }else{
   const params=new URLSearchParams({payment_intent:charge.payment_intent,limit:'2'});
   const list=await this.provider.request(config,'/checkout/sessions?'+params);
   const session=list?.data?.[0];
   if(list?.object!=='list'||list.has_more!==false||list.data?.length!==1||session?.payment_intent!==charge.payment_intent)return false;
   const order=await this.order(config,session.client_reference_id);
   if(!order)return false;
   if(!order.customer_id||!checkoutMatches(session,order,order.customer_id,config)||
    session.status!=='complete'||session.payment_status!=='paid')fail('stripe_checkout_conflict',409);
   const payment=await this.payment(config,session,order);
   if(payment.charge.id!==charge.id)fail('stripe_charge_mismatch',409);
   project=order.project;sessionId=session.id;
  }
  const isRefunded=refunded(charge),lost=dispute?.status==='lost';
  const resolved=lost||dispute?.status==='won'||dispute?.status==='warning_closed';
  if(!isRefunded&&!dispute)return false;
  return this.apply(event,async c=>{
   await lockStripeSales(c,config.mode);
   await c.query('SELECT id FROM control_projects WHERE id=$1 FOR UPDATE',[project]);
   const binding={project,accountId:config.accountId,mode:config.mode};
   if(isRefunded||lost){
    const reversal=await c.query(`INSERT INTO control_stripe_credit_reversals(mode,account_id,charge_id,session_id,payment_intent_id,project,reason)
     VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(mode,account_id,charge_id) DO UPDATE SET charge_id=EXCLUDED.charge_id
     WHERE control_stripe_credit_reversals.session_id=EXCLUDED.session_id AND control_stripe_credit_reversals.project=EXCLUDED.project
      AND control_stripe_credit_reversals.payment_intent_id=EXCLUDED.payment_intent_id`,
     [...scope,sessionId,charge.payment_intent,project,isRefunded?'refund':'dispute_lost']);
    if(!reversal.rowCount)fail('stripe_payment_conflict',409);
    await c.query("UPDATE control_stripe_purchases SET state='reversed' WHERE mode=$1 AND account_id=$2 AND charge_id=$3",scope);
    if(config.mode==='live')await this.paidCredits.revokePaidCredits(c,{...binding,checkoutSessionId:sessionId,paymentIntentId:charge.payment_intent});
   }
   if(config.mode==='live'&&dispute){
    await this.paidCredits.setPaymentHold(c,{...binding,holdId:'charge:'+charge.id,active:!resolved});
    await this.paidCredits.setPaymentHold(c,{...binding,holdId:'dispute:'+id,active:!resolved});
   }
  });
 }
}

function refunded(charge){return charge.refunded===true||Number.isSafeInteger(charge.amount_refunded)&&charge.amount_refunded>0;}
