import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {handleControl,CONTROL_REQUEST_LIMIT,CONTROL_RESPONSE_LIMIT,CONTROL_TIMEOUT_MS,type ControlEnv} from '../src/server/control';

const origin='https://fetchx.ai',secret='synthetic-control-secret-32-bytes-minimum',token='fxs_'+'s'.repeat(43),binding='fxg_'+'g'.repeat(43);
const project='cp_00000000-0000-4000-8000-000000000001';
const env:ControlEnv={SITE_ENV:'production',ALLOWED_ORIGINS:origin,FETCHX_CONTROL_URL:'https://gateway.example/control',FETCHX_CONTROL_SECRET:secret};
let calls:{url:string;init:RequestInit}[]=[];
let upstream:()=>Response|Promise<Response>;
const send=(path='/session',options:{method?:string;body?:string;headers?:Record<string,string>;env?:ControlEnv;origin?:string;country?:unknown}={})=>{
 const method=options.method??'GET';
 const request=new Request((options.origin??origin)+'/api/control'+path,{method,headers:{Origin:options.origin??origin,'Content-Type':'application/json',Cookie:`unrelated=private; fetchx_session=${token}`,'X-CSRF-Token':'c'.repeat(43),...options.headers},...(options.body===undefined?{}:{body:options.body})});
 if(options.country!==undefined)Object.defineProperty(request,'cf',{value:{country:options.country}});
 return handleControl(request,options.env??env);
};
beforeEach(()=>{
 calls=[];upstream=()=>Response.json({user:{id:'synthetic'}});
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{calls.push({url:String(input),init:init??{}});return upstream();}));
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});

