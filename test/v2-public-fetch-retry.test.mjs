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
import {server} from '../src/main.mjs';
import {fixedFeePoolFingerprint} from '../src/v2-pricing.mjs';

function fixture(root){
 const profile={id:'read',version:1,origins:['https://source.example'],paths:['^/'],methods:['GET','HEAD','POST'],headers:['accept','content-type'],proxy_classes:['direct','datacenter'],countries:['US'],limits:{max_requests:100,max_encoded_bytes:4096,max_decoded_bytes:8192,max_session_encoded_bytes:1000000,max_input_bytes:1024,max_tunnel_bytes:8192,max_redirects:0,max_expansion_ratio:100,timeout_ms:2000,min_interval_ms:0,ttl_seconds:900}};
 const config={release:'synthetic-public-retry',artifactDir:root,artifactKey:'46'.repeat(32),maxDailyFallbackCredits:0,projects:{a:{tokenHash:sha('synthetic-a'),profiles:[],v2_access_profiles:['read@1'],v2_entitlement:{mode:'unmetered'}},b:{tokenHash:sha('synthetic-b'),profiles:[],v2_access_profiles:['read@1']}},proxies:[{id:'private-member-a',country:'US',provider:'oxylabs',pool_id:'assigned-pool',dedicated_ip:'1.1.1.1',url:'http://fixture-user:fixture-secret@proxy-a.invalid:8080'},{id:'private-member-b',country:'US',provider:'oxylabs',pool_id:'assigned-pool',dedicated_ip:'8.8.8.8',url:'http://fixture-user:fixture-secret@proxy-b.invalid:8080'}],v2:{accessProfiles:{'read@1':profile}}};
 config.datacenterFixedFeePool={schema_version:1,id:'assigned-fixed-fee',reviewed:true,provider:'oxylabs',pool_id:'assigned-pool',countries:['US'],cost_scope:'incremental_traffic_only',fixed_subscription_allocation_micro_usd:null,provenance:{id:'private-authority',sha256:'a'.repeat(64),reviewed_at:'2026-11-01T00:00:00Z'},pool_fingerprint_sha256:fixedFeePoolFingerprint(config.proxies,['US'])};
 return config;
}

