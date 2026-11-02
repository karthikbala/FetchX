import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import {chromium} from '@playwright/test';
import fs from 'node:fs/promises';

const base=process.env.TEST_BASE_URL||'http://127.0.0.1:4331';
const out=process.env.TEST_OUTPUT_DIR||'.local/browser-reports';
await fs.mkdir(out,{recursive:true});
const chrome=await chromeLauncher.launch({chromePath:chromium.executablePath(),chromeFlags:['--headless','--no-sandbox','--disable-dev-shm-usage']});
const scores=[];
try{
 for(const route of ['/','/products/web-scraping-api','/resources']){
  const result=await lighthouse(base+route,{port:chrome.port,output:'json',logLevel:'error',onlyCategories:['performance','accessibility','best-practices']});
  const name=route==='/'?'home':route.slice(1).replaceAll('/','-');
  await fs.writeFile(out+'/lighthouse-'+name+'.json',result.report);
  scores.push({route,mobile:true,performance:Math.round(result.lhr.categories.performance.score*100),accessibility:Math.round(result.lhr.categories.accessibility.score*100),bestPractices:Math.round(result.lhr.categories['best-practices'].score*100),lcp:result.lhr.audits['largest-contentful-paint'].displayValue,cls:result.lhr.audits['cumulative-layout-shift'].displayValue});
 }
}finally{await chrome.kill();}
await fs.writeFile(out+'/performance-summary.json',JSON.stringify(scores,null,2));
console.log(JSON.stringify(scores));
if(scores.some(score=>score.performance<90))process.exitCode=1;
