// Server-only private gateway relay. Never import from browser code.
export interface ControlMailEnv {
 FETCHX_CONTROL_MAIL_SECRET?: string;
 FETCHX_CONTROL_SECRET?: string;
 MAIL_FROM?: string;
 GOOGLE_CLIENT_ID?: string;
 GOOGLE_CLIENT_SECRET?: string;
 GOOGLE_REFRESH_TOKEN?: string;
}
const encoder=new TextEncoder();
const INPUT_LIMIT=2048;
const PROVIDER_LIMIT=16384;
const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Pragma':'no-cache','X-Content-Type-Options':'nosniff','X-Robots-Tag':'noindex, nofollow'};
const reply=(status:number,body:Record<string,unknown>,extra:Record<string,string>={})=>new Response(JSON.stringify(body),{status,headers:{...headers,...extra}});
const failure=(status:number,code:string)=>reply(status,{error:code});
const validSecret=(value:unknown):value is string=>typeof value==='string'&&/^[\x21-\x7e]{32,256}$/.test(value);
const mailbox=(value:unknown):boolean=>{
 if(typeof value!=='string'||value.length>254||!/^[A-Za-z0-9.!#$%&'*+\-/=?^_`{|}~]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/.test(value))return false;
 const [local,domain]=value.split('@');
 return local.length<=64&&!local.startsWith('.')&&!local.endsWith('.')&&!local.includes('..')&&domain.split('.').every(label=>/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
};
function sender(value:unknown):value is string {
 if(typeof value!=='string')return false;
 return mailbox(value)||value.startsWith('FetchX <')&&value.endsWith('>')&&mailbox(value.slice(8,-1));
}
async function authorized(supplied:string,expected:string):Promise<boolean> {
 // Hash both values before the fixed-length comparison; never compare secret
 // strings with an early-return prefix or expose either value in a response.
 const hashes=await Promise.all([supplied,expected].map(value=>crypto.subtle.digest('SHA-256',encoder.encode(value))));
 const left=new Uint8Array(hashes[0]),right=new Uint8Array(hashes[1]);let difference=0;
 for(let i=0;i<left.length;i++)difference|=left[i]^right[i];
 return difference===0;
}
class BodyFailure extends Error {constructor(readonly code:'size'|'timeout'){super(code);}}
async function readBody(body:ReadableStream<Uint8Array>|null,limit:number,signal:AbortSignal):Promise<Uint8Array> {
 if(!body)return new Uint8Array();
 const reader=body.getReader(),chunks:Uint8Array[]=[];let length=0,abort:()=>void=()=>{};
 const aborted=new Promise<never>((_,reject)=>{abort=()=>{reject(new BodyFailure('timeout'));void reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
 try{
  for(;;){const {done,value}=await Promise.race([reader.read(),aborted]);if(done)break;length+=value.byteLength;if(length>limit){void reader.cancel().catch(()=>{});throw new BodyFailure('size');}chunks.push(value);}
 }finally{signal.removeEventListener('abort',abort);reader.releaseLock();}
 const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return bytes;
}
async function providerJson(response:Response,signal:AbortSignal):Promise<Record<string,unknown>> {
 if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('Content-Type')??'')||Number(response.headers.get('Content-Length')??0)>PROVIDER_LIMIT){void response.body?.cancel().catch(()=>{});throw new Error();}
 const bytes=await readBody(response.body,PROVIDER_LIMIT,signal);
 const data:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes));
 if(!data||typeof data!=='object'||Array.isArray(data))throw new Error();
 return data as Record<string,unknown>;
}
interface Verification {email:string;code:string;challenge_id:string;expires_at:string}
function verification(value:unknown):Verification|null {
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const data=value as Record<string,unknown>;
 if(Object.keys(data).length!==4||!['email','code','challenge_id','expires_at'].every(key=>Object.hasOwn(data,key)))return null;
 if(!mailbox(data.email)||typeof data.code!=='string'||!/^\d{8}$/.test(data.code)||typeof data.challenge_id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(data.challenge_id)||typeof data.expires_at!=='string')return null;
 const expiry=new Date(data.expires_at),remaining=expiry.getTime()-Date.now();
 if(!Number.isFinite(remaining)||remaining<=0||remaining>660000||expiry.toISOString()!==data.expires_at)return null;
 return data as unknown as Verification;
}
function message(data:Verification,from:string):string {
 const text=`Your FetchX verification code is ${data.code}.\n\nThis code expires at ${data.expires_at} and can be used once.\nIf you did not request it, you can ignore this email.`;
 const body=btoa(text).match(/.{1,76}/g)!.join('\r\n');
 const mime=[`From: ${from}`,`To: ${data.email}`,'Subject: Your FetchX verification code',`Message-ID: <${data.challenge_id}.${crypto.randomUUID()}@fetchx.ai>`,'MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',body,''].join('\r\n');
 return btoa(mime).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

type MailAuthResult={ok:true;token:string}|{ok:false;error:string};
const authErrors=new Set(['invalid_grant','invalid_client','unauthorized_client','access_denied','invalid_scope','unsupported_grant_type']);
async function mailAuth(env:ControlMailEnv,diagnostic:boolean):Promise<MailAuthResult> {
 const credentials=new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID!,client_secret:env.GOOGLE_CLIENT_SECRET!,refresh_token:env.GOOGLE_REFRESH_TOKEN!,grant_type:'refresh_token'});
 const signal=AbortSignal.timeout(10000);
 let response:Response;
 try{response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:credentials,redirect:'error',signal});}
 catch{return {ok:false,error:'mail_provider_unreachable'};}
 if(!response.ok){
  if(diagnostic){
   try{const result=await providerJson(response,signal);if(typeof result.error==='string'&&authErrors.has(result.error))return {ok:false,error:'mail_auth_'+result.error};}catch{}
  }else void response.body?.cancel().catch(()=>{});
  return {ok:false,error:'mail_auth_failed'};
 }
 try{
  const token=(await providerJson(response,signal)).access_token;
  if(typeof token!=='string'||!token||token.length>8192||/[^\x21-\x7e]/.test(token))return {ok:false,error:'mail_auth_invalid_response'};
  return {ok:true,token};
 }catch{return {ok:false,error:'mail_auth_invalid_response'};}
}

