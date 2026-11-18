export const BROKER_PATH='/broker/v1';
export const RELAY_PATH='/webhooks/stripe/relay';
export const STRIPE_WEBHOOK_PATH='/webhooks/stripe';
export const STRIPE_VERSION='2026-10-28.endive';
export const BROKER_MAX_BODY=4096;
export const STRIPE_MAX_BODY=128*1024;
export const BROKER_TIME_WINDOW=60;
export const RELAY_TIME_WINDOW=300;
export const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const KEY_ID=/^[A-Za-z0-9_.-]{1,64}$/;
export const SHA256=/^[a-f0-9]{64}$/;
export const BROKER_SECRET=/^[A-Za-z0-9_-]{43}$/;
export const PACK_AMOUNTS=Object.freeze({'credits-10000':200,'credits-50000':800,'credits-150000':2000,'credits-1000000':10000});
export const EVENT_SUBJECTS=Object.freeze({
 'checkout.session.completed':'checkout.session',
 'checkout.session.async_payment_succeeded':'checkout.session',
 'checkout.session.expired':'checkout.session',
 'charge.refunded':'charge',
 'charge.dispute.created':'dispute',
 'charge.dispute.closed':'dispute',
});
const encode=new TextEncoder();
export const stripeId=(value,prefix)=>typeof value==='string'&&value.startsWith(prefix+'_')&&/^[A-Za-z0-9]{1,200}$/.test(value.slice(prefix.length+1));
export const uuid=value=>typeof value==='string'&&UUID.test(value);
export const sessionPrefix=mode=>mode==='live'?'cs_live':'cs_test';
export const subjectPrefix=(object,mode)=>object==='checkout.session'?sessionPrefix(mode):object==='charge'?'ch':'dp';
export const audience=(mode,accountId)=>'fetchx-stripe-'+mode+'-'+accountId;
export const exact=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&
 Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
export const epoch=()=>Math.floor(Date.now()/1000);
export const fresh=(value,window,now=epoch())=>typeof value==='string'&&/^\d{1,12}$/.test(value)&&Math.abs(now-Number(value))<=window;
export const hex=bytes=>Array.from(bytes,n=>n.toString(16).padStart(2,'0')).join('');
export const utf8=value=>encode.encode(value);
export const sha256=async bytes=>hex(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)));
export const brokerMessage=(aud,time,digest)=>utf8(['fetchx-stripe-broker-v1',aud,'POST',BROKER_PATH,time,digest].join('\n'));
export const relayMessage=(aud,time,kid,digest)=>utf8(['fetchx-stripe-relay-v1',aud,'POST',RELAY_PATH,time,kid,digest].join('\n'));
export const customerForm=creationKey=>new URLSearchParams({'metadata[fetchx_customer]':creationKey}).toString();
export function checkoutForm({orderId,customerId,priceId,expiresAt,returnOrigin}){
 return new URLSearchParams({
  mode:'payment',client_reference_id:orderId,customer:customerId,'line_items[0][price]':priceId,'line_items[0][quantity]':'1',
  'payment_method_types[0]':'card','adaptive_pricing[enabled]':'false',allow_promotion_codes:'false','automatic_tax[enabled]':'false',
  expires_at:String(expiresAt),'payment_intent_data[metadata][fetchx_checkout]':orderId,
  success_url:returnOrigin+'/app/billing?checkout=success',cancel_url:returnOrigin+'/app/billing?checkout=cancelled',
 }).toString();
}
