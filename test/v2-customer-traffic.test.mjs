import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {Gateway} from '../src/gateway.mjs';
import {V2Gateway,recoverV2,initV2} from '../src/v2.mjs';
import {server} from '../src/main.mjs';
import {sha} from '../src/crypto.mjs';
import {GatewayError} from '../src/policy.mjs';
import {estimateRoutePricing} from '../src/v2-pricing.mjs';

function fixture(root){
 const profile={id:'meter',version:1,origins:['https://source.example'],paths:['^/'],methods:['GET'],headers:['accept'],proxy_classes:['direct','residential'],countries:['US'],limits:{max_requests:1000,max_encoded_bytes:4096,max_decoded_bytes:8192,max_session_encoded_bytes:1000000,max_input_bytes:1024,max_tunnel_bytes:8192,max_redirects:2,max_expansion_ratio:100,timeout_ms:2000,min_interval_ms:0,ttl_seconds:900},browser_probe:{enabled:true,max_requests:2,max_network_bytes:4096,max_decoded_bytes:4096,max_dom_bytes:1024,settle_ms:0}};
 const provider={enabled:true,username:'fixture-user',password:'fixture-password',countries:['US'],maxTotalBytes:1e8,microUsdPerGB:1e6};
 return {release:'customer-fixture',artifactDir:root,artifactKey:'14'.repeat(32),maxDailyFallbackCredits:0,projects:{a:{tokenHash:sha('customer-token'),profiles:[],v2_access_profiles:['meter@1'],v2_entitlement:{mode:'unmetered'}}},proxies:[],v2:{accessProfiles:{'meter@1':profile}},residential:{maxTotalBytes:1e8,maxDailyBytes:1e8,providers:{evomi:{...provider},dataimpulse:{...provider}}}};
}

test('v2 residential quotation exposes a distinct customer bound for either provider',()=>{
 const config=fixture(),profile=config.v2.accessProfiles['meter@1'];
 for(const provider of ['evomi','dataimpulse']){
  const quote=estimateRoutePricing({config,project:'a',profile,route:{class:'residential',provider},reserved_tunnel_bytes:24576});
  assert.equal(quote.estimated_micro_usd,25);assert.equal(quote.customer_traffic_reservation.reserved_bytes,24576);assert.equal(quote.customer_traffic_reservation.max_cost_usd,'0.000049152');assert.equal(quote.customer_traffic_reservation.max_estimated_micro_usd,50);
 }
});

