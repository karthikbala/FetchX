import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.mjs';
import {Gateway} from '../src/gateway.mjs';
import {initRouteHealth,chooseHealthyProxy,recordRouteOutcome,routeHealthStatus,validateRouteHealthConfig} from '../src/route-health.mjs';

const enabled=!!process.env.TEST_DATABASE_URL;
const request={method:'GET',main_document:true,headers:{}};
const response=(status=200,extra={})=>({provider:'oxylabs',status,headers:{},body:Buffer.from('fixture'),error:null,...extra});

test('route health configuration is strictly bounded before admission or settlement',()=>{
 assert.deepEqual(validateRouteHealthConfig({}),{failureThreshold:3,cooldownMs:300000,probeIntervalMs:30000});
 assert.deepEqual(validateRouteHealthConfig({routeHealth:{failureThreshold:5}}),{failureThreshold:5,cooldownMs:300000,probeIntervalMs:30000});
 assert.ok(Object.isFrozen(validateRouteHealthConfig({})));
 const invalid=[null,[],false,3,'automatic',{unknown:true},{failureThreshold:0},{failureThreshold:101},{failureThreshold:1.5},{failureThreshold:'3'},
  {failureThreshold:NaN},{failureThreshold:Infinity},{cooldownMs:999},{cooldownMs:86400001},{probeIntervalMs:999},{probeIntervalMs:3600001},
  {probeIntervalMs:300000,cooldownMs:60000},{cooldownMs:Number.MAX_SAFE_INTEGER+1},{failureThreshold:undefined}];
 for(const routeHealth of invalid){
  assert.throws(()=>validateRouteHealthConfig({routeHealth}),error=>error.code==='route_health_config_invalid'&&error.status===500);
  let writes=0;
  assert.throws(()=>new Gateway({store:{tx(){writes++;}},config:{artifactKey:'11'.repeat(32),maxDailyFallbackCredits:0,projects:{a:{profiles:[]}},routeHealth},profiles:{}}),/route_health_config_invalid/);
  assert.equal(writes,0,'startup rejection cannot write or dispatch an operation');
 }
});
async function fixture(run){
 const url=new URL(process.env.TEST_DATABASE_URL);
 assert.match(url.pathname,/^\/(?:gateway_conformance|gateway_test)(?:_[A-Za-z0-9]+)?$/,'route health tests require a disposable gateway database');
 const admin=new Store(url.href),schema='health_'+randomUUID().replaceAll('-','');
 await admin.pool.query('CREATE SCHEMA '+schema);url.searchParams.set('options','-c search_path='+schema);
 const store=new Store(url.href);
 const proxies=[{id:'in-a',country:'IN',url:'https://private-a:secret-a@proxy-a.invalid'},{id:'in-b',country:'IN',url:'https://private-b:secret-b@proxy-b.invalid'}];
 const config={release:'health-test',artifactKey:'11'.repeat(32),maxDailyFallbackCredits:16,proxies,projects:{a:{profiles:['source.a']},b:{profiles:['source.b']}}};
 const record=(proxyId,reply,workflowId=randomUUID(),input=request,profile='source.a')=>store.tx(c=>recordRouteOutcome(c,{profile,proxyId,workflowId,response:reply,input,config}));
 const choose=(cursor=1,profile='source.a',eligible=proxies)=>store.tx(c=>chooseHealthyProxy(c,{profile,eligible,cursor,config}));
 const rows=()=>store.pool.query('SELECT * FROM route_health ORDER BY profile,proxy_id').then(result=>result.rows);
 try{await store.init();await initRouteHealth(store.pool);await run({store,url,config,proxies,record,choose,rows});}
 finally{await store.close();await admin.pool.query('DROP SCHEMA '+schema+' CASCADE');await admin.close();}
}

test('healthy selection round robins immutable proxy copies and isolates profile health',{skip:!enabled},async()=>fixture(async({config,proxies,record,choose})=>{
 assert.deepEqual(await choose(1),{...proxies[0],selectionReason:'healthy_proxy_selected'});
 assert.deepEqual(await choose(2),{...proxies[1],selectionReason:'healthy_proxy_selected'});
 for(let i=0;i<3;i++)await record('in-a',response(403));
 for(let i=1;i<5;i++)assert.equal((await choose(i)).id,'in-b');
 assert.equal((await choose(1,'source.b')).id,'in-a','another source profile has independent route health');
 assert.equal(config.proxies[0].selectionReason,undefined);
}));

