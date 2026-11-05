import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {GatewayError} from '../src/policy.mjs';
import {registerControl,controlCsrf,CONTROL_COOKIE,isControlRequest} from '../src/control.mjs';

const origin='https://fetchx.ai',secret='synthetic-bridge-secret-32-bytes-minimum',token='fxs_'+'s'.repeat(43);
const project='cp_00000000-0000-4000-8000-000000000001',foreign='cp_00000000-0000-4000-8000-000000000002',operation='00000000-0000-4000-8000-000000000003';
const user={id:'user-one',email:'synthetic@example.com',token_hash:'private-user-hash'};
const metadata={id:project,name:'Synthetic project',status:'active',template_hash:'private-template-hash'};
const key={id:operation,project,name:'Synthetic key',prefix:'fxk_safe',scopes:['fetch:read'],token_hash:'private-token-hash'};
const envelope={success:false,state:'unknown',operation_id:operation,idempotency_key:'saved',data:null,retry:{safe_to_retry:false,lookup_url:'/v2/fetch/saved'}};
async function fixture(options={}){
 const calls=[],queries=[];let revoked=false;
 const identity={mailConfigured:true,requestCode:async data=>{calls.push(['code',data]);return {challenge_id:operation,expires_in:600,accepted:true};},verifyCode:async()=>({user,session:{token,expires_at:'2030-01-01T00:00:00Z'}}),session:async value=>{if(value!==token||revoked)throw new GatewayError('unauthorized',401);return {user,session:{id:operation}};},revokeSession:async()=>{revoked=true;},projects:async()=>[metadata],createProject:async()=>metadata,requireProject:async(uid,id)=>{calls.push(['member',uid,id]);if(id!==project)throw new GatewayError('project_not_found',404);return metadata;},hydrateProject:async id=>calls.push(['hydrate',id]),keys:async()=>[key],createKey:async()=>({...key,token:'fxk_'+'k'.repeat(43)}),rotateKey:async()=>({...key,token:'fxk_'+'r'.repeat(43)}),revokeKey:async()=>calls.push(['revoke'])};
 const pool={query:async(sql,args)=>{queries.push({sql,args});if(sql.includes('percentile_cont'))return {rows:[{completed_operations:1,mean:400,p50:400,p95:400}]};return {rows:[{id:operation,state:'completed',error:null,created_at:'2026-11-01T00:00:00Z',finished_at:'2026-11-01T00:00:00.400Z',profile_id:'source',profile_version:1,provider:'direct',proxy_class:'direct',summary:{source_http_status:200,physical_requests:1,decoded_bytes:12,private_capture:'secret source URL',diagnostics:{private:'secret'}}}]};}};
 identity.authMethods=async()=>({github:false});
 const v2={store:{pool},recentOperations:async(id,raw)=>{queries.push({args:[id,Number(raw.limit??25)]});return {operations:[{id:operation,state:'completed',error:null,created_at:'2026-11-01T00:00:00Z',finished_at:'2026-11-01T00:00:00.400Z',latency_ms:400,access_profile:{id:'source',version:1},routing:{class:'direct',country:null,provider:'direct',private:'secret'},private_capture:'secret source URL',diagnostics:{private:'secret'},source_http_status:200}]};},capabilities:async()=>({transports:{http:true,browser:true},proxy_classes:{direct:true,datacenter:true,residential:true},features:{browser_network_probe:true}}),profiles:async()=>({access_profiles:[{id:'source',version:1,proxy_classes:['direct','residential'],route_reservations:[{class:'direct'},{class:'residential'}],browser_probe:{enabled:true}}]}),usage:async()=>({outcomes:{source_successes:1}})};
 const app=Fastify();app.decorate('v2',v2);app.decorate('publicFetch',{fetch:async(id,body,identity)=>{calls.push(['fetch',id,body,identity]);if(body.render)throw new GatewayError('capability_unsupported',409);return envelope;},lookup:async(id,saved)=>{calls.push(['lookup',id,saved]);return envelope;},lookupOperation:async(id,op)=>{calls.push(['lookupOperation',id,op]);return envelope;}});
 if(options.testRender){
  const rendered={...envelope,execution:'browser'};
  v2.readOperation=async(id,op)=>{calls.push(['readOperation',id,op]);return {id:op,execution:'browser'};};
  app.decorate('publicRender',{render:async(id,body,selected)=>{calls.push(['render',id,body,selected]);return rendered;},
   lookup:async(id,saved)=>{calls.push(['renderLookup',id,saved]);return rendered;},
   lookupOperation:async(id,op,retained)=>{calls.push(['renderLookupOperation',id,op,retained]);return rendered;}});
 }
 const config={enabled:true,origins:[origin],bridgeSecret:secret,creditPolicy:{weights:{direct:1}},...options};
 const credits={usage:async()=>({granted:10,available:9,held:1})};
 registerControl(app,{config:{controlPlane:config}},{identity,credits});await app.ready();
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
 for(const [method,path,body]of [['GET',''],['GET','/keys'],['POST','/keys',{name:'new'}],['POST',`/keys/${operation}/rotate`,{}],['DELETE',`/keys/${operation}`],['POST','/fetch',{idempotency_key:'x'}],['GET','/fetch/saved'],['POST','/playground/prepare',{}],['POST','/render',{}],['GET','/render/saved'],['GET','/requests'],['GET',`/requests/${operation}`],['GET','/usage'],['GET','/billing']]){
  const denied=await f.send(method,`/projects/${foreign}${path}`,body);assert.equal(denied.statusCode,404,path);assert.equal(denied.json().error.code,'project_not_found');
 }
 assert.equal(f.calls.some(c=>c[0]==='fetch'),false);assert.equal(f.queries.length,0);
 assert.equal((await f.send('POST','/projects',{name:'x',v2_access_profiles:['unapproved']})).statusCode,400);
 assert.equal((await f.send('POST',`/projects/${project}/keys`,{name:'x',token:'caller-choice'})).statusCode,400);
 const keys=await f.send('GET',`/projects/${project}/keys`);assert.deepEqual(keys.json().keys[0].scopes,['fetch:read']);assert.ok(!keys.body.includes('token_hash'));
 const created=await f.send('POST',`/projects/${project}/keys`,{name:'x'});assert.match(created.json().token,/^fxk_/);assert.ok(!created.body.includes('token_hash'));
 assert.equal((await f.send('POST',`/projects/${project}/keys/${operation}/rotate`)).statusCode,415);
 const rotated=await f.send('POST',`/projects/${project}/keys/${operation}/rotate`,{});assert.equal(rotated.statusCode,200);assert.match(rotated.json().token,/^fxk_/);assert.ok(!rotated.body.includes('token_hash'));
});

