import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,writeFile,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import {gzipSync,brotliCompressSync} from 'node:zlib';
import {Store} from '../src/store.mjs';
import {Gateway} from '../src/gateway.mjs';
import {sha} from '../src/crypto.mjs';
import {server} from '../src/main.mjs';
import {V2Gateway,recoverV2} from '../src/v2.mjs';
import {nativeHttp,pinnedDestination,decodeNative,openPinnedTunnel} from '../src/v2-http.mjs';
import {reserveResidential} from '../src/residential.mjs';
import {provisionV2Project} from '../scripts/provision-v2-project.mjs';

const enabled=!!process.env.TEST_DATABASE_URL;
const destination={url:new URL('https://source.example/data'),address:'93.184.216.34',family:4};
const limits={max_encoded_bytes:4096,max_decoded_bytes:16384,max_expansion_ratio:100,timeout_ms:1000,max_tunnel_bytes:8192};
function fakeRequest(handler){
 return (url,options,callback)=>{
  const req=new EventEmitter();req.destroy=()=>{};
  req.end=body=>setImmediate(()=>{
   try{
    const result=handler(url,options,body),res=new PassThrough();res.statusCode=result.status??200;res.headers=result.headers??{};res.rawHeaders=Object.entries(res.headers).flatMap(([k,v])=>[k,String(v)]);callback(res);res.end(result.body??'');
   }catch(e){req.emit('error',e);}
  });return req;
 };
}

test('v2 pins every destination, rejects mixed/private DNS and preserves significant URL encoding',async()=>{
 const profile={origins:['https://source.example'],paths:['^/data']};
 const pinned=await pinnedDestination('https://source.example/data?q=a%2fb+space&x=2',profile,async()=>[{address:'93.184.216.34'}]);
 assert.equal(pinned.address,'93.184.216.34');assert.equal(pinned.url.search,'?q=a%2fb+space&x=2');
 for(const addresses of [[{address:'127.0.0.1'}],[{address:'93.184.216.34'},{address:'10.0.0.1'}],[{address:'169.254.169.254'}],[{address:'::1'}],[]])await assert.rejects(pinnedDestination('https://source.example/data',profile,async()=>addresses),{code:'destination_rejected'});
 for(const url of ['https://source.example/data/%2e%2e/private','https://source.example\\@evil.example/data','https://user:secret@source.example/data','http://source.example/data'])await assert.rejects(pinnedDestination(url,profile,async()=>[{address:'93.184.216.34'}]),{code:'destination_rejected'});
});

test('v2 native gzip/brotli evidence and bounded decompression retain independent sizes',async()=>{
 const value=Buffer.from(JSON.stringify({value:'native'.repeat(300)}));
 for(const [encoding,compress]of [['gzip',gzipSync],['br',brotliCompressSync]]){
  const encoded=compress(value);let actualPin;
  const requestImpl=fakeRequest((url,options)=>{options.lookup(url.hostname,{},(e,address)=>{actualPin=address;});assert.equal(options.rejectUnauthorized,true);assert.equal(options.servername,'source.example');return {headers:{'content-encoding':encoding},body:encoded};});
  const result=await nativeHttp({method:'GET',headers:{}},destination,limits,{requestImpl});
  assert.deepEqual(result.encoded,encoded);assert.deepEqual(decodeNative(result.encoded,encoding,limits),value);assert.equal(actualPin,destination.address);assert.equal(result.tunnel_bytes,null);
  assert.throws(()=>decodeNative(encoded,encoding,{...limits,max_decoded_bytes:100}),{code:'decoded_body_limit'});
  assert.throws(()=>decodeNative(encoded,encoding,{...limits,max_expansion_ratio:1}),{code:'decompression_ratio_limit'});
 }
 assert.throws(()=>decodeNative(Buffer.from('broken'),'gzip',limits),{code:'content_decoding_failed'});
 assert.throws(()=>decodeNative(Buffer.from('body'),'gzip, br',limits),{code:'content_encoding_unsupported'});
 await assert.rejects(nativeHttp({method:'GET',headers:{}},destination,{...limits,max_encoded_bytes:3},{requestImpl:fakeRequest(()=>({body:'oversized'}))}),{code:'encoded_body_limit'});
});

