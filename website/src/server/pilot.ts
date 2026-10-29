import {InputError, validateSubmission, enquiryData, PRIVACY_VERSION, type PilotData} from '../lib/pilot-schema';

export interface PilotEnv {
 DB: D1Database; SITE_ENV: string; ALLOWED_ORIGINS: string; TURNSTILE_HOSTNAMES: string;
 MAIL_FROM: string; SALES_EMAIL: string; TURNSTILE_SECRET: string; RESEND_API_KEY: string; HASH_SECRET: string;
}
type Background = { waitUntil(promise: Promise<unknown>): void };
export interface EnquiryRow {
 reference: string; request_id: string; payload_hash: string; payload_json: string; created_at: number; expires_at: number;
 notification_status: string; notification_attempts: number; notification_first_attempt_at: number | null;
 notification_last_attempt_at: number | null; notification_lease: string | null; notification_id: string | null;
 notification_payload_json: string | null;
}
const LIMIT = 16_384;
const DAY = 86_400_000;
const encoder = new TextEncoder();
const headers = {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Robots-Tag':'noindex, nofollow'};
function reply(status: number, body: Record<string, unknown>, extra: Record<string,string> = {}) { return new Response(JSON.stringify(body), {status, headers:{...headers,...extra}}); }
function log(event: string, reference?: string) { console.log(JSON.stringify({event, ...(reference ? {reference} : {})})); }
export async function digest(value: string, secret: string): Promise<string> {
 const key = await crypto.subtle.importKey('raw', encoder.encode(secret), {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
 const result = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
 return [...new Uint8Array(result)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
async function readInput(request: Request): Promise<unknown> {
 if (Number(request.headers.get('content-length') || 0) > LIMIT) throw new InputError('form','This request is too large.');
 if (!request.body) throw new InputError('form','Please complete the form.');
 const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let length=0;
 try {
  for (;;) {const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>LIMIT){await reader.cancel();throw new InputError('form','This request is too large.');}chunks.push(value);}
 } finally {reader.releaseLock();}
 const body=new Uint8Array(length);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.length;}
 try {return JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(body));}catch{throw new InputError('form','Please submit a valid enquiry.');}
}
async function verifyToken(token: string, request: Request, env: PilotEnv): Promise<boolean> {
 try {
  const body=new URLSearchParams({secret:env.TURNSTILE_SECRET,response:token});
  const ip=request.headers.get('CF-Connecting-IP');if(ip)body.set('remoteip',ip);
  const response=await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',{method:'POST',body,signal:AbortSignal.timeout(10_000)});
  if(!response.ok)return false;
  const result: {success?: boolean; hostname?: string; action?: string}=await response.json();
  const allowed=env.TURNSTILE_HOSTNAMES.split(',').map(h=>h.trim()).filter(Boolean);
  return result.success===true && result.action==='pilot' && typeof result.hostname==='string' && allowed.includes(result.hostname) && result.hostname===new URL(request.url).hostname;
 } catch {return false;}
}
export async function handlePilot(request: Request, env: PilotEnv, context: Background): Promise<Response> {
 if(request.method!=='POST')return reply(405,{error:'method_not_allowed',message:'Use the pilot enquiry form.'},{Allow:'POST'});
 const origin=request.headers.get('Origin');
 if(!origin || origin!==new URL(request.url).origin || !(env.ALLOWED_ORIGINS||'').split(',').map(o=>o.trim()).includes(origin))return reply(403,{error:'origin_rejected',message:'Please submit from the FetchX website.'});
 if(!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json'))return reply(415,{error:'invalid_content_type',message:'Please submit the website form.'});
 if(!env.DB || !env.TURNSTILE_SECRET || !env.HASH_SECRET || !env.TURNSTILE_HOSTNAMES)return reply(503,{error:'temporarily_unavailable',message:'The form is temporarily unavailable. Email sales@headrun.ai instead.'});
 let submission;
 try{submission=validateSubmission(await readInput(request));}catch(error){return reply(400,{error:'invalid_input',field:error instanceof InputError?error.field:'form',message:error instanceof InputError?error.message:'Please check your details.'});}
 if(submission.website_confirm)return reply(403,{error:'verification_failed',message:'Please complete verification and try again.'});
 if(!await verifyToken(submission.token,request,env))return reply(403,{error:'verification_failed',field:'verification',message:'Verification expired or could not be completed. Please verify again.'});
 const now=Date.now();const data=enquiryData(submission);
 try {
  const payload=JSON.stringify(data);const hash=await digest(payload,env.HASH_SECRET);
  const existing=await env.DB.prepare('SELECT * FROM enquiries WHERE request_id = ? AND expires_at > ?').bind(submission.requestId,now).first<EnquiryRow>();
  if(existing){
   if(existing.payload_hash!==hash)return reply(409,{error:'request_conflict',message:'Your request has changed. Please reload the form before sending it again.'});
   return reply(200,{ok:true,reference:existing.reference,duplicate:true});
  }
  const dedupe=await digest(`${Math.floor(now/DAY)}:${payload}`,env.HASH_SECRET);
  const duplicate=await env.DB.prepare('SELECT reference FROM enquiries WHERE dedupe_key = ? AND expires_at > ?').bind(dedupe,now).first<{reference:string}>();
  if(duplicate)return reply(200,{ok:true,reference:duplicate.reference,duplicate:true});
  const ip=request.headers.get('CF-Connecting-IP')||'local';
  const bucket=await digest(`rate:${Math.floor(now/3_600_000)}:${ip}`,env.HASH_SECRET);
  const quota=await env.DB.prepare('INSERT INTO rate_buckets(bucket_key,attempts,expires_at) VALUES(?,1,?) ON CONFLICT(bucket_key) DO UPDATE SET attempts=attempts+1 RETURNING attempts').bind(bucket,now+DAY).first<{attempts:number}>();
  if(!quota || quota.attempts>10)return reply(429,{error:'rate_limited',message:'Too many requests. Please try later or email sales@headrun.ai.'},{'Retry-After':'3600'});
  const reference='FX-'+crypto.randomUUID().toUpperCase();
  const inserted=await env.DB.prepare('INSERT INTO enquiries(reference,request_id,dedupe_key,payload_hash,payload_json,privacy_version,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING reference').bind(reference,submission.requestId,dedupe,hash,payload,PRIVACY_VERSION,now,now+90*DAY).first<{reference:string}>();
  if(!inserted){
   const winner=await env.DB.prepare('SELECT reference,payload_hash FROM enquiries WHERE (request_id = ? OR dedupe_key = ?) AND expires_at > ?').bind(submission.requestId,dedupe,now).first<{reference:string;payload_hash:string}>();
   if(!winner || winner.payload_hash!==hash)return reply(409,{error:'request_conflict',message:'Please reload the form before sending it again.'});
   return reply(200,{ok:true,reference:winner.reference,duplicate:true});
  }
  log('enquiry_stored',reference);
  context.waitUntil(notifyEnquiry(reference,env).catch(()=>log('notification_update_failed',reference)));
  return reply(201,{ok:true,reference});
 } catch {
  log('enquiry_storage_failed');
  return reply(503,{error:'storage_unavailable',message:'We could not confirm receipt. Your details are still here. Please retry or email sales@headrun.ai.'});
 }
}
export function notificationPayload(row: EnquiryRow, env: Pick<PilotEnv,'MAIL_FROM'|'SALES_EMAIL'>) {
 const data: PilotData=JSON.parse(row.payload_json);
 return {
  from:env.MAIL_FROM,to:[env.SALES_EMAIL],reply_to:data.email,subject:`FetchX pilot enquiry ${row.reference}`,
  text:[`FetchX enquiry ${row.reference}`,`Received: ${new Date(row.created_at).toISOString()}`,'',`Offer: ${data.offer}`,`Name: ${data.name}`,`Company: ${data.company}`,`Email: ${data.email}`,'','Target websites (submitted by the visitor; not fetched):',...data.websites.map(u=>'- '+u),'',`Required fields: ${data.fields}`,`Frequency: ${data.frequency}`,`Estimated volume: ${data.volume}`,`Format: ${data.format}`,`Notes: ${data.notes || 'None'}`,'','Stored privately before this notification was sent. A repeated notification with this reference is the same enquiry.','Remove this enquiry notification from the sales mailbox at the end of its 90-day retention period unless it becomes part of an active customer engagement.'].join('\n'),
  tags:[{name:'enquiry_reference',value:row.reference}],
 };
}
export async function notifyEnquiry(reference: string, env: PilotEnv): Promise<'sent'|'failed'|'uncertain'|'skipped'> {
 const now=Date.now();const lease=crypto.randomUUID();
 const row=await env.DB.prepare(`UPDATE enquiries SET notification_status='sending',notification_attempts=notification_attempts+1,notification_last_attempt_at=?,notification_lease=? WHERE reference=? AND expires_at>? AND notification_status!='sent' AND (notification_status!='sending' OR notification_last_attempt_at<?) AND (notification_first_attempt_at IS NULL OR notification_first_attempt_at>?) RETURNING *`).bind(now,lease,reference,now,now-120_000,now-23*3_600_000).first<EnquiryRow>();
 if(!row)return 'skipped';
 let status:'sent'|'failed'|'uncertain'='uncertain';let providerId:string|null=null;let errorCode:string|null=null;
 // Persist the exact message before sending so provider idempotency also survives a deployment or configuration change.
 const message = env.RESEND_API_KEY ? await env.DB.prepare('UPDATE enquiries SET notification_payload_json=COALESCE(notification_payload_json,?), notification_first_attempt_at=COALESCE(notification_first_attempt_at,?) WHERE reference=? AND notification_lease=? RETURNING notification_payload_json').bind(JSON.stringify(notificationPayload(row,env)),now,reference,lease).first<{notification_payload_json:string}>() : null;
 try {
  if(!env.RESEND_API_KEY){status='failed';errorCode='mail_not_configured';}
  else if(!message){return 'skipped';}
  else {
   const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+env.RESEND_API_KEY,'Content-Type':'application/json','Idempotency-Key':'fetchx-enquiry/'+reference},body:message.notification_payload_json,signal:AbortSignal.timeout(10_000)});
   if(response.ok){const result:{id?:string}=await response.json();if(result.id){status='sent';providerId=result.id;}else errorCode='invalid_mail_response';}
   else {status=response.status>=500?'uncertain':'failed';errorCode='mail_http_'+response.status;}
  }
 }catch{errorCode='mail_network_error';}
 await env.DB.prepare('UPDATE enquiries SET notification_status=?,notification_id=?,notification_error=?,notification_lease=NULL WHERE reference=? AND notification_lease=?').bind(status,providerId,errorCode,reference,lease).run();
 log('notification_'+status,reference);return status;
}
export async function purgeExpired(db: D1Database, now=Date.now()): Promise<{enquiries:number;rateBuckets:number}> {
 const results=await db.batch([db.prepare('DELETE FROM enquiries WHERE expires_at<=?').bind(now),db.prepare('DELETE FROM rate_buckets WHERE expires_at<=?').bind(now)]);
 return {enquiries:results[0].meta.changes,rateBuckets:results[1].meta.changes};
}
