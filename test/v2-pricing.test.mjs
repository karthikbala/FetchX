import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {Gateway} from '../src/gateway.mjs';
import {V2Gateway} from '../src/v2.mjs';
import {GatewayError} from '../src/policy.mjs';
import {sha} from '../src/crypto.mjs';
import {datacenterPoolFingerprint,estimateRoutePricing,fixedFeePoolFingerprint} from '../src/v2-pricing.mjs';

const epoch=Date.parse('2026-11-01T10:00:00.000Z');
function fixture(root,now=epoch){
 const profile={id:'source',version:1,origins:['https://source.example'],paths:['^/'],methods:['GET'],headers:['accept'],proxy_classes:['direct','datacenter','residential'],countries:['US'],limits:{max_requests:100,max_encoded_bytes:4096,max_decoded_bytes:16384,max_session_encoded_bytes:655360,max_input_bytes:1024,max_tunnel_bytes:8192,max_redirects:2,max_expansion_ratio:100,timeout_ms:2000,min_interval_ms:0,ttl_seconds:900},browser_probe:{enabled:true,max_requests:4,max_network_bytes:8192,max_decoded_bytes:8192,max_dom_bytes:1024,settle_ms:0}};
 const config={release:'synthetic-pricing',artifactDir:root,artifactKey:'12'.repeat(32),maxDailyFallbackCredits:0,projects:{a:{keyId:'key-a',tokenHash:sha('synthetic-project-a'),profiles:[],v2_access_profiles:['source@1']},b:{keyId:'key-b',tokenHash:sha('synthetic-project-b'),profiles:[],v2_access_profiles:['source@1']}},proxies:[{id:'dc-a',country:'US',provider:'oxylabs',pool_id:'synthetic-prepaid',url:'http://fixture-user:fixture-secret@proxy-a.example:8080'},{id:'dc-b',country:'US',provider:'oxylabs',pool_id:'synthetic-prepaid',url:'http://fixture-user:fixture-secret@proxy-b.example:8080'}],v2:{accessProfiles:{'source@1':profile},dns:{allowed_hosts:['source.example'],fallback_resolvers:[{id:'synthetic-resolver',endpoint:'https://resolver.example/resolve'}],use_session_proxy:true}},residential:{maxTotalBytes:10000000,maxDailyBytes:10000000,providers:{evomi:{enabled:true,username:'synthetic-vendor',password:'synthetic-password',countries:['US'],maxTotalBytes:10000000,microUsdPerGB:1000000}}}};
 const grant={schema_version:1,id:'synthetic-attestation',reviewed:true,provider:'oxylabs',pool_id:'synthetic-prepaid',country:'US',project:'a',access_profiles:[{id:'source',version:1}],transport:'http',cost_scope:'incremental_traffic_only',fixed_subscription_allocation_micro_usd:null,valid_from:new Date(now-60000).toISOString(),expires_at:new Date(now+600000).toISOString(),provenance:{id:'synthetic-human-evidence',sha256:'a'.repeat(64),reviewed_at:new Date(now-60000).toISOString()},pool_fingerprint_sha256:datacenterPoolFingerprint(config.proxies,'US')};
 config.v2.datacenterPricingAttestations=[grant];
 return {config,profile,grant,now};
}
const route={class:'datacenter',country:'US',provider:'configured_datacenter',proxy_id:'dc-a'};
const estimate=(f,extra={})=>estimateRoutePricing({config:f.config,project:'a',profile:f.profile,route,reserved_tunnel_bytes:24576,now_ms:epoch,duration_ms:2000,...extra});
const invalidCases=[
 ['missing',f=>delete f.config.v2.datacenterPricingAttestations],
 ['unreviewed',f=>f.grant.reviewed=false],
 ['malformed timestamp',f=>f.grant.expires_at='2026-11-31T10:00:00Z'],
 ['non UTC timestamp',f=>f.grant.valid_from='2026-11-01T09:59:00+00:00'],
 ['unknown field',f=>f.grant.client_override=true],
 ['not yet valid',f=>f.grant.valid_from=new Date(f.now+1000).toISOString()],
 ['expired',f=>f.grant.expires_at=new Date(f.now-1).toISOString()],
 ['near expiry',f=>f.grant.expires_at=new Date(f.now+2000).toISOString()],
 ['implausible validity',f=>f.grant.expires_at='2099-01-01T00:00:00Z'],
 ['future review',f=>f.grant.provenance.reviewed_at=new Date(f.now+1000).toISOString()],
 ['evidence digest',f=>f.grant.provenance.sha256='unreviewed'],
 ['wrong project',f=>f.grant.project='b'],
 ['wrong profile',f=>f.grant.access_profiles[0].id='other'],
 ['wrong version',f=>f.grant.access_profiles[0].version=2],
 ['wrong transport',f=>f.grant.transport='browser'],
 ['wrong country',f=>f.grant.country='GB'],
 ['wrong grant provider',f=>f.grant.provider='other'],
 ['wrong grant pool',f=>f.grant.pool_id='other'],
 ['wrong member provider',f=>f.config.proxies[1].provider='other'],
 ['wrong member pool',f=>f.config.proxies[1].pool_id='other'],
 ['changed URL',f=>f.config.proxies[1].url+='0'],
 ['changed credentials',f=>f.config.proxies[1].url=f.config.proxies[1].url.replace('fixture-secret','rotated-secret')],
 ['member removed',f=>f.config.proxies.pop()],
 ['member added',f=>f.config.proxies.push({...f.config.proxies[0],id:'dc-c'})],
 ['member unannotated',f=>delete f.config.proxies[1].provider],
 ['duplicate member id',f=>f.config.proxies[1].id='dc-a'],
 ['ambiguous grants',f=>f.config.v2.datacenterPricingAttestations.push({...f.grant,id:'another-attestation'})],
 ['invoice scope',f=>f.grant.cost_scope='total_invoice'],
 ['fixed allocation inferred',f=>f.grant.fixed_subscription_allocation_micro_usd=0]
];