test('v2 actual synthetic HTTPS response preserves gzip and original attachment bytes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'fetchx-v2-tls-'));let fixture,proxy;const sockets=new Set();
 try{
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(root,'key.pem'),'-out',join(root,'cert.pem'),'-days','1','-subj','/CN=source.example','-addext','subjectAltName=DNS:source.example'],{stdio:'ignore'});
  const cert=await readFile(join(root,'cert.pem')),bytes=Buffer.from('%PDF-1.7\nsynthetic download\n'),encoded=gzipSync(bytes);
  fixture=https.createServer({key:await readFile(join(root,'key.pem')),cert},(req,res)=>{res.writeHead(200,{'Content-Type':'application/pdf','Content-Encoding':'gzip','Content-Disposition':'attachment; filename="bill.pdf"'});res.end(encoded);});
  await new Promise(r=>fixture.listen(0,'127.0.0.1',r));
  const result=await nativeHttp({method:'GET',headers:{}},destination,limits,{requestImpl:(url,options,cb)=>{
   options.lookup(url.hostname,{},(e,address)=>assert.equal(address,destination.address));
   return https.request({...options,hostname:'127.0.0.1',port:fixture.address().port,path:url.pathname,servername:'source.example',ca:cert},cb);
  }});
  assert.equal(result.status,200);assert.deepEqual(result.encoded,encoded);assert.deepEqual(decodeNative(result.encoded,'gzip',limits),bytes);assert.match(result.headers['content-disposition'],/bill.pdf/);
  const head=await nativeHttp({method:'HEAD',headers:{}},destination,limits,{requestImpl:(url,options,cb)=>https.request({...options,hostname:'127.0.0.1',port:fixture.address().port,path:url.pathname,servername:'source.example',ca:cert},cb)});
  assert.equal(head.status,200);assert.equal(head.headers['content-encoding'],'gzip');assert.equal(head.encoded.length,0);
  proxy=net.createServer(socket=>{
   sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));
   socket.once('data',header=>{
    assert.match(header.toString(),/^CONNECT 93\.184\.216\.34:443 HTTP\/1.1/);
    const remote=net.connect({host:'127.0.0.1',port:fixture.address().port});sockets.add(remote);remote.on('close',()=>sockets.delete(remote));remote.on('error',()=>socket.destroy());
    remote.once('connect',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');socket.pipe(remote);remote.pipe(socket);});
   });
  });
  await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
  const proxied=await nativeHttp({method:'GET',headers:{}},destination,limits,{proxy:{url:`http://127.0.0.1:${proxy.address().port}`},tlsImpl:options=>{assert.equal(options.servername,'source.example');assert.equal(options.rejectUnauthorized,true);return tls.connect({...options,ca:cert});}});
  assert.deepEqual(proxied.encoded,encoded);assert.equal(proxied.provider_status,200);assert.ok(proxied.tunnel_bytes>encoded.length);assert.deepEqual(decodeNative(proxied.encoded,'gzip',limits),bytes);
 }finally{for(const s of sockets)s.destroy();if(proxy)await new Promise(r=>proxy.close(r));if(fixture)await new Promise(r=>fixture.close(r));await rm(root,{recursive:true,force:true});}
});

