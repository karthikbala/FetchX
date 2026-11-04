import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {Store} from '../src/store.mjs';
import {Gateway} from '../src/gateway.mjs';
import {GatewayError} from '../src/policy.mjs';
import {sha} from '../src/crypto.mjs';
import {server} from '../src/main.mjs';
import {V2Gateway,recoverV2} from '../src/v2.mjs';
import {publicFetchFailure} from '../src/v2-public-fetch.mjs';

test('public fetch error envelopes never expose arbitrary exception text or cause properties',()=>{
 const error=Object.assign(new Error('private password and source URL'),{code:'secret-value',cause:{message:'private SQL'}});
 const result=publicFetchFailure(error,{key:'safe-key'});
 assert.equal(result.error.code,'internal_error');assert.equal(result.gateway_http_status,500);
 assert.equal(result.retry.next_action,'recover_first');assert.equal(result.retry.safe_to_retry,false);
 assert.ok(!JSON.stringify(result).includes('private'));assert.ok(!JSON.stringify(result).includes('secret-value'));
});

function configFor(root){
 const profile={id:'source',version:1,origins:['https://source.example'],paths:['^/'],methods:['GET','HEAD','POST'],headers:['accept','content-type'],proxy_classes:['direct','datacenter','residential'],countries:['US','GB'],limits:{max_requests:100,max_encoded_bytes:4096,max_decoded_bytes:16384,max_session_encoded_bytes:65536,max_input_bytes:1024,max_tunnel_bytes:8192,max_redirects:0,max_expansion_ratio:100,timeout_ms:2000,min_interval_ms:0,ttl_seconds:900}};
 const provider={enabled:true,username:'synthetic-user',password:'synthetic-password',countries:['US','GB'],maxTotalBytes:1e7,microUsdPerGB:1e6};
 return {release:'public-fetch-synthetic',artifactDir:root,artifactKey:'23'.repeat(32),maxDailyFallbackCredits:0,projects:{a:{tokenHash:sha('token-a'),profiles:[],v2_access_profiles:['source@1','other@1'],v2_entitlement:{mode:'unmetered'}},b:{tokenHash:sha('token-b'),profiles:[],v2_access_profiles:['source@1']}},proxies:[{id:'dc-us',country:'US',url:'http://dc-proxy.example:8080'},{id:'dc-gb',country:'GB',url:'http://dc-gb-proxy.example:8080'}],v2:{accessProfiles:{'source@1':profile,'other@1':{...structuredClone(profile),id:'other'}}},residential:{maxTotalBytes:1e7,maxDailyBytes:1e7,providers:{evomi:{...provider},dataimpulse:{...provider}}}};
}

