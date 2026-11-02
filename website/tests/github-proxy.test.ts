import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {handleControl,type ControlEnv} from '../src/server/control';

const origin='https://fetchx.ai',session='fxs_'+'s'.repeat(43),binding='fxh_'+'h'.repeat(43),state='t'.repeat(43),csrf='c'.repeat(43);
const callback='/api/control/auth/github/callback',code='synthetic_github_code';
const env:ControlEnv={SITE_ENV:'production',ALLOWED_ORIGINS:origin,FETCHX_CONTROL_URL:'https://gateway.example/control',FETCHX_CONTROL_SECRET:'synthetic-control-secret-over-32-bytes'};
let calls:{url:string;init:RequestInit}[]=[];
let upstream:(url:string)=>Response|Promise<Response>;
const complete=(mode='login',projects:unknown[]=[])=>Response.json({user:{id:'synthetic-user',email:'synthetic@example.test'},csrf_token:csrf,projects,mode,auth_methods:{github:true}},{headers:{'Set-Cookie':`fetchx_session=${session}; Domain=private.example; Path=/`}});
const send=(path:string,options:{method?:string;body?:unknown;headers?:Record<string,string>;env?:ControlEnv;origin?:string}={})=>handleControl(new Request((options.origin??origin)+path,{method:options.method??'GET',headers:{'Sec-Fetch-Site':'cross-site',Cookie:`fetchx_github=${binding}`,...options.headers},...(options.body===undefined?{}:{body:JSON.stringify(options.body)})}),options.env??env);
const cb=(query=`code=${code}&state=${state}`,options:Parameters<typeof send>[1]={})=>send(callback+'?'+query,options);
beforeEach(()=>{calls=[];upstream=()=>complete();vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{calls.push({url:String(input),init:init??{}});return upstream(String(input));}));});
afterEach(()=>{vi.unstubAllGlobals();});

