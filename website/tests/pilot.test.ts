import {beforeEach, afterEach, describe, expect, it, vi} from 'vitest';
import {env} from 'cloudflare:workers';
import {applyD1Migrations, reset, type D1Migration} from 'cloudflare:test';
import {handlePilot, notifyEnquiry, purgeExpired, type EnquiryRow, type PilotEnv} from '../src/server/pilot';
import {validateSubmission} from '../src/lib/pilot-schema';

const origin='https://fetchx.ai';
const db=env.DB;
const config: PilotEnv={DB:db,SITE_ENV:'production',ALLOWED_ORIGINS:origin,TURNSTILE_HOSTNAMES:'fetchx.ai',MAIL_FROM:'FetchX <karthik@headrun.com>',SALES_EMAIL:'karthik@headrun.ai',TURNSTILE_SECRET:'synthetic-turnstile-secret',GOOGLE_CLIENT_ID:'synthetic-client',GOOGLE_CLIENT_SECRET:'synthetic-secret',GOOGLE_REFRESH_TOKEN:'synthetic-refresh',HASH_SECRET:'synthetic-hmac-secret-at-least-32-characters'};
const valid=()=>({requestId:crypto.randomUUID(),token:crypto.randomUUID(),website_confirm:'',offer:'pilot',websites:['https://example.com/products'],fields:'title, price, availability',frequency:'One-time pilot',volume:'Up to 500 records',format:'CSV',name:'Test Operator',company:'Synthetic Company',email:'test@example.com',notes:'Synthetic test; no actual customer.'});
let mailCalls: RequestInit[]=[];
let verification: Record<string,unknown>;
let mailStatus=200;
let mailThrows=false;
let authStatus=200;
let authThrows=false;
let verifyThrows=false;
let usedTokens:Set<string>;
let verifyReplay=false;
let background:Promise<unknown>[]=[];
const row=(reference:string)=>db.prepare('SELECT * FROM enquiries WHERE reference=?').bind(reference).first<EnquiryRow>();
const count=async()=>Number((await db.prepare('SELECT COUNT(*) AS n FROM enquiries').first<{n:number}>())!.n);
async function send(payload:unknown=valid(), options:{method?:string;origin?:string;type?:string;raw?:string;env?:PilotEnv}={}) {
 const method=options.method||'POST';
 const request=new Request(origin+'/api/pilot',{method,headers:{Origin:options.origin??origin,'Content-Type':options.type??'application/json','CF-Connecting-IP':'192.0.2.10'},...(method==='GET'?{}:{body:options.raw??JSON.stringify(payload)})});
 const response=await handlePilot(request,options.env??config,{waitUntil(p){background.push(p);}});
 const body=await response.json() as {ok?:boolean;reference:string;error?:string;duplicate?:boolean};
 return {response,body};
}
async function settle(){await Promise.all(background);background=[];}
beforeEach(async()=>{
 await reset();
 await applyD1Migrations(db,(env as unknown as {TEST_MIGRATIONS:D1Migration[]}).TEST_MIGRATIONS);
 background=[];mailCalls=[];mailStatus=200;mailThrows=false;authStatus=200;authThrows=false;verifyThrows=false;verifyReplay=false;usedTokens=new Set();
 verification={success:true,hostname:'fetchx.ai',action:'pilot'};
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const url=String(input);
  if(url==='https://challenges.cloudflare.com/turnstile/v0/siteverify'){
   if(verifyThrows)throw new Error('Synthetic verifier outage');
   const token=new URLSearchParams(String(init?.body)).get('response')!;
   if(verifyReplay&&usedTokens.has(token))return Response.json({success:false,'error-codes':['timeout-or-duplicate']});
   usedTokens.add(token);return Response.json(verification);
  }
  if(url==='https://oauth2.googleapis.com/token'){if(authThrows)throw new Error('Synthetic auth outage');return Response.json(authStatus===200?{access_token:'synthetic-access-token'}:{error:'synthetic'},{status:authStatus});}
  if(url==='https://gmail.googleapis.com/gmail/v1/users/me/messages/send'){
   const raw=JSON.parse(String(init?.body)).raw as string;
   const decoded=atob(raw.replace(/-/g,'+').replace(/_/g,'/'));
   const reference=decoded.match(/Subject: FetchX pilot enquiry (FX-[A-F0-9-]+)/)?.[1];
   expect(reference).toBeDefined();
   // Mail cannot be sent unless the matching private record already exists.
   expect(await row(reference!)).not.toBeNull();
   mailCalls.push(init!);
   if(mailThrows)throw new Error('Synthetic mail timeout');
   return Response.json(mailStatus===200?{id:'mail-synthetic-1'}:{message:'Synthetic rejection'},{status:mailStatus});
  }
  throw new Error('Unexpected network request: '+url);
 }));
});
afterEach(async()=>{await settle();vi.restoreAllMocks();vi.unstubAllGlobals();});

