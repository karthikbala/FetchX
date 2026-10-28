import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {Gateway} from '../src/gateway.mjs';
import {classifyOutcome} from '../src/diagnostics.mjs';
import {recordRouteOutcome} from '../src/route-health.mjs';

const enabled=!!process.env.TEST_DATABASE_URL;
const fixtureHtml=await readFile(new URL('./fixtures/amazon-404-comment.html',import.meta.url),'utf8');
const input={method:'GET',main_document:true,resource_type:'document',headers:{},zipcode:'500022'};
const html=(body,status=404)=>({status,headers:{'content-type':'text/html'},body:Buffer.from(body),error:null});

test('synthetic not-found page comment is not a challenge',()=>{
 assert.match(fixtureHtml,/<!--\s*To discuss automated access to Amazon/);
 assert.equal(classifyOutcome(html(fixtureHtml),input),'unknown');
 assert.equal(classifyOutcome(html(fixtureHtml,200),input),'success');
});

test('real challenge signals survive comments, misleading 404s and raw-text delimiters',()=>{
 const real=['<title>Robot Check</title>','<form action="/errors/validateCaptcha"><input></form>',
  '<p>Verify that you are a human</p>','<p>Automated access to Amazon has been blocked.</p>'];
 for(const signal of real){
  assert.equal(classifyOutcome(html(fixtureHtml+signal),input),'source_challenge');
  assert.equal(classifyOutcome(html('<!-- harmless -->'+signal,200),input),'source_challenge');
 }
 for(const prefix of ['<!-->','<!--->','<!-- harmless --!>','<script>const marker="<!--";</script>',
  '<style>/* <!-- */</style>','<textarea><!--</textarea>']){
  assert.equal(classifyOutcome(html(prefix+real[1]),input),'source_challenge',prefix);
 }
 assert.equal(classifyOutcome(html('<!-- '+real.join(' ')+' -->'),input),'unknown');
 assert.equal(classifyOutcome(html('<!-- automated access to Amazon'),input),'unknown');
 assert.equal(classifyOutcome(html('<script>const msg="verify you are human";</script>'),input),'source_challenge','existing raw-text signal handling is preserved');
});

test('comment filtering retains HTTP denials, explicit challenge errors and the original inspection bound',()=>{
 assert.equal(classifyOutcome(html(fixtureHtml,403),input),'source_denied');
 assert.equal(classifyOutcome(html(fixtureHtml,429),input),'rate_limited');
 assert.equal(classifyOutcome({...html(fixtureHtml),error:'source_challenge'},input),'source_challenge');
 assert.equal(classifyOutcome(html('x'.repeat(12001)+'<title>Robot Check</title>',200),input),'success');
 assert.equal(classifyOutcome({...html('<title>Robot Check</title>'),headers:{'content-type':'application/json'}},input),'unknown');
});

async function fixture(run){
 const url=new URL(process.env.TEST_DATABASE_URL);
 assert.match(url.pathname,/^\/(?:gateway_conformance|gateway_test)(?:_[A-Za-z0-9]+)?$/);
 const admin=new Store(url.href),schema='amazon404_'+randomUUID().replaceAll('-','');
 await admin.pool.query('CREATE SCHEMA '+schema);url.searchParams.set('options','-c search_path='+schema);
 const store=new Store(url.href),root=await mkdtemp(join(tmpdir(),'gateway-amazon404-'));
 const profile={hosts:['www.amazon.in'],methods:['GET'],headers:[],country:'IN',maxConcurrent:4,
  maxRequests:20,maxInputBytes:1024,maxResponseBytes:4096,maxBytes:65536,ttlSeconds:120,minIntervalMs:0,
  maxFallbackCredits:4,fallbackMaxCost:1,fallbackSuper:false,fallbackCountry:'in'};
 const config={release:'amazon404-test',artifactDir:root,artifactKey:'11'.repeat(32),maxDailyFallbackCredits:10,
  scrapeDoToken:'offline-token',projects:{test:{profiles:['mop.amazon']}},proxies:[{id:'in-fixture',country:'IN',url:'offline-proxy'}]};
 const calls=[];let native=html(fixtureHtml);
 const gateway=new Gateway({store,config,profiles:{'mop.amazon':profile},resolve:async()=>[{address:'93.184.216.34'}],
  transport:{oxylabs:async()=>{calls.push('oxylabs');return {...native};},
   scrapedo:async()=>{calls.push('scrapedo');return {...html('<html>paid response</html>',200),providerStatus:200,credits:1};}}});
 try{
  await store.init();
  await run({store,gateway,config,calls,setNative:value=>{native=value;}});
 }finally{await store.close();await admin.pool.query('DROP SCHEMA '+schema+' CASCADE');await admin.close();await rm(root,{recursive:true,force:true});}
}