test('browser datacenter pricing requires an explicitly reviewed transport scope',t=>{
 const f=fixture();
 assert.equal(estimate(f,{transport:'browser'}).pricing.reason,'attestation_scope_mismatch');
 const browser={...f.grant,schema_version:2,id:'browser-grant',transport:'browser'};
 f.config.v2.datacenterPricingAttestations.push(browser);
 assert.equal(estimate(f).pricing.attestation_id,f.grant.id);
 const decision=estimate(f,{transport:'browser'});
 assert.equal(decision.pricing.attestation_id,browser.id);
 assert.equal(decision.estimated_micro_usd,0);
 t.mock.method(Date,'now',()=>epoch);
 const gateway={pricing:(project,profile,selected,bytes,transport,duration)=>estimate(f,{project,profile,route:selected,reserved_tunnel_bytes:bytes,transport,duration_ms:duration})};
 const context={profile:f.profile,route,decision,transport:'browser'};
 V2Gateway.prototype.assertPricingDispatch.call(gateway,'a',context);
 assert.throws(()=>V2Gateway.prototype.assertPricingDispatch.call(gateway,'a',{...context,transport:'http'}),{code:'pricing_attestation_unavailable'});
 browser.reviewed=false;
 assert.throws(()=>V2Gateway.prototype.assertPricingDispatch.call(gateway,'a',context),{code:'pricing_attestation_unavailable'});

 const pool={schema_version:1,id:'fixed-v1',reviewed:true,provider:'oxylabs',pool_id:'synthetic-prepaid',countries:['US'],cost_scope:'incremental_traffic_only',
  fixed_subscription_allocation_micro_usd:null,provenance:{...f.grant.provenance},pool_fingerprint_sha256:fixedFeePoolFingerprint(f.config.proxies,['US'])};
 f.config.datacenterFixedFeePool=pool;
 assert.equal(estimate(f).estimated_micro_usd,0);
 assert.equal(estimate(f,{transport:'browser'}).pricing.reason,'fixed_fee_pool_scope_mismatch');
 f.config.datacenterFixedFeePool={...pool,schema_version:2,transports:['browser']};
 assert.equal(estimate(f).pricing.reason,'fixed_fee_pool_scope_mismatch');
 assert.equal(estimate(f,{transport:'browser'}).estimated_micro_usd,0);
 f.config.datacenterFixedFeePool.transports=['http','browser'];
 assert.equal(estimate(f).estimated_micro_usd,0);
 assert.equal(estimate(f,{transport:'browser'}).estimated_micro_usd,0);
 f.config.datacenterFixedFeePool.transports=['browser','browser'];
 assert.equal(estimate(f,{transport:'browser'}).pricing.reason,'fixed_fee_pool_policy_invalid');
});