describe('same-origin control bridge',()=>{
 it('forwards only private bridge credentials, session, CSRF and authenticated client origin',async()=>{
  const result=await send('/session',{headers:{Authorization:'Bearer customer-secret','X-FetchX-Control-Secret':'caller-secret','X-Forwarded-Host':'attacker.example','CF-Connecting-IP':'192.0.2.10','X-FetchX-Client-IP':'attacker'}});
  expect(result.status).toBe(200);expect(calls).toHaveLength(1);expect(calls[0].url).toBe('https://gateway.example/control/session');
  const headers=new Headers(calls[0].init.headers);expect(headers.get('X-FetchX-Control-Secret')).toBe(secret);expect(headers.get('Origin')).toBe(origin);expect(headers.get('Cookie')).toBe(`fetchx_session=${token}`);expect(headers.get('X-CSRF-Token')).toBe('c'.repeat(43));expect(headers.get('X-FetchX-Client-IP')).toBe('192.0.2.10');
  expect(headers.get('Authorization')).toBeNull();expect(headers.get('X-Forwarded-Host')).toBeNull();expect(calls[0].init.redirect).toBe('manual');
  expect(result.headers.get('Cache-Control')).toBe('no-store');expect(JSON.stringify(await result.json())).not.toContain(secret);
 });
 it('forwards only trusted Cloudflare country and replaces browser market spoofing',async()=>{
  for(const country of ['IN','US',undefined,'XX','in','IND']){
   const result=await send(`/projects/${project}/billing`,{country,headers:{'X-FetchX-Client-Country':'IN','CF-IPCountry':'IN','Accept-Language':'en-IN'}});
   expect(result.status).toBe(200);
   const forwarded=new Headers(calls.at(-1)!.init.headers);
   expect(forwarded.get('X-FetchX-Client-Country')).toBe(country==='IN'||country==='US'?country:null);
   expect(forwarded.get('CF-IPCountry')).toBeNull();expect(forwarded.get('Accept-Language')).toBeNull();
  }
 });
 it('allows GET without an Origin and rejects a cross-site or mismatched Origin',async()=>{
  expect((await send('/session',{headers:{Origin:''}})).status).toBe(200);
  const rejected:Record<string,string>[]=[{Origin:'https://attacker.example'},{'Sec-Fetch-Site':'cross-site'},{Origin:'null'}];
  for(const headers of rejected)expect((await send('/session',{headers})).status).toBe(403);
  expect((await send('/projects',{method:'POST',body:'{}',headers:{Origin:''}})).status).toBe(403);
  expect(calls).toHaveLength(1);
 });
 it('allows only a credentialless CLI POST to start or claim a Connect request',async()=>{
  const start='/connect/start',claim='/connect/claim',requestId='00000000-0000-4000-8000-000000000002';
  const sendCli=(path:string,body:object,headers:Record<string,string>={},url=origin,method='POST')=>handleControl(new Request(url+'/api/control'+path,{
   method,headers:{'Content-Type':'application/json',...headers},...(method==='POST'?{body:JSON.stringify(body)}:{})
  }),env);
  upstream=()=>Response.json({state:'pending'},{headers:{'Set-Cookie':`fetchx_session=${token}`}});
  const startResult=await sendCli(start,{client_name:'Synthetic agent'},{Authorization:'Bearer caller-token','X-FetchX-Control-Secret':'caller-secret'});
  const claimResult=await sendCli(claim,{request_id:requestId,device_code:'synthetic-device-code'});
  expect([startResult.status,claimResult.status]).toEqual([200,200]);
  for(const result of [startResult,claimResult]){
   expect(result.headers.get('Cache-Control')).toBe('no-store');expect(result.headers.get('Set-Cookie')).toBeNull();
  }
  expect(calls.map(({url})=>url)).toEqual([`https://gateway.example/control${start}`,`https://gateway.example/control${claim}`]);
  for(const {init} of calls){
   const headers=new Headers(init.headers);
   expect(headers.get('Origin')).toBe(origin);expect(headers.get('X-FetchX-Control-Secret')).toBe(secret);
   for(const name of ['Authorization','Cookie','Sec-Fetch-Site','X-CSRF-Token'])expect(headers.get(name)).toBeNull();
   expect(init.redirect).toBe('manual');
  }
  const rejected:Record<string,string>[]=[{Origin:origin},{Origin:''},{'Sec-Fetch-Site':'same-origin'},{'Sec-Fetch-Site':''},{Cookie:'unrelated=1'},{Cookie:''},{'X-CSRF-Token':'c'.repeat(43)},{'X-CSRF-Token':''}];
  for(const path of [start,claim]){
   for(const headers of rejected){
    expect((await sendCli(path,{},headers)).status).toBe(403);
   }
   expect((await sendCli(path,{}, {},'https://other.example')).status).toBe(403);
   expect((await sendCli(path+'?code=private',{})).status).toBe(400);
   expect((await sendCli(path,{}, {},origin,'GET')).status).toBe(405);
  }
  expect((await sendCli('/projects',{})).status).toBe(403);
  expect((await sendCli('/connect/unknown',{})).status).toBe(404);
  expect(calls).toHaveLength(2);
  upstream=()=>new Response(null,{status:307,headers:{Location:'https://other.example'}});
  expect((await sendCli(claim,{request_id:requestId,device_code:'synthetic-device-code'})).status).toBe(502);
  expect(calls).toHaveLength(3);
 });
 it('requires browser session, same origin and CSRF for Connect review and decision, and strips private response fields',async()=>{
  const requestId='00000000-0000-4000-8000-000000000002';
  const review={state:'pending',client_name:'Synthetic agent',scopes:['fetch:read'],expires_at:'2030-01-01T00:00:00Z',
   limits:{credits_per_day:100,credits_per_month:null,expires_at:'2030-02-01T00:00:00.000Z'}};
  for(const path of ['/connect/review','/connect/decision']){
   const body=JSON.stringify(path.endsWith('/review')?{request_id:requestId}:{request_id:requestId,user_code:'TEST-CODE',decision:'approve',project_id:project});
   expect((await send(path,{method:'POST',body,headers:{Origin:''}})).status).toBe(403);
   expect((await send(path,{method:'POST',body,headers:{Origin:'https://other.example'}})).status).toBe(403);
   expect((await send(path,{method:'POST',body,headers:{'Sec-Fetch-Site':'cross-site'}})).status).toBe(403);
   expect((await send(path,{method:'POST',body,headers:{Cookie:'unrelated=private'}})).status).toBe(401);
   for(const csrf of ['', 'malformed'])expect((await send(path,{method:'POST',body,headers:{'X-CSRF-Token':csrf}})).status).toBe(403);
   const safe=path.endsWith('/review')?review:{state:'approved'};
   upstream=()=>Response.json({...safe,device_code:'synthetic-device-code',api_key:'synthetic-key',user_code:'TEST-CODE'},{headers:{'Set-Cookie':`fetchx_session=${token}`}});
   const result=await send(path,{method:'POST',body,headers:{'Sec-Fetch-Site':'same-origin',Authorization:'Bearer caller-secret'}});
   expect(result.status).toBe(200);expect(await result.json()).toEqual(safe);expect(result.headers.get('Set-Cookie')).toBeNull();
   const call=calls.at(-1)!;const headers=new Headers(call.init.headers);
   expect(call.init.body).toBe(body);expect(headers.get('Cookie')).toBe(`fetchx_session=${token}`);
   expect(headers.get('X-CSRF-Token')).toBe('c'.repeat(43));expect(headers.get('Authorization')).toBeNull();
  }
  expect(calls).toHaveLength(2);
  // A review from an older service has no limits (none); malformed limits are not passed on.
  const reviewBody=JSON.stringify({request_id:requestId});
  const {limits:_omitted,...older}=review;
  upstream=()=>Response.json(older);
  expect(await (await send('/connect/review',{method:'POST',body:reviewBody})).json()).toEqual({...older,limits:{credits_per_day:null,credits_per_month:null,expires_at:null}});
  for(const limits of [{credits_per_day:0,credits_per_month:null,expires_at:null},{credits_per_day:null,credits_per_month:'5',expires_at:null},{credits_per_day:null,credits_per_month:null,expires_at:'soon'},[]]){
   upstream=()=>Response.json({...older,limits});
   expect((await send('/connect/review',{method:'POST',body:reviewBody})).status).toBe(502);
  }
  const body=JSON.stringify({request_id:requestId,user_code:'TEST-CODE',decision:'deny'});
  for(const [upstreamCode,publicCode] of [['connect_code_invalid','connect_code_invalid'],['synthetic-secret','connect_unavailable']]){
   upstream=()=>Response.json({error:{code:upstreamCode,message:'private upstream detail'},device_code:'synthetic-device-code'},{status:400});
   const result=await send('/connect/decision',{method:'POST',body});
   expect(result.status).toBe(400);const failure=await result.json() as {error:{code:string}};
   expect(failure.error.code).toBe(publicCode);expect(JSON.stringify(failure)).not.toContain('private upstream detail');expect(JSON.stringify(failure)).not.toContain('synthetic-device-code');
  }
 });
 it('restricts paths, methods and bounded query parameters before contacting the gateway',async()=>{
  for(const path of ['/anything','/projects/a/keys','/status/extra','/projects/'+project+'/fetch/key%2Fextra','/status?upstream=https://attacker.example'])expect((await send(path)).status).toBeGreaterThanOrEqual(400);
  const method=await send('/status',{method:'POST',body:'{}'});expect(method.status).toBe(405);expect(method.headers.get('Allow')).toBe('GET');
  for(const query of ['limit=101','limit=2&limit=3','status=done','tag=a%20b','cursor=x&extra=1'])expect((await send(`/projects/${project}/fetch?${query}`)).status).toBe(400);
  expect((await send(`/projects/${project}/usage?period=year`)).status).toBe(400);expect(calls).toHaveLength(0);
  expect((await send(`/projects/${project}/fetch?limit=25&status=failed&tag=console&cursor=abc_-1`)).status).toBe(200);expect(calls[0].url).toContain('?limit=25&status=failed&tag=console&cursor=abc_-1');
  expect((await send(`/projects/${project}/usage?period=day`)).status).toBe(200);
 });
 it('forwards a key\'s limits with PUT only',async()=>{
  const path=`/projects/${project}/keys/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/limits`,body=JSON.stringify({credits_per_month:2000,expires_at:null});
  expect((await send(path,{method:'PUT',body})).status).toBe(200);
  expect(calls.map(({url,init})=>[url,init.method,init.body])).toEqual([[`https://gateway.example/control${path}`,'PUT',body]]);
  const wrong=await send(path,{method:'POST',body});expect(wrong.status).toBe(405);expect(wrong.headers.get('Allow')).toBe('PUT');
  expect((await send(`/projects/${project}/keys/not-a-uuid/limits`,{method:'PUT',body})).status).toBe(404);expect(calls).toHaveLength(1);
 });
 it('forwards only the console fetch routes: submit, list, read and delete one result',async()=>{
  const base=`/projects/${project}`,id='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',body=JSON.stringify({url:'https://source.example/path?x=1'});
  expect((await send(`${base}/fetch`,{method:'POST',body})).status).toBe(200);
  expect((await send(`${base}/fetch/${id}?include_body=false`)).status).toBe(200);
  expect((await send(`${base}/fetch/${id}`,{method:'DELETE'})).status).toBe(200);
  expect((await send(`${base}/webhook-secret/rotate`,{method:'POST',body:'{}'})).status).toBe(200);
  expect(calls.map(({url,init})=>[url,init.method,init.body])).toEqual([
   [`https://gateway.example/control${base}/fetch`,'POST',body],
   [`https://gateway.example/control${base}/fetch/${id}?include_body=false`,'GET',undefined],
   [`https://gateway.example/control${base}/fetch/${id}`,'DELETE','{}'],
   [`https://gateway.example/control${base}/webhook-secret/rotate`,'POST','{}'],
  ]);
  for(const path of [`${base}/render`,`${base}/playground/prepare`,`${base}/requests`,`${base}/fetch/not-a-uuid`,`${base}/fetch/${id}/content`])expect((await send(path)).status).toBe(404);
  expect((await send(`${base}/fetch/${id}`,{method:'POST',body})).status).toBe(405);
  expect((await send(`${base}/fetch/${id}?url=other`)).status).toBe(400);
  expect((await send(`${base}/fetch`,{method:'POST',body,headers:{'X-CSRF-Token':'invalid'}})).status).toBe(403);
  expect((await send(`${base}/fetch`,{method:'POST',body,headers:{Origin:'https://other.example'}})).status).toBe(403);
  upstream=()=>{throw new Error('lost submission');};
  expect((await send(`${base}/fetch`,{method:'POST',body})).status).toBe(502);
  expect(calls).toHaveLength(5);
 });
 it('forwards only the admin portal routes and methods, without query strings',async()=>{
  const rule=JSON.stringify({rule:{id:'evomi-x',provider:'evomi',match:{host:'a.example.com'},action:'exclude',reason:'r'}});
  for(const path of ['/admin','/admin/rules/Bad_ID','/admin/rules/a/b','/admin/operators','/admin/rules/x/audit/extra','/admin/rules/x%2Fy'])expect((await send(path)).status).toBe(404);
  expect((await send('/admin/rules',{method:'DELETE'})).status).toBe(405);
  expect((await send('/admin/rules/test')).status).toBe(405);
  expect((await send('/admin/rules/evomi-x')).status).toBe(405);
  expect((await send('/admin/rules/evomi-x/enable')).status).toBe(405);
  expect((await send('/admin/session',{method:'POST',body:'{}'})).status).toBe(405);
  expect((await send('/admin/rules?x=1')).status).toBe(400);
  expect((await send('/admin/rules',{method:'POST',body:rule,headers:{'X-CSRF-Token':'invalid'}})).status).toBe(403);
  expect(calls).toHaveLength(0);
  const ok:[string,string,string?][]=[['/admin/session','GET'],['/admin/rules','GET'],['/admin/rules','POST',rule],['/admin/rules/test','POST','{"provider":"oxylabs","host":"ohio.gov"}'],
   ['/admin/rules/evomi-x','PUT',rule],['/admin/rules/evomi-x','DELETE'],['/admin/rules/oxylabs-gov/disable','POST','{"reason":"r"}'],['/admin/rules/oxylabs-gov/enable','POST','{"reason":"r"}'],
   ['/admin/rules/oxylabs-gov/audit','GET'],['/admin/audit','GET']];
  for(const [path,method,body] of ok)expect((await send(path,{method,body})).status).toBe(200);
  expect(calls.map(({url,init})=>[url.replace('https://gateway.example/control',''),init.method])).toEqual(ok.map(([path,method])=>[path,method]));
 });
 it('forwards only the admin probe and site knowledge routes',async()=>{
  const probe='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  for(const path of [`/admin/probes/${probe}/extra`,'/admin/probes/not-a-uuid','/admin/profiles','/admin/profiles/src.city/routing','/admin/sites/Bad_Host','/admin/sites/a.com/extra'])expect((await send(path)).status).toBe(404);
  expect((await send('/admin/sites',{method:'DELETE'})).status).toBe(405);
  expect((await send(`/admin/probes/${probe}`,{method:'POST',body:'{}'})).status).toBe(405);
  expect(calls).toHaveLength(0);
  const ok:[string,string,string?][]=[['/admin/probes','GET'],['/admin/probes','POST','{"host":"a.example","countries":["US"]}'],[`/admin/probes/${probe}`,'GET'],[`/admin/probes/${probe}/apply`,'POST','{"rules":[]}'],
   ['/admin/sites','GET'],['/admin/sites/shop.example.com','GET'],['/admin/sites/shop.example.com','DELETE']];
  for(const [path,method,body] of ok)expect((await send(path,{method,body})).status).toBe(200);
  expect(calls.map(({url,init})=>[url.replace('https://gateway.example/control',''),init.method])).toEqual(ok.map(([path,method])=>[path,method]));
 });
 it('forwards only the admin budget routes',async()=>{
  for(const path of ['/admin/budgets/Bad_Key','/admin/budgets/captcha.maxDailyMicroUsd/extra','/admin/budgets/captcha.maxDailyMicroUsd/reset/x','/admin/budgets/a%2Fb'])expect((await send(path)).status).toBe(404);
  expect((await send('/admin/budgets',{method:'POST',body:'{}'})).status).toBe(405);
  expect((await send('/admin/budgets/captcha.maxDailyMicroUsd')).status).toBe(405);
  expect((await send('/admin/budgets/captcha.maxDailyMicroUsd',{method:'DELETE'})).status).toBe(405);
  expect((await send('/admin/budgets/captcha.maxDailyMicroUsd/reset')).status).toBe(405);
  expect((await send('/admin/budgets?x=1')).status).toBe(400);
  expect(calls).toHaveLength(0);
  const ok:[string,string,string?][]=[['/admin/budgets','GET'],['/admin/budgets/captcha.maxDailyMicroUsd','PUT','{"value":1,"version":0,"reason":"r"}'],
   ['/admin/budgets/captcha.maxDailyMicroUsd/reset','POST','{"version":1,"reason":"r"}'],['/admin/budgets/captcha.maxDailyMicroUsd/audit','GET']];
  for(const [path,method,body] of ok)expect((await send(path,{method,body})).status).toBe(200);
  expect(calls.map(({url,init})=>[url.replace('https://gateway.example/control',''),init.method])).toEqual(ok.map(([path,method])=>[path,method]));
 });
 it('forwards only the admin status notice routes',async()=>{
  for(const path of ['/admin/notices/0','/admin/notices/abc','/admin/notices/12/extra','/admin/notices/12/resolve/x','/admin/notices/1%2F2'])expect((await send(path)).status).toBe(404);
  expect((await send('/admin/notices',{method:'DELETE'})).status).toBe(405);
  expect((await send('/admin/notices/12')).status).toBe(405);
  expect((await send('/admin/notices/12',{method:'DELETE'})).status).toBe(405);
  expect((await send('/admin/notices/12/resolve')).status).toBe(405);
  expect((await send('/admin/notices?x=1')).status).toBe(400);
  expect(calls).toHaveLength(0);
  const ok:[string,string,string?][]=[['/admin/notices','GET'],['/admin/notices','POST','{"kind":"incident","title":"t"}'],
   ['/admin/notices/12','PUT','{"update":"u"}'],['/admin/notices/12/resolve','POST','{}']];
  for(const [path,method,body] of ok)expect((await send(path,{method,body})).status).toBe(200);
  expect(calls.map(({url,init})=>[url.replace('https://gateway.example/control',''),init.method])).toEqual(ok.map(([path,method])=>[path,method]));
 });
 it('forwards only the admin feedback routes',async()=>{
  const report='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  for(const path of ['/admin/feedback/12','/admin/feedback/not-a-uuid',`/admin/feedback/${report}/extra`,`/admin/feedback/${report}%2Fx`])expect((await send(path)).status).toBe(404);
  expect((await send('/admin/feedback',{method:'POST',body:'{}'})).status).toBe(405);
  expect((await send(`/admin/feedback/${report}`)).status).toBe(405);
  expect((await send(`/admin/feedback/${report}`,{method:'DELETE'})).status).toBe(405);
  expect((await send('/admin/feedback?status=received')).status).toBe(400);
  expect(calls).toHaveLength(0);
  const ok:[string,string,string?][]=[['/admin/feedback','GET'],[`/admin/feedback/${report}`,'PUT','{"status":"resolved","reply":"r"}']];
  for(const [path,method,body] of ok)expect((await send(path,{method,body})).status).toBe(200);
  expect(calls.map(({url,init})=>[url.replace('https://gateway.example/control',''),init.method])).toEqual(ok.map(([path,method])=>[path,method]));
 });
 it('allows only the project-scoped Stripe checkout methods',async()=>{
  const stripe=`/projects/${project}/billing/stripe`,key='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const checkout=JSON.stringify({plan_id:'developer',idempotency_key:key});
  for(const path of ['/billing/stripe/checkout','/webhooks/stripe',`${stripe}/refund`,`${stripe}/checkout/${key.toUpperCase()}`,`${stripe}/checkout/${key}/extra`,`${stripe}/checkout/${key}%2Fextra`])expect((await send(path)).status).toBe(404);
  expect((await send(`${stripe}/checkout`)).status).toBe(405);
  expect((await send(`${stripe}/portal`,{method:'POST',body:checkout})).status).toBe(404);
  expect((await send(`${stripe}/checkout/${key}`,{method:'POST',body:checkout})).status).toBe(405);
  expect((await send(`${stripe}/checkout/${key}?extra=1`)).status).toBe(400);
  expect((await send(`${stripe}/checkout`,{method:'POST',body:checkout,headers:{Origin:'https://other.example'}})).status).toBe(403);
  expect((await send(`${stripe}/checkout`,{method:'POST',body:checkout,headers:{'X-CSRF-Token':'invalid'}})).status).toBe(403);
  expect(calls).toHaveLength(0);
  expect((await send(`${stripe}/checkout`,{method:'POST',body:checkout})).status).toBe(200);
  expect((await send(`${stripe}/checkout/${key}`)).status).toBe(200);
  expect(calls.map(({url,init})=>[url,init.method,init.body])).toEqual([
   [`https://gateway.example/control${stripe}/checkout`,'POST',checkout],
   [`https://gateway.example/control${stripe}/checkout/${key}`,'GET',undefined],
  ]);
 });
 it('returns an explicit disabled state with no configured upstream',async()=>{
  const missing={...env,FETCHX_CONTROL_URL:undefined};
  const status=await send('/status',{env:missing});expect(status.status).toBe(503);expect(await status.json()).toMatchObject({enabled:false,mail_configured:false});expect((await send('/session',{env:missing})).status).toBe(503);expect(calls).toHaveLength(0);
 });
 it('rejects insecure or malformed operator upstream settings and production localhost',async()=>{
  for(const url of ['http://gateway.example','https://localhost','http://127.0.0.1:8789','https://user:secret@gateway.example','https://gateway.example/control?url=attacker','https://gateway.example/unexpected'])expect((await send('/status',{env:{...env,FETCHX_CONTROL_URL:url}})).status).toBe(503);
  expect((await send('/status',{env:{...env,FETCHX_CONTROL_SECRET:'short'}})).status).toBe(503);expect(calls).toHaveLength(0);
 });
 it('supports loopback only under explicit development settings',async()=>{
  const local='http://127.0.0.1:4328',development={...env,SITE_ENV:'development',ALLOWED_ORIGINS:local,FETCHX_CONTROL_URL:'http://127.0.0.1:8789',FETCHX_CONTROL_ALLOW_LOOPBACK:'true'};
  expect((await send('/status',{env:development,origin:local})).status).toBe(200);expect(calls[0].url).toBe('http://127.0.0.1:8789/control/status');
  expect((await send('/status',{env:{...development,SITE_ENV:'production'},origin:local})).status).toBe(503);
 });
 it('normalizes only the session cookie to HttpOnly, scoped, SameSite and Secure',async()=>{
  upstream=()=>{const result=Response.json({ok:true},{headers:{'Location':'https://attacker.example','X-Secret':'private'}});result.headers.append('Set-Cookie',`fetchx_session=${token}; Domain=gateway.example; Path=/; SameSite=None; Expires=Tue, 01 Jan 2030 00:00:00 GMT`);result.headers.append('Set-Cookie','other=private; Path=/');return result;};
  const result=await send('/session');expect(result.headers.getSetCookie()).toHaveLength(1);expect(result.headers.get('Set-Cookie')).toContain('Path=/api/control; HttpOnly; SameSite=Lax; Secure');expect(result.headers.get('Set-Cookie')).not.toContain('Domain=');expect(result.headers.get('X-Secret')).toBeNull();expect(result.headers.get('Location')).toBeNull();
  upstream=()=>Response.json({logged_out:true},{headers:{'Set-Cookie':'fetchx_session=; Path=/'}});
  expect((await send('/auth/logout',{method:'POST',body:'{}'})).headers.get('Set-Cookie')).toContain('Max-Age=0');
 });
 it('drops invalid and duplicate session cookies and rejects malformed CSRF',async()=>{
  await send('/session',{headers:{Cookie:`fetchx_session=${token}; fetchx_session=${token}`}});expect(new Headers(calls[0].init.headers).get('Cookie')).toBeNull();
  expect((await send('/session',{headers:{'X-CSRF-Token':'bad token'}})).status).toBe(403);expect(calls).toHaveLength(1);
 });
 it('allows only the two POST Google routes and forwards their single valid browser binding',async()=>{
  const cookie=`unrelated=private; fetchx_session=${token}; fetchx_google=${binding}`;
  await send('/auth/google/challenge',{method:'POST',body:'{}',headers:{Cookie:cookie}});
  expect(new Headers(calls[0].init.headers).get('Cookie')).toBe(`fetchx_session=${token}; fetchx_google=${binding}`);
  await send('/auth/google/verify',{method:'POST',body:JSON.stringify({challenge_id:'synthetic',credential:'synthetic-id-token'}),headers:{Cookie:cookie,Authorization:'Bearer private-caller-key'}});
  expect(calls[1].url).toBe('https://gateway.example/control/auth/google/verify');
  expect(new Headers(calls[1].init.headers).get('Cookie')).toBe(`fetchx_session=${token}; fetchx_google=${binding}`);
  expect(new Headers(calls[1].init.headers).get('Authorization')).toBeNull();
  await send('/session',{headers:{Cookie:cookie}});expect(new Headers(calls[2].init.headers).get('Cookie')).toBe(`fetchx_session=${token}`);
  expect((await send('/auth/google/verify')).status).toBe(405);
  expect((await send('/auth/google/token',{method:'POST',body:'{}'})).status).toBe(404);
  expect((await send('/auth/google/verify?credential=private',{method:'POST',body:'{}'})).status).toBe(400);
  expect((await send('/auth/google/verify',{method:'POST',body:'{}',headers:{Origin:'https://attacker.example'}})).status).toBe(403);
  expect(calls).toHaveLength(3);
 });
 it('isolates malformed or duplicate Google and session cookies independently',async()=>{
  await send('/auth/google/challenge',{method:'POST',body:'{}',headers:{Cookie:`fetchx_session=${token}; fetchx_google=${binding}; fetchx_google=bad`}});
  expect(new Headers(calls[0].init.headers).get('Cookie')).toBe(`fetchx_session=${token}`);
  await send('/auth/google/verify',{method:'POST',body:'{}',headers:{Cookie:`fetchx_session=${token}; fetchx_google=${binding}; fetchx_google=bad`}});
  expect(new Headers(calls[1].init.headers).get('Cookie')).toBe(`fetchx_session=${token}`);
  await send('/auth/google/verify',{method:'POST',body:'{}',headers:{Cookie:`fetchx_session=bad; fetchx_session=${token}; fetchx_google=${binding}`}});
  expect(new Headers(calls[2].init.headers).get('Cookie')).toBe(`fetchx_google=${binding}`);
  await send('/auth/google/verify',{method:'POST',body:'{}',headers:{Cookie:'fetchx_google=fxg_bad'}});
  expect(new Headers(calls[3].init.headers).get('Cookie')).toBeNull();
 });
 it('returns both safe Google/session cookies, caps Google expiry, and clears its binding after verification',async()=>{
  upstream=()=>{const result=Response.json({ok:true});result.headers.append('Set-Cookie',`fetchx_google=${binding}; Domain=attacker.example; Path=/; SameSite=None; Max-Age=999999; Expires=Tue, 01 Jan 2030 00:00:00 GMT`);result.headers.append('Set-Cookie',`fetchx_session=${token}; Path=/; SameSite=None; Expires=Tue, 01 Jan 2030 00:00:00 GMT`);result.headers.append('Set-Cookie','unrelated=private');return result;};
  const result=await send('/auth/google/challenge',{method:'POST',body:'{}'}),cookies=result.headers.getSetCookie();
  expect(cookies).toHaveLength(2);
  const google=cookies.find(cookie=>cookie.startsWith('fetchx_google='))!;
  expect(google).toContain('Path=/api/control; HttpOnly; SameSite=Lax; Secure');expect(google).not.toContain('Domain=');
  const maxAge=Number(/Max-Age=(\d+)/.exec(google)?.[1]);expect(maxAge).toBeGreaterThan(0);expect(maxAge).toBeLessThanOrEqual(300);
  expect(Date.parse(/Expires=([^;]+)/.exec(google)![1])).toBeLessThanOrEqual(Date.now()+300_000);
  upstream=()=>{const result=Response.json({ok:true});result.headers.append('Set-Cookie','fetchx_google=; Domain=attacker.example; Path=/');result.headers.append('Set-Cookie',`fetchx_session=${token}`);return result;};
  const verified=await send('/auth/google/verify',{method:'POST',body:'{}'});
  expect(verified.headers.getSetCookie()).toHaveLength(2);expect(verified.headers.getSetCookie().find(cookie=>cookie.startsWith('fetchx_google='))).toContain('Max-Age=0');
  expect((await send('/session')).headers.getSetCookie()).toHaveLength(1);
 });
 it('drops duplicate or malformed returned cookies without losing the other safe cookie',async()=>{
  upstream=()=>{const result=Response.json({ok:true});result.headers.append('Set-Cookie',`fetchx_google=${binding}`);result.headers.append('Set-Cookie',`fetchx_google=${binding}`);result.headers.append('Set-Cookie',`fetchx_session=${token}`);return result;};
  const duplicate=await send('/auth/google/challenge',{method:'POST',body:'{}'});expect(duplicate.headers.getSetCookie()).toHaveLength(1);expect(duplicate.headers.get('Set-Cookie')).toContain('fetchx_session=');
  upstream=()=>{const result=Response.json({ok:true});result.headers.append('Set-Cookie','fetchx_session=bad');result.headers.append('Set-Cookie',`fetchx_google=${binding}`);return result;};
  const malformed=await send('/auth/google/challenge',{method:'POST',body:'{}'});expect(malformed.headers.getSetCookie()).toHaveLength(1);expect(malformed.headers.get('Set-Cookie')).toContain('fetchx_google=');
 });
 it('validates JSON and request bounds without forwarding invalid content',async()=>{
  for(const body of ['{"invalid"','[]','null','"string"'])expect((await send('/projects',{method:'POST',body})).status).toBe(400);
  expect((await send('/projects',{method:'POST',body:'{}',headers:{'Content-Type':'text/plain'}})).status).toBe(415);
  expect((await send('/projects',{method:'POST',body:JSON.stringify({name:'x'.repeat(CONTROL_REQUEST_LIMIT)})})).status).toBe(413);expect(calls).toHaveLength(0);
  expect((await send('/auth/logout',{method:'POST'})).status).toBe(200);expect(calls[0].init.body).toBe('{}');
 });
 it('normalizes an empty DELETE stream without requiring a content type but rejects nonempty untyped content',async()=>{
  const key='00000000-0000-4000-8000-000000000002',url=origin+`/api/control/projects/${project}/keys/${key}`;
  const headers={Origin:origin,Cookie:`fetchx_session=${token}`,'X-CSRF-Token':'c'.repeat(43)};
  const empty=new Request(url,{method:'DELETE',headers,body:new ReadableStream({start(controller){controller.close();}})});
  expect(empty.body).not.toBeNull();
  expect((await handleControl(empty,env)).status).toBe(200);
  expect(calls).toHaveLength(1);expect(calls[0].init.body).toBe('{}');expect(new Headers(calls[0].init.headers).get('Content-Type')).toBe('application/json');
  const nonempty=new Request(url,{method:'DELETE',headers,body:new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{}'));controller.close();}})});
  expect((await handleControl(nonempty,env)).status).toBe(415);expect(calls).toHaveLength(1);
 });
 it('never follows redirects or retries an uncertain POST and hides upstream exceptions',async()=>{
  upstream=()=>new Response(null,{status:302,headers:{Location:'https://attacker.example','Content-Type':'application/json'}});
  expect((await send('/projects',{method:'POST',body:'{}'})).status).toBe(502);expect(calls).toHaveLength(1);
  upstream=()=>{throw new Error('private secret and source URL');};
  const failed=await send(`/projects/${project}/fetch`,{method:'POST',body:JSON.stringify({idempotency_key:'saved'})});expect(failed.status).toBe(502);expect(await failed.text()).not.toContain('private');expect(calls).toHaveLength(2);
 });
 it('bounds and validates upstream responses',async()=>{
  upstream=()=>new Response('private stacktrace',{headers:{'Content-Type':'text/html'}});expect((await send()).status).toBe(502);
  upstream=()=>new Response('{broken',{headers:{'Content-Type':'application/json'}});expect((await send()).status).toBe(502);
  upstream=()=>new Response('{}',{headers:{'Content-Type':'application/json','Content-Length':String(CONTROL_RESPONSE_LIMIT+1)}});expect((await send()).status).toBe(502);
  upstream=()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(CONTROL_RESPONSE_LIMIT+1));controller.close();}}),{headers:{'Content-Type':'application/json'}});expect((await send()).status).toBe(502);
 });
 it('passes a full 10 MB base64 fetch result within its scoped response budget',async()=>{
  const encodedLength=4*Math.ceil(10_000_000/3);
  upstream=()=>new Response(new ReadableStream({start(controller){
   const encoder=new TextEncoder(),chunk=encoder.encode('A'.repeat(1024*1024));
   controller.enqueue(encoder.encode('{"data":{"body_base64":"'));
   for(let remaining=encodedLength;remaining>0;remaining-=chunk.length)controller.enqueue(chunk.subarray(0,remaining));
   controller.enqueue(encoder.encode('"}}'));
   controller.close();
  }}),{headers:{'Content-Type':'application/json'}});
  const path=`/projects/${project}/fetch`;
  const result=await send(path,{method:'POST',body:'{}'});
  expect(result.status).toBe(200);
  expect(result.headers.get('Cache-Control')).toBe('no-store');
  expect((await result.json() as {data:{body_base64:string}}).data.body_base64.length).toBe(encodedLength);
  expect((await send(`${path}/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`)).status).toBe(200);
  expect((await send('/session')).status).toBe(502);
 });
 it('times out a slow response body without replaying a submission',async()=>{
  vi.useFakeTimers();upstream=()=>new Response(new ReadableStream({start(){}}),{headers:{'Content-Type':'application/json'}});
  const pending=send('/projects',{method:'POST',body:'{}'});await vi.advanceTimersByTimeAsync(CONTROL_TIMEOUT_MS+1);const result=await pending;
  expect(result.status).toBe(504);expect((await result.json() as {error:{code:string}}).error.code).toBe('control_timeout');expect(calls).toHaveLength(1);
 });
});