test('public retry opt-in executes once as a durable bounded native operation and recovers without source work',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 assert.match(new URL(process.env.TEST_DATABASE_URL).pathname,/^\/gateway_test_[A-Za-z0-9_]+$/);
 const root=await mkdtemp(join(tmpdir(),'fetchx-public-retry-')),store=new Store(process.env.TEST_DATABASE_URL);
 await store.init();
 await store.pool.query('TRUNCATE v2_registry,v2_ledger_events,v2_artifacts,v2_ledger,v2_operations,v2_sessions,workflows,source_limits RESTART IDENTITY CASCADE');
 const config=fixture(root),calls=[];let mode='ok',attempt=0;
 const gateway=new Gateway({store,config,profiles:{},resolve:async()=>[{address:'93.184.216.34',family:4}]});
 const http=async(input,destination,limits,{proxy})=>{
  calls.push({input,proxy});attempt++;
  if(mode==='connect'&&attempt===1)throw Object.assign(new GatewayError('proxy_connect_rejected',502),{message:'private upstream fixture-secret at proxy-a.invalid',provider_status:503,proxy_connected:true,proxy_request_dispatched:true,source_request_dispatched:false,observed_encoded_bytes:0,observed_tunnel_bytes:87});
  if(mode==='unknown'||mode==='source-then-unknown'&&attempt===2)throw Object.assign(new GatewayError('source_timeout_unknown',504),{cause_code:'ETIMEDOUT',observed_encoded_bytes:0,observed_tunnel_bytes:211});
  const status=mode==='forbidden'?403:mode==='challenge'||mode==='ok'||mode==='connect'?200:mode==='source'&&attempt>1?200:503;
  const headers={'content-type':mode==='challenge'?'text/html':'text/plain'};
  if(mode==='cooldown')headers['retry-after']='120';
  if(mode==='cookie'||mode==='connect'&&attempt===2)headers['set-cookie']=['sid=one; Path=/; Secure; HttpOnly'];
  return {status,headers,encoded:Buffer.from(mode==='challenge'?'<title>Robot check</title><form>Verify you are human</form>':status===200?'ok':'busy'),tunnel_bytes:500,provider_status:200};
 };
 gateway.v2=new V2Gateway(gateway,{http});
 const app=server(gateway),headers={authorization:'Bearer synthetic-a'};
 const payload=key=>({idempotency_key:key,access_profile:{id:'read',version:1},url:'https://source.example/data',proxy:{class:'datacenter',country:'US'}});
 const post=async body=>{const response=await app.inject({method:'POST',url:'/v2/fetch',headers,payload:body});return {status:response.statusCode,body:response.json()};};
 const get=async path=>{const response=await app.inject({url:path,headers});return {status:response.statusCode,body:response.json()};};
 const select=value=>{mode=value;attempt=0;};
 try{
  await t.test('boolean validation, old false/omitted fingerprints and true conflicts',async()=>{
   for(const retry of [null,0,1,'true',{},[]]){const before=calls.length,result=await post({...payload('invalid-'+calls.length),retry});assert.equal(result.status,400);assert.equal(result.body.error.code,'request_invalid');assert.equal(calls.length,before);}
   const omitted=await post(payload('historical-omitted')),count=calls.length;
   assert.equal(omitted.body.success,true);assert.equal(omitted.body.retry.requested,undefined);
   assert.deepEqual((await post({...payload('historical-omitted'),retry:false})).body,omitted.body);assert.equal(calls.length,count);
   const disabled=await post({...payload('explicit-false'),retry:false}),disabledCount=calls.length;
   assert.deepEqual((await post(payload('explicit-false'))).body,disabled.body);assert.equal(calls.length,disabledCount);
   const changed=await post({...payload('historical-omitted'),retry:true});assert.equal(changed.status,409);assert.equal(changed.body.error.code,'idempotency_conflict');assert.equal(calls.length,disabledCount);
  });
  await t.test('one response combines safe native attempts, both traffic totals, cookie continuity and durable replay',async()=>{
   select('connect');const before=calls.length,input={...payload('connect-retry'),retry:true,max_estimated_micro_usd:0},result=await post(input),body=result.body;
   assert.equal(result.status,200);assert.equal(body.success,true);assert.equal(calls.length,before+2);assert.equal(body.retry.requested,true);assert.equal(body.retry.attempts,2);assert.equal(body.retry.route_changed,true);assert.equal(body.retry.effective_session_id,body.session_id);assert.equal(body.retry.next_action,'complete');assert.equal(body.retry.same_key_replay_safe,true);
   assert.notEqual(calls.at(-2).proxy.id,calls.at(-1).proxy.id);assert.notEqual(calls.at(-2).proxy.dedicated_ip,calls.at(-1).proxy.dedicated_ip);
   assert.equal(body.data.status,200);assert.equal(body.data.text,'ok');assert.equal(body.usage.native_requests,1);assert.equal(body.usage.tunnel_bytes,587);assert.equal(body.usage.accounting.observed_tunnel_bytes,587);assert.equal(body.usage.accounting.estimated_micro_usd,0);assert.equal(body.usage.accounting.pricing.customer_traffic_charge_micro_usd,0);assert.equal(body.usage.accounting.invoice_micro_usd,null);assert.ok(body.usage.accounting.reserved_tunnel_bytes>=body.usage.tunnel_bytes);
   assert.equal(body.diagnostics.attempts.length,2);assert.equal(body.diagnostics.attempts[0].error,'proxy_connect_rejected');assert.equal(body.diagnostics.attempts[0].failure.provider_status,503);assert.equal(body.diagnostics.attempts[0].tunnel_bytes,87);assert.equal(body.diagnostics.attempts[1].error,null);assert.equal(body.diagnostics.attempts[1].route_changed,true);assert.equal(body.diagnostics.attempts[1].tunnel_bytes,500);
   const safe=JSON.stringify(body);for(const secret of ['fixture-secret','fixture-user','proxy-a.invalid','proxy-b.invalid','private-member-a','private-member-b','1.1.1.1','8.8.8.8'])assert.ok(!safe.includes(secret),secret);
   const saved=(await store.pool.query('SELECT input FROM v2_operations WHERE id=$1',[body.operation_id])).rows[0];assert.equal(gateway.v2.sealer.open(saved.input).retry,true);
   const ledgerBefore=(await store.pool.query('SELECT row_to_json(l) AS value FROM v2_ledger l WHERE operation=$1',[body.operation_id])).rows[0].value;
   const oldProfile=config.projects.a.v2_access_profiles;config.projects.a.v2_access_profiles=[];
   try{assert.deepEqual((await post(input)).body,body);assert.deepEqual((await get('/v2/fetch/connect-retry')).body,body);}finally{config.projects.a.v2_access_profiles=oldProfile;}
   const restarted=server({...gateway,v2:new V2Gateway(gateway,{http:async()=>{throw Error('recovery must not dispatch');}})});
   try{const recovered=await restarted.inject({url:'/v2/fetch/connect-retry',headers});assert.deepEqual(recovered.json(),body);}finally{await restarted.close();}
   assert.equal(calls.length,before+2);assert.deepEqual((await store.pool.query('SELECT row_to_json(l) AS value FROM v2_ledger l WHERE operation=$1',[body.operation_id])).rows[0].value,ledgerBefore);
   const projected=await get('/v2/fetch/operations/'+body.operation_id);assert.equal(projected.body.retry.attempts,2);assert.equal(projected.body.retry.same_key_replay_safe,false);assert.deepEqual(projected.body.diagnostics.attempts,body.diagnostics.attempts);
   const conflicting=await post({...input,retry:false});assert.equal(conflicting.status,409);assert.equal(conflicting.body.error.code,'idempotency_conflict');
   const pinned=calls.at(-1).proxy.id;select('ok');const continued=await post({...payload('continued'),session_id:body.session_id});assert.equal(continued.body.session_id,body.session_id);assert.equal(calls.at(-1).proxy.id,pinned);assert.match(calls.at(-1).input.headers.cookie,/sid=one/);
   select('always503');const count=calls.length,followup=await post({...payload('pinned-followup'),session_id:body.session_id,retry:true});assert.equal(calls.length,count+1);assert.equal(followup.body.retry.stop_reason,'retry_ineligible');assert.equal(followup.body.retry.route_changed,false);assert.equal(calls.at(-1).proxy.id,pinned);
  });
  await t.test('complete transient source responses retain both native artifacts in one operation',async()=>{
   select('source');const before=calls.length,result=await post({...payload('source-retry'),retry:true});assert.equal(result.body.success,true);assert.equal(calls.length,before+2);assert.equal(result.body.retry.attempts,2);assert.deepEqual(result.body.artifacts.map(a=>a.status),[503,200]);assert.equal(result.body.usage.native_requests,2);assert.equal(result.body.usage.encoded_bytes,6);assert.equal(result.body.usage.tunnel_bytes,1000);assert.equal(result.body.data.text,'ok');
  });
  await t.test('a second uncertain failure never presents the first response as the final response',async()=>{
   select('source-then-unknown');const before=calls.length,result=await post({...payload('second-unknown'),retry:true});assert.equal(calls.length,before+2);assert.equal(result.body.state,'unknown');assert.equal(result.body.error.code,'source_timeout_unknown');assert.equal(result.body.retry.attempts,2);assert.equal(result.body.retry.next_action,'recover_first');assert.equal(result.body.data.status,null);assert.equal(result.body.data.body_base64,null);assert.equal(result.body.data.text,null);assert.equal(result.body.artifacts[0].status,503);assert.equal(result.body.artifacts[0].attempt,1);assert.equal(result.body.usage.tunnel_bytes,711);assert.equal(result.body.diagnostics.attempts[1].error,'source_timeout_unknown');
  });
  await t.test('state, challenge, denial, cooldown and uncertain outcomes never trigger another source call',async()=>{
   for(const [name,changes,expected]of [['stateful',{method:'POST',body_base64:Buffer.from('stateful').toString('base64')},'retry_ineligible'],['direct',{proxy:{class:'direct',country:null}},'retry_route_unavailable'],['forbidden',{},'retry_not_transient'],['challenge',{},'retry_not_transient'],['cookie',{},'retry_not_transient'],['cooldown',{},'retry_not_transient'],['unknown',{},'retry_not_transient']]){
    select(['stateful','direct'].includes(name)?'always503':name);const before=calls.length,result=await post({...payload('no-retry-'+name),retry:true,...changes});assert.equal(calls.length,before+1,name);assert.equal(result.body.retry.requested,true,name);assert.equal(result.body.retry.attempts,1,name);assert.equal(result.body.retry.route_changed,false,name);assert.equal(result.body.retry.stop_reason,expected,name);assert.equal(result.body.diagnostics.attempts.length,1,name);
    if(name==='unknown'){assert.equal(result.body.state,'unknown');assert.equal(result.body.retry.next_action,'recover_first');assert.equal(result.body.retry.new_request_allowed,false);assert.equal(result.body.usage.accounting.invoice_micro_usd,null);}
    await store.pool.query('DELETE FROM source_limits');
   }
  });
  await t.test('two attempts remain the maximum and missing physical-route evidence cannot claim rotation',async()=>{
   select('always503');const before=calls.length,limited=await post({...payload('retry-limit'),retry:true});assert.equal(calls.length,before+2);assert.equal(limited.body.retry.attempts,2);assert.equal(limited.body.retry.stop_reason,'retry_limit');assert.equal(limited.body.success,false);assert.equal(limited.body.data.status,503);
   const inventory=structuredClone(config.proxies);delete config.proxies[0].dedicated_ip;delete config.proxies[1].dedicated_ip;
   try{select('always503');const count=calls.length,unavailable=await post({...payload('no-distinct-route'),retry:true});assert.equal(calls.length,count+1);assert.equal(unavailable.body.retry.route_changed,false);assert.equal(unavailable.body.retry.stop_reason,'retry_route_unavailable');}finally{config.proxies=inventory;}
  });
  await t.test('supporting proxy DNS remains within the aggregate traffic evidence and reservation',async()=>{
   const prior=config.v2.dns;let dnsCalls=0,dnsEncoded=0;
   config.v2.dns={allowed_hosts:['source.example'],use_session_proxy:true,fallback_resolvers:[{id:'fixture-resolver',endpoint:'https://resolver.example/resolve'}]};
   const dnsHttp=async(input,destination)=>{
    dnsCalls++;
    if(dnsCalls===1)throw Object.assign(new GatewayError('proxy_connect_rejected',502),{provider_status:503,proxy_connected:true,proxy_request_dispatched:true,source_request_dispatched:false,observed_encoded_bytes:0,observed_tunnel_bytes:87});
    const type=Number(destination.url.searchParams.get('type')),encoded=Buffer.from(JSON.stringify({Status:0,Question:[{name:'source.example',type}],Answer:type===1?[{name:'source.example',type:1,data:'93.184.216.34'}]:[]}));dnsEncoded+=encoded.length;
    return {status:200,headers:{},encoded,tunnel_bytes:100};
   };
   const dnsApp=server({...gateway,v2:new V2Gateway(gateway,{http,dnsHttp})});
   try{
    select('ok');const before=calls.length,response=await dnsApp.inject({method:'POST',url:'/v2/fetch',headers,payload:{...payload('dns-retry'),retry:true}}),body=response.json();
    assert.equal(response.statusCode,200);assert.equal(body.success,true);assert.equal(dnsCalls,3);assert.equal(calls.length,before+1);assert.equal(body.retry.attempts,2);assert.equal(body.usage.dns_requests,3);assert.equal(body.usage.native_requests,1);assert.equal(body.usage.encoded_bytes,dnsEncoded+2);assert.equal(body.usage.decoded_bytes,2);assert.equal(body.usage.tunnel_bytes,787);assert.equal(body.usage.accounting.observed_tunnel_bytes,787);assert.match(body.usage.byte_basis,/metered_session_proxy_dns/);assert.equal(body.diagnostics.attempts[0].dns_requests,1);assert.equal(body.diagnostics.attempts[0].failure.stage,'dns');assert.equal(body.diagnostics.attempts[0].failure.dns.attempts[0].resolver_id,'fixture-resolver');
   }finally{await dnsApp.close();if(prior===undefined)delete config.v2.dns;else config.v2.dns=prior;}
  });
 }finally{await app.close();await store.close();await rm(root,{recursive:true,force:true});}
});
