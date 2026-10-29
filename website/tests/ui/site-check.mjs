import {chromium} from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const base=process.env.TEST_BASE_URL||'http://127.0.0.1:4328';
const out=process.env.TEST_OUTPUT_DIR||'../../../outputs/launch-review';
await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
const page=await context.newPage();
const errors=[],requests=[],checks=[],accessibility=[],layouts=[],links=new Set(),metadata=[];
page.on('pageerror',error=>errors.push(error.message));
page.on('console',message=>{if(message.type()==='error')errors.push(message.text().slice(0,300));});
page.on('request',request=>{if(!request.url().startsWith(base)&&!request.url().startsWith('data:')&&!request.url().startsWith('blob:'))requests.push(request.url());});
for(const route of ['/','/samples','/pricing','/pilot','/developers','/privacy','/terms']){
 const response=await page.goto(base+route);assert.equal(response.status(),200);
 await page.evaluate(()=>document.fonts.ready);
 assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
 assert.equal(await page.locator('script:not([src]):not([type="application/json"]):not([type="application/ld+json"])').count(),0,'Executable scripts must stay external for the deployed CSP');
 metadata.push({route,title:await page.title(),description:await page.locator('meta[name="description"]').getAttribute('content'),canonical:await page.locator('link[rel="canonical"]').getAttribute('href'),robots:await page.locator('meta[name="robots"]').getAttribute('content')});
 for(const href of await page.locator('a[href]').evaluateAll(anchors=>anchors.map(a=>a.getAttribute('href'))))if(href.startsWith('/'))links.add(href.split('#')[0]);
 for(const width of [360,768,1024,1440]){
  await page.setViewportSize({width,height:1000});
  const overflow=await page.evaluate(()=>({viewport:innerWidth,scroll:document.documentElement.scrollWidth}));
  assert.ok(overflow.scroll<=width,`${route} overflows at ${width}: ${overflow.scroll}`);layouts.push({route,width,overflow:false});
  if(width===360||width===1440){await page.screenshot({path:`${out}/${route==='/'?'home':route.slice(1)}-${width}.png`,fullPage:true,animations:'disabled'});}
 }
 const audit=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
 accessibility.push({route,violations:audit.violations.map(v=>({id:v.id,impact:v.impact,description:v.description,nodes:v.nodes.map(n=>({html:n.html,summary:n.failureSummary}))}))});
}
assert.equal(new Set(metadata.map(m=>m.title)).size,7,'Each marketing page needs a unique title');assert.equal(new Set(metadata.map(m=>m.description)).size,7,'Each marketing page needs a unique description');
for(const m of metadata)assert.equal(m.canonical,'https://fetchx.ai'+(m.route==='/'?'/':m.route));
for(const href of links){const response=await page.request.get(base+href);assert.ok(response.ok(),`${href} returned ${response.status()}`);}
checks.push('Seven pages, unique metadata, canonical URLs and internal links');
await page.goto(base+'/samples');
for(const category of ['Commerce','Property','Logistics']){
 await page.getByRole('tab',{name:category,exact:true}).click();
 const table=await page.locator('.sample-table tbody tr').evaluateAll(rows=>rows.map(row=>[...row.querySelectorAll('td')].map(cell=>cell.textContent)));
 await page.getByRole('button',{name:'JSON',exact:true}).click();
 const records=JSON.parse(await page.locator('.sample-json code').textContent());
 assert.deepEqual(records.map(r=>Object.values(r).map(String)),table);
 const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'Download sample CSV',exact:true}).click();
 const download=await downloadPromise;const csv=await fs.readFile(await download.path(),'utf8');
 assert.equal(csv.trim().split('\r\n').length,records.length+1);for(const row of table)for(const value of row)assert.ok(csv.includes(value.replaceAll('"','""')));
 await page.getByRole('button',{name:'Table',exact:true}).click();checks.push(category+': table, JSON and CSV parity');
}
await page.getByRole('tab',{name:'Commerce',exact:true}).focus();await page.keyboard.press('ArrowRight');assert.equal(await page.getByRole('tab',{name:'Property',exact:true}).getAttribute('aria-selected'),'true');
checks.push('Sample tabs support keyboard navigation');
await page.setViewportSize({width:360,height:900});await page.goto(base+'/');
await page.keyboard.press('Tab');assert.equal(await page.locator('.skip-link').evaluate(el=>el===document.activeElement),true);
const focus=await page.locator('.skip-link').evaluate(el=>getComputedStyle(el).outlineStyle);assert.notEqual(focus,'none');
await page.getByRole('button',{name:'Open navigation',exact:true}).click();assert.equal(await page.locator('#navigation').isVisible(),true);await page.keyboard.press('Escape');assert.equal(await page.locator('#navigation').isVisible(),false);
await page.getByRole('button',{name:'Pause animation',exact:true}).first().click();assert.ok(await page.locator('html').evaluate(e=>e.classList.contains('motion-paused')));
await page.getByRole('button',{name:'Play animation',exact:true}).first().click();assert.ok(await page.locator('html').evaluate(e=>!e.classList.contains('motion-paused')));
await page.emulateMedia({reducedMotion:'reduce'});await page.reload();assert.equal(await page.evaluate(()=>document.getAnimations().filter(a=>a.playState==='running').length),0);
checks.push('Mobile navigation, skip link, visible focus, pause controls and reduced motion');
assert.equal(requests.length,0,'Marketing pages and samples made external requests');assert.equal(errors.length,0);
await fs.writeFile(out+'/site-checks.json',JSON.stringify({checks,layouts,accessibility,metadata,errors,externalRequests:requests},null,2));
console.log(JSON.stringify({checks,layoutChecks:layouts.length,accessibility:accessibility.map(a=>({route:a.route,violations:a.violations})),errors,externalRequests:requests}));
await browser.close();
if(accessibility.some(a=>a.violations.length))process.exitCode=1;
