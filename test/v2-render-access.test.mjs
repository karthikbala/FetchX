import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {browserProbePolicy} from '../src/v2-browser-policy.mjs';
import {browserRelay} from '../src/v2-browser-relay.mjs';
import {classifyProtection} from '../src/protection.mjs';
import {hasHtmlChallenge,sourceChallenge} from '../src/source-challenge.mjs';
import {cooldownView} from '../src/v2-public-fetch.mjs';
import {cooldownFailure} from '../src/v2.mjs';
import {Store} from '../src/store.mjs';
import {Gateway} from '../src/gateway.mjs';
import {V2Gateway} from '../src/v2.mjs';
import {server} from '../src/main.mjs';
import {sha} from '../src/crypto.mjs';

const html=body=>({headers:{'content-type':'text/html'},body:Buffer.from(body)});

test('generic bot-manager interstitials are challenges, including when served with 429',()=>{
 for(const title of ['Bot or Not?','Just a moment...','Attention Required! | Cloudflare','Pardon Our Interruption','Are you a robot?']){
  assert.equal(hasHtmlChallenge(html(`<html><head><title>${title}</title></head></html>`)),true,title);
  const view=classifyProtection({status:429,...html(`<title>${title}</title>`)},{main_document:true,url:'https://source.example/'});
  assert.equal(view.kind,'challenge',title);assert.ok(view.playbooks.includes('honor_source_cooldown'));
 }
 assert.equal(hasHtmlChallenge(html('<p>JavaScript is disabled. Verify that you\'re not a robot.</p>')),true);
 // Product copy is not a challenge: the phrase must be the whole document title.
 assert.equal(hasHtmlChallenge(html('<title>Hotels</title><div>Just a moment! We are finding great stays</div>')),false);
 assert.equal(classifyProtection({status:429,...html('<title>Hotels</title>')},{main_document:true}).kind,'rate_limited');
 const dd=sourceChallenge({status:429,...html("<title>Bot or Not?</title><script>var dd={'rt':'c','cid':'synthetic','hsh':'x'}</script>"),url:'https://source.example/'});
 assert.deepEqual(dd,{vendor:'datadome',http_status:429});
 assert.deepEqual(sourceChallenge({status:202,...html('<title>Just a moment...</title>')}),{vendor:'unknown',http_status:202});
 assert.equal(sourceChallenge({status:200,...html('<title>Results</title>')}),null);
});

test('cooldown failures name origin scope, expiry and remaining seconds',()=>{
 const until=new Date(Date.now()+90_000);
 let error;try{cooldownFailure('source.example',until);}catch(e){error=e;}
 assert.equal(error.code,'source_cooldown');assert.equal(error.status,429);
 const view=cooldownView(error.details);
 assert.equal(view.scope,'origin');assert.equal(view.origin,'source.example');assert.equal(view.cooldown_until,until.toISOString());
 assert.ok(view.retry_after_seconds>=89&&view.retry_after_seconds<=90);
 assert.equal(cooldownView({scope:'route',origin:'x'}),null);assert.equal(cooldownView(null),null);
});

test('browser policy keeps same-origin by default and bounds wait ceilings and request caps',()=>{
 const defaults=browserProbePolicy({enabled:true});
 assert.equal(defaults.subresources,'same_origin');assert.equal(defaults.max_wait_ms,defaults.settle_ms);
 const open=browserProbePolicy({enabled:true,max_requests:96,settle_ms:750,max_wait_ms:10000,subresources:'public'});
 assert.equal(open.subresources,'public');assert.equal(open.max_wait_ms,10000);
});

