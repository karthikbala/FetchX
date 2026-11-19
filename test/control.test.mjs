import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {GatewayError} from '../src/policy.mjs';
import {registerControl,controlCsrf,CONTROL_COOKIE,isControlRequest} from '../src/control.mjs';

const origin='https://fetchx.ai',secret='synthetic-bridge-secret-32-bytes-minimum',token='fxs_'+'s'.repeat(43);
const project='cp_00000000-0000-4000-8000-000000000001',foreign='cp_00000000-0000-4000-8000-000000000002',operation='00000000-0000-4000-8000-000000000003';
const user={id:'user-one',email:'synthetic@example.com',token_hash:'private-user-hash'};
const metadata={id:project,name:'Synthetic project',status:'active'};
const key={id:operation,project,name:'Synthetic key',prefix:'fxk_safe',scopes:['fetch:read'],token_hash:'private-token-hash'};
async function fixture({fetchResult=null,...options}={}){
 const calls=[],queries=[];let revoked=false;
 const identity={mailConfigured:true,requestCode:async data=>{calls.push(['code',data]);return {challenge_id:operation,expires_in:600,accepted:true};},verifyCode:async()=>({user,session:{token,expires_at:'2030-01-01T00:00:00Z'}}),session:async value=>{if(value!==token||revoked)throw new GatewayError('unauthorized',401);return {user,session:{id:operation}};},revokeSession:async()=>{revoked=true;},projects:async()=>[metadata],createProject:async()=>metadata,requireProject:async(uid,id)=>{calls.push(['member',uid,id]);if(id!==project)throw new GatewayError('project_not_found',404);return metadata;},hydrateProject:async id=>calls.push(['hydrate',id]),keys:async()=>[key],createKey:async()=>({...key,token:'fxk_'+'k'.repeat(43)}),rotateKey:async()=>({...key,token:'fxk_'+'r'.repeat(43)}),revokeKey:async()=>calls.push(['revoke'])};
 identity.authMethods=async()=>({github:false});
 const view={id:operation,status:'succeeded',url:'https://example.com/',data:{status_code:200},credits:{charged:1},attempts:[],error:null};
 const service={
  submit:async(id,body,meta)=>{calls.push(['submit',id,body,meta]);return fetchResult??view;},
  list:async(id,query)=>{queries.push({args:[id,query]});return {items:[{id:operation,status:'succeeded'}],next_cursor:null};},
  get:async(id,rid,options)=>{calls.push(['get',id,rid,options]);return view;},
  remove:async(id,rid)=>{calls.push(['remove',id,rid]);},
  webhookSecret:async(id,options)=>options?.rotate?'whsec_rotated':'whsec_current',
  store:{pool:{query:async()=>({rows:[{succeeded:3,failed:1}]})}},
 };
 const ledger={prices:{http:1},metered:()=>true,balance:async()=>({credits:9,available:9,reserved:0,trial:10,purchased:0,held:false}),
  usage:async()=>({credits:1,by_step:[{step:'http',requests:1,credits:1}],captcha_solved:0,daily:[]})};
 const app=Fastify();
 const config={enabled:true,origins:[origin],bridgeSecret:secret,...options};
 registerControl(app,{config:{controlPlane:config}},{identity,ledger,service});await app.ready();
 const send=(method,path,payload,extra={})=>app.inject({method,url:'/control'+path,headers:{origin,'x-fetchx-control-secret':secret,cookie:`${CONTROL_COOKIE}=${token}`,'x-csrf-token':controlCsrf(token,secret),...extra},...(payload===undefined?{}:{payload})});
 return {app,send,calls,queries,identity};
}

