// Server-only: never import this module from a browser script.
export interface ControlEnv {
 FETCHX_CONTROL_URL?: string;
 FETCHX_CONTROL_SECRET?: string;
 FETCHX_CONTROL_ALLOW_LOOPBACK?: string;
 ALLOWED_ORIGINS?: string;
 SITE_ENV?: string;
}
const COOKIE='fetchx_session';
const SESSION=/^fxs_[A-Za-z0-9_-]{43}$/;
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
 if(['/auth/code','/auth/verify','/auth/logout'].includes(path))return ['POST'];
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
function sessionCookie(value:string|null):string|null {
 const parts=(value??'').split(';').map(v=>v.trim()).filter(v=>v.startsWith(COOKIE+'='));
 return parts.length===1&&SESSION.test(parts[0].slice(COOKIE.length+1))?parts[0]:null;
}
function responseCookie(value:string,secure:boolean):string|null {
 const parts=value.split(';').map(v=>v.trim()),pair=parts.shift()??'';
 if(!pair.startsWith(COOKIE+'='))return null;
 const token=pair.slice(COOKIE.length+1);if(token!==''&&!SESSION.test(token))return null;
 const out=[pair,'Path=/api/control','HttpOnly','SameSite=Lax'];if(secure)out.push('Secure');
 if(!token)out.push('Max-Age=0','Expires=Thu, 01 Jan 1970 00:00:00 GMT');
 else {const expires=parts.find(v=>/^Expires=/i.test(v));if(expires){const date=new Date(expires.slice(8));if(!Number.isFinite(date.getTime()))return null;out.push('Expires='+date.toUTCString());}}
 return out.join('; ');
}

export async function handleControl(request:Request,env:ControlEnv):Promise<Response> {
 const incoming=new URL(request.url),path=incoming.pathname.slice('/api/control'.length);
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
  if(path==='/status')return response(503,{enabled:false,mail_configured:false,api_base_url:null,capabilities:{native_http:false,render:false,routes:[]}});
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
  const cookie=sessionCookie(request.headers.get('Cookie'));if(cookie)forwarded.set('Cookie',cookie);
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
  for(const value of result.headers.getSetCookie()){const cookie=responseCookie(value,!development);if(cookie)output.headers.append('Set-Cookie',cookie);}
  const retry=result.headers.get('Retry-After');if(retry&&/^\d{1,5}$/.test(retry))output.headers.set('Retry-After',retry);
  return output;
 } catch {
  return error(controller.signal.aborted?504:502,controller.signal.aborted?'control_timeout':'control_unavailable',submitted?'The account service response could not be confirmed. Recover any saved request before sending more work.':'The account service is currently unavailable.');
 } finally {clearTimeout(timer);}
}
