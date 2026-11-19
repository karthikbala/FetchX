import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {Gateway} from '../src/gateway.mjs';
import {GatewayError} from '../src/policy.mjs';
import {sha} from '../src/crypto.mjs';
import {server} from '../src/main.mjs';
import {V2Gateway} from '../src/v2.mjs';
import {recordSiteOutcome} from '../src/site-knowledge.mjs';
import {autoAttemptKey} from '../src/v2-auto-fetch.mjs';

function configFor(root){
 const profile={id:'source',version:1,origins:['https://source.example','https://other.example','https://gov.example.gov','https://third.example'],paths:['^/'],methods:['GET','HEAD','POST'],headers:['accept','content-type','user-agent'],proxy_classes:['direct','datacenter','residential'],countries:['US','GB'],limits:{max_requests:100,max_encoded_bytes:4096,max_decoded_bytes:16384,max_session_encoded_bytes:65536,max_input_bytes:1024,max_tunnel_bytes:8192,max_redirects:0,max_expansion_ratio:100,timeout_ms:2000,min_interval_ms:0,ttl_seconds:900}};
 const provider={enabled:true,username:'synthetic-user',password:'synthetic-password',countries:['US','GB'],maxTotalBytes:1e7,microUsdPerGB:1e6};
 return {release:'auto-fetch-synthetic',artifactDir:root,artifactKey:'24'.repeat(32),maxDailyFallbackCredits:0,
  projects:{a:{tokenHash:sha('token-a'),profiles:[],v2_access_profiles:['source@1'],v2_entitlement:{mode:'unmetered'}}},
  proxies:[{id:'dc-us',country:'US',url:'http://dc-proxy.example:8080'},{id:'dc-gb',country:'GB',url:'http://dc-gb-proxy.example:8080'}],
  v2:{accessProfiles:{'source@1':profile}},residential:{maxTotalBytes:1e7,maxDailyBytes:1e7,providers:{evomi:{...provider},dataimpulse:{...provider}}}};
}
const fixtureArtifact=(kind,url,bytes,extra={})=>({kind,url,status:200,method:'GET',raw_headers:null,
 headers:{'content-type':'text/html; charset=utf-8'},captured_at:new Date().toISOString(),
 content_encoding:null,encoded_body_base64:null,encoded_sha256:null,encoded_bytes:null,encoded_size_basis:null,original_encoded_available:false,
 decoded_body_base64:bytes.toString('base64'),decoded_sha256:sha(bytes),decoded_bytes:bytes.length,tunnel_bytes:null,provider_status:null,decoding_error:null,...extra});
const routeClass=proxy=>!proxy?'direct':JSON.stringify(proxy).includes('dc-')?'datacenter':'residential';

