// One bounded capture, fresh process/profile. Only reviewed navigation; no caller JS.
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {checkedURL,checkedHeaders} from './policy.mjs';
import {recipeInput,runRecipe,extractRecipe} from './browser-recipes.mjs';
import {captchaHandler,captchaObservation} from './captcha-browser.mjs';
let x,browser,context,page,response,captcha,phase='startup';
let sequence=0;const pending=new Map();
process.on('message',message=>{const task=pending.get(message?.id);if(!task)return;pending.delete(message.id);clearTimeout(task.timer);message.error?task.reject(Object.assign(Error(),{code:message.error})):task.resolve(message.result);});
function parentRequest(kind,data){return new Promise((resolve,reject)=>{if(!process.send)return reject(Object.assign(Error(),{code:'captcha_solver_unavailable'}));const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Object.assign(Error(),{code:'captcha_ipc_timeout'}));},150000);pending.set(id,{resolve,reject,timer});process.send({id,kind,data},error=>{if(error){clearTimeout(timer);pending.delete(id);reject(Object.assign(Error(),{code:'captcha_ipc_unavailable'}));}});});}
const input=await new Promise((r,j)=>{let b='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>{b+=s;if(b.length>2e6)j(Error());});process.stdin.on('end',()=>{try{r(JSON.parse(b));}catch{j(Error());}});});x=input;
for(const method of ['log','warn','info','debug','error'])console[method]=()=>{};
let result;const progress={actionsStarted:false,completed:0,step:null};
try{
 const recipeRequest=recipeInput(x.recipeInput,x.profile),recipe=recipeRequest?x.profile.browserRecipes[recipeRequest.recipe]:null;
 const tier=x.browser;
 if(createHash('sha256').update(await readFile(tier.executablePath)).digest('hex')!==tier.sha256)throw Object.assign(Error(),{code:'browser_build_mismatch'});
 process.env.CLOAKBROWSER_BINARY_PATH=tier.executablePath;process.env.CLOAKBROWSER_AUTO_UPDATE='false';
 process.env.CLOAKBROWSER_LICENSE_KEY='';process.env.CLOAKBROWSER_CACHE_DIR=x.cacheDir;
 const {launch}=await import('cloakbrowser');
 browser=await launch({licenseKey:tier.licenseKey,headless:true,geoip:false,humanize:true,browserVersion:tier.version,
  proxy:{server:x.relay},chromiumSandbox:true,launchOptions:{chromiumSandbox:true,timeout:20000},
  args:['--fingerprint-platform=linux','--proxy-bypass-list=<-loopback>','--disable-quic','--disable-background-networking','--force-webrtc-ip-handling-policy=disable_non_proxied_udp','--license-through-proxy']});
 context=await browser.newContext({serviceWorkers:'block',acceptDownloads:false,locale:x.profile.locale??'en-US',timezoneId:x.profile.timezone??'UTC',storageState:x.storageState??undefined});
 await context.routeWebSocket('**/*',ws=>ws.close());
 let requests=0,blocked=0;
 await context.route('**/*',async route=>{
  try{
   const request=route.request();
   if(++requests>(x.profile.maxBrowserRequests??50)||['image','media','font'].includes(request.resourceType()))throw Error();
   const u=await checkedURL(request.url(),x.profile);
   if(!x.profile.methods.includes(request.method()))throw Error();
   if((request.postDataBuffer()?.length??0)>x.profile.maxInputBytes)throw Error();
   // Gateway credentials and caller headers apply only to the requested origin.
   const supplied=u.origin===new URL(x.url).origin?x.headers:{};
   checkedHeaders(supplied,x.profile,u,request.method());
   await route.continue({headers:{...request.headers(),...supplied}});
  }catch{blocked++;await route.abort('blockedbyclient').catch(()=>{});}
 });
 page=await context.newPage();phase='navigation';page.setDefaultTimeout(x.profile.browserWaitMs??15000);
 page.on('response',r=>{if(r.request().isNavigationRequest()&&r.frame()===page.mainFrame())response=r;});
 response=await page.goto(x.url,{waitUntil:'domcontentloaded',timeout:30000});
 captcha=captchaHandler(page,x.profile,progress,{solve:data=>parentRequest('captcha_solve',data),report:data=>parentRequest('captcha_report',data),status:()=>response?.status()??null});
 phase='captcha';await captcha.check();
 if(recipe){phase='actions';await runRecipe(page,recipe,recipeRequest.values,progress,{status:response?.status()??null,onCheckpoint:options=>captcha.check(options)});}
 phase='readiness';
 if(x.profile.readySelector){try{await page.locator(x.profile.readySelector).waitFor({state:'visible'});}catch(e){if(!await captcha.check())throw e;await page.locator(x.profile.readySelector).waitFor({state:'visible'});}}
 await captcha.clear();
 const html=captcha.redact(await page.content()),body=Buffer.from(html);
 const extracted=recipe?await extractRecipe(page,recipe):undefined;
 const screenshot=recipe?.screenshot?await (recipe.screenshot==='viewport'?page:page.locator(recipe.screenshot)).screenshot({type:'png',timeout:10000}):null;
 if(body.length+(screenshot?.length??0)+Buffer.byteLength(JSON.stringify(extracted??{}))>x.profile.maxResponseBytes)throw Object.assign(Error(),{code:'response_too_large'});
 const observation=await captchaObservation(page,captcha,x.profile,response?.status());
 result={captcha:observation,receivedBytes:body.length+(screenshot?.length??0)+Buffer.byteLength(JSON.stringify(extracted??{})),actionsStarted:progress.actionsStarted,actionsCompleted:progress.completed,extracted,screenshot_base64:screenshot?.toString('base64'),status:response?.status()??null,headers:{'content-type':'text/html; charset=utf-8'},cookies:[],body_base64:body.toString('base64'),storageState:await context.storageState(),browserVersion:tier.version,browserRequests:requests,blockedRequests:blocked};
}catch(e){
 await captcha?.clear();
 let partial='';try{partial=await page?.content()??'';}catch{}
 if(Buffer.byteLength(partial)>x.profile?.maxResponseBytes)partial='';
 result={captcha:await captchaObservation(page,captcha,x.profile,response?.status()),actionsStarted:progress.actionsStarted,actionsCompleted:progress.completed,actionStep:progress.step,status:response?.status()??null,browserVersion:x.browser?.version,browserPhase:phase,browserFailureCode:/net::(ERR_[A-Z_]+)/.exec(e.message??'')?.[1]??(e.name==='TimeoutError'?'TIMEOUT':'CAPTURE_ERROR'),error:e.code?.startsWith('captcha_')?e.code:['browser_build_mismatch','response_too_large','browser_extraction_limit','source_denied','source_challenge'].includes(e.code)?e.code:!browser?'browser_launch_failed':'browser_capture_failed',body_base64:Buffer.from(captcha?captcha.redact(partial):partial).toString('base64'),headers:partial?{'content-type':'text/html'}:{},cookies:[]};}
finally{await context?.close().catch(()=>{});await browser?.close().catch(()=>{});}
const output=JSON.stringify(result);process.stdout.write(captcha?captcha.redact(output):output);
for(const task of pending.values())clearTimeout(task.timer);if(process.connected)process.disconnect();
