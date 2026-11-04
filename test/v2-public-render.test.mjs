import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {sha} from '../src/crypto.mjs';
import {Gateway} from '../src/gateway.mjs';
import {Store} from '../src/store.mjs';
import {server,controlKeyScope} from '../src/main.mjs';
import {controlCsrf} from '../src/control.mjs';
import {recoverV2,V2Gateway} from '../src/v2.mjs';
import {fixedFeePoolFingerprint} from '../src/v2-pricing.mjs';

test('managed Bearer scopes classify render send and original-key recovery separately',()=>{
 assert.equal(controlKeyScope('POST','/v2/render'),'fetch:write');
 assert.equal(controlKeyScope('GET','/v2/render/saved%3Akey'),'fetch:read');
 for(const [method,path] of [['GET','/v2/render'],['POST','/v2/render/saved'],['GET','/v2/render/saved/extra'],['POST','/v2/browser-probes']])assert.equal(controlKeyScope(method,path),null);
});

const datacenter={class:'datacenter',country:'US'};
const doc=Buffer.from('<main>synthetic rendered DOM</main>');
const screenshot=Buffer.from([0xff,0xd8,0xff,0xd9]);
const fixtureArtifact=(kind,url,bytes,extra={})=>({kind,url,status:200,method:'GET',raw_headers:null,
 headers:{'content-type':kind==='browser_screenshot'?'image/jpeg':'text/html; charset=utf-8'},captured_at:new Date().toISOString(),
 content_encoding:null,encoded_body_base64:null,encoded_sha256:null,encoded_bytes:null,encoded_size_basis:null,original_encoded_available:false,
 decoded_body_base64:bytes.toString('base64'),decoded_sha256:sha(bytes),decoded_bytes:bytes.length,tunnel_bytes:null,provider_status:null,decoding_error:null,...extra});

