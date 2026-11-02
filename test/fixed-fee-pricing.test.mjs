import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {Gateway} from '../src/gateway.mjs';
import {V2Gateway} from '../src/v2.mjs';
import {server} from '../src/main.mjs';
import {sha} from '../src/crypto.mjs';
import {GatewayError} from '../src/policy.mjs';
import {datacenterPoolFingerprint,fixedFeePoolFingerprint,estimateRoutePricing} from '../src/v2-pricing.mjs';

const epoch=Date.parse('2026-11-01T10:00:00Z');
function fixture(root){
 const profile={id:'source',version:1,origins:['https://source.example'],paths:['^/data','^/redirect','^/final'],methods:['GET'],headers:['accept'],proxy_classes:['direct','datacenter','residential'],countries:['US','IN'],limits:{max_requests:1000,max_encoded_bytes:4096,max_decoded_bytes:16384,max_session_encoded_bytes:1000000,max_input_bytes:1024,max_tunnel_bytes:8192,max_redirects:1,max_expansion_ratio:100,timeout_ms:2000,min_interval_ms:0,ttl_seconds:900},browser_probe:{enabled:true,max_requests:4,max_network_bytes:8192,max_decoded_bytes:8192,max_dom_bytes:1024,settle_ms:0}};
 const config={release:'synthetic-fixed-fee',artifactDir:root,artifactKey:'32'.repeat(32),maxDailyFallbackCredits:10,scrapeDoToken:'synthetic-paid-token',projects:{a:{keyId:'key-a',tokenHash:sha('synthetic-a'),profiles:['native'],v2_access_profiles:['source@1','other@2'],v2_entitlement:{mode:'unmetered'}},b:{keyId:'key-b',tokenHash:sha('synthetic-b'),profiles:['native'],v2_access_profiles:['source@1']}},proxies:[{id:'dc-us-a',country:'US',provider:'oxylabs',pool_id:'assigned-pool',url:'http://fixture-user:fixture-secret@proxy-a.example:8080'},{id:'dc-us-b',country:'US',provider:'oxylabs',pool_id:'assigned-pool',url:'http://fixture-user:fixture-secret@proxy-b.example:8080'},{id:'dc-in-a',country:'IN',provider:'oxylabs',pool_id:'assigned-pool',url:'http://fixture-user:fixture-secret@proxy-in.example:8080'}],v2:{accessProfiles:{'source@1':profile,'other@2':{...structuredClone(profile),id:'other',version:2}},dns:{allowed_hosts:['source.example'],fallback_resolvers:[{id:'synthetic-resolver',endpoint:'https://resolver.example/resolve'}],use_session_proxy:true}},residential:{maxTotalBytes:1e8,maxDailyBytes:1e8,providers:{evomi:{enabled:true,username:'fixture-vendor',password:'fixture-password',countries:['US','IN'],maxTotalBytes:1e8,microUsdPerGB:1e6}}}};
 config.datacenterFixedFeePool={schema_version:1,id:'assigned-fixed-fee',reviewed:true,provider:'oxylabs',pool_id:'assigned-pool',countries:['US','IN'],cost_scope:'incremental_traffic_only',fixed_subscription_allocation_micro_usd:null,provenance:{id:'private-authority',sha256:'a'.repeat(64),reviewed_at:new Date(epoch-60000).toISOString()},pool_fingerprint_sha256:fixedFeePoolFingerprint(config.proxies,['US','IN'])};
 return {config,profile,policy:config.datacenterFixedFeePool};
}
const route={class:'datacenter',provider:'configured_datacenter',country:'US',proxy_id:'dc-us-a'};
const estimate=(f,extra={})=>estimateRoutePricing({config:f.config,project:'a',profile:f.profile,route,reserved_tunnel_bytes:16384,now_ms:epoch,duration_ms:2000,...extra});
const invalid=[
 ['null policy',f=>f.config.datacenterFixedFeePool=null],
 ['unreviewed',f=>f.policy.reviewed=false],
 ['unexpected expiry',f=>f.policy.expires_at='2099-01-01T00:00:00Z'],
 ['unexpected project restriction',f=>f.policy.project='a'],
 ['unexpected profiles restriction',f=>f.policy.access_profiles=[]],
 ['invoice scope',f=>f.policy.cost_scope='total_invoice'],
 ['allocated subscription',f=>f.policy.fixed_subscription_allocation_micro_usd=0],
 ['wrong provider',f=>f.policy.provider='evomi'],
 ['wrong pool',f=>f.policy.pool_id='other'],
 ['empty countries',f=>f.policy.countries=[]],
 ['duplicate countries',f=>f.policy.countries=['US','US']],
 ['missing assigned country',f=>f.policy.countries=['US']],
 ['malformed country',f=>f.policy.countries=['USA']],
 ['future review',f=>f.policy.provenance.reviewed_at='2099-01-01T00:00:00Z'],
 ['bad evidence',f=>f.policy.provenance.sha256='unknown'],
 ['missing member',f=>f.config.proxies.pop()],
 ['missing inventory',f=>delete f.config.proxies],
 ['invalid inventory',f=>f.config.proxies={}],
 ['added member',f=>f.config.proxies.push({...f.config.proxies[0],id:'new-ip'})],
 ['replaced nonselected member',f=>f.config.proxies[2].url+='0'],
 ['credential rotation',f=>f.config.proxies[1].url=f.config.proxies[1].url.replace('fixture-secret','rotated')],
 ['mixed provider',f=>f.config.proxies[1].provider='other'],
 ['mixed pool',f=>f.config.proxies[1].pool_id='other'],
 ['unannotated member',f=>delete f.config.proxies[1].provider],
 ['missing country member',f=>delete f.config.proxies[1].country],
 ['unknown member',f=>f.config.proxies.push(null)],
 ['duplicate member id',f=>f.config.proxies[2].id='dc-us-a'],
 ['wrong fingerprint',f=>f.policy.pool_fingerprint_sha256='b'.repeat(64)]
];

