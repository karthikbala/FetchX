import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CookieJar} from 'tough-cookie';
import net from 'node:net';
import {nativeHttp} from '../src/v2-http.mjs';
import {Gateway} from '../src/gateway.mjs';
import {V2Gateway,recoverV2} from '../src/v2.mjs';
import {Store} from '../src/store.mjs';
import {GatewayError} from '../src/policy.mjs';
import {sha} from '../src/crypto.mjs';
import {fixedFeePoolFingerprint} from '../src/v2-pricing.mjs';
import {distinctNativeRetryRoute,pristineNativeRetry,transientNativeResponse,transientNativeTransport} from '../src/v2-native-retry.mjs';

const route={class:'datacenter',country:'US',provider:'configured_datacenter',proxy_id:'a',affinity:'session'};
const member=(id,ip,port,country='US')=>({id,country,provider:'oxylabs',pool_id:'assigned',url:`http://fixture:private-password@127.0.0.1:${port}/`,dedicated_ip:ip});
const refusal=()=>Object.assign(new GatewayError('proxy_connect_refused',502),{cause_code:'ECONNREFUSED',proxy_connected:false,proxy_request_dispatched:false,observed_tunnel_bytes:0,observed_encoded_bytes:0});
const rejected=(status=503)=>Object.assign(new GatewayError('proxy_connect_rejected',502),{provider_status:status,proxy_connected:true,proxy_request_dispatched:true,source_request_dispatched:false,observed_tunnel_bytes:111,observed_encoded_bytes:0});
const response=(status=200,headers={},body='synthetic')=>({status,headers:{'content-type':'text/plain',...headers},encoded:Buffer.from(body),tunnel_bytes:500,provider_status:200});

test('retry backup rotates through verified distinct dedicated members and never treats aliases as second IPs',()=>{
 const config={proxies:[member('a','93.184.216.34',18001),member('a-alias','93.184.216.34',18002),member('endpoint-alias','93.184.216.35',18001),member('b','93.184.216.36',18003),member('c','93.184.216.37',18004),member('foreign','93.184.216.38',18005,'IN')]};
 assert.equal(distinctNativeRetryRoute(config,route).proxy_id,'b');
 assert.equal(distinctNativeRetryRoute(config,{...route,proxy_id:'b'}).proxy_id,'c');
 assert.equal(distinctNativeRetryRoute(config,{...route,proxy_id:'c'}).proxy_id,'a');
 for(const ip of [undefined,'127.0.0.1','10.0.0.1','093.184.216.34','::ffff:93.184.216.34']){
  const changed=structuredClone(config);changed.proxies[0].dedicated_ip=ip;assert.equal(distinctNativeRetryRoute(changed,route),null);
 }
 assert.equal(distinctNativeRetryRoute({proxies:config.proxies.slice(0,3)},route),null);
 assert.equal(distinctNativeRetryRoute(config,{...route,class:'residential'}),null);
});

test('retry only admits a pristine credential-free initial GET/HEAD and positive transient evidence',()=>{
 const profile={credential_headers:['x-custom-secret']},session={requests:0,encoded_bytes:0,cookie_jar:new CookieJar().serializeSync()},input={url:'https://source.example/data',method:'GET',headers:{},body:null};
 assert.equal(pristineNativeRetry(session,input,null,profile),true);
 for(const changes of [{method:'POST'},{headers:{AUTHORIZATION:'Bearer private'}},{headers:{'X-Custom-Secret':'private'}},{url:'https://source.example/data?token=private'},{url:'https://source.example/logout'},{body:Buffer.alloc(0)}])assert.equal(pristineNativeRetry(session,{...input,...changes},null,profile),false);
 for(const changes of [{requests:1},{encoded_bytes:1},{cookie_jar:{...session.cookie_jar,cookies:[{key:'sid',value:'private',domain:'source.example',path:'/',hostOnly:true}]}}])assert.equal(pristineNativeRetry({...session,...changes},input,null,profile),false);
 assert.equal(transientNativeTransport(refusal()),true);assert.equal(transientNativeTransport(rejected()),true);
 for(const error of [rejected(403),rejected(429),{...rejected(),source_request_dispatched:undefined},{...rejected(),proxy_retry_after:true},{...rejected(),provider_reason:'ERR_ACCESS_DENIED'},new GatewayError('source_timeout_unknown',502)])assert.equal(transientNativeTransport(error),false);
 for(const headers of [{'Retry-After':'0'},{'SET-COOKIE':[]},{location:'/next'},{'cf-mitigated':'challenge'}])assert.equal(transientNativeResponse(response(503,headers),Buffer.from('temporary'),'https://source.example/data'),false);
 assert.equal(transientNativeResponse(response(503),Buffer.from('temporary'),'https://source.example/data'),true);
});

