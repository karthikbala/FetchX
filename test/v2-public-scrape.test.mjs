import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {sha} from '../src/crypto.mjs';
import {Gateway} from '../src/gateway.mjs';
import {server,controlKeyScope} from '../src/main.mjs';
import {Store} from '../src/store.mjs';
import {scrapeDocument} from '../src/v2-public-scrape.mjs';
import {V2Gateway} from '../src/v2.mjs';

const source='https://source.gov/catalog/';
const html=`<!doctype html><html lang="en"><head><title>  Fixture Catalog </title>
<meta name="description" content="Synthetic &amp; safe"></head><body>
<nav><a href="/nav">Site nav</a></nav>
<main><h1>Items</h1><script>dangerous()</script><p onclick="dangerous()">See <a href="./alpha">Alpha</a> and <a href="./alpha">it again</a>.</p>
<ul><li>First</li><li>Second</li></ul>
<table><thead><tr><th>Item</th><th>Count</th></tr></thead><tbody><tr><td>Alpha</td><td>2</td></tr></tbody></table>
<a href="java&#x73;cript:dangerous()">Bad URL</a><img src="data:text/html,ignore" onerror="dangerous()"><iframe src="https://never-resolved.gov"></iframe>
<p hidden>Hidden copy</p></main><footer>Footer copy</footer></body></html>`;

