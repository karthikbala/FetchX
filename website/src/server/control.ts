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
export const CONTROL_REQUEST_LIMIT=96*1024;
export const CONTROL_RESPONSE_LIMIT=24*1024*1024;
export const CONTROL_TIMEOUT_MS=85_000;
const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Pragma':'no-cache','X-Content-Type-Options':'nosniff','X-Robots-Tag':'noindex, nofollow'};
const response=(status:number,body:unknown,extra:Record<string,string>={})=>new Response(JSON.stringify(body),{status,headers:{...headers,...extra}});
const error=(status:number,code:string,message:string)=>response(status,{error:{code,message}});
const loopback=(url:URL)=>/^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i.test(url.hostname)||url.hostname.endsWith('.localhost');
function allowedMethods(path:string):string[]|null {
 if(['/status','/session'].includes(path))return ['GET'];
 if(['/auth/code','/auth/verify','/auth/logout','/auth/google/challenge','/auth/google/verify','/auth/github/start','/auth/github/complete'].includes(path))return ['POST'];
 if(path==='/projects')return ['GET','POST'];
 if(new RegExp(`^/projects/${PROJECT}$`).test(path))return ['GET'];
 if(new RegExp(`^/projects/${PROJECT}/keys$`).test(path))return ['GET','POST'];
 if(new RegExp(`^/projects/${PROJECT}/keys/${UUID}/rotate$`).test(path))return ['POST'];
 if(new RegExp(`^/projects/${PROJECT}/keys/${UUID}$`).test(path))return ['DELETE'];
 if(new RegExp(`^/projects/${PROJECT}/fetch$`).test(path))return ['POST'];
 if(new RegExp(`^/projects/${PROJECT}/fetch/[A-Za-z0-9_.:-]{1,160}$`).test(path))return ['GET'];
 if(new RegExp(`^/projects/${PROJECT}/(?:requests|usage|billing)$`).test(path))return ['GET'];
 if(new RegExp(`^/projects/${PROJECT}/requests/${UUID}$`).test(path))return ['GET'];
 return null;
}
class ProxyFailure extends Error {constructor(readonly code:string){super(code);}}
async function boundedBody(body:ReadableStream<Uint8Array>|null,limit:number,signal:AbortSignal):Promise<Uint8Array> {
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
 const parameters=[...incoming.searchParams];
 if(parameters.length&&!(new RegExp(`^/projects/${PROJECT}/requests$`).test(path)&&parameters.length===1&&parameters[0][0]==='limit'&&/^(?:[1-9]|[1-4][0-9]|50)$/.test(parameters[0][1])))return error(400,'request_invalid','Check the submitted request.');
 const origin=request.headers.get('Origin'),site=request.headers.get('Sec-Fetch-Site');
 if(origin&&origin!==incoming.origin||!['GET','HEAD'].includes(request.method)&&!origin||site&& !['same-origin','none'].includes(site))return error(403,'origin_rejected','Submit this request from the FetchX website.');
 if(!(env.ALLOWED_ORIGINS??'').split(',').map(v=>v.trim()).includes(incoming.origin))return error(403,'origin_rejected','Submit this request from the FetchX website.');
 const development=env.SITE_ENV==='development'&&env.FETCHX_CONTROL_ALLOW_LOOPBACK==='true'&&loopback(incoming);
 if(!env.FETCHX_CONTROL_URL||!env.FETCHX_CONTROL_SECRET){
  if(path==='/status')return response(503,{enabled:false,mail_configured:false,github:{enabled:false},api_base_url:null,capabilities:{native_http:false,render:false,routes:[]}});
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
  const cookies=[requestCookie(request.headers.get('Cookie'),COOKIE,SESSION)];
  if(path==='/auth/google/challenge'||path==='/auth/google/verify')cookies.push(requestCookie(request.headers.get('Cookie'),GOOGLE_COOKIE,GOOGLE_BINDING));
  if(path==='/auth/github/start'||path==='/auth/github/complete')cookies.push(requestCookie(request.headers.get('Cookie'),GITHUB_COOKIE,GITHUB_BINDING));
  const cookie=cookies.filter(Boolean).join('; ');if(cookie)forwarded.set('Cookie',cookie);
  const csrf=request.headers.get('X-CSRF-Token');if(csrf){if(!/^[A-Za-z0-9_-]{43}$/.test(csrf))return error(403,'csrf_rejected','This request could not be authorized.');forwarded.set('X-CSRF-Token',csrf);}
  const ip=request.headers.get('CF-Connecting-IP');if(ip&&/^[a-fA-F0-9:.]{3,64}$/.test(ip))forwarded.set('X-FetchX-Client-IP',ip);
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
  if(result.status>=300&&result.status<400){void result.body?.cancel().catch(()=>{});return error(502,'control_upstream_invalid','The account service response could not be confirmed. Recover any saved request before sending more work.');}
  if(!/^application\/json(?:\s*;|$)/i.test(result.headers.get('Content-Type')??'')||Number(result.headers.get('Content-Length')??0)>CONTROL_RESPONSE_LIMIT){void result.body?.cancel().catch(()=>{});return error(502,'control_upstream_invalid','The account service response could not be confirmed. Recover any saved request before sending more work.');}
  const bytes=await boundedBody(result.body,CONTROL_RESPONSE_LIMIT,controller.signal);
  let payload:unknown;try{payload=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes));if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new Error();}catch{return error(502,'control_upstream_invalid','The account service response could not be confirmed. Recover any saved request before sending more work.');}
  const output=response(result.status,payload);
  const returnedCookies=result.headers.getSetCookie();
  for(const name of [COOKIE,...(path.startsWith('/auth/google/')?[GOOGLE_COOKIE]:[]),...(path.startsWith('/auth/github/')?[GITHUB_COOKIE]:[])]){
   const values=returnedCookies.filter(value=>value.startsWith(name+'='));
   if(values.length!==1)continue;
   const cookie=responseCookie(values[0],!development,name);if(cookie)output.headers.append('Set-Cookie',cookie);
  }
  const retry=result.headers.get('Retry-After');if(retry&&/^\d{1,5}$/.test(retry))output.headers.set('Retry-After',retry);
  return output;
 } catch {
  return error(controller.signal.aborted?504:502,controller.signal.aborted?'control_timeout':'control_unavailable',submitted?'The account service response could not be confirmed. Recover any saved request before sending more work.':'The account service is currently unavailable.');
 } finally {clearTimeout(timer);}
}
