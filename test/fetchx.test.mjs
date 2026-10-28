import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.mjs';
import {Gateway} from '../src/gateway.mjs';
import {server} from '../src/main.mjs';
import {sha} from '../src/crypto.mjs';
import {recipeInput,validateRecipe,runRecipe,extractRecipe} from '../src/browser-recipes.mjs';
import {redactProviderSecrets} from '../src/transport.mjs';
const recipe={steps:[{action:'fill',selector:'#query',valueFrom:'query'},{action:'click',selector:'#search'},{action:'wait',selector:'#result'}],extract:{result:{selector:'#result'}},screenshot:'viewport'};
const profile={hosts:['source.example'],methods:['GET','POST'],headers:[],country:'US',execution:'browser',maxRequests:4,maxConcurrent:1,maxInputBytes:8192,maxResponseBytes:65536,maxBytes:262144,ttlSeconds:120,minIntervalMs:0,maxAttemptBytes:1000,maxResidentialBytes:4000,browserRecipes:{search:recipe}};
test('browser recipes reject caller code, unknown recipes, selectors and unbounded inputs',()=>{
 assert.deepEqual(recipeInput({recipe:'search',values:{query:'test'}},profile),{recipe:'search',values:{query:'test'}});
 for(const input of [{recipe:'missing'},{recipe:'search',values:{}},{recipe:'search',values:{query:'x',unknown:'y'}},{recipe:'search',values:{query:'x'.repeat(4097)}},{recipe:'search',steps:[]},{recipe:'search',values:{query:{}}}])assert.throws(()=>recipeInput(input,profile));
 assert.throws(()=>recipeInput({recipe:'search',values:{query:'x'}},{...profile,execution:'http'}));
 for(const steps of [[{action:'evaluate',selector:'body',value:'process.exit()'}],[{action:'fill',selector:'input'}],[{action:'press',selector:'input',value:'Control+L'}],Array(21).fill({action:'click',selector:'button'})])assert.throws(()=>validateRecipe({steps}));
});
test('recipe progress marks uncertain actions before execution and omits submitted values',async()=>{
 const progress={actionsStarted:false,completed:0},calls=[];
 const page={locator:selector=>({fill:async value=>calls.push([selector,value]),click:async()=>{throw Error('timeout');}})};
 await assert.rejects(runRecipe(page,recipe,{query:'private query'},progress),/timeout/);
 assert.deepEqual(progress,{actionsStarted:true,completed:1,step:1});assert.equal(JSON.stringify(progress).includes('private'),false);
});
test('extraction bounds and provider-secret redaction include structured fields and browser state',async()=>{
 const page={locator:()=>({count:async()=>101})};await assert.rejects(extractRecipe(page,recipe),/extraction_limit/);
 const r=redactProviderSecrets({headers:{},body:Buffer.from('ok'),extracted:{token:'provider-secret'},screenshot_base64:'image',storageState:{cookies:[]}},['provider-secret']);
 assert.equal(r.error,'sensitive_provider_response');assert.equal(r.extracted,undefined);assert.equal(r.storageState,undefined);assert.equal(r.screenshot_base64,undefined);
});
test('FetchX API isolates projects, replays durably, rejects changed requests and never replays browser actions',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const url=new URL(process.env.TEST_DATABASE_URL);assert.match(url.pathname,/^\/gateway_test_[A-Za-z0-9]+$/);
 const admin=new Store(url.href),schema='fetchx_'+randomUUID().replaceAll('-','');await admin.pool.query('CREATE SCHEMA '+schema);url.searchParams.set('options','-c search_path='+schema);
 const store=new Store(url.href),root=await mkdtemp(join(tmpdir(),'fetchx-test-'));await store.init();
 const provider={enabled:true,username:'provider-user',password:'provider-password',maxTotalBytes:100000,microUsdPerGB:1000000};
 const config={jobs:{enabled:true,maxQueued:5},release:'fetchx-test',defaultRouting:'residential-v1',artifactDir:root,artifactKey:'22'.repeat(32),proxies:[],maxDailyFallbackCredits:0,projects:{a:{profiles:['browser'],tokenHash:sha('a')},b:{profiles:[],tokenHash:sha('b')}},residential:{maxDailyBytes:100000,maxTotalBytes:100000,providers:{evomi:provider,dataimpulse:provider}}};
 let calls=0,blocked=false;const gateway=new Gateway({store,config,profiles:{browser:profile},resolve:async()=>[{address:'93.184.216.34'}],browserTierCheck:async()=>{},transport:{residential:async()=>{calls++;return {status:blocked?403:200,headers:{},body:Buffer.from('result'),wireBytes:20,actionsStarted:true,actionsCompleted:3,extracted:{result:'found'},screenshot_base64:'cG5n'};}}});
 const app=server(gateway),auth={authorization:'Bearer a'},payload={profile:'browser',idempotency_key:'durable',url:'https://source.example/',browser:{recipe:'search',values:{query:'test'}}};
 try{
  assert.equal((await app.inject({method:'POST',url:'/v1/fetch',payload})).statusCode,401);
  const profiles=(await app.inject({url:'/v1/profiles',headers:auth})).json();assert.deepEqual(profiles.profiles[0].recipes,['search']);assert.equal(JSON.stringify(profiles).includes('provider-password'),false);
  const first=await app.inject({method:'POST',url:'/v1/fetch',headers:auth,payload});assert.equal(first.statusCode,200,first.body);const result=first.json();assert.equal(result.extracted.result,'found');assert.equal(result.screenshot.content_type,'image/png');assert.equal(result.fallback_blocked,null);
  assert.deepEqual((await app.inject({method:'POST',url:'/v1/fetch',headers:auth,payload})).json(),result);assert.equal(calls,1);
  assert.deepEqual((await app.inject({url:'/v1/fetch/durable',headers:auth})).json(),result);
  assert.equal((await gateway.read('a',result.workflow)).state,'closed');
  assert.equal((await app.inject({url:'/v1/fetch/durable',headers:{authorization:'Bearer b'}})).statusCode,404);
  assert.equal((await app.inject({method:'POST',url:'/v1/fetch',headers:auth,payload:{...payload,url:'https://source.example/changed'}})).statusCode,409);assert.equal(calls,1);
  blocked=true;const denial=(await app.inject({method:'POST',url:'/v1/fetch',headers:auth,payload:{...payload,idempotency_key:'denial'}})).json();assert.equal(denial.provider,'evomi');assert.equal(denial.fallback_blocked,'browser_actions_not_replayable');assert.equal(calls,2);
  const jobPayload={...payload,idempotency_key:'job-durable'};
  const job=(await app.inject({method:'POST',url:'/v1/jobs',headers:auth,payload:jobPayload})).json();assert.equal(job.state,'queued');assert.equal(calls,2);
  assert.equal((await app.inject({method:'POST',url:'/v1/jobs',headers:auth,payload:jobPayload})).json().id,job.id);
  assert.equal((await app.inject({method:'POST',url:'/v1/jobs',headers:auth,payload:{...jobPayload,url:'https://source.example/changed'}})).statusCode,409);
  assert.equal((await app.inject({url:'/v1/jobs/'+job.id,headers:{authorization:'Bearer b'}})).statusCode,404);
  await app.jobs.recover();assert.equal((await app.jobs.read('a',job.id)).state,'queued');
  blocked=false;await app.jobs.runOne();assert.equal(calls,3);assert.equal((await app.jobs.read('a',job.id)).result.status,200);
  const cancelled=await app.jobs.submit('a',{...payload,idempotency_key:'cancelled'});await app.jobs.cancel('a',cancelled.id);assert.equal(await app.jobs.runOne(),false);
  const interrupted=await app.jobs.submit('a',{...payload,idempotency_key:'interrupted'});await store.pool.query("UPDATE fetch_jobs SET state='running' WHERE id=$1",[interrupted.id]);await app.jobs.recover();assert.equal((await app.jobs.read('a',interrupted.id)).state,'unknown');assert.equal(await app.jobs.runOne(),false);
  await store.pool.query("UPDATE fetch_jobs SET state='running',operation=NULL WHERE id=$1",[job.id]);await app.jobs.recover();assert.equal((await app.jobs.read('a',job.id)).state,'completed');assert.equal(calls,3);
  await store.recover();assert.deepEqual(await gateway.lookup('a',result.workflow,'durable'),result);assert.equal(calls,3);
 }finally{await app.close();await store.close();await admin.pool.query('DROP SCHEMA '+schema+' CASCADE');await admin.close();await rm(root,{recursive:true,force:true});}
});
test('real browser recipe fills, selects, submits, waits, extracts and captures without external traffic',{skip:!process.env.BROWSER_TEST_EXECUTABLE},async()=>{
 const {chromium}=await import('playwright-core');
 const browser=await chromium.launch({executablePath:process.env.BROWSER_TEST_EXECUTABLE,chromiumSandbox:true,args:['--disable-background-networking']});
 try{
  const page=await browser.newPage();await page.route('**/*',r=>r.abort());
  await page.goto('data:text/html,'+encodeURIComponent('<input id="query"><select id="kind"><option value="a">A</option><option value="b">B</option></select><button id="search" onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'#query\').value+document.querySelector(\'#kind\').value">Search</button><div id="result"></div>'),{waitUntil:'domcontentloaded'});
  const r={...recipe,steps:[recipe.steps[0],{action:'select',selector:'#kind',value:'b'},...recipe.steps.slice(1)]},progress={};
  await runRecipe(page,r,{query:'FetchX'},progress);assert.equal(progress.completed,4);assert.deepEqual(await extractRecipe(page,r),{result:'FetchXb'});
  const png=await page.screenshot();assert.equal(png.subarray(1,4).toString(),'PNG');
 }finally{await browser.close();}
});