test('browser relay reaches another host only through an admitted subresource pin',async()=>{
 const sockets=new Set();let dialed=0;
 const upstream=net.createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});});
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 const pins=new Map([['cdn.example',{destination:{url:new URL('https://cdn.example/'),address:'93.184.216.34',family:4},permits:1,subresource:true}]]);
 const relay=await browserRelay({profile:{origins:['https://source.example']},pinnedDestinations:pins,resolve:async()=>[{address:'93.184.216.34',family:4}],limits:{max_requests:4,max_network_bytes:65536},deadline:Date.now()+2000,
  dial:()=>{dialed++;return net.connect({host:'127.0.0.1',port:upstream.address().port});}});
 const connect=path=>new Promise((resolve,reject)=>{const req=http.request(relay.url,{method:'CONNECT',path});req.once('connect',(response,socket)=>resolve({response,socket}));req.once('error',reject);req.end();});
 try{
  const other=await connect('other.example:443');assert.equal(other.response.statusCode,403);other.socket.destroy();
  const cdn=await connect('cdn.example:443');assert.equal(cdn.response.statusCode,200);cdn.socket.destroy();
  const again=await connect('cdn.example:443');assert.equal(again.response.statusCode,403);again.socket.destroy();
  assert.equal(dialed,1);
 }finally{await relay.close();for(const socket of sockets)socket.destroy();await new Promise(r=>upstream.close(r));}
});

function makeArtifact(kind,url,body,request=null,main=true){return {kind,url,method:'GET',status:200,headers:{'content-type':kind==='rendered_dom'?'text/html':'application/javascript'},raw_headers:null,captured_at:new Date().toISOString(),content_encoding:kind==='rendered_dom'?null:'identity',decoded_body_base64:body.toString('base64'),decoded_sha256:sha(body),decoded_bytes:body.length,encoded_body_base64:null,encoded_sha256:null,original_encoded_available:false,encoded_bytes:null,encoded_size_basis:null,tunnel_bytes:null,provider_status:null,decoding_error:null,...(kind==='browser_response'?{request,main_document:main}:{generated:true})};}