test('fixed fee policy covers the complete assigned multi-country pool for ongoing service-wide HTTP pricing',()=>{
 const f=fixture(),first=estimate(f);
 assert.equal(first.estimated_micro_usd,0);assert.equal(first.pricing.basis,'operator_fixed_fee_pool');assert.equal(first.pricing.customer_traffic_charge_micro_usd,0);assert.equal(first.pricing.invoice_micro_usd,null);assert.equal(first.pricing.fixed_subscription_allocation_micro_usd,null);
 for(const extra of [{project:'b'},{profile:{id:'newly-approved',version:99}},{route:{...route,country:'IN',proxy_id:'dc-in-a'}},{now_ms:Date.parse('2099-01-01T00:00:00Z')}])assert.equal(estimate(f,extra).estimated_micro_usd,0);
 f.config.proxies.reverse();assert.deepEqual(estimate(f),first);assert.equal(fixedFeePoolFingerprint(f.config.proxies,['IN','US']),f.policy.pool_fingerprint_sha256);
 for(const [name,change]of invalid){const f=fixture();change(f);const decision=estimate(f);assert.equal(decision.estimated_micro_usd,null,name);assert.equal(decision.pricing.customer_traffic_charge_micro_usd,undefined,name);assert.equal(decision.binding,null,name);}
 for(const extra of [{route:{...route,proxy_id:'unknown'}},{route:{...route,country:'IN'}},{route:{...route,country:'GB'}},{route:{...route,provider:'oxylabs'}},{transport:'browser'}])assert.equal(estimate(f,extra).estimated_micro_usd,null);
 for(const [cls,provider,cost]of [['direct','direct',0],['residential','evomi',17]])assert.equal(estimate(f,{route:{class:cls,provider}}).estimated_micro_usd,cost);
 // A fresh digest cannot make mixed or out-of-scope inventory eligible.
 for(const change of [f=>f.config.proxies[1].provider='other',f=>f.config.proxies[1].pool_id='other',f=>f.config.proxies.push({...f.config.proxies[0],id:'outside-country',country:'GB'})]){const f=fixture();change(f);f.policy.pool_fingerprint_sha256=fixedFeePoolFingerprint(f.config.proxies,f.policy.countries);assert.equal(estimate(f).estimated_micro_usd,null);}
 delete f.config.datacenterFixedFeePool;assert.equal(estimate(f).pricing.reason,'attestation_missing');
});

