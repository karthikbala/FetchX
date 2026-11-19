import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {connectApiBase} from '../src/control-connect.mjs';
import {Store} from '../src/store.mjs';
import {createGateway,server} from '../src/server.mjs';

const ORIGIN='http://127.0.0.1:4434';
const API='http://127.0.0.1:8789';
const SCOPES=['fetch:read','fetch:write','usage:read'];
const sha256=value=>createHash('sha256').update(value,'utf8');
const deriveKey=code=>'fxk_'+sha256('fetchx-connect-key-v1\0'+code).digest('base64url');

test('Connect requires explicit enablement and canonical HTTPS origins, with an explicit loopback exception',()=>{
 const origin='https://fetchx.example',api='https://api.fetchx.example';
 const config={enabled:true,agentConnectEnabled:true,origins:[origin],apiBaseUrl:api+'/'};
 assert.equal(connectApiBase(config,origin),api);
 assert.equal(connectApiBase({...config,agentConnectEnabled:false},origin),null);
 assert.equal(connectApiBase({...config,agentConnectEnabled:'true'},origin),null);
 assert.equal(connectApiBase({...config,enabled:false},origin),null);
 assert.equal(connectApiBase(config,'https://other.example'),null);
 for(const value of [undefined,'not-a-url',api+'/v2',api+'?',api+'#','http://api.fetchx.example','https://user@api.fetchx.example','https://127.0.0.1:8789',API])assert.equal(connectApiBase({...config,apiBaseUrl:value},origin),null,value);
 const development={...config,origins:[ORIGIN],apiBaseUrl:API};
 assert.equal(connectApiBase(development,ORIGIN),null);
 assert.equal(connectApiBase({...development,allowLoopbackDevelopment:true},ORIGIN),API);
 assert.equal(connectApiBase({...config,allowLoopbackDevelopment:true,apiBaseUrl:API},origin),null);
});

