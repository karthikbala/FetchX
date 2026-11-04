import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import net from 'node:net';
import {execFileSync} from 'node:child_process';
import {createHash,X509Certificate} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {binarySha,browserProbeLaunchOptions} from '../src/v2-browser-policy.mjs';
import {captureBrowserProbe} from '../src/v2-browser-capture.mjs';
import {runBrowserProbe} from '../src/v2-browser-runner.mjs';
import {browserRelay} from '../src/v2-browser-relay.mjs';
import {pinnedDestination} from '../src/v2-http.mjs';
import {GatewayError} from '../src/policy.mjs';

const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const close=server=>new Promise(resolve=>server.close(resolve));
const fixtureHost='source.example',origin='https://'+fixtureHost,publicAddress='93.184.216.34';
const documentHTML=`<!doctype html><link rel="icon" href="data:,"><p id="receipt">pending</p>
 <iframe src="/forbidden-frame"></iframe>
 <script>
  fetch('/data').then(r=>r.text()).then(v=>document.querySelector('#receipt').textContent=v);
  for (const path of ['/redirect-fetch','/redirect-cross','/redirect-private']) fetch(path).catch(()=>{});
  fetch('/forbidden-method',{method:'POST',body:'unsafe'}).catch(()=>{});
  fetch('/forbidden-auth',{headers:{authorization:'Bearer synthetic'}}).catch(()=>{});
  const xhr=new XMLHttpRequest();xhr.open('GET','/redirect-xhr');xhr.send();
  window.open('/forbidden-popup');
  try { new Worker('/forbidden-worker'); } catch {}
  try { new Worker(URL.createObjectURL(new Blob(["fetch('/forbidden-blob-worker')"]))); } catch {}
  try { new WebSocket('wss://source.example/forbidden-socket'); } catch {}
 </script>`;
const redirects=new Map([
 ['/start','/document'],['/blocked-navigation','/forbidden-navigation'],['/redirect-fetch','/forbidden-fetch'],
 ['/redirect-xhr','/forbidden-xhr'],['/redirect-cross','https://outside.example/forbidden-cross'],
 ['/redirect-private','https://private.example/forbidden-private']
]);

