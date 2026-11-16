import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir,readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {residentialPolicy,routePlan,residentialStatus} from '../src/residential.mjs';
import {checkBrowserTier} from '../src/browser.mjs';
import {browserEngine,browserRedirectBlocked,CAMOUFOX_PIN,fileSha256,camoufoxLaunchOptions,verifyCamoufoxBuild,launchPinnedBrowser,installBrowserRestrictions} from '../src/browser-engines.mjs';
import {prepareCamoufoxContext,setCookieLine,cookieHost,CAMOUFOX_STATE_PATH} from '../src/camoufox-cookies.mjs';
import {runRecipe,extractRecipe} from '../src/browser-recipes.mjs';
const base={hosts:['fixture.example'],methods:['GET','POST'],headers:[],country:'US',execution:'browser',maxBytes:1024*1024,ttlSeconds:120};
const settings={defaultRouting:'residential-v1',browser:{defaultEngine:'camoufox'}};
const identity={browserEngine:'camoufox',locale:'en-US',timezone:'America/New_York',browserActionDelayMs:0};

test('new workflows and generated deployments select Camoufox; explicit configuration and persisted workflows retain Cloak',async()=>{
 assert.equal(residentialPolicy(base,settings).browserEngine,'camoufox');
 assert.equal(residentialPolicy(base,{defaultRouting:'residential-v1'}).browserEngine,'camoufox');
 assert.equal(residentialPolicy(base,{defaultRouting:'residential-v1',browser:{defaultEngine:'cloakbrowser'}}).browserEngine,'cloakbrowser');
 assert.equal(residentialPolicy({...base,browserEngine:'cloakbrowser'},settings).browserEngine,'cloakbrowser');
 assert.equal(browserEngine({execution:'browser'}),'cloakbrowser');
 assert.equal(residentialPolicy({...base,execution:'http'},settings).browserEngine,undefined);
 assert.throws(()=>residentialPolicy(base,{...settings,browser:{defaultEngine:'unknown'}}),/browser_engine_unavailable/);
 const root=await mkdtemp(join(tmpdir(),'fetchx camoufox config '));
 try{
  const target=join(root,'new'),result=spawnSync(process.execPath,['scripts/init-config.mjs',target],{encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH,HOME:root}});
  assert.equal(result.status,0,result.stderr);
  const config=JSON.parse(await readFile(join(target,'secrets/gateway.json'),'utf8'));
  assert.equal(config.browser.defaultEngine,'camoufox');assert.equal(config.browser.camoufox.free.version,CAMOUFOX_PIN.version);assert.equal(config.browser.camoufox.free.qualified,false);
  assert.equal(config.sourceProfiles['example.browser'].locale,'en-US');assert.equal(config.sourceProfiles['example.browser'].timezone,'UTC');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('Camoufox routing/status exposes only supported free routes and distinguishes configured from qualified',async()=>{
 assert.deepEqual(routePlan({...base,browserEngine:'camoufox'}),[{provider:'evomi',tier:'free'},{provider:'dataimpulse',tier:'free'}]);
 assert.equal(routePlan(base).length,4);assert.equal(routePlan({...base,browserEngine:'cloakbrowser'}).length,4);
 const pool={query:async()=>({rows:[]})},config={...settings,browser:{defaultEngine:'camoufox',camoufox:{free:{executablePath:'/synthetic/camoufox-bin',version:CAMOUFOX_PIN.version,qualified:false}}}};
 const status=await residentialStatus(pool,config,'synthetic');assert.equal(status.browser_engine,'camoufox');assert.equal(status.browser_order.length,2);assert.equal(status.browser_tiers.free.configured,true);assert.equal(status.browser_tiers.free.qualified,false);assert.equal(status.browser_tiers.paid.supported,false);assert.equal(status.browser_tiers.paid.configured,false);
 assert.equal(status.browser_tiers.free.qualification_error,'browser_not_qualified');assert.equal(status.browser_tiers.paid.qualification_error,'browser_tier_unsupported');
 config.browser.camoufox.free.qualified=true;assert.equal((await residentialStatus(pool,config,'synthetic')).browser_tiers.free.qualified,true);assert.equal((await residentialStatus(pool,config,'synthetic')).browser_tiers.free.qualification_error,null);
 const legacy=await residentialStatus(pool,{browser:{defaultEngine:'cloakbrowser',free:{executablePath:'/synthetic/cloak',version:'146',entitlement:'unlicensed'}}},'synthetic');assert.equal(legacy.browser_order.length,4);assert.equal(legacy.browser_tiers.free.configured,true);assert.equal(legacy.browser_tiers.free.qualified,null);
});

test('Camoufox rejects unqualified, missing, mismatched and unpinned builds/models before launch; no paid tier or license call',async()=>{
 const root=await mkdtemp(join(tmpdir(),'fetchx-camoufox-pin-'));
 try{
  const executablePath=join(root,'camoufox-bin'),modelDir=join(root,'model');await writeFile(executablePath,'synthetic not executable');await mkdir(modelDir);
  const tier={executablePath,modelDir,sha256:await fileSha256(executablePath),version:CAMOUFOX_PIN.version,qualified:true};
  await writeFile(join(root,'version.json'),JSON.stringify({version:'158.0.1',release:'beta.41'}));
  await assert.rejects(checkBrowserTier({browser:{camoufox:{free:tier}}},'free',{engine:'camoufox'}),/browser_model_unavailable/);await assert.rejects(launchPinnedBrowser(tier,identity,'http://127.0.0.1:1234',root),/browser_model_unavailable/);
  await assert.rejects(checkBrowserTier({browser:{camoufox:{free:{...tier,qualified:false}}}},'free',{engine:'camoufox'}),/browser_not_qualified/);await assert.rejects(checkBrowserTier({browser:{}},'free',{engine:'camoufox'}),/browser_tier_unavailable/);
  await assert.rejects(verifyCamoufoxBuild({...tier,qualified:false}),/browser_not_qualified/);
  await assert.rejects(verifyCamoufoxBuild({...tier,executablePath:join(root,'missing')}),/browser_tier_unavailable/);
  await assert.rejects(verifyCamoufoxBuild({...tier,sha256:'0'.repeat(64)}),/browser_build_mismatch/);
  await assert.rejects(verifyCamoufoxBuild({...tier,version:'latest'}),/browser_version_mismatch/);
  await writeFile(join(root,'version.json'),JSON.stringify({version:'156.0.1',release:'beta.36'}));
  await assert.rejects(verifyCamoufoxBuild(tier),/browser_version_mismatch/);
  await writeFile(join(root,'version.json'),JSON.stringify({version:'158.0.1',release:'beta.41'}));
  await assert.rejects(verifyCamoufoxBuild(tier),/browser_model_unavailable/);
  let calls=0;await assert.rejects(checkBrowserTier({browser:{camoufox:{free:tier}}},'paid',{engine:'camoufox',fetchImpl:()=>{calls++;throw Error();}}),/browser_tier_unsupported/);assert.equal(calls,0);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('Camoufox options require the local relay and reviewed identity, force private browsing, block direct failover/GeoIP/WebRTC, and bound pacing',()=>{
 const tier={executablePath:'/synthetic/camoufox-bin',modelDir:'/synthetic/model'},options=camoufoxLaunchOptions(tier,identity,'http://127.0.0.1:12345','/synthetic/cache');
 assert.equal(options.executable_path,tier.executablePath);assert.equal(options.geoip,false);assert.equal(options.block_webrtc,true);assert.equal(options.canvas_noise,true);
 assert.equal(options.locale,'en-US');assert.equal(options.config.timezone,'America/New_York');assert.equal(options.slowMo,0);
 assert.equal(options.firefox_user_prefs['network.http.redirection-limit'],0);assert.equal(options.firefox_user_prefs['network.proxy.failover_direct'],false);assert.equal(options.firefox_user_prefs['dom.serviceWorkers.enabled'],true);assert.equal(options.firefox_user_prefs['browser.privatebrowsing.autostart'],true);assert.equal(options.firefox_user_prefs['dom.serviceWorkers.privateBrowsing.enabled'],false);assert.equal(options.firefox_user_prefs['toolkit.telemetry.enabled'],false);
 for(const relay of ['',undefined,'http://proxy.example:1234','socks5://127.0.0.1:1234','http://user:secret@127.0.0.1:1234'])assert.throws(()=>camoufoxLaunchOptions(tier,identity,relay,'/synthetic/cache'),/browser_proxy_required/);
 assert.throws(()=>camoufoxLaunchOptions(tier,{browserEngine:'camoufox'},'http://127.0.0.1:1234','/cache'),/browser_identity_unconfigured/);
 assert.throws(()=>camoufoxLaunchOptions(tier,{...identity,timezone:'invalid'},'http://127.0.0.1:1234','/cache'),/browser_identity_invalid/);
 assert.throws(()=>camoufoxLaunchOptions(tier,{...identity,browserActionDelayMs:1001},'http://127.0.0.1:1234','/cache'),/browser_pacing_invalid/);
});

test('shared browser admission blocks hosts, private DNS, paths, methods, bodies and resources; strips source headers on other origins',async()=>{
 let handler,ws;const counts=await installBrowserRestrictions({routeWebSocket:async(_,fn)=>{ws=fn;},route:async(_,fn)=>{handler=fn;}},{url:'https://fixture.example/',headers:{authorization:'Bearer synthetic-source'},profile:{...base,hosts:['fixture.example','dependency.example','private.example'],paths:['^/(?:allowed)?$'],maxInputBytes:4,maxBrowserRequests:20,headers:['authorization'],guestAuth:[{host:'fixture.example',method:'GET',path:'^/$'}]}},{resolve:async host=>[{address:host==='private.example'?'127.0.0.1':'93.184.216.34'}]});
 let closed=false;ws({close:()=>{closed=true;}});assert.equal(closed,true);assert.equal(counts.webSockets,1);
 async function request(url,{method='GET',body='',type='fetch'}={}){let result;await handler({request:()=>({url:()=>url,method:()=>method,postDataBuffer:()=>Buffer.from(body),resourceType:()=>type,headers:()=>({authorization:'Bearer synthetic-source','x-gateway-token':'not-forwarded'})}),abort:async()=>{result='blocked';},fallback:async options=>{result=options;}});return result;}
 for(const [url,opts]of [['https://unknown.example/',{}],['https://private.example/',{}],['https://fixture.example/other',{}],['https://fixture.example/',{method:'DELETE'}],['https://fixture.example/',{method:'POST',body:'12345'}],['https://fixture.example/',{type:'image'}]])assert.equal(await request(url,opts),'blocked');
 const allowed=await request('https://dependency.example/allowed');assert.equal(allowed.headers.authorization,undefined);
 assert.equal(counts.blocked,6);assert.equal(counts.requests,7);
});

test('Camoufox cookie replay lines keep attributes, skip expired/unsafe cookies, and stay on reviewed hosts',()=>{
 const hosts=['fixture.example','www.shop.example'];
 assert.equal(cookieHost({name:'a',domain:'fixture.example'},hosts),'fixture.example');
 assert.equal(cookieHost({name:'a',domain:'.shop.example'},hosts),'www.shop.example');
 assert.equal(cookieHost({name:'a',domain:'unreviewed.example'},hosts),null);
 assert.equal(cookieHost({name:'a',domain:'.example'},['fixture.example']),'fixture.example');
 const future=Math.floor(Date.now()/1000)+3600;
 assert.equal(setCookieLine({name:'s',value:'v',domain:'.shop.example',path:'/a',expires:future,secure:true,httpOnly:true,sameSite:'None'}),`s=v; Path=/a; Domain=shop.example; Expires=${new Date(future*1000).toUTCString()}; Secure; HttpOnly; SameSite=None`);
 assert.equal(setCookieLine({name:'s',value:'v',domain:'fixture.example',path:'/',expires:-1,secure:false,httpOnly:false,sameSite:'None'}),'s=v; Path=/');
 assert.equal(setCookieLine({name:'s',value:'v',domain:'fixture.example',expires:1}),null);
 assert.equal(setCookieLine({name:'s',value:'v; Domain=evil.example',domain:'fixture.example'}),null);
 assert.equal(setCookieLine({name:'s',value:'v\nx',domain:'fixture.example'}),null);
});

const executable=process.env.CAMOUFOX_TEST_EXECUTABLE,model=process.env.CAMOUFOX_TEST_MODEL;
test('actual Camoufox runs recipes and routing in native private browsing, with FetchX cookie and localStorage continuity',{skip:!executable||!model,timeout:90000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'fetchx-camoufox-real-')),traffic=[],sockets=new Set();
 // Firefox establishes TLS through CONNECT before route fulfillment. Trust this
 // generated certificate only in the synthetic context; production TLS is unchanged.
 const cert=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(root,'key.pem'),'-out',join(root,'cert.pem'),'-days','1','-subj','/CN=fixture.example'],{encoding:'utf8',timeout:10000});assert.equal(cert.status,0,cert.stderr);
 const nativeRequests=[];const fixture=https.createServer({key:await readFile(join(root,'key.pem')),cert:await readFile(join(root,'cert.pem'))},(req,res)=>{nativeRequests.push({url:req.url,cookie:req.headers.cookie??null});if(req.url==='/native-cookie'){res.writeHead(200,{'content-type':'text/plain','set-cookie':['http_session=native-synthetic; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600','http_cleared=gone; Path=/; Secure']});res.end('synthetic cookie set');}else if(req.url==='/native-check'){res.writeHead(200,{'content-type':'text/plain'});res.end('checked');}else if(req.url==='/redirect/same'||req.url==='/redirect/cross'){res.writeHead(302,{location:req.url.endsWith('/same')?'https://fixture.example/disallowed-target':'https://unreviewed.example/disallowed-target'});res.end('synthetic redirect');}else{res.writeHead(500);res.end('unapproved HTTP target must never be reached');}});
 const track=socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});};fixture.on('connection',track);await new Promise(r=>fixture.listen(0,'127.0.0.1',r));
 const relay=http.createServer((req,res)=>{traffic.push({target:req.url,admitted:false,ordinary:true});res.writeHead(403);res.end();});
 relay.on('connect',(req,socket,head)=>{track(socket);const admitted=['fixture.example:443','dependency.example:443'].includes(req.url)&&!head.length&&traffic.length<20;traffic.push({target:req.url,admitted});if(!admitted){socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}const remote=net.connect({host:'127.0.0.1',port:fixture.address().port});track(remote);remote.once('connect',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');socket.pipe(remote);remote.pipe(socket);});socket.on('close',()=>remote.destroy());remote.on('close',()=>socket.destroy());});await new Promise(r=>relay.listen(0,'127.0.0.1',r));
 let browser;
 try{
  const tier={executablePath:executable,modelDir:model,sha256:process.env.CAMOUFOX_TEST_SHA256??await fileSha256(executable),version:CAMOUFOX_PIN.version,qualified:true};
  await assert.rejects(launchPinnedBrowser({...tier,qualified:false},identity,`http://127.0.0.1:${relay.address().port}`,root),/browser_not_qualified/);
  browser=await launchPinnedBrowser(tier,identity,`http://127.0.0.1:${relay.address().port}`,root);
  const profile={...base,...identity,methods:['GET','POST','OPTIONS'],hosts:['fixture.example','dependency.example','private.example'],paths:['^/(?:allowed|native-cookie|native-check|redirect/(?:same|cross))?$'],headers:['authorization'],guestAuth:[{host:'fixture.example',method:'GET',path:'^/(?:native-cookie)?$'}],maxInputBytes:1024,maxBrowserRequests:40};
  const native=new Set(['/native-cookie','/native-check']);
  const context=await browser.newContext({serviceWorkers:'block',acceptDownloads:false,ignoreHTTPSErrors:true,locale:identity.locale,timezoneId:identity.timezone});
  const observed=[];
  await context.route('**/*',async route=>{if(native.has(new URL(route.request().url()).pathname))return route.continue();observed.push({url:route.request().url(),method:route.request().method(),headers:route.request().headers()});await route.fulfill({status:200,headers:{'content-type':'text/html','set-cookie':'source_session=synthetic; Path=/; Secure; SameSite=Lax','access-control-allow-origin':'https://fixture.example','access-control-allow-headers':'authorization','access-control-allow-methods':'GET,POST,OPTIONS'},body:`<input id="query"><select id="kind"><option value="a">A</option><option value="b">B</option></select><button id="search" onclick="setTimeout(()=>document.querySelector('#result').textContent=document.querySelector('#query').value+document.querySelector('#kind').value,25)">Search</button><div id="result" hidden></div><script>document.querySelector('#search').addEventListener('click',()=>document.querySelector('#result').hidden=false)</script>`});});
  const counts=await installBrowserRestrictions(context,{url:'https://fixture.example/',headers:{authorization:'Bearer synthetic-source'},profile},{resolve:async host=>[{address:host==='private.example'?'127.0.0.1':'93.184.216.34'}]});
  const jar=await prepareCamoufoxContext(context,{url:'https://fixture.example/',cookies:[],profile});
  assert.equal(counts.requests,0,'engine-state checks are local and do not consume source request budget');
  const page=await context.newPage();page.setDefaultTimeout(5000);const navigation=await page.goto('https://fixture.example/');
  assert.equal(await page.locator('#query').count(),1,JSON.stringify({status:navigation.status(),observed,traffic,nativeRequests,counts,html:(await page.content()).slice(0,2048)}));
  const recipe={steps:[{action:'fill',selector:'#query',valueFrom:'query'},{action:'select',selector:'#kind',value:'b'},{action:'click',selector:'#search'},{action:'wait',selector:'#result'}],extract:{result:{selector:'#result'}},screenshot:'viewport'},progress={};
  await runRecipe(page,recipe,{query:'FetchX'},progress);await page.locator('#result').filter({hasText:'FetchXb'}).waitFor();
  assert.equal(progress.completed,4);assert.deepEqual(await extractRecipe(page,recipe),{result:'FetchXb'});
  assert.equal((await page.screenshot()).subarray(1,4).toString(),'PNG');
  // Native exclusion: private browsing removes the API, not a JavaScript no-op.
  assert.deepEqual(await page.evaluate(()=>({locale:navigator.language,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,webrtc:typeof RTCPeerConnection,serviceWorker:'serviceWorker' in navigator,secure:isSecureContext})),{locale:identity.locale,timezone:identity.timezone,webrtc:'undefined',serviceWorker:false,secure:true});
  for(const [url,options]of [['https://unreviewed.example/',{}],['https://private.example/',{}],['https://fixture.example/native-cookie',{method:'DELETE'}],['https://fixture.example/native-cookie',{method:'POST',body:'x'.repeat(1025)}]])assert.equal(await page.evaluate(async({url,options})=>fetch(url,options).then(()=>false,()=>true),{url,options}),true);
  await page.evaluate(()=>fetch('https://dependency.example/allowed',{headers:{authorization:'Bearer synthetic-source'}}).catch(()=>{}));
  assert.equal(observed.find(x=>x.url==='https://dependency.example/allowed'&&x.method==='GET').headers.authorization,undefined);
  const socketState=await page.evaluate(()=>new Promise(resolve=>{const ws=new WebSocket('wss://fixture.example/socket'),timer=setTimeout(()=>resolve({event:'none',readyState:ws.readyState}),250);ws.onclose=()=>{clearTimeout(timer);resolve({event:'close',readyState:ws.readyState});};ws.onerror=()=>{clearTimeout(timer);resolve({event:'error',readyState:ws.readyState});};}));assert.equal(counts.webSockets,1);
  await page.evaluate(async()=>{document.cookie='script_session=script-synthetic; Path=/; Secure';localStorage.setItem('workflow_context','synthetic-state');await fetch('/native-cookie').then(r=>r.text());document.cookie='http_cleared=; Path=/; Secure; Max-Age=0';});
  await jar.capture(page);const saved={...await context.storageState(),cookies:jar.cookies()};jar.stop();await context.close();
  const byName=Object.fromEntries(saved.cookies.map(c=>[c.name,c]));
  assert.equal(byName.source_session?.value,'synthetic',JSON.stringify(saved.cookies));assert.equal(byName.http_session.value,'native-synthetic');assert.equal(byName.http_session.httpOnly,true);assert.equal(byName.http_session.secure,true);assert.ok(byName.http_session.expires>Date.now()/1000);
  assert.equal(byName.script_session.value,'script-synthetic');assert.equal(byName.http_cleared,undefined,'script deletions are reconciled');
  assert.equal(saved.origins.find(o=>o.origin==='https://fixture.example').localStorage.find(v=>v.name==='workflow_context').value,'synthetic-state');
  // Restore into a fresh private context exactly as the worker does.
  const restored=await browser.newContext({storageState:{cookies:[],origins:saved.origins},serviceWorkers:'block',acceptDownloads:false,ignoreHTTPSErrors:true,locale:identity.locale,timezoneId:identity.timezone});
  await restored.route('**/*',route=>native.has(new URL(route.request().url()).pathname)?route.continue():route.fulfill({status:200,contentType:'text/html',body:'<div>restored synthetic context</div>'}));
  await installBrowserRestrictions(restored,{url:'https://fixture.example/',headers:{},profile},{resolve:async()=>[{address:'93.184.216.34'}]});
  const restoredJar=await prepareCamoufoxContext(restored,{url:'https://fixture.example/',cookies:[...saved.cookies,{name:'foreign',value:'x',domain:'unreviewed.example',path:'/',expires:-1}],profile});
  const restoredPage=await restored.newPage();await restoredPage.goto('https://fixture.example/');
  assert.equal(await restoredPage.evaluate(()=>localStorage.getItem('workflow_context')),'synthetic-state');
  assert.deepEqual((await restoredPage.evaluate(()=>document.cookie)).split('; ').sort(),['script_session=script-synthetic','source_session=synthetic']);
  await restoredPage.evaluate(()=>fetch('/native-check').then(r=>r.text()));
  const check=nativeRequests.find(r=>r.url==='/native-check');assert.deepEqual(check.cookie.split('; ').sort(),['http_session=native-synthetic','script_session=script-synthetic','source_session=synthetic']);
  assert.deepEqual(restoredJar.cookies().map(c=>`${c.domain}:${c.name}`).sort(),['dependency.example:source_session','fixture.example:http_session','fixture.example:script_session','fixture.example:source_session'],'the foreign-domain cookie is never replayed');restoredJar.stop();await restored.close();
  const redirects=await browser.newContext({serviceWorkers:'block',acceptDownloads:false,ignoreHTTPSErrors:true,locale:identity.locale,timezoneId:identity.timezone});await installBrowserRestrictions(redirects,{url:'https://fixture.example/',headers:{},profile},{resolve:async()=>[{address:'93.184.216.34'}]});const redirectPage=await redirects.newPage();for(const path of ['/redirect/same','/redirect/cross'])await assert.rejects(redirectPage.goto('https://fixture.example'+path,{timeout:5000}),error=>browserRedirectBlocked(error,identity));await redirects.close();
  assert.ok(counts.blocked>=2);assert.deepEqual(nativeRequests.map(r=>r.url),['/native-cookie','/native-check','/redirect/same','/redirect/cross']);assert.ok(traffic.every(t=>t.admitted&&t.target==='fixture.example:443'),JSON.stringify(traffic));
  assert.ok(!nativeRequests.some(r=>r.url===CAMOUFOX_STATE_PATH),'state replay never reaches the source');
  console.info('synthetic_camoufox_observations',JSON.stringify({privateBrowsing:true,serviceWorkerApi:false,browserVersion:browser.version(),requests:counts.requests,blocked:counts.blocked,webSockets:counts.webSockets,socketState,relayRequests:traffic.length,redirectTargetsReached:false,cookiesSaved:saved.cookies.length,cookieRestored:true,localStorageRestored:true}));
 }finally{await browser?.close();for(const socket of sockets)socket.destroy();await new Promise(r=>relay.close(r));await new Promise(r=>fixture.close(r));await rm(root,{recursive:true,force:true});}
});

test('actual service workers bypass Juggler routing in normal mode and are absent in the production private launcher',{skip:!executable||!model,timeout:60000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'camoufox-native-control-')),unexpected=[],hits=[];
 let port;const fixture=http.createServer((req,res)=>{let url;try{url=new URL(req.url,`http://127.0.0.1:${port}`);}catch{res.writeHead(403);res.end();return;}if(url.hostname!=='127.0.0.1'||Number(url.port)!==port){unexpected.push(req.url);res.writeHead(403);res.end();return;}hits.push(url.pathname);res.writeHead(200,{'content-type':url.pathname==='/sw.js'?'application/javascript':'text/html'});res.end(url.pathname==='/sw.js'?`self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',event=>event.waitUntil(self.clients.claim().then(()=>fetch('/from-worker'))));`:'<div>native service-worker positive control</div>');});fixture.on('connect',(req,socket)=>{unexpected.push(req.url);socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');});await new Promise(r=>fixture.listen(0,'127.0.0.1',r));port=fixture.address().port;
 try{
  const tier={executablePath:executable,modelDir:model,sha256:process.env.CAMOUFOX_TEST_SHA256??await fileSha256(executable),version:CAMOUFOX_PIN.version,qualified:true};
  for(const variant of ['normal_mode_positive_control','production_private_launcher']){
   let browser;try{
    if(variant==='production_private_launcher')browser=await launchPinnedBrowser(tier,identity,`http://127.0.0.1:${port}`,root);
    else{await launchPinnedBrowser(tier,identity,`http://127.0.0.1:${port}`,root).then(b=>b.close());const {Camoufox}=await import('camoufox');const options=camoufoxLaunchOptions(tier,identity,`http://127.0.0.1:${port}`,root);options.firefox_user_prefs['browser.privatebrowsing.autostart']=false;options.firefox_user_prefs['dom.serviceWorkers.testing.enabled']=false;browser=await Camoufox(options);}
    const context=await browser.newContext({serviceWorkers:'allow'}),routed=[];await context.route('**/*',route=>{routed.push(new URL(route.request().url()).pathname);return route.fallback();});
    const page=await context.newPage();await page.goto(`http://127.0.0.1:${port}/`,{timeout:5000});
    const result=await page.evaluate(()=>Promise.race([(async()=>{if(!('serviceWorker' in navigator))return{api:false};const registration=await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;await new Promise(r=>setTimeout(r,300));return{api:true,active:!!registration.active};})(),new Promise(resolve=>setTimeout(()=>resolve({error:'native_registration_timeout'}),5000))]));
    if(variant==='normal_mode_positive_control'){assert.deepEqual(result,{api:true,active:true});assert.ok(hits.includes('/sw.js')&&hits.includes('/from-worker'));assert.ok(!routed.includes('/sw.js')&&!routed.includes('/from-worker'),'worker traffic is invisible to routing, so it must be natively absent');}
    else assert.deepEqual(result,{api:false});
    console.info('synthetic_native_service_worker_control',JSON.stringify({variant,...result,routed}));
   }finally{await browser?.close();}
  }
  assert.equal(hits.filter(path=>path==='/sw.js').length,1);assert.deepEqual(unexpected,[]);
 }finally{fixture.closeAllConnections();await new Promise(r=>fixture.close(r));await rm(root,{recursive:true,force:true});}
});
