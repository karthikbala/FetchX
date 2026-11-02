// Real browser -> Pages proxy -> local native FetchX acceptance. No interception,
// mocked responses, source retries, screenshots, tracing, or secret artifacts.
import {chromium,request as playwrightRequest} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,lstat,realpath} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const repository=fileURLToPath(new URL('../../../',import.meta.url));
const preview=join(repository,'.local/selfservice-preview');
const base=process.env.TEST_BASE_URL||'http://127.0.0.1:4331';
const api='http://127.0.0.1:8789';
const mailbox=resolve(process.env.CONTROL_PREVIEW_MAILBOX||join(preview,'mailbox.jsonl'));
const counts={checks:0,axe_audits:0,axe_violations:0,layout_checks:0,browser_page_errors:0,external_browser_requests:0,bridge_headers_exposed:0,verification_requests:0,project_creations:0,key_creations:0,key_rotations:0,key_revocations:0,source_fetch_posts:0,recovery_reads:0,api_key_reads:0,storage_checks:0};
let stage='preflight',browser,nativeApi;
const accessibility=[];
const failure_metadata={};
const checked=(condition,code)=>{if(!condition)throw Error('control_live_'+code);counts.checks++;};
const loopback=url=>['127.0.0.1','localhost','[::1]'].includes(url.hostname);
const safeJSON=async response=>{try{return await response.json();}catch{throw Error('control_live_response_invalid');}};

async function privateJSON(path){
 const stat=await lstat(path);
 checked(stat.isFile()&&!stat.isSymbolicLink()&&(stat.mode&0o077)===0,'private_preview_file_required');
 checked(stat.size<2*1024*1024,'preview_file_too_large');
 return JSON.parse(await readFile(path,'utf8'));
}
async function preflight(){
 const origin=new URL(base);
 checked(loopback(origin)&&['http:','https:'].includes(origin.protocol)&&origin.origin===base&&!origin.username&&!origin.password,'loopback_website_required');
 // Reproduce the runner's fingerprint using an explicitly supplied disposable
 // URL; no database connection is made by this browser test.
 checked(typeof process.env.CONTROL_PREVIEW_DATABASE_URL==='string','disposable_preview_database_required');
 const database=new URL(process.env.CONTROL_PREVIEW_DATABASE_URL);
 checked(['postgres:','postgresql:'].includes(database.protocol)&&loopback(database)&&/^\/gateway_test_[A-Za-z0-9_]+$/.test(decodeURIComponent(database.pathname))&&!database.search&&!database.hash,'disposable_preview_database_required');
 const directory=await realpath(preview);
 checked(dirname(await realpath(mailbox))===directory,'private_preview_mailbox_required');
 const mailStat=await lstat(mailbox);
 checked(mailStat.isFile()&&!mailStat.isSymbolicLink()&&(mailStat.mode&0o077)===0,'private_preview_mailbox_required');
 const state=await privateJSON(join(preview,'state.json'));
 const identity=JSON.stringify({host:database.hostname,port:database.port||'5432',user:database.username,database:decodeURIComponent(database.pathname.slice(1))});
 checked(state.version===1&&state.mode==='native'&&state.databaseFingerprint===createHash('sha256').update(identity).digest('hex'),'native_disposable_preview_required');
 const config=await privateJSON(join(preview,'gateway.json'));
 checked(config.release==='selfservice-local-native'&&config.artifactKey===state.artifactKey&&Object.keys(config.projects||{}).length===0&&Array.isArray(config.proxies)&&config.proxies.length===0,'generated_native_preview_required');
 checked(config.controlPlane?.enabled===true&&config.controlPlane.allowLoopbackDevelopment===true&&config.controlPlane.sessionSecure===false&&config.controlPlane.apiBaseUrl===api&&config.controlPlane.origins?.includes(base)&&config.controlPlane.bridgeSecret===state.bridgeSecret,'local_control_configuration_required');
 const policy=config.controlPlane.creditPolicy;
 checked(policy?.reviewed===true&&policy.maxEstimatedMicroUsdPerOperation===0&&Object.keys(policy.weights||{}).length===1&&policy.weights.direct===1,'zero_paid_provider_allowance_required');
 const profiles=Object.values(config.v2?.accessProfiles||{}),profile=profiles[0];
 checked(profiles.length===1&&profile.id==='preview-example'&&profile.version===1&&JSON.stringify(profile.origins)==='["https://example.com"]'&&JSON.stringify(profile.paths)==='["^/$"]'&&JSON.stringify(profile.proxy_classes)==='["direct"]'&&JSON.stringify(profile.methods)==='["GET","HEAD"]'&&profile.limits?.max_redirects===0,'approved_native_example_profile_required');
 const health=await fetch(api+'/healthz',{signal:AbortSignal.timeout(5000)});
 checked(health.ok&&(await safeJSON(health)).release===config.release,'native_preview_not_running');
 const statusResponse=await fetch(base+'/api/control/status',{signal:AbortSignal.timeout(10000)}),status=await safeJSON(statusResponse);
 checked(statusResponse.ok&&status.enabled===true&&status.mail_configured===true&&status.mail_delivery==='local_private_mailbox'&&status.api_base_url===api&&JSON.stringify(status.capabilities?.routes)==='["direct"]','private_mailbox_proxy_required');
}