describe('pilot intake with isolated D1',()=>{
 it('saves before notification and returns a private reference without exposing submitted data',async()=>{
  const {response,body}=await send();expect(response.status).toBe(201);expect(body.reference).toMatch(/^FX-[A-F0-9-]{36}$/);
  const stored=await row(body.reference);expect(stored).not.toBeNull();expect(stored!.expires_at-stored!.created_at).toBe(90*86_400_000);
  expect(JSON.stringify(body)).not.toContain('test@example.com');expect(stored!.payload_json).not.toContain('token');
  await settle();expect((await row(body.reference))!.notification_status).toBe('sent');expect(mailCalls).toHaveLength(1);
  const raw=JSON.parse(String(mailCalls[0].body)).raw as string;const mime=atob(raw.replace(/-/g,'+').replace(/_/g,'/'));
  expect(mime).toContain('From: FetchX <karthik@headrun.com>');expect(mime).toContain('To: karthik@headrun.ai');expect(mime).toContain('Reply-To: test@example.com');expect(mime).not.toContain('synthetic-refresh');
  expect(response.headers.get('Cache-Control')).toBe('no-store');
 });
 it.each([
  [{method:'GET'},405], [{origin:'https://untrusted.example'},403], [{origin:''},403], [{type:'text/plain'},415],
 ])('rejects invalid request envelope %j',async(options,status)=>{const {response}=await send(valid(),options);expect(response.status).toBe(status);expect(await count()).toBe(0);expect(mailCalls).toHaveLength(0);});
 it.each([
  {email:'bad'}, {websites:['file:///etc/passwd']}, {websites:['https://user:secret@example.com']}, {websites:['http://127.0.0.1/']},
  {websites:['https://example.com','https://example.com']}, {websites:Array(4).fill('https://example.com')}, {offer:'enterprise'}, {fields:'x'}, {name:'Test\nInjected'},
 ])('rejects invalid fields %j',async(patch)=>{expect((await send({...valid(),...patch})).response.status).toBe(400);expect(await count()).toBe(0);});
 it('bounds the request body and rejects malformed JSON',async()=>{
  expect((await send({}, {raw:'x'.repeat(17_000)})).response.status).toBe(400);
  expect((await send({}, {raw:'{"broken"'})).response.status).toBe(400);expect(await count()).toBe(0);
 });
 it('rejects the honeypot before any external verification',async()=>{expect((await send({...valid(),website_confirm:'bot'})).response.status).toBe(403);expect(fetch).not.toHaveBeenCalled();});
 it.each([{success:false},{hostname:'elsewhere.example'},{action:'login'}])('rejects invalid verifier result %j',async(patch)=>{
  verification={...verification,...patch};expect((await send()).response.status).toBe(403);expect(await count()).toBe(0);expect(mailCalls).toHaveLength(0);
 });
 it('fails closed during a verifier outage or missing deployment secret',async()=>{
  verifyThrows=true;expect((await send()).response.status).toBe(403);
  expect((await send(valid(),{env:{...config,TURNSTILE_SECRET:''}})).response.status).toBe(503);expect(await count()).toBe(0);
 });
 it('rejects a replayed token and accepts an idempotent retry with a new verified token',async()=>{
  verifyReplay=true;const payload=valid();const first=await send(payload);await settle();
  expect((await send(payload)).response.status).toBe(403);
  const retry=await send({...payload,token:crypto.randomUUID()});expect(retry.response.status).toBe(200);expect(retry.body.reference).toBe(first.body.reference);expect(retry.body.duplicate).toBe(true);
  expect(await count()).toBe(1);expect(mailCalls).toHaveLength(1);
 });
 it('deduplicates same-day identical data even with a new request ID',async()=>{
  const first=await send();await settle();const second=await send();expect(second.body.reference).toBe(first.body.reference);expect(await count()).toBe(1);expect(mailCalls).toHaveLength(1);
 });
 it('does not treat changed data under the same request ID as accepted',async()=>{
  const payload=valid();await send(payload);await settle();expect((await send({...payload,notes:'Changed'})).response.status).toBe(409);expect(await count()).toBe(1);
 });
 it('resolves concurrent duplicate inserts to one record and one notification',async()=>{
  const results=await Promise.all([send(),send()]);await settle();expect(new Set(results.map(r=>r.body.reference)).size).toBe(1);expect(await count()).toBe(1);expect(mailCalls).toHaveLength(1);
 });
 it('enforces the hourly allowance without storing the raw IP',async()=>{
  for(let n=0;n<10;n++){expect((await send({...valid(),notes:'Request '+n})).response.status).toBe(201);await settle();}
  expect((await send({...valid(),notes:'Request 11'})).response.status).toBe(429);expect(await count()).toBe(10);
  const buckets=await db.prepare('SELECT * FROM rate_buckets').all();expect(JSON.stringify(buckets)).not.toContain('192.0.2.10');
 });
 it('does not confirm or send mail when the database is unavailable',async()=>{
  const broken={prepare(){throw new Error('Synthetic database outage');}} as unknown as D1Database;
  const result=await send(valid(),{env:{...config,DB:broken}});expect(result.response.status).toBe(503);expect(result.body.ok).toBeUndefined();expect(mailCalls).toHaveLength(0);
 });
 it.each([[422,'failed'],[503,'uncertain']])('preserves successful intake when mail returns %i',async(status,expected)=>{
  mailStatus=Number(status);const result=await send();expect(result.response.status).toBe(201);await settle();expect((await row(result.body.reference))!.notification_status).toBe(expected);expect(await count()).toBe(1);
 });
 it('retains an uncertain outcome when mail times out',async()=>{
  mailThrows=true;const result=await send();await settle();expect(result.response.status).toBe(201);expect((await row(result.body.reference))!.notification_status).toBe('uncertain');
 });
 it.each(['http','network'])('preserves the enquiry when Gmail authorization fails: %s',async(mode)=>{
  if(mode==='http')authStatus=401;else authThrows=true;
  const result=await send();await settle();expect(result.response.status).toBe(201);expect((await row(result.body.reference))!.notification_status).toBe('failed');expect(mailCalls).toHaveLength(0);
 });
 it('never automatically retries an uncertain Gmail send',async()=>{
  mailThrows=true;const result=await send();await settle();mailThrows=false;
  expect(await notifyEnquiry(result.body.reference,config)).toBe('skipped');expect(mailCalls).toHaveLength(1);
 });
 it('retries a confirmed rejection with the identical stored message',async()=>{
  mailStatus=422;const result=await send();await settle();mailStatus=200;
  expect(await notifyEnquiry(result.body.reference,{...config,MAIL_FROM:'Changed <changed@example.com>'})).toBe('sent');
  expect(mailCalls).toHaveLength(2);expect(mailCalls[1].body).toBe(mailCalls[0].body);
  expect(await notifyEnquiry(result.body.reference,config)).toBe('skipped');expect(mailCalls).toHaveLength(2);
 });
 it('retains the enquiry while Gmail credentials are missing',async()=>{
  const result=await send(valid(),{env:{...config,GOOGLE_REFRESH_TOKEN:''}});await settle();const stored=await row(result.body.reference);
  expect(stored!.notification_status).toBe('failed');expect(stored!.notification_first_attempt_at).toBeNull();expect(mailCalls).toHaveLength(0);
  expect(await notifyEnquiry(result.body.reference,config)).toBe('sent');
 });
 it('allows only one sender and holds interrupted sends for reconciliation',async()=>{
  mailStatus=422;const result=await send();await settle();mailStatus=200;
  const results=await Promise.all([notifyEnquiry(result.body.reference,config),notifyEnquiry(result.body.reference,config)]);
  expect(results.sort()).toEqual(['sent','skipped']);expect(mailCalls).toHaveLength(2);
  await db.prepare("UPDATE enquiries SET notification_status='sending' WHERE reference=?").bind(result.body.reference).run();
  expect(await notifyEnquiry(result.body.reference,config)).toBe('skipped');expect(mailCalls).toHaveLength(2);
 });
 it('purges expired enquiries and rate buckets while retaining current requests',async()=>{
  const old=await send();await settle();await db.prepare('UPDATE enquiries SET expires_at=? WHERE reference=?').bind(Date.now()-1,old.body.reference).run();
  await db.prepare('UPDATE rate_buckets SET expires_at=?').bind(Date.now()-1).run();
  const current=await send({...valid(),notes:'Current'});await settle();
  // The current submission reuses the hour bucket, so expire that fixture explicitly.
  await db.prepare('UPDATE rate_buckets SET expires_at=?').bind(Date.now()-1).run();
  expect(await purgeExpired(db)).toEqual({enquiries:1,rateBuckets:1});expect(await row(old.body.reference)).toBeNull();expect(await row(current.body.reference)).not.toBeNull();
 });
 it('normalizes public URLs and email without collecting extra fields',()=>{
  const value=validateSubmission({...valid(),email:' TEST@EXAMPLE.COM ',websites:['https://example.com/path#section'],gatewayKey:'never-store'});
  expect(validateSubmission({...valid(),websites:['abc.com','example.com/path']}).websites).toEqual(['https://abc.com/','https://example.com/path']);
  expect(() => validateSubmission({...valid(),websites:['abc.com','https://abc.com/']})).toThrow();
  expect(value.email).toBe('test@example.com');expect(value.websites).toEqual(['https://example.com/path']);expect(value).not.toHaveProperty('gatewayKey');
 });
});