function config(root){
 const profile={id:'source',version:1,origins:['https://source.example'],methods:['GET','HEAD','POST'],headers:['accept','authorization','x-custom-secret'],credential_headers:['authorization','x-custom-secret'],proxy_classes:['datacenter','direct','residential'],countries:['US'],limits:{max_requests:5,max_encoded_bytes:4096,max_decoded_bytes:8192,max_session_encoded_bytes:65536,max_input_bytes:1024,max_tunnel_bytes:8192,max_redirects:0,max_expansion_ratio:100,timeout_ms:2000,min_interval_ms:0,ttl_seconds:900}};
 const c={release:'synthetic-native-retry',artifactDir:root,artifactKey:'21'.repeat(32),maxDailyFallbackCredits:0,projects:{a:{tokenHash:sha('synthetic-project'),profiles:[],v2_access_profiles:['source@1']}},proxies:[member('a','93.184.216.34',18001),member('b','93.184.216.35',18002),member('c','93.184.216.36',18003)],v2:{accessProfiles:{'source@1':profile},dns:{allowed_hosts:['source.example'],fallback_resolvers:[{id:'approved',endpoint:'https://resolver.example/resolve'}],use_session_proxy:true}}};
 c.datacenterFixedFeePool={schema_version:1,id:'fixed',reviewed:true,provider:'oxylabs',pool_id:'assigned',countries:['US'],cost_scope:'incremental_traffic_only',fixed_subscription_allocation_micro_usd:null,provenance:{id:'private-inventory',sha256:'a'.repeat(64),reviewed_at:new Date(Date.now()-60000).toISOString()},pool_fingerprint_sha256:fixedFeePoolFingerprint(c.proxies,['US'])};return c;
}
async function fixture(run,{dns=false,maxRequests=5,limits={}}={}){
 const root=await mkdtemp(join(tmpdir(),'native-retry-')),store=new Store(process.env.TEST_DATABASE_URL);await store.init();
 await store.pool.query('TRUNCATE v2_registry,v2_discovery_profiles,v2_ledger_events,v2_artifacts,v2_ledger,v2_operations,v2_sessions,workflows,source_limits RESTART IDENTITY CASCADE');
 const settings=config(root);Object.assign(settings.v2.accessProfiles['source@1'].limits,{max_requests:maxRequests},limits);if(!dns)delete settings.v2.dns;
 const calls=[],dnsCalls=[];let source=async()=>response(),dnsSource=async(input,dest)=>{
  const type=Number(dest.url.searchParams.get('type'));return response(200,{'content-type':'application/dns-json'},JSON.stringify({Status:0,Question:[{name:'source.example',type}],Answer:type===1?[{name:'source.example',type:1,data:'93.184.216.34'}]:[]}));
 };
 const gateway=new Gateway({store,config:settings,profiles:{},resolve:async()=>[{address:'93.184.216.34',family:4}]});
 const v2=new V2Gateway(gateway,{http:async(...args)=>{calls.push(args);return source(...args);},dnsHttp:async(...args)=>{dnsCalls.push(args);return dnsSource(...args);}});
 const createSession=async(key='session')=>v2.session('a',{idempotency_key:key,access_profile:{id:'source',version:1},transport:'http',proxy:{class:'datacenter',country:'US',affinity:'session'}});
 const s=await createSession();
 // Stable fixture primary without changing operator configuration.
 await store.pool.query('UPDATE v2_sessions SET route=$2 WHERE id=$1',[s.id,gateway.sealer.seal(route)]);
 const input={idempotency_key:'operation',session_id:s.id,request:{url:'https://source.example/data'},retry:true};
 try{await run({store,settings,gateway,v2,calls,dnsCalls,session:s,input,createSession,setSource:fn=>source=fn,setDns:fn=>dnsSource=fn,defaultDns:()=>dnsSource});}
 finally{await store.close();await rm(root,{recursive:true,force:true});}
}
const enabled=!!process.env.TEST_DATABASE_URL;
if(enabled)assert.match(new URL(process.env.TEST_DATABASE_URL).pathname,/^\/gateway_test_[A-Za-z0-9_]+$/);