test('control projects expose only HTTP routes and safe real history, usage and billing projections',async t=>{
 const f=await fixture();t.after(()=>f.app.close());
 const detail=await f.send('GET',`/projects/${project}`),data=detail.json();
 assert.equal(data.capabilities.render,false);assert.equal(data.capabilities.transports.browser,false);assert.deepEqual(data.capabilities.routes,['direct']);assert.deepEqual(data.access_profiles[0].proxy_classes,['direct']);assert.deepEqual(data.access_profiles[0].browser_probe,{enabled:false});
 const recent=await f.send('GET',`/projects/${project}/requests?limit=5`);assert.equal(recent.json().operations[0].latency_ms,400);assert.equal(recent.json().operations[0].routing.class,'direct');assert.ok(!recent.body.includes('secret'));assert.ok(!recent.body.includes('diagnostics'));
 assert.deepEqual(f.queries.at(-1).args,[project,5]);
 assert.equal((await f.send('GET',`/projects/${project}/requests?limit=51`)).statusCode,400);
 const usage=await f.send('GET',`/projects/${project}/usage`);assert.equal(usage.json().gateway.latency_ms.mean,400);assert.equal(usage.json().credits.held,1);
 assert.deepEqual((await f.send('GET',`/projects/${project}/billing`)).json(),{status:'trial',credits:{granted:10,available:9,held:1},commercial_enabled:false});
 assert.equal(recent.headers['cache-control'],'no-store');
});

test('control fetch uses trusted console identity and recovery reads retained state without redispatch',async t=>{
 const f=await fixture();t.after(()=>f.app.close());
 const submitted=await f.send('POST',`/projects/${project}/fetch`,{idempotency_key:'saved'});
 assert.equal(submitted.json().state,'unknown');assert.equal(submitted.json().retry.safe_to_retry,false);assert.equal(submitted.json().retry.lookup_url,`/api/control/projects/${project}/fetch/saved`);
 assert.deepEqual(f.calls.find(c=>c[0]==='fetch')[3],{keyId:'console'});
 await f.send('GET',`/projects/${project}/fetch/saved`);await f.send('GET',`/projects/${project}/requests/${operation}`);
 assert.equal(f.calls.filter(c=>c[0]==='fetch').length,1);assert.equal(f.calls.filter(c=>c[0]==='lookup').length,1);
 const unsupported=await f.send('POST',`/projects/${project}/fetch`,{idempotency_key:'render',render:true});assert.equal(unsupported.statusCode,409);assert.equal(unsupported.json().error.code,'capability_unsupported');assert.equal(unsupported.json().supported.render,false);
});

test('control browser routes forward only named attribution and recover typed retained operations',async t=>{
 const f=await fixture({testRender:true});t.after(()=>f.app.close());
 f.identity.keys=async()=>[{...key,scopes:['fetch:write']}];
 const body={idempotency_key:'saved',url:'https://example.com/',access_profile:{id:'synthetic',version:1},proxy:{class:'direct',country:null},screenshot:true,wait_ms:200};
 assert.equal((await f.send('POST',`/projects/${project}/render`,body,{'x-csrf-token':''})).statusCode,403);
 const submitted=await f.send('POST',`/projects/${project}/render`,{...body,key_id:key.id});
 assert.equal(submitted.statusCode,200,submitted.body);
 assert.equal(submitted.json().execution,'browser');
 assert.equal(submitted.json().retry.lookup_url,`/api/control/projects/${project}/render/saved`);
 assert.deepEqual(f.calls.find(c=>c[0]==='render'),['render',project,body,{keyId:key.id,userId:user.id,requireSoleKey:false}]);
 f.identity.keys=async()=>[];
 const recovery=await f.send('GET',`/projects/${project}/render/saved`);
 assert.equal(recovery.json().state,'unknown');
 const history=await f.send('GET',`/projects/${project}/requests/${operation}`);
 assert.equal(history.json().retry.lookup_url,`/api/control/projects/${project}/requests/${operation}`);
 assert.deepEqual(f.calls.find(c=>c[0]==='renderLookupOperation'),['renderLookupOperation',project,operation,{id:operation,execution:'browser'}]);
 assert.equal(f.calls.filter(c=>c[0]==='render').length,1);
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