test('quarantine requires three distinct failing workflows and asset successes cannot erase failure',{skip:!enabled},async()=>fixture(async({record,rows,choose})=>{
 const workflow=randomUUID();
 for(let i=0;i<4;i++)await record('in-a',response(null,{error:'proxy_connect_failed'}),workflow,{resource_type:'script'});
 assert.equal((await rows())[0].consecutive_failed_workflows,1);
 await record('in-a',response(200),workflow,{resource_type:'script'});
 await record('in-a',response(200),workflow,request);
 assert.equal((await rows())[0].consecutive_failed_workflows,1);
 await record('in-a',response(403));
 assert.equal((await rows())[0].quarantined_until,null);
 await record('in-a',response(403));
 const route=(await rows())[0];
 assert.equal(route.consecutive_failed_workflows,3);
 assert.ok(+route.quarantined_until>Date.now()+290000);
 assert.equal((await choose()).id,'in-b');
}));

test('independent success recovers a quarantined route and survives store reconnect',{skip:!enabled},async()=>fixture(async({store,url,config,record,choose})=>{
 for(let i=0;i<3;i++)await record('in-a',response(403));
 const reopened=new Store(url.href);
 try{
  await initRouteHealth(reopened.pool);
  const persisted=await reopened.tx(c=>chooseHealthyProxy(c,{profile:'source.a',eligible:config.proxies,cursor:1,config}));
  assert.equal(persisted.id,'in-b');
  await reopened.tx(c=>recordRouteOutcome(c,{profile:'source.a',proxyId:'in-a',workflowId:randomUUID(),response:response(),input:request,config}));
 }finally{await reopened.close();}
 assert.equal((await choose()).id,'in-a');
 const row=(await store.pool.query("SELECT * FROM route_health WHERE profile='source.a' AND proxy_id='in-a'")).rows[0];
 assert.equal(row.consecutive_failed_workflows,0);assert.equal(row.quarantined_until,null);assert.equal(row.next_probe_at,null);
}));

test('rate limits, authentication, TLS, local errors, paid billing and denied assets do not poison proxy health',{skip:!enabled},async()=>fixture(async({record,rows})=>{
 const ignored=[
  [response(429)],
  [response(403,{headers:{'retry-after':'120'}})],
  [response(200,{headers:{'Retry-After':'120'}})],
  [response(401)], [response(407)],
  [response(403),{...request,headers:{Authorization:'Bearer private-source-token'}}],
  ...['tls_verification_failed','transport_unavailable','transport_request_invalid','transport_failed','transport_protocol_error','source_body_incomplete','response_too_large','sensitive_provider_response'].map(error=>[response(null,{error})]),
  [response(403,{provider:'scrapedo'})],
  [response(null,{provider:'scrapedo',error:'metered_outcome_unknown'})],
  [response(503)],
  [response(403),{resource_type:'image'}],
  [response(200),{resource_type:'script'}],
 ];
 for(const [reply,input=request] of ignored)await record('in-a',reply,randomUUID(),input);
 assert.deepEqual(await rows(),[]);
 await record('in-a',response(403));
 const before=(await rows())[0];
 for(const [reply,input=request] of ignored)await record('in-a',reply,randomUUID(),input);
 assert.deepEqual((await rows())[0],before,'ignored outcomes neither penalize nor recover a route');
}));

test('HTML challenges count as failures for documents and API requests but not assets',{skip:!enabled},async()=>fixture(async({record,rows})=>{
 const challenge=response(200,{headers:{'content-type':'text/html'},body:Buffer.from('<title>Robot Check</title>')});
 await record('in-a',challenge);
 await record('in-a',challenge,randomUUID(),{resource_type:'fetch'});
 await record('in-a',challenge,randomUUID(),{resource_type:'script'});
 assert.equal((await rows())[0].consecutive_failed_workflows,2);
 assert.equal((await rows())[0].last_failure,'source_challenge');
}));

test('all-quarantined pools admit one durable least-bad probe across concurrent selections',{skip:!enabled},async()=>fixture(async({store,url,config,record,choose})=>{
 for(const id of ['in-a','in-b'])for(let i=0;i<3;i++)await record(id,response(403));
 await record('in-b',response(403));
 await assert.rejects(choose(),error=>error.code==='health_pool_cooling'&&error.status===503);
 await store.pool.query("UPDATE route_health SET next_probe_at=now()-interval '1 second'");
 assert.equal((await routeHealthStatus(store.pool,'a',config)).profiles[0].probe_due,2);
 const attempts=await Promise.allSettled([choose(1),choose(2),choose(3)]);
 const success=attempts.filter(result=>result.status==='fulfilled');
 assert.equal(success.length,1);assert.equal(success[0].value.id,'in-a');assert.equal(success[0].value.selectionReason,'quarantine_probe');
 assert.ok(attempts.filter(result=>result.status==='rejected').every(result=>result.reason.code==='health_pool_cooling'));
 assert.equal((await routeHealthStatus(store.pool,'a',config)).profiles[0].probe_due,0,'shared pool cooldown prevents another IP probe');
 const reopened=new Store(url.href);
 try{await assert.rejects(reopened.tx(c=>chooseHealthyProxy(c,{profile:'source.a',eligible:config.proxies,cursor:1,config})),/health_pool_cooling/);}
 finally{await reopened.close();}
 await store.pool.query("UPDATE route_health_pools SET next_probe_at=now()-interval '1 second'");
 await store.pool.query("UPDATE route_health SET next_probe_at=now()-interval '1 second'");
 assert.equal((await choose()).selectionReason,'quarantine_probe');
}));