test('native retry retains one operation/key, all attempt traffic, winning affinity and false/omitted historical hashes',{skip:!enabled},async()=>{
 await fixture(async({store,v2,calls,session,input,setSource})=>{
  setSource(async()=>{if(calls.length===1)throw rejected();return response();});
  const result=await v2.operation('a',input);
  assert.equal(result.state,'completed');assert.equal(result.result.status,200);assert.equal(result.result.retry.attempts,2);assert.equal(result.result.retry.route_changed,true);assert.equal(result.result.retry.effective_session_id,session.id);assert.equal(result.result.retry.stop_reason,null);
  assert.deepEqual(result.result.diagnostics.attempts.map(a=>a.source_status),[null,200]);assert.equal(result.result.physical_requests,1);assert.equal(result.result.tunnel_bytes,611);assert.equal(result.result.diagnostics.attempts[0].failure.provider_status,503);
  assert.notEqual(calls[0][3].proxy.id,calls[1][3].proxy.id);assert.equal(calls[1][3].proxy.id,'b');
  assert.equal((await v2.operation('a',input)).id,result.id);assert.equal(calls.length,2);
  assert.equal((await store.pool.query('SELECT count(*)::int n FROM v2_operations')).rows[0].n,1);
  const ledger=(await store.pool.query('SELECT * FROM v2_ledger')).rows[0];assert.equal(Number(ledger.observed_tunnel_bytes),611);assert.equal(Number(ledger.accounted_tunnel_bytes),8192);assert.equal(ledger.state,'unreconciled');
  const saved=await v2.owned('a',session.id);assert.equal(v2.sealer.open(saved.route).proxy_id,'b');
  assert.doesNotMatch(JSON.stringify(result),/93\.184|127\.0|private-password|pool_fingerprint|dedicated_ip/);
  const fresh=await v2.session('a',{idempotency_key:'false-session',access_profile:{id:'source',version:1},transport:'http',proxy:{class:'direct',country:null,affinity:'session'}}),plain={...input,idempotency_key:'legacy',session_id:fresh.id};delete plain.retry;
  const ordinary=await v2.operation('a',plain);assert.equal((await v2.operation('a',{...plain,retry:false})).id,ordinary.id);
  await assert.rejects(v2.operation('a',{...plain,retry:true}),{code:'idempotency_conflict'});
  for(const retry of [null,0,1,'true',{}])await assert.rejects(v2.operation('a',{...plain,retry}),{code:'request_invalid'});
 });
});

