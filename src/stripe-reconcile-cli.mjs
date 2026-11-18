import {readFile} from 'node:fs/promises';
import {ControlPaidCredits} from './control-paid-credits.mjs';
import {ControlStripe} from './control-stripe.mjs';
import {GatewayError} from './policy.mjs';
import {Store} from './store.mjs';

const args=process.argv.slice(2);
const event=args.length===2&&args[0]==='--event';
const checkout=args.length===3&&args[0]==='--checkout-order';
if(!process.env.DATABASE_URL||!event&&!checkout){
 process.stderr.write('Usage: node src/stripe-reconcile-cli.mjs --event evt_ID | --checkout-order ORDER_UUID SESSION_ID\n');
 process.exitCode=2;
}else{
 const store=new Store(process.env.DATABASE_URL);
 try{
  const config=JSON.parse(await readFile(process.env.GATEWAY_CONFIG??'/run/secrets/gateway.json','utf8'));
  const stripe=new ControlStripe({store,config,paidCredits:new ControlPaidCredits({store,config})});
  const result=event?await stripe.reconcile({eventId:args[1]}):await stripe.recoverCheckout({orderId:args[1],sessionId:args[2]});
  process.stdout.write(JSON.stringify(result)+'\n');
  if(result.pending)process.exitCode=1;
 }catch(error){
  process.stderr.write((error instanceof GatewayError?error.code:'stripe_reconciliation_failed')+'\n');
  process.exitCode=1;
 }finally{await store.close();}
}