test('expired quarantines are probed gradually alongside healthy routes',{skip:!enabled},async()=>fixture(async({store,config,record,choose})=>{
 for(let i=0;i<3;i++)await record('in-a',response(403));
 await choose(1);
 await store.pool.query("UPDATE route_health SET next_probe_at=now()-interval '1 second'");
 assert.equal((await routeHealthStatus(store.pool,'a',config)).profiles[0].probe_due,0,'healthy alternative keeps a route quarantined until its cooldown expires');
 await store.pool.query("UPDATE route_health SET quarantined_until=now()-interval '1 second',next_probe_at=now()-interval '1 second'");
 assert.equal((await routeHealthStatus(store.pool,'a',config)).profiles[0].probe_due,1);
 assert.equal((await choose(2)).selectionReason,'quarantine_probe');
 const subsequent=await choose(2);assert.equal(subsequent.id,'in-b');assert.equal(subsequent.selectionReason,'healthy_proxy_selected');
}));

test('project health status exposes allowed-profile aggregates without route credentials or other identities',{skip:!enabled},async()=>fixture(async({store,config,record,choose})=>{
 await choose(1);await choose(1,'source.b');
 await record('in-a',response(403));
 for(let i=0;i<3;i++)await record('in-b',response(403),randomUUID(),request,'source.b');
 const scoped=await routeHealthStatus(store.pool,'a',config);
 assert.deepEqual(scoped.profiles.map(row=>row.profile),['source.a']);
 assert.equal(scoped.signal_scope,'transport_only');assert.equal(scoped.profiles[0].unobserved,1);assert.equal(scoped.profiles[0].healthy,0);assert.equal(scoped.profiles[0].degraded,1);assert.equal(scoped.profiles[0].quarantined,0);
 const encoded=JSON.stringify(scoped);
 for(const forbidden of ['source.b','in-a','in-b','secret-a','secret-b','proxy-a.invalid','workflow','project'])assert.equal(encoded.includes(forbidden),false);
 assert.equal((await routeHealthStatus(store.pool,null,config)).profiles.length,2);
 await assert.rejects(routeHealthStatus(store.pool,'unknown',config),error=>error.code==='project_forbidden'&&error.status===403);
}));

test('operational health status excludes removed proxies and retired profile assignments without deleting history',{skip:!enabled},async()=>fixture(async({store,config,record,choose})=>{
 await choose();await choose(1,'source.b');
 for(let i=0;i<3;i++)await record('in-a',response(403));
 const updated={...config,proxies:config.proxies.filter(proxy=>proxy.id!=='in-a'),projects:{a:config.projects.a}};
 const report=await routeHealthStatus(store.pool,null,updated);
 assert.deepEqual(report.profiles.map(row=>row.profile),['source.a']);
 assert.equal(report.profiles[0].routes,1);assert.equal(report.profiles[0].quarantined,0);
 assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM route_health')).rows[0].n,4,'operational filtering must preserve routing history');
}));

test('workflow reuse retains its original sticky proxy when future workflows avoid that route',{skip:!enabled},async()=>fixture(async({store,config,record})=>{
 const profile={country:'IN',maxRequests:20,maxBytes:10000,ttlSeconds:120};
 const gateway=new Gateway({store,config,profiles:{'source.a':profile}});
 const original=await gateway.workflow('a',{profile:'source.a',idempotency_key:'sticky-original'});
 const before=(await store.pool.query('SELECT * FROM workflows WHERE id=$1',[original.id])).rows[0];
 for(let i=0;i<3;i++)await record(before.proxy_id,response(403));
 const reused=await gateway.workflow('a',{profile:'source.a',idempotency_key:'sticky-original'});
 assert.equal(reused.id,original.id);
 const after=(await store.pool.query('SELECT * FROM workflows WHERE id=$1',[original.id])).rows[0];
 assert.equal(after.proxy_id,before.proxy_id);assert.equal(after.config.providerSession,before.config.providerSession);
 const newer=await gateway.workflow('a',{profile:'source.a',idempotency_key:'new-workflow'});
 const assigned=(await store.pool.query('SELECT * FROM workflows WHERE id=$1',[newer.id])).rows[0];
 assert.notEqual(assigned.proxy_id,before.proxy_id);
}));