describe('GitHub control bridge and isolated callback',()=>{
 it('allows only same-origin POST start/complete and restricts the binding to those routes',async()=>{
  const headers={Origin:origin,'Sec-Fetch-Site':'same-origin','Content-Type':'application/json',Cookie:`fetchx_session=${session}; fetchx_github=${binding}; fetchx_google=fxg_${'g'.repeat(43)}; unrelated=private`};
  for(const path of ['/auth/github/start','/auth/github/complete']){
   expect((await send('/api/control'+path,{method:'POST',body:{mode:'login'},headers})).status).toBe(200);
   expect(new Headers(calls.at(-1)!.init.headers).get('Cookie')).toBe(`fetchx_session=${session}; fetchx_github=${binding}`);
  }
  await send('/api/control/session',{headers});expect(new Headers(calls.at(-1)!.init.headers).get('Cookie')).toBe(`fetchx_session=${session}`);
  for(const path of ['/auth/github/start','/auth/github/complete']){
   expect((await send('/api/control'+path,{method:'POST',body:{},headers:{...headers,'Sec-Fetch-Site':'cross-site'}})).status).toBe(403);
   expect((await send('/api/control'+path,{headers})).status).toBe(405);
   expect((await send('/api/control'+path+'?code=private',{method:'POST',body:{},headers})).status).toBe(400);
  }
  expect((await send('/api/control/auth/github/token',{method:'POST',body:{},headers})).status).toBe(404);expect(calls).toHaveLength(3);
 });
 it('drops duplicate or malformed GitHub bindings independently of session and Google bindings',async()=>{
  const headers={Origin:origin,'Sec-Fetch-Site':'same-origin','Content-Type':'application/json'};
  for(const value of [`fetchx_session=${session}; fetchx_github=${binding}; fetchx_github=bad`,`fetchx_session=${session}; fetchx_github=fxh_bad`]){
   await send('/api/control/auth/github/start',{method:'POST',body:{mode:'login'},headers:{...headers,Cookie:value}});
   expect(new Headers(calls.at(-1)!.init.headers).get('Cookie')).toBe(`fetchx_session=${session}`);
  }
  await send('/api/control/auth/google/challenge',{method:'POST',body:{},headers:{...headers,Cookie:`fetchx_github=${binding}`}});
  expect(new Headers(calls.at(-1)!.init.headers).get('Cookie')).toBeNull();
 });
 it('normalizes and caps returned GitHub cookies without accepting unrelated cookies',async()=>{
  upstream=()=>{const result=complete();result.headers.append('Set-Cookie',`fetchx_github=${binding}; Domain=private.example; Max-Age=999999; Expires=Tue, 01 Jan 2030 00:00:00 GMT`);result.headers.append('Set-Cookie',`fetchx_google=fxg_${'g'.repeat(43)}`);return result;};
  const result=await send('/api/control/auth/github/start',{method:'POST',body:{mode:'login'},headers:{Origin:origin,'Sec-Fetch-Site':'same-origin','Content-Type':'application/json'}});
  const cookies=result.headers.getSetCookie();expect(cookies).toHaveLength(2);
  const returned=cookies.find(value=>value.startsWith('fetchx_github='))!;
  expect(returned).toContain('Path=/api/control; HttpOnly; SameSite=Lax; Secure');expect(returned).not.toContain('Domain=');expect(Number(/Max-Age=(\d+)/.exec(returned)![1])).toBeLessThanOrEqual(300);
  upstream=()=>{const response=complete();response.headers.append('Set-Cookie',`fetchx_github=${binding}`);response.headers.append('Set-Cookie',`fetchx_github=${binding}`);return response;};
  const duplicate=await send('/api/control/auth/github/start',{method:'POST',body:{mode:'login'},headers:{Origin:origin,'Sec-Fetch-Site':'same-origin','Content-Type':'application/json'}});expect(duplicate.headers.getSetCookie()).toHaveLength(1);
 });
 it('admits only the exact callback GET as a cross-site exception',async()=>{
  expect((await cb()).status).toBe(303);expect(calls).toHaveLength(1);
  expect((await send(callback,{method:'POST',body:{}})).status).toBe(405);
  for(const path of ['/api/control/session','/api/control/status',callback+'/',callback+'/extra'])expect((await send(path)).status).toBeGreaterThanOrEqual(400);
  expect(calls).toHaveLength(1);
  const untrusted=await cb(undefined,{origin:'https://attacker.example'});expect(untrusted.headers.get('Location')).toBe('/login?github=github_verification_invalid');expect(calls).toHaveLength(1);
 });
 it('forwards code/state only in private JSON with generated origin headers and sanitized cookies',async()=>{
  const result=await cb(undefined,{headers:{Origin:'https://github.com','Sec-Fetch-Site':'cross-site',Authorization:'Bearer private','X-CSRF-Token':'attacker','X-FetchX-Control-Secret':'attacker','CF-Connecting-IP':'192.0.2.11',Cookie:`fetchx_github=${binding}; unrelated=private`}});
  expect(calls).toHaveLength(1);expect(calls[0].url).toBe('https://gateway.example/control/auth/github/complete');expect(calls[0].init.method).toBe('POST');expect(JSON.parse(String(calls[0].init.body))).toEqual({code,state});
  const forwarded=new Headers(calls[0].init.headers);expect(forwarded.get('Origin')).toBe(origin);expect(forwarded.get('Cookie')).toBe(`fetchx_github=${binding}`);expect(forwarded.get('Authorization')).toBeNull();expect(forwarded.get('X-CSRF-Token')).toBeNull();expect(forwarded.get('X-FetchX-Control-Secret')).toBe(env.FETCHX_CONTROL_SECRET);expect(forwarded.get('X-FetchX-Client-IP')).toBe('192.0.2.11');
  expect(result.status).toBe(303);expect(result.headers.get('Location')).toBe('/signup');expect(await result.text()).toBe('');expect(result.headers.get('Cache-Control')).toBe('no-store');expect(result.headers.get('Referrer-Policy')).toBe('no-referrer');expect(result.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
  expect(result.headers.getSetCookie()).toHaveLength(2);expect(result.headers.getSetCookie()[0]).toContain(`fetchx_session=${session}; Path=/api/control; HttpOnly; SameSite=Lax; Secure`);expect(result.headers.getSetCookie()[1]).toContain('fetchx_github=; Path=/api/control; HttpOnly; SameSite=Lax; Secure; Max-Age=0');
  expect([...result.headers].join()).not.toContain(code);expect([...result.headers].join()).not.toContain(state);
 });
 it('retrieves only the current session CSRF before explicit linking and preserves its session',async()=>{
  upstream=url=>url.endsWith('/session')?Response.json({csrf_token:csrf}):complete('link');
  const result=await cb(undefined,{headers:{Cookie:`fetchx_session=${session}; fetchx_github=${binding}`,'X-CSRF-Token':'attacker'}});
  expect(calls.map(call=>call.url)).toEqual(['https://gateway.example/control/session','https://gateway.example/control/auth/github/complete']);
  expect(new Headers(calls[0].init.headers).get('Cookie')).toBe(`fetchx_session=${session}`);expect(new Headers(calls[0].init.headers).get('X-CSRF-Token')).toBeNull();
  expect(new Headers(calls[1].init.headers).get('Cookie')).toBe(`fetchx_session=${session}; fetchx_github=${binding}`);expect(new Headers(calls[1].init.headers).get('X-CSRF-Token')).toBe(csrf);
  expect(result.headers.get('Location')).toBe('/login?github=linked');
 });
 it('does not trust missing, malformed or rejected session CSRF',async()=>{
  for(const response of [Response.json({csrf_token:'bad'}),Response.json({error:{code:'unauthorized'}},{status:401})]){
   calls=[];upstream=url=>url.endsWith('/session')?response:Response.json({error:{code:'github_session_conflict'}},{status:409});
   const result=await cb(undefined,{headers:{Cookie:`fetchx_session=${session}; fetchx_github=${binding}`}});
   expect(new Headers(calls[1].init.headers).get('X-CSRF-Token')).toBeNull();expect(result.headers.get('Location')).toBe('/login?github=github_session_conflict');
  }
 });
 it('rejects duplicate, unknown, mixed, missing, oversized or invalid callback parameters without gateway work',async()=>{
  const valid=`code=${code}&state=${state}`;
  for(const query of ['',`code=${code}`,`state=${state}`,valid+'&state='+state,valid+'&code=other',valid+'&next=https://attacker.example',valid+'&error=access_denied',`code=${'x'.repeat(513)}&state=${state}`,`code=bad%0Acode&state=${state}`,`code=${code}&state=bad`,`error=unknown&state=${state}`,`error=access_denied&state=${state}&error_description=${'x'.repeat(1025)}`,valid+'&error_description=private']){
   const result=await cb(query);expect(result.status).toBe(303);expect(result.headers.get('Location')).toBe('/login?github=github_verification_invalid');expect(result.headers.getSetCookie()).toHaveLength(1);
  }
  expect(calls).toHaveLength(0);
 });
 it('consumes cancellation once and discards provider descriptions and URLs',async()=>{
  upstream=()=>Response.json({error:{code:'github_cancelled',message:'private provider description'}},{status:400});
  const result=await cb(`error=access_denied&state=${state}&error_description=private_provider&error_uri=https%3A%2F%2Fattacker.example`);
  expect(calls).toHaveLength(1);expect(JSON.parse(String(calls[0].init.body))).toEqual({error:'access_denied',state});expect(result.headers.get('Location')).toBe('/login?github=github_cancelled');expect(await result.text()).toBe('');
 });
 it('uses fixed redirects and exposes only known error codes, never provider tokens or messages',async()=>{
  for(const code of ['github_disabled','github_unavailable','github_verification_invalid','github_cancelled','github_account_link_required','github_identity_conflict','github_session_conflict','github_email_verification_required','https://attacker.example/?token=private']){
   upstream=()=>Response.json({error:{code,message:'private-token'},authorization_url:'https://attacker.example',access_token:'private'},{status:401});
   const result=await cb();expect(result.headers.get('Location')).toBe('/login?github='+(code.startsWith('github_')?code:'github_verification_invalid'));expect(await result.text()).toBe('');
  }
  upstream=()=>complete('login',[{id:'synthetic-project'}]);expect((await cb()).headers.get('Location')).toBe('/app');
  upstream=()=>Response.json({mode:'https://attacker.example',projects:[],user:{id:'x',email:'x'},csrf_token:csrf,auth_methods:{github:true}});expect((await cb()).headers.get('Location')).toBe('/login?github=github_unavailable');
 });
 it('does not retry or follow an uncertain OAuth exchange',async()=>{
  upstream=()=>{throw new Error('private-token');};const result=await cb();expect(calls).toHaveLength(1);expect(calls[0].init.redirect).toBe('manual');expect(result.headers.get('Location')).toBe('/login?github=github_unavailable');expect(await result.text()).toBe('');
 });
 it('preserves the current session on failed or malformed callbacks and requires a valid success session cookie',async()=>{
  upstream=()=>Response.json({error:{code:'github_verification_invalid'}},{status:401,headers:{'Set-Cookie':`fetchx_session=${session}`}});
  let result=await cb();expect(result.headers.getSetCookie()).toHaveLength(1);expect(result.headers.getSetCookie()[0]).toMatch(/^fetchx_github=;/);
  upstream=()=>Response.json({error:{code:'github_session_conflict'}},{status:409,headers:{'Set-Cookie':'fetchx_session=; Path=/'}});
  result=await cb();expect(result.headers.getSetCookie()).toHaveLength(1);expect(result.headers.getSetCookie()[0]).toMatch(/^fetchx_github=;/);
  for(const invalid of ['missing','clear','duplicate','malformed']){
   upstream=()=>{const output=complete();output.headers.delete('Set-Cookie');if(invalid!=='missing')output.headers.append('Set-Cookie',invalid==='clear'?'fetchx_session=':invalid==='malformed'?'fetchx_session=private':`fetchx_session=${session}`);if(invalid==='duplicate')output.headers.append('Set-Cookie',`fetchx_session=${session}`);return output;};
   result=await cb();expect(result.headers.get('Location')).toBe('/login?github=github_unavailable');expect(result.headers.getSetCookie()).toHaveLength(1);expect(result.headers.getSetCookie()[0]).toMatch(/^fetchx_github=;/);
  }
  upstream=()=>Response.json({mode:'login',projects:[],csrf_token:csrf},{headers:{'Set-Cookie':`fetchx_session=${session}`}});
  result=await cb();expect(result.headers.getSetCookie()).toHaveLength(1);expect(result.headers.get('Location')).toBe('/login?github=github_unavailable');
 });
 it('uses non-Secure callback cookies only under explicit loopback development configuration',async()=>{
  const local='http://127.0.0.1:4328',localEnv={...env,SITE_ENV:'development',ALLOWED_ORIGINS:local,FETCHX_CONTROL_ALLOW_LOOPBACK:'true',FETCHX_CONTROL_URL:'http://127.0.0.1:8789'};
  const result=await cb(undefined,{origin:local,env:localEnv});expect(result.headers.getSetCookie().every(value=>!value.includes('; Secure'))).toBe(true);expect(calls[0].url).toBe('http://127.0.0.1:8789/control/auth/github/complete');
 });
});