test('prepaid estimator binds the full sorted country pool and reports only included incremental traffic',()=>{
 const f=fixture(),decision=estimate(f);
 assert.equal(decision.estimated_micro_usd,0);assert.equal(decision.pricing.basis,'operator_attested_prepaid_included_traffic');assert.equal(decision.pricing.cost_scope,'incremental_traffic_only');assert.equal(decision.pricing.invoice_micro_usd,null);assert.equal(decision.pricing.fixed_subscription_allocation_micro_usd,null);
 assert.equal(decision.dispatch_deadline_ms,epoch+2000);assert.equal(decision.pricing.customer_traffic_charge_micro_usd,0);
 f.config.proxies.reverse();assert.deepEqual(estimate(f),decision);
 for(const [name,mutate]of invalidCases){const next=fixture();mutate(next);assert.equal(estimate(next).estimated_micro_usd,null,name);assert.equal(estimate(next).pricing.customer_traffic_charge_micro_usd,undefined,name);}
 assert.equal(estimate(f,{route:{...route,proxy_id:'absent'}}).estimated_micro_usd,null);
 assert.equal(estimate(f,{route:{...route,provider:'oxylabs'}}).estimated_micro_usd,null);
 assert.equal(estimate(f,{transport:'browser'}).estimated_micro_usd,null);
 const near=fixture();near.grant.expires_at=new Date(near.now+2000).toISOString();assert.equal(estimate(near).pricing.reason,'insufficient_validity');
 for(const [className,provider,expected]of [['direct','direct',0],['residential','evomi',25]]){
  delete f.config.v2.datacenterPricingAttestations;
  const d=estimate(f,{route:{class:className,provider}});assert.equal(d.estimated_micro_usd,expected);assert.equal(d.pricing,null);
 }
});