test('control authenticates the bridge, exact origin, session and session-bound CSRF',async t=>{
 const f=await fixture();t.after(()=>f.app.close());
 assert.equal(isControlRequest({url:'/control/session?x=1'}),true);assert.equal(isControlRequest({url:'/controller'}),false);
 for(const headers of [{'x-fetchx-control-secret':'wrong'},{origin:'https://fetchx.ai.attacker.example'},{origin:''}])assert.equal((await f.send('GET','/session',undefined,headers)).statusCode,403);
 assert.equal((await f.send('GET','/session',undefined,{cookie:''})).statusCode,401);
 assert.equal((await f.send('GET','/session',undefined,{cookie:`${CONTROL_COOKIE}=${token}; ${CONTROL_COOKIE}=${token}`})).statusCode,401);
 const auth=await f.send('POST','/auth/verify',{email:user.email,challenge_id:operation,code:'12345678'});
 assert.equal(auth.statusCode,200);assert.match(auth.headers['set-cookie'],/HttpOnly; SameSite=Lax; Secure/);assert.match(auth.headers['set-cookie'],/Path=\/api\/control/);
 assert.equal(auth.json().csrf_token,controlCsrf(token,secret));assert.ok(!auth.body.includes(token));assert.ok(!auth.body.includes('private-'));
 assert.deepEqual(auth.json().auth_methods,{github:false});
 for(const csrf of ['',controlCsrf('fxs_'+'x'.repeat(43),secret)])assert.equal((await f.send('POST','/projects',{name:'New'},{'x-csrf-token':csrf})).statusCode,403);
 const logout=await f.send('POST','/auth/logout',{});assert.equal(logout.statusCode,200);assert.match(logout.headers['set-cookie'],/Path=\/api\/control; HttpOnly; SameSite=Lax; Secure; Max-Age=0/);
 assert.equal((await f.send('GET','/session')).statusCode,401);
});

test('control checks membership for every project resource and never accepts body grants or credentials',async t=>{
 const f=await fixture();t.after(()=>f.app.close());
 for(const [method,path,body]of [['GET',''],['GET','/keys'],['POST','/keys',{name:'new'}],['POST',`/keys/${operation}/rotate`,{}],['DELETE',`/keys/${operation}`],['POST','/fetch',{url:'https://example.com/'}],['GET',`/fetch/${operation}`],['GET','/fetch'],['DELETE',`/fetch/${operation}`],['GET','/webhook-secret'],['GET','/usage'],['GET','/billing']]){
  const denied=await f.send(method,`/projects/${foreign}${path}`,body);assert.equal(denied.statusCode,404,path);assert.equal(denied.json().error.code,'project_not_found');
 }
 assert.equal(f.calls.some(c=>c[0]==='submit'),false);assert.equal(f.queries.length,0);
 assert.equal((await f.send('POST','/projects',{name:'x',v2_access_profiles:['unapproved']})).statusCode,400);
 assert.equal((await f.send('POST',`/projects/${project}/keys`,{name:'x',token:'caller-choice'})).statusCode,400);
 const keys=await f.send('GET',`/projects/${project}/keys`);assert.deepEqual(keys.json().keys[0].scopes,['fetch:read']);assert.ok(!keys.body.includes('token_hash'));
 const created=await f.send('POST',`/projects/${project}/keys`,{name:'x'});assert.match(created.json().token,/^fxk_/);assert.ok(!created.body.includes('token_hash'));
 assert.equal((await f.send('POST',`/projects/${project}/keys/${operation}/rotate`)).statusCode,415);
 const rotated=await f.send('POST',`/projects/${project}/keys/${operation}/rotate`,{});assert.equal(rotated.statusCode,200);assert.match(rotated.json().token,/^fxk_/);assert.ok(!rotated.body.includes('token_hash'));
});





test('control rejects malformed, oversized and unknown requests with stable errors',async t=>{
 const f=await fixture();t.after(()=>f.app.close());
 f.identity.requestCode=async()=>{throw new Error('private SQL password and token');};
 const failed=await f.send('POST','/auth/code',{email:user.email});assert.equal(failed.statusCode,500);assert.deepEqual(failed.json(),{error:{code:'internal_error',message:'The account service could not complete this request.'}});
 const invalid=await f.send('POST','/auth/code','{"secret":',{'content-type':'application/json'});assert.equal(invalid.statusCode,400);assert.ok(!invalid.body.includes('secret'));
 const oversized=await f.send('POST','/auth/code',{email:'x'.repeat(100*1024)});assert.equal(oversized.statusCode,413);assert.equal(oversized.json().error.code,'request_invalid');
 assert.equal((await f.send('GET','/unknown')).statusCode,404);
});

