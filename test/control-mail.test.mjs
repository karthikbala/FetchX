import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createControlMail} from '../src/control-mail.mjs';

const secret='synthetic-private-mail-secret-at-least-32-bytes';
const settings=mail=>({controlPlane:{bridgeSecret:'separate-synthetic-bridge-secret-at-least-32-bytes',mail:{transport:'pages',url:'https://fetchx.example/api/control-mail',secret,...mail}}});
const verification=()=>({email:'user@example.com',code:'01234567',challenge_id:randomUUID(),expires_at:new Date(Date.now()+600000)});
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});

test('Pages mail configuration fails closed for malformed endpoint, weak or reused secret',async()=>{
 for(const mail of [
  {url:undefined},{url:'http://fetchx.example/api/control-mail'},{url:'\nhttps://fetchx.example/api/control-mail'},
  {url:'https://fetchx.example/api/control-mail?redirect=other'},
  {url:'https://fetchx.example/api/control-mail#fragment'},
  {url:'https://user:pass@fetchx.example/api/control-mail'},
  {url:'https://fetchx.example:444/api/control-mail'},
  {url:'https://fetchx.example/api/other'},
  {url:'https://localhost/api/control-mail'},{url:'https://127.0.0.1/api/control-mail'},
  {secret:''},{secret:'too-short'},{secret:secret+'\r\n'},
  {secret:'separate-synthetic-bridge-secret-at-least-32-bytes'},
  {secret:'x'.repeat(257)},{transport:'unapproved'},
 ]){
  let calls=0;
  const configured=createControlMail(settings(mail),{fetchImpl:async()=>{calls++;return json({ok:true});}});
  assert.equal(configured.configured,false);
  await assert.rejects(configured.sendCode(verification()),{message:'mail_not_configured'});
  assert.equal(calls,0);
 }
});

test('Pages mail sends only one fixed verification payload to its configured private endpoint',async()=>{
 const calls=[];
 const mail=createControlMail(settings(),{fetchImpl:async(...args)=>{calls.push(args);return json({ok:true});}});
 assert.equal(mail.configured,true);
 const data=verification();await mail.sendCode({...data,from:'attacker@example.com',text:'arbitrary body'});
 assert.equal(calls.length,1);
 const [url,input]=calls[0];
 assert.equal(url,'https://fetchx.example/api/control-mail');
 assert.equal(input.method,'POST');assert.equal(input.redirect,'error');
 assert.equal(input.headers['X-FetchX-Control-Mail-Secret'],secret);
 assert.equal(input.headers['content-type'],'application/json');
 assert.ok(input.signal instanceof AbortSignal);
 assert.deepEqual(JSON.parse(input.body),{...data,expires_at:data.expires_at.toISOString()});
 assert.ok(!input.body.includes(secret));
});

test('Pages mail rejects invalid recipient, code, challenge and expiry before dispatch',async()=>{
 let calls=0;const mail=createControlMail(settings(),{fetchImpl:async()=>{calls++;return json({ok:true});}});
 for(const invalid of [
  {email:'recipient@example.com\r\nBcc: other@example.com'},{email:'not-an-email'},
  {email:'user@example..com'},{email:'.user@example.com'},{email:'user..other@example.com'},{email:'user@-example.com'},
  {code:'1234567'},{code:12345678},{code:'123456789'},
  {challenge_id:'-'.repeat(36)},{challenge_id:randomUUID()+'\r\nHeader: injected'},
  {expires_at:'invalid'},{expires_at:new Date(Date.now()-1000)},
  {expires_at:new Date(Date.now()+86400000)},
 ])await assert.rejects(mail.sendCode({...verification(),...invalid}),{message:'mail_input_invalid'});
 assert.equal(calls,0);
});

test('Pages mail bounds and validates replies and never retries ambiguous delivery',async()=>{
 for(const outcome of [
  ()=>{throw Error('sensitive upstream secret');},
  ()=>json({error:'sensitive upstream secret'},502),
  ()=>new Response(null,{status:302,headers:{location:'https://other.example/'}}),
  ()=>json({ok:false}),()=>json({ok:true,unexpected:'x'.repeat(2048)}),
  ()=>new Response('not JSON',{headers:{'Content-Type':'application/json'}}),
  ()=>new Response('ok',{headers:{'Content-Type':'text/plain'}}),
  ()=>new Response('{}',{headers:{'Content-Type':'application/json','Content-Length':'2048'}}),
 ]){
  let calls=0;const mail=createControlMail(settings(),{fetchImpl:async()=>{calls++;return outcome();}});
  await assert.rejects(mail.sendCode(verification()),{message:'mail_delivery_uncertain'});assert.equal(calls,1);
 }
 let calls=0;const rejected=createControlMail(settings(),{fetchImpl:async()=>{calls++;return json({error:'private'},401);}});
 await assert.rejects(rejected.sendCode(verification()),{message:'mail_delivery_failed'});assert.equal(calls,1);
});

test('Pages mail timeout covers reply streaming without retry',async t=>{
 let calls=0;
 t.mock.method(AbortSignal,'timeout',()=>AbortSignal.abort());
 const mail=createControlMail(settings(),{fetchImpl:async()=>{
  calls++;
  const response=new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{'));}}),{headers:{'Content-Type':'application/json'}});
  return response;
 }});
 await assert.rejects(mail.sendCode(verification()),{message:'mail_delivery_uncertain'});assert.equal(calls,1);
});

test('direct Gmail mail transport remains compatible and does not retry',async()=>{
 const calls=[];
 const mail=createControlMail(settings({transport:'gmail',from:'verify@example.com',clientId:'synthetic-client',clientSecret:'synthetic-client-secret',refreshToken:'synthetic-refresh'}),{fetchImpl:async(...args)=>{calls.push(args);return calls.length===1?{ok:true,json:async()=>({access_token:'synthetic-token'})}:{ok:true,json:async()=>({id:'synthetic-message'})};}});
 assert.equal(mail.configured,true);await mail.sendCode(verification());assert.equal(calls.length,2);
 assert.equal(calls[0][0],'https://oauth2.googleapis.com/token');
 assert.equal(calls[1][0],'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
 const mime=Buffer.from(JSON.parse(calls[1][1].body).raw,'base64url').toString();
 assert.match(mime,/From: verify@example\.com\r\nTo: user@example\.com\r\n/);
 assert.ok(!mime.includes('synthetic-client-secret'));
});