test('durable pool policy takes precedence without removing scoped legacy attestation compatibility',()=>{
 const f=fixture(),policy=f.policy;
 f.config.proxies=f.config.proxies.filter(p=>p.country==='US');
 f.config.v2.datacenterPricingAttestations=[{schema_version:1,id:'legacy-scope',reviewed:true,provider:'oxylabs',pool_id:'assigned-pool',country:'US',project:'a',access_profiles:[{id:'source',version:1}],transport:'http',cost_scope:'incremental_traffic_only',fixed_subscription_allocation_micro_usd:null,valid_from:new Date(epoch-60000).toISOString(),expires_at:new Date(epoch+60000).toISOString(),provenance:{...policy.provenance},pool_fingerprint_sha256:datacenterPoolFingerprint(f.config.proxies,'US')}];
 f.config.datacenterFixedFeePool=null;assert.equal(estimate(f).estimated_micro_usd,null);
 delete f.config.datacenterFixedFeePool;assert.equal(estimate(f).pricing.basis,'operator_attested_prepaid_included_traffic');
 f.config.datacenterFixedFeePool={...policy,countries:['US'],pool_fingerprint_sha256:fixedFeePoolFingerprint(f.config.proxies,['US'])};
 assert.equal(estimate(f).pricing.basis,'operator_fixed_fee_pool');assert.equal(estimate(f,{project:'b'}).estimated_micro_usd,0);assert.equal(estimate(f,{now_ms:epoch+120000}).estimated_micro_usd,0);
});