test('historical DNS-only CONNECT 503 can change member at max_requests=1 while preserving paid hold and DNS traffic',{skip:!enabled},async()=>{
 await fixture(async({v2,calls,dnsCalls,input,setDns,defaultDns,store})=>{
  const fallback=defaultDns();setDns(async(...args)=>{if(dnsCalls.length===1)throw rejected();return fallback(...args);});
  const result=await v2.operation('a',input);
  assert.equal(result.state,'completed');assert.equal(result.result.status,200);assert.equal(calls.length,1);assert.equal(dnsCalls.length,3);assert.equal(result.result.physical_requests,1);assert.equal(result.result.dns_requests,3);assert.equal(result.result.tunnel_bytes,1611);
  const [first,second]=result.result.diagnostics.attempts;assert.equal(first.stage,'dns');assert.equal(first.failure.provider_status,503);assert.equal(first.failure.request_dispatched,false);assert.equal(first.dns_requests,1);assert.equal(second.dns_requests,2);
  assert.equal(result.result.encoded_bytes,211);
  assert.equal(first.encoded_bytes+second.encoded_bytes,result.result.encoded_bytes);
  const ledger=(await store.pool.query('SELECT * FROM v2_ledger')).rows[0];assert.equal(Number(ledger.accounted_tunnel_bytes),8192);assert.equal(ledger.state,'unreconciled');
 },{dns:true,maxRequests:1});
});

test('complete source 503 is audited but never becomes final response after backup fails; no third attempt',{skip:!enabled},async()=>{
 await fixture(async({v2,calls,input,setSource})=>{
  setSource(async()=>{if(calls.length===1)return response(503,{},'temporarily unavailable');throw rejected();});
  const result=await v2.operation('a',input);
  assert.equal(calls.length,2);assert.equal(result.state,'failed');assert.equal(result.result.status,null);assert.equal(result.result.final_url,null);assert.equal(result.result.final_artifact_id,null);assert.equal(result.result.artifacts.length,1);assert.equal(result.result.artifacts[0].attempt,1);assert.equal(result.result.retry.stop_reason,'retry_limit');
  assert.equal(result.result.encoded_bytes,23);assert.equal(result.result.tunnel_bytes,611);assert.equal(result.result.diagnostics.attempts[0].artifacts.length,1);
 });
});

test('source request limit blocks a second dispatched source response but permits definite pre-source refusal',{skip:!enabled},async()=>{
 await fixture(async({v2,calls,input,setSource})=>{
  setSource(async()=>response(503));const result=await v2.operation('a',input);assert.equal(calls.length,1);assert.equal(result.result.retry.stop_reason,'retry_request_limit');
 },{maxRequests:1});
 await fixture(async({v2,calls,input,setSource})=>{
  setSource(async()=>{if(calls.length===1)throw refusal();return response();});const result=await v2.operation('a',input);assert.equal(calls.length,2);assert.equal(result.state,'completed');assert.equal(result.result.physical_requests,1);
 },{maxRequests:1});
});

test('session history, cookies, redirects, credentials and uncertain work cannot change native identity',{skip:!enabled},async()=>{
 for(const mode of ['history','cookies','credentials','redirect','unknown','challenge','retry-after','denial'])await fixture(async({store,v2,calls,input,session,setSource})=>{
  if(mode==='history'){
   const previous={...input,idempotency_key:'previous'};delete previous.retry;setSource(async()=>{throw refusal();});await v2.operation('a',previous);
  }
  if(mode==='cookies'){const jar=new CookieJar();await jar.setCookie('sid=private; Secure','https://source.example');await store.pool.query('UPDATE v2_sessions SET cookie_jar=$2 WHERE id=$1',[session.id,v2.sealer.seal(jar.serializeSync())]);}
  if(mode==='credentials')input.request.headers={'X-Custom-Secret':'private'};
  const before=calls.length;setSource(async()=>{
   if(mode==='redirect')return response(302,{location:'/next'});
   if(mode==='unknown')throw Object.assign(new GatewayError('source_timeout_unknown',502),{observed_tunnel_bytes:111,observed_encoded_bytes:0});
   if(mode==='challenge')return response(503,{'content-type':'text/html'},'<title>Security check</title><script src="/cdn-cgi/challenge-platform/test"></script>');
   if(mode==='retry-after')return response(503,{'retry-after':'0'});
   if(mode==='denial')throw rejected(403);
   throw rejected();
  });
  const result=await v2.operation('a',input);assert.equal(calls.length-before,1,mode);assert.equal(result.result.retry.route_changed,false,mode);assert.equal(result.result.retry.attempts,1,mode);
 });
});