test('disabled control and insecure cookie configurations fail closed',async t=>{
 const disabled=await fixture({enabled:false});t.after(()=>disabled.app.close());assert.equal((await disabled.send('GET','/status')).json().enabled,false);assert.equal((await disabled.send('POST','/projects',{name:'x'})).statusCode,503);
 const insecure=await fixture({sessionSecure:false});t.after(()=>insecure.app.close());assert.equal((await insecure.send('GET','/status')).statusCode,503);
});

test('local mailbox status is disclosed only for the trusted adapter under explicit loopback development',async t=>{
 const local='http://127.0.0.1:4328';
 for(const [settings,expected]of [
  [{allowLoopbackDevelopment:true,origins:[local],sessionSecure:false},true],
  [{origins:[local]},false],
  [{allowLoopbackDevelopment:true,origins:[local,origin]},false],
  [{allowLoopbackDevelopment:true},false],
 ]){
  const f=await fixture(settings);t.after(()=>f.app.close());
  f.identity.mail={configured:true,delivery:'local_private_mailbox',path:'/private/mailbox.jsonl',code:'12345678'};
  const result=await f.send('GET','/status',undefined,{origin:settings.origins?.[0]??origin});
  assert.equal(result.statusCode,200);
  assert.equal(result.json().mail_delivery,expected?'local_private_mailbox':undefined);
  assert.ok(!result.body.includes('/private'));assert.ok(!result.body.includes('12345678'));
 }
 const f=await fixture({allowLoopbackDevelopment:true,origins:[local],sessionSecure:false});t.after(()=>f.app.close());
 f.identity.mail={configured:true,delivery:'gmail'};
 assert.equal((await f.send('GET','/status',undefined,{origin:local})).json().mail_delivery,undefined);
});

test('the console playground, history, usage, billing and webhook secret go through the one fetch service and ledger',async t=>{
 const f=await fixture();t.after(()=>f.app.close());
 assert.deepEqual((await f.send('GET',`/projects/${project}`)).json(),{project:{id:project,name:'Synthetic project',status:'active'}});
 const submitted=await f.send('POST',`/projects/${project}/fetch`,{url:'https://example.com/',formats:['markdown']});
 assert.equal(submitted.statusCode,200);assert.equal(submitted.json().status,'succeeded');
 assert.deepEqual(f.calls.find(c=>c[0]==='submit'),['submit',project,{url:'https://example.com/',formats:['markdown']},{keyId:'console'}]);
 const history=await f.send('GET',`/projects/${project}/fetch?limit=5`);
 assert.deepEqual(history.json().items,[{id:operation,status:'succeeded'}]);assert.equal(f.queries.at(-1).args[0],project);assert.equal(f.queries.at(-1).args[1].limit,'5');
 assert.equal(history.headers['cache-control'],'no-store');
 assert.equal((await f.send('GET',`/projects/${project}/fetch/${operation}?include_body=false`)).json().id,operation);
 assert.deepEqual(f.calls.find(c=>c[0]==='get'),['get',project,operation,{includeBody:false}]);
 assert.equal((await f.send('GET',`/projects/${project}/fetch/not-a-uuid`)).statusCode,400);
 assert.deepEqual((await f.send('DELETE',`/projects/${project}/fetch/${operation}`)).json(),{deleted:true});
 const usage=(await f.send('GET',`/projects/${project}/usage?period=day`)).json();
 assert.equal(usage.balance.credits,9);assert.equal(usage.used.succeeded,3);assert.deepEqual(usage.by_step,[{step:'http',requests:1,credits:1}]);
 const billing=(await f.send('GET',`/projects/${project}/billing`)).json();
 assert.equal(billing.balance.available,9);assert.deepEqual(billing.prices,{http:1});
 assert.deepEqual((await f.send('GET',`/projects/${project}/webhook-secret`)).json(),{secret:'whsec_current'});
 assert.deepEqual((await f.send('POST',`/projects/${project}/webhook-secret/rotate`,{})).json(),{secret:'whsec_rotated'});
});
