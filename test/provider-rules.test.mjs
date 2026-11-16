import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {providerRule,providerRules,assertProviderAllowed,hostMatches} from '../src/provider-rules.mjs';
import {probeCell,probePlan,runProbe,summarizeProbe} from '../src/reachability.mjs';
import {connectRelay} from '../src/connect-relay.mjs';
import {classifyOutcome} from '../src/diagnostics.mjs';

test('default rule excludes Oxylabs for .gov hosts only',()=>{
 assert.equal(providerRule({},'oxylabs','myplace.cuyahogacounty.gov')?.id,'oxylabs-gov');
 assert.equal(providerRule({},'oxylabs','WWW.USA.GOV.')?.id,'oxylabs-gov');
 for(const host of ['example.com','gov.example.com','notgov','govt.nz'])assert.equal(providerRule({},'oxylabs',host),null);
 assert.equal(providerRule({},'evomi','ohio.gov'),null);
 assert.equal(hostMatches({hostSuffix:'.gov'},'gov'),true);
 assert.throws(()=>assertProviderAllowed({},'oxylabs','irs.gov'),e=>e.code==='provider_host_excluded'&&e.status===409&&e.details.rule==='oxylabs-gov');
 assert.doesNotThrow(()=>assertProviderAllowed({},'dataimpulse','irs.gov'));
});
test('config rules add, replace or disable defaults and are validated',()=>{
 const config={providerRules:[{id:'oxylabs-gov',provider:'oxylabs',match:{hostSuffix:'.gov'},action:'exclude',reason:'disabled for test',enabled:false},{id:'evomi-shop',provider:'evomi',match:{host:'shop.example.com'},action:'exclude',reason:'test'}]};
 assert.equal(providerRule(config,'oxylabs','ohio.gov'),null);
 assert.equal(providerRule(config,'evomi','shop.example.com')?.id,'evomi-shop');assert.equal(providerRule(config,'evomi','www.shop.example.com'),null);
 assert.equal(providerRules(config).length,2);
 for(const bad of [{id:'x',provider:'unknown',match:{host:'a.com'},action:'exclude',reason:'r'},{id:'x',provider:'evomi',match:{host:'a.com',hostSuffix:'.com'},action:'exclude',reason:'r'},{id:'x',provider:'evomi',match:{hostSuffix:'com'},action:'exclude',reason:'r'},{id:'x',provider:'evomi',match:{host:'a.com'},action:'allow',reason:'r'},{id:'Bad Id',provider:'evomi',match:{host:'a.com'},action:'exclude',reason:'r'}])
  assert.throws(()=>providerRules({providerRules:[bad]}),/provider_rules_invalid/);
});