test('v2 facade persists exact customer traffic, protects both bounds and never reprices replay or history',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 assert.match(new URL(process.env.TEST_DATABASE_URL).pathname,/^\/gateway_test_[A-Za-z0-9_]+$/);
 const root=await mkdtemp(join(tmpdir(),'fetchx-customer-v2-')),store=new Store(process.env.TEST_DATABASE_URL);await store.init();
 await store.pool.query('TRUNCATE v2_registry,v2_ledger_events,v2_artifacts,v2_ledger,v2_operations,v2_sessions,workflows,source_limits RESTART IDENTITY CASCADE');
 const config=fixture(root),gateway=new Gateway({store,config,profiles:{},resolve:async()=>[{address:'93.184.216.34',family:4}]});let mode='tiny',calls=0,dnsCalls=0;
 gateway.v2=new V2Gateway(gateway,{http:async(input,destination,limits,{proxy})=>{
  calls++;assert.ok(proxy);
  if(mode==='unknown')throw Object.assign(new GatewayError('source_timeout_unknown',502),{observed_tunnel_bytes:17});
  if(mode==='known-failure')throw Object.assign(new GatewayError('proxy_connect_rejected',502),{observed_tunnel_bytes:17});
  if(mode==='partial')throw Object.assign(new GatewayError('source_body_incomplete',502),{observed_tunnel_bytes:17});
  const redirected=input.url.endsWith('/redirect');
  return {status:mode==='source-failure'?503:redirected?302:200,headers:redirected?{location:'/final'}:{'content-type':'application/json'},encoded:Buffer.from('{}'),tunnel_bytes:mode==='missing'||mode==='missing-hop'&&redirected?null:mode==='negative'?-1:mode==='fractional'?1.5:mode==='unsafe'?Number.MAX_SAFE_INTEGER+1:mode==='overrun'?24585:1,provider_status:200};
 },dnsHttp:async(input,destination)=>{dnsCalls++;const type=Number(destination.url.searchParams.get('type'));if(mode==='dns-unknown')throw Object.assign(new GatewayError('source_timeout_unknown',502),{observed_tunnel_bytes:11});return {status:200,headers:{},encoded:Buffer.from(JSON.stringify({Status:mode==='dns-failure'?2:0,Question:[{name:'source.example',type}],Answer:type===1?[{name:'source.example',type,data:'93.184.216.34'}]:[]})),tunnel_bytes:mode==='dns-missing'?null:11};}});
 const v2=gateway.v2,app=server(gateway),headers={authorization:'Bearer customer-token'};
 const payload=key=>({idempotency_key:key,access_profile:{id:'meter',version:1},url:'https://source.example/data',proxy:{class:'residential',country:'US'}});
 const post=async value=>{const response=await app.inject({method:'POST',url:'/v2/fetch',headers,payload:value});return {status:response.statusCode,body:response.json()};};
 const ledger=async id=>(await store.pool.query('SELECT row_to_json(l) AS value FROM v2_ledger l WHERE operation=$1',[id])).rows[0].value;
 try{
  for(const provider of ['evomi','dataimpulse']){
   config.residential.providers.evomi.enabled=provider==='evomi';
   const quote=(await v2.profiles('a')).access_profiles[0].route_reservations.find(q=>q.class==='residential');assert.equal(quote.provider,provider);assert.equal(quote.customer_traffic_reservation.max_estimated_micro_usd,50);
   const before=calls;const denied=await post({...payload(provider+'-customer-ceiling'),max_estimated_micro_usd:25});assert.equal(denied.status,429);assert.equal(denied.body.error.code,'cost_ceiling_exceeded');assert.equal(calls,before);
   config.residential.providers[provider].microUsdPerGB=4e6;const providerDenied=await post({...payload(provider+'-provider-ceiling'),max_estimated_micro_usd:50});assert.equal(providerDenied.status,429);assert.equal(calls,before);config.residential.providers[provider].microUsdPerGB=1e6;
   for(mode of ['tiny','source-failure','known-failure','unknown','partial','missing','missing-hop','negative','fractional','unsafe']){
    const raw={...payload(provider+'-'+mode),...(mode==='missing-hop'?{url:'https://source.example/redirect'}:{}),max_estimated_micro_usd:50},answer=await post(raw),operation=answer.body,charge=operation.usage.accounting.customer_traffic;
    assert.equal(answer.status,200,mode);assert.equal(operation.routing.provider,provider);assert.equal(operation.usage.accounting.estimated_micro_usd,25);assert.equal(operation.usage.accounting.invoice_micro_usd,null);assert.equal(operation.usage.accounting.customer_traffic_reservation.max_cost_usd,'0.000049152');
    if(['tiny','source-failure','known-failure'].includes(mode)){assert.equal(charge.status,'measured',mode);assert.equal(charge.cost_usd,mode==='known-failure'?'0.000000034':'0.000000002');}else {assert.equal(charge.status,'unknown',mode);assert.equal(charge.cost_usd,null,mode);}
    if(['missing','missing-hop','negative','fractional','unsafe'].includes(mode))assert.equal(operation.usage.tunnel_bytes,null,mode);
    const saved=await ledger(operation.operation_id),beforeReplay=calls;config.residential.providers[provider].microUsdPerGB=8e6;
    assert.deepEqual((await post(raw)).body,operation);const recovered=await app.inject({url:'/v2/fetch/'+raw.idempotency_key,headers});assert.deepEqual(recovered.json(),operation);assert.equal(calls,beforeReplay);assert.deepEqual(await ledger(operation.operation_id),saved);config.residential.providers[provider].microUsdPerGB=1e6;
   }
  }
  config.residential.providers.evomi.enabled=true;mode='tiny';const legacyRaw=payload('historical'),legacy=(await post(legacyRaw)).body;await store.pool.query('UPDATE v2_ledger SET customer_traffic=NULL,customer_traffic_reservation=NULL WHERE operation=$1',[legacy.operation_id]);const old=await ledger(legacy.operation_id);await initV2(store.pool);assert.equal((await post(legacyRaw)).body.usage.accounting.customer_traffic,undefined);assert.deepEqual(await ledger(legacy.operation_id),old);
  const execute=v2.execute.bind(v2);v2.execute=async()=>{};
  for(const state of ['reserved','running']){const raw=payload('recovery-'+state),pending=(await post(raw)).body;assert.equal(pending.usage.accounting.customer_traffic.status,'pending');await store.pool.query('UPDATE v2_operations SET state=$2 WHERE id=$1',[pending.operation_id,state]);await recoverV2(store.pool);const recovered=await v2.readOperation('a',pending.operation_id);assert.equal(recovered.accounting.customer_traffic.status,state==='reserved'?'no_traffic':'unknown');assert.equal(recovered.accounting.customer_traffic.cost_usd,state==='reserved'?'0.000000000':null);}
  v2.execute=execute;
  config.v2.dns={allowed_hosts:['source.example'],fallback_resolvers:[{id:'fixture',endpoint:'https://resolver.example/resolve'}],use_session_proxy:true};
  // Resolver policy is created with the gateway; recreate only the test adapter.
  const dnsV2=new V2Gateway(gateway,{http:v2.http,dnsHttp:async(input,destination)=>{dnsCalls++;const type=Number(destination.url.searchParams.get('type'));if(mode==='dns-unknown')throw Object.assign(new GatewayError('source_timeout_unknown',502),{observed_tunnel_bytes:11});return {status:200,headers:{},encoded:Buffer.from(JSON.stringify({Status:mode==='dns-failure'?2:0,Question:[{name:'source.example',type}],Answer:type===1?[{name:'source.example',type,data:'93.184.216.34'}]:[]})),tunnel_bytes:mode==='dns-missing'?null:11};}});
  for(mode of ['dns-ok','dns-failure','dns-unknown','dns-missing']){const session=await dnsV2.session('a',{idempotency_key:mode,access_profile:{id:'meter',version:1},transport:'http',proxy:{class:'residential',country:'US',affinity:'session'}}),before=dnsCalls,result=await dnsV2.operation('a',{idempotency_key:mode,session_id:session.id,request:{url:'https://source.example/redirect'}});assert.equal(result.accounting.customer_traffic.status,['dns-ok','dns-failure'].includes(mode)?'measured':'unknown');assert.equal(result.accounting.customer_traffic.cost_usd,mode==='dns-ok'?'0.000000092':mode==='dns-failure'?'0.000000022':null);assert.equal(dnsCalls-before,mode==='dns-ok'?4:1);}
  // Measured overrun can never charge beyond the original customer byte bound.
  mode='overrun';const overrun=(await post(payload('overrun'))).body;assert.equal(overrun.usage.accounting.customer_traffic.metered_bytes,24585);assert.equal(overrun.usage.accounting.customer_traffic.billable_bytes,24576);assert.equal(overrun.usage.accounting.customer_traffic.cost_usd,'0.000049152');
 }finally{await app.close();await store.pool.query('TRUNCATE v2_registry,v2_ledger_events,v2_artifacts,v2_ledger,v2_operations,v2_sessions,workflows,source_limits RESTART IDENTITY CASCADE');await store.close();await rm(root,{recursive:true,force:true});}
});