test('genuine Amazon 404s stay native, charge no paid credits and do not quarantine routes',{skip:!enabled},async()=>fixture(async({store,gateway,calls})=>{
 for(let n=0;n<4;n++){
  const workflow=await gateway.workflow('test',{profile:'mop.amazon',idempotency_key:'not-found-'+n});
  const request={...input,url:'https://www.amazon.in/dp/B0BQR3BTKB',idempotency_key:'document'};
  const response=await gateway.operation('test',workflow.id,request);
  assert.equal(response.provider,'oxylabs');assert.equal(response.status,404);assert.equal(response.error,null);
  assert.equal(response.credits,null);assert.equal(response.proxy_cost_basis,'existing_subscription_included_usage');
  assert.equal(Buffer.from(response.body_base64,'base64').toString(),fixtureHtml);
  assert.deepEqual(await gateway.operation('test',workflow.id,request),response,'replay keeps the exact stored 404');
  const state=await gateway.read('test',workflow.id);assert.equal(state.route,'oxylabs');assert.equal(state.requests,1);
  await gateway.close('test',workflow.id);
 }
 assert.deepEqual(calls,['oxylabs','oxylabs','oxylabs','oxylabs']);
 assert.equal((await store.pool.query("SELECT count(*)::int AS n FROM attempts WHERE provider='scrapedo'")).rows[0].n,0);
 const health=(await store.pool.query('SELECT * FROM route_health')).rows;
 assert.ok(health.every(r=>r.consecutive_failed_workflows===0&&r.quarantined_until===null));
 assert.equal((await store.pool.query("SELECT count(*)::int AS n FROM attempts WHERE outcome_category='source_challenge'")).rows[0].n,0);
}));

test('real CAPTCHA on an HTTP 404 still triggers one correctly accounted paid fallback',{skip:!enabled},async()=>fixture(async({store,gateway,calls,setNative})=>{
 setNative(html(fixtureHtml+'<form action="/errors/validateCaptcha"></form>'));
 const workflow=await gateway.workflow('test',{profile:'mop.amazon',idempotency_key:'real-challenge'});
 const response=await gateway.operation('test',workflow.id,{...input,url:'https://www.amazon.in/dp/B0BQR3BTKB',idempotency_key:'document'});
 assert.deepEqual(calls,['oxylabs','scrapedo']);assert.equal(response.provider,'scrapedo');assert.equal(response.credits,1);
 const paid=(await store.pool.query("SELECT credits,routing_reason FROM attempts WHERE provider='scrapedo'")).rows;
 assert.deepEqual(paid,[{credits:1,routing_reason:'fallback_source_challenge'}]);
 const health=(await store.pool.query('SELECT * FROM route_health')).rows;
 assert.equal(health[0].consecutive_failed_workflows,1);assert.equal(health[0].last_failure,'source_challenge');
}));

test('route health ignores comment-only challenge text for documents and API replies',{skip:!enabled},async()=>fixture(async({store,config})=>{
 for(const resource_type of ['document','xhr','fetch']){
  const request={...input,resource_type,main_document:resource_type==='document'};
  await store.tx(c=>recordRouteOutcome(c,{profile:'mop.amazon',proxyId:'in-fixture',workflowId:randomUUID(),response:{...html(fixtureHtml),provider:'oxylabs'},input:request,config}));
 }
 assert.deepEqual((await store.pool.query('SELECT * FROM route_health')).rows,[]);
}));