test('same-key concurrency does not dispatch twice and restart after retry admission only exposes unknown audit',{skip:!enabled},async()=>{
 await fixture(async({store,v2,calls,input,setSource})=>{
  let release,started;const gate=new Promise(r=>release=r),start=new Promise(r=>started=r);
  setSource(async()=>{if(calls.length===1){started();await gate;throw rejected();}return response();});
  const pending=v2.operation('a',input);await start;
  const replay=await v2.operation('a',input);assert.equal(replay.state,'running');assert.equal(calls.length,1);
  await assert.rejects(v2.operation('a',{...input,idempotency_key:'other'}),{code:'session_busy_or_unknown'});
  await assert.rejects(v2.operation('a',{...input,retry:false}),{code:'idempotency_conflict'});
  release();const result=await pending;assert.equal(calls.length,2);
  await store.pool.query("UPDATE v2_operations SET state='running',result=NULL,summary=NULL,error=NULL,finished_at=NULL WHERE id=$1",[result.id]);
  await store.pool.query("UPDATE v2_ledger SET state='reserved' WHERE operation=$1",[result.id]);
  await recoverV2(store.pool);const recovered=await v2.operation('a',input);assert.equal(recovered.state,'unknown');assert.equal(recovered.result.status,null);assert.equal(recovered.result.retry.stop_reason,'interrupted_unknown');assert.equal(recovered.result.diagnostics.attempts[0].failure.provider_status,503);assert.equal(calls.length,2);
 });
});


test('actual local DNS CONNECT 503 supplies definitive no-target evidence and retains the rejected proxy traffic',{skip:!enabled},async()=>{
 const sockets=new Set();let connects=0;
 const proxy=net.createServer(socket=>{sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));socket.once('data',bytes=>{connects++;assert.match(bytes.toString(),/^CONNECT 93\.184\.216\.34:443 HTTP\/1\.1/);socket.end('HTTP/1.1 503 Service Unavailable\r\nX-Squid-Error: ERR_DNS_FAIL 0\r\n\r\nprivate provider page');});});
 await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 try{await fixture(async({v2,settings,input,dnsCalls,setDns,defaultDns,calls})=>{
  settings.proxies[0].url=`http://fixture:private-password@127.0.0.1:${proxy.address().port}/`;
  settings.datacenterFixedFeePool.pool_fingerprint_sha256=fixedFeePoolFingerprint(settings.proxies,['US']);
  const fallback=defaultDns();setDns(async(...args)=>dnsCalls.length===1?nativeHttp(...args):fallback(...args));
  const result=await v2.operation('a',input),first=result.result.diagnostics.attempts[0];
  assert.equal(result.state,'completed');assert.equal(connects,1);assert.equal(calls.length,1);assert.equal(first.stage,'dns');assert.equal(first.source_status,null);assert.equal(first.provider_status,503);assert.equal(first.failure.source_request_dispatched,false);assert.equal(first.failure.provider_reason,'ERR_DNS_FAIL');assert.ok(first.tunnel_bytes>100);assert.equal(result.result.retry.attempts,2);
  assert.doesNotMatch(JSON.stringify(result),/private provider page|private-password|127\.0|93\.184/);
 },{dns:true,maxRequests:1});}finally{for(const socket of sockets)socket.destroy();await new Promise(resolve=>proxy.close(resolve));}
});