// A minimal CONNECT proxy: refuses some hosts with a status, otherwise tunnels to `target`.
async function fakeProxy(statusFor,target){
 const server=http.createServer((q,r)=>{r.writeHead(400);r.end();});
 server.on('connect',(req,client)=>{
  const status=statusFor(req.url.split(':')[0]);
  if(status!==200){client.end(`HTTP/1.1 ${status} Refused\r\n\r\n`);return;}
  const remote=net.connect(target.port,'127.0.0.1',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');remote.pipe(client);client.pipe(remote);});
  remote.on('error',()=>client.destroy());client.on('error',()=>remote.destroy());
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));return server;
}
test('probe cell classifies provider refusal, account rejection, unreachable TLS and HTTP outcomes',async()=>{
 const source=http.createServer((q,r)=>{if(q.headers.host==='walled.example.com'){r.writeHead(429,{'content-type':'text/html'});r.end('<title>Bot or Not?</title>');return;}if(q.headers.host==='denied.example.com'){r.writeHead(403,{'content-type':'text/html'});r.end('no');return;}r.writeHead(200,{'content-type':'text/html'});r.end('<title>Home</title>');});
 await new Promise(r=>source.listen(0,'127.0.0.1',r));
 const proxy=await fakeProxy(h=>h==='refused.gov'?444:h==='auth.example.com'?407:h==='down.example.com'?502:200,source.address());
 const proxyUrl=`http://user:pass@127.0.0.1:${proxy.address().port}`,plain=async s=>s;// tests tunnel plain HTTP in place of TLS
 try{
  assert.equal((await probeCell({proxyUrl,host:'refused.gov',tlsConnect:plain})).result,'provider_refused');
  assert.equal((await probeCell({proxyUrl,host:'refused.gov',tlsConnect:plain})).connect_status,444);
  assert.equal((await probeCell({proxyUrl,host:'auth.example.com',tlsConnect:plain})).result,'account_rejected');
  assert.equal((await probeCell({proxyUrl,host:'down.example.com',tlsConnect:plain})).result,'unreachable');
  const ok=await probeCell({proxyUrl,host:'ok.example.com',tlsConnect:plain});assert.equal(ok.result,'ok');assert.equal(ok.http_status,200);assert.equal(ok.tls,true);assert.ok(ok.bytes>0);assert.equal('body' in ok,false);
  assert.equal((await probeCell({proxyUrl,host:'walled.example.com',tlsConnect:plain})).result,'rate_limited');
  assert.equal((await probeCell({proxyUrl,host:'denied.example.com',tlsConnect:plain})).result,'denied');
  // Real TLS against a plaintext peer fails the handshake: the "wrong version number" case.
  const tlsFail=await probeCell({proxyUrl,host:'ok.example.com',timeoutMs:3000});assert.equal(tlsFail.result,'unreachable');assert.equal(tlsFail.stage,'tls');
  assert.equal((await probeCell({proxyUrl:'http://127.0.0.1:1',host:'ok.example.com',timeoutMs:2000})).result,'proxy_failed');
 }finally{proxy.close();source.close();}
});
test('CONNECT relay reports a provider 4xx refusal as provider_target_refused',async()=>{
 const proxy=await fakeProxy(()=>444,{port:1});
 const relay=await connectRelay({proxy:{url:`http://u:p@127.0.0.1:${proxy.address().port}`},profile:{hosts:['refused.gov']},maxBytes:4096,resolve:async()=>[{address:'93.184.216.34'}]});
 try{
  await new Promise((resolve,reject)=>{const q=http.request(relay.url,{method:'CONNECT',path:'refused.gov:443'});q.on('connect',(r,s)=>{s.destroy();resolve(r.statusCode);});q.on('error',reject);q.end();});
  assert.equal(relay.error,'provider_target_refused');
  assert.equal(classifyOutcome({status:null,error:'provider_target_refused'}),'provider_refused');
 }finally{await relay.close();proxy.close();}
});
test('CONNECT relay reports a proxy 502-504 as source_unreachable',async()=>{
 const proxy=await fakeProxy(()=>502,{port:1});
 const relay=await connectRelay({proxy:{url:`http://u:p@127.0.0.1:${proxy.address().port}`},profile:{hosts:['geo.example.com']},maxBytes:4096,resolve:async()=>[{address:'93.184.216.34'}]});
 try{
  await new Promise((resolve,reject)=>{const q=http.request(relay.url,{method:'CONNECT',path:'geo.example.com:443'});q.on('connect',(r,s)=>{s.destroy();resolve(r.statusCode);});q.on('error',reject);q.end();});
  assert.equal(relay.error,'source_unreachable');assert.equal(classifyOutcome({status:null,error:'source_unreachable'}),'source_unreachable');
 }finally{await relay.close();proxy.close();}
});
test('probe plan skips rule-excluded providers and the summary infers country, provider and datacenter limits',async()=>{
 const config={proxies:[{id:'us-1',country:'US',url:'http://u:p@dc.invalid:1'},{id:'gb-1',country:'GB',url:'http://u:p@dc.invalid:2'}],residential:{providers:{evomi:{enabled:true,username:'u',password:'p'},dataimpulse:{enabled:false}}}};
 const plan=probePlan(config,'myplace.cuyahogacounty.gov',['US','GB']);
 assert.deepEqual(plan.map(c=>`${c.provider}/${c.class}/${c.country}/${c.excluded??'-'}`),['oxylabs/datacenter/US/oxylabs-gov','evomi/residential/US/-','oxylabs/datacenter/GB/oxylabs-gov','evomi/residential/GB/-']);
 assert.throws(()=>probePlan(config,'http://x',['US']),/probe_host_invalid/);
 // Matrix observed for the Cuyahoga host on 2026-11-16, with the rule disabled.
 const report=await runProbe(config,'myplace.cuyahogacounty.gov',['US','GB'],{includeExcluded:true,paceMs:0,probe:async({proxyUrl})=>proxyUrl.includes('dc.invalid')?{result:'provider_refused',connect_status:444}:proxyUrl.includes('country-US')?{result:'ok',http_status:200}:{result:'unreachable',stage:'tls'}});
 const s=report.summary;
 assert.deepEqual(s.reachable_countries,['US']);assert.deepEqual(s.unreachable_countries,['GB']);assert.equal(s.geo_restricted,true);
 assert.deepEqual(s.provider_refused,['oxylabs']);assert.deepEqual(s.datacenter_blocked_countries,[]);
 assert.deepEqual(s.recommended_route,{country:'US',class:'residential',provider:'evomi',execution:'http'});
 assert.deepEqual(s.proposed_profile,{v1:{country:'US',routingPolicy:'residential-v1',execution:'http'},v2:{countries:['US'],proxy_classes:['residential']}});
 assert.equal(s.proposed_provider_rules[0].provider,'oxylabs');assert.deepEqual(s.proposed_provider_rules[0].match,{host:'myplace.cuyahogacounty.gov'});
 assert.equal(JSON.stringify(report).includes('u:p'),false);
 // Datacenter blocked by the source; a challenge-only source needs a browser.
 const dcBlocked=summarizeProbe('shop.example.com',['US'],[{provider:'oxylabs',class:'datacenter',country:'US',result:'denied'},{provider:'evomi',class:'residential',country:'US',result:'ok'}]);
 assert.deepEqual(dcBlocked.datacenter_blocked_countries,['US']);assert.equal(dcBlocked.recommended_route.class,'residential');assert.equal(dcBlocked.geo_restricted,false);
 const walled=summarizeProbe('walled.example.com',['US'],[{provider:'oxylabs',class:'datacenter',country:'US',result:'challenge'},{provider:'evomi',class:'residential',country:'US',result:'challenge'}]);
 assert.deepEqual(walled.recommended_route,{country:'US',class:'residential',provider:'evomi',execution:'browser',verified:false});
 const cheap=summarizeProbe('example.com',['US'],[{provider:'oxylabs',class:'datacenter',country:'US',result:'ok'},{provider:'evomi',class:'residential',country:'US',result:'ok'}]);
 assert.equal(cheap.recommended_route.class,'datacenter');assert.deepEqual(cheap.proposed_profile.v1,{country:'US'});
});

test('gateway never dispatches an excluded provider and starts residential on the next allowed route',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const {Store}=await import('../src/store.mjs'),{Gateway}=await import('../src/gateway.mjs'),{sha}=await import('../src/crypto.mjs');
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 assert.match(new URL(process.env.TEST_DATABASE_URL).pathname,/^\/gateway_test_[A-Za-z0-9]+$/);
 const root=await mkdtemp(join(tmpdir(),'rules-test-')),store=new Store(process.env.TEST_DATABASE_URL);await store.init();
 await store.pool.query('TRUNCATE ledger,attempts,operations,workflows,source_limits RESTART IDENTITY CASCADE');
 const base={methods:['GET'],headers:[],country:'US',maxConcurrent:1,maxRequests:4,maxInputBytes:1024,maxResponseBytes:1024,maxBytes:20000,ttlSeconds:120,minIntervalMs:0,maxFallbackCredits:0};
 const provider={enabled:true,username:'u',password:'p',maxTotalBytes:100000,microUsdPerGB:1000000};
 const config={release:'test',artifactDir:root,artifactKey:'33'.repeat(32),maxDailyFallbackCredits:0,proxies:[{id:'us-1',country:'US',url:'http://u:p@127.0.0.1:9'}],
  residential:{maxDailyBytes:100000,maxTotalBytes:100000,providers:{evomi:{...provider},dataimpulse:{...provider}}},
  providerRules:[{id:'evomi-source',provider:'evomi',match:{host:'source.example'},action:'exclude',reason:'test'}],
  projects:{a:{profiles:['dc','res'],tokenHash:sha('a')}}};
 const calls=[];
 const g=new Gateway({store,config,profiles:{dc:{...base,hosts:['records.county.gov']},res:{...base,hosts:['source.example'],routingPolicy:'residential-v1',maxAttemptBytes:1000,maxResidentialBytes:4000}},resolve:async()=>[{address:'93.184.216.34'}],
  transport:{oxylabs:async()=>{calls.push('oxylabs');return {status:200,headers:{},body:Buffer.from('x')};},residential:async(input,w)=>{calls.push(w.route);return {status:200,headers:{},body:Buffer.from('ok'),wireBytes:10,proxyTraffic:{status:'measured',bytes:10}};}}});
 try{
  const dc=await g.workflow('a',{profile:'dc',idempotency_key:'dc'});
  await assert.rejects(g.operation('a',dc.id,{idempotency_key:'o1',url:'https://records.county.gov/'}),e=>e.code==='provider_host_excluded');
  assert.deepEqual(calls,[]);assert.equal((await store.pool.query('SELECT count(*)::int n FROM attempts')).rows[0].n,0);
  const res=await g.workflow('a',{profile:'res',idempotency_key:'res'});assert.equal(res.route,'evomi');
  const r=await g.operation('a',res.id,{idempotency_key:'o2',url:'https://source.example/'});
  assert.equal(r.status,200);assert.equal(r.provider,'dataimpulse');assert.deepEqual(calls,['dataimpulse']);assert.equal((await g.read('a',res.id)).route,'dataimpulse');
 }finally{await store.close();await rm(root,{recursive:true,force:true});}
});