test('auto mode climbs cheapest first, learns, reuses knowledge, bills only the success and replays without dispatch',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 assert.match(new URL(process.env.TEST_DATABASE_URL).pathname,/^\/gateway_test_[A-Za-z0-9]+$/);
 const root=await mkdtemp(join(tmpdir(),'fetchx-auto-')),store=new Store(process.env.TEST_DATABASE_URL);await store.init();
 await store.pool.query('TRUNCATE v2_registry,v2_ledger_events,v2_artifacts,v2_ledger,v2_operations,v2_sessions,workflows,source_limits,site_routes RESTART IDENTITY CASCADE');
 const config=configFor(root),calls=[],seenHeaders=[];
 // Per-class behaviour of the synthetic site.
 let site={direct:403,datacenter:403,residential:200};let uncertain=false;
 const gateway=new Gateway({store,config,profiles:{},resolve:async()=>[{address:'93.184.216.34',family:4}]});
 gateway.v2=new V2Gateway(gateway,{http:async(input,destination,limits,{proxy})=>{
  const cls=routeClass(proxy);calls.push(cls);seenHeaders.push(input.headers);
  if(uncertain)throw Object.assign(new GatewayError('source_timeout_unknown',504),{observed_encoded_bytes:0,observed_tunnel_bytes:400});
  const status=site[cls],headers={'content-type':'application/json'};if(status===429)headers['retry-after']='120';
  return {status,headers,raw_headers:Object.entries(headers).flat(),encoded:Buffer.from(status===200?'{"ok":true}':'{"blocked":true}'),tunnel_bytes:proxy?300:null,provider_status:proxy?200:null};
 }});
 const app=server(gateway),auth={authorization:'Bearer token-a'};
 const payload=(key,extra={})=>({idempotency_key:key,access_profile:{id:'source',version:1},url:'https://source.example/data?x=1',proxy:{class:'auto'},...extra});
 const post=async input=>{const r=await app.inject({method:'POST',url:'/v2/fetch',headers:auth,payload:input});return {status:r.statusCode,body:r.json()};};
 const get=async key=>{const r=await app.inject({url:'/v2/fetch/'+encodeURIComponent(key),headers:auth});return {status:r.statusCode,body:r.json()};};
 try{
  // First visit: direct and datacenter are blocked, residential works.
  const first=await post(payload('first'));
  assert.equal(first.status,200);assert.equal(first.body.success,true);assert.equal(first.body.idempotency_key,'first');
  assert.deepEqual(calls,['direct','datacenter','residential']);
  assert.deepEqual(first.body.auto.routes_tried.map(r=>[r.class,r.result]),[['direct','blocked'],['datacenter','blocked'],['residential','success']]);
  assert.equal(first.body.auto.billed_attempt,3);assert.equal(first.body.auto.next,null);assert.equal(first.body.routing.class,'residential');
  assert.ok(!JSON.stringify(first.body.auto).includes('evomi')&&!JSON.stringify(first.body.auto).includes('oxylabs'),'no provider names in the auto summary');
  // Three operations ran: two completed with 403 (not billed) and the success.
  const states=(await store.pool.query('SELECT o.state FROM v2_ledger l JOIN v2_operations o ON o.id=l.operation')).rows;
  assert.equal(states.length,3);
  // Same key: replay with no new dispatch, and lookup returns the same final attempt.
  calls.length=0;
  const replay=await post(payload('first'));assert.equal(replay.body.operation_id,first.body.operation_id);assert.deepEqual(calls,[]);
  const looked=await get('first');assert.equal(looked.body.operation_id,first.body.operation_id);assert.equal(looked.body.auto.billed_attempt,3);assert.deepEqual(calls,[]);
  // A different body under the same key conflicts.
  assert.equal((await post(payload('first',{max_attempts:2}))).body.error.code,'idempotency_conflict');
  // Second request: site knowledge now has residential proven, so it is tried first.
  const second=await post(payload('second'));
  assert.equal(second.body.success,true);assert.deepEqual(calls,['residential'],'the proven route is tried first');
  // Rate limit on every route: data is not returned, next step says wait.
  calls.length=0;site={direct:429,datacenter:429,residential:429};
  const limited=await post(payload('limited',{url:'https://other.example/a'}));
  assert.equal(calls.length,1,'a rate limit stops the ladder');assert.equal(limited.body.success,false);assert.equal(limited.body.auto.next.action,'retry_after');assert.equal(limited.body.auto.next.retry_after_seconds,120);
  assert.equal(limited.body.auto.billed_attempt,null);
  // max_attempts caps the ladder.
  calls.length=0;site={direct:403,datacenter:403,residential:403};
  const capped=await post(payload('capped',{url:'https://third.example/b',max_attempts:1}));
  assert.equal(calls.length,1);assert.equal(capped.body.auto.attempts,1);
  // All routes blocked: clear final reason and the next step is rendering.
  calls.length=0;
  const blocked=await post(payload('blocked',{url:'https://source.example/blocked',proxy:{class:'auto',country:'GB'}}));
  assert.equal(blocked.body.success,false);assert.equal(blocked.body.error.code,'source_forbidden');assert.equal(blocked.body.auto.next.action,'retry_later');
  // This profile cannot render, so the browser rungs are refused at admission: no dispatch, no cost, no attempt used.
  assert.deepEqual(blocked.body.auto.routes_tried.map(r=>[r.transport,r.class,r.country,r.result]),[['http','direct',null,'blocked'],['http','datacenter','GB','blocked'],['http','residential','GB','blocked'],
   ['browser','residential','GB','not_admitted'],['browser','residential','GB','not_admitted'],['browser','datacenter','GB','not_admitted']]);
  assert.equal(blocked.body.auto.attempts,3);assert.deepEqual(calls,['direct','datacenter','residential']);
  // An uncertain attempt stops the ladder: uncertain source work is never retried.
  calls.length=0;uncertain=true;
  const unsure=await post(payload('unsure',{url:'https://source.example/unsure'}));
  assert.equal(calls.length,1);assert.equal(unsure.body.auto.next.action,'recover');uncertain=false;
  // Non-GET methods never escalate.
  calls.length=0;site={direct:403,datacenter:200,residential:200};
  const posted=await post(payload('posted',{url:'https://third.example/form',method:'POST'}));
  assert.equal(calls.length,1);assert.equal(posted.body.auto.max_attempts,1);
  // Every route cooling: no dispatch, a 429 with the wait.
  for(const cls of ['direct','datacenter','residential'])for(let i=0;i<2;i++)
   await recordSiteOutcome(store.pool,{host:'https://gov.example.gov/',execution:'http',route:{class:cls,provider:cls==='residential'?'evomi':cls==='datacenter'?'oxylabs':'',country:cls==='direct'?'':'US'},outcome:'blocked'});
  calls.length=0;
  const cooling=await post(payload('cooling',{url:'https://gov.example.gov/page'}));
  assert.equal(cooling.status,429);assert.equal(cooling.body.error.code,'source_cooldown');assert.equal(calls.length,0);
  assert.equal(cooling.body.error.details.auto.next.action,'retry_after');assert.ok(cooling.body.error.details.auto.next.retry_after_seconds>3600);
  // A client automation User-Agent is replaced with a browser one; other headers stay.
  seenHeaders.length=0;site={direct:200,datacenter:200,residential:200};
  const ua=await post(payload('ua',{url:'https://third.example/ua',headers:{'User-Agent':'python-requests/2.32','content-type':'application/json'}}));
  assert.equal(ua.body.success,true);assert.deepEqual(ua.body.auto.headers_adjusted,['user-agent','accept']);
  const sent=Object.fromEntries(Object.entries(seenHeaders.at(-1)).map(([k,v])=>[k.toLowerCase(),v]));
  assert.match(sent['user-agent'],/^Mozilla\/5\.0/);assert.equal(sent['content-type'],'application/json');assert.equal(sent.accept,'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
  assert.deepEqual((await get('ua')).body.auto.headers_adjusted,['user-agent','accept']);
  // Attempt keys are derived, bounded and valid identifiers.
  assert.match(autoAttemptKey('x'.repeat(160),4),/^auto\.[a-f0-9]{48}\.4$/);
 }finally{await app.close();await store.close();await rm(root,{recursive:true,force:true});}
});

