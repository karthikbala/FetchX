import {afterEach,describe,expect,it,vi} from 'vitest';
import {handleControlMail,type ControlMailEnv} from '../src/server/control-mail';

const secret='synthetic-private-mail-secret-at-least-32-bytes';
const config:ControlMailEnv={FETCHX_CONTROL_MAIL_SECRET:secret,FETCHX_CONTROL_SECRET:'synthetic-separate-bridge-secret-at-least-32-bytes',MAIL_FROM:'FetchX <verify@example.com>',GOOGLE_CLIENT_ID:'synthetic-client',GOOGLE_CLIENT_SECRET:'synthetic-client-secret',GOOGLE_REFRESH_TOKEN:'synthetic-refresh-token'};
const payload=()=>({email:'user@example.com',code:'01234567',challenge_id:'12345678-1234-4321-8765-123456789abc',expires_at:new Date(Date.now()+600000).toISOString()});
const request=(data:unknown=payload(),headers:Record<string,string>={},method='POST')=>new Request('https://fetchx.example/api/control-mail',{method,headers:{'Content-Type':'application/json','X-FetchX-Control-Mail-Secret':secret,...headers},...(!['GET','HEAD'].includes(method)?{body:JSON.stringify(data)}:{})});
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
const successful=()=>vi.fn(async(input:RequestInfo|URL)=>String(input)==='https://oauth2.googleapis.com/token'?json({access_token:'synthetic-access-token'}):json({id:'synthetic-message-id'}));
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();vi.useRealTimers();});

