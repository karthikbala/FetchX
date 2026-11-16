import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {Store} from '../src/store.mjs';
import {Gateway} from '../src/gateway.mjs';
import {connectFailure,providerExcluded,validateProviderExclusions} from '../src/policy.mjs';
import {classifyOutcome} from '../src/diagnostics.mjs';
import {probeResult,proposeRule,probeHost} from '../src/reachability.mjs';
import {connectRelay} from '../src/connect-relay.mjs';

test('a refused CONNECT says which layer refused',()=>{
 for(const s of [403,444,451])assert.equal(connectFailure(s),'provider_target_refused');
 for(const s of [502,503,504])assert.equal(connectFailure(s),'source_unreachable');
 for(const s of [401,402,407])assert.equal(connectFailure(s),'provider_account_rejected');
 assert.equal(connectFailure(500),'proxy_connect_failed');
 assert.equal(classifyOutcome({status:null,error:'provider_target_refused'}),'provider_refused');
 assert.equal(classifyOutcome({status:null,error:'source_unreachable'}),'source_unreachable');
 assert.equal(classifyOutcome({status:null,error:'proxy_connect_failed'}),'transport_failure');
});

test('Oxylabs is excluded for .gov hosts by default and exclusions are configurable',()=>{
 for(const host of ['myplace.cuyahogacounty.gov','www.irs.gov','usa.gov','USA.GOV.'])assert.equal(providerExcluded({},'oxylabs',host),true,host);
 for(const host of ['gov.example.com','example.gov.uk','government.com'])assert.equal(providerExcluded({},'oxylabs',host),false,host);
 assert.equal(providerExcluded({},'scrapedo','www.irs.gov'),false);
 const config={providerExclusions:[{provider:'scrapedo',hostSuffixes:['.mil','example.org']}]};
 assert.equal(providerExcluded(config,'oxylabs','www.irs.gov'),false,'config replaces the default list');
 assert.equal(providerExcluded(config,'scrapedo','army.mil'),true);assert.equal(providerExcluded(config,'scrapedo','example.org'),true);
 validateProviderExclusions(undefined);validateProviderExclusions(config.providerExclusions);
 for(const bad of [{},[{provider:'evomi',hostSuffixes:['.gov']}],[{provider:'oxylabs',hostSuffixes:[]}],[{provider:'oxylabs',hostSuffixes:['bad host']}]])assert.throws(()=>validateProviderExclusions(bad),/provider_exclusions_invalid/);
});

test('the relay reports a provider policy refusal separately from an unreachable source',async()=>{
 for(const [answer,expected] of [[444,'provider_target_refused'],[502,'source_unreachable'],[407,'provider_account_rejected']]){
  const upstream=http.createServer();upstream.on('connect',(req,socket)=>{socket.end(`HTTP/1.1 ${answer} No\r\n\r\n`);});
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
  const relay=await connectRelay({proxy:{url:`http://u:p@127.0.0.1:${upstream.address().port}`},profile:{hosts:['source.gov']},maxBytes:4096,resolve:async()=>[{address:'93.184.216.34'}]});
  try{
   const status=await new Promise((resolve,reject)=>{const q=http.request(relay.url,{method:'CONNECT',path:'source.gov:443'});q.on('connect',(r,s)=>{s.destroy();resolve(r.statusCode);});q.on('error',reject);q.end();});
   assert.equal(status,502);await new Promise(r=>setTimeout(r,20));assert.equal(relay.error,expected,String(answer));
  }finally{await relay.close();await new Promise(r=>upstream.close(r));}
 }
});

// The Cuyahoga matrix measured on 2026-11-16: US-only, Oxylabs refuses .gov.
const cuyahoga=[
 {provider:'oxylabs',class:'datacenter',country:'US',result:'provider_refused'},
 {provider:'evomi',class:'residential',country:'US',result:'ok'},
 {provider:'dataimpulse',class:'residential',country:'US',result:'ok'},
 {provider:'oxylabs',class:'datacenter',country:'GB',result:'provider_refused'},
 {provider:'evomi',class:'residential',country:'GB',result:'unreachable'},
 {provider:'dataimpulse',class:'residential',country:'GB',result:'unreachable'}];