test('v2 browser customer charges distinguish complete source failures, incomplete captures, uncertain meters and unsent work',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 assert.match(new URL(process.env.TEST_DATABASE_URL).pathname,/^\/gateway_test_[A-Za-z0-9_]+$/);
 const root=await mkdtemp(join(tmpdir(),'fetchx-customer-probe-')),store=new Store(process.env.TEST_DATABASE_URL);await store.init();
 await store.pool.query('TRUNCATE v2_registry,v2_ledger_events,v2_artifacts,v2_ledger,v2_operations,v2_sessions,workflows,source_limits RESTART IDENTITY CASCADE');
 const config=fixture(root),gateway=new Gateway({store,config,profiles:{},resolve:async()=>[{address:'93.184.216.34',family:4}]});let mode='ok',runs=0;
 const artifact=(kind,request)=>{const body=Buffer.from(kind==='rendered_dom'?'<html/>':'{}');return {kind,url:'https://source.example/data',method:'GET',status:mode==='source-failure'?503:200,headers:{'content-type':kind==='rendered_dom'?'text/html':'application/json'},raw_headers:null,content_encoding:null,decoded_body_base64:body.toString('base64'),decoded_sha256:sha(body),decoded_bytes:body.length,encoded_body_base64:null,encoded_sha256:null,original_encoded_available:false,encoded_bytes:null,encoded_size_basis:null,...(kind==='rendered_dom'?{generated:true}:{request})};};
 const v2=new V2Gateway(gateway,{browserRuntime:async()=>({available:true,runtime:{synthetic:true}}),relayFactory:async()=>({url:'http://127.0.0.1:1',bytes:mode==='missing'?null:mode==='negative'?-1:mode==='overrun'?4105:17,dispatched:mode!=='cancel',connections:mode==='cancel'?0:1,error:null,meter_complete:mode!=='incomplete-meter',close:async function(){if(mode==='late-error')this.error='browser_transport_unknown';if(mode==='close-error')throw new Error('synthetic close failure');}}),browserRunner:async(input,hooks)=>{
  runs++;if(mode==='cancel')throw new GatewayError('destination_rejected',403);
  const request={url:input.url,method:'GET',headers:{accept:'application/json'},body_base64:null,redirect_depth:0,redirected_from:null};await hooks.admit(request);
  if(mode==='unknown')throw new Error('synthetic interruption');
  await hooks.artifact(artifact('browser_response',request));await hooks.artifact(artifact('rendered_dom'));
  return {status:mode==='source-failure'?503:200,final_url:input.url,error:null,capture_complete:mode!=='partial',blocked_requests:0,blocked_reasons:{},counts_complete:true};
 }});
 const session=key=>v2.session('a',{idempotency_key:key,access_profile:{id:'meter',version:1},transport:'http',proxy:{class:'residential',country:'US',affinity:'session'}});
 try{
  for(const provider of ['evomi','dataimpulse']){
   config.residential.providers.evomi.enabled=provider==='evomi';const s=await session(provider+'-ceiling'),before=runs;
   await assert.rejects(v2.browserProbe('a',{idempotency_key:provider+'-ceiling',session_id:s.id,url:'https://source.example/data',max_estimated_micro_usd:5}),{code:'cost_ceiling_exceeded'});assert.equal(runs,before);
   for(mode of ['ok','source-failure','partial','unknown','incomplete-meter','late-error','close-error','missing','negative','cancel','overrun']){
    const s=await session(provider+'-'+mode),raw={idempotency_key:provider+'-'+mode,session_id:s.id,url:'https://source.example/data',max_estimated_micro_usd:9},result=await v2.browserProbe('a',raw),charge=result.accounting.customer_traffic;
    assert.equal(result.accounting.provider,provider);assert.equal(result.accounting.estimated_micro_usd,mode==='cancel'?0:5);assert.equal(result.accounting.customer_traffic_reservation.max_cost_usd,'0.000008192');
    assert.equal(charge.status,['ok','source-failure','partial','overrun'].includes(mode)?'measured':mode==='cancel'?'no_traffic':'unknown',mode);
    assert.equal(charge.cost_usd,['ok','source-failure','partial'].includes(mode)?'0.000000034':mode==='cancel'?'0.000000000':mode==='overrun'?'0.000008192':null,mode);
    if(mode==='partial')assert.equal(result.result.capture_complete,false);
    if(mode==='overrun'){assert.equal(charge.metered_bytes,4105);assert.equal(charge.billable_bytes,4096);}
    const before=runs;config.residential.providers[provider].microUsdPerGB=9e6;assert.deepEqual(await v2.browserProbe('a',raw),result);assert.equal(runs,before);config.residential.providers[provider].microUsdPerGB=1e6;
   }
  }
 }finally{await store.pool.query('TRUNCATE v2_registry,v2_ledger_events,v2_artifacts,v2_ledger,v2_operations,v2_sessions,workflows,source_limits RESTART IDENTITY CASCADE');await store.close();await rm(root,{recursive:true,force:true});}
});
