import {spawnSync} from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {Gateway} from '../src/gateway.mjs';
import {sha} from '../src/crypto.mjs';
import {providerProxy,residentialPolicy,routePlan,residentialStatus,reconcileResidential} from '../src/residential.mjs';
import {checkBrowserTier} from '../src/browser.mjs';
import {connectRelay} from '../src/connect-relay.mjs';
import http from 'node:http';
const base={hosts:['source.example'],methods:['GET'],headers:['cookie'],country:'US',maxConcurrent:1,maxRequests:12,maxInputBytes:1024,maxResponseBytes:1024,maxBytes:20000,ttlSeconds:120,minIntervalMs:0,maxFallbackCredits:0,maxAttemptBytes:1000,maxResidentialBytes:4000};
const provider={enabled:true,username:'private-user',password:'private-pass',maxTotalBytes:100000,microUsdPerGB:1000000};
const settings={defaultRouting:'residential-v1',residential:{maxDailyBytes:100000,maxTotalBytes:100000,providers:{evomi:{...provider},dataimpulse:{...provider}}}};
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
 }assert.equal(relay.bytes,0);}finally{await relay.close();}
});
test('durable residential default, bounded fallback, accounting and browser tier isolation',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 assert.match(new URL(process.env.TEST_DATABASE_URL).pathname,/^\/gateway_test_[A-Za-z0-9]+$/);
 const root=await mkdtemp(join(tmpdir(),'residential-test-')),store=new Store(process.env.TEST_DATABASE_URL);await store.init();await store.pool.query('TRUNCATE ledger,attempts,operations,workflows,source_limits RESTART IDENTITY CASCADE');
 const config={...structuredClone(settings),release:'test',artifactDir:root,artifactKey:'22'.repeat(32),maxDailyFallbackCredits:0,projects:{a:{profiles:['native','browser'],tokenHash:sha('a')},b:{profiles:['native'],tokenHash:sha('b')}},proxies:[]};
 let mode='fallback';const calls=[],tiers=[];
 const g=new Gateway({store,config,profiles:{native:base,browser:{...base,execution:'browser'}},resolve:async()=>[{address:'93.184.216.34'}],browserTierCheck:async(c,t)=>{tiers.push(t);},transport:{residential:async(input,w)=>{
  calls.push({provider:w.route,tier:routePlan(w.config)[w.config.routeIndex].tier,session:w.config.residentialSession});
  if(mode==='secret')return {status:200,headers:{},body:Buffer.from(provider.password),wireBytes:50};
  if(mode==='unknown')throw Error('unclassified');
  const status=mode==='rate'?429:mode==='denied'?403:mode==='browser'?(w.config.routeIndex===3?200:403):mode==='fallback'&&w.route==='evomi'?403:200;
  return {status,error:mode==='browser'&&status===403?'browser_capture_failed':mode==='readiness'?'browser_capture_failed':null,headers:{},body:Buffer.from('body'),wireBytes:50};
 }}});
 let n=0;const workflow=(profile='native')=>g.workflow('a',{profile,idempotency_key:'w'+(++n)}),input={idempotency_key:'one',url:'https://source.example/',main_document:true};
 try{
  const w=await workflow();assert.equal(w.route,'evomi');const result=await g.operation('a',w.id,input);assert.equal(result.provider,'dataimpulse');assert.equal(result.proxy_class,'residential');assert.equal(result.credits,null);assert.equal(result.wire_bytes,50);
  assert.deepEqual(calls.map(x=>x.provider),['evomi','dataimpulse']);assert.notEqual(calls[0].session,calls[1].session);
  assert.deepEqual(await g.lookup('a',w.id,'one'),result);assert.deepEqual(await g.operation('a',w.id,input),result);assert.equal(calls.length,2);
  const usage=(await store.pool.query('SELECT * FROM residential_usage ORDER BY created_at')).rows;assert.equal(usage.length,2);assert.ok(usage.every(x=>Number(x.accounted_bytes)===1000&&Number(x.observed_bytes)===50&&x.invoice_micro_usd===null));
  mode='denied';await g.operation('a',w.id,{...input,idempotency_key:'two'});assert.equal(calls.length,3);assert.equal(calls.at(-1).provider,'dataimpulse');
  mode='readiness';const ready=await workflow('browser'),readyBefore=calls.length;await g.operation('a',ready.id,input);assert.equal(calls.length,readyBefore+1);
  mode='rate';const rate=await workflow();await g.operation('a',rate.id,input);assert.equal(calls.at(-1).provider,'evomi');assert.equal((await g.read('a',rate.id)).route,'evomi');await store.pool.query('TRUNCATE source_limits');
  mode='browser';const browser=await workflow('browser'),before=calls.length;const rendered=await g.operation('a',browser.id,input);assert.equal(rendered.provider,'dataimpulse');assert.equal(rendered.browser_tier,'paid');assert.deepEqual(calls.slice(before).map(x=>`${x.provider}/${x.tier}`),['evomi/free','dataimpulse/free','evomi/paid','dataimpulse/paid']);
  await assert.rejects(g.operation('a',browser.id,{...input,idempotency_key:'over'}),/residential_budget_exhausted/);
  assert.equal((await residentialStatus(store.pool,config,'b')).usage.length,0);
  const proof={attempt:usage[0].attempt,bytes:50,invoice_micro_usd:1,evidence:'sha256:'+'a'.repeat(64)};assert.deepEqual(await reconcileResidential(store,proof),{replayed:false});assert.deepEqual(await reconcileResidential(store,proof),{replayed:true});await assert.rejects(reconcileResidential(store,{...proof,bytes:51}),/reconciliation_conflict/);
  mode='success';const limited=await workflow();config.residential.maxDailyBytes=1;const count=calls.length;await assert.rejects(g.operation('a',limited.id,input),/residential_budget_exhausted/);assert.equal(calls.length,count);config.residential.maxDailyBytes=100000;
  mode='unknown';const uncertain=await workflow(),priorCalls=calls.length;const ur=await g.operation('a',uncertain.id,input);assert.equal(ur.error,'transport_outcome_unknown');assert.equal(calls.length,priorCalls+1);assert.equal((await store.pool.query('SELECT state FROM attempts WHERE operation=$1',[ur.id])).rows[0].state,'unknown');
  mode='secret';const secret=await workflow();const redacted=await g.operation('a',secret.id,input);assert.equal(redacted.error,'sensitive_provider_response');assert.equal(redacted.body_base64,'');
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
 const r=spawnSync(process.execPath,[new URL('../src/browser-worker.mjs',import.meta.url).pathname],{input:JSON.stringify({browser:{executablePath:new URL('../package.json',import.meta.url).pathname,sha256:'bad'}}),encoding:'utf8',timeout:10000});
 assert.equal(r.status,0,r.stderr);const result=JSON.parse(r.stdout);assert.equal(result.error,'browser_build_mismatch');assert.equal(result.body_base64,'');
});
