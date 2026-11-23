import { requestCountry } from './pricing';
// Server-only: never import this module from a browser script.
export interface ControlEnv {
 FETCHX_CONTROL_URL?: string;
 FETCHX_CONTROL_SECRET?: string;
 FETCHX_CONTROL_ALLOW_LOOPBACK?: string;
 ALLOWED_ORIGINS?: string;
 SITE_ENV?: string;
}
const COOKIE='fetchx_session';
const GOOGLE_COOKIE='fetchx_google';
const GITHUB_COOKIE='fetchx_github';
const SESSION=/^fxs_[A-Za-z0-9_-]{43}$/;
const GOOGLE_BINDING=/^fxg_[A-Za-z0-9_-]{43}$/;
const GITHUB_BINDING=/^fxh_[A-Za-z0-9_-]{43}$/;
const GITHUB_CALLBACK='/api/control/auth/github/callback';
const GITHUB_ISSUER='https://github.com/login/oauth';
const GITHUB_ERRORS=new Set(['github_disabled','github_unavailable','github_verification_invalid','github_cancelled','github_account_link_required','github_identity_conflict','github_session_conflict','github_email_verification_required']);
const PROJECT='cp_[a-fA-F0-9-]{36}';
const UUID='[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}';
const CONNECT_CLI=new Set(['/connect/start','/connect/claim']);
const CONNECT_BROWSER=new Set(['/connect/review','/connect/decision']);
const CONNECT_STATES=new Set(['pending','approved','denied','connected','expired']);
const CONNECT_ERRORS:Record<string,string>={
 unauthorized:'Sign in to continue.',csrf_rejected:'This request could not be authorized.',request_invalid:'Check the submitted connection request.',
 connect_disabled:'FetchX Connect is currently unavailable.',connect_not_found:'This connection request was not found.',
 connect_code_invalid:'The code could not be verified.',connect_request_closed:'This connection request is closed.',
 project_not_found:'The selected project was not found.',project_disabled:'The selected project is disabled.',
 project_template_changed:'The selected project cannot currently accept new keys.',key_limit:'The selected project has reached its key limit.',
 project_limit:'This account has reached its project limit.',project_name_invalid:'Give the project a name of up to 80 characters.',
 key_limits_invalid:'Credit limits must be whole numbers from 1 to 100,000,000, or empty for no limit.',
 key_expiry_invalid:'The expiry must be in the future, at most 5 years away.',
};
// A Connect request's key limits, as the review shows them (absent from an older service: none).
function connectLimits(value:unknown):object|null {
 if(value===undefined||value===null)return {credits_per_day:null,credits_per_month:null,expires_at:null};
 if(typeof value!=='object'||Array.isArray(value))return null;
 const {credits_per_day:day,credits_per_month:month,expires_at:expires}=value as Record<string,unknown>;
 const amount=(v:unknown)=>v===null||Number.isSafeInteger(v)&&(v as number)>=1&&(v as number)<=100_000_000;
 if(!amount(day)||!amount(month)||!(expires===null||typeof expires==='string'&&expires.length<=40&&Number.isFinite(Date.parse(expires))))return null;
 return {credits_per_day:day,credits_per_month:month,expires_at:expires};
}
const STRIPE_KEY='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
export const CONTROL_REQUEST_LIMIT=96*1024;
// Account responses are small; a fetch result can inline a 10 MB body
// (13.4 MB of base64) plus its formats.
export const CONTROL_RESPONSE_LIMIT=2*1024*1024;
const CONTROL_FETCH_RESPONSE_LIMIT=28*1024*1024;
const ADMIN_BUDGET='[a-z][A-Za-z0-9.]{1,80}';
const ADMIN_NOTICE='[1-9][0-9]{0,17}';
const ADMIN_RULE='[a-z0-9][a-z0-9._-]{0,63}',ADMIN_HOST='[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?';
const fetchResultPath=new RegExp(`^/projects/${PROJECT}/fetch(?:/${UUID})?$`);
export const CONTROL_TIMEOUT_MS=85_000;
const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Pragma':'no-cache','X-Content-Type-Options':'nosniff','X-Robots-Tag':'noindex, nofollow'};
const response=(status:number,body:unknown,extra:Record<string,string>={})=>new Response(JSON.stringify(body),{status,headers:{...headers,...extra}});
const error=(status:number,code:string,message:string)=>response(status,{error:{code,message}});
const loopback=(url:URL)=>/^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i.test(url.hostname)||url.hostname.endsWith('.localhost');
function browserConnectPayload(path:string,status:number,payload:Record<string,unknown>):object|null {
 if(status>=400){
  const code=(payload.error as Record<string,unknown>|undefined)?.code;
  return typeof code==='string'&&Object.hasOwn(CONNECT_ERRORS,code)
   ?{error:{code,message:CONNECT_ERRORS[code]}}
   :{error:{code:'connect_unavailable',message:'The account service could not complete this connection request.'}};
 }
 const {state,client_name,scopes,expires_at}=payload;
 if(path==='/connect/decision')return state==='approved'||state==='denied'?{state}:null;
 const limits=connectLimits(payload.limits);
 return typeof state==='string'&&CONNECT_STATES.has(state)&&typeof client_name==='string'&&Array.isArray(scopes)&&scopes.every(scope=>typeof scope==='string')&&typeof expires_at==='string'&&limits
  ?{state,client_name,scopes,expires_at,limits}:null;
}
// The only query strings the console sends: request-history filters and paging,
// the usage period, and include_body on one result.
const QUERY_RULES:[RegExp,Record<string,RegExp>][]=[
 [new RegExp(`^/projects/${PROJECT}/fetch$`),{limit:/^(?:[1-9]|[1-9][0-9]|100)$/,status:/^(?:pending|succeeded|failed)$/,tag:/^[A-Za-z0-9_.:-]{1,64}$/,cursor:/^[A-Za-z0-9_-]{1,200}$/}],
 [new RegExp(`^/projects/${PROJECT}/fetch/${UUID}$`),{include_body:/^(?:true|false)$/}],
 [new RegExp(`^/projects/${PROJECT}/usage$`),{period:/^(?:day|month)$/}],
];
function queryAllowed(path:string,params:URLSearchParams):boolean {
 const entries=[...params];
 if(!entries.length)return true;
 const rules=QUERY_RULES.find(([pattern])=>pattern.test(path))?.[1];
 return !!rules&&new Set(entries.map(([name])=>name)).size===entries.length&&entries.every(([name,value])=>rules[name]?.test(value)===true);
}
function allowedMethods(path:string):string[]|null {
 if(['/status','/session'].includes(path))return ['GET'];
 if(CONNECT_CLI.has(path)||CONNECT_BROWSER.has(path))return ['POST'];
 if(['/auth/code','/auth/verify','/auth/logout','/auth/google/challenge','/auth/google/verify','/auth/github/start','/auth/github/complete'].includes(path))return ['POST'];
 if(path==='/projects')return ['GET','POST'];
 if(new RegExp(`^/projects/${PROJECT}$`).test(path))return ['GET'];
 if(new RegExp(`^/projects/${PROJECT}/keys$`).test(path))return ['GET','POST'];
 if(new RegExp(`^/projects/${PROJECT}/keys/${UUID}/rotate$`).test(path))return ['POST'];
 if(new RegExp(`^/projects/${PROJECT}/keys/${UUID}/limits$`).test(path))return ['PUT'];
 if(new RegExp(`^/projects/${PROJECT}/keys/${UUID}$`).test(path))return ['DELETE'];
 if(new RegExp(`^/projects/${PROJECT}/fetch$`).test(path))return ['GET','POST'];
 if(new RegExp(`^/projects/${PROJECT}/fetch/${UUID}$`).test(path))return ['GET','DELETE'];
 if(new RegExp(`^/projects/${PROJECT}/(?:usage|billing|webhook-secret)$`).test(path))return ['GET'];
 if(new RegExp(`^/projects/${PROJECT}/webhook-secret/rotate$`).test(path))return ['POST'];
 if(new RegExp(`^/projects/${PROJECT}/billing/stripe/checkout$`).test(path))return ['POST'];
 if(new RegExp(`^/projects/${PROJECT}/billing/stripe/checkout/${STRIPE_KEY}$`).test(path))return ['GET'];
 // Admin portal API (operator role enforced by the gateway; no query strings).
 if(path==='/admin/session'||path==='/admin/audit')return ['GET'];
 if(path==='/admin/rules')return ['GET','POST'];
 if(path==='/admin/rules/test')return ['POST'];
 if(new RegExp(`^/admin/rules/${ADMIN_RULE}$`).test(path))return ['PUT','DELETE'];
 if(new RegExp(`^/admin/rules/${ADMIN_RULE}/(?:enable|disable)$`).test(path))return ['POST'];
 if(new RegExp(`^/admin/rules/${ADMIN_RULE}/audit$`).test(path))return ['GET'];
 if(path==='/admin/probes')return ['GET','POST'];
 if(new RegExp(`^/admin/probes/${UUID}$`).test(path))return ['GET'];
 if(new RegExp(`^/admin/probes/${UUID}/apply$`).test(path))return ['POST'];
 if(path==='/admin/sites')return ['GET'];
 if(new RegExp(`^/admin/sites/${ADMIN_HOST}$`).test(path))return ['GET','DELETE'];
 if(path==='/admin/budgets')return ['GET'];
 if(new RegExp(`^/admin/budgets/${ADMIN_BUDGET}$`).test(path))return ['PUT'];
 if(new RegExp(`^/admin/budgets/${ADMIN_BUDGET}/(?:reset)$`).test(path))return ['POST'];
 if(new RegExp(`^/admin/budgets/${ADMIN_BUDGET}/audit$`).test(path))return ['GET'];
 if(path==='/admin/feedback')return ['GET'];
 if(new RegExp(`^/admin/feedback/${UUID}$`).test(path))return ['PUT'];
 if(path==='/admin/notices')return ['GET','POST'];
 if(new RegExp(`^/admin/notices/${ADMIN_NOTICE}$`).test(path))return ['PUT'];
 if(new RegExp(`^/admin/notices/${ADMIN_NOTICE}/resolve$`).test(path))return ['POST'];
 return null;
}
class ProxyFailure extends Error {constructor(readonly code:string){super(code);}}
async function boundedBody(body:ReadableStream<Uint8Array>|null,limit:number,signal:AbortSignal):Promise<Uint8Array<ArrayBuffer>> {
 if(!body)return new Uint8Array();
 const reader=body.getReader(),chunks:Uint8Array[]=[];let length=0;
 let abort:()=>void=()=>{};
 const aborted=new Promise<never>((_,reject)=>{abort=()=>{reject(new ProxyFailure('timeout'));void reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
 try {
  for(;;){const {value,done}=await Promise.race([reader.read(),aborted]);if(done)break;length+=value.byteLength;if(length>limit){void reader.cancel().catch(()=>{});throw new ProxyFailure('size');}chunks.push(value);}
 } finally {signal.removeEventListener('abort',abort);reader.releaseLock();}
 const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
}
function requestCookie(value:string|null,name:string,pattern:RegExp):string|null {
 const parts=(value??'').split(';').map(v=>v.trim()).filter(v=>v.startsWith(name+'='));
 return parts.length===1&&pattern.test(parts[0].slice(name.length+1))?parts[0]:null;
}
function responseCookie(value:string,secure:boolean,name:string):string|null {
 const parts=value.split(';').map(v=>v.trim()),pair=parts.shift()??'';
 if(!pair.startsWith(name+'='))return null;
 const token=pair.slice(name.length+1),binding=name===GOOGLE_COOKIE||name===GITHUB_COOKIE;
 if(token!==''&&!(name===GOOGLE_COOKIE?GOOGLE_BINDING:name===GITHUB_COOKIE?GITHUB_BINDING:SESSION).test(token))return null;
 const out=[pair,'Path=/api/control','HttpOnly','SameSite=Lax'];if(secure)out.push('Secure');
 if(!token)out.push('Max-Age=0','Expires=Thu, 01 Jan 1970 00:00:00 GMT');
 else {
  const expires=parts.find(v=>/^Expires=/i.test(v));
  let time:number|undefined;
  if(expires){time=Date.parse(expires.slice(8));if(!Number.isFinite(time))return null;}
  if(binding){time=Math.min(time??Date.now()+300_000,Date.now()+300_000);out.push('Max-Age='+Math.max(0,Math.min(300,Math.floor((time-Date.now())/1000))));}
  if(time!==undefined)out.push('Expires='+new Date(time).toUTCString());
 }
 return out.join('; ');
}

// This is the only cross-site navigation exception. OAuth parameters remain on
// the server and never enter a page, browser storage, logs or a redirect target.
async function githubCallback(request:Request,env:ControlEnv):Promise<Response> {
 const incoming=new URL(request.url);
 const secure=!(env.SITE_ENV==='development'&&env.FETCHX_CONTROL_ALLOW_LOOPBACK==='true'&&loopback(incoming));
 const redirect=(destination:string,completed?:Response)=>{
  const output=new Response(null,{status:303,headers:{...headers,Location:destination,'Referrer-Policy':'no-referrer'}});
  for(const cookie of completed?.headers.getSetCookie()??[])if(cookie.startsWith(COOKIE+'='))output.headers.append('Set-Cookie',cookie);
  output.headers.append('Set-Cookie',responseCookie(GITHUB_COOKIE+'=',secure,GITHUB_COOKIE)!);
  return output;
 };
 const failed=(code='github_verification_invalid')=>redirect('/login?github='+code);
 if(!(env.ALLOWED_ORIGINS??'').split(',').map(v=>v.trim()).includes(incoming.origin))return failed();
 if(request.method!=='GET')return response(405,{error:{code:'method_not_allowed',message:'This method is not supported.'}},{Allow:'GET','Referrer-Policy':'no-referrer'});
 if(incoming.search.length>4096)return failed();
 const parameters=[...incoming.searchParams],state=incoming.searchParams.get('state'),code=incoming.searchParams.get('code'),denied=incoming.searchParams.get('error');
 const keys=parameters.map(([key])=>key);
 // Validate GitHub's optional RFC 9207 issuer with exact string comparison.
 // Issuer and optional error_description/error_uri are never forwarded.
 if(parameters.length>5||new Set(keys).size!==keys.length||keys.some(key=>!['code','state','iss','error','error_description','error_uri'].includes(key))||incoming.searchParams.has('iss')&&incoming.searchParams.get('iss')!==GITHUB_ISSUER||parameters.some(([,value])=>value.length>1024)||!state||!/^[A-Za-z0-9_-]{43}$/.test(state))return failed();
 const cancelled=denied==='access_denied'&&code===null;
 if(!cancelled&&(denied!==null||!code||!/^[A-Za-z0-9_-]{1,512}$/.test(code)||keys.some(key=>key==='error_description'||key==='error_uri')))return failed();
 const forwarded=new Headers({'Origin':incoming.origin,'Sec-Fetch-Site':'same-origin','Accept':'application/json'});
 const cookie=request.headers.get('Cookie');if(cookie)forwarded.set('Cookie',cookie);
 const ip=request.headers.get('CF-Connecting-IP');if(ip)forwarded.set('CF-Connecting-IP',ip);
 if(requestCookie(cookie,COOKIE,SESSION)){
  const current=await handleControl(new Request(incoming.origin+'/api/control/session',{headers:forwarded}),env);
  if(current.ok){const session=await current.json() as {csrf_token?:unknown};if(typeof session.csrf_token==='string'&&/^[A-Za-z0-9_-]{43}$/.test(session.csrf_token))forwarded.set('X-CSRF-Token',session.csrf_token);}
 }
 forwarded.set('Content-Type','application/json');
 const completed=await handleControl(new Request(incoming.origin+'/api/control/auth/github/complete',{method:'POST',headers:forwarded,body:JSON.stringify(cancelled?{error:'access_denied',state}:{code,state})}),env);
 const payload=await completed.json() as {error?:{code?:unknown};user?:{id?:unknown;email?:unknown};csrf_token?:unknown;projects?:unknown;mode?:unknown;auth_methods?:{github?:unknown}};
 if(!completed.ok){const code=payload.error?.code;return failed(typeof code==='string'&&GITHUB_ERRORS.has(code)?code:completed.status>=500?'github_unavailable':'github_verification_invalid');}
 if(!payload.user||typeof payload.user.id!=='string'||typeof payload.user.email!=='string'||typeof payload.csrf_token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(payload.csrf_token)||!Array.isArray(payload.projects)||payload.auth_methods?.github!==true||payload.mode!=='login'&&payload.mode!=='link')return failed('github_unavailable');
 const sessions=completed.headers.getSetCookie().filter(value=>value.startsWith(COOKIE+'='));
 if(sessions.length!==1||!SESSION.test(sessions[0].split(';')[0].slice(COOKIE.length+1)))return failed('github_unavailable');
 return redirect(payload.mode==='link'?'/login?github=linked':payload.projects.length?'/app':'/signup',completed);
}

export async function handleControl(request:Request,env:ControlEnv):Promise<Response> {
 const incoming=new URL(request.url),path=incoming.pathname.slice('/api/control'.length);
 if(incoming.pathname===GITHUB_CALLBACK)return githubCallback(request,env);
 if(!incoming.pathname.startsWith('/api/control/'))return error(404,'not_found','This account endpoint does not exist.');
 const methods=allowedMethods(path);if(!methods)return error(404,'not_found','This account endpoint does not exist.');
 if(!methods.includes(request.method))return response(405,{error:{code:'method_not_allowed',message:'This method is not supported.'}},{Allow:methods.join(', ')});
 if(!queryAllowed(path,incoming.searchParams))return error(400,'request_invalid','Check the submitted request.');
 const origin=request.headers.get('Origin'),site=request.headers.get('Sec-Fetch-Site');
 const cliConnect=CONNECT_CLI.has(path),browserConnect=CONNECT_BROWSER.has(path);
 const rawCookie=request.headers.get('Cookie'),csrf=request.headers.get('X-CSRF-Token');
 // Only the device client may omit the POST origin. Browser requests never
 // start or claim a device grant, even from this origin or with blank headers.
 if(cliConnect?origin!==null||site!==null||rawCookie!==null||csrf!==null:
    origin&&origin!==incoming.origin||!['GET','HEAD'].includes(request.method)&&!origin||site&&!['same-origin','none'].includes(site))return error(403,'origin_rejected','Submit this request from the FetchX website.');
 if(!(env.ALLOWED_ORIGINS??'').split(',').map(v=>v.trim()).includes(incoming.origin))return error(403,'origin_rejected','Submit this request from the FetchX website.');
 const sessionCookie=cliConnect?null:requestCookie(rawCookie,COOKIE,SESSION);
 if(browserConnect){
  if(!sessionCookie)return error(401,'unauthorized','Sign in to continue.');
  if(!csrf||!/^[A-Za-z0-9_-]{43}$/.test(csrf))return error(403,'csrf_rejected','This request could not be authorized.');
 }
 const development=env.SITE_ENV==='development'&&env.FETCHX_CONTROL_ALLOW_LOOPBACK==='true'&&loopback(incoming);
 if(!env.FETCHX_CONTROL_URL||!env.FETCHX_CONTROL_SECRET){
  if(path==='/status')return response(503,{enabled:false,mail_configured:false,github:{enabled:false},api_base_url:null});
  return error(503,'control_disabled','Account access is currently unavailable.');
 }
 let upstream:URL;
 try {
  upstream=new URL(env.FETCHX_CONTROL_URL);
  if(upstream.username||upstream.password||upstream.search||upstream.hash||!['','/','/control','/control/'].includes(upstream.pathname)||new TextEncoder().encode(env.FETCHX_CONTROL_SECRET).length<32||/[\r\n]/.test(env.FETCHX_CONTROL_SECRET))throw new Error();
  if(loopback(upstream)?!development:upstream.protocol!=='https:')throw new Error();
  if(!['http:','https:'].includes(upstream.protocol))throw new Error();
  upstream.pathname='/control'+path;upstream.search=incoming.search;
 } catch {return error(503,'control_configuration_invalid','Account access is currently unavailable.');}
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),CONTROL_TIMEOUT_MS);
 let submitted=false;
 try {
  const forwarded=new Headers({'Accept':'application/json','Origin':incoming.origin,'X-FetchX-Control-Secret':env.FETCHX_CONTROL_SECRET});
  const cookies=[sessionCookie];
  if(path==='/auth/google/challenge'||path==='/auth/google/verify')cookies.push(requestCookie(rawCookie,GOOGLE_COOKIE,GOOGLE_BINDING));
  if(path==='/auth/github/start'||path==='/auth/github/complete')cookies.push(requestCookie(rawCookie,GITHUB_COOKIE,GITHUB_BINDING));
  const cookie=cookies.filter(Boolean).join('; ');if(cookie)forwarded.set('Cookie',cookie);
  if(csrf){if(!/^[A-Za-z0-9_-]{43}$/.test(csrf))return error(403,'csrf_rejected','This request could not be authorized.');forwarded.set('X-CSRF-Token',csrf);}
  const ip=request.headers.get('CF-Connecting-IP');if(ip&&/^[a-fA-F0-9:.]{3,64}$/.test(ip))forwarded.set('X-FetchX-Client-IP',ip);
  const country=requestCountry(request);if(country)forwarded.set('X-FetchX-Client-Country',country);
  let body:string|undefined;
  if(!['GET','HEAD'].includes(request.method)){
   if(Number(request.headers.get('Content-Length')??0)>CONTROL_REQUEST_LIMIT)return error(413,'request_too_large','This request is too large.');
   let bytes:Uint8Array;try{bytes=await boundedBody(request.body,CONTROL_REQUEST_LIMIT,controller.signal);}catch(e){if(e instanceof ProxyFailure&&e.code==='size')return error(413,'request_too_large','This request is too large.');throw e;}
   // Workers may expose a non-null empty stream for a bodyless DELETE.
   if(bytes.byteLength&&!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type')??''))return error(415,'request_invalid','Submit JSON from the FetchX website.');
   try{const parsed=JSON.parse(bytes.byteLength?new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes):'{}');if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error();body=JSON.stringify(parsed);}catch{return error(400,'request_invalid','Check the submitted JSON request.');}
   forwarded.set('Content-Type','application/json');
  }
  submitted=true;
  const result=await fetch(upstream.href,{method:request.method,headers:forwarded,body,redirect:'manual',signal:controller.signal});
  if(result.status>=300&&result.status<400){void result.body?.cancel().catch(()=>{});return error(502,'control_upstream_invalid','The account service response could not be confirmed. Check Requests before sending the same work again.');}
  const fetchResult=fetchResultPath.test(path),limit=fetchResult?CONTROL_FETCH_RESPONSE_LIMIT:CONTROL_RESPONSE_LIMIT;
  if(!/^application\/json(?:\s*;|$)/i.test(result.headers.get('Content-Type')??'')||Number(result.headers.get('Content-Length')??0)>limit){void result.body?.cancel().catch(()=>{});return error(502,'control_upstream_invalid','The account service response could not be confirmed. Check Requests before sending the same work again.');}
  const bytes=await boundedBody(result.body,limit,controller.signal);
  let payload:unknown;try{
   payload=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:fetchResult}).decode(bytes));if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new Error();
   if(browserConnect){payload=browserConnectPayload(path,result.status,payload as Record<string,unknown>);if(!payload)throw new Error();}
  }catch{return error(502,'control_upstream_invalid','The account service response could not be confirmed. Check Requests before sending the same work again.');}
  const output=fetchResult?new Response(bytes,{status:result.status,headers}):response(result.status,payload);
  const returnedCookies=cliConnect||browserConnect?[]:result.headers.getSetCookie();
  for(const name of [COOKIE,...(path.startsWith('/auth/google/')?[GOOGLE_COOKIE]:[]),...(path.startsWith('/auth/github/')?[GITHUB_COOKIE]:[])]){
   const values=returnedCookies.filter(value=>value.startsWith(name+'='));
   if(values.length!==1)continue;
   const cookie=responseCookie(values[0],!development,name);if(cookie)output.headers.append('Set-Cookie',cookie);
  }
  const retry=result.headers.get('Retry-After');if(retry&&/^\d{1,5}$/.test(retry))output.headers.set('Retry-After',retry);
  return output;
 } catch {
  return error(controller.signal.aborted?504:502,controller.signal.aborted?'control_timeout':'control_unavailable',submitted?'The account service response could not be confirmed. Check Requests before sending the same work again.':'The account service is currently unavailable.');
 } finally {clearTimeout(timer);}
}