test('source retries share the first deadline and cumulative encoded/tunnel caps and preserve both source statuses',{skip:!enabled},async()=>{
 await fixture(async({v2,calls,input,setSource})=>{
  setSource(async()=>{if(calls.length===1){await new Promise(resolve=>setTimeout(resolve,20));return response(503,{},'x'.repeat(3000));}return response(200,{},'y'.repeat(1000));});
  const result=await v2.operation('a',input);
  assert.equal(result.state,'completed');assert.equal(result.result.encoded_bytes,4000);assert.deepEqual(result.result.diagnostics.attempts.map(a=>a.source_status),[503,200]);
  assert.equal(calls[1][2].max_encoded_bytes,1096);assert.equal(calls[1][2].max_tunnel_bytes,7692);assert.ok(calls[1][2].timeout_ms<calls[0][2].timeout_ms-10);
 });
 await fixture(async({v2,calls,input,setSource})=>{
  setSource(async()=>response(503,{},'x'.repeat(4096)));const result=await v2.operation('a',input);assert.equal(calls.length,1);assert.equal(result.result.retry.stop_reason,'retry_byte_limit');
 });
 await fixture(async({v2,calls,input,setSource})=>{
  setSource(async()=>{await new Promise(resolve=>setTimeout(resolve,40));return response(503);});const result=await v2.operation('a',input);assert.equal(calls.length,1);assert.equal(result.result.retry.stop_reason,'retry_deadline');
 },{limits:{timeout_ms:30}});
});

test('policy, cooldown, identity binding and budget changes prevent retry admission under the original operation',{skip:!enabled},async()=>{
 for(const mode of ['pricing','identity','cooldown','policy'])await fixture(async({store,settings,v2,calls,input,setSource})=>{
  setSource(async()=>{
   if(mode==='pricing')settings.datacenterFixedFeePool.reviewed=false;
   if(mode==='identity')settings.proxies[1].dedicated_ip='93.184.216.39';
   if(mode==='policy')settings.v2.accessProfiles['source@1'].limits.min_interval_ms=1;
   if(mode==='cooldown')await store.pool.query("INSERT INTO source_limits(source,cooldown_until) VALUES('origin:source.example',now()+interval '1 minute') ON CONFLICT(source) DO UPDATE SET cooldown_until=EXCLUDED.cooldown_until");
   return response(503);
  });
  const result=await v2.operation('a',input);assert.equal(calls.length,1,mode);assert.equal(result.result.retry.route_changed,false,mode);assert.equal(result.result.retry.attempts,1,mode);assert.equal(result.result.status,503,mode);
  assert.equal(result.result.retry.stop_reason,{pricing:'pricing_attestation_unavailable',identity:'retry_route_unavailable',cooldown:'source_cooldown',policy:'version_immutable'}[mode],mode);
 });
});

test('ineligible retry retains ordinary reservation and redirect admission semantics',{skip:!enabled},async()=>{
 await fixture(async({settings,v2,calls,input})=>{
  delete settings.datacenterFixedFeePool;
  await assert.rejects(v2.operation('a',input),{code:'session_limit'});
  await assert.rejects(v2.operation('a',{...input,retry:false}),{code:'session_limit'});
  assert.equal(calls.length,0);
 },{maxRequests:1,limits:{max_redirects:1}});
});

test('native retry success diagnostics reject 2xx challenges and final 3xx responses without replay',{skip:!enabled},async()=>{
 for(const [status,headers,body,expected]of [
  [200,{'content-type':'text/html'},'<title>Robot Check</title>','retry_not_transient'],
  [200,{'content-type':'text/html','cf-mitigated':'challenge'},'<html>pending</html>','retry_not_transient'],
  [302,{},'redirect without location','retry_not_transient'],
  [304,{},'','retry_not_transient'],
  [403,{},'access denied','retry_not_transient'],
  [200,{},'ok',null],
  [204,{},'',null],
 ])await fixture(async({v2,calls,input,setSource})=>{
  setSource(async()=>response(status,headers,body));const result=await v2.operation('a',input);
  assert.equal(calls.length,1);assert.equal(result.result.retry.attempts,1);assert.equal(result.result.retry.route_changed,false);assert.equal(result.result.retry.stop_reason,expected,`${status} ${JSON.stringify(headers)}`);
 });
});