export async function handleControlMail(request:Request,env:ControlMailEnv):Promise<Response> {
 const url=new URL(request.url);
 if(url.pathname!=='/api/control-mail'||url.search)return failure(404,'not_found');
 if(!['GET','POST'].includes(request.method))return reply(405,{error:'method_not_allowed'},{Allow:'GET, POST'});
 if(!validSecret(env.FETCHX_CONTROL_MAIL_SECRET)||env.FETCHX_CONTROL_MAIL_SECRET===env.FETCHX_CONTROL_SECRET||!sender(env.MAIL_FROM)||![env.GOOGLE_CLIENT_ID,env.GOOGLE_CLIENT_SECRET,env.GOOGLE_REFRESH_TOKEN].every(value=>typeof value==='string'&&value.trim().length>0))return failure(503,'mail_unavailable');
 const supplied=request.headers.get('X-FetchX-Control-Mail-Secret');
 if(!validSecret(supplied)||!await authorized(supplied,env.FETCHX_CONTROL_MAIL_SECRET))return failure(401,'unauthorized');
 if(request.headers.has('Origin')||request.headers.has('Sec-Fetch-Site'))return failure(403,'forbidden');
 if(request.method==='GET'){
  // Private operator probe: refresh authorization only; never construct or send mail.
  const auth=await mailAuth(env,true);
  return auth.ok?reply(200,{ready:true}):reply(503,{ready:false,error:auth.error});
 }
 if(!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(request.headers.get('Content-Type')??'')||!['','identity'].includes(request.headers.get('Content-Encoding')??''))return failure(415,'request_invalid');
 if(Number(request.headers.get('Content-Length')??0)>INPUT_LIMIT)return failure(413,'request_too_large');
 let data:Verification|null;
 try{data=verification(JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(await readBody(request.body,INPUT_LIMIT,AbortSignal.timeout(3000)))));}catch(error){return failure(error instanceof BodyFailure&&error.code==='size'?413:400,'request_invalid');}
 if(!data)return failure(400,'request_invalid');
 const auth=await mailAuth(env,false);
 if(!auth.ok)return failure(503,'mail_unavailable');
 const token=auth.token;
 try{
  const signal=AbortSignal.timeout(10000);
  // One attempt only. Gmail cannot establish idempotency after an ambiguous send.
  const response=await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send',{method:'POST',headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({raw:message(data,env.MAIL_FROM)}),redirect:'error',signal});
  if(!response.ok){void response.body?.cancel().catch(()=>{});return failure(response.status>=500||response.status>=300&&response.status<400?502:422,'mail_unconfirmed');}
  const result=await providerJson(response,signal);
  if(typeof result.id!=='string'||!result.id)return failure(502,'mail_unconfirmed');
  return reply(200,{ok:true});
 }catch{return failure(502,'mail_unconfirmed');}
}