test('public and signed-in render retain one scoped operation, bounded artifacts and conservative credits',{skip:!process.env.TEST_DATABASE_URL,timeout:30_000},async t=>{
 const url=new URL(process.env.TEST_DATABASE_URL);
 assert.match(decodeURIComponent(url.pathname),/^\/gateway_test_[A-Za-z0-9_]+$/);
 const schema='render_e2e_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:url.href,max:1});
 const root=await mkdtemp(join(tmpdir(),'fetchx-render-fixture-'));
 let app,store,unblock;
 t.after(async()=>{
  unblock?.();await app?.close();await store?.close();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();await rm(root,{recursive:true,force:true});
 });
 await admin.query(`CREATE SCHEMA ${schema}`);
 url.searchParams.set('options',`-csearch_path=${schema}`);
 store=new Store(url.href);await store.init();
 const site='https://fetchx.test',bridge='synthetic-render-bridge-secret-over-32-bytes',sessionToken='fxs_'+'r'.repeat(43);
 const proxies=[{id:'fixture-us',provider:'oxylabs',pool_id:'fixture-pool',country:'US',url:'http://fixture-proxy:fixture-password@127.0.0.1:1'}];
 const staticProfile={id:'fixture-static',version:1,origins:['https://sample.example.com'],methods:['GET'],headers:[],proxy_classes:['datacenter'],countries:['US'],browser_probe:{enabled:true}};
 const controlPlane={enabled:true,origins:[site],bridgeSecret:bridge,projectTemplate:{id:'fixture-template',v2_access_profiles:['fixture-static@1'],v2_entitlement:{mode:'metered',max_daily_operations:20}},
  creditPolicy:{reviewed:true,version:'fixture-credit-v1',trialCredits:4,weights:{direct:1},maxEstimatedMicroUsdPerOperation:0,
   modeWeights:{reviewed:true,version:'fixture-mode-credit-v2',browser:{datacenter:2}}},
  playground:{enabled:true,reviewed:true,version:'fixture-playground-v1',maxProfilesPerProject:8,routes:{browser:{datacenter:['US']}}}};
 const config={release:'render-fixture',artifactDir:root,artifactKey:'6b'.repeat(32),projects:{},proxies,controlPlane,maxDailyFallbackCredits:0,v2:{accessProfiles:{'fixture-static@1':staticProfile}},
  datacenterFixedFeePool:{schema_version:2,id:'fixture-browser-pricing',reviewed:true,provider:'oxylabs',pool_id:'fixture-pool',countries:['US'],transports:['browser'],
   cost_scope:'incremental_traffic_only',fixed_subscription_allocation_micro_usd:null,provenance:{id:'fixture-evidence',sha256:'a'.repeat(64),reviewed_at:'2026-01-01T00:00:00Z'},
   pool_fingerprint_sha256:fixedFeePoolFingerprint(proxies,['US'])}};
 const gateway=new Gateway({store,config,profiles:{},resolve:async()=>[{address:'93.184.216.34',family:4}]});
 const {promise:runnerEntered,resolve:notifyRunner}=Promise.withResolvers();
 let runs=0,mode='blocked',relayOptions;
 gateway.v2=new V2Gateway(gateway,{browserRuntime:async()=>({available:true,runtime:{synthetic:true}}),
  relayFactory:async options=>{
   relayOptions=options;
   return {url:'http://127.0.0.1:1',bytes:512,meter_complete:true,connections:1,provider_status:200,close:async()=>{}};
  },browserRunner:async(input,hooks)=>{
   runs++;
   assert.equal(relayOptions.proxy.id,'fixture-us');
   const request={url:input.url,method:'GET',headers:{accept:'text/html'},body_base64:null,resource_type:'document',redirect_depth:0,redirected_from:null};
   await hooks.admit(request);
   await relayOptions.beforeConnect(relayOptions.pinnedDestinations.get(new URL(input.url).hostname).destination);
   if(mode==='blocked')await new Promise(resolve=>{unblock=resolve;notifyRunner();});
   if(mode==='unknown')throw Error('fixture interrupted after admission');
   assert.equal(input.policy.settle_ms,0);
   assert.equal(input.screenshot,true);
   await hooks.artifact(fixtureArtifact('browser_response',input.url,Buffer.from('<main>original source</main>'),{
    request,main_document:true,headers:{'content-type':'text/html; charset=utf-8','cache-control':'max-age=120','set-cookie':'sid=fixture-secret','x-private':'fixture-private'}
   }));
   await hooks.artifact(fixtureArtifact('rendered_dom',input.url,doc,{generated:true}));
   await hooks.artifact(fixtureArtifact('browser_screenshot',input.url,screenshot,{generated:true}));
   return {status:200,final_url:input.url,capture_complete:true,counts_complete:true};
  }});
 app=server(gateway);
 const user=randomUUID(),foreignUser=randomUUID();
 await store.pool.query('INSERT INTO control_users(id,email) VALUES($1,$2),($3,$4)',[user,'owner@fixture.test',foreignUser,'other@fixture.test']);
 await store.pool.query("INSERT INTO control_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",[randomUUID(),user,sha(sessionToken)]);
 const identity=gateway.controlIdentity,project=(await identity.createProject(user,{name:'Render owner'})).id,foreign=(await identity.createProject(foreignUser,{name:'Other tenant'})).id;
 const writer=await identity.createKey(user,project,{name:'Writer',scopes:['fetch:write','fetch:read']}),reader=await identity.createKey(user,project,{name:'Reader',scopes:['fetch:read']});
 const other=await identity.createKey(foreignUser,foreign,{name:'Other writer',scopes:['fetch:read','fetch:write']});
 const native=(method,path,payload,token)=>app.inject({method,url:path,...(token?{headers:{authorization:'Bearer '+token}}:{}),...(payload===undefined?{}:{payload})});
 const signed=(method,path,payload)=>app.inject({method,url:`/control/projects/${project}${path}`,headers:{origin:site,'x-fetchx-control-secret':bridge,cookie:`fetchx_session=${sessionToken}`,'x-csrf-token':controlCsrf(sessionToken,bridge)},...(payload===undefined?{}:{payload})});
 const source='https://sample.example.com/page?synthetic=1';
 const prepare=await signed('POST','/playground/prepare',{execution:'browser',proxy:datacenter,url:source});
 assert.equal(prepare.statusCode,200,prepare.body);
 const prepared=prepare.json();assert.equal(prepared.ready,true,prepare.body);assert.deepEqual(prepared.quote,{credits:2,max_estimated_micro_usd:0});
 assert.equal(prepared.selected_key_id,writer.id);
 assert.equal(runs,0);
 const body={idempotency_key:'render:fixture',url:prepared.url,access_profile:prepared.access_profile,proxy:datacenter,max_estimated_micro_usd:0,wait_ms:0,screenshot:true};
 const keyPath='/v2/render/'+encodeURIComponent(body.idempotency_key);
 assert.equal((await native('POST','/v2/render',body)).json().error.code,'unauthorized');
 assert.equal((await native('POST','/v2/render',body,reader.token)).json().error.code,'api_key_scope_forbidden');
 assert.equal((await native('POST','/v2/render',{...body,method:'POST'},writer.token)).json().error.code,'browser_probe_invalid');
 assert.equal((await native('POST','/v2/render',{...body,idempotency_key:'static-browser',access_profile:{id:staticProfile.id,version:1}},writer.token)).json().error.code,'access_profile_forbidden');
 const pending=signed('POST','/render',{...body,key_id:writer.id});
 await Promise.race([runnerEntered,pending.then(reply=>assert.fail(reply.body))]);
 const duplicate=await native('POST','/v2/render',body,writer.token);
 assert.equal(duplicate.statusCode,200,duplicate.body);assert.equal(duplicate.json().state,'running');assert.equal(duplicate.json().retry.safe_to_retry,false);
 const changed=await native('POST','/v2/render',{...body,wait_ms:1},writer.token);
 assert.equal(changed.statusCode,409,changed.body);assert.equal(changed.json().error.code,'idempotency_conflict');
 unblock();
 const completed=await pending;assert.equal(completed.statusCode,200,completed.body);
 const result=completed.json();assert.equal(result.success,true,completed.body);assert.equal(result.execution,'browser');assert.equal(result.application_acceptance,'not_evaluated');
 assert.equal(result.operation_id,duplicate.json().operation_id);assert.equal(runs,1);
 assert.deepEqual(result.routing,{...datacenter,provider:'configured_datacenter'});
 assert.equal(result.data.status,200);assert.equal(result.data.text,doc.toString());assert.equal(result.data.body_base64,doc.toString('base64'));
 assert.deepEqual(result.data.headers,{'content-type':'text/html; charset=utf-8','cache-control':'max-age=120'});
 assert.equal(result.artifacts.find(a=>a.kind==='browser_screenshot').body_base64,screenshot.toString('base64'));
 assert.equal(result.artifacts.find(a=>a.kind==='browser_response').body_base64,undefined);
 for(const secret of ['fixture-secret','fixture-private','fixture-password','fixture-evidence'])assert.ok(!completed.body.includes(secret),secret);
 assert.equal(result.usage.accounting.request_credits.key_id,writer.id);assert.equal(result.usage.accounting.request_credits.state,'settled');
 assert.equal((await native('GET',keyPath,undefined,reader.token)).json().operation_id,result.operation_id);
 assert.equal((await native('GET',keyPath,undefined,other.token)).statusCode,404);
 assert.equal((await native('GET','/v2/fetch/operations/'+result.operation_id,undefined,reader.token)).statusCode,409);
 const history=(await signed('GET','/requests')).json();assert.equal(history.operations[0].execution,'browser');assert.equal(history.operations[0].key_id,writer.id);
 const byId=(await signed('GET','/requests/'+result.operation_id)).json();assert.equal(byId.data.text,result.data.text);assert.equal(byId.retry.same_key_replay_safe,false);
 assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM v2_sessions WHERE project=$1',[project])).rows[0].n,1);

 mode='unknown';
 const uncertainBody={...body,idempotency_key:'uncertain'},uncertain=await native('POST','/v2/render',uncertainBody,writer.token);
 assert.equal(uncertain.json().state,'unknown',uncertain.body);assert.equal(uncertain.json().usage.accounting.request_credits.state,'held');
 await recoverV2(store.pool);
 assert.deepEqual((await native('GET','/v2/render/uncertain',undefined,reader.token)).json(),uncertain.json());
 assert.deepEqual((await native('POST','/v2/render',uncertainBody,writer.token)).json(),uncertain.json());
 assert.equal(runs,2);
 const deniedPrepare=(await signed('POST','/playground/prepare',{execution:'browser',proxy:datacenter,url:'https://another.example.com/'})).json();
 assert.equal(deniedPrepare.ready,false);assert.equal(deniedPrepare.errors[0].code,'credit_balance_exhausted');
 const denied=await native('POST','/v2/render',{...body,idempotency_key:'balance-failure',url:deniedPrepare.url,access_profile:deniedPrepare.access_profile},writer.token);
 assert.equal(denied.statusCode,429,denied.body);assert.equal(denied.json().error.code,'credit_balance_exhausted');assert.equal(denied.json().state,'rejected');
 assert.equal((await native('GET','/v2/render/balance-failure',undefined,reader.token)).statusCode,404);
 assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM v2_operations WHERE project=$1',[project])).rows[0].n,2);
 assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM control_credit_reservations WHERE project=$1',[project])).rows[0].n,2);
 assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM control_playground_profiles WHERE project=$1',[project])).rows[0].n,1);
 assert.equal(runs,2);
 controlPlane.playground={enabled:false};
 assert.equal((await native('GET',keyPath,undefined,reader.token)).json().operation_id,result.operation_id);
 assert.equal((await native('POST','/v2/render',body,writer.token)).json().operation_id,result.operation_id);
 assert.equal(runs,2);
});
