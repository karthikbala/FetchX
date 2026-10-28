import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {Gateway} from '../src/gateway.mjs';
import {sha} from '../src/crypto.mjs';
import {CaptchaSolver,microUsd,validateCaptchaProfile,captchaStatus} from '../src/captcha.mjs';
import {captchaHandler,observeCaptcha,captchaObservation} from '../src/captcha-browser.mjs';
import {fetchOnce} from '../src/fetch.mjs';
const spec={type:'recaptcha_v2',websiteURL:'https://source.example/challenge',siteKey:'fixtureSiteKey123',triggerSelector:'#challenge',widgetSelector:'#challenge',responseSelector:'textarea[name="g-recaptcha-response"]',submitSelector:'#submit',successSelector:'#ok'};
const profile={hosts:['source.example','www.google.com'],methods:['GET','POST'],headers:[],country:'US',execution:'browser',maxRequests:4,maxInputBytes:8192,maxResponseBytes:65536,maxBytes:262144,ttlSeconds:600,minIntervalMs:0,maxAttemptBytes:1000,maxResidentialBytes:4000,captcha:spec};
test('CAPTCHA policy requires reviewed widget, page, fields and supported type; dollars parse exactly',()=>{
 validateCaptchaProfile(profile);assert.equal(microUsd('0.00299'),2990);assert.equal(microUsd('0'),0);
 for(const cost of [0.01,'NaN','1e-3','-1','0.0000001'])assert.throws(()=>microUsd(cost));
 for(const patch of [{type:'hcaptcha'},{websiteURL:'https://unreviewed.example/'},{siteKey:'bad'},{callback:'arbitraryCode'},{successSelector:''}])assert.throws(()=>validateCaptchaProfile({...profile,captcha:{...spec,...patch}}));
});
async function fixture(fn){
 const url=new URL(process.env.TEST_DATABASE_URL);assert.match(url.pathname,/^\/gateway_test_[A-Za-z0-9]+$/);
 const admin=new Store(url.href),schema='captcha_'+randomUUID().replaceAll('-','');await admin.pool.query('CREATE SCHEMA '+schema);url.searchParams.set('options','-c search_path='+schema);
 const store=new Store(url.href),root=await mkdtemp(join(tmpdir(),'fetchx-captcha-test-'));await store.init();
 const provider={enabled:true,username:'fixture-user',password:'fixture-password',maxTotalBytes:100000,microUsdPerGB:1000000};
 const config={release:'captcha-test',defaultRouting:'residential-v1',artifactDir:root,artifactKey:'33'.repeat(32),proxies:[],maxDailyFallbackCredits:0,projects:{a:{profiles:['source'],tokenHash:sha('a')},b:{profiles:[],tokenHash:sha('b')}},captcha:{enabled:true,apiKey:'private-solver-key',maxTaskMicroUsd:10000,maxDailyMicroUsd:30000,maxTotalMicroUsd:30000,maxTotalTasks:3},residential:{maxDailyBytes:100000,maxTotalBytes:100000,providers:{evomi:provider,dataimpulse:provider}}};
 const gateway=new Gateway({store,config,profiles:{source:profile},resolve:async()=>[{address:'93.184.216.34'}],browserTierCheck:async()=>{}});
 let n=0;const make=async()=>{const w=await gateway.workflow('a',{profile:'source',idempotency_key:'w'+(++n)}),operation=randomUUID(),attempt=randomUUID();await store.pool.query("INSERT INTO operations(id,workflow,key,input,state) VALUES($1,$2,'capture',$3,'running')",[operation,w.id,gateway.sealer.seal('{}')]);await store.pool.query("INSERT INTO attempts(id,operation,workflow,provider,state) VALUES($1,$2,$3,'evomi','sent')",[attempt,operation,w.id]);return {w:await gateway.owned('a',w.id),attempt,operation};};
 try{await fn({store,gateway,config,make});}finally{await store.close();await admin.pool.query('DROP SCHEMA '+schema+' CASCADE');await admin.close();await rm(root,{recursive:true,force:true});}
}
const candidate={type:spec.type,websiteURL:spec.websiteURL,siteKey:spec.siteKey,userAgent:'Fixture browser'};
const reply=data=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
const token='private-solved-token-0123456789';
test('solver reservations settle once, isolate projects and do not persist key or token',{skip:!process.env.TEST_DATABASE_URL},async()=>fixture(async({store,config,make})=>{
 const f=await make(),calls=[];let clock=0;
 const solver=new CaptchaSolver(store,config,{now:()=>clock,wait:async()=>{clock+=5000;},fetchImpl:async(url,request)=>{calls.push(url);const body=JSON.parse(request.body);assert.equal(body.clientKey,config.captcha.apiKey);if(url.endsWith('createTask')){assert.equal(body.task.type,'RecaptchaV2TaskProxyless');assert.equal(body.task.proxyPassword,undefined);return reply({errorId:0,taskId:123});}return reply({errorId:0,status:'ready',cost:'0.00299',solution:{gRecaptchaResponse:token}});}});
 const solved=await solver.solve(f.w,f.attempt,f.operation,candidate);assert.equal(solved.token,token);assert.equal(solved.cost_micro_usd,2990);await solver.report(f.w,f.attempt,'verified');
 await assert.rejects(solver.solve(f.w,f.attempt,f.operation,candidate),/already_attempted/);assert.equal(calls.length,2);
 const rows=(await store.pool.query('SELECT * FROM captcha_tasks')).rows;assert.equal(rows[0].verification,'verified');assert.equal(rows[0].actual_micro_usd,'2990');assert.equal(JSON.stringify(rows).includes(token),false);assert.equal(JSON.stringify(rows).includes(config.captcha.apiKey),false);
 assert.equal((await captchaStatus(store.pool,config,'b')).usage.length,0);
}));
test('uncertain create retains spend, concurrent budget admission is atomic, and restart never re-creates',{skip:!process.env.TEST_DATABASE_URL},async()=>fixture(async({store,config,make})=>{
 config.captcha.maxTotalTasks=1;const a=await make(),b=await make();let creates=0;
 const solver=new CaptchaSolver(store,config,{fetchImpl:async()=>{creates++;throw Error('contains private credentials');}});
 const results=await Promise.allSettled([solver.solve(a.w,a.attempt,a.operation,candidate),solver.solve(b.w,b.attempt,b.operation,candidate)]);assert.ok(results.every(r=>r.status==='rejected'));assert.equal(creates,1);
 const row=(await store.pool.query('SELECT * FROM captcha_tasks')).rows[0];assert.equal(row.state,'unknown');assert.equal(row.actual_micro_usd,null);assert.equal(row.error,'captcha_provider_outcome_unknown');assert.equal(row.reserved_micro_usd,'10000');
 await store.recover();assert.equal(creates,1);await assert.rejects(solver.solve(a.w,a.attempt,a.operation,candidate));assert.equal(creates,1);
}));
test('timeout keeps provider task ID and read-only reconciliation never applies an old token',{skip:!process.env.TEST_DATABASE_URL},async()=>fixture(async({store,config,make})=>{
 config.captcha.timeoutMs=10000;const f=await make();let clock=0,ready=false,creates=0;
 const solver=new CaptchaSolver(store,config,{now:()=>clock,wait:async()=>{clock+=5000;},fetchImpl:async url=>{if(url.endsWith('createTask')){creates++;return reply({errorId:0,taskId:456});}return reply(ready?{errorId:0,status:'ready',cost:'0.00299',solution:{gRecaptchaResponse:token}}:{errorId:0,status:'processing'});}});
 await assert.rejects(solver.solve(f.w,f.attempt,f.operation,candidate),/timeout/);const row=(await store.pool.query('SELECT * FROM captcha_tasks')).rows[0];assert.equal(row.provider_task_id,'456');assert.equal(row.actual_micro_usd,null);
 ready=true;assert.deepEqual(await solver.reconcile(row.id),{state:'reconciled',cost_micro_usd:2990,redispatched:false,solution_applied:false});assert.equal(creates,1);assert.equal((await store.pool.query('SELECT verification FROM captcha_tasks')).rows[0].verification,'not_submitted');
}));
test('source identity mismatch, absent key and synchronous API cannot start paid solving',{skip:!process.env.TEST_DATABASE_URL},async()=>fixture(async({store,config,make,gateway})=>{
 let calls=0;const solver=new CaptchaSolver(store,config,{fetchImpl:async()=>{calls++;throw Error();}}),f=await make();
 await assert.rejects(solver.solve(f.w,f.attempt,f.operation,{...candidate,siteKey:'different'}),/identity_mismatch/);
 config.captcha.apiKey='';await assert.rejects(solver.solve(f.w,f.attempt,f.operation,candidate),/unavailable/);
 await assert.rejects(fetchOnce(gateway,'a',{profile:'source',url:spec.websiteURL,idempotency_key:'sync'}),/async_required/);
 assert.equal(calls,0);assert.equal((await store.pool.query('SELECT count(*) n FROM captcha_tasks')).rows[0].n,'0');
}));
test('actual browser solves a reviewed form in-session, rechecks identity, clears token and skips rate limits',{skip:!process.env.BROWSER_TEST_EXECUTABLE},async()=>{
 const {chromium}=await import('playwright-core');const browser=await chromium.launch({executablePath:process.env.BROWSER_TEST_EXECUTABLE,chromiumSandbox:true,args:['--disable-background-networking']});
 try{
  const context=await browser.newContext(),page=await context.newPage();let submits=0;
  await context.addCookies([{name:'session',value:'same-session',url:spec.websiteURL}]);
  await context.route('**/*',async route=>{
   const u=new URL(route.request().url());if(u.hostname==='www.google.com')return route.fulfill({contentType:'text/html',body:'<body><div role="checkbox" tabindex="0">checkbox</div></body>'});
   if(u.hostname!=='source.example')return route.abort();
   if(u.pathname==='/submit'){assert.ok(route.request().headers().cookie.includes('session=same-session'));assert.equal(route.request().postData(),token);submits++;return route.fulfill({contentType:'application/json',body:'{"accepted":true}'});}
   await route.fulfill({contentType:'text/html',body:`<div id="challenge"><iframe src="https://www.google.com/recaptcha/api2/anchor?k=${spec.siteKey}"></iframe><textarea name="g-recaptcha-response" style="display:none"></textarea></div><button id="submit" onclick="fetch('/submit',{method:'POST',body:document.querySelector('textarea').value}).then(r=>r.json()).then(r=>{if(r.accepted){document.querySelector('#challenge').style.display='none';document.body.insertAdjacentHTML('beforeend','<div id=ok>source accepted</div>')}})">Submit</button>`});
  });
  await page.goto(spec.websiteURL);let solves=0;const reports=[],progress={actionsStarted:false};
  const handler=captchaHandler(page,profile,progress,{status:()=>200,solve:async()=>{solves++;return {token,id:'fixture',provider:'2captcha',cost_micro_usd:2990};},report:async state=>reports.push(state)});
  assert.equal(await handler.check(),true);assert.equal(solves,1);assert.equal(submits,1);assert.deepEqual(reports,['submitted','verified']);assert.equal(handler.summary.outcome,'verified');assert.equal(await page.locator('textarea').inputValue(),'');assert.equal(handler.redact('x'+token),'x[captcha-token-redacted]');assert.equal(progress.actionsStarted,true);
  await page.goto(spec.websiteURL);const changed=captchaHandler(page,profile,{}, {status:()=>200,solve:async()=>{await page.goto('https://source.example/other');return {token};},report:async()=>{}});await assert.rejects(changed.check(),/identity_mismatch/);assert.equal(submits,1);
  await page.goto(spec.websiteURL);const stale=captchaHandler(page,profile,{}, {status:()=>200,solve:async()=>{await page.locator('body').evaluate(el=>el.insertAdjacentHTML('beforeend','<div id=ok>independent result</div>'));return {token};},report:async()=>{}});await assert.rejects(stale.check(),/success_predicate_ambiguous/);assert.equal(submits,1);
  await page.goto(spec.websiteURL);const limited=captchaHandler(page,profile,{}, {status:()=>429,solve:async()=>{throw Error('must not solve');}});assert.equal(await limited.check(),false);assert.equal(limited.summary.outcome,'rate_limited');assert.equal((await observeCaptcha(page,429)).outcome,'rate_limited');
 }finally{await browser.close();}
});