test('probe results become a proposed rule, never an active one',()=>{
 assert.equal(probeResult({status:200}),'ok');assert.equal(probeResult({status:301}),'ok');
 assert.equal(probeResult({status:null,error:'provider_target_refused'}),'provider_refused');
 assert.equal(probeResult({status:null,error:'source_unreachable'}),'unreachable');
 assert.equal(probeResult({status:null,error:'tls_verification_failed'}),'unreachable');
 assert.equal(probeResult({status:403}),'denied');assert.equal(probeResult({status:429}),'rate_limited');
 const rule=proposeRule('myplace.cuyahogacounty.gov',cuyahoga);
 assert.equal(rule.status,'proposed');assert.deepEqual(rule.allowedCountries,['US']);assert.deepEqual(rule.excludedProviders,['oxylabs']);
 assert.equal(rule.startRoute,'residential_http');assert.equal(rule.browserNeeded,null);
 assert.ok(rule.findings.some(f=>f.startsWith('country_restricted')));assert.ok(rule.findings.some(f=>f.startsWith('provider_refused: oxylabs')));
 // Datacenter blocked by the site (not the provider) in a country residential reaches.
 const dc=proposeRule('x.example',[{provider:'oxylabs',class:'datacenter',country:'US',result:'unreachable'},{provider:'evomi',class:'residential',country:'US',result:'ok'}]);
 assert.deepEqual(dc.excludedProviders,[]);assert.equal(dc.allowedCountries,null);assert.ok(dc.findings.some(f=>f.startsWith('datacenter_blocked')));
 const open=proposeRule('y.example',[{provider:'oxylabs',class:'datacenter',country:'US',result:'ok'},{provider:'oxylabs',class:'datacenter',country:'GB',result:'ok'}]);
 assert.equal(open.startRoute,'datacenter');assert.deepEqual(open.findings,[]);
});

test('probeHost runs the matrix without trying an excluded provider',async()=>{
 const config={proxies:[{id:'us',country:'US',url:'http://dc-us'}],residential:{providers:{evomi:{enabled:true,username:'u',password:'p'}}}};
 const seen=[];
 const rule=await probeHost(config,'www.irs.gov',['US'],{request:async(url,host,{residential})=>{seen.push(residential);return {status:200};}});
 assert.deepEqual(seen,[true],'only Evomi was contacted');
 assert.deepEqual(rule.matrix.map(c=>`${c.provider}:${c.result}`),['oxylabs:excluded','evomi:ok','dataimpulse:unconfigured']);
 assert.equal(rule.startRoute,'residential_http');
 assert.ok(!JSON.stringify(rule).includes('dc-us')&&!JSON.stringify(rule).includes('"p"'),'no proxy addresses or credentials in the proposal');
 await assert.rejects(probeHost(config,'bad host',['US']),/probe_input_invalid/);
});

test('a .gov request never goes through Oxylabs',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const url=new URL(process.env.TEST_DATABASE_URL),admin=new Store(url.href),schema='exclusion_'+randomUUID().replaceAll('-','');
 await admin.pool.query('CREATE SCHEMA '+schema);url.searchParams.set('options','-c search_path='+schema);
 const store=new Store(url.href),root=await mkdtemp(join(tmpdir(),'gateway-exclusion-'));
 const profile={hosts:['www.irs.gov'],methods:['GET'],headers:[],country:'US',maxConcurrent:4,maxRequests:20,maxInputBytes:1024,maxResponseBytes:4096,maxBytes:65536,ttlSeconds:120,minIntervalMs:0,maxFallbackCredits:0,fallbackMaxCost:1,fallbackSuper:false,fallbackCountry:'us'};
 const config={release:'exclusion-test',artifactDir:root,artifactKey:'11'.repeat(32),maxDailyFallbackCredits:10,scrapeDoToken:'offline-token',projects:{test:{profiles:['gov.plain','gov.paid']}},proxies:[{id:'us-fixture',country:'US',url:'offline-proxy'}]};
 const calls=[];
 const gateway=new Gateway({store,config,profiles:{'gov.plain':profile,'gov.paid':{...profile,maxFallbackCredits:4}},resolve:async()=>[{address:'93.184.216.34'}],
  transport:{oxylabs:async()=>{calls.push('oxylabs');return {status:200,headers:{},cookies:[],body:Buffer.from('x')};},scrapedo:async()=>{calls.push('scrapedo');return {status:200,providerStatus:200,headers:{},cookies:[],body:Buffer.from('paid'),credits:1};}}});
 const input={method:'GET',url:'https://www.irs.gov/',headers:{},idempotency_key:'one'};
 try{
  await store.init();
  const plain=await gateway.workflow('test',{profile:'gov.plain',idempotency_key:'a'});
  await assert.rejects(gateway.operation('test',plain.id,input),/provider_excluded/);
  const paid=await gateway.workflow('test',{profile:'gov.paid',idempotency_key:'b'});
  const r=await gateway.operation('test',paid.id,input);assert.equal(r.provider,'scrapedo');assert.equal(r.status,200);
  assert.deepEqual(calls,['scrapedo']);
  assert.equal((await store.pool.query("SELECT routing_reason FROM attempts WHERE workflow=$1",[paid.id])).rows[0].routing_reason,'provider_excluded');
  assert.equal((await store.pool.query("SELECT count(*)::int n FROM route_health WHERE consecutive_failed_workflows>0")).rows[0].n,0,'no route health penalty');
 }finally{await store.close();await admin.pool.query('DROP SCHEMA '+schema+' CASCADE');await admin.close();await rm(root,{recursive:true,force:true});}
});