test('Scrape formats use retained DOM and safely convert main or full content',()=>{
 const capture={text:html,final_url:source,status:200,content_type:'text/html',headers:{'content-type':'text/html; charset=utf-8','content-language':'fr'}};
 const data=scrapeDocument({url:source,formats:['markdown','html','rawHtml','links'],onlyMainContent:true},capture);
 assert.equal(data.rawHtml,html);
 assert.deepEqual(data.metadata,{sourceURL:source,url:source,statusCode:200,contentType:'text/html; charset=utf-8',title:'Fixture Catalog',description:'Synthetic & safe',language:'en'});
 assert.deepEqual(data.links,['https://source.gov/catalog/alpha']);
 assert.match(data.markdown,/# Items/);
 assert.match(data.markdown,/\[Alpha\]\(https:\/\/source\.gov\/catalog\/alpha\)/);
 assert.match(data.markdown,/- +First\n- +Second/);
 assert.match(data.markdown,/\| Item \| Count \|\n\| --- \| --- \|\n\| Alpha \| 2 \|/);
 assert.doesNotMatch(data.html,/script|onclick|onerror|javascript|iframe|data:text|Hidden copy|Footer copy|Site nav/i);
 assert.match(data.html,/<table>/);
 const all=scrapeDocument({url:source,formats:['links','html'],onlyMainContent:false},capture);
 assert.deepEqual(all.links,['https://source.gov/nav','https://source.gov/catalog/alpha']);
 assert.match(all.html,/Site nav/);
 assert.match(all.html,/Footer copy/);
 assert.equal(all.markdown,undefined);
 assert.throws(()=>scrapeDocument({url:source,formats:['markdown'],onlyMainContent:true},
  {...capture,text:'<div>'.repeat(200)+'Too deep'+'</div>'.repeat(200)}),{code:'scrape_content_limit'});
});

test('Scrape requires the managed fetch write scope only at the exact POST route',()=>{
 assert.equal(controlKeyScope('POST','/v2/scrape'),'fetch:write');
 assert.equal(controlKeyScope('POST','/v2/scrape?fixture=1'),'fetch:write');
 assert.equal(controlKeyScope('GET','/v2/scrape'),null);
 assert.equal(controlKeyScope('POST','/v2/scrape/a'),null);
 assert.equal(controlKeyScope('POST','/v2/render'),'fetch:write');
 assert.equal(controlKeyScope('GET','/v2/render/fixture'),'fetch:read');
});

function artifact(kind,url,markup,extra){
 const bytes=Buffer.from(markup);
 return {kind,url,status:200,method:'GET',captured_at:new Date().toISOString(),raw_headers:null,
  headers:{'content-type':'text/html; charset=utf-8'},content_encoding:null,encoded_body_base64:null,encoded_sha256:null,
  original_encoded_available:false,encoded_bytes:null,encoded_size_basis:null,decoded_body_base64:bytes.toString('base64'),
  decoded_sha256:sha(bytes),decoded_bytes:bytes.length,tunnel_bytes:null,provider_status:null,decoding_error:null,...extra};
}

test('Scrape API keeps project policy, ledger, encrypted capture and original-key recovery',{skip:!process.env.TEST_DATABASE_URL,timeout:30000},async t=>{
 const url=new URL(process.env.TEST_DATABASE_URL);
 assert.match(decodeURIComponent(url.pathname),/^\/gateway_test_[A-Za-z0-9_]+$/);
 const admin=new pg.Pool({connectionString:url.href,max:1});
 const schema='scrape_fixture_'+randomUUID().replaceAll('-','');
 const root=await mkdtemp(join(tmpdir(),'fetchx-scrape-fixture-'));
 let app,store,release;
 t.after(async()=>{
  release?.();await app?.close();await store?.close();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();
  await rm(root,{recursive:true,force:true});
 });
 await admin.query(`CREATE SCHEMA ${schema}`);
 url.searchParams.set('options',`-csearch_path=${schema}`);
 store=new Store(url.href);
 await store.init();
 const access_profile={id:'fixture-scrape',version:1},proxy={class:'direct',country:null};
 const profile={...access_profile,origins:['https://source.gov'],paths:['^/catalog/'],methods:['GET'],headers:['accept'],
  proxy_classes:['direct'],countries:[],limits:{timeout_ms:5000,min_interval_ms:0},browser_probe:{enabled:true,settle_ms:120}};
 const config={artifactDir:root,artifactKey:'23'.repeat(32),maxDailyFallbackCredits:0,proxies:[],projects:{
  owner:{profiles:[],v2_access_profiles:['fixture-scrape@1'],tokenHash:sha('fixture-owner')},
  foreign:{profiles:[],v2_access_profiles:[],tokenHash:sha('fixture-foreign')}
 },v2:{accessProfiles:{'fixture-scrape@1':profile},scrape:{projects:{owner:{access_profile,proxy,max_estimated_micro_usd:0}}}}};
 const gateway=new Gateway({store,config,profiles:{},resolve:async()=>[{address:'93.184.216.34',family:4}]});
 gateway.controlIdentity={
  authenticateKey:async token=>({project:'owner',key_id:'scoped-key',scopes:token==='fxk_fixture_reader'?['fetch:read']:['fetch:write']}),
  isCredential:async()=>false
 };
 let relay,runs=0,mode='success',notify;
 const deadlines=[],settles=[];
 gateway.v2=new V2Gateway(gateway,{
  browserRuntime:async()=>({available:true,runtime:{synthetic:true}}),
  relayFactory:async options=>{
   relay=options;
   assert.equal(relay.proxy,null);
   return {url:'http://127.0.0.1:1',bytes:512,meter_complete:true,connections:1,close:async()=>{}};
  },
  browserRunner:async(input,hooks)=>{
   runs++;
   deadlines.push(input.timeout_ms);
   settles.push(input.policy.settle_ms);
   const request={url:input.url,method:'GET',headers:{accept:'text/html'},body_base64:null,resource_type:'document',redirect_depth:0,redirected_from:null};
   await hooks.admit(request);
   await relay.beforeConnect(relay.pinnedDestinations.get('source.gov').destination);
   if(mode==='running')await new Promise(resolve=>{release=resolve;notify();});
   if(mode==='unknown')throw Error('private fixture stack');
   await hooks.artifact(artifact('browser_response',input.url,'<main>Native response marker</main>',{request,main_document:true}));
   await hooks.artifact(artifact('rendered_dom',input.url,html,{generated:true}));
   return {status:200,final_url:input.url,capture_complete:true,counts_complete:true};
  }
 });
 app=server(gateway);
 const post=(payload,{key,token='fixture-owner',path='/v2/scrape'}={})=>app.inject({
  method:'POST',url:path,payload,headers:{...(token?{authorization:'Bearer '+token}:{}),...(key===undefined?{}:{'x-idempotency-key':key})}
 });
 const basic={url:source};
 assert.equal((await post(basic,{token:null})).json().code,'unauthorized');
 assert.equal((await post(basic,{token:'fxk_fixture_reader'})).json().code,'api_key_scope_forbidden');
 assert.equal((await post(basic,{token:'fixture-foreign'})).json().code,'scrape_unavailable');
 assert.equal((await post({...basic,provider:'synthetic'})).json().code,'request_invalid');
 const pythonSDKDefaults={mobile:false,removeBase64Images:true,fastMode:false,blockAds:true,maxAge:14400000,storeInCache:true};
 for(const [field,value] of Object.entries(pythonSDKDefaults)){
  const unsupported=typeof value==='boolean'?!value:0;
  assert.equal((await post({...basic,...pythonSDKDefaults,[field]:unsupported})).json().code,'request_invalid',field);
 }
 assert.equal((await post({...basic,formats:['screenshot']})).json().code,'scrape_formats_unsupported');
 assert.equal((await post({...basic,timeout:999})).json().code,'scrape_timeout_invalid');
 assert.equal((await post({...basic,waitFor:121})).json().code,'browser_wait_ceiling_rejected');
 assert.equal((await post({url:'https://outside.gov/catalog/'})).json().code,'destination_rejected');
 assert.equal((await post({url:'https://source.gov/catalog/../'})).json().code,'destination_rejected');
 assert.equal((await post(basic,{key:'comma,invalid'})).json().code,'idempotency_key_required');
 assert.equal(runs,0);

 const key='shared:same-key',options={...basic,formats:['rawHtml','links','markdown'],waitFor:12,timeout:1000,origin:'python-sdk@fixture'};
 mode='running';
 const started=new Promise(resolve=>{notify=resolve;});
 const pending=post(options,{key,token:'fxk_fixture_writer'});
 await Promise.race([started,pending.then(reply=>assert.fail(reply.body))]);
 const repeated=await post({...options,formats:[{type:'markdown'},'links','rawHtml'],origin:'js-sdk@fixture',integration:'fixture'},{key});
 assert.equal(repeated.statusCode,409,repeated.body);
 assert.equal(repeated.json().code,'scrape_running');
 assert.equal(repeated.headers['x-idempotency-key'],key);
 assert.equal((await post({...options,timeout:1001},{key})).json().code,'idempotency_conflict');
 release();
 const first=await pending;
 assert.equal(first.statusCode,200,first.body);
 assert.equal(first.headers['x-idempotency-key'],key);
 assert.equal(first.json().data.rawHtml,html);
 assert.doesNotMatch(first.json().data.markdown,/Native response marker/);
 assert.deepEqual(Object.keys(first.json()).sort(),['data','success']);
 assert.equal(settles[0],12);
 assert.ok(deadlines[0]>0&&deadlines[0]<=1000);
 mode='success';
 const generated=await post({...basic,timeout:300000});
 assert.equal(generated.statusCode,200,generated.body);
 assert.match(generated.headers['x-idempotency-key'],/^[a-f0-9-]{36}$/);
 assert.deepEqual(Object.keys(generated.json().data).sort(),['markdown','metadata']);
 assert.ok(deadlines[1]>0&&deadlines[1]<=5000);
 assert.equal(settles[1],0);
 assert.deepEqual((await post({url:'https://SOURCE.GOV:443/catalog/',timeout:300000,waitFor:0,onlyMainContent:true},
  {key:generated.headers['x-idempotency-key']})).json(),generated.json());
 // Firecrawl Python 4.55.0 serializes these fields even when the caller only sets formats.
 const pythonSDK=await post({...basic,formats:['markdown','html','links'],onlyMainContent:true,...pythonSDKDefaults,origin:'python-sdk@4.55.0'});
 assert.equal(pythonSDK.statusCode,200,pythonSDK.body);
 assert.deepEqual(Object.keys(pythonSDK.json().data).sort(),['html','links','markdown','metadata']);
 assert.deepEqual((await post({...basic,formats:['markdown','html','links']},
  {key:pythonSDK.headers['x-idempotency-key']})).json(),pythonSDK.json());
 const nativeRender=await post({idempotency_key:key,access_profile,url:source,proxy},{key,path:'/v2/render'});
 assert.equal(nativeRender.json().success,true,nativeRender.body);
 assert.equal(nativeRender.json().data.text,html);
 assert.equal(runs,4);

 mode='unknown';
 const uncertain=await post(basic,{key:'unknown'});
 assert.equal(uncertain.statusCode,409,uncertain.body);
 assert.equal(uncertain.json().code,'scrape_outcome_unknown');
 assert.doesNotMatch(uncertain.body,/private fixture/);
 delete config.v2.scrape.projects.owner;
 assert.deepEqual((await post(options,{key})).json(),first.json());
 assert.deepEqual((await post(basic,{key:'unknown'})).json(),uncertain.json());
 assert.equal((await post({...basic,onlyMainContent:false},{key:'unknown'})).json().code,'idempotency_conflict');
 assert.equal((await post(basic,{key})).json().code,'idempotency_conflict');
 assert.equal((await post(options,{key,token:'fixture-foreign'})).json().code,'scrape_unavailable');
 assert.equal(runs,5);

 const operations=(await store.pool.query('SELECT o.key,o.key_id,o.state,l.state AS ledger_state FROM v2_operations o JOIN v2_ledger l ON l.operation=o.id ORDER BY o.created_at')).rows;
 assert.deepEqual(operations.map(o=>o.key.split('.').slice(0,2).join('.')),['public-scrape.o','public-scrape.o','public-scrape.o','public-render.o','public-scrape.o']);
 assert.equal(operations[0].key_id,'owner');
 assert.equal(operations[4].ledger_state,'unknown');
 const bodies=(await store.pool.query('SELECT body FROM v2_artifacts')).rows;
 assert.equal(bodies.length,8);
 assert.ok(bodies.every(({body})=>!body.includes(Buffer.from('Fixture Catalog'))));
});
