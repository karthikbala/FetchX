import test from 'node:test';
import assert from 'node:assert/strict';
import {detectCaptcha,solvePageCaptcha} from '../src/captcha-generic.mjs';

// Real Chromium against synthetic pages served by page.route; no network.
const executable=process.env.BROWSER_TEST_EXECUTABLE;
const KEY='0x4AAAAAAAsyntheticKey01';

async function withPage(pages,run){
 const {chromium}=await import('playwright-core');
 const browser=await chromium.launch({executablePath:executable,headless:true});
 try{
  const page=await browser.newPage();
  await page.route('https://source.test/**',route=>{
   const url=new URL(route.request().url()),body=pages[url.pathname];
   if(body===undefined)return route.fulfill({status:404,body:'missing'});
   return route.fulfill({status:200,contentType:'text/html',body:typeof body==='function'?body(url):body});
  });
  await run(page);
 }finally{await browser.close();}
}

test('generic CAPTCHA: Turnstile form is solved once through the parent hook and the page moves on',{skip:!executable},async()=>{
 const challenge=`<form action="/done" method="GET"><div class="cf-turnstile" data-sitekey="${KEY}"></div><input type="hidden" name="cf-turnstile-response"></form>`;
 await withPage({'/page':challenge,'/done':url=>`<main>data ok ${url.searchParams.get('cf-turnstile-response')?.length}</main>`},async page=>{
  await page.goto('https://source.test/page');
  assert.deepEqual(await detectCaptcha(page),{type:'turnstile',site_key:KEY,invisible:false,callback:null});
  const calls=[];
  const summary=await solvePageCaptcha(page,{captcha:async data=>{calls.push(data);return {ok:true,token:'t'.repeat(40)};}},{deadline:Date.now()+30000});
  assert.equal(calls.length,1);assert.equal(calls[0].website_url,'https://source.test/page');assert.equal(calls[0].site_key,KEY);assert.match(calls[0].user_agent,/Mozilla/);
  assert.deepEqual(summary,{type:'turnstile',outcome:'passed',submitted_via:'form'});
  assert.match(await page.content(),/data ok 40/);
 });
});

test('generic CAPTCHA: reCAPTCHA v2 callback widgets get the token through their declared callback',{skip:!executable},async()=>{
 const page=`<div class="g-recaptcha" data-sitekey="${KEY}" data-callback="onSolved"></div><textarea name="g-recaptcha-response"></textarea>
  <script>window.onSolved=t=>{document.body.innerHTML='<main>unlocked '+t.length+'</main>';};</script>`;
 await withPage({'/page':page},async p=>{
  await p.goto('https://source.test/page');
  const summary=await solvePageCaptcha(p,{captcha:async()=>({ok:true,token:'r'.repeat(30)})},{deadline:Date.now()+30000});
  assert.equal(summary.submitted_via,'callback');assert.equal(summary.outcome,'passed');
  assert.match(await p.content(),/unlocked 30/);
 });
});

test('generic CAPTCHA: pages without a supported widget, bad site keys and solver failures never apply anything',{skip:!executable},async()=>{
 await withPage({'/plain':'<main>no challenge</main>','/bad':'<div class="cf-turnstile" data-sitekey="<script>"></div>','/fail':`<div class="cf-turnstile" data-sitekey="${KEY}"></div><input name="cf-turnstile-response">`},async page=>{
  let calls=0;const hooks={captcha:async()=>{calls++;throw Object.assign(new Error(),{code:'captcha_budget_exhausted'});}};
  await page.goto('https://source.test/plain');assert.equal(await solvePageCaptcha(page,hooks,{deadline:Date.now()+30000}),null);
  await page.goto('https://source.test/bad');assert.equal(await solvePageCaptcha(page,hooks,{deadline:Date.now()+30000}),null);
  assert.equal(calls,0);
  await page.goto('https://source.test/fail');
  assert.deepEqual(await solvePageCaptcha(page,hooks,{deadline:Date.now()+30000}),{type:'turnstile',outcome:'captcha_budget_exhausted'});
  assert.equal(await page.inputValue('input[name="cf-turnstile-response"]'),'');
  // Not enough time left: report instead of starting a paid solve.
  assert.deepEqual(await solvePageCaptcha(page,hooks,{deadline:Date.now()+5000}),{type:'turnstile',outcome:'captcha_deadline'});assert.equal(calls,1);
 });
});

test('v2 generic solver reserves within shared budgets, allows one task per operation and stores no token',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const {Store}=await import('../src/store.mjs');const {CaptchaSolver}=await import('../src/captcha.mjs');const {randomUUID}=await import('node:crypto');
 const store=new Store(process.env.TEST_DATABASE_URL);await store.init();await store.pool.query('TRUNCATE v2_captcha_tasks');
 const config={captcha:{enabled:true,apiKey:'synthetic-key',maxTaskMicroUsd:3000,maxDailyMicroUsd:5000,maxTotalMicroUsd:100000,maxTotalTasks:100,timeoutMs:20000},projects:{p:{}}};
 const posts=[];let clock=0;
 const fetchImpl=async(url,{body})=>{const data=JSON.parse(body);posts.push([url.split('/').pop(),data]);
  const value=url.endsWith('createTask')?{errorId:0,taskId:posts.length}:{errorId:0,status:'ready',cost:'0.00145',solution:{token:'x'.repeat(50)}};
  return {ok:true,body:[Buffer.from(JSON.stringify(value))]};};
 const solver=new CaptchaSolver(store,config,{fetchImpl,wait:async()=>{clock+=5000;},now:()=>clock});
 const request=operation=>({project:'p',operation,type:'turnstile',websiteURL:'https://source.test/page?q=private',siteKey:KEY,userAgent:'Mozilla/5.0 test'});
 try{
  const first=randomUUID(),answer=await solver.solveV2(request(first));
  assert.equal(answer.token.length,50);assert.equal(answer.cost_micro_usd,1450);
  assert.equal(posts[0][1].task.type,'TurnstileTaskProxyless');assert.equal(posts[0][1].task.websiteKey,KEY);
  await assert.rejects(solver.solveV2(request(first)),{code:'captcha_already_attempted'});
  const row=(await store.pool.query('SELECT * FROM v2_captcha_tasks WHERE operation=$1',[first])).rows[0];
  assert.equal(row.host,'source.test');assert.equal(row.state,'ready');assert.equal(Number(row.actual_micro_usd),1450);
  assert.ok(!JSON.stringify(row).includes('xxxxxxxxxx')&&!JSON.stringify(row).includes('private'),'no token or URL path stored');
  // Daily budget 5000: 1450 used + 3000 reserved fits once more; 2900 + 3000 is refused before any vendor call.
  await solver.solveV2(request(randomUUID()));
  const before=posts.length;
  await assert.rejects(solver.solveV2(request(randomUUID())),{code:'captcha_budget_exhausted'});assert.equal(posts.length,before);
  for(const bad of [{type:'hcaptcha'},{siteKey:'<script>'},{websiteURL:'http://source.test/'},{userAgent:''}])
   await assert.rejects(solver.solveV2({...request(randomUUID()),...bad}),{code:'captcha_request_invalid'});
  await assert.rejects(new CaptchaSolver(store,{...config,captcha:{...config.captcha,enabled:false}}).solveV2(request(randomUUID())),{code:'captcha_solver_unavailable'});
 }finally{await store.pool.query('TRUNCATE v2_captcha_tasks');await store.close();}
});