test('public HTTP fetch: explicit routes, durable isolation/idempotency, retained evidence and failure guidance',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 assert.match(new URL(process.env.TEST_DATABASE_URL).pathname,/^\/gateway_test_[A-Za-z0-9]+$/);
 const root=await mkdtemp(join(tmpdir(),'fetchx-public-fetch-')),store=new Store(process.env.TEST_DATABASE_URL);
 await store.init();
 await store.pool.query('TRUNCATE v2_registry,v2_ledger_events,v2_artifacts,v2_ledger,v2_operations,v2_sessions,workflows,source_limits RESTART IDENTITY CASCADE');
 const config=configFor(root),calls=[],body=Buffer.from('{"value":42}'),encoded=gzipSync(body);
 const gateway=new Gateway({store,config,profiles:{},resolve:async()=>[{address:'93.184.216.34',family:4}]});
 let mode='json',entered,unblock;
 gateway.v2=new V2Gateway(gateway,{http:async(input,destination,limits,{proxy})=>{
  calls.push({input,proxy,address:destination.address});
  if(mode==='blocked'){entered?.();await new Promise(resolve=>{unblock=resolve;});}
  if(mode==='unknown')throw Object.assign(new GatewayError('source_timeout_unknown',504),{observed_encoded_bytes:0,observed_tunnel_bytes:400});
  if(mode==='proxy-unknown')throw Object.assign(new GatewayError('proxy_connect_unknown',502),{cause_code:'ECONNRESET',observed_encoded_bytes:0,observed_tunnel_bytes:400});
  if(mode==='tls-unknown')throw Object.assign(new GatewayError('source_transport_unknown',502),{cause_code:'CERT_HAS_EXPIRED',observed_encoded_bytes:0,observed_tunnel_bytes:400});
  const headers={'content-type':'application/json; charset=utf-8','content-encoding':'gzip','set-cookie':['sid=one; Path=/; Secure; HttpOnly'],'x-fixture-private':'fixture-private'};
  let value=encoded,status=200;
  if(mode==='403')status=403;
  if(mode==='404')status=404;
  if(mode==='429'){status=429;headers['retry-after']='120';}
  if(mode==='challenge'||mode==='comment'||mode==='post-challenge'){
   headers['content-type']='text/html; charset=UTF-8';delete headers['content-encoding'];
   value=Buffer.from(mode==='comment'?'<!-- verify you are human --><h1>ordinary page</h1>':'<title>Robot check</title><form>Verify you are human</form>');
  }
  if(mode==='pdf'){headers['content-type']='application/pdf';headers['content-disposition']='attachment; filename="native.pdf"';delete headers['content-encoding'];value=Buffer.from('%PDF-synthetic');}
  if(mode==='invalid-utf8'){headers['content-type']='text/plain';delete headers['content-encoding'];value=Buffer.from([0xc3,0x28]);}
  return {status,headers,raw_headers:Object.entries(headers).flat(),encoded:value,tunnel_bytes:proxy?500:null,provider_status:proxy?200:null};
 }});
 const app=server(gateway),auth={authorization:'Bearer token-a'},authB={authorization:'Bearer token-b'};
 const payload=(key,proxy={class:'datacenter',country:'US'})=>({idempotency_key:key,access_profile:{id:'source',version:1},url:'https://source.example/data',proxy});
 const post=async(input,headers=auth)=>{const response=await app.inject({method:'POST',url:'/v2/fetch',headers,payload:input});return {status:response.statusCode,body:response.json()};};
 const get=async(key,headers=auth)=>{const response=await app.inject({url:'/v2/fetch/'+encodeURIComponent(key),headers});return {status:response.statusCode,body:response.json()};};
 const noDispatch=async(fn)=>{const count=calls.length;await fn();assert.equal(calls.length,count);};
 let first;
 try{
  await t.test('authentication, explicit class/country, profile approval and unsupported browser capabilities',async()=>{
   for(const headers of [{},{authorization:'Bearer incorrect'}]){
    const denied=await post(payload('unauth'),headers);assert.equal(denied.status,401);assert.equal(denied.body.error.code,'unauthorized');assert.equal(denied.body.success,false);
   }
   assert.equal((await get('unauth',{})).status,401);
   await noDispatch(async()=>{
    for(const input of [{...payload('missing-proxy'),proxy:undefined},{...payload('missing-class'),proxy:{country:'US'}}])assert.equal((await post(input)).body.error.code,'proxy_required');
    for(const country of [undefined,null,'us','USA'])assert.equal((await post(payload('bad-country-'+String(country),{class:'residential',country}))).body.error.code,'country_required');
    assert.equal((await post(payload('direct-country',{class:'direct',country:'US'}))).body.error.code,'direct_country_unverified');
    assert.equal((await post(payload('forbidden-country',{class:'residential',country:'DE'}))).status,403);
    assert.equal((await post({...payload('forbidden-profile'),access_profile:{id:'unapproved',version:1}})).body.error.code,'access_profile_forbidden');
    assert.equal((await post({...payload('null-method'),method:null})).body.error.code,'method_rejected');
    assert.equal((await post({...payload('null-headers'),headers:null})).body.error.code,'headers_rejected');
    for(const option of ['render','browser','formats','actions','extract']){
     const denied=await post({...payload('unsupported-'+option),[option]:true});assert.equal(denied.status,409);assert.equal(denied.body.error.code,'capability_unsupported');assert.equal(denied.body.supported.transport,'http');
    }
    const malformed=await app.inject({method:'POST',url:'/v2/fetch',headers:{...auth,'content-type':'application/json'},payload:'{"private-secret":'});
    assert.equal(malformed.statusCode,400);assert.equal(malformed.json().error.code,'request_invalid');assert.ok(!malformed.body.includes('private-secret'));
   });
  });
  await t.test('native status, original gzip hashes, decoded response and read-only durable recovery',async()=>{
   first=await post(payload('dc-success'));assert.equal(first.status,200);assert.equal(first.body.success,true);assert.equal(first.body.state,'completed');
   assert.deepEqual(first.body.routing,{class:'datacenter',country:'US',provider:'configured_datacenter'});assert.equal(first.body.data.status,200);assert.equal(first.body.gateway_http_status,200);
   assert.equal(first.body.data.body_base64,body.toString('base64'));assert.equal(first.body.data.text,body.toString());
   assert.deepEqual(first.body.data.headers,{'content-type':'application/json; charset=utf-8','content-encoding':'gzip'});
   assert.equal(first.body.artifacts[0].encoded_sha256,sha(encoded));assert.equal(first.body.artifacts[0].decoded_sha256,sha(body));
   assert.equal(first.body.usage.accounting.invoice_micro_usd,null);assert.equal(first.body.usage.accounting.estimated_micro_usd,null);
   assert.equal(first.body.usage.native_requests,1);assert.equal(first.body.usage.dns_requests,0);assert.equal(first.body.application_acceptance,'not_evaluated');
   assert.equal(calls.at(-1).proxy.id,'dc-us');assert.equal(calls.at(-1).address,'93.184.216.34');
   await noDispatch(async()=>{
    assert.deepEqual((await post(payload('dc-success'))).body,first.body);assert.deepEqual((await get('dc-success')).body,first.body);
    config.projects.a.v2_access_profiles=[];assert.deepEqual((await post(payload('dc-success'))).body,first.body);assert.deepEqual((await get('dc-success')).body,first.body);config.projects.a.v2_access_profiles=['source@1','other@1'];
   });
   const renewal=server({...gateway,v2:new V2Gateway(gateway,{http:async()=>{throw Error('recovery must never dispatch');}})});
   try{const recovered=await renewal.inject({url:'/v2/fetch/dc-success',headers:auth});assert.deepEqual(recovered.json(),first.body);}finally{await renewal.close();}
   const bindings=(await store.pool.query("SELECT key,hash FROM v2_registry WHERE kind='public_fetch_request_v1'")).rows;
   assert.ok(bindings.length>0);assert.ok(bindings.every(row=>/^[a-f0-9]{64}$/.test(row.key)&&/^[a-f0-9]{64}$/.test(row.hash)));
  });
  await t.test('project isolation and changed request, body, route, country, profile, session and ceiling conflict',async()=>{
   await noDispatch(async()=>{
    assert.equal((await get('dc-success',authB)).status,404);
    const wrongSession=await post({...payload('cross-project'),session_id:first.body.session_id},authB);assert.equal(wrongSession.status,404);assert.equal(wrongSession.body.error.code,'session_not_found');
    for(const changes of [{url:'https://source.example/changed'},{method:'POST',body_base64:Buffer.from('changed').toString('base64')},{proxy:{class:'residential',country:'US'}},{proxy:{class:'datacenter',country:'GB'}},{access_profile:{id:'other',version:1}},{session_id:first.body.session_id},{max_estimated_micro_usd:0}]){
     const conflict=await post({...payload('dc-success'),...changes});assert.equal(conflict.status,409);assert.equal(conflict.body.error.code,'idempotency_conflict');
    }
   });
   const otherProject=await post(payload('dc-success'),authB);assert.equal(otherProject.body.success,true);assert.notEqual(otherProject.body.operation_id,first.body.operation_id);assert.notEqual(otherProject.body.session_id,first.body.session_id);
   const write={...payload('body-conflict'),method:'POST',body_base64:Buffer.from('first').toString('base64')};assert.equal((await post(write)).body.success,true);
   await noDispatch(async()=>{const conflict=await post({...write,body_base64:Buffer.from('second').toString('base64')});assert.equal(conflict.status,409);assert.equal(conflict.body.error.code,'idempotency_conflict');});
  });
  await t.test('residential primary/backup selection and provided cookie-session continuity never change a pinned provider',async()=>{
   const residential=await post(payload('res-success',{class:'residential',country:'US'}));assert.equal(residential.body.success,true);assert.equal(residential.body.routing.provider,'evomi');assert.equal(residential.body.routing.country,'US');
   const proxy=calls.at(-1).proxy.url;
   const continued=await post({...payload('continued',{class:'residential',country:'US'}),session_id:residential.body.session_id});
   assert.equal(continued.body.session_id,residential.body.session_id);assert.equal(calls.at(-1).proxy.url,proxy);assert.match(calls.at(-1).input.headers.cookie,/sid=one/);
   await noDispatch(async()=>{
    assert.equal((await post({...payload('session-class-conflict'),session_id:residential.body.session_id})).body.error.code,'session_route_conflict');
    assert.equal((await post({...payload('session-country-conflict',{class:'residential',country:'GB'}),session_id:residential.body.session_id})).status,409);
    assert.equal((await post({...payload('session-profile-conflict',{class:'residential',country:'US'}),access_profile:{id:'other',version:1},session_id:residential.body.session_id})).body.error.code,'session_profile_conflict');
   });
   config.residential.providers.evomi.enabled=false;
   const backup=await post(payload('res-backup',{class:'residential',country:'US'}));assert.equal(backup.body.routing.provider,'dataimpulse');assert.equal(backup.body.success,true);
   await noDispatch(async()=>{
    const pinned=await post({...payload('no-pinned-switch',{class:'residential',country:'US'}),session_id:residential.body.session_id});assert.equal(pinned.body.success,false);assert.equal(pinned.body.routing.provider,'evomi');assert.equal(pinned.body.error.code,'residential_provider_unavailable');
   });
   config.residential.providers.evomi.enabled=true;
  });
  await t.test('concurrent exact POSTs dispatch at most once and an active response directs recovery',async()=>{
   mode='blocked';const start=new Promise(resolve=>{entered=resolve;});const input=payload('concurrent'),count=calls.length;
   const pending=post(input);await start;
   try{
    const duplicate=await post(input);assert.equal(duplicate.status,200);assert.equal(duplicate.body.success,false);assert.ok(['reserved','running'].includes(duplicate.body.state));assert.equal(duplicate.body.retry.next_action,'recover_first');assert.equal(calls.length,count+1);
    const conflict=await post({...input,url:'https://source.example/different'});assert.equal(conflict.status,409);assert.equal(calls.length,count+1);
   }finally{unblock();}
   const completed=await pending;assert.equal(completed.body.success,true);assert.deepEqual((await get('concurrent')).body,completed.body);assert.equal(calls.length,count+1);mode='json';
   const pair=await Promise.all([post(payload('concurrent-new')),post(payload('concurrent-new'))]);
   assert.equal(pair[0].status,200);assert.equal(pair[1].status,200);assert.equal(pair[0].body.operation_id,pair[1].body.operation_id);assert.equal(calls.length,count+2);
  });
  await t.test('403/challenge/404/429 preserve source status and never escalate class or country',async()=>{
   for(const [selected,code,action] of [['403','source_forbidden','consider_approved_residential_fresh_session'],['challenge','source_challenge','consider_approved_residential_fresh_session'],['404','source_not_found','check_url'],['429','source_rate_limited','wait_for_source_retry_after']]){
    mode=selected;const count=calls.length,result=await post(payload('source-'+selected));
    assert.equal(result.status,200);assert.equal(result.body.gateway_http_status,200);assert.equal(result.body.success,false);assert.equal(result.body.state,'completed');assert.equal(result.body.error.code,code);assert.equal(result.body.error.stage,'source_response');assert.equal(result.body.retry.next_action,action);assert.equal(result.body.retry.safe_to_retry,['403','challenge'].includes(selected));assert.equal(result.body.retry.new_request_allowed,['403','challenge'].includes(selected));assert.equal(result.body.retry.same_key_replay_safe,true);
    assert.equal(result.body.data.status,selected==='challenge'?200:Number(selected));assert.equal(result.body.routing.class,'datacenter');assert.equal(result.body.routing.country,'US');assert.equal(calls.length,count+1);
    if(selected==='403'||selected==='challenge')assert.deepEqual(result.body.retry.suggested_proxy,{class:'residential',country:'US'});
    if(selected==='429'){assert.equal(result.body.retry.retry_after,'120');assert.equal(result.body.retry.suggested_proxy,undefined);}
    await noDispatch(async()=>{assert.deepEqual((await get('source-'+selected)).body,result.body);});
   }
   await store.pool.query('DELETE FROM source_limits');mode='comment';assert.equal((await post(payload('comment'))).body.success,true);
   mode='post-challenge';const stateful=await post({...payload('post-challenge'),method:'POST',body_base64:Buffer.from('stateful').toString('base64')});assert.equal(stateful.body.error.code,'source_challenge');assert.equal(stateful.body.retry.next_action,'recover_first');assert.equal(stateful.body.retry.suggested_proxy,undefined);
   mode='403';const direct=await post(payload('direct-forbidden',{class:'direct',country:null}));assert.equal(direct.body.routing.provider,'direct');assert.equal(direct.body.retry.next_action,'review_source_access');assert.equal(direct.body.retry.suggested_proxy,undefined);assert.equal(calls.at(-1).proxy,null);
   mode='json';
  });
  await t.test('unknown operations, retained partial evidence and held charges only recover',async()=>{
   mode='unknown';const input=payload('uncertain',{class:'residential',country:'US'}),count=calls.length,result=await post(input);
   assert.equal(result.body.state,'unknown');assert.equal(result.body.error.code,'source_timeout_unknown');assert.equal(result.body.retry.next_action,'recover_first');assert.equal(result.body.usage.accounting.invoice_micro_usd,null);assert.equal(result.body.usage.accounting.reserved_tunnel_bytes,8192);assert.equal(calls.length,count+1);
   const ledger=(await store.pool.query('SELECT state,accounted_tunnel_bytes FROM v2_ledger WHERE operation=$1',[result.body.operation_id])).rows[0];assert.equal(ledger.state,'unknown');assert.equal(Number(ledger.accounted_tunnel_bytes),8192);
   await noDispatch(async()=>{
    assert.deepEqual((await post(input)).body,result.body);assert.deepEqual((await get('uncertain')).body,result.body);
    const denied=await post({...payload('unknown-session-next',{class:'residential',country:'US'}),session_id:result.body.session_id});assert.equal(denied.body.error.code,'session_busy_or_unknown');assert.equal(denied.body.retry.next_action,'recover_first');
   });
   mode='json';const partial=await post(payload('interrupted'));await store.pool.query("UPDATE v2_operations SET state='running',result=NULL,summary=NULL,finished_at=NULL WHERE id=$1",[partial.body.operation_id]);await recoverV2(store.pool);
   await noDispatch(async()=>{
    const recovered=await get('interrupted');assert.equal(recovered.body.state,'unknown');assert.equal(recovered.body.success,false);assert.equal(recovered.body.data.body_base64,body.toString('base64'));assert.equal(recovered.body.usage.native_requests,null);assert.equal(recovered.body.usage.dns_requests,null);assert.equal(recovered.body.retry.next_action,'recover_first');assert.equal(recovered.body.artifacts[0].encoded_sha256,sha(encoded));
   });
  });
  await t.test('safe DNS, proxy and TLS provenance reaches the facade without exception text',async()=>{
   const originalResolve=gateway.v2.resolve;
   gateway.v2.resolve=async()=>{throw Object.assign(new GatewayError('source_dns_not_found',502),{cause_code:'ENOTFOUND',dns_diagnostics:{attempts:[{resolver_id:'synthetic-resolver',code:'ENOTFOUND',rcode:3,extended_dns_errors:[]}]}});};
   try{await noDispatch(async()=>{
    const dns=await post(payload('dns-failed'));assert.equal(dns.body.success,false);assert.equal(dns.body.error.code,'source_dns_not_found');assert.match(dns.body.error.message,/DNS/);assert.equal(dns.body.error.stage,'dns');assert.equal(dns.body.diagnostics.failure.request_dispatched,false);assert.equal(dns.body.diagnostics.failure.cause_code,'ENOTFOUND');assert.equal(dns.body.diagnostics.failure.dns.attempts[0].resolver_id,'synthetic-resolver');assert.equal(dns.body.usage.native_requests,0);
   });}finally{gateway.v2.resolve=originalResolve;}
   for(const selected of ['proxy-unknown','tls-unknown']){
    mode=selected;const result=await post(payload(selected));assert.equal(result.body.state,'unknown');assert.equal(result.body.retry.next_action,'recover_first');assert.equal(result.body.retry.new_request_allowed,false);assert.equal(result.body.diagnostics.failure.request_dispatched,true);assert.equal(result.body.error.stage,'transport');assert.match(result.body.error.message,selected==='proxy-unknown'?/proxy/i:/TLS/);
   }
   mode='json';
  });
  await t.test('post-operation formatting failures are uncertain and recover the original operation without dispatch',async()=>{
   const originalArtifact=gateway.v2.artifact,count=calls.length;
   gateway.v2.artifact=async()=>{throw new Error('private artifact database/password failure');};
   let failed;
   try{failed=await post(payload('formatting-failure'));}finally{gateway.v2.artifact=originalArtifact;}
   assert.equal(failed.status,500);assert.equal(failed.body.state,'unknown');assert.equal(failed.body.error.stage,'response_reconstruction');assert.ok(failed.body.operation_id);assert.ok(failed.body.session_id);assert.equal(failed.body.retry.next_action,'recover_first');assert.equal(failed.body.retry.new_request_allowed,false);assert.equal(failed.body.retry.same_key_replay_safe,true);assert.ok(!JSON.stringify(failed.body).includes('password'));assert.equal(calls.length,count+1);
   await noDispatch(async()=>{const recovered=await get('formatting-failure');assert.equal(recovered.body.success,true);assert.equal(recovered.body.operation_id,failed.body.operation_id);assert.deepEqual((await post(payload('formatting-failure'))).body,recovered.body);});
  });
  await t.test('quota/cost/budget admission failures allocate no financial allowance or source work',async()=>{
   const beforeOperations=(await store.pool.query('SELECT count(*)::int AS n FROM v2_operations')).rows[0].n;
   await noDispatch(async()=>{
    config.projects.a.v2_entitlement={mode:'metered',max_daily_operations:1};const quota=await post(payload('quota'));assert.equal(quota.status,429);assert.equal(quota.body.error.code,'client_quota_exhausted');assert.equal(quota.body.retry.next_action,'review_quota_or_budget');config.projects.a.v2_entitlement={mode:'unmetered'};
    const ceiling=await post({...payload('ceiling',{class:'residential',country:'US'}),max_estimated_micro_usd:0});assert.equal(ceiling.status,429);assert.equal(ceiling.body.error.code,'cost_ceiling_exceeded');
    const unknownEstimate=await post({...payload('dc-ceiling'),max_estimated_micro_usd:0});assert.equal(unknownEstimate.status,409);assert.equal(unknownEstimate.body.error.code,'cost_estimate_unavailable');
    config.residential.maxTotalBytes=1;const budget=await post(payload('budget',{class:'residential',country:'US'}));assert.equal(budget.status,429);assert.equal(budget.body.error.code,'residential_budget_exhausted');config.residential.maxTotalBytes=1e7;
    const count=(await store.pool.query('SELECT count(*)::int AS n FROM v2_operations')).rows[0].n;assert.equal(count,beforeOperations);
    const allocated=await store.pool.query("SELECT requests,encoded_bytes FROM v2_sessions s WHERE NOT EXISTS(SELECT 1 FROM v2_operations o WHERE o.session_id=s.id)");assert.ok(allocated.rows.length>=3);assert.ok(allocated.rows.every(row=>row.requests===0&&Number(row.encoded_bytes)===0));
   });
   const retry=await post(payload('quota'));assert.equal(retry.body.success,true);
  });
  await t.test('binary bodies and invalid UTF-8 never become text; native v2 contract remains available',async()=>{
   mode='pdf';const pdf=await post(payload('pdf'));assert.equal(pdf.body.success,true);assert.equal(pdf.body.data.text,null);assert.equal(Buffer.from(pdf.body.data.body_base64,'base64').toString(),'%PDF-synthetic');assert.equal(pdf.body.artifacts[0].kind,'download');
   mode='invalid-utf8';const invalid=await post(payload('invalid-utf8'));assert.equal(invalid.body.data.text,null);assert.equal(invalid.body.data.body_base64,Buffer.from([0xc3,0x28]).toString('base64'));
   const native=await app.inject({url:'/v2/operations/'+first.body.operation_id,headers:auth});assert.equal(native.statusCode,200);assert.equal(native.json().id,first.body.operation_id);assert.ok(Object.hasOwn(native.json(),'accounting'));assert.equal(native.json().gateway_http_status,undefined);
  });
  await t.test('read-only by-ID projection migrates native HTTP evidence and keeps internal caller keys distinct',async()=>{
   mode='json';const nativeSession=await gateway.v2.session('a',{idempotency_key:'native-session',access_profile:{id:'source',version:1},transport:'http',proxy:{class:'datacenter',country:'US',affinity:'session'}});
   const native=await gateway.v2.operation('a',{idempotency_key:'original-native-key',session_id:nativeSession.id,request:{url:'https://source.example/data'}});
   const byId=async(id,headers=auth)=>{const response=await app.inject({url:'/v2/fetch/operations/'+id,headers});return {status:response.statusCode,body:response.json()};};
   await noDispatch(async()=>{
    const projected=await byId(native.id);assert.equal(projected.status,200);assert.equal(projected.body.success,true);assert.equal(projected.body.idempotency_key,'original-native-key');assert.equal(projected.body.idempotency_key_scope,'native_operation');assert.equal(projected.body.retry.lookup_url,'/v2/fetch/operations/'+native.id);assert.equal(projected.body.retry.same_key_replay_safe,false);assert.equal(projected.body.artifacts[0].encoded_sha256,sha(encoded));
    const internal=await byId(first.body.operation_id);assert.equal(internal.body.idempotency_key,null);assert.equal(internal.body.idempotency_key_scope,'internal_operation');assert.match(internal.body.internal_idempotency_key,/^public-fetch\.o\.[a-f0-9]{32}$/);assert.equal(internal.body.retry.lookup_url,'/v2/fetch/operations/'+first.body.operation_id);assert.equal(internal.body.retry.same_key_replay_safe,false);
    const originalArtifact=gateway.v2.artifact;
    gateway.v2.artifact=async()=>{throw new Error('private projection artifact/password failure');};
    try{
     for(const [id,key,keyScope] of [[native.id,'original-native-key','native_operation'],[first.body.operation_id,null,'internal_operation']]){
      const failed=await byId(id);assert.equal(failed.status,500);assert.equal(failed.body.state,'unknown');assert.equal(failed.body.operation_id,id);assert.equal(failed.body.idempotency_key,key);assert.equal(failed.body.idempotency_key_scope,keyScope);assert.equal(failed.body.error.stage,'response_reconstruction');assert.equal(failed.body.retry.same_key_replay_safe,false);assert.equal(failed.body.retry.new_request_allowed,false);assert.equal(failed.body.retry.lookup_url,'/v2/fetch/operations/'+id);assert.ok(!JSON.stringify(failed.body).includes('password'));
     }
    }finally{gateway.v2.artifact=originalArtifact;}
    assert.equal((await byId(native.id)).body.success,true);assert.equal((await byId(first.body.operation_id)).body.success,true);
    assert.equal((await byId(native.id,authB)).status,404);assert.equal((await byId(native.id,{})).status,401);
    await store.pool.query("UPDATE v2_operations SET kind='browser_probe' WHERE id=$1",[native.id]);
    const unsupported=await byId(native.id);assert.equal(unsupported.status,409);assert.equal(unsupported.body.error.code,'capability_unsupported');assert.equal(unsupported.body.operation_id,native.id);assert.equal(unsupported.body.retry.same_key_replay_safe,false);assert.equal(unsupported.body.idempotency_key_scope,'native_operation');
   });
  });
 }finally{await app.close();await store.close();await rm(root,{recursive:true,force:true});}
});
