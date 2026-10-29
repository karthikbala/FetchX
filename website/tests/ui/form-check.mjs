import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const base=process.env.TEST_BASE_URL||'http://127.0.0.1:4328';
const out=process.env.TEST_OUTPUT_DIR||'../../../outputs/launch-review';
await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true});
const checks=[],errors=[];
async function fillData(page){
 await page.locator('#websites').fill('https://example.com/products');await page.locator('#fields').fill('Title, price, availability, source reference');
 await page.locator('#frequency').selectOption('Weekly');await page.locator('#volume').selectOption('501–5,000 records');
 await page.getByRole('button',{name:'Continue',exact:true}).click();
 await page.locator('#name').fill('Synthetic Tester');await page.locator('#company').fill('Example Company');await page.locator('#email').fill('test@example.com');
}
{
 const page=await browser.newPage();await page.goto(base+'/pilot?plan=scale');
 assert.match(await page.locator('[data-offer]').textContent(),/SCALE/);
 await page.getByRole('button',{name:'Continue',exact:true}).click();assert.equal(await page.locator('[data-step="1"]').isVisible(),true);
 await fillData(page);assert.equal(await page.getByRole('button',{name:'Send pilot request'}).isDisabled(),true);
 assert.match(await page.locator('.verification-status').textContent(),/not open yet/);checks.push('Unconfigured preview stays closed; required fields and offer prefill work');await page.close();
}
for(const scenario of ['success','storage-failure','network-failure','validation-failure']){
 const page=await browser.newPage({viewport:{width:360,height:900}});const submissions=[];let failures=scenario==='success'?0:1;
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/pilot?*',async route=>{const response=await route.fetch();let body=await response.text();body=body.replace(/data-sitekey(?:="")?(?=[\s>])/,'data-sitekey="synthetic-ui-test-key"');await route.fulfill({response,body});});
 await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',async route=>route.fulfill({contentType:'application/javascript',body:`window.turnstile={render(el,options){window.testVerification=options;setTimeout(()=>options.callback('synthetic-token-'+Math.random()),0);return 'test-widget';},reset(){setTimeout(()=>window.testVerification.callback('synthetic-token-'+Math.random()),0);},remove(){}};`}));
 await page.route('**/api/pilot',async route=>{
  submissions.push(route.request().postDataJSON());
  if(failures-->0){
   if(scenario==='network-failure'){await route.abort();return;}
   if(scenario==='validation-failure'){await route.fulfill({status:400,json:{error:'invalid_input',field:'fields',message:'Please check the requested fields.'}});return;}
   await route.fulfill({status:503,json:{error:'storage_unavailable',message:'We could not confirm receipt. Your details are still here. Please retry or email karthik@headrun.ai.'}});return;
  }
  await route.fulfill({status:201,json:{ok:true,reference:'FX-12345678-1234-4123-8123-123456789ABC'}});
 });
 await page.goto(base+'/pilot?plan=managed');await fillData(page);await page.waitForFunction(()=>window.testVerification?.action==='pilot');
 await page.getByRole('button',{name:'Send pilot request'}).click();
 if(scenario!=='success'){
  await page.locator('.form-error').waitFor({state:'visible'});assert.equal(await page.locator('.form-result').isVisible(),false);
  assert.equal(await page.locator('#email').inputValue(),'test@example.com');
  if(scenario==='validation-failure'){assert.equal(await page.locator('[data-step="1"]').isVisible(),true);await page.locator('#fields').fill('Updated title and price');await page.getByRole('button',{name:'Continue',exact:true}).click();}
  await page.getByRole('button',{name:'Send pilot request'}).click();
 }
 await page.locator('.form-result').waitFor({state:'visible'});assert.match(await page.locator('[data-reference]').textContent(),/^FX-/);
 assert.match(await page.locator('[data-followup]').getAttribute('href'),/subject=FetchX/);
 if(submissions.length===2){assert.notEqual(submissions[0].token,submissions[1].token);if(scenario==='validation-failure')assert.notEqual(submissions[0].requestId,submissions[1].requestId);else assert.equal(submissions[0].requestId,submissions[1].requestId);}
 const storage=await page.evaluate(()=>({local:Object.keys(localStorage),session:Object.keys(sessionStorage)}));assert.deepEqual(storage.local,[]);assert.ok(storage.session.every(k=>k==='fetchx-motion'));
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 if(scenario==='success')await page.screenshot({path:out+'/pilot-confirmation-mobile.png',fullPage:true});
 checks.push(`${scenario}: correct confirmation, draft handling and retry identity`);await page.close();
}
assert.equal(errors.length,0);await fs.writeFile(out+'/form-checks.json',JSON.stringify({checks,errors,note:'Synthetic UI transport and Turnstile fixtures. Real email and live Turnstile remain launch checks.'},null,2));console.log(JSON.stringify({checks,errors}));await browser.close();