describe('private control verification mail relay',()=>{
 it('authenticates a server request and sends one fixed MIME message through existing Gmail secrets',async()=>{
  const upstream=successful();vi.stubGlobal('fetch',upstream);
  const data=payload(),result=await handleControlMail(request(data),config);
  expect(result.status).toBe(200);expect(await result.json()).toEqual({ok:true});
  expect(result.headers.get('Cache-Control')).toBe('no-store');expect(result.headers.get('Access-Control-Allow-Origin')).toBeNull();
  expect(upstream).toHaveBeenCalledTimes(2);
  const calls=upstream.mock.calls as unknown as [string,RequestInit][];
  expect(calls[0][0]).toBe('https://oauth2.googleapis.com/token');expect(calls[0][1].redirect).toBe('error');
  expect((calls[0][1].body as URLSearchParams).get('refresh_token')).toBe(config.GOOGLE_REFRESH_TOKEN);
  expect(calls[1][0]).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');expect(calls[1][1].redirect).toBe('error');
  expect(calls[1][1].headers).toEqual({'Authorization':'Bearer synthetic-access-token','Content-Type':'application/json'});
  const raw=JSON.parse(calls[1][1].body as string).raw as string;
  const mime=atob(raw.replace(/-/g,'+').replace(/_/g,'/'));
  expect(mime).toMatch(/^From: FetchX <verify@example.com>\r\nTo: user@example.com\r\nSubject: Your FetchX verification code\r\n/);
  const text=atob(mime.split('\r\n\r\n')[1].replace(/\s/g,''));
  expect(text).toBe(`Your FetchX verification code is ${data.code}.\n\nThis code expires at ${data.expires_at} and can be used once.\nIf you did not request it, you can ignore this email.`);
  expect(mime).not.toContain(secret);expect(mime).not.toContain(config.GOOGLE_REFRESH_TOKEN);
 });

 it.each(['GET','HEAD','PUT','OPTIONS'])('rejects method %s without dispatch',async method=>{
  const upstream=successful();vi.stubGlobal('fetch',upstream);
  const result=await handleControlMail(request(undefined,{},method),config);
  expect(result.status).toBe(405);expect(result.headers.get('Allow')).toBe('POST');expect(upstream).not.toHaveBeenCalled();
 });

 it.each(['','wrong-secret','x'.repeat(32),'x'.repeat(257)])('rejects missing or incorrect private authentication (%s)',async supplied=>{
  const upstream=successful();vi.stubGlobal('fetch',upstream);
  const result=await handleControlMail(request(payload(),{'X-FetchX-Control-Mail-Secret':supplied}),config);
  expect(result.status).toBe(401);expect(upstream).not.toHaveBeenCalled();
 });

 it.each([
  {FETCHX_CONTROL_MAIL_SECRET:undefined},{FETCHX_CONTROL_MAIL_SECRET:'short'},
  {FETCHX_CONTROL_MAIL_SECRET:secret+'\n'},{FETCHX_CONTROL_MAIL_SECRET:config.FETCHX_CONTROL_SECRET},
  {MAIL_FROM:undefined},{MAIL_FROM:'FetchX <verify@example.com>\r\nBcc: victim@example.com'},
  {MAIL_FROM:'Other <verify@example.com>'},{GOOGLE_CLIENT_ID:undefined},
  {GOOGLE_CLIENT_SECRET:''},{GOOGLE_REFRESH_TOKEN:' '},
 ])('fails closed for unavailable or invalid private configuration',async invalid=>{
  const upstream=successful();vi.stubGlobal('fetch',upstream);
  const result=await handleControlMail(request(),{...config,...invalid});
  expect(result.status).toBe(503);expect(upstream).not.toHaveBeenCalled();
 });

 it.each([
  {Origin:'https://fetchx.example'},{Origin:'null'},{'Sec-Fetch-Site':'same-origin'},
 ])('rejects browser-originated requests without dispatch',async headers=>{
  const upstream=successful();vi.stubGlobal('fetch',upstream);
  const result=await handleControlMail(request(payload(),headers as unknown as Record<string,string>),config);
  expect(result.status).toBe(403);expect(upstream).not.toHaveBeenCalled();
 });

 it.each(['text/plain','application/jsonp','application/json; arbitrary=true'])('rejects invalid content type %s',async type=>{
  const upstream=successful();vi.stubGlobal('fetch',upstream);
  expect((await handleControlMail(request(payload(),{'Content-Type':type}),config)).status).toBe(415);expect(upstream).not.toHaveBeenCalled();
 });

 it.each([
  {email:'invalid'},{email:'user@example.com\r\nBcc: other@example.com'},
  {email:'user@example..com'},{email:'.user@example.com'},{email:'user..other@example.com'},{email:'user@-example.com'},
  {code:'1234567'},{code:12345678},{code:'123456789'},{code:'code body'},
  {challenge_id:'-'.repeat(36)},{challenge_id:'id\r\nHeader: injected'},
  {expires_at:'not a date'},{expires_at:new Date(0).toISOString()},
  {expires_at:'2999-01-01T00:00:00.000Z'},{expires_at:'2026-02-30T00:00:00.000Z'},
  {body:'free-form message'},{subject:'arbitrary subject'},{from:'other@example.com'},
 ])('rejects invalid or extra verification fields without dispatch',async invalid=>{
  const upstream=successful();vi.stubGlobal('fetch',upstream);
  expect((await handleControlMail(request({...payload(),...invalid}),config)).status).toBe(400);expect(upstream).not.toHaveBeenCalled();
 });

 it('bounds declared and streamed input and rejects malformed JSON before dispatch',async()=>{
  const upstream=successful();vi.stubGlobal('fetch',upstream);
  expect((await handleControlMail(request(payload(),{'Content-Length':'2049'}),config)).status).toBe(413);
  expect((await handleControlMail(request({...payload(),body:'x'.repeat(3000)}),config)).status).toBe(413);
  const invalid=new Request('https://fetchx.example/api/control-mail',{method:'POST',headers:{'Content-Type':'application/json','X-FetchX-Control-Mail-Secret':secret},body:'{'});
  expect((await handleControlMail(invalid,config)).status).toBe(400);
  for(const data of [null,[],{},'text'])expect((await handleControlMail(request(data),config)).status).toBe(400);
  expect(upstream).not.toHaveBeenCalled();
 });

 it.each(['token-http','token-network','token-invalid','token-large','token-type','token-redirect'])('fails without Gmail dispatch after %s',async mode=>{
  const upstream=vi.fn(async()=>{
   if(mode==='token-network')throw new Error('sensitive-provider-error');
   if(mode==='token-http')return json({error:'sensitive-provider-error'},401);
   if(mode==='token-redirect')return new Response(null,{status:302,headers:{Location:'https://other.example/'}});
   if(mode==='token-large')return json({access_token:'x'.repeat(17000)});
   if(mode==='token-type')return new Response('{}',{headers:{'Content-Type':'text/plain'}});
   return json({access_token:'token\r\nHeader: injection'});
  });vi.stubGlobal('fetch',upstream);
  const result=await handleControlMail(request(),config);
  expect(result.status).toBe(503);expect(await result.json()).toEqual({error:'mail_unavailable'});expect(upstream).toHaveBeenCalledTimes(1);
 });

 it('bounds a stalled request body without dispatch',async()=>{
  const upstream=successful();vi.stubGlobal('fetch',upstream);
  const controller=new AbortController();controller.abort();
  vi.spyOn(AbortSignal,'timeout').mockImplementation(()=>controller.signal);
  const incoming=new Request('https://fetchx.example/api/control-mail',{method:'POST',headers:{'Content-Type':'application/json','X-FetchX-Control-Mail-Secret':secret},body:new ReadableStream<Uint8Array>({start(stream){stream.enqueue(new TextEncoder().encode('{'));}})});
  expect((await handleControlMail(incoming,config)).status).toBe(400);expect(upstream).not.toHaveBeenCalled();
 });

 it.each(['network','http','invalid','large','redirect'])('holds an uncertain Gmail %s result without retry or leaking provider data',async mode=>{
  let calls=0;const upstream=vi.fn(async()=>{
   if(++calls===1)return json({access_token:'synthetic-access-token'});
   if(mode==='network')throw new Error('sensitive-provider-error');
   if(mode==='http')return json({error:'sensitive-provider-error'},502);
   if(mode==='redirect')return new Response(null,{status:302,headers:{Location:'https://other.example/'}});
   if(mode==='large')return json({id:'x'.repeat(17000)});
   return json({unexpected:'sensitive-provider-error'});
  });vi.stubGlobal('fetch',upstream);
  const result=await handleControlMail(request(),config);
  expect(result.status).toBe(502);expect(await result.json()).toEqual({error:'mail_unconfirmed'});expect(upstream).toHaveBeenCalledTimes(2);
 });

 it('reports a confirmed Gmail rejection without retry',async()=>{
  let calls=0;const upstream=vi.fn(async()=>++calls===1?json({access_token:'synthetic-access-token'}):json({error:'private-provider-detail'},403));vi.stubGlobal('fetch',upstream);
  const result=await handleControlMail(request(),config);
  expect(result.status).toBe(422);expect(await result.json()).toEqual({error:'mail_unconfirmed'});expect(upstream).toHaveBeenCalledTimes(2);
 });
});