test('fixed fee normal v2 routes persist zero pricing, isolate projects, retain holds and recheck all pool members',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 assert.match(new URL(process.env.TEST_DATABASE_URL).pathname,/^\/gateway_test_[A-Za-z0-9]+$/);
 const root=await mkdtemp(join(tmpdir(),'fixed-fee-v2-')),store=new Store(process.env.TEST_DATABASE_URL);await store.init();
 await store.pool.query('TRUNCATE v2_registry,v2_ledger_events,v2_artifacts,v2_ledger,v2_operations,v2_sessions,workflows,source_limits RESTART IDENTITY CASCADE');
 const f=fixture(root),{config}=f;let mode='ok',calls=0,dns=0,onDns=null;
 const gateway=new Gateway({store,config,profiles:{},resolve:async()=>[{address:'93.184.216.34',family:4}]});
 gateway.v2=new V2Gateway(gateway,{http:async(input,destination,limits,{proxy})=>{calls++;assert.ok(proxy);assert.ok(limits.max_tunnel_bytes<=8192);if(mode==='unknown')throw Object.assign(new GatewayError('source_timeout_unknown',504),{observed_tunnel_bytes:77});return {status:mode==='source-failure'?503:input.url.endsWith('/redirect')?302:200,headers:input.url.endsWith('/redirect')?{location:'/final'}:{'content-type':'application/json'},encoded:Buffer.from('{}'),tunnel_bytes:500,provider_status:200};},dnsHttp:async(input,destination)=>{dns++;onDns?.();const type=Number(destination.url.searchParams.get('type'));return {status:200,headers:{},encoded:Buffer.from(JSON.stringify({Status:0,Question:[{name:'source.example',type}],Answer:type===1?[{name:'source.example',type:1,data:'93.184.216.34'}]:[]})),tunnel_bytes:100};}});
 const v2=gateway.v2,app=server(gateway),headers={authorization:'Bearer synthetic-a'};
 const post=async(payload,auth=headers)=>{const r=await app.inject({method:'POST',url:'/v2/fetch',headers:auth,payload});return {status:r.statusCode,body:r.json()};};
 const payload=(key,country='US',profile={id:'source',version:1})=>({idempotency_key:key,access_profile:profile,url:'https://source.example/data',proxy:{class:'datacenter',country},max_estimated_micro_usd:0});
 const counts=async()=>({calls,dns,operations:Number((await store.pool.query('SELECT count(*) n FROM v2_operations')).rows[0].n),ledger:Number((await store.pool.query('SELECT count(*) n FROM v2_ledger')).rows[0].n)});
 const ledger=async id=>(await store.pool.query('SELECT row_to_json(l) v FROM v2_ledger l WHERE operation=$1',[id])).rows[0].v;
 try{
  const quotes=(await v2.profiles('a')).access_profiles;
  for(const p of quotes){for(const country of ['US','IN']){const q=p.route_reservations.find(r=>r.class==='datacenter'&&r.country===country);assert.equal(q.estimated_micro_usd,0);assert.equal(q.reserved_tunnel_bytes,16384);}assert.equal(p.browser_probe.route_reservations.find(r=>r.class==='datacenter').estimated_micro_usd,null);}
  const raw={...payload('first'),url:'https://source.example/redirect'},first=await post(raw);assert.equal(first.status,200);assert.equal(first.body.state,'completed');assert.equal(calls,2);assert.equal(dns,4);
  const accounting=first.body.usage.accounting;assert.equal(accounting.estimated_micro_usd,0);assert.equal(accounting.pricing.customer_traffic_charge_micro_usd,0);assert.equal(accounting.invoice_micro_usd,null);assert.equal(accounting.reserved_tunnel_bytes,16384);
  const reserve=(await store.pool.query("SELECT detail->'pricing_decision' AS d FROM v2_ledger_events WHERE operation=$1 AND event='reserve'",[first.body.operation_id])).rows[0].d;
  assert.equal(reserve.binding.policy_id,f.policy.id);assert.equal(reserve.binding.pool_fingerprint_sha256,f.policy.pool_fingerprint_sha256);assert.match(reserve.binding.policy_sha256,/^[a-f0-9]{64}$/);assert.deepEqual(reserve.binding.provenance,f.policy.provenance);
  const safe=JSON.stringify([quotes,first]);for(const hidden of ['fixture-secret','proxy-a.example',f.policy.pool_fingerprint_sha256,'private-authority','a'.repeat(64)])assert.ok(!safe.includes(hidden),hidden);
  assert.equal((await post(payload('india','IN',{id:'other',version:2}))).body.usage.accounting.estimated_micro_usd,0);
  const other=await post(payload('other-project'),{authorization:'Bearer synthetic-b'});assert.equal(other.body.usage.accounting.estimated_micro_usd,0);assert.equal((await app.inject({url:'/v2/fetch/first',headers:{authorization:'Bearer synthetic-b'}})).statusCode,404);
  for(const [index,changes]of [{url:'https://blocked.example/data'},{url:'https://source.example/forbidden'},{method:'POST'},{access_profile:{id:'forbidden',version:1}},{proxy:{class:'datacenter',country:'GB'}}].entries()){const before=await counts(),denied=await post({...payload('deny-'+index),...changes});assert.equal(denied.body.success,false,JSON.stringify(changes));assert.ok(denied.body.error);assert.equal(calls,before.calls);assert.equal(dns,before.dns);}
  mode='source-failure';const failure=await post(payload('source-failure'));assert.equal(failure.body.data.status,503);assert.equal(failure.body.usage.accounting.estimated_micro_usd,0);assert.equal(failure.body.application_acceptance,'not_evaluated');
  mode='unknown';const unknown=await post(payload('unknown'));assert.equal(unknown.body.state,'unknown');assert.equal(unknown.body.usage.accounting.pricing.customer_traffic_charge_micro_usd,0);assert.equal(Number((await ledger(unknown.body.operation_id)).accounted_tunnel_bytes),16384);mode='ok';
  const original=structuredClone(config.datacenterFixedFeePool),proxies=structuredClone(config.proxies);
  for(const [name,change]of invalid){config.datacenterFixedFeePool=structuredClone(original);config.proxies=structuredClone(proxies);change({config,policy:config.datacenterFixedFeePool});const before=await counts(),denied=await post(payload('invalid-'+name.replaceAll(' ','-')));assert.ok(denied.status>=400,name);assert.deepEqual(await counts(),before,name);}
  config.datacenterFixedFeePool=structuredClone(original);config.proxies=structuredClone(proxies);
  const beforeChanged=await counts();onDns=()=>{if(dns===beforeChanged.dns+2)config.proxies[2].url+='0';};const changed=await post(payload('changed-after-dns'));onDns=null;assert.equal(changed.body.error.code,'pricing_attestation_unavailable');assert.equal(calls,beforeChanged.calls);assert.equal(dns,beforeChanged.dns+2);
  config.datacenterFixedFeePool=structuredClone(original);config.proxies=structuredClone(proxies);
  const beforeEvidence=await counts();onDns=()=>{if(dns===beforeEvidence.dns+1)config.datacenterFixedFeePool.provenance.sha256='b'.repeat(64);};const changedEvidence=await post(payload('evidence-after-dns'));onDns=null;assert.equal(changedEvidence.body.error.code,'pricing_attestation_unavailable');assert.equal(calls,beforeEvidence.calls);assert.equal(dns,beforeEvidence.dns+1);
  delete config.datacenterFixedFeePool;const beforeReplay=await counts(),saved=await ledger(first.body.operation_id);
  assert.deepEqual((await post(raw)).body,first.body);assert.deepEqual((await post(payload('unknown'))).body,unknown.body);assert.deepEqual(await counts(),beforeReplay);assert.deepEqual(await ledger(first.body.operation_id),saved);
  const usage=await v2.usage('a');assert.equal(usage.invoice_basis,'unknown_until_authoritative_reconciliation');assert.equal(usage.application_acceptance,'not_measured');assert.ok(usage.by_key_and_state.every(r=>r.estimated_micro_usd===0&&r.unknown_invoice_operations===r.operations));assert.ok(!(await v2.recentOperations('b')).operations.some(o=>o.id===first.body.operation_id));
  const missing=await post(payload('missing-policy'));assert.equal(missing.body.error.code,'cost_estimate_unavailable');
 }finally{await app.close();await store.close();await rm(root,{recursive:true,force:true});}
});

