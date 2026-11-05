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
 it('restricts paths, methods and bounded query parameters before contacting the gateway',async()=>{
  for(const path of ['/anything','/projects/a/keys','/status/extra','/projects/'+project+'/fetch/key%2Fextra','/status?upstream=https://attacker.example'])expect((await send(path)).status).toBeGreaterThanOrEqual(400);
  const method=await send('/status',{method:'POST',body:'{}'});expect(method.status).toBe(405);expect(method.headers.get('Allow')).toBe('GET');
  expect((await send(`/projects/${project}/requests?limit=51`)).status).toBe(400);expect((await send(`/projects/${project}/requests?limit=2&limit=3`)).status).toBe(400);expect(calls).toHaveLength(0);
  expect((await send(`/projects/${project}/requests?limit=50`)).status).toBe(200);expect(calls[0].url).toContain('?limit=50');
 });
 it('forwards only the bounded playground preparation, render submission and recovery routes',async()=>{
  const base=`/projects/${project}`,body=JSON.stringify({url:'https://source.example/path?x=1'});
  expect((await send(`${base}/playground/prepare`,{method:'POST',body})).status).toBe(200);
  expect((await send(`${base}/render`,{method:'POST',body})).status).toBe(200);
  expect((await send(`${base}/render/${encodeURIComponent('render-key:1')}`)).status).toBe(200);
  expect(calls.map(({url,init})=>[url,init.method,init.body])).toEqual([
   [`https://gateway.example/control${base}/playground/prepare`,'POST',body],
   [`https://gateway.example/control${base}/render`,'POST',body],
   [`https://gateway.example/control${base}/render/render-key%3A1`,'GET',undefined]
  ]);
  expect((await send(`${base}/playground/prepare`)).status).toBe(405);
  expect((await send(`${base}/render/saved`,{method:'POST',body})).status).toBe(405);
  expect((await send(`${base}/render/key%2Fextra`)).status).toBe(404);
  expect((await send(`${base}/render/saved?url=other`)).status).toBe(400);
  expect((await send(`${base}/render`,{method:'POST',body,headers:{'X-CSRF-Token':'invalid'}})).status).toBe(403);
  expect((await send(`${base}/playground/prepare`,{method:'POST',body,headers:{Origin:'https://other.example'}})).status).toBe(403);
  upstream=()=>{throw new Error('uncertain render submission');};
  expect((await send(`${base}/render`,{method:'POST',body})).status).toBe(502);
  expect(calls).toHaveLength(4);
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
 it('times out a slow response body without replaying a submission',async()=>{
  vi.useFakeTimers();upstream=()=>new Response(new ReadableStream({start(){}}),{headers:{'Content-Type':'application/json'}});
  const pending=send('/projects',{method:'POST',body:'{}'});await vi.advanceTimersByTimeAsync(CONTROL_TIMEOUT_MS+1);const result=await pending;
  expect(result.status).toBe(504);expect((await result.json() as {error:{code:string}}).error.code).toBe('control_timeout');expect(calls).toHaveLength(1);
 });
});