test('v2 proxy CONNECT pins IP, confines credentials and meters both tunnel directions',async()=>{
 let connectText;const sockets=new Set();
 const proxy=net.createServer(socket=>{
  sockets.add(socket);socket.on('close',()=>sockets.delete(socket));
  let initialized=false;
  socket.on('data',b=>{if(!initialized){connectText=b.toString();initialized=true;socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');}else socket.write(Buffer.from('pong'));});
 });
 await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
 const meter={bytes:0,provider_status:null};let tunnel;
 try{
  tunnel=await openPinnedTunnel({url:`http://private-user:private-password@127.0.0.1:${proxy.address().port}`},destination,limits,meter);
  tunnel.write('ping');const response=await new Promise((r,j)=>{tunnel.once('data',r);tunnel.once('error',j);});
  assert.equal(response.toString(),'pong');assert.match(connectText,/CONNECT 93\.184\.216\.34:443 HTTP\/1.1/);assert.ok(!connectText.includes('source.example'));assert.match(connectText,/Proxy-Authorization: Basic/);assert.equal(meter.provider_status,200);assert.equal(meter.bytes,Buffer.byteLength(connectText)+Buffer.byteLength('HTTP/1.1 200 Connection Established\r\n\r\n')+8);
 }finally{tunnel?.destroy();for(const s of sockets)s.destroy();await new Promise(r=>proxy.close(r));}
});

function baseConfig(root){
 const p={id:'source',version:1,origins:['https://source.example'],paths:['^/'],method_paths:{GET:['^/'],POST:['^/readonly-form$']},methods:['GET','POST'],headers:['accept','content-type','authorization'],proxy_classes:['direct','datacenter','residential'],countries:['US'],limits:{max_requests:100,max_encoded_bytes:4096,max_decoded_bytes:16384,max_session_encoded_bytes:65536,max_input_bytes:1024,max_tunnel_bytes:8192,max_redirects:2,max_expansion_ratio:100,timeout_ms:2000,min_interval_ms:0,ttl_seconds:900}};
 return {release:'synthetic-v2',artifactDir:root,artifactKey:'12'.repeat(32),maxDailyFallbackCredits:0,projects:{a:{keyId:'key-a',tokenHash:sha('project-a-secret'),profiles:[],v2_access_profiles:['source@1'],v2_entitlement:{mode:'unmetered'}},b:{keyId:'key-b',tokenHash:sha('project-b-secret'),profiles:[],v2_access_profiles:['source@1']}},proxies:[{id:'dc-us',country:'US',url:'http://proxy-user:proxy-password@configured-proxy.example:8080'}],v2:{accessProfiles:{'source@1':p},recipes:{'lookup@1':{id:'lookup',version:1,access_profile:{id:'source',version:1},kind:'http',json_pointers:{value:'/value',escaped:'/a~1b/~0key'}}}},residential:{maxTotalBytes:1000000,maxDailyBytes:1000000,providers:{evomi:{enabled:true,username:'vendor-user',password:'vendor-password',countries:['US'],maxTotalBytes:1000000,microUsdPerGB:1000000,priorReservedBytes:1234}}}};
}

test('v2 API scoped idempotency, native artifacts, cookie isolation, proxy selection, immutable versions, usage and restart',{skip:!enabled},async()=>{
 assert.match(new URL(process.env.TEST_DATABASE_URL).pathname,/^\/gateway_test_[A-Za-z0-9_]+$/);
 const root=await mkdtemp(join(tmpdir(),'fetchx-v2-')),store=new Store(process.env.TEST_DATABASE_URL);await store.init();
 await store.pool.query('TRUNCATE v2_registry,v2_ledger_events,v2_artifacts,v2_ledger,v2_operations,v2_sessions,workflows,source_limits RESTART IDENTITY CASCADE');
 const config=baseConfig(root),calls=[];
 const gateway=new Gateway({store,config,profiles:{},resolve:async host=>[{address:host==='private.example'?'127.0.0.1':'93.184.216.34'}]});
 let mode='json';
 gateway.v2=new V2Gateway(gateway,{http:async(input,dest,cap,{proxy})=>{
  calls.push({input,proxy,address:dest.address});
  if(mode==='unknown'){const e=Error('sensitive transport detail');e.code='does-not-leak';throw e;}
  const headers={'content-type':'application/json','set-cookie':['sid=one; Path=/; Secure; HttpOnly']};let value=Buffer.from('{"value":42,"a/b":{"~key":"escaped"}}');
  if(input.url.endsWith('/redirect')){headers.location='https://private.example/private';return {status:302,headers,encoded:Buffer.from('redirect'),provider_status:null};}
  if(input.url.endsWith('/cookie-path'))headers['set-cookie']=['scoped=narrow; Path=/private; Secure'];
  if(mode==='gzip'){headers['content-encoding']='gzip';value=gzipSync(value);}
  if(mode==='bomb'){headers['content-encoding']='br';value=brotliCompressSync(Buffer.alloc(100000,65));}
  if(mode==='download'){headers['content-type']='application/pdf';headers['content-disposition']='attachment; filename="native.pdf"';value=Buffer.from('%PDF-native');}
  return {status:mode==='source-fail'?503:200,headers,raw_headers:Object.entries(headers).flat(),encoded:value,tunnel_bytes:proxy?500:null,provider_status:proxy?200:null};
 }});
 const app=server(gateway),auth={authorization:'Bearer project-a-secret'},authB={authorization:'Bearer project-b-secret'};
 const post=async(url,payload,headers=auth)=>{const r=await app.inject({method:'POST',url,payload,headers});return {status:r.statusCode,body:r.json()};};
 const sessionInput=k=>({idempotency_key:k,access_profile:{id:'source',version:1},transport:'http',proxy:{class:'direct',country:null,affinity:'session'}});
 const request=(session,k,path='/data')=>({idempotency_key:k,session_id:session,request:{url:'https://source.example'+path}});
 try{
  assert.equal((await app.inject('/v2/capabilities')).statusCode,401);
  assert.equal((await app.inject({url:'/v2/capabilities',headers:auth})).json().transports.browser,false);
  assert.equal((await app.inject({url:'/v2/access-profiles',headers:auth})).json().access_profiles.length,1);
  assert.equal((await app.inject({url:'/v2/recipes',headers:auth})).json().recipes.length,1);
  const s=(await post('/v2/sessions',sessionInput('s1'))).body;assert.equal(s.proxy.class,'direct');assert.equal((await post('/v2/sessions',sessionInput('s1'))).body.id,s.id);
  assert.equal((await post('/v2/sessions',{...sessionInput('s1'),transport:'browser'})).body.error,'capability_unsupported');
  assert.equal((await post('/v2/sessions',{...sessionInput('bad-country'),proxy:{class:'direct',country:'US',affinity:'session'}})).body.error,'direct_country_unverified');
  mode='gzip';const input={...request(s.id,'lookup'),recipe:{id:'lookup',version:1}};
  const first=await post('/v2/operations',input);assert.equal(first.status,200);assert.equal(first.body.state,'completed');assert.deepEqual(first.body.result.extracted,{value:42,escaped:'escaped'});
  assert.equal(first.body.result.physical_requests,1);assert.deepEqual((await post('/v2/operations',input)).body,first.body);assert.equal(calls.length,1);
  const artifactId=first.body.result.artifacts[0].id;
  const artifact=(await app.inject({url:'/v2/artifacts/'+artifactId,headers:auth})).json();
  assert.equal(artifact.content_encoding,'gzip');assert.equal(artifact.encoded_sha256,sha(Buffer.from(artifact.encoded_body_base64,'base64')));assert.equal(JSON.parse(Buffer.from(artifact.decoded_body_base64,'base64')).value,42);
  assert.equal((await app.inject({url:'/v2/operations/'+first.body.id,headers:authB})).statusCode,404);
  assert.equal((await app.inject({url:'/v2/artifacts/'+artifactId,headers:authB})).statusCode,404);
  assert.equal((await app.inject({url:'/v2/operations/by-key/lookup',headers:authB})).statusCode,404);
  assert.equal((await app.inject({url:'/v2/sessions/'+s.id,headers:authB})).statusCode,404);
  assert.equal((await post('/v2/operations',{...input,request:{url:'https://source.example/changed'}})).body.error,'idempotency_conflict');
  assert.equal((await app.inject({url:'/v2/operations/by-key/lookup',headers:auth})).json().id,first.body.id);
  mode='json';await post('/v2/operations',request(s.id,'cookie-next','/cookie-path'));assert.equal(calls.at(-1).input.headers.cookie,'sid=one');
  const deniedPost=await post('/v2/operations',{...request(s.id,'method-path-reject'),request:{url:'https://source.example/data',method:'POST'}});assert.equal(deniedPost.body.error,'endpoint_method_rejected');assert.equal(deniedPost.body.result.physical_requests,0);
  const acceptedPost=await post('/v2/operations',{...request(s.id,'method-path-approved'),request:{url:'https://source.example/readonly-form',method:'POST',headers:{'content-type':'application/json'},body_base64:Buffer.from('{"search":"synthetic"}').toString('base64')},max_estimated_micro_usd:0});assert.equal(acceptedPost.body.state,'completed');assert.equal(acceptedPost.body.accounting.estimated_micro_usd,0);
  await post('/v2/operations',request(s.id,'cookie-path-check'));assert.equal(calls.at(-1).input.headers.cookie,'sid=one');
  const renewed=new V2Gateway(gateway,{http:gateway.v2.http});await renewed.operation('a',request(s.id,'cookie-after-restart'));assert.equal(calls.at(-1).input.headers.cookie,'sid=one');
  const separate=(await post('/v2/sessions',sessionInput('s2'))).body;await post('/v2/operations',request(separate.id,'separate'));assert.equal(calls.at(-1).input.headers.cookie,undefined);
  const encrypted=(await store.pool.query('SELECT cookie_jar FROM v2_sessions WHERE id=$1',[s.id])).rows[0].cookie_jar;assert.ok(!encrypted.includes(Buffer.from('sid')));
  for(const headers of [{cookie:'bypass=1'},{authorization:'Bearer project-a-secret'},{'proxy-authorization':'provider-secret'}]){
   const r=await post('/v2/operations',{...request(s.id,randomUUID()),request:{url:'https://source.example/data',headers}});assert.equal(r.body.state,'failed');assert.equal(r.body.result.physical_requests,0);
  }
  const beforeRedirect=calls.length;config.v2.accessProfiles['source@1'].origins.push('https://private.example');
  assert.equal((await post('/v2/sessions',sessionInput('immutable'))).body.error,'version_immutable');config.v2.accessProfiles['source@1'].origins.pop();
  const redirect=await post('/v2/operations',request(s.id,'private-redirect','/redirect'));assert.equal(redirect.body.state,'failed');assert.equal(redirect.body.error,'destination_rejected');assert.equal(calls.length-beforeRedirect,1);assert.equal(redirect.body.result.artifacts.length,1);
  mode='download';const download=await post('/v2/operations',request(s.id,'download'));assert.equal(download.body.result.artifacts[0].kind,'download');
  mode='bomb';const bomb=await post('/v2/operations',request(s.id,'bomb'));assert.equal(bomb.body.error,'decoded_body_limit');const bombArtifact=await gateway.v2.artifact('a',bomb.body.result.artifacts[0].id);assert.equal(bombArtifact.decoded_body_base64,null);assert.ok(bombArtifact.encoded_body_base64);
  mode='json';
  for(const cls of ['datacenter','residential']){
   const created=await post('/v2/sessions',{...sessionInput(cls),proxy:{class:cls,country:'US',affinity:'session'}});assert.equal(created.body.proxy.class,cls);
   const outcome=await post('/v2/operations',request(created.body.id,cls));assert.equal(outcome.body.state,'completed');assert.equal(outcome.body.accounting.reserved_tunnel_bytes,8192*3);assert.equal(outcome.body.accounting.observed_tunnel_bytes,500);assert.equal(outcome.body.accounting.invoice_micro_usd,null);
   assert.ok(calls.at(-1).proxy);assert.equal(calls.at(-1).address,'93.184.216.34');
   if(cls==='residential')assert.match(calls.at(-1).proxy.url,/_country-US_session-/);
   const quoted=(await app.inject({url:'/v2/access-profiles',headers:auth})).json().access_profiles[0].route_reservations.find(r=>r.class===cls);assert.equal(quoted.reserved_tunnel_bytes,24576);assert.equal(quoted.estimated_micro_usd,cls==='residential'?25:null);
   const deniedCost=await post('/v2/operations',{...request(created.body.id,cls+'-ceiling'),max_estimated_micro_usd:0});assert.equal(deniedCost.body.error,cls==='residential'?'cost_ceiling_exceeded':'cost_estimate_unavailable');
  }
  const held=(await store.pool.query("SELECT accounted_tunnel_bytes FROM v2_ledger WHERE proxy_class='residential'")).rows[0];assert.equal(Number(held.accounted_tunnel_bytes),24576);
  const v1w={id:randomUUID(),project:'a',config:{country:'US',residentialSession:'abcdef1234',maxAttemptBytes:980000,maxResidentialBytes:1000000,execution:'http'}};
  await assert.rejects(store.tx(c=>reserveResidential(c,config,v1w,randomUUID(),'evomi')),{code:'residential_budget_exhausted'});
  config.projects.a.v2_entitlement={mode:'metered',max_daily_operations:1};
  assert.equal((await post('/v2/operations',request(s.id,'quota'))).body.error,'client_quota_exhausted');config.projects.a.v2_entitlement={mode:'unmetered'};
  mode='source-fail';await post('/v2/operations',request(s.id,'source-failure'));mode='json';
  const uncertain=(await post('/v2/sessions',sessionInput('actual-unknown'))).body;mode='unknown';const uncertainInput=request(uncertain.id,'actual-unknown');const uncertainOutcome=await post('/v2/operations',uncertainInput);assert.equal(uncertainOutcome.body.state,'unknown');assert.equal(uncertainOutcome.body.result.physical_requests,1);const unknownCalls=calls.length;assert.equal((await post('/v2/operations',uncertainInput)).body.state,'unknown');assert.equal(calls.length,unknownCalls);mode='json';
  const originalResolve=gateway.resolve;gateway.resolve=async()=>{throw Object.assign(new Error('private hostname/source token'),{code:'ENOTFOUND'});};const dnsGateway=new V2Gateway(gateway,{http:gateway.v2.http});gateway.resolve=originalResolve;
  const dnsFailed=await dnsGateway.operation('a',request(s.id,'dns-before-dispatch'));assert.equal(dnsFailed.error,'source_dns_not_found');assert.equal(dnsFailed.result.physical_requests,0);assert.equal(dnsFailed.result.diagnostics.failure.cause_code,'ENOTFOUND');assert.equal(dnsFailed.result.diagnostics.stage,'dns');assert.ok(!JSON.stringify(dnsFailed).includes('private hostname'));
  const sqlGateway=new V2Gateway(gateway,{http:gateway.v2.http});sqlGateway.pace=async()=>{throw Object.assign(new Error('private SQL and password'),{code:'42P01'});};const sqlFailed=await sqlGateway.operation('a',request(s.id,'sql-before-dispatch'));assert.equal(sqlFailed.error,'operation_internal_error');assert.equal(sqlFailed.result.physical_requests,0);assert.equal(sqlFailed.result.diagnostics.stage,'pacing');assert.equal(sqlFailed.result.diagnostics.failure.cause_code,'42P01');assert.ok(!JSON.stringify(sqlFailed).includes('private SQL'));
  const usage=(await app.inject({url:'/v2/usage',headers:auth})).json();assert.equal(usage.entitlement.max_daily_operations,null);assert.ok(usage.outcomes.source_successes>=5);assert.equal(usage.outcomes.source_failures,1);assert.ok(usage.outcomes.gateway_failures>=4);assert.ok(usage.by_key_and_state.every(r=>r.key_id==='key-a'));assert.ok(usage.by_key_and_state.some(r=>r.unknown_invoice_operations>0));
  const recent=(await app.inject({url:'/v2/operations?limit=5',headers:auth})).json();assert.equal(recent.operations.length,5);assert.ok(recent.operations.every(o=>o.key_id==='key-a'));assert.ok(!JSON.stringify(recent).includes('body_base64'));assert.ok(!JSON.stringify(recent).includes('https://source.example'));assert.ok(recent.operations.some(o=>o.error==='source_dns_not_found'));assert.ok(recent.operations.every(o=>!Object.hasOwn(o,'extracted')));
  assert.equal((await app.inject('/v2/operations')).statusCode,401);assert.equal((await app.inject({url:'/v2/operations?limit=99',headers:auth})).statusCode,400);assert.equal((await app.inject({url:'/v2/operations',headers:authB})).json().operations.length,0);
  const pending=(await post('/v2/sessions',sessionInput('restart'))).body;
  const interrupted=await gateway.v2.operation('a',request(pending.id,'will-interrupt'));await store.pool.query("UPDATE v2_operations SET state='running',result=NULL,finished_at=NULL WHERE id=$1",[interrupted.id]);
  const count=calls.length;await recoverV2(store.pool);const unknown=await post('/v2/operations',request(pending.id,'will-interrupt'));assert.equal(unknown.body.state,'unknown');assert.equal(unknown.body.error,'interrupted_unknown');assert.equal(unknown.body.result.partial,true);assert.equal(unknown.body.result.physical_requests,null);assert.equal(unknown.body.result.artifacts.length,1);assert.equal(calls.length,count);
  assert.equal((await post('/v2/operations',request(pending.id,'must-not-replay'))).body.error,'session_busy_or_unknown');
  assert.equal((await app.inject({url:'/v2/usage',headers:authB})).json().outcomes.physical_requests,0);
 }finally{await app.close();await store.pool.query('TRUNCATE v2_registry,v2_ledger_events,v2_artifacts,v2_ledger,v2_operations,v2_sessions RESTART IDENTITY CASCADE');await store.close();await rm(root,{recursive:true,force:true});}
});

test('v2 preserves bodyless HEAD and 204/205/304 representation headers without decompressing absent bodies',{skip:!enabled},async()=>{
 assert.match(new URL(process.env.TEST_DATABASE_URL).pathname,/^\/gateway_test_[A-Za-z0-9_]+$/);
 const root=await mkdtemp(join(tmpdir(),'fetchx-v2-bodyless-')),store=new Store(process.env.TEST_DATABASE_URL);await store.init();
 await store.pool.query('TRUNCATE v2_registry,v2_ledger_events,v2_artifacts,v2_ledger,v2_operations,v2_sessions,workflows,source_limits RESTART IDENTITY CASCADE');
 const config=baseConfig(root),profile=config.v2.accessProfiles['source@1'];profile.methods.push('HEAD');profile.method_paths.HEAD=['^/'];
 const gateway=new Gateway({store,config,profiles:{},resolve:async()=>[{address:'93.184.216.34',family:4}]});let status=200,encoded=Buffer.alloc(0);
 gateway.v2=new V2Gateway(gateway,{http:async()=>({status,headers:{'content-encoding':'gzip','content-type':'text/html'},raw_headers:['Content-Encoding','gzip','Content-Type','text/html'],encoded,tunnel_bytes:null,provider_status:null})});
 try{
  const session=await gateway.v2.session('a',{idempotency_key:'bodyless',access_profile:{id:'source',version:1},transport:'http',proxy:{class:'direct',country:null,affinity:'session'}});
  for(const [method,code]of [['HEAD',200],['GET',204],['GET',205],['GET',304]]){
   status=code;const result=await gateway.v2.operation('a',{idempotency_key:method+'-'+code,session_id:session.id,request:{url:'https://source.example/data',method}});
   assert.equal(result.state,'completed');assert.equal(result.error,null);assert.equal(result.result.status,code);assert.equal(result.result.physical_requests,1);assert.equal(result.result.encoded_bytes,0);assert.equal(result.result.decoded_bytes,0);
   const artifact=await gateway.v2.artifact('a',result.result.artifacts[0].id);assert.equal(artifact.headers['content-encoding'],'gzip');assert.deepEqual(artifact.raw_headers,['Content-Encoding','gzip','Content-Type','text/html']);assert.equal(artifact.encoded_body_base64,'');assert.equal(artifact.decoded_body_base64,'');assert.equal(artifact.encoded_sha256,sha(Buffer.alloc(0)));assert.equal(artifact.decoded_sha256,sha(Buffer.alloc(0)));assert.equal(artifact.decoding_error,null);
  }
  status=200;const malformed=await gateway.v2.operation('a',{idempotency_key:'malformed-gzip',session_id:session.id,request:{url:'https://source.example/data'}});assert.equal(malformed.error,'content_decoding_failed');
  encoded=gzipSync(Buffer.alloc(0));const empty=await gateway.v2.operation('a',{idempotency_key:'valid-empty-gzip',session_id:session.id,request:{url:'https://source.example/data'}});assert.equal(empty.state,'completed');assert.equal(empty.result.decoded_bytes,0);assert.equal(empty.result.encoded_bytes,encoded.length);
 }finally{await store.pool.query('TRUNCATE v2_registry,v2_ledger_events,v2_artifacts,v2_ledger,v2_operations,v2_sessions RESTART IDENTITY CASCADE');await store.close();await rm(root,{recursive:true,force:true});}
});

test('v2 project provisioning writes a private key only to a private env and keeps hash in config',async()=>{
 const root=await mkdtemp(join(tmpdir(),'fetchx-v2-key-'));
 try{
  const configPath=join(root,'gateway.json'),envPath=join(root,'studio.env');await writeFile(configPath,JSON.stringify(baseConfig(root)));
  const result=await provisionV2Project({configPath,envPath,project:'studio',profileKeys:['source@1']});
  const env=await readFile(envPath,'utf8'),config=JSON.parse(await readFile(configPath,'utf8')),token=/FETCHX_TOKEN=(.*)/.exec(env)[1];
  assert.equal((await stat(envPath)).mode&0o777,0o600);assert.equal(config.projects.studio.tokenHash,sha(token));assert.equal(config.projects.studio.v2_entitlement.mode,'unmetered');assert.ok(!JSON.stringify(result).includes(token));assert.ok(!(await readFile(configPath,'utf8')).includes(token));
  await assert.rejects(provisionV2Project({configPath,envPath,project:'studio',profileKeys:['source@1']}),/project_already_exists/);
 }finally{await rm(root,{recursive:true,force:true});}
});