test('browser probes admit public cross-origin scripts only when the profile allows them',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 assert.match(new URL(process.env.TEST_DATABASE_URL).pathname,/^\/gateway_test_[A-Za-z0-9_]+$/);
 const root=await mkdtemp(join(tmpdir(),'render-access-')),store=new Store(process.env.TEST_DATABASE_URL);await store.init();
 await store.pool.query('TRUNCATE v2_registry,v2_discovery_profiles,v2_ledger_events,v2_artifacts,v2_ledger,v2_operations,v2_sessions,workflows,source_limits RESTART IDENTITY CASCADE');
 const browser={enabled:true,max_requests:12,max_network_bytes:65536,max_decoded_bytes:65536,max_dom_bytes:4096,settle_ms:0,max_wait_ms:5000,subresources:'public',frames:true,page_post:true};
 const profile={id:'render',version:1,origins:['https://source.gov'],methods:['GET','HEAD'],headers:['accept'],proxy_classes:['direct'],countries:[],limits:{max_requests:20,max_encoded_bytes:65536,max_decoded_bytes:65536,max_session_encoded_bytes:262144,min_interval_ms:0},browser_probe:browser};
 const config={release:'render-access-test',artifactDir:root,artifactKey:'42'.repeat(32),maxDailyFallbackCredits:0,projects:{a:{profiles:[],v2_access_profiles:['render@1','closed@1'],tokenHash:sha('key-a')}},proxies:[],v2:{accessProfiles:{'render@1':profile,'closed@1':{...profile,id:'closed',browser_probe:{...browser,subresources:'same_origin',frames:false,page_post:false}}}},residential:{maxTotalBytes:0,maxDailyBytes:0,providers:{}}};
 const addresses={'source.gov':'93.184.216.34','cdn.example.net':'93.184.216.35','internal.example.net':'10.0.0.5'};
 const gateway=new Gateway({store,config,profiles:{},resolve:async host=>[{address:addresses[host]??'93.184.216.36',family:4}]});
 const outcomes=[];
 gateway.v2=new V2Gateway(gateway,{browserRuntime:async()=>({available:true,runtime:{engine:'chromium',version:'1.2.3.4',synthetic:true}}),
  relayFactory:async()=>({url:'http://127.0.0.1:1',bytes:512,error:null,connections:2,dispatched:true,provider_status:null,close:async()=>{}}),
  browserRunner:async(input,hooks)=>{
   const doc={url:input.url,method:'GET',headers:{accept:'text/html'},body_base64:null,resource_type:'document',redirect_depth:0,redirected_from:null};
   await hooks.admit(doc);
   const attempt=async request=>{try{await hooks.admit({headers:{},body_base64:null,redirect_depth:0,redirected_from:null,method:'GET',...request});return 'ok';}catch(e){return e.code;}};
   for(const request of [
    {url:'https://cdn.example.net/app.js',resource_type:'script'},
    {url:'https://cdn.example.net/hero.jpg',resource_type:'image'},
    {url:'https://captcha.example.net/widget',resource_type:'document',frame:'child'},
    {url:'https://cdn.example.net/api',resource_type:'fetch',method:'POST',body_bytes:120,headers:{'x-api-key':'site-public-key'}},
    {url:'https://source.gov/graphql',resource_type:'xhr',method:'POST',body_bytes:300},
    {url:'https://cdn.example.net/navigate',resource_type:'document',frame:'main'},
    {url:'https://internal.example.net/x.js',resource_type:'script'},
    {url:'http://cdn.example.net/plain.js',resource_type:'script'},
    {url:'https://cdn.example.net/api',resource_type:'fetch',method:'HEAD'},
    {url:'https://source.gov/huge',resource_type:'fetch',method:'POST',body_bytes:70000},
    {url:'https://source.gov/form',resource_type:'document',method:'POST',body_bytes:10,frame:'main'},
    {url:'https://cdn.example.net/x',resource_type:'script',headers:{'proxy-authorization':'Basic x'}},
   ])outcomes.push(await attempt(request));
   await hooks.artifact(makeArtifact('browser_response',input.url,Buffer.from('<html></html>'),doc));
   if(outcomes[0]==='ok')await hooks.artifact(makeArtifact('browser_response','https://cdn.example.net/app.js',Buffer.from('void 0'),{url:'https://cdn.example.net/app.js',method:'GET',headers:{},body_base64:null,resource_type:'script'},false));
   await hooks.artifact(makeArtifact('rendered_dom',input.url,Buffer.from('<html>rendered</html>')));
   return {status:200,final_url:input.url,error:null,capture_complete:true,physical_requests:2,blocked_requests:0,blocked_reasons:{},encoded_bytes:null,decoded_bytes:19,dom_bytes:21,cookies:[]};
  }});
 const app=server(gateway),headers={authorization:'Bearer key-a'};
 const post=async(url,payload)=>(await app.inject({method:'POST',url,headers,payload})).json();
 const session=async(key,id='render')=>post('/v2/sessions',{idempotency_key:key,access_profile:{id,version:1},transport:'http',proxy:{class:'direct',country:null,affinity:'session'}});
 try{
  assert.equal((await post('/v2/browser-probes',{idempotency_key:'too-long',session_id:(await session('s0')).id,url:'https://source.gov/',wait_ms:5001})).error,'browser_wait_ceiling_rejected');
  const open=await post('/v2/browser-probes',{idempotency_key:'public',session_id:(await session('s1')).id,url:'https://source.gov/',wait_ms:5000});
  assert.equal(open.state,'completed',JSON.stringify(open));
  assert.deepEqual(outcomes,['ok','ok','ok','ok','ok','destination_rejected','destination_rejected','destination_rejected','destination_rejected','method_rejected','method_rejected','credential_scope_rejected']);
  assert.equal(open.result.physical_requests,6);assert.equal(open.result.subresource_origins,2);
  assert.deepEqual(open.result.browser,{engine:'chromium',version:'1.2.3.4'});
  const kinds=open.result.artifacts.map(a=>a.kind);assert.deepEqual(kinds,['browser_response','browser_response','rendered_dom']);

  outcomes.length=0;
  const closed=await post('/v2/browser-probes',{idempotency_key:'same-origin',session_id:(await session('s2','closed')).id,url:'https://source.gov/'});
  assert.equal(closed.state,'completed',JSON.stringify(closed));
  assert.deepEqual(outcomes.slice(0,5),['destination_rejected','destination_rejected','frame_blocked','method_rejected','method_rejected']);assert.equal(closed.result.subresource_origins,0);
 }finally{await app.close();await store.close?.();}
});