test('v2 routes refuse an excluded provider for the destination and redirect hosts',async()=>{
 const {V2Gateway}=await import('../src/v2.mjs');
 const v=Object.create(V2Gateway.prototype);v.config={proxies:[{id:'us-1',country:'US',url:'http://u:p@127.0.0.1:9'},{id:'us-x',country:'US',provider:'otherdc',url:'http://u:p@127.0.0.1:9'}]};
 assert.throws(()=>v.assertRouteProvider({class:'datacenter',country:'US',proxy_id:'us-1'},'www.irs.gov'),e=>e.code==='provider_host_excluded'&&e.details.provider==='oxylabs');
 assert.doesNotThrow(()=>v.assertRouteProvider({class:'datacenter',country:'US',proxy_id:'us-1'},'example.com'));
 assert.doesNotThrow(()=>v.assertRouteProvider({class:'residential',country:'US',provider:'evomi'},'www.irs.gov'));
 assert.doesNotThrow(()=>v.assertRouteProvider({class:'direct',country:null},'www.irs.gov'));
});

test('database rules: precedence, versioned saves, default override, delete and audit',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const {Store}=await import('../src/store.mjs'),m=await import('../src/provider-rules.mjs');
 assert.match(new URL(process.env.TEST_DATABASE_URL).pathname,/^\/gateway_test_[A-Za-z0-9]+$/);
 const store=new Store(process.env.TEST_DATABASE_URL);await store.init();await store.pool.query('TRUNCATE routing_rules,routing_rule_audit RESTART IDENTITY');
 const config={providerRules:[{id:'scrapedo-shop',provider:'scrapedo',match:{host:'shop.example.com'},action:'exclude',reason:'config rule'}]};
 const actor='ops@example.com';
 try{
  assert.deepEqual(await m.loadProviderRules(store.pool,config),{loaded:0,rejected:[]});
  assert.deepEqual(m.providerRuleSources(config).map(r=>`${r.id}:${r.source}`),['oxylabs-gov:default','scrapedo-shop:config']);
  // Create, then a stale or missing version conflicts; the right version updates.
  const rule={id:'evomi-records',provider:'evomi',match:{hostSuffix:'.records.example'},action:'exclude',reason:'portal rule',evidence:{probe:'p1'}};
  const created=await m.saveProviderRule(store,rule,{actor});assert.equal(created.version,1);
  await assert.rejects(m.saveProviderRule(store,rule,{actor}),e=>e.code==='rule_version_conflict');
  await assert.rejects(m.saveProviderRule(store,{...rule,reason:'x'},{actor,expectedVersion:5}),e=>e.code==='rule_version_conflict');
  assert.equal((await m.saveProviderRule(store,{...rule,reason:'edited'},{actor,expectedVersion:1})).version,2);
  for(const bad of [{...rule,provider:'nope'},{...rule,extra:1},{...rule,evidence:'text'},{...rule,evidence:{blob:'x'.repeat(5000)}}])await assert.rejects(m.saveProviderRule(store,bad,{actor,expectedVersion:2}),e=>e.code==='rule_invalid');
  await assert.rejects(m.saveProviderRule(store,{...rule,id:'other'},{actor:'bad actor!'}),e=>e.code==='rule_actor_invalid');
  // Not visible to routing until loaded (the gateway refreshes on an interval).
  assert.equal(m.providerRule(config,'evomi','a.records.example'),null);
  await m.loadProviderRules(store.pool,config);assert.equal(m.providerRule(config,'evomi','a.records.example')?.id,'evomi-records');
  // Disabling a shipped default writes a database override; deleting it restores the default.
  await assert.rejects(m.setProviderRuleEnabled(store,config,'oxylabs-gov',false,{actor,reason:''}),e=>e.code==='rule_reason_required');
  await assert.rejects(m.setProviderRuleEnabled(store,config,'missing',false,{actor,reason:'x'}),e=>e.code==='rule_not_found');
  const off=await m.setProviderRuleEnabled(store,config,'oxylabs-gov',false,{actor,reason:'Oxylabs enabled .gov for our account'});assert.equal(off.enabled,false);assert.deepEqual(off.match,{hostSuffix:'.gov'});
  await m.loadProviderRules(store.pool,config);assert.equal(m.providerRule(config,'oxylabs','ohio.gov'),null);
  const sources=m.providerRuleSources(config);assert.deepEqual(sources.find(r=>r.id==='oxylabs-gov')?.overrides,'default');assert.equal(sources.find(r=>r.id==='oxylabs-gov').source,'database');
  await m.deleteProviderRule(store,'oxylabs-gov',{actor});await m.loadProviderRules(store.pool,config);assert.equal(m.providerRule(config,'oxylabs','ohio.gov')?.id,'oxylabs-gov');
  await assert.rejects(m.deleteProviderRule(store,'oxylabs-gov',{actor}),e=>e.code==='rule_not_found');
  // An invalid row (written outside the API) is skipped, never loaded.
  await store.pool.query("INSERT INTO routing_rules(id,provider,match,reason,updated_by) VALUES('broken','evomi','{\"host\":\"NOT A HOST\"}','x','sql')");
  assert.deepEqual((await m.loadProviderRules(store.pool,config)).rejected,['broken']);
  const audit=await m.providerRuleAudit(store.pool);
  assert.deepEqual(audit.map(a=>`${a.rule_id}:${a.action}`).reverse(),['evomi-records:create','evomi-records:update','oxylabs-gov:disable','oxylabs-gov:delete']);
  assert.ok(audit.every(a=>a.actor===actor));assert.equal(audit.find(a=>a.action==='disable').after.note,'Oxylabs enabled .gov for our account');
 }finally{await store.close();}
});
