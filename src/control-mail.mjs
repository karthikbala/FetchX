import {randomUUID} from 'node:crypto';

const mailbox=value=>{
 if(typeof value!=='string'||value.length>254||!/^[A-Za-z0-9.!#$%&'*+\-/=?^_`{|}~]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/.test(value))return false;
 const [local,domain]=value.split('@');
 return local.length<=64&&!local.startsWith('.')&&!local.endsWith('.')&&!local.includes('..')&&domain.split('.').every(label=>/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
};
const relaySecret=value=>typeof value==='string'&&/^[\x21-\x7e]{32,256}$/.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
function relayUrl(value){
 try{
  if(typeof value!=='string'||/[\x00-\x20\x7f]/.test(value))return null;
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.port||url.pathname!=='/api/control-mail'||!/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(url.hostname)||url.hostname.endsWith('.localhost'))return null;
  return url.href;
 }catch{return null;}
}
async function relayReply(response,signal){
 const limit=1024;
 if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??'')||Number(response.headers.get('content-length')??0)>limit){void response.body?.cancel().catch(()=>{});throw Error();}
 if(!response.body)throw Error();
 const reader=response.body.getReader(),chunks=[];let length=0,abort;
 const aborted=new Promise((_,reject)=>{abort=()=>{void reader.cancel().catch(()=>{});reject(Error());};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
 try{
  for(;;){const {done,value}=await Promise.race([reader.read(),aborted]);if(done)break;length+=value.byteLength;if(length>limit){void reader.cancel().catch(()=>{});throw Error();}chunks.push(value);}
 }finally{signal.removeEventListener('abort',abort);reader.releaseLock();}
 return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
}

// No message or credential is retained here. In particular an ambiguous send is
// never retried: the caller may explicitly request a fresh, independently limited code.
export function createControlMail(config,{fetchImpl=globalThis.fetch}={}){
 const mail=config?.controlPlane?.mail;
 const pagesUrl=mail?.transport==='pages'?relayUrl(mail.url):null;
 const pagesConfigured=!!pagesUrl&&relaySecret(mail?.secret)&&mail.secret!==config?.controlPlane?.bridgeSecret;
 const gmailConfigured=mail?.transport==='gmail'&&mailbox(mail.from)&&['clientId','clientSecret','refreshToken'].every(k=>typeof mail[k]==='string'&&mail[k].trim().length>0);
 const configured=pagesConfigured||gmailConfigured;
 return {configured:!!configured,async sendCode({email,code,challenge_id,expires_at}){
  if(!configured)throw Error('mail_not_configured');
  if(!mailbox(email)||typeof code!=='string'||!/^\d{8}$/.test(code)||!uuid(challenge_id))throw Error('mail_input_invalid');
  const expiry=new Date(expires_at);if(!Number.isFinite(expiry.getTime()))throw Error('mail_input_invalid');
  if(pagesConfigured){
   const remaining=expiry.getTime()-Date.now();if(remaining<=0||remaining>660000)throw Error('mail_input_invalid');
   const signal=AbortSignal.timeout(25000);let response;
   try{response=await fetchImpl(pagesUrl,{method:'POST',headers:{'content-type':'application/json','accept':'application/json','X-FetchX-Control-Mail-Secret':mail.secret},body:JSON.stringify({email,code,challenge_id,expires_at:expiry.toISOString()}),redirect:'error',signal});}catch{throw Error('mail_delivery_uncertain');}
   if(!response.ok){void response.body?.cancel().catch(()=>{});throw Error(response.status>=500||response.status>=300&&response.status<400?'mail_delivery_uncertain':'mail_delivery_failed');}
   try{const result=await relayReply(response,signal);if(result?.ok!==true)throw Error();}catch{throw Error('mail_delivery_uncertain');}
   return;
  }
  const credentials=new URLSearchParams({client_id:mail.clientId,client_secret:mail.clientSecret,refresh_token:mail.refreshToken,grant_type:'refresh_token'});
  let tokenResponse;
  try{tokenResponse=await fetchImpl('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:credentials,redirect:'error',signal:AbortSignal.timeout(10000)});}catch{throw Error('mail_auth_failed');}
  if(!tokenResponse.ok)throw Error('mail_auth_failed');
  let accessToken;try{accessToken=(await tokenResponse.json()).access_token;}catch{throw Error('mail_auth_failed');}
  if(typeof accessToken!=='string'||!accessToken||/[\r\n]/.test(accessToken))throw Error('mail_auth_failed');
  const text=`Your FetchX verification code is ${code}.\n\nThis code expires at ${expiry.toISOString()} and can be used once.\nIf you did not request it, you can ignore this email.`;
  const body=Buffer.from(text).toString('base64').match(/.{1,76}/g).join('\r\n');
  const mime=[`From: ${mail.from}`,`To: ${email}`,'Subject: Your FetchX verification code',`Message-ID: <${challenge_id}.${randomUUID()}@fetchx.ai>`,'MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',body,''].join('\r\n');
  let response;
  try{response=await fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me/messages/send',{method:'POST',headers:{authorization:`Bearer ${accessToken}`,'content-type':'application/json'},body:JSON.stringify({raw:Buffer.from(mime).toString('base64url')}),redirect:'error',signal:AbortSignal.timeout(10000)});}catch{throw Error('mail_delivery_uncertain');}
  // Do not expose provider responses, message IDs, or user-supplied text in errors.
  if(!response.ok)throw Error(response.status>=500?'mail_delivery_uncertain':'mail_delivery_failed');
  let result;try{result=await response.json();}catch{throw Error('mail_delivery_uncertain');}
  if(typeof result.id!=='string'||!result.id)throw Error('mail_delivery_uncertain');
 }};
}
