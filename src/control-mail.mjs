import {randomUUID} from 'node:crypto';

const mailbox=value=>typeof value==='string'&&value.length<=254&&/^[A-Za-z0-9.!#$%&'*+\-/=?^_`{|}~]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(value);

// No message or credential is retained here. In particular an ambiguous send is
// never retried: the caller may explicitly request a fresh, independently limited code.
export function createControlMail(config,{fetchImpl=globalThis.fetch}={}){
 const mail=config?.controlPlane?.mail;
 const configured=mail?.transport==='gmail'&&mailbox(mail.from)&&['clientId','clientSecret','refreshToken'].every(k=>typeof mail[k]==='string'&&mail[k].trim().length>0);
 return {configured:!!configured,async sendCode({email,code,challenge_id,expires_at}){
  if(!configured)throw Error('mail_not_configured');
  if(!mailbox(email)||typeof code!=='string'||!/^\d{8}$/.test(code)||typeof challenge_id!=='string'||!/^[-a-f0-9]{36}$/i.test(challenge_id))throw Error('mail_input_invalid');
  const expiry=new Date(expires_at);if(!Number.isFinite(expiry.getTime()))throw Error('mail_input_invalid');
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
