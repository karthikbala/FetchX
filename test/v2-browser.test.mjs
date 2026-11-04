import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {PassThrough} from 'node:stream';
import {mkdtemp,rm,writeFile,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {browserProbePolicy,browserProbeRuntime,binarySha,BROWSER_PROBE_ARGS,BROWSER_PROBE_QUALIFICATION_KIND,browserProxyArg,browserProbeLaunchOptions} from '../src/v2-browser-policy.mjs';
import {browserRelay} from '../src/v2-browser-relay.mjs';
import {openPinnedTunnel} from '../src/v2-http.mjs';
import {captureBrowserProbe} from '../src/v2-browser-capture.mjs';
import {Store} from '../src/store.mjs';
import {Gateway} from '../src/gateway.mjs';
import {V2Gateway,recoverV2} from '../src/v2.mjs';
import {server} from '../src/main.mjs';
import {sha} from '../src/crypto.mjs';

test('browser probe policy/runtime fail closed without exact local build, free entitlement and current qualification',async()=>{
 assert.equal(browserProbePolicy(undefined),null);assert.equal(browserProbePolicy({enabled:false}),null);
 for(const patch of [{max_requests:33},{max_decoded_bytes:8388609},{max_dom_bytes:1048577},{max_network_bytes:16777217},{settle_ms:2001},{script:'fetch(...)'}])assert.throws(()=>browserProbePolicy({enabled:true,...patch}),{code:'browser_probe_configuration'});
 assert.equal((await browserProbeRuntime({})).available,false);
 const root=await mkdtemp(join(tmpdir(),'probe-runtime-'));try{
  const path=join(root,'synthetic-not-a-browser');await writeFile(path,'not executed');await chmod(path,0o700);const hash=await binarySha(path);
  const config={browser:{free:{executablePath:path,sha256:hash,version:'synthetic',entitlement:'unlicensed'}},v2:{browser_probe:{enabled:true,tier:'free'}}};assert.equal((await browserProbeRuntime(config)).available,false);
  config.v2.browser_probe.qualification={status:'accepted',kind:'pinned-relay-egress-v1',binary_sha256:hash,version:'synthetic',entitlement:'unlicensed',platform:process.platform,arch:process.arch,evidence:'sha256:'+'a'.repeat(64),expires_at:'2020-01-01'};assert.equal((await browserProbeRuntime(config)).available,false);
  config.v2.browser_probe.qualification.expires_at='2099-01-01';
  assert.deepEqual(await browserProbeRuntime(config),{available:false,reason:'browser_probe_runtime_unqualified'});
  config.v2.browser_probe.qualification.kind=BROWSER_PROBE_QUALIFICATION_KIND;
  config.browser.free.entitlement='trial';assert.equal((await browserProbeRuntime(config)).available,false);
  config.browser.free.entitlement='paid';assert.equal((await browserProbeRuntime(config)).available,false);
  config.browser.free.entitlement='unlicensed';
  const ready=await browserProbeRuntime(config);
  assert.equal(ready.available,true);assert.equal(ready.runtime.sha256,hash);assert.equal(ready.runtime.executablePath,path);
  await writeFile(path,'changed');assert.equal((await browserProbeRuntime(config)).reason,'browser_probe_build_mismatch');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('explicit Chromium runtime binds the exact engine, executable and platform without requiring Cloak credentials',async()=>{
 const root=await mkdtemp(join(tmpdir(),'probe-chromium-runtime-'));
 try{
  const executablePath=join(root,'synthetic-chromium');
  await writeFile(executablePath,'only a configuration fixture');await chmod(executablePath,0o700);
  const sha256=await binarySha(executablePath),version='151.0.7922.34',runtime={executablePath,sha256,version};
  const expires_at=new Date(Date.now()+60000).toISOString();
  const qualification={status:'accepted',kind:BROWSER_PROBE_QUALIFICATION_KIND,engine:'chromium',binary_sha256:sha256,version,platform:process.platform,arch:process.arch,evidence:'sha256:'+'a'.repeat(64),expires_at};
  const probe={enabled:true,engine:'chromium',runtime,qualification};
  const config={v2:{browser_probe:probe}};
  for(const patch of [{engine:undefined},{engine:'cloakbrowser'},{arch:'other'},{version:'151.0.7922.35'},{binary_sha256:'0'.repeat(64)},{expires_at:'2000-01-01T00:00:00Z'}]){
   assert.deepEqual(await browserProbeRuntime({v2:{browser_probe:{...probe,qualification:{...qualification,...patch}}}}),{available:false,reason:'browser_probe_runtime_unqualified'});
  }
  assert.equal((await browserProbeRuntime({v2:{browser_probe:{...probe,runtime:undefined}}})).available,false);
  assert.equal((await browserProbeRuntime({v2:{browser_probe:{...probe,tier:'free'}}})).available,false);
  const ready=await browserProbeRuntime(config);
  assert.deepEqual(ready,{available:true,runtime:{engine:'chromium',...runtime,expires_at}});
  const args={relay:'http://127.0.0.1:30000',denyRelay:'http://127.0.0.1:30001',cacheDir:root,deadline:Date.now()+1000};
  const options=await browserProbeLaunchOptions(ready.runtime,args);
  assert.equal(options.executablePath,executablePath);
  assert.equal(options.chromiumSandbox,true);
  assert.equal(options.host,'127.0.0.1');
  assert.equal(options.env.XDG_CONFIG_HOME,root);
  assert.equal(options.env.XDG_CACHE_HOME,root);
  assert.ok(options.args.includes(browserProxyArg(args.relay,args.denyRelay)));
  assert.ok(options.args.includes('--disable-quic'));
  assert.equal(options.args.some(arg=>arg.startsWith('--fingerprint')),false);
  await assert.rejects(browserProbeLaunchOptions(ready.runtime,{...args,relay:'https://outside.example:443'}),{code:'browser_probe_runtime_unqualified'});
  await writeFile(executablePath,'mutated');
  assert.equal((await browserProbeRuntime(config)).reason,'browser_probe_build_mismatch');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('browser relay rejects unapproved/private CONNECT and pins allowed direct sockets with a shared byte/connection cap',async()=>{
 const sockets=new Set();let dialed=0;const upstream=net.createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});socket.on('data',()=>socket.write(Buffer.alloc(2048,65)));});await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 const relay=await browserRelay({profile:{origins:['https://source.gov','https://private.gov']},resolve:async host=>[{address:host==='private.gov'?'127.0.0.1':'93.184.216.34',family:4}],limits:{max_requests:1,max_network_bytes:1024},deadline:Date.now()+2000,dial:destination=>{dialed++;assert.equal(destination.address,'93.184.216.34');return net.connect({host:'127.0.0.1',port:upstream.address().port});}});
 const connect=path=>new Promise((resolve,reject)=>{const req=http.request(relay.url,{method:'CONNECT',path});req.once('connect',(response,socket)=>resolve({response,socket}));req.once('error',reject);req.end();});
 try{
  for(const host of ['unapproved.gov:443','127.0.0.1:443','source.gov:80']){const {response,socket}=await connect(host);assert.equal(response.statusCode,403);socket.destroy();}assert.equal(dialed,0);
  const allowed=await connect('source.gov:443');assert.equal(allowed.response.statusCode,200);const closed=new Promise(r=>allowed.socket.once('close',r));allowed.socket.on('error',()=>{});allowed.socket.write('request');await closed;assert.equal(dialed,1);assert.equal(relay.error,'browser_network_byte_limit');assert.ok(relay.bytes>=1024);assert.equal(relay.dispatched,true);
 }finally{await relay.close();for(const socket of sockets)socket.destroy();await new Promise(r=>upstream.close(r));}
 const rejected=await browserRelay({profile:{origins:['https://private.gov']},resolve:async()=>[{address:'169.254.169.254'}],limits:{max_requests:1,max_network_bytes:1024},deadline:Date.now()+1000,dial:()=>{throw new Error('private IP must not dial');}});
 try{const {response,socket}=await new Promise((resolve,reject)=>{const req=http.request(rejected.url,{method:'CONNECT',path:'private.gov:443'});req.on('connect',(response,socket)=>resolve({response,socket}));req.on('error',reject);req.end();});assert.equal(response.statusCode,403);socket.destroy();assert.equal(rejected.dispatched,false);}finally{await rejected.close();}
});

test('browser proxy relay measures aggregate CONNECT and both encrypted-stream directions without hostname re-resolution',async()=>{
 let requestText='';const sockets=new Set();const proxy=net.createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});socket.once('data',header=>{requestText=header.toString();socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');socket.on('data',chunk=>socket.write(Buffer.alloc(chunk.length,66)));});});await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
 const relay=await browserRelay({profile:{origins:['https://source.gov']},resolve:async()=>[{address:'93.184.216.34',family:4}],proxy:{url:`http://synthetic-user:synthetic-pass@127.0.0.1:${proxy.address().port}`},limits:{max_requests:1,max_network_bytes:4096},deadline:Date.now()+2000});let tunnel;
 try{
  tunnel=await new Promise((resolve,reject)=>{const request=http.request(relay.url,{method:'CONNECT',path:'source.gov:443'});request.on('connect',(response,socket)=>{assert.equal(response.statusCode,200);resolve(socket);});request.on('error',reject);request.end();});
  const reply=new Promise((resolve,reject)=>{tunnel.once('data',resolve);tunnel.once('error',reject);});tunnel.write('five!');assert.equal((await reply).length,5);assert.match(requestText,/CONNECT 93\.184\.216\.34:443/);assert.ok(!requestText.includes('source.gov'));assert.equal(relay.bytes,Buffer.byteLength(requestText)+Buffer.byteLength('HTTP/1.1 200 Connection Established\r\n\r\n')+10);assert.equal(relay.provider_status,200);
 }finally{tunnel?.destroy();await relay.close();for(const socket of sockets)socket.destroy();await new Promise(r=>proxy.close(r));}
});

test('browser relay close waits for an admitted upstream tunnel meter to settle',async()=>{
 let entered,release;const started=new Promise(resolve=>{entered=resolve;});
 const relay=await browserRelay({profile:{origins:['https://source.gov']},resolve:async()=>[{address:'93.184.216.34',family:4}],proxy:{url:'http://fixture-proxy.example:8080'},limits:{max_requests:1,max_network_bytes:4096},deadline:Date.now()+2000,openTunnel:async(proxy,destination,limits,meter)=>{entered();await new Promise(resolve=>{release=resolve;});meter.bytes=127;return new PassThrough();}});
 const request=http.request(relay.url,{method:'CONNECT',path:'source.gov:443'});request.on('error',()=>{});request.end();
 try{
  await started;let closed=false;const closing=relay.close().then(()=>{closed=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false);release();await closing;assert.equal(relay.bytes,127);assert.equal(relay.meter_complete,true);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(relay.bytes,127);
 }finally{request.destroy();release?.();await relay.close();}
});

test('browser relay marks delayed tunnel failures and asynchronous failed or unsettled writes uncertain',async()=>{
 const sockets=new Set();
 const proxy=net.createServer(socket=>{sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));socket.once('data',()=>socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'));});
 await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 try{
  for(const mode of ['failed-write','pending-write','delayed-connect']){
   let release,started;const entered=new Promise(resolve=>{started=resolve;});
   const relay=await browserRelay({profile:{origins:['https://source.gov']},resolve:async()=>[{address:'93.184.216.34',family:4}],proxy:{url:`http://127.0.0.1:${proxy.address().port}`},limits:{max_requests:1,max_network_bytes:4096},deadline:Date.now()+2000,openTunnel:async(...args)=>{
    if(mode==='delayed-connect'){started();await new Promise(resolve=>{release=resolve;});throw new Error('synthetic delayed CONNECT failure');}
    const tunnel=await openPinnedTunnel(...args);
    tunnel.socket.write=(bytes,encoding,callback)=>{started();if(mode==='failed-write')setImmediate(()=>callback(Object.assign(new Error('synthetic async write failure'),{code:'EPIPE'})));else release=()=>callback();return true;};
    return tunnel;
   }});
   let client;const request=http.request(relay.url,{method:'CONNECT',path:'source.gov:443'});request.on('error',()=>{});request.on('connect',(response,socket)=>{client=socket;socket.on('error',()=>{});if(mode!=='delayed-connect')socket.write('pending-payload');});request.end();
   try{
    await entered;
    if(mode==='failed-write'){await new Promise(resolve=>setTimeout(resolve,10));assert.equal(relay.error,'browser_transport_unknown');await relay.close();}
    else {const closing=relay.close();if(mode==='delayed-connect')release();await closing;}
    assert.equal(relay.meter_complete,false,mode);
    if(mode==='delayed-connect')assert.equal(relay.error,'browser_connect_unknown');
    release?.();await new Promise(resolve=>setImmediate(resolve));assert.equal(relay.meter_complete,false,mode);
   }finally{client?.destroy();request.destroy();release?.();await relay.close();}
  }
 }finally{for(const socket of sockets)socket.destroy();await new Promise(resolve=>proxy.close(resolve));}
});

test('actual local browser captures native requests/bodies separately from DOM and blocks methods, external/private traffic, sockets and popups',{skip:!process.env.BROWSER_TEST_EXECUTABLE},async()=>{
 const {chromium}=await import('playwright-core');let tripwireCalls=0;const tripwire=http.createServer((req,res)=>{tripwireCalls++;res.end('must not be reached');});tripwire.on('upgrade',(req,socket)=>{tripwireCalls++;socket.destroy();});await new Promise(r=>tripwire.listen(0,'127.0.0.1',r));
 const relay=await browserRelay({profile:{origins:[]},limits:{max_requests:4,max_network_bytes:65536},deadline:Date.now()+15000});
 const browser=await chromium.launch({executablePath:process.env.BROWSER_TEST_EXECUTABLE,headless:true,chromiumSandbox:true,ignoreDefaultArgs:['--disable-popup-blocking'],args:[...BROWSER_PROBE_ARGS,browserProxyArg(relay.url,relay.deny_url)]});
 try{
  const artifacts=[],admitted=[];const html=`<!doctype html><link rel="icon" href="data:,"><div id="data">waiting</div><script>document.cookie='probe=one; Path=/; Secure; SameSite=Lax';fetch('/data').then(r=>r.json()).then(v=>document.querySelector('#data').textContent=v.value);fetch('/mutation',{method:'POST',body:'mutation Unsafe { write }'}).catch(()=>{});fetch('https://blocked.gov/data').catch(()=>{});fetch('http://127.0.0.1:${tripwire.address().port}/private').catch(()=>{});try{new WebSocket('ws://127.0.0.1:${tripwire.address().port}/socket')}catch{};window.open('https://blocked.gov/popup');navigator.serviceWorker.register('/sw.js').catch(()=>{});</script>`;
  const result=await captureBrowserProbe(browser,{url:'https://source.gov/',timeout_ms:8000,deadline:Date.now()+10000,cookies:[]},{max_requests:8,max_network_bytes:65536,max_decoded_bytes:65536,max_dom_bytes:65536,settle_ms:350},{
   admit:async request=>{assert.ok(['GET','HEAD'].includes(request.method));const u=new URL(request.url);if(u.origin!=='https://source.gov')throw Object.assign(new Error(),{code:'destination_rejected'});admitted.push(request);},
   dispatch:async(route,request)=>route.fulfill({status:200,contentType:request.url.endsWith('/data')?'application/json':'text/html',body:request.url.endsWith('/data')?'{"value":"native-data-arrived"}':html}),
   artifact:async artifact=>{artifacts.push(artifact);}
  });
  assert.equal(result.error,null);assert.equal(result.physical_requests,2);assert.ok(result.blocked_requests>=3);assert.equal(result.capture_complete,false);assert.equal(tripwireCalls,0);assert.equal(relay.dispatched,false);
  const native=artifacts.filter(a=>a.kind==='browser_response'),dom=artifacts.find(a=>a.kind==='rendered_dom');assert.equal(native.length,2);assert.equal(dom.generated,true);assert.ok(Buffer.from(dom.decoded_body_base64,'base64').toString().includes('<div id="data">native-data-arrived</div>'));
  assert.ok(native.some(a=>a.request.url.endsWith('/data')&&a.request.headers.cookie?.includes('probe=one')));assert.ok(native.every(a=>a.original_encoded_available===false&&a.encoded_body_base64===null&&a.encoded_sha256===null));assert.equal(dom.encoded_bytes,null);assert.equal(dom.encoded_size_basis,null);assert.ok(artifacts.length<=33);assert.ok(result.cookies.some(c=>c.name==='probe'));
 }finally{await browser.close();await relay.close();await new Promise(r=>tripwire.close(r));}
});

function makeArtifact(kind,url,body,request=null){return {kind,url,method:'GET',status:200,headers:{'content-type':kind==='rendered_dom'?'text/html':kind==='browser_screenshot'?'image/jpeg':'application/json'},raw_headers:null,captured_at:new Date().toISOString(),content_encoding:kind==='rendered_dom'?null:'gzip',decoded_body_base64:body.toString('base64'),decoded_sha256:sha(body),decoded_bytes:body.length,encoded_body_base64:null,encoded_sha256:null,original_encoded_available:false,encoded_bytes:null,encoded_size_basis:null,tunnel_bytes:null,provider_status:null,decoding_error:null,...(kind==='browser_response'?{request,main_document:true}:{generated:true})};}

test('browser probe API conserves admission/ledger, isolates artifacts, persists cookies, and never replays uncertain work',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 assert.match(new URL(process.env.TEST_DATABASE_URL).pathname,/^\/gateway_test_[A-Za-z0-9_]+$/);
 const root=await mkdtemp(join(tmpdir(),'probe-api-')),store=new Store(process.env.TEST_DATABASE_URL);await store.init();await store.pool.query('TRUNCATE v2_registry,v2_discovery_profiles,v2_ledger_events,v2_artifacts,v2_ledger,v2_operations,v2_sessions,workflows,source_limits RESTART IDENTITY CASCADE');
 const profile={id:'probe',version:1,origins:['https://source.gov'],methods:['GET','HEAD','POST'],headers:['accept'],proxy_classes:['direct','residential'],countries:['US'],limits:{max_requests:20,max_encoded_bytes:4096,max_decoded_bytes:4096,max_session_encoded_bytes:65536,min_interval_ms:0},browser_probe:{enabled:true,max_requests:3,max_network_bytes:4096,max_decoded_bytes:4096,max_dom_bytes:1024,settle_ms:0}};
 const provider={enabled:true,username:'private-vendor-user',password:'private-vendor-password',maxTotalBytes:100000,microUsdPerGB:1000000,countries:['US']};
 const config={release:'probe-test',artifactDir:root,artifactKey:'42'.repeat(32),maxDailyFallbackCredits:0,projects:{a:{profiles:[],v2_access_profiles:['probe@1'],tokenHash:sha('key-a')},b:{profiles:[],v2_access_profiles:[],tokenHash:sha('key-b')}},proxies:[],v2:{accessProfiles:{'probe@1':profile}},residential:{maxTotalBytes:100000,maxDailyBytes:100000,providers:{evomi:provider}}};
 const gateway=new Gateway({store,config,profiles:{},resolve:async()=>[{address:'93.184.216.34',family:4}]});let mode='ok',runs=0,qualified=true,relayOptions;const receivedCookies=[];
 gateway.v2=new V2Gateway(gateway,{browserRuntime:async()=>({available:qualified,reason:'browser_probe_runtime_unqualified',runtime:{synthetic:true}}),relayFactory:async options=>{relayOptions=options;return {url:'http://127.0.0.1:1',bytes:512,error:null,connections:1,dispatched:true,provider_status:options.proxy?200:null,close:async()=>{}};},browserRunner:async(input,hooks)=>{
  runs++;receivedCookies.push(input.cookies);const request={url:input.url,method:'GET',headers:{accept:'text/html',cookie:'sid=private-source-cookie'},body_base64:null,resource_type:'document'};
  if(mode==='parallel'){const results=await Promise.allSettled([1,2].map(()=>hooks.admit({...request,redirect_depth:0,redirected_from:null})));assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.reason?.code==='browser_request_limit').length,1);}else await hooks.admit({...request,redirect_depth:0,redirected_from:null});
  if(mode==='unknown')throw new Error('private stack must not leak');
  if(mode==='methods')for(const method of ['POST','PUT','PATCH','DELETE'])await assert.rejects(hooks.admit({...request,method,body_base64:Buffer.from('mutation').toString('base64'),redirect_depth:0}),{code:'method_rejected'});
  await hooks.artifact(makeArtifact('browser_response',input.url,Buffer.from('{"native":true}'),request));const dom=makeArtifact('rendered_dom',input.url,Buffer.from('<html>generated</html>'));if(mode==='callback-failure')dom.decoded_sha256='0'.repeat(64);await hooks.artifact(dom);
  if(input.screenshot)await hooks.artifact(makeArtifact('browser_screenshot',input.url,Buffer.from([0xff,0xd8,0xff,0xd9])));
  return {status:200,final_url:input.url,error:null,capture_complete:true,physical_requests:1,blocked_requests:0,blocked_reasons:{},encoded_bytes:null,decoded_bytes:15,dom_bytes:22,cookies:[{name:'sid',value:'persisted',domain:'source.gov',path:'/',secure:true,httpOnly:true,sameSite:'Lax',expires:-1}]};
 }});
 const app=server(gateway),headers={authorization:'Bearer key-a'};const post=async(url,payload,auth=headers)=>{const r=await app.inject({method:'POST',url,headers:auth,payload});return {status:r.statusCode,body:r.json()};};
 const session=async(key,cls='direct')=>(await post('/v2/sessions',{idempotency_key:key,access_profile:{id:'probe',version:1},transport:'http',proxy:{class:cls,country:cls==='direct'?null:'US',affinity:'session'}})).body;
 try{
  const w=await session('one'),payload={idempotency_key:'probe-one',session_id:w.id,url:'https://source.gov/',max_physical_requests:2,max_estimated_micro_usd:0};
  assert.equal((await app.inject({method:'POST',url:'/v2/browser-probes',payload})).statusCode,401);
  const executable=join(root,'synthetic-pinned-build');await writeFile(executable,'synthetic never executed');await chmod(executable,0o700);const binaryHash=await binarySha(executable);
  config.browser={free:{executablePath:executable,sha256:binaryHash,version:'synthetic',entitlement:'unlicensed'}};
  config.v2.browser_probe={enabled:true,tier:'free',qualification:{status:'accepted',kind:'pinned-relay-egress-v1',binary_sha256:binaryHash,version:'synthetic',entitlement:'unlicensed',platform:process.platform,arch:process.arch,evidence:'sha256:'+'a'.repeat(64),expires_at:'2099-01-01'}};
  const fixtureRuntime=gateway.v2.browserRuntime;gateway.v2.browserRuntime=browserProbeRuntime;
  const unavailable=(await app.inject({url:'/v2/capabilities',headers})).json();assert.equal(unavailable.features.browser_network_probe,false);assert.equal(unavailable.browser_probe.reason,'browser_probe_runtime_unqualified');
  for(const url of ['https://source.gov/redirect','https://source.gov/fetch-redirect','https://source.gov/xhr-redirect'])assert.equal((await post('/v2/browser-probes',{...payload,url})).body.error,'browser_probe_runtime_unqualified');
  assert.equal(runs,0);assert.equal(relayOptions,undefined);assert.equal(Number((await store.pool.query('SELECT count(*) AS n FROM v2_operations')).rows[0].n),0);
  gateway.v2.browserRuntime=fixtureRuntime;
  qualified=false;assert.equal((await post('/v2/browser-probes',payload)).body.error,'browser_probe_runtime_unqualified');assert.equal(runs,0);qualified=true;
  assert.equal((await post('/v2/browser-probes',{...payload,max_physical_requests:4})).body.error,'browser_request_ceiling_rejected');
  assert.equal((await post('/v2/browser-probes',{...payload,wait_ms:1})).body.error,'browser_wait_ceiling_rejected');
  const first=await post('/v2/browser-probes',payload);assert.equal(first.status,200);assert.equal(first.body.state,'completed');assert.equal(first.body.result.kind,'browser_network_probe');assert.equal(first.body.result.encoded_bytes,null);assert.equal(first.body.result.physical_requests,1);assert.equal(first.body.result.dom_bytes,22);assert.equal(first.body.result.main_artifact_id,first.body.result.artifacts[0].id);assert.equal(first.body.accounting.reserved_tunnel_bytes,0);assert.equal(first.body.accounting.observed_tunnel_bytes,512);
  gateway.v2.browserRuntime=browserProbeRuntime;assert.deepEqual((await post('/v2/browser-probes',payload)).body,first.body);assert.equal(runs,1);gateway.v2.browserRuntime=fixtureRuntime;
  assert.equal((await post('/v2/browser-probes',{...payload,url:'https://source.gov/changed'})).body.error,'idempotency_conflict');
  const artifact=(await app.inject({url:'/v2/artifacts/'+first.body.result.artifacts[0].id,headers})).json();assert.equal(artifact.kind,'browser_response');assert.equal(artifact.encoded_body_base64,null);assert.equal(artifact.original_encoded_available,false);assert.ok(artifact.request.headers.cookie.includes('private-source-cookie'));
  assert.equal((await app.inject({url:'/v2/artifacts/'+artifact.id,headers:{authorization:'Bearer key-b'}})).statusCode,404);const recent=(await app.inject({url:'/v2/operations',headers})).json();assert.ok(!JSON.stringify(recent).includes('private-source-cookie'));assert.ok(!JSON.stringify(recent).includes('request.headers'));
  const shot=await post('/v2/browser-probes',{...payload,idempotency_key:'capture-shot',screenshot:true,wait_ms:0});
  assert.equal(shot.body.state,'completed');assert.equal(shot.body.result.screenshot_bytes,4);
  const jpeg=(await app.inject({url:'/v2/artifacts/'+shot.body.result.screenshot_artifact_id,headers})).json();
  assert.equal(jpeg.kind,'browser_screenshot');assert.equal(jpeg.generated,true);assert.equal(jpeg.decoded_body_base64,'/9j/2Q==');
  const storedScreenshot=(await store.pool.query('SELECT body FROM v2_artifacts WHERE id=$1',[jpeg.id])).rows[0].body;
  assert.equal(storedScreenshot.includes(Buffer.from(jpeg.decoded_body_base64)),false);
  mode='methods';const next=await post('/v2/browser-probes',{...payload,idempotency_key:'second'});assert.equal(next.body.state,'completed');assert.ok(receivedCookies.at(-1).some(c=>c.name==='sid'&&c.value==='persisted'));
  mode='parallel';const parallel=await post('/v2/browser-probes',{...payload,idempotency_key:'parallel',max_physical_requests:1});assert.equal(parallel.body.result.physical_requests,1);mode='methods';
  const paid=await session('paid','residential');const paidResult=await post('/v2/browser-probes',{...payload,idempotency_key:'paid',session_id:paid.id,max_estimated_micro_usd:9});assert.equal(paidResult.body.state,'completed');assert.ok(relayOptions.proxy.url.includes('_session-'));assert.equal(paidResult.body.accounting.reserved_tunnel_bytes,4096);assert.equal(paidResult.body.accounting.estimated_micro_usd,5);assert.equal(paidResult.body.accounting.invoice_micro_usd,null);assert.equal(paidResult.body.accounting.customer_traffic.cost_usd,'0.000001024');assert.equal(paidResult.body.accounting.customer_traffic_reservation.max_estimated_micro_usd,9);
  assert.equal(Number((await store.pool.query("SELECT accounted_tunnel_bytes FROM v2_ledger WHERE provider='evomi'")).rows[0].accounted_tunnel_bytes),4096);
  config.residential.maxTotalBytes=4097;const runsBeforeCap=runs;assert.equal((await post('/v2/browser-probes',{...payload,idempotency_key:'paid-cap',session_id:paid.id,max_estimated_micro_usd:9})).body.error,'residential_budget_exhausted');assert.equal(runs,runsBeforeCap);config.residential.maxTotalBytes=100000;
  const broken=await session('callback-failure');mode='callback-failure';const lostArtifact=await post('/v2/browser-probes',{...payload,idempotency_key:'callback-failure',session_id:broken.id});assert.equal(lostArtifact.body.state,'unknown');assert.equal(lostArtifact.body.result.capture_complete,false);assert.equal(lostArtifact.body.result.artifacts.length,1);
  const lost=await session('lost');mode='unknown';const uncertainInput={...payload,idempotency_key:'unknown',session_id:lost.id};const uncertain=await post('/v2/browser-probes',uncertainInput);assert.equal(uncertain.body.state,'unknown');const before=runs;await recoverV2(store.pool);assert.equal((await post('/v2/browser-probes',uncertainInput)).body.state,'unknown');assert.equal(runs,before);assert.equal((await post('/v2/browser-probes',{...uncertainInput,idempotency_key:'new-unsafe-key'})).body.error,'session_busy_or_unknown');
  await store.pool.query("UPDATE v2_operations SET state='running',result=NULL,summary=NULL WHERE id=$1",[first.body.id]);await recoverV2(store.pool);const partial=await gateway.v2.readOperation('a',first.body.id);assert.equal(partial.result.kind,'browser_network_probe');assert.equal(partial.result.partial,true);assert.equal(partial.result.capture_complete,false);assert.equal(partial.result.physical_requests,null);assert.equal(partial.result.blocked_requests,null);assert.equal(partial.result.artifacts.length,2);
  if(process.env.PROBE_CONTRACT_FIXTURE)await writeFile(process.env.PROBE_CONTRACT_FIXTURE,JSON.stringify({synthetic:true,normal:{operation:first.body,artifacts:await Promise.all(first.body.result.artifacts.map(a=>gateway.v2.artifact('a',a.id)))},recovered:{operation:partial,artifacts:await Promise.all(partial.result.artifacts.map(a=>gateway.v2.artifact('a',a.id)))}}));
 }finally{await app.close();await store.pool.query('TRUNCATE v2_registry,v2_discovery_profiles,v2_ledger_events,v2_artifacts,v2_ledger,v2_operations,v2_sessions RESTART IDENTITY CASCADE');await store.close();await rm(root,{recursive:true,force:true});}
});