test('prepaid quotes, admission, DNS bounds, replay and unknown holds preserve durable accounting',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 assert.match(new URL(process.env.TEST_DATABASE_URL).pathname,/^\/gateway_test_[A-Za-z0-9]+$/);
 const root=await mkdtemp(join(tmpdir(),'fetchx-prepaid-')),store=new Store(process.env.TEST_DATABASE_URL);await store.init();
 await store.pool.query('TRUNCATE v2_registry,v2_ledger_events,v2_artifacts,v2_ledger,v2_operations,v2_sessions,workflows,source_limits RESTART IDENTITY CASCADE');
 let now=Date.now(),mode='ok',httpCalls=0,dnsCalls=0,resolves=0,onDns=null;
 t.mock.method(Date,'now',()=>now);
 const f=fixture(root,now),{config}=f;
 const gateway=new Gateway({store,config,profiles:{},resolve:async()=>{resolves++;return [{address:'93.184.216.34',family:4}];}});
 const v2=new V2Gateway(gateway,{browserRuntime:async()=>({available:true,runtime:{}}),http:async(input,dest,limits,{proxy})=>{
  httpCalls++;assert.ok(limits.timeout_ms<=2000);assert.ok(limits.max_tunnel_bytes<=8192);assert.ok(proxy);
  if(mode==='unknown'){const e=new GatewayError('source_timeout_unknown',504);e.observed_tunnel_bytes=700;throw e;}
  return {status:input.url.endsWith('/redirect')?302:200,headers:input.url.endsWith('/redirect')?{location:'https://source.example/final'}:{'content-type':'application/json'},encoded:Buffer.from('{"ok":true}'),tunnel_bytes:500,provider_status:200};
 },dnsHttp:async(input,dest,limits,{proxy})=>{
  dnsCalls++;assert.ok(proxy);assert.ok(limits.timeout_ms<=2000);assert.ok(limits.max_tunnel_bytes<=24576);onDns?.();
  const type=Number(dest.url.searchParams.get('type'));
  return {status:200,headers:{},encoded:Buffer.from(JSON.stringify({Status:0,AD:true,Question:[{name:'source.example',type}],Answer:type===1?[{name:'source.example',type:1,data:'93.184.216.34'}]:[]})),tunnel_bytes:100};
 }});
 const session=async(key,project='a',className='datacenter')=>v2.session(project,{idempotency_key:key,access_profile:{id:'source',version:1},transport:'http',proxy:{class:className,country:className==='direct'?null:'US',affinity:'session'}});
 const input=(sid,key,path='/data')=>({idempotency_key:key,session_id:sid,request:{url:'https://source.example'+path},max_estimated_micro_usd:0});
 const counts=async()=>({operations:Number((await store.pool.query('SELECT count(*) n FROM v2_operations')).rows[0].n),ledger:Number((await store.pool.query('SELECT count(*) n FROM v2_ledger')).rows[0].n),events:Number((await store.pool.query('SELECT count(*) n FROM v2_ledger_events')).rows[0].n),httpCalls,dnsCalls,resolves});
 const restore=()=>{const next=fixture(root,now);config.proxies=next.config.proxies;config.v2.datacenterPricingAttestations=next.config.v2.datacenterPricingAttestations;return {config,profile:f.profile,grant:config.v2.datacenterPricingAttestations[0],now};};
 try{
  const s=await session('matching');
  const beforeOverride=await counts();await assert.rejects(v2.operation('a',{...input(s.id,'client-pricing'),pricing:{customer_traffic_charge_micro_usd:0}}),{code:'operation_invalid'});assert.deepEqual(await counts(),beforeOverride);
  const quote=(await v2.profiles('a')).access_profiles[0],dc=quote.route_reservations.find(r=>r.class==='datacenter');
  assert.equal(dc.estimated_micro_usd,0);assert.equal(dc.reserved_tunnel_bytes,24576);assert.equal(dc.provider,'configured_datacenter');assert.equal(dc.pricing.provider,'oxylabs');
  assert.equal(quote.browser_probe.route_reservations.find(r=>r.class==='datacenter').estimated_micro_usd,null);
  const raw=input(s.id,'matching','/redirect'),result=await v2.operation('a',raw);
  assert.equal(result.state,'completed');assert.equal(httpCalls,2);assert.equal(dnsCalls,4);assert.equal(result.result.dns_requests,4);assert.equal(result.result.tunnel_bytes,1400);
  assert.equal(result.accounting.estimated_micro_usd,0);assert.equal(result.accounting.invoice_micro_usd,null);assert.equal(result.accounting.reserved_tunnel_bytes,24576);assert.deepEqual(result.accounting.pricing,dc.pricing);
  const persisted=(await store.pool.query("SELECT detail FROM v2_ledger_events WHERE operation=$1 AND event='reserve'",[result.id])).rows[0].detail;
  assert.equal(persisted.pricing_decision.binding.pool_fingerprint_sha256,f.grant.pool_fingerprint_sha256);
  assert.deepEqual(persisted.pricing_decision.binding.provenance,f.grant.provenance);assert.match(persisted.pricing_decision.binding.attestation_sha256,/^[a-f0-9]{64}$/);
  const safe=JSON.stringify([quote,result]);for(const secret of ['fixture-secret',f.grant.pool_fingerprint_sha256,'synthetic-human-evidence','a'.repeat(64),'proxy-a.example'])assert.ok(!safe.includes(secret),secret);
  const ledger=async id=>(await store.pool.query('SELECT row_to_json(l) row FROM v2_ledger l WHERE operation=$1',[id])).rows[0].row;
  assert.equal(Number((await ledger(result.id)).accounted_tunnel_bytes),24576);
  const beforeBrowser=await counts();await assert.rejects(v2.browserProbe('a',{idempotency_key:'browser-blocked',session_id:s.id,url:'https://source.example/data',max_estimated_micro_usd:0}),{code:'cost_estimate_unavailable'});assert.deepEqual(await counts(),beforeBrowser);
  // Invalid pricing never dispatches even resolver work and inserts no operation,
  // reservation or reserve event. Existing sessions do not pin an old grant.
  for(const [name,mutate]of invalidCases){
   const state=restore(),created=await session('reject-'+name.replaceAll(' ','-')),before=await counts();
   mutate(state);
   const deniedQuote=(await v2.profiles('a')).access_profiles[0].route_reservations.find(r=>r.class==='datacenter');assert.equal(deniedQuote.estimated_micro_usd,null,name);assert.equal(deniedQuote.pricing.customer_traffic_charge_micro_usd,undefined,name);
   await assert.rejects(v2.operation('a',input(created.id,'denied-'+name.replaceAll(' ','-'))),{code:'cost_estimate_unavailable'},name);assert.deepEqual(await counts(),before,name);
  }
  restore();const bs=await session('other-project','b'),beforeOther=await counts();await assert.rejects(v2.operation('b',input(bs.id,'other-project')),{code:'cost_estimate_unavailable'});assert.deepEqual(await counts(),beforeOther);
  restore();const exp=await session('session-then-expired');config.v2.datacenterPricingAttestations[0].expires_at=new Date(now-1).toISOString();const beforeExpired=await counts();await assert.rejects(v2.operation('a',input(exp.id,'session-then-expired')),{code:'cost_estimate_unavailable'});assert.deepEqual(await counts(),beforeExpired);
  restore();const unknownSession=await session('unknown');mode='unknown';const unknown=await v2.operation('a',input(unknownSession.id,'unknown'));
  assert.equal(unknown.state,'unknown');assert.equal(unknown.accounting.estimated_micro_usd,0);assert.equal(unknown.accounting.invoice_micro_usd,null);assert.equal(Number((await ledger(unknown.id)).accounted_tunnel_bytes),24576);
  mode='ok';restore();const ds=await session('expiry-before-first-dns'),originalExecute=v2.execute.bind(v2),at=now;
  v2.execute=async(...args)=>{now+=700000;return originalExecute(...args);};const beforeDispatch=await counts();const cancelled=await v2.operation('a',input(ds.id,'expiry-before-first-dns'));v2.execute=originalExecute;
  assert.equal(cancelled.state,'failed');assert.equal(cancelled.result.physical_requests,0);assert.equal(cancelled.result.dns_requests,0);assert.equal(dnsCalls,beforeDispatch.dnsCalls);assert.equal(httpCalls,beforeDispatch.httpCalls);now=at;
  // An expiry between A and AAAA must prevent the next fresh DNS dispatch.
  restore();const mid=await session('expiry-between-dns'),beforeMid=await counts();onDns=()=>{now+=700000;};const stopped=await v2.operation('a',input(mid.id,'expiry-between-dns'));onDns=null;
  assert.equal(stopped.state,'failed');assert.equal(stopped.result.dns_requests,1);assert.equal(dnsCalls,beforeMid.dnsCalls+1);assert.equal(httpCalls,beforeMid.httpCalls);assert.equal(Number((await ledger(stopped.id)).accounted_tunnel_bytes),24576);now=at;
  // Removing the attestation at target admission prevents target dispatch even
  // after two successful, already-accounted DNS queries.
  restore();const changed=await session('pool-changes-after-dns'),beforeChanged=await counts();onDns=()=>{if(dnsCalls===beforeChanged.dnsCalls+2)config.proxies[0].url+='0';};const blocked=await v2.operation('a',input(changed.id,'pool-changes-after-dns'));onDns=null;
  assert.equal(blocked.error,'pricing_attestation_unavailable');assert.equal(httpCalls,beforeChanged.httpCalls);assert.equal(blocked.result.dns_requests,2);assert.equal(Number((await ledger(blocked.id)).accounted_tunnel_bytes),24576);
  restore();const evidence=await session('evidence-changes-after-dns'),beforeEvidence=await counts();onDns=()=>{if(dnsCalls===beforeEvidence.dnsCalls+2)config.v2.datacenterPricingAttestations[0].provenance.sha256='b'.repeat(64);};const reattested=await v2.operation('a',input(evidence.id,'evidence-changes-after-dns'));onDns=null;
  assert.equal(reattested.error,'pricing_attestation_unavailable');assert.equal(httpCalls,beforeEvidence.httpCalls);assert.equal(reattested.result.dns_requests,2);
  const originalEvidence=(await store.pool.query("SELECT detail->'pricing_decision'->'binding' AS binding FROM v2_ledger_events WHERE operation=$1 AND event='reserve'",[reattested.id])).rows[0].binding;assert.equal(originalEvidence.provenance.sha256,'a'.repeat(64));
  // Legacy ledger rows have no pricing decision and remain byte-for-byte stable
  // through reads/replays under newly installed or expired pricing.
  restore();delete config.v2.datacenterPricingAttestations;const legacySession=await session('legacy'),legacyInput=input(legacySession.id,'legacy');delete legacyInput.max_estimated_micro_usd;const legacy=await v2.operation('a',legacyInput);
  await store.pool.query("UPDATE v2_ledger_events SET detail=detail-'pricing_decision' WHERE operation=$1 AND event='reserve'",[legacy.id]);await store.pool.query('UPDATE v2_ledger SET estimated_micro_usd=12345,invoice_micro_usd=321 WHERE operation=$1',[legacy.id]);const oldLedger=await ledger(legacy.id);
  restore();const newView=await v2.readOperation('a',legacy.id);assert.equal(newView.accounting.estimated_micro_usd,12345);assert.equal(newView.accounting.invoice_micro_usd,321);assert.equal(newView.accounting.pricing,undefined);
  const savedLedger=await ledger(result.id),unknownLedger=await ledger(unknown.id),beforeReplay=await counts();now+=700000;delete config.v2.datacenterPricingAttestations;
  assert.deepEqual(await v2.operation('a',raw),result);assert.deepEqual(await v2.lookup('a','matching'),result);assert.deepEqual(await v2.readOperation('a',result.id),result);assert.deepEqual(await v2.operation('a',input(unknownSession.id,'unknown')),unknown);await v2.operation('a',legacyInput);assert.deepEqual(await counts(),beforeReplay);assert.deepEqual(await ledger(result.id),savedLedger);assert.deepEqual(await ledger(unknown.id),unknownLedger);assert.deepEqual(await ledger(legacy.id),oldLedger);
  // Residential/direct quotes retain their previous semantics with no grant.
  const unaffected=(await v2.profiles('a')).access_profiles[0].route_reservations;assert.equal(unaffected.find(r=>r.class==='direct').estimated_micro_usd,0);assert.equal(unaffected.find(r=>r.class==='residential').estimated_micro_usd,25);
 }finally{t.mock.restoreAll();await store.close();await rm(root,{recursive:true,force:true});}
});