test('v1 opted-in Oxylabs attempts persist explicit zero accounting without changing paid fallback or old captures',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 assert.match(new URL(process.env.TEST_DATABASE_URL).pathname,/^\/gateway_test_[A-Za-z0-9]+$/);
 const root=await mkdtemp(join(tmpdir(),'fixed-fee-v1-')),store=new Store(process.env.TEST_DATABASE_URL);await store.init();await store.pool.query('TRUNCATE ledger,attempts,operations,workflows,source_limits RESTART IDENTITY CASCADE');
 const f=fixture(root),{config}=f,profile={hosts:['source.example'],methods:['GET'],headers:[],country:'US',maxConcurrent:1,maxRequests:20,maxInputBytes:1024,maxResponseBytes:1024,maxBytes:30000,ttlSeconds:120,minIntervalMs:0,maxFallbackCredits:4,fallbackMaxCost:1};let calls=0,mode='ok',afterReserve=null;
 const gateway=new Gateway({store,config,profiles:{native:profile},resolve:async()=>[{address:'93.184.216.34'}],transport:{oxylabs:async()=>{calls++;return {status:mode==='fallback'?403:200,headers:{},cookies:[],body:Buffer.from('source')};},scrapedo:async()=>{calls++;return {status:200,providerStatus:200,headers:{},cookies:[],body:Buffer.from('fallback'),credits:1};}}});
 const originalTx=store.tx.bind(store);store.tx=fn=>originalTx(c=>fn({query:async(sql,args)=>{const r=await c.query(sql,args);if(sql.startsWith('INSERT INTO ledger(attempt,event,credits,detail)')&&afterReserve){const action=afterReserve;afterReserve=null;action();}return r;}}));
 const create=key=>gateway.workflow('a',{profile:'native',idempotency_key:key});const input=key=>({idempotency_key:key,url:'https://source.example/data',headers:{}});
 try{
  const w=await create('v1-fixed'),first=await gateway.operation('a',w.id,input('first'));assert.equal(first.provider,'oxylabs');assert.equal(first.accounting.estimated_micro_usd,0);assert.equal(first.accounting.pricing.customer_traffic_charge_micro_usd,0);assert.equal(first.accounting.invoice_micro_usd,null);assert.equal(first.credits,null);
  const decision=(await store.pool.query("SELECT l.detail->'pricing_decision' d FROM ledger l JOIN attempts a ON a.id=l.attempt WHERE a.operation=$1 AND l.event='reserve'",[first.id])).rows[0].d;assert.equal(decision.binding.pool_fingerprint_sha256,f.policy.pool_fingerprint_sha256);
  const original=structuredClone(config.datacenterFixedFeePool);delete config.datacenterFixedFeePool;const before=calls;assert.deepEqual(await gateway.operation('a',w.id,input('first')),first);assert.equal(calls,before);
  const old=await create('v1-old'),historical=await gateway.operation('a',old.id,input('old'));assert.equal(historical.accounting,undefined);config.datacenterFixedFeePool=structuredClone(original);assert.deepEqual(await gateway.operation('a',old.id,input('old')),historical);
  mode='fallback';const fallback=await create('v1-paid'),paid=await gateway.operation('a',fallback.id,input('paid'));assert.equal(paid.provider,'scrapedo');assert.equal(paid.credits,1);assert.equal(paid.accounting,undefined);mode='ok';
  const changed=await create('v1-replaced'),beforeChanged=calls;afterReserve=()=>{config.proxies[2].url+='0';};await assert.rejects(gateway.operation('a',changed.id,input('changed')),{code:'pricing_attestation_unavailable'});assert.equal(calls,beforeChanged);
  assert.equal((await store.pool.query("SELECT a.state FROM attempts a WHERE a.operation IN (SELECT id FROM operations WHERE workflow=$1)",[changed.id])).rows[0].state,'cancelled');
  await assert.rejects(gateway.result('b',first.id),{code:'operation_not_found'});
 }finally{await store.close();await rm(root,{recursive:true,force:true});}
});