test('auto mode request validation',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const root=await mkdtemp(join(tmpdir(),'fetchx-auto-v-')),store=new Store(process.env.TEST_DATABASE_URL);await store.init();
 const gateway=new Gateway({store,config:configFor(root),profiles:{},resolve:async()=>[{address:'93.184.216.34',family:4}]});
 gateway.v2=new V2Gateway(gateway,{http:async()=>{throw Error('no dispatch');}});
 const app=server(gateway);
 try{
  for(const [extra,code] of [[{max_attempts:6},'max_attempts_invalid'],[{max_attempts:0},'max_attempts_invalid'],[{proxy:{class:'auto',country:'usa'}},'country_required'],[{proxy:{class:'auto',extra:1}},'proxy_required'],[{surprise:true},'request_invalid']]){
   const r=await app.inject({method:'POST',url:'/v2/fetch',headers:{authorization:'Bearer token-a'},payload:{idempotency_key:'v-'+code+JSON.stringify(extra).length,access_profile:{id:'source',version:1},url:'https://source.example/',proxy:{class:'auto'},...extra}});
   assert.equal(r.json().error.code,code,JSON.stringify(extra));
  }
 }finally{await app.close();await store.close();await rm(root,{recursive:true,force:true});}
});

test('auto mode escalates from blocked HTTP to a rendered residential browser and learns it',{skip:!process.env.TEST_DATABASE_URL,timeout:30_000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'fetchx-auto-b-')),store=new Store(process.env.TEST_DATABASE_URL);await store.init();
 await store.pool.query('TRUNCATE v2_registry,v2_ledger_events,v2_artifacts,v2_ledger,v2_operations,v2_sessions,workflows,source_limits,site_routes RESTART IDENTITY CASCADE');
 const config=configFor(root);config.v2.accessProfiles['source@1'].browser_probe={enabled:true,max_requests:8,max_network_bytes:65536,max_decoded_bytes:16384,max_dom_bytes:16384,settle_ms:0,max_wait_ms:0,subresources:'same_origin',frames:false,page_post:false};
 const calls=[];let relay,browserRuns=0;
 const gateway=new Gateway({store,config,profiles:{},resolve:async()=>[{address:'93.184.216.34',family:4}]});
 gateway.v2=new V2Gateway(gateway,{browserRuntime:async()=>({available:true,runtime:{synthetic:true,engine:'camoufox'}}),
  http:async(input,destination,limits,{proxy})=>{calls.push('http:'+routeClass(proxy));const headers={'content-type':'text/html'};
   return {status:403,headers,raw_headers:Object.entries(headers).flat(),encoded:Buffer.from('<title>denied</title>'),tunnel_bytes:proxy?300:null,provider_status:proxy?200:null};},
  relayFactory:async options=>{relay=options;return {url:'http://127.0.0.1:1',bytes:512,meter_complete:true,connections:1,provider_status:200,close:async()=>{}};},
  browserRunner:async(input,hooks)=>{
   browserRuns++;calls.push('browser:'+routeClass(relay.proxy));
   const request={url:input.url,method:'GET',headers:{accept:'text/html'},body_base64:null,resource_type:'document',redirect_depth:0,redirected_from:null};
   await hooks.admit(request);
   await relay.beforeConnect(relay.pinnedDestinations.get(new URL(input.url).hostname).destination);
   await hooks.artifact(fixtureArtifact('browser_response',input.url,Buffer.from('<main>rendered data</main>'),{request,main_document:true}));
   await hooks.artifact(fixtureArtifact('rendered_dom',input.url,Buffer.from('<html><main>rendered data</main></html>'),{generated:true}));
   return {status:200,final_url:input.url,capture_complete:true,counts_complete:true};
  }});
 const app=server(gateway),auth={authorization:'Bearer token-a'};
 const post=async input=>{const r=await app.inject({method:'POST',url:'/v2/fetch',headers:auth,payload:input});return {status:r.statusCode,body:r.json()};};
 const payload=key=>({idempotency_key:key,access_profile:{id:'source',version:1},url:'https://source.example/page',proxy:{class:'auto'}});
 try{
  const first=await post(payload('render-1'));
  assert.equal(first.status,200,JSON.stringify(first.body.error));assert.equal(first.body.success,true,JSON.stringify(first.body.auto));
  assert.deepEqual(calls,['http:direct','http:datacenter','http:residential','browser:residential']);
  assert.deepEqual(first.body.auto.routes_tried.at(-1),{transport:'browser',class:'residential',country:'US',result:'success'});
  assert.equal(first.body.auto.billed_attempt,4);
  // Lookup returns the rendered final attempt without dispatching.
  const before=calls.length;
  const looked=await app.inject({url:'/v2/fetch/render-1',headers:auth});
  assert.equal(looked.json().operation_id,first.body.operation_id);assert.equal(calls.length,before);
  // Next request for the host goes straight to the proven browser route.
  calls.length=0;
  const second=await post(payload('render-2'));
  assert.equal(second.body.success,true);assert.deepEqual(calls,['browser:residential']);
 }finally{await app.close();await store.close();await rm(root,{recursive:true,force:true});}
});
