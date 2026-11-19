import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {providerRule,providerRules,hostMatches} from '../src/provider-rules.mjs';
import {probeCell,probePlan,runProbe,summarizeProbe} from '../src/reachability.mjs';
import {exchange} from '../src/fetch/transport.mjs';
import {startRelay} from '../src/browser/relay.mjs';
import {databaseUrl,gatewayFor,html,openStore,testConfig} from './helpers.mjs';

test('default rule excludes Oxylabs for .gov hosts only',()=>{
 assert.equal(providerRule({},'oxylabs','myplace.cuyahogacounty.gov')?.id,'oxylabs-gov');
 assert.equal(providerRule({},'oxylabs','WWW.USA.GOV.')?.id,'oxylabs-gov');
 for(const host of ['example.com','gov.example.com','notgov','govt.nz'])assert.equal(providerRule({},'oxylabs',host),null);
 assert.equal(providerRule({},'evomi','ohio.gov'),null);
 assert.equal(hostMatches({hostSuffix:'.gov'},'gov'),true);
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
test('a refused CONNECT is the provider\'s answer, and a 502-504 means the exit could not reach the site',async()=>{
 const proxy=await fakeProxy(h=>h==='127.0.0.2'?444:502,{port:1});
 const url=`http://u:p@127.0.0.1:${proxy.address().port}`,limits={timeoutMs:3000,maxBodyBytes:1000,maxWireBytes:10000};
 const fetchVia=address=>exchange({method:'GET',headers:{}},{url:new URL('http://site.example.com/'),address,family:4},limits,{proxy:{url}});
 try{
  await assert.rejects(fetchVia('127.0.0.2'),e=>e.code==='provider_target_refused'&&e.provider_status===444&&e.dispatched===false);
  await assert.rejects(fetchVia('127.0.0.3'),e=>e.code==='source_unreachable'&&e.provider_status===502&&e.dispatched===false);
  // The browser relay reports the same codes instead of a generic browser failure.
  const pin={destination:{url:new URL('https://site.example.com/'),address:'127.0.0.2',family:4},permits:1};
  const relay=await startRelay({pins:new Map([['site.example.com',pin]]),proxy:{url},maxBytes:4096,deadline:Date.now()+3000});
  try{
   await new Promise((resolve,reject)=>{const q=http.request(relay.url,{method:'CONNECT',path:'site.example.com:443'});q.on('connect',(r,socket)=>{socket.destroy();resolve(r.statusCode);});q.on('error',reject);q.end();});
   assert.equal(relay.error,'provider_target_refused');
  }finally{await relay.close();}
 }finally{proxy.close();}
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
 assert.equal(s.proposed_provider_rules[0].provider,'oxylabs');assert.deepEqual(s.proposed_provider_rules[0].match,{host:'myplace.cuyahogacounty.gov'});
 assert.equal(JSON.stringify(report).includes('u:p'),false);
 // Datacenter blocked by the source; a challenge-only source needs a browser.
 const dcBlocked=summarizeProbe('shop.example.com',['US'],[{provider:'oxylabs',class:'datacenter',country:'US',result:'denied'},{provider:'evomi',class:'residential',country:'US',result:'ok'}]);
 assert.deepEqual(dcBlocked.datacenter_blocked_countries,['US']);assert.equal(dcBlocked.recommended_route.class,'residential');assert.equal(dcBlocked.geo_restricted,false);
 const walled=summarizeProbe('walled.example.com',['US'],[{provider:'oxylabs',class:'datacenter',country:'US',result:'challenge'},{provider:'evomi',class:'residential',country:'US',result:'challenge'}]);
 assert.deepEqual(walled.recommended_route,{country:'US',class:'residential',provider:'evomi',execution:'browser',verified:false});
 const cheap=summarizeProbe('example.com',['US'],[{provider:'oxylabs',class:'datacenter',country:'US',result:'ok'},{provider:'evomi',class:'residential',country:'US',result:'ok'}]);
 assert.equal(cheap.recommended_route.class,'datacenter');
});

test('an excluded residential provider is never used; its partner carries the request',{skip:!databaseUrl},async t=>{
 const store=await openStore();t.after(()=>store.close());
 const config=testConfig({routes:{direct:false},proxies:[],providerRules:[{id:'evomi-source',provider:'evomi',match:{host:'source.example.com'},action:'exclude',reason:'test'}]});
 const {call,calls}=await gatewayFor(store,{config,site:()=>({body:html('ok')})});
 const result=await call('POST','/v1/fetch',{body:{url:'https://source.example.com/'}});
 assert.equal(result.body.status,'succeeded');
 assert.deepEqual(calls.map(c=>c.provider),['dataimpulse']);
});

test('a provider refusing the host costs no attempt and the ladder moves on',{skip:!databaseUrl},async t=>{
 const store=await openStore();t.after(()=>store.close());
 const {GatewayError}=await import('../src/policy.mjs');
 const {call,calls}=await gatewayFor(store,{config:testConfig({routes:{direct:false}}),site:c=>{
  if(c.provider==='oxylabs'){const e=new GatewayError('provider_target_refused',502);e.dispatched=false;e.provider_status=444;return e;}
  return {body:html('ok')};
 }});
 const result=await call('POST','/v1/fetch',{body:{url:'https://shop.example.com/',max_attempts:1}});
 assert.equal(result.body.status,'succeeded',JSON.stringify(result.body));
 assert.deepEqual(calls.map(c=>c.provider),['oxylabs','evomi']);
 assert.deepEqual(result.body.attempts.map(a=>a.result),['not_admitted','success']);
});

test('database rules: precedence, versioned saves, default override, delete and audit',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const {Store}=await import('../src/store.mjs'),m=await import('../src/provider-rules.mjs');
 assert.match(new URL(process.env.TEST_DATABASE_URL).pathname,/^\/gateway_test_[A-Za-z0-9]+$/);
 const store=new Store(process.env.TEST_DATABASE_URL);await store.init();await store.pool.query('TRUNCATE routing_rules,routing_rule_audit RESTART IDENTITY');
 const config={providerRules:[{id:'dataimpulse-shop',provider:'dataimpulse',match:{host:'shop.example.com'},action:'exclude',reason:'config rule'}]};
 const actor='ops@example.com';
 try{
  assert.deepEqual(await m.loadProviderRules(store.pool,config),{loaded:0,rejected:[]});
  assert.deepEqual(m.providerRuleSources(config).map(r=>`${r.id}:${r.source}`),['oxylabs-gov:default','dataimpulse-shop:config']);
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