test('over-budget solver receipt holds subsequent tasks and returns no token',{skip:!process.env.TEST_DATABASE_URL},async()=>fixture(async({store,config,make})=>{
 const a=await make(),b=await make();let clock=0,creates=0;
 const solver=new CaptchaSolver(store,config,{now:()=>clock,wait:async()=>{clock+=5000;},fetchImpl:async url=>url.endsWith('createTask')?(creates++,reply({errorId:0,taskId:987})):reply({errorId:0,status:'ready',cost:'0.011',solution:{gRecaptchaResponse:token}})});
 await assert.rejects(solver.solve(a.w,a.attempt,a.operation,candidate),/cost_overrun/);await assert.rejects(solver.solve(b.w,b.attempt,b.operation,candidate),/account_held/);assert.equal(creates,1);
 const row=(await store.pool.query('SELECT * FROM captcha_tasks')).rows[0];assert.equal(row.actual_micro_usd,'11000');assert.equal(row.verification,'not_submitted');
}));
test('standalone Turnstile validates site key and source acceptance in real Chromium',{skip:!process.env.BROWSER_TEST_EXECUTABLE},async()=>{
 const {chromium}=await import('playwright-core'),browser=await chromium.launch({executablePath:process.env.BROWSER_TEST_EXECUTABLE,chromiumSandbox:true,args:['--disable-background-networking']});
 try{
  const page=await browser.newPage(),c={...spec,type:'turnstile',responseSelector:'input[name="cf-turnstile-response"]'};let solves=0;
  await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:`<form><div id="challenge" data-sitekey="${spec.siteKey}">challenge<input type="hidden" name="cf-turnstile-response"></div><button type="button" id="submit" onclick="if(document.querySelector('input').value.length>20){document.querySelector('#challenge').hidden=true;document.body.insertAdjacentHTML('beforeend','<div id=ok>accepted</div>')}">Submit</button></form>`}));
  await page.goto(spec.websiteURL);const options={status:()=>200,solve:async()=>{solves++;return {token,provider:'2captcha',id:'fixture',cost_micro_usd:1450};},report:async()=>{}};
  const wrong=captchaHandler(page,{...profile,captcha:{...c,siteKey:'wrongPublicKey123'}},{},options);await assert.rejects(wrong.check(),/sitekey_mismatch/);assert.equal(solves,0);
  const handler=captchaHandler(page,{...profile,captcha:c},{},options);assert.equal(await handler.check(),true);assert.equal(handler.summary.outcome,'verified');assert.equal(solves,1);assert.equal(await page.locator('input').inputValue(),'');
 }finally{await browser.close();}
});

test('challenge observations survive capture failures and distinguish inactive configured widgets',async()=>{
 const page={content:async()=>'<textarea name="g-recaptcha-response"></textarea>'};
 assert.equal((await captchaObservation(page,null,profile,200)).outcome,'not_required');
 assert.equal((await captchaObservation(page,null,{},429)).outcome,'rate_limited');
 assert.equal((await captchaObservation({content:async()=>'<title>Just a moment</title><script src="/cdn-cgi/challenge-platform/x"></script>'},null,{},403)).observed_type,'cloudflare_managed');
 assert.equal((await captchaObservation(undefined,null,{},429)).outcome,'rate_limited');
});
