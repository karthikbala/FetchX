import test from 'node:test';
import assert from 'node:assert/strict';
import {stripeHostedUrl} from '../src/control-stripe-provider.mjs';

test('Stripe-hosted checkout URLs: /c/pay/ and current /g/pay/ for the exact session only',()=>{
 const id='cs_live_abcDEF123',paths=['/c/pay/'+id,'/g/pay/'+id],origin='https://checkout.stripe.com';
 for(const p of ['/c/pay/','/g/pay/'])assert.equal(stripeHostedUrl('https://checkout.stripe.com'+p+id+'#fid123',origin,paths),'https://checkout.stripe.com'+p+id+'#fid123');
 for(const bad of ['https://checkout.stripe.com/x/pay/'+id,'https://checkout.stripe.com/g/pay/cs_live_other','https://evil.example/g/pay/'+id,
  'https://user:pw@checkout.stripe.com/g/pay/'+id,'http://checkout.stripe.com/g/pay/'+id,'https://checkout.stripe.com/g/pay/'+id+'/extra',null,'x'.repeat(5000)])
  assert.equal(stripeHostedUrl(bad,origin,paths),null,String(bad).slice(0,60));
 // A single path string keeps working for existing callers.
 assert.equal(stripeHostedUrl('https://checkout.stripe.com/c/pay/'+id,origin,'/c/pay/'+id),'https://checkout.stripe.com/c/pay/'+id);
});
