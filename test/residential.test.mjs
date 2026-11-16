import {spawnSync} from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Store} from '../src/store.mjs';
import {Gateway} from '../src/gateway.mjs';
import {sha} from '../src/crypto.mjs';
import {providerProxy,residentialPolicy,routePlan,residentialStatus,reconcileResidential} from '../src/residential.mjs';
import {checkBrowserTier} from '../src/browser.mjs';
import {connectRelay} from '../src/connect-relay.mjs';
import http from 'node:http';
const base={hosts:['source.example'],methods:['GET'],headers:['cookie'],country:'US',maxConcurrent:1,maxRequests:12,maxInputBytes:1024,maxResponseBytes:1024,maxBytes:20000,ttlSeconds:120,minIntervalMs:0,maxFallbackCredits:0,maxAttemptBytes:1000,maxResidentialBytes:4000};
const provider={enabled:true,username:'private-user',password:'private-pass',maxTotalBytes:100000,microUsdPerGB:1000000};
const settings={defaultRouting:'residential-v1',browser:{defaultEngine:'cloakbrowser'},residential:{maxDailyBytes:100000,maxTotalBytes:100000,providers:{evomi:{...provider},dataimpulse:{...provider}}}};
test('new profile defaults, native/browser ladder and sticky country syntax',()=>{
 const p=residentialPolicy(base,settings);assert.equal(p.routingPolicy,'residential-v1');
 assert.deepEqual(routePlan(p).map(r=>r.provider),['evomi','dataimpulse']);
 assert.deepEqual(routePlan({...p,execution:'browser'}).map(r=>`${r.provider}/${r.tier}`),['evomi/free','dataimpulse/free','evomi/paid','dataimpulse/paid']);
 const e=new URL(providerProxy(settings,p,'evomi').url),d=new URL(providerProxy(settings,p,'dataimpulse').url);
 assert.match(decodeURIComponent(e.password),new RegExp(`_country-US_session-${p.residentialSession}_lifetime-30$`));
 assert.equal(decodeURIComponent(d.username),`private-user__cr.us;sessid.${p.residentialSession}`);
 assert.equal(providerProxy(settings,p,'evomi').url,e.href);
 assert.equal(residentialPolicy({...base,routingPolicy:'legacy'},settings).routingPolicy,'legacy');
 assert.throws(()=>residentialPolicy({...base,country:'xx'},settings));
 assert.equal(p.maxSessionRenewals,0);assert.equal(residentialPolicy({...base,maxSessionRenewals:3},settings).maxSessionRenewals,3);
 for(const bad of [-1,11,1.5,'2'])assert.throws(()=>residentialPolicy({...base,maxSessionRenewals:bad},settings),/residential_profile_invalid/);
});
test('paid tier rejects free trial, invalid, expired and unverifiable entitlement',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tier-test-')),path=join(dir,'binary');await writeFile(path,'not executed');
 const config={browser:{free:{executablePath:path,sha256:'a',version:'146',entitlement:'unlicensed'},paid:{executablePath:path,sha256:'b',version:'155',entitlement:'paid',licenseKey:'private'}}};
 try{
  await checkBrowserTier(config,'free',{fetchImpl:()=>{throw Error('should not call');}});
  for(const info of [{valid:true,plan:'free'},{valid:true,plan:'trial'},{valid:false,plan:'solo'},{valid:true,plan:'solo',expires:'2020-01-01'}])await assert.rejects(checkBrowserTier(config,'paid',{fetchImpl:async()=>({ok:true,json:async()=>info})}));
  await assert.rejects(checkBrowserTier(config,'paid',{fetchImpl:async()=>{throw Error();}}),/unverified/);
  assert.equal((await checkBrowserTier(config,'paid',{fetchImpl:async()=>({ok:true,json:async()=>({valid:true,plan:'solo',expires:'2099-01-01'})})})).version,'155');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('CONNECT relay rejects private/unknown destinations without upstream access',async()=>{
 const relay=await connectRelay({proxy:{url:'http://unused:secret@127.0.0.1:1'},profile:{hosts:['source.example']},maxBytes:1024,resolve:async()=>[{address:'127.0.0.1'}]});
 try{for(const host of ['source.example:443','evil.example:443','127.0.0.1:443','source.example:80']){
  const status=await new Promise((resolve,reject)=>{const q=http.request(relay.url,{method:'CONNECT',path:host});q.on('connect',(r,s)=>{s.destroy();resolve(r.statusCode);});q.on('error',reject);q.end();});assert.equal(status,403);
 }assert.equal(relay.bytes,0);assert.deepEqual(relay.traffic,{status:'no_traffic',bytes:0});}finally{await relay.close();}
});
test('durable residential default, bounded fallback, accounting and browser tier isolation',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 assert.match(new URL(process.env.TEST_DATABASE_URL).pathname,/^\/gateway_test_[A-Za-z0-9]+$/);
 const root=await mkdtemp(join(tmpdir(),'residential-test-')),store=new Store(process.env.TEST_DATABASE_URL);await store.init();await store.pool.query('TRUNCATE ledger,attempts,operations,workflows,source_limits RESTART IDENTITY CASCADE');
 const config={...structuredClone(settings),release:'test',artifactDir:root,artifactKey:'22'.repeat(32),maxDailyFallbackCredits:0,projects:{a:{profiles:['native','browser','renew'],tokenHash:sha('a')},b:{profiles:['native'],tokenHash:sha('b')}},proxies:[]};
 let mode='fallback',queue=[];const calls=[],tiers=[];
 const g=new Gateway({store,config,profiles:{native:base,browser:{...base,execution:'browser'},renew:{...base,maxSessionRenewals:1}},resolve:async()=>[{address:'93.184.216.34'}],browserTierCheck:async(c,t)=>{tiers.push(t);},transport:{residential:async(input,w,c,storageState)=>{
  calls.push({provider:w.route,tier:routePlan(w.config)[w.config.routeIndex].tier,session:w.config.residentialSession,state:storageState??null});
  if(queue.length)return {status:queue.shift(),error:null,headers:{},body:Buffer.from('body'),wireBytes:50,proxyTraffic:{status:'measured',bytes:100},storageState:{cookies:[{name:'session',value:w.config.residentialSession}],origins:[]}};
  if(mode==='secret')return {status:200,headers:{},body:Buffer.from(provider.password),wireBytes:50,proxyTraffic:{status:'measured',bytes:42}};
  if(mode==='unknown')throw Error('unclassified');
  if(mode==='unsent-primary'&&w.route==='evomi')return {status:null,error:'proxy_connect_failed',headers:{},body:Buffer.alloc(0),wireBytes:0,proxyTraffic:{status:'no_traffic',bytes:0}};
  const status=mode==='rate'||mode==='rate-primary'&&w.route==='evomi'?429:mode==='denied'?403:mode==='browser'?(w.config.routeIndex===3?200:403):['fallback','missing-primary'].includes(mode)&&w.route==='evomi'?403:200;
  return {status,error:mode==='browser'&&status===403?'browser_capture_failed':mode==='readiness'?'browser_capture_failed':null,headers:{},body:Buffer.from('body'),wireBytes:50,...(mode==='missing'||mode==='missing-primary'&&w.route==='evomi'?{}:{proxyTraffic:{status:'measured',bytes:mode==='overrun'?1500:w.route==='evomi'?150:350}})};
 }}});
 let n=0;const workflow=(profile='native')=>g.workflow('a',{profile,idempotency_key:'w'+(++n)}),input={idempotency_key:'one',url:'https://source.example/',main_document:true};
 try{
  const w=await workflow();assert.equal(w.route,'evomi');const result=await g.operation('a',w.id,input);assert.equal(result.provider,'dataimpulse');assert.equal(result.proxy_class,'residential');assert.equal(result.credits,null);assert.equal(result.wire_bytes,50);
  assert.deepEqual(result.customer_traffic,{currency:'USD',rate_usd_per_gb:2,bytes_per_gb:1000000000,basis:'bidirectional_proxy_bytes',status:'measured',metered_bytes:500,billable_bytes:500,cost_usd:'0.000001000'});
  assert.deepEqual(calls.map(x=>x.provider),['evomi','dataimpulse']);assert.notEqual(calls[0].session,calls[1].session);
  assert.deepEqual(await g.lookup('a',w.id,'one'),result);assert.deepEqual(await g.operation('a',w.id,input),result);assert.equal(calls.length,2);
  const usage=(await store.pool.query('SELECT * FROM residential_usage ORDER BY created_at')).rows;assert.equal(usage.length,2);assert.ok(usage.every(x=>Number(x.accounted_bytes)===1000&&Number(x.observed_bytes)===50&&x.invoice_micro_usd===null));assert.deepEqual(usage.map(x=>Number(x.observed_proxy_bytes)),[150,350]);
  mode='denied';await g.operation('a',w.id,{...input,idempotency_key:'two'});assert.equal(calls.length,3);assert.equal(calls.at(-1).provider,'dataimpulse');
  mode='readiness';const ready=await workflow('browser'),readyBefore=calls.length;await g.operation('a',ready.id,input);assert.equal(calls.length,readyBefore+1);
  // A first-GET 429 rotates Evomi -> DataImpulse; only the limited egress cools
  // down until the last route is also limited, which then cools the origin.
  await store.pool.query('TRUNCATE source_limits');
  mode='rate-primary';const ratePrimary=await workflow(),rpBefore=calls.length;const rp=await g.operation('a',ratePrimary.id,input);
  assert.deepEqual(calls.slice(rpBefore).map(x=>x.provider),['evomi','dataimpulse']);assert.equal(rp.provider,'dataimpulse');assert.equal(rp.status,200);assert.equal((await g.read('a',ratePrimary.id)).route,'dataimpulse');
  const cooled=async()=>(await store.pool.query("SELECT source FROM source_limits WHERE cooldown_until>now()+interval '30 seconds' ORDER BY source")).rows.map(x=>x.source);
  assert.deepEqual(await cooled(),[`egress:evomi:${calls[rpBefore].session}`]);
  mode='rate';const rate=await workflow(),rateBefore=calls.length;const limitedResult=await g.operation('a',rate.id,input);
  assert.deepEqual(calls.slice(rateBefore).map(x=>x.provider),['evomi','dataimpulse']);assert.equal(limitedResult.status,429);assert.equal((await g.read('a',rate.id)).route,'dataimpulse');
  assert.ok((await cooled()).includes('origin:source.example'));
  await assert.rejects(g.operation('a',(await workflow()).id,{...input,idempotency_key:'cooling'}),/source_cooldown/);
  await store.pool.query('TRUNCATE source_limits');
  // Generic session renewal (profile maxSessionRenewals): a later 429 restarts
  // the ladder in a fresh session without saved state; the default profile never renews.
  const plain=await workflow();queue=[200,429];await g.operation('a',plain.id,{...input,idempotency_key:'p1'});const plainBefore=calls.length;
  const plainLimited=await g.operation('a',plain.id,{...input,idempotency_key:'p2'});assert.equal(plainLimited.status,429);assert.equal(calls.length,plainBefore+1);assert.equal(calls.at(-1).session,calls.at(-2).session);
  await store.pool.query('TRUNCATE source_limits');
  const renew=await workflow('renew');queue=[200,429,200];const r1=await g.operation('a',renew.id,{...input,idempotency_key:'r1'});assert.equal(r1.status,200);
  const renewBefore=calls.length;const r2=await g.operation('a',renew.id,{...input,idempotency_key:'r2'});
  const [limitedCall,renewedCall]=calls.slice(renewBefore);assert.equal(calls.length,renewBefore+2);assert.equal(r2.status,200);assert.equal(r2.provider,'evomi');
  assert.ok(limitedCall.state?.cookies?.length);assert.equal(renewedCall.state,null);assert.notEqual(limitedCall.session,renewedCall.session);
  assert.deepEqual(await cooled(),[`egress:evomi:${limitedCall.session}`]);
  const renewedView=await g.read('a',renew.id);assert.equal(renewedView.session_renewals,1);assert.equal(renewedView.route,'evomi');
  assert.equal((await store.pool.query("SELECT count(*)::int n FROM attempts WHERE workflow=$1 AND routing_reason='session_renewal'",[renew.id])).rows[0].n,1);
  // The renewal budget is spent: the next 429 is returned and cools the origin.
  queue=[429];const r3=await g.operation('a',renew.id,{...input,idempotency_key:'r3'});assert.equal(r3.status,429);assert.ok((await cooled()).includes('origin:source.example'));
  await store.pool.query('TRUNCATE source_limits');
  // A renewed session's first GET still rotates Evomi -> DataImpulse on 429.
  const renew2=await workflow('renew');queue=[200,429,429,200];await g.operation('a',renew2.id,{...input,idempotency_key:'s1'});const r2Before=calls.length;
  const s2=await g.operation('a',renew2.id,{...input,idempotency_key:'s2'});assert.deepEqual(calls.slice(r2Before).map(x=>x.provider),['evomi','evomi','dataimpulse']);assert.equal(s2.status,200);assert.equal(s2.provider,'dataimpulse');
  queue=[];await store.pool.query('TRUNCATE source_limits');
  mode='browser';const browser=await workflow('browser'),before=calls.length;const rendered=await g.operation('a',browser.id,input);assert.equal(rendered.provider,'dataimpulse');assert.equal(rendered.browser_tier,'paid');assert.deepEqual(calls.slice(before).map(x=>`${x.provider}/${x.tier}`),['evomi/free','dataimpulse/free','evomi/paid','dataimpulse/paid']);
  assert.equal(rendered.customer_traffic.metered_bytes,1000);assert.equal(rendered.customer_traffic.cost_usd,'0.000002000');
  await assert.rejects(g.operation('a',browser.id,{...input,idempotency_key:'over'}),/residential_budget_exhausted/);
  assert.equal((await residentialStatus(store.pool,config,'b')).usage.length,0);
  const proof={attempt:usage[0].attempt,bytes:50,invoice_micro_usd:1,evidence:'sha256:'+'a'.repeat(64)};assert.deepEqual(await reconcileResidential(store,proof),{replayed:false});assert.deepEqual(await reconcileResidential(store,proof),{replayed:true});await assert.rejects(reconcileResidential(store,{...proof,bytes:51}),/reconciliation_conflict/);
  mode='success';const limited=await workflow();config.residential.maxDailyBytes=1;const count=calls.length;await assert.rejects(g.operation('a',limited.id,input),/residential_budget_exhausted/);assert.equal(calls.length,count);config.residential.maxDailyBytes=100000;
  mode='unknown';const uncertain=await workflow(),priorCalls=calls.length;const ur=await g.operation('a',uncertain.id,input);assert.equal(ur.error,'transport_outcome_unknown');assert.equal(calls.length,priorCalls+1);assert.equal((await store.pool.query('SELECT state FROM attempts WHERE operation=$1',[ur.id])).rows[0].state,'unknown');
  assert.equal(ur.customer_traffic.status,'unknown');assert.equal(ur.customer_traffic.cost_usd,null);
  mode='missing';const missing=await g.operation('a',(await workflow()).id,input);assert.equal(missing.customer_traffic.status,'unknown');assert.equal(missing.customer_traffic.cost_usd,null);
  mode='missing-primary';const missingPrimary=await g.operation('a',(await workflow()).id,input);assert.equal(missingPrimary.provider,'dataimpulse');assert.equal(missingPrimary.customer_traffic.status,'unknown');assert.equal(missingPrimary.customer_traffic.cost_usd,null);
  mode='unsent-primary';const unsentPrimary=await g.operation('a',(await workflow()).id,input);assert.equal(unsentPrimary.provider,'dataimpulse');assert.equal(unsentPrimary.customer_traffic.metered_bytes,350);assert.equal(unsentPrimary.customer_traffic.cost_usd,'0.000000700');
  mode='overrun';const overrun=await g.operation('a',(await workflow()).id,input);assert.equal(overrun.customer_traffic.metered_bytes,1500);assert.equal(overrun.customer_traffic.billable_bytes,1000);assert.equal(overrun.customer_traffic.cost_usd,'0.000002000');
  mode='secret';const secret=await workflow();const redacted=await g.operation('a',secret.id,input);assert.equal(redacted.error,'sensitive_provider_response');assert.equal(redacted.body_base64,'');
  assert.equal(redacted.customer_traffic.metered_bytes,42);
  // Sent work remains reserved through crash recovery; no redispatch.
  const attempt=(await store.pool.query('SELECT attempt FROM residential_usage LIMIT 1')).rows[0].attempt;await store.pool.query("UPDATE attempts SET state='sent' WHERE id=$1",[attempt]);await store.recover();assert.equal((await store.pool.query('SELECT state,accounted_bytes FROM residential_usage WHERE attempt=$1',[attempt])).rows[0].state,'unknown');
 }finally{await store.close();await rm(root,{recursive:true,force:true});}
});
test('CONNECT relay meters both directions and terminates at hard byte bound',async()=>{
 let proxyAuth;
 const upstream=http.createServer();upstream.on('connect',(req,socket)=>{proxyAuth=req.headers['proxy-authorization'];socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');socket.on('data',()=>socket.write(Buffer.alloc(4096,'x')));socket.on('error',()=>{});socket.on('end',()=>socket.destroy());});
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 const relay=await connectRelay({proxy:{url:`http://user:secret@127.0.0.1:${upstream.address().port}`},profile:{hosts:['source.example']},maxBytes:1024,resolve:async()=>[{address:'93.184.216.34'}]});
 try{
  await new Promise((resolve,reject)=>{const req=http.request(relay.url,{method:'CONNECT',path:'source.example:443'});req.on('connect',(response,socket)=>{assert.equal(response.statusCode,200);socket.on('error',()=>{});socket.on('close',resolve);socket.write('test');});req.on('error',reject);req.end();});
  assert.equal(proxyAuth,'Basic '+Buffer.from('user:secret').toString('base64'));assert.equal(relay.error,'residential_byte_limit');assert.ok(relay.bytes<=1024&&relay.bytes>=512);
 }finally{await relay.close();await new Promise(r=>upstream.close(r));}
});

test('browser child executes its IPC protocol and rejects a mismatched build before network',()=>{
 const r=spawnSync(process.execPath,[fileURLToPath(new URL('../src/browser-worker.mjs',import.meta.url))],{input:JSON.stringify({browser:{executablePath:fileURLToPath(new URL('../package.json',import.meta.url)),sha256:'bad'}}),encoding:'utf8',timeout:10000});
 assert.equal(r.status,0,r.stderr);const result=JSON.parse(r.stdout);assert.equal(result.error,'browser_build_mismatch');assert.equal(result.body_base64,'');
});