test('real Chromium routes cross-site frame, image and page POST requests through admission',{skip:!process.env.BROWSER_TEST_EXECUTABLE},async()=>{
 const {chromium}=await import('playwright-core');
 const {captureBrowserProbe}=await import('../src/v2-browser-capture.mjs');
 const {BROWSER_PROBE_ARGS,browserProxyArg}=await import('../src/v2-browser-policy.mjs');
 const relay=await browserRelay({profile:{origins:[]},limits:{max_requests:16,max_network_bytes:65536},deadline:Date.now()+15000});
 const browser=await chromium.launch({executablePath:process.env.BROWSER_TEST_EXECUTABLE,headless:true,chromiumSandbox:true,args:[...BROWSER_PROBE_ARGS,browserProxyArg(relay.url,relay.deny_url)]});
 const page=`<!doctype html><link rel="icon" href="data:,"><div id="out">waiting</div><img src="https://img.example.net/p.png">
<iframe src="https://widget.example.net/frame"></iframe>
<script>fetch('/api/search',{method:'POST',headers:{'content-type':'application/json','x-api-key':'site-key'},body:JSON.stringify({q:'hotels'})}).then(r=>r.json()).then(v=>document.querySelector('#out').textContent=v.result);</script>`;
 const frame=`<!doctype html><script src="https://widget.example.net/w.js"></script>`;
 try{
  const admitted=[],artifacts=[];
  const result=await captureBrowserProbe(browser,{url:'https://source.gov/',timeout_ms:8000,deadline:Date.now()+10000,cookies:[]},
   {max_requests:16,max_network_bytes:65536,max_decoded_bytes:65536,max_dom_bytes:65536,settle_ms:500,frames:true,page_post:true},{
   admit:async request=>{admitted.push({url:request.url,method:request.method,type:request.resource_type,frame:request.frame,body_bytes:request.body_bytes});},
   dispatch:async(route,request)=>{
    const u=new URL(request.url);
    if(u.pathname==='/api/search')return route.fulfill({status:200,contentType:'application/json',body:'{"result":"posted-data-arrived"}'});
    if(u.pathname==='/frame')return route.fulfill({status:200,contentType:'text/html',body:frame});
    if(u.pathname==='/w.js')return route.fulfill({status:200,contentType:'application/javascript',body:'void 0'});
    if(u.pathname==='/p.png')return route.fulfill({status:200,contentType:'image/png',body:''});
    return route.fulfill({status:200,contentType:'text/html',body:page});
   },
   artifact:async artifact=>{artifacts.push(artifact);}
  });
  const seen=url=>admitted.find(a=>a.url===url);
  assert.equal(seen('https://source.gov/api/search')?.method,'POST');assert.ok(seen('https://source.gov/api/search').body_bytes>0);
  assert.equal(seen('https://widget.example.net/frame')?.frame,'child');
  assert.equal(seen('https://widget.example.net/w.js')?.frame,'child');
  assert.equal(seen('https://img.example.net/p.png')?.type,'image');
  const dom=artifacts.find(a=>a.kind==='rendered_dom');
  assert.ok(Buffer.from(dom.decoded_body_base64,'base64').toString().includes('posted-data-arrived'));
  assert.equal(result.blocked_reasons.frame_blocked,undefined);assert.equal(result.blocked_reasons.method_rejected,undefined);
 }finally{await browser.close();await relay.close();}
});