test('Connect requires account approval, issues once under concurrency, and honors key revocation',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const url=new URL(process.env.TEST_DATABASE_URL);
 assert.ok(['postgres:','postgresql:'].includes(url.protocol));
 assert.match(decodeURIComponent(url.pathname),/^\/gateway_test_[A-Za-z0-9_]+$/,'explicit disposable gateway_test_* database required');
 const schema='control_connect_'+randomUUID().replaceAll('-','');
 const admin=new pg.Pool({connectionString:url.href,max:1});
 let store,app;
 t.after(async()=>{try{await app?.close();await store?.close();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);}finally{await admin.end();}});
 await admin.query(`CREATE SCHEMA ${schema}`);
 url.searchParams.set('options',`-csearch_path=${schema}`);
 store=new Store(url.href);await store.init();
 assert.equal((await store.pool.query('SELECT current_schema() AS name')).rows[0].name,schema);
 const otherOrigin='http://127.0.0.1:4435';
 const controlPlane={enabled:true,origins:[ORIGIN,otherOrigin],bridgeSecret:randomBytes(32).toString('hex'),sessionSecure:false,allowLoopbackDevelopment:true,apiBaseUrl:API,
  projectTemplate:{id:'connect-test',v2_access_profiles:[],v2_entitlement:{mode:'metered',max_daily_operations:50}},
  creditPolicy:{reviewed:true,version:'connect-test',trialCredits:10,weights:{direct:1},maxEstimatedMicroUsdPerOperation:0}};
 const config={artifactKey:randomBytes(32).toString('hex'),projects:{},proxies:[],v2:{accessProfiles:{}},controlPlane};
 const gateway=createGateway({store,config,deps:{runtime:null,browserPool:null}});
 app=server(gateway);
 const identity=gateway.controlIdentity;
 const bridge={origin:ORIGIN,'x-fetchx-control-secret':controlPlane.bridgeSecret};
 const request=async(path,payload,actor,headers={})=>{
  const response=await app.inject({method:payload===undefined?'GET':'POST',url:'/control'+path,headers:{...bridge,...actor?.headers,...headers},...(payload===undefined?{}:{payload})});
  assert.equal(response.headers['cache-control'],'no-store');
  return {status:response.statusCode,body:response.json(),headers:response.headers};
 };
 const error=async(promise,status,code)=>{const result=await promise;assert.equal(result.status,status,JSON.stringify(result.body));assert.equal(result.body.error.code,code);return result;};
 const start=async()=>{const result=await request('/connect/start',{client_name:'Synthetic agent'});assert.equal(result.status,200);return result.body;};
 const approve=(flow,actor,project_id,more={})=>request('/connect/decision',{request_id:flow.request_id,user_code:flow.user_code,decision:'approve',project_id,...more},actor);
 const claim=(flow,more={},headers={})=>request('/connect/claim',{request_id:flow.request_id,device_code:flow.device_code,...more},null,headers);
 const review=(flow,actor)=>request('/connect/review',{request_id:flow.request_id},actor);
 const native=(url,token)=>app.inject({method:'GET',url,headers:{authorization:'Bearer '+token}});
 const count=async project=>Number((await store.pool.query('SELECT count(*) FROM control_keys WHERE project=$1 AND revoked_at IS NULL',[project])).rows[0].count);
 const expire=flow=>store.pool.query("UPDATE control_connect_requests SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[flow.request_id]);
 async function actor(label){
  const mailbox=[];identity.mail={configured:true,sendCode:async mail=>mailbox.push(mail)};
  const email=`${label}@example.com`;
  assert.equal((await request('/auth/code',{email})).status,200);
  const verified=await request('/auth/verify',{email,challenge_id:mailbox[0].challenge_id,code:mailbox[0].code});
  assert.equal(verified.status,200);
  return {id:verified.body.user.id,headers:{cookie:verified.headers['set-cookie'].split(';')[0],'x-csrf-token':verified.body.csrf_token}};
 }

 assert.equal((await request('/status')).body.connect_enabled,undefined);
 await error(request('/connect/start',{client_name:'Synthetic agent'}),503,'connect_disabled');
 controlPlane.agentConnectEnabled=true;controlPlane.apiBaseUrl='https://user@api.fetchx.example';
 assert.equal((await request('/status')).body.connect_enabled,undefined);
 await error(request('/connect/start',{client_name:'Synthetic agent'}),503,'connect_disabled');
 controlPlane.apiBaseUrl=API;
 assert.equal((await request('/status')).body.connect_enabled,true);
 await error(request('/connect/start',{client_name:'Synthetic agent'},null,{'x-fetchx-control-secret':'invalid'}),403,'bridge_rejected');
 await error(request('/connect/start',{client_name:'Synthetic agent'},null,{origin:'https://foreign.example'}),403,'origin_rejected');

 const owner=await actor('owner'),stranger=await actor('stranger');
 const project=await identity.createProject(owner.id,{name:'Agent project'});
 const flow=await start(),token=deriveKey(flow.device_code);
 assert.deepEqual(Object.keys(flow).sort(),['device_code','expires_in','interval','request_id','user_code','verification_uri']);
 assert.match(flow.request_id,/^[0-9a-f-]{36}$/);assert.match(flow.device_code,/^[A-Za-z0-9_-]{43}$/);assert.match(flow.user_code,/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
 assert.equal(flow.verification_uri,`${ORIGIN}/connect#${flow.request_id}`);assert.equal(flow.expires_in,600);assert.equal(flow.interval,5);
 const stored=(await store.pool.query('SELECT * FROM control_connect_requests WHERE id=$1',[flow.request_id])).rows[0];
 assert.equal(stored.device_hash,sha256(flow.device_code).digest('hex'));
 assert.notEqual(stored.user_code_hash,sha256(flow.user_code).digest('hex'));
 for(const secret of [flow.device_code,flow.user_code,token])assert.ok(!JSON.stringify(stored).includes(secret));
 await error(review(flow,null),401,'unauthorized');
 await error(review(flow,{headers:{...owner.headers,'x-csrf-token':stranger.headers['x-csrf-token']}}),403,'csrf_rejected');
 const pending=await review(flow,owner);
 assert.deepEqual(pending.body,{state:'pending',client_name:'Synthetic agent',scopes:SCOPES,expires_at:stored.expires_at.toISOString()});
 const wrongProof=await error(claim(flow,{device_code:'X'.repeat(43)}),404,'connect_not_found');
 assert.deepEqual((await error(claim(flow,{request_id:'bad',device_code:''}),404,'connect_not_found')).body,wrongProof.body);
 assert.deepEqual((await error(claim(flow,{}, {origin:otherOrigin}),404,'connect_not_found')).body,wrongProof.body);
 assert.deepEqual((await claim(flow)).body,{state:'pending'});
 assert.equal((await error(claim(flow),429,'connect_slow_down')).headers['retry-after'],'5');
 await error(approve(flow,stranger,project.id),404,'project_not_found');
 const wrongCode=flow.user_code==='XXXX-XXXX'?'YYYY-YYYY':'XXXX-XXXX';
 await error(approve(flow,owner,project.id,{user_code:wrongCode}),400,'connect_code_invalid');
 assert.deepEqual((await approve(flow,owner,project.id)).body,{state:'approved'});
 await error(approve(flow,owner,project.id,{user_code:wrongCode}),400,'connect_code_invalid');
 assert.deepEqual((await approve(flow,owner,project.id)).body,{state:'approved'});
 await error(review(flow,stranger),404,'connect_not_found');
 assert.equal((await review(flow,owner)).body.state,'approved');
 assert.equal(await count(project.id),0);
 assert.equal((await native('/v1/fetch',token)).statusCode,401);
 const receipts=await Promise.all(Array.from({length:8},()=>claim(flow)));
 const receipt=receipts[0].body;
 assert.match(receipt.key_id,/^[0-9a-f-]{36}$/);
 assert.deepEqual(receipt,{state:'connected',project_id:project.id,key_id:receipt.key_id,api_base_url:API});
 for(const result of receipts){assert.equal(result.status,200);assert.deepEqual(result.body,receipt);}
 assert.deepEqual((await claim(flow)).body,receipt);
 assert.equal(await count(project.id),1);
 assert.equal((await review(flow,owner)).body.state,'connected');
 const persisted=(await store.pool.query('SELECT token_hash,scopes FROM control_keys WHERE id=$1',[receipt.key_id])).rows[0];
 assert.deepEqual(persisted,{token_hash:sha256(token).digest('hex'),scopes:SCOPES});
 assert.equal(await identity.isCredential(token),true);
 assert.equal((await native('/v1/fetch',token)).statusCode,200);
 assert.equal((await native('/v1/usage',token)).statusCode,200);
 const rotated=await identity.rotateKey(owner.id,project.id,receipt.key_id);
 assert.deepEqual((await claim(flow)).body,{state:'denied'});
 assert.equal((await native('/v1/fetch',token)).statusCode,401);
 assert.equal((await native('/v1/fetch',rotated.token)).statusCode,200);
 await identity.revokeKey(owner.id,project.id,rotated.id);
 assert.equal((await native('/v1/fetch',rotated.token)).statusCode,401);

 await t.test('expired, denied, and exhausted user-code requests cannot issue a key',async()=>{
  const expired=await start();await approve(expired,owner,project.id);await expire(expired);
  assert.equal((await review(expired,owner)).body.state,'expired');
  assert.deepEqual((await claim(expired)).body,{state:'expired'});
  await error(approve(expired,owner,project.id),409,'connect_request_closed');
  const denied=await start();
  const deny=()=>request('/connect/decision',{request_id:denied.request_id,user_code:denied.user_code,decision:'deny'},owner);
  assert.deepEqual((await deny()).body,{state:'denied'});
  assert.deepEqual((await deny()).body,{state:'denied'});
  assert.deepEqual((await claim(denied)).body,{state:'denied'});
  const exhausted=await start(),bad=exhausted.user_code==='ZZZZ-ZZZZ'?'AAAA-AAAA':'ZZZZ-ZZZZ';
  for(let attempt=0;attempt<5;attempt++)await error(approve(exhausted,owner,project.id,{user_code:bad}),400,'connect_code_invalid');
  await error(approve(exhausted,owner,project.id),400,'connect_code_invalid');
  assert.deepEqual((await claim(exhausted)).body,{state:'denied'});
  assert.equal(await count(project.id),0);
 });

 await t.test('claim rechecks project membership and competes with regular keys for the same limit',async()=>{
  const lost=await start();assert.equal((await approve(lost,owner,project.id)).body.state,'approved');
  await store.pool.query('DELETE FROM control_memberships WHERE user_id=$1 AND project=$2',[owner.id,project.id]);
  assert.deepEqual((await claim(lost)).body,{state:'denied'});
  assert.equal(await count(project.id),0);
  await store.pool.query('INSERT INTO control_memberships(user_id,project) VALUES($1,$2)',[owner.id,project.id]);
  for(let n=0;n<19;n++)await identity.createKey(owner.id,project.id,{name:'Manual key',scopes:['usage:read']});
  const competing=await start();assert.equal((await approve(competing,owner,project.id)).body.state,'approved');
  const [redemption,manual]=await Promise.allSettled([claim(competing),identity.createKey(owner.id,project.id,{name:'Manual key',scopes:['usage:read']})]);
  assert.equal(redemption.status,'fulfilled');assert.equal(redemption.value.status,200);
  if(manual.status==='fulfilled')assert.deepEqual(redemption.value.body,{state:'denied'});
  else{assert.equal(manual.reason.code,'key_limit');assert.equal(redemption.value.body.state,'connected');}
  assert.equal(await count(project.id),20);
  await error(approve(await start(),owner,project.id),429,'key_limit');
 });

 await t.test('new requests reap a bounded batch of old challenges',async()=>{
  const old=Array.from({length:70},()=>randomUUID());
  await store.pool.query(`INSERT INTO control_connect_requests(id,origin,client_name,device_hash,user_code_hash,expires_at)
   SELECT id,$2,'Synthetic expired row',repeat('a',64),repeat('b',64),clock_timestamp()-interval '2 days' FROM unnest($1::uuid[]) AS id`,[old,ORIGIN]);
  const remaining=async()=>Number((await store.pool.query('SELECT count(*) FROM control_connect_requests WHERE id=ANY($1::uuid[])',[old])).rows[0].count);
  await start();assert.equal(await remaining(),6);
  await start();assert.equal(await remaining(),0);
  assert.equal((await review(flow,owner)).body.state,'connected');
 });
});