async function codeFor(email,challenge){
 const deadline=Date.now()+5000;
 do{
  const stat=await lstat(mailbox);checked(stat.isFile()&&!stat.isSymbolicLink()&&(stat.mode&0o077)===0&&stat.size<8*1024*1024,'private_preview_mailbox_required');
  const entries=(await readFile(mailbox,'utf8')).trim().split('\n').filter(Boolean);
  for(let i=entries.length-1;i>=0;i--){
   let message;try{message=JSON.parse(entries[i]);}catch{continue;}
   if(message.email===email&&message.challenge_id===challenge&&message.delivered_by==='local_private_mailbox'&&/^\d{8}$/.test(message.code))return message.code;
  }
  await new Promise(resolve=>setTimeout(resolve,100));
 }while(Date.now()<deadline);
 throw Error('control_live_mailbox_code_missing');
}

async function run(){
 await preflight();
 browser=await chromium.launch({headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
 page.setDefaultTimeout(15000);page.setDefaultNavigationTimeout(20000);
 page.on('pageerror',()=>{counts.browser_page_errors++;});
 page.on('request',request=>{
  const url=new URL(request.url());
  if(!['data:','blob:'].includes(url.protocol)&&url.origin!==base)counts.external_browser_requests++;
  const headers=request.headers();if(headers['x-fetchx-control-secret'])counts.bridge_headers_exposed++;
  if(url.origin!==base||!url.pathname.startsWith('/api/control/'))return;
  const path=url.pathname.slice('/api/control'.length),method=request.method();
  if(path==='/auth/code'&&method==='POST')counts.verification_requests++;
  if(path==='/projects'&&method==='POST')counts.project_creations++;
  if(/^\/projects\/[^/]+\/keys$/.test(path)&&method==='POST')counts.key_creations++;
  if(/^\/projects\/[^/]+\/keys\/[^/]+\/rotate$/.test(path)&&method==='POST')counts.key_rotations++;
  if(/^\/projects\/[^/]+\/keys\/[^/]+$/.test(path)&&method==='DELETE')counts.key_revocations++;
  if(/^\/projects\/[^/]+\/fetch$/.test(path)&&method==='POST')counts.source_fetch_posts++;
  if(/^\/projects\/[^/]+\/fetch\/[^/]+$/.test(path)&&method==='GET')counts.recovery_reads++;
 });
 const responseFor=(method,path)=>page.waitForResponse(response=>{const url=new URL(response.url());return url.origin===base&&url.pathname==='/api/control'+path&&response.request().method()===method;},{timeout:60000});
 const perform=async(method,path,action)=>{const response=responseFor(method,path);void response.catch(()=>{});await action();return await response;};
 const navigate=async path=>{const response=await page.goto(base+path);checked(response?.status()===200,'website_page_failed');};
 const visible=selector=>page.locator(selector).waitFor({state:'visible'});
 const enabled=selector=>page.waitForFunction(selector=>{const node=document.querySelector(selector);return node&&!node.disabled;},selector);
 const audit=async()=>{
  await page.evaluate(()=>document.fonts.ready);
  const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
  counts.axe_audits++;counts.axe_violations+=result.violations.length;
  for(const violation of result.violations)accessibility.push({id:/^[a-z0-9-]+$/.test(violation.id)?violation.id:'unknown',stage,viewport:page.viewportSize()?.width,node_count:violation.nodes.length});
  counts.layout_checks++;checked(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'horizontal_overflow');
 };
 const auditBoth=async()=>{for(const width of [1440,360]){await page.setViewportSize({width,height:1000});await audit();}await page.setViewportSize({width:1440,height:1000});};
 const privateValues=[];
 const storage=async(projectId)=>{
  const value=await page.evaluate(()=>({local:Object.entries(localStorage),session:Object.entries(sessionStorage)}));
  counts.storage_checks++;checked(value.local.length===0,'local_storage_not_empty');
  for(const [name,raw]of value.session){
   if(name==='fetchx-selected-project'){checked(raw===projectId,'selected_project_storage_invalid');continue;}
   checked(name==='fetchx-pending-operations:'+projectId,'unexpected_session_storage');
   let pending;try{pending=JSON.parse(raw);}catch{throw Error('control_live_pending_storage_invalid');}
   checked(Array.isArray(pending)&&pending.length<=100&&pending.every(key=>/^console_[a-f0-9-]{36}$/.test(key)),'pending_storage_invalid');
  }
  const serialized=JSON.stringify(value);
  checked(!/fx[ks]_[A-Za-z0-9_-]{20,}|https?:\/\//.test(serialized)&&privateValues.every(secret=>!serialized.includes(secret)),'sensitive_browser_storage');
  return value;
 };
 const keyRead=async(token,expected)=>{counts.api_key_reads++;const response=await nativeApi.get('/v2/usage',{headers:{authorization:'Bearer '+token}});checked(response.status()===expected,'key_authentication_state_invalid');};

 stage='email_verification';
 const email='fetchx-live-'+Date.now()+'-'+randomUUID().slice(0,8)+'@example.com';privateValues.push(email);
 await navigate('/signup');await enabled('[data-signup-email] button');
 checked((await page.locator('[data-auth-delivery-help]').textContent()).includes('No email is sent'),'local_mailbox_label_missing');await auditBoth();
 await page.locator('[data-signup-email] input').fill(email);
 const issued=await perform('POST','/auth/code',()=>page.locator('[data-signup-email] button').click()),challenge=await safeJSON(issued);
 checked(issued.status()===200&&challenge.accepted===true&&!Object.hasOwn(challenge,'code'),'verification_challenge_invalid');
 await visible('[data-signup-stage="1"]');await auditBoth();
 const code=await codeFor(email,challenge.challenge_id);privateValues.push(code);
 await page.locator('[data-signup-verify] input').fill(code);
 const verified=await perform('POST','/auth/verify',()=>page.locator('[data-signup-verify] button').click()),session=await safeJSON(verified);
 checked(verified.status()===200&&session.user?.email===email&&Array.isArray(session.projects)&&session.projects.length===0,'verified_session_invalid');
 privateValues.push(session.csrf_token);await visible('[data-signup-stage="2"]');
 const cookie=(await context.cookies(base+'/api/control/session')).find(item=>item.name==='fetchx_session');
 checked(cookie?.httpOnly===true&&cookie.sameSite==='Lax'&&cookie.path==='/api/control'&&/^fxs_[A-Za-z0-9_-]{43}$/.test(cookie.value),'session_cookie_invalid');
 checked(!(await page.evaluate(()=>document.cookie)).includes('fetchx_session='),'session_cookie_visible_to_script');await auditBoth();

 stage='project_and_key';
 const projectName='Native acceptance '+randomUUID().slice(0,8);privateValues.push(projectName);
 await page.locator('[data-signup-project] input').fill(projectName);
 const created=await perform('POST','/projects',()=>page.locator('[data-signup-project] button').click()),project=(await safeJSON(created)).project;
 checked(created.ok()&&/^cp_[a-f0-9-]{36}$/.test(project?.id),'project_creation_invalid');
 await visible('[data-signup-stage="3"]');await storage(project.id);
 const keyResponse=await perform('POST',`/projects/${project.id}/keys`,()=>page.locator('[data-signup-key] button[type="submit"]').click()),key=await safeJSON(keyResponse);
 checked(keyResponse.ok()&&/^fxk_[A-Za-z0-9_-]{43}$/.test(key.token)&&key.key?.id,'key_creation_invalid');privateValues.push(key.token);
 await visible('[data-signup-reveal]');checked((await page.locator('[data-signup-secret]').textContent())===key.token,'initial_key_reveal_invalid');await storage(project.id);await auditBoth();
 await page.locator('[data-finish-signup]').click();await enabled('[data-run-request]');
 await navigate('/app/keys');await visible('[data-workspace-content]');await page.locator(`[data-key-id="${key.key.id}"]`).waitFor();
 checked((await page.locator('[data-key-secret]').textContent())==='Concealed','key_not_concealed_after_navigation');await page.reload();await visible('[data-workspace-content]');
 checked((await page.locator('[data-key-secret]').textContent())==='Concealed','key_not_concealed_after_reload');checked(!(await page.locator('body').textContent()).includes(key.token),'key_secret_retrievable_after_reload');await storage(project.id);
 nativeApi=await playwrightRequest.newContext({baseURL:api,timeout:10000});await keyRead(key.token,200);

 stage='single_native_fetch';
 await navigate('/app/playground');await enabled('[data-run-request]');
 checked(await page.locator('input[value="browser"]').isDisabled(),'browser_execution_not_blocked');
 checked(await page.locator('[data-request-country]').isDisabled(),'direct_country_not_disabled');
 checked(await page.locator('[data-request-route] option').count()===1&&(await page.locator('[data-request-route]').inputValue())==='direct','paid_route_available');
 checked((await page.locator('[data-request-profile]').inputValue())==='preview-example@1','native_example_profile_missing');
 await page.locator('[data-request-url]').fill('https://example.com/');await auditBoth();
 const fetchResponse=await perform('POST',`/projects/${project.id}/fetch`,()=>page.locator('[data-run-request]').click()),result=await safeJSON(fetchResponse);
 // A single uncertain or failed source result ends acceptance; do not create a
 // fresh request, change providers, or automatically resubmit its operation key.
 checked(counts.source_fetch_posts===1,'unexpected_source_redispatch');
 if(result.state==='unknown'){await storage(project.id);throw Error('control_live_native_source_unknown_no_retry');}
 checked(fetchResponse.status()===200&&result.success===true&&result.state==='completed'&&result.data?.status===200,'native_source_not_200_no_retry');
 checked(result.routing?.class==='direct'&&result.routing?.provider==='direct'&&result.data.final_url==='https://example.com/'&&typeof result.data.text==='string'&&result.data.text.includes('Example Domain')&&result.application_acceptance==='not_evaluated','native_source_content_invalid');
 checked(result.usage?.native_requests===1&&result.usage.accounting?.request_credits?.credits===1&&result.usage.accounting.request_credits.state==='settled','native_usage_invalid');
 await page.waitForFunction(()=>document.querySelector('[data-response-state]')?.textContent==='Completed');
 checked((await page.locator('[data-response-output]').textContent()).includes('Example Domain'),'native_response_not_rendered');
 checked(await page.locator('.pp-response-panel img,.pp-response-panel iframe').count()===0,'source_html_executed');await storage(project.id);
 const readResponse=await perform('GET',`/projects/${project.id}/fetch/${result.idempotency_key}`,()=>page.locator('[data-recover-result]').click()),recovered=await safeJSON(readResponse);
 checked(readResponse.ok()&&recovered.operation_id===result.operation_id&&recovered.data?.text===result.data.text&&counts.source_fetch_posts===1,'retained_recovery_redispatched');

 stage='retained_history_and_usage';
 await navigate('/app/requests');await visible('[data-workspace-content]');await page.locator(`[data-request-id="${result.operation_id}"]`).waitFor();
 checked(await page.locator('[data-request-id]').count()===1,'history_operation_count_invalid');
 const detailResponse=await perform('GET',`/projects/${project.id}/requests/${result.operation_id}`,()=>page.locator(`[data-request-id="${result.operation_id}"]`).click()),detail=await safeJSON(detailResponse);
 checked(detailResponse.ok()&&detail.operation_id===result.operation_id&&detail.data?.text===result.data.text,'retained_history_content_invalid');
 await visible('[data-request-dialog]');await page.waitForFunction(()=>document.querySelector('[data-request-detail]')?.textContent?.includes('Example Domain'));await auditBoth();await page.locator('[data-close-request]').click();
 await navigate('/app/billing');await visible('[data-workspace-content]');
 checked((await page.locator('[data-request-count]').textContent())==='1'&&(await page.locator('[data-source-successes]').textContent())==='1'&&(await page.locator('[data-credits-used]').textContent())==='1','authoritative_usage_not_rendered');
 checked((await page.locator('[data-credits-available]').textContent())==='24'&&(await page.locator('[data-reserved-credits]').textContent())==='0'&&(await page.locator('[data-billing-status]').textContent())==='Trial access','authoritative_balance_not_rendered');
 checked(/^\d[\d,]* ms$/.test(await page.locator('[data-mean-latency]').textContent()),'measured_latency_missing');

 stage='rotate_and_revoke';
 await navigate('/app/keys');await visible('[data-workspace-content]');await page.locator(`[data-rotate-key="${key.key.id}"]`).click();await visible('[data-confirm-dialog]');
 const rotation=await perform('POST',`/projects/${project.id}/keys/${key.key.id}/rotate`,()=>page.locator('[data-confirm-action]').click()),replacement=await safeJSON(rotation);
 checked(rotation.ok()&&/^fxk_[A-Za-z0-9_-]{43}$/.test(replacement.token)&&replacement.token!==key.token&&replacement.key?.id!==key.key.id,'rotation_invalid');privateValues.push(replacement.token);
 await visible('[data-key-dialog]');checked((await page.locator('[data-key-secret]').textContent())===replacement.token,'replacement_key_reveal_invalid');await storage(project.id);await auditBoth();
 await page.locator('[data-close-key]').click();await page.locator('[data-key-dialog]').waitFor({state:'hidden'});
 checked((await page.locator('[data-key-secret]').textContent())==='Concealed','replacement_not_concealed');
 await keyRead(key.token,401);await keyRead(replacement.token,200);
 await page.locator(`[data-revoke-key="${replacement.key.id}"]`).click();await visible('[data-confirm-dialog]');
 const revocation=await perform('DELETE',`/projects/${project.id}/keys/${replacement.key.id}`,()=>page.locator('[data-confirm-action]').click()),revoked=await safeJSON(revocation);
 if(!revocation.ok()||revoked.revoked!==true){failure_metadata.http_status=revocation.status();failure_metadata.error_code=/^[a-z0-9_]{1,80}$/.test(revoked.error?.code||'')?revoked.error.code:'unknown';}
 checked(revocation.ok()&&revoked.revoked===true,'revocation_invalid');
 await page.waitForFunction(id=>document.querySelector(`[data-key-id="${id}"]`)?.textContent?.includes('Revoked'),replacement.key.id);await keyRead(replacement.token,401);

 stage='workspace_accessibility';
 for(const route of ['/app','/app/onboarding','/app/playground','/app/requests','/app/keys','/app/billing']){
  await navigate(route);await visible('[data-workspace-content]');
  checked(await page.locator('h1').count()===1,'workspace_heading_invalid');await storage(project.id);await auditBoth();
 }
 await page.setViewportSize({width:360,height:900});await page.locator('[data-app-menu]').click();
 checked((await page.locator('[data-app-menu]').getAttribute('aria-expanded'))==='true','mobile_navigation_not_open');await page.keyboard.press('Escape');
 checked((await page.locator('[data-app-menu]').getAttribute('aria-expanded'))==='false','mobile_navigation_not_closed');

 stage='logout_and_unauthenticated_gate';
 await page.setViewportSize({width:1440,height:1000});const logout=responseFor('POST','/auth/logout');void logout.catch(()=>{});await page.locator('[data-logout]').click();checked((await logout).ok(),'logout_failed');
 await page.waitForURL(base+'/login');await enabled('[data-signup-email] button');await auditBoth();
 checked(!(await context.cookies(base+'/api/control/session')).some(cookie=>cookie.name==='fetchx_session'),'logout_cookie_not_cleared');
 const sessionResponse=await context.request.get(base+'/api/control/session');checked(sessionResponse.status()===401,'logout_session_not_revoked');
 await navigate('/app');await page.waitForFunction(()=>document.querySelector('[data-gate-title]')?.textContent==='Sign in to continue.');
 checked(await page.locator('[data-workspace-content]').isHidden()&&await page.locator('[data-login-link]').isVisible(),'unauthenticated_workspace_not_gated');await storage(project.id);await auditBoth();
 checked(counts.verification_requests===1&&counts.project_creations===1&&counts.key_creations===1&&counts.key_rotations===1&&counts.key_revocations===1,'unexpected_identity_mutation_count');
 checked(counts.source_fetch_posts===1&&counts.recovery_reads===1,'unexpected_source_work_count');
 checked(counts.browser_page_errors===0&&counts.external_browser_requests===0&&counts.bridge_headers_exposed===0,'browser_privacy_or_runtime_failure');
 checked(counts.axe_violations===0,'accessibility_violations');stage='complete';
}

try{
 await run();process.stdout.write(JSON.stringify({passed:true,...counts,accessibility})+'\n');
}catch(error){
 const code=/^control_live_[a-z0-9_]+$/.test(error?.message||'')?error.message:'control_live_check_failed';
 // Playwright errors and axe node HTML may include typed secrets. Only bounded
 // stage labels, rule IDs, viewport widths and integer counters leave this process.
 process.stderr.write(JSON.stringify({passed:false,stage,error:code,...counts,accessibility,failure_metadata})+'\n');process.exitCode=1;
}finally{
 await nativeApi?.dispose().catch(()=>{});await browser?.close().catch(()=>{});
}