test('real Chromium admits every TLS redirect before dispatch and renders over one pinned synthetic proxy',{skip:!process.env.BROWSER_TEST_EXECUTABLE},async()=>{
 const {chromium}=await import('playwright-core');
 const directory=await mkdtemp(join(tmpdir(),'fetchx-browser-tls-'));
 const executablePath=process.env.BROWSER_TEST_EXECUTABLE,engine=process.env.BROWSER_TEST_RUNTIME_ENGINE??'chromium';
 const runtime={engine,executablePath,sha256:await binarySha(executablePath),version:process.env.BROWSER_TEST_RUNTIME_VERSION??'156.0.0.0',...(engine==='cloakbrowser'?{entitlement:'unlicensed'}:{})};
 const certificate=join(directory,'certificate.pem'),key=join(directory,'key.pem');
 const hits=[],connects=[],sockets=new Set();
 let source,proxy;
 try{
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN='+fixtureHost,'-keyout',key,'-out',certificate],{stdio:'ignore'});
  const cert=await readFile(certificate);
  const spki=createHash('sha256').update(new X509Certificate(cert).publicKey.export({type:'spki',format:'der'})).digest('base64');
  source=https.createServer({key:await readFile(key),cert},(req,res)=>{
   hits.push({path:req.url,method:req.method,connection:req.headers.connection,socket:req.socket});
   const location=redirects.get(req.url);
   if(location){res.writeHead(302,{location});res.end();return;}
   if(req.url==='/reset'){req.socket.destroy();return;}
   if(req.url==='/document'){
    res.writeHead(200,{'content-type':'text/html','content-security-policy':"base-uri 'none'",'x-fixture':'native'});
    res.end(documentHTML);return;
   }
   res.writeHead(200,{'content-type':'text/plain'});res.end(req.url==='/data'?'TLS rendered fixture':'unexpected');
  });
  source.on('upgrade',(req,socket)=>{hits.push({path:req.url,method:req.method});socket.destroy();});
  await listen(source);
  proxy=net.createServer(client=>{
   sockets.add(client);client.on('close',()=>sockets.delete(client));client.on('error',()=>{});
   let buffered='';
   function connect(chunk){
    buffered+=chunk.toString('ascii');
    if(!buffered.endsWith('\r\n\r\n'))return;
    client.off('data',connect);connects.push(buffered.split('\r\n')[0]);
    if(!buffered.startsWith('CONNECT '+publicAddress+':443 HTTP/1.1\r\n')){client.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}
    const target=net.connect({host:'127.0.0.1',port:source.address().port});
    target.once('connect',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');client.pipe(target).pipe(client);});
    target.on('error',()=>client.destroy());client.on('close',()=>target.destroy());
   }
   client.on('data',connect);
  });
  await listen(proxy);
  const profile={origins:[origin,'https://outside.example','https://private.example'],paths:['^/(?:start|blocked-navigation|document|data|reset|redirect-(?:fetch|xhr|cross|private)|forbidden-(?:auth|method|cross|private|worker|blob-worker|popup|frame|socket))$']};
  const resolve=async host=>[{address:host==='private.example'?'169.254.169.254':publicAddress}];
  async function run(path,{trustFixture=false,screenshot=false,maxRequests=16,isolatedWorker=false}={}){
   const policy={max_requests:maxRequests,max_network_bytes:1024*1024,max_decoded_bytes:65536,max_dom_bytes:65536,settle_ms:650};
   const pinnedDestinations=new Map();
   const deadline=Date.now()+12000;
   const relay=await browserRelay({profile,pinnedDestinations,proxy:{url:`http://127.0.0.1:${proxy.address().port}`},limits:policy,deadline});
   let browser,server;
   try{
    const attempts=[],artifacts=[];
    const input={url:origin+path,timeout_ms:8000,deadline,screenshot};
    const hooks={
     admit:async request=>{
      attempts.push(request);
      const destination=await pinnedDestination(request.url,profile,resolve);
      if(request.redirected_from&&new URL(request.redirected_from).origin!==destination.url.origin)throw new GatewayError('redirect_origin_rejected');
      if(Object.keys(request.headers).some(name=>name.toLowerCase()==='authorization'))throw new GatewayError('credential_scope_rejected');
      const pin=pinnedDestinations.get(destination.url.hostname)??{destination,permits:0};
      pin.permits++;pinnedDestinations.set(destination.url.hostname,pin);
      if(destination.url.pathname==='/data')await new Promise(resolve=>setTimeout(resolve,100));
     },
     artifact:async artifact=>artifacts.push(artifact)
    };
    let result;
    if(isolatedWorker){
     // Execute the isolated worker, IPC and launch guards against the local
     // Chromium fixture. The executable is never configured as a ready runtime.
     result=await runBrowserProbe({...input,policy,runtime:{...runtime,expires_at:new Date(deadline).toISOString()},relay:relay.url,deny_relay:relay.deny_url},hooks);
    }else{
     const options=await browserProbeLaunchOptions(runtime,{relay:relay.url,denyRelay:relay.deny_url,cacheDir:directory,deadline});
     // The exception applies only to this freshly generated fixture key.
     if(trustFixture)options.args.push('--ignore-certificate-errors-spki-list='+spki);
     server=await chromium.launchServer(options);
     browser=await chromium.connect(server.wsEndpoint());
     result=await captureBrowserProbe(browser,input,policy,hooks);
    }
    return {result,attempts,artifacts};
   }finally{await browser?.close().catch(()=>{});await server?.close().catch(()=>{});await relay.close();}
  }
  const untrusted=await run('/start',{isolatedWorker:true});
  assert.equal(untrusted.result.error,'ERR_CERT_AUTHORITY_INVALID');
  assert.equal(hits.length,0);
  const blocked=await run('/blocked-navigation',{trustFixture:true});
  assert.deepEqual(blocked.attempts.map(a=>[new URL(a.url).pathname,a.redirect_depth]),[['/blocked-navigation',0],['/forbidden-navigation',1]]);
  assert.deepEqual(hits.map(h=>h.path),['/blocked-navigation']);
  assert.equal(blocked.result.blocked_reasons.endpoint_rejected,1);
  const {result,attempts,artifacts}=await run('/start',{trustFixture:true,screenshot:true});
  assert.equal(result.error,null);
  assert.equal(result.status,200);
  assert.equal(result.final_url,origin+'/document');
  assert.equal(result.capture_complete,false);
  assert.equal(result.physical_requests,7);
  assert.equal(result.blocked_reasons.endpoint_rejected,2);
  assert.equal(result.blocked_reasons.redirect_origin_rejected,1);
  assert.equal(result.blocked_reasons.destination_rejected,1);
  assert.equal(result.blocked_reasons.method_rejected,1);
  assert.equal(result.blocked_reasons.credential_scope_rejected,1);
  assert.equal(result.blocked_reasons.websocket_blocked,1);
  for(const path of ['/document','/forbidden-fetch','/forbidden-xhr','/forbidden-cross','/forbidden-private']){
   const hop=attempts.find(a=>new URL(a.url).pathname===path);
   assert.equal(hop?.redirect_depth,1,path);
   assert.ok(hop.redirected_from.startsWith(origin+'/'),path);
  }
  assert.deepEqual(hits.map(h=>h.path).sort(),['/blocked-navigation','/data','/document','/redirect-cross','/redirect-fetch','/redirect-private','/redirect-xhr','/start']);
  assert.ok(hits.every(hit=>hit.connection==='close'));
  assert.equal(new Set(hits.map(hit=>hit.socket)).size,hits.length);
  assert.ok(connects.every(line=>line==='CONNECT '+publicAddress+':443 HTTP/1.1'));
  const main=artifacts.find(a=>a.main_document),dom=artifacts.find(a=>a.kind==='rendered_dom'),screenshot=artifacts.find(a=>a.kind==='browser_screenshot');
  assert.equal(main.headers['x-fixture'],'native');
  assert.equal(main.headers['content-security-policy'],"base-uri 'none'");
  assert.equal(main.status,200);
  assert.match(Buffer.from(dom.decoded_body_base64,'base64').toString(),/<p id="receipt">TLS rendered fixture<\/p>/);
  assert.equal(screenshot.headers['content-type'],'image/jpeg');
  assert.equal(screenshot.decoded_bytes,result.screenshot_bytes);
  assert.deepEqual([...Buffer.from(screenshot.decoded_body_base64,'base64').subarray(0,2)],[255,216]);
  const capped=await run('/start',{trustFixture:true,maxRequests:1});
  assert.equal(capped.result.physical_requests,1);
  assert.equal(capped.result.blocked_reasons.browser_request_limit,1);
  assert.equal(hits.at(-1).path,'/start');
  const reset=await run('/reset',{trustFixture:true});
  assert.equal(reset.result.physical_requests,1);
  assert.equal(reset.result.error,'browser_request_incomplete');
  assert.equal(hits.filter(hit=>hit.path==='/reset').length,1);
 }finally{
  for(const socket of sockets)socket.destroy();
  if(proxy)await close(proxy);
  if(source)await close(source);
  await rm(directory,{recursive:true,force:true});
 }
});
