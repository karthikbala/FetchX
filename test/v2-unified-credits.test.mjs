import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {preparePlayground} from '../src/control-playground.mjs';
import {grantInitialCredits} from '../src/control-credits.mjs';
import {Gateway} from '../src/gateway.mjs';
import {GatewayError} from '../src/policy.mjs';
import {Store} from '../src/store.mjs';
import {V2Gateway} from '../src/v2.mjs';
import {PublicFetchGateway} from '../src/v2-public-fetch.mjs';
import {PublicRenderGateway} from '../src/v2-public-render.mjs';
import {PUBLIC_URL_REF,PUBLIC_URL_V2_REF} from '../src/v2-public-url.mjs';

const direct={class:'direct',country:null},residential={class:'residential',country:'US'};
const browserResidential={class:'residential',country:'CA'};
const browserResidentialCap=16_778;
const address={address:'93.184.216.34',family:4};

test('verified purchase unifies scoped HTTP, browser and metered public HTTP while preserving legacy in-flight billing',
 {skip:!process.env.TEST_DATABASE_URL},async t=>{
 const db=process.env.TEST_DATABASE_URL;
 assert.match(new URL(db).pathname,/^\/gateway_test_[A-Za-z0-9_]+$/);
 const store=new Store(db),root=await mkdtemp(join(tmpdir(),'fetchx-unified-routes-'));
 const user=randomUUID(),project='cp_'+user,keyId=randomUUID(),identity={keyId,userId:user,requireSoleKey:true};
 const accountId='acct_fixture',checkoutSessionId='cs_live_'+user.replaceAll('-',''),paymentIntentId='pi_'+user.replaceAll('-','');
 const provider={enabled:true,username:'fixture-user',password:'fixture-password',maxTotalBytes:1e9,microUsdPerGB:1e6};
 const config={release:'unified-routes',artifactDir:root,artifactKey:'51'.repeat(32),maxDailyFallbackCredits:0,proxies:[],v2:{},
  projects:{[project]:{v2_entitlement:{mode:'metered',max_daily_operations:2}}},
  residential:{maxTotalBytes:1e9,maxDailyBytes:1e9,providers:{evomi:provider,dataimpulse:{...provider}}},
  controlPlane:{enabled:true,unifiedCredits:{enabled:true},creditPolicy:{reviewed:true,version:'legacy-v1',weights:{direct:2},maxEstimatedMicroUsdPerOperation:0,
   modeWeights:{reviewed:true,version:'scoped-v1',browser:{direct:4,residential:100},browserResidentialMaxEstimatedMicroUsd:browserResidentialCap}},
   playground:{enabled:true,reviewed:true,version:'unified-routes-v1',maxProfilesPerProject:4,browserResidentialProviderPolicy:'reviewed-http-v2',
    routes:{http:{direct:true},browser:{direct:true,residential:['CA','DE','GB','NL']}}},
   paidCreditPolicy:{reviewed:true,version:'paid-v1',routes:[
    {accessProfile:PUBLIC_URL_REF,...residential,provider:'evomi'},
    {accessProfile:PUBLIC_URL_V2_REF,...browserResidential,provider:'evomi'},
    {accessProfile:PUBLIC_URL_V2_REF,...browserResidential,provider:'dataimpulse'},
    {accessProfile:PUBLIC_URL_V2_REF,class:'residential',country:'GB',provider:'evomi'},
    {accessProfile:PUBLIC_URL_V2_REF,class:'residential',country:'NL',provider:'dataimpulse'}],
    dns:{reviewed:true,endpoint:'https://resolver.example.net/resolve',address:'1.1.1.1'},publicUrl:{reviewed:true,maxDailyOperations:1},
    residentialBudget:{reviewed:true,provider:'evomi',maxTotalBytes:1e9,maxDailyBytes:1e9,microUsdPerGB:1e6}}}};
 const dnsStarted=Promise.withResolvers(),dnsReleased=Promise.withResolvers();
 const gateway=new Gateway({store,config,profiles:{},resolve:async host=>{
  if(host!=='legacy.example.com')return [address];
  dnsStarted.resolve();await dnsReleased.promise;
  return [{address:'127.0.0.1',family:4}];
 }});
 let targetCalls=0,browserCalls=0,legacy,holdDuringBrowser=false,relayOptions;
 const v2=new V2Gateway(gateway,{
  dnsHttp:async(_input,{url})=>{
   const name=url.searchParams.get('name'),type=Number(url.searchParams.get('type'));
   const encoded=Buffer.from(JSON.stringify({Status:0,Question:[{name,type}],Answer:type===1?[{name,type,data:address.address}]:[]}));
   return {status:200,headers:{},encoded,wire_bytes:200,wire_bytes_lower_bound:200};
  },
  http:async(_input,{url},_limits,{wireMeter})=>{
   targetCalls++;
   if(url.pathname==='/unknown')throw new GatewayError('source_timeout_unknown',502);
   return {status:200,headers:{},encoded:Buffer.from('fixture'),...(wireMeter?{wire_bytes:300,wire_bytes_lower_bound:300,tunnel_bytes:300}:{})};
  },
  browserRuntime:async()=>({available:true,runtime:{synthetic:true}}),
  relayFactory:async options=>{
   relayOptions=options;
   const before=browserCalls;
   return {url:'http://127.0.0.1:1',get dispatched(){return browserCalls>before;},bytes:0,close:async()=>{}};
  },
  browserRunner:async({url},hooks)=>{
   if(holdDuringBrowser)await store.tx(c=>v2.controlPaidCredits.setPaymentHold(c,{project,mode:'live',accountId,holdId:'fixture-hold',active:true}));
   await hooks.admit({url,method:'GET',headers:{},body_base64:null,redirect_depth:0});
   if(new URL(url).pathname==='/canada')assert.match(relayOptions.proxy.url,/_country-CA_session-/);
   if(new URL(url).pathname==='/netherlands')assert.equal(new URL(relayOptions.proxy.url).hostname,'gw.dataimpulse.com');
   browserCalls++;
   return {status:200,final_url:url};
  }
 });
 v2.pace=async()=>{};
 const fetch=new PublicFetchGateway(v2),render=new PublicRenderGateway(v2);
 const legacyUrl='https://legacy.example.com/',url='https://scoped.example.com/';
 const prepare=(execution,target,proxy=direct)=>preparePlayground(v2,project,{url:target,execution,proxy},[{id:keyId,scopes:['fetch:write']}]);
 const scoped=(idempotency_key,quote,proxy=direct)=>({idempotency_key,url:quote.url,access_profile:quote.access_profile,proxy});
 const publicFetch=(idempotency_key)=>fetch.fetch(project,{idempotency_key,url:'https://paid.example.com/',proxy:residential,max_transfer_mb:0.25,max_credits:5},identity);
 const credits=(weight,state,policy_version,unit)=>({credits:weight,state,key_id:keyId,policy_version,unit});

 t.after(async()=>{
  dnsReleased.resolve();await legacy?.catch(()=>{});
  await store.tx(async c=>{
   await c.query('DELETE FROM v2_ledger_events WHERE operation IN (SELECT id FROM v2_operations WHERE project=$1)',[project]);
   for(const table of ['paid_credit_allocations','paid_credit_reservations','control_credit_reservations','control_credit_upgrades',
    'paid_credit_grants','paid_credit_payment_holds','v2_artifacts','v2_ledger','v2_operations','v2_sessions','control_stripe_purchases',
    'control_stripe_orders','control_stripe_customers','control_playground_profiles','control_credit_accounts','control_keys','control_memberships'])
    await c.query(`DELETE FROM ${table} WHERE project=$1`,[project]);
   await c.query('DELETE FROM control_projects WHERE id=$1',[project]);
   await c.query('DELETE FROM control_users WHERE id=$1',[user]);
  });
  await store.close();await rm(root,{recursive:true,force:true});
 });

 await store.init();
 await store.tx(async c=>{
  await c.query('INSERT INTO control_users(id,email) VALUES($1,$2)',[user,`${user}@example.net`]);
  await c.query("INSERT INTO control_projects(id,user_id,name,template_hash) VALUES($1,$2,'Fixture','fixture')",[project,user]);
  await c.query('INSERT INTO control_memberships(user_id,project) VALUES($1,$2)',[user,project]);
  await c.query(`INSERT INTO control_keys(id,project,name,prefix,token_hash,scopes)
   VALUES($1,$2,'Fixture','fixture',$3,'["fetch:write"]')`,[keyId,project,keyId]);
  await grantInitialCredits(c,project,112);
 });

 const before=await prepare('http',legacyUrl),http=await prepare('http',url),browser=await prepare('browser',url);
 assert.equal(before.ready,true);assert.equal((await v2.usage(project)).credit_balance,undefined);
 const canadaUrl=url+'canada',canada=await prepare('browser',canadaUrl,browserResidential);
 assert.equal(canada.ready,true);
 assert.deepEqual(canada.capabilities.routes.find(route=>route.class==='residential').countries,['CA','GB','NL']);
 assert.deepEqual(canada.quote,{credits:100,max_estimated_micro_usd:browserResidentialCap});
 const canadaTrialBody=scoped('trial-canada-browser',canada,browserResidential);
 const trialResidential=await render.render(project,canadaTrialBody,identity);
 assert.deepEqual(trialResidential.usage.accounting.request_credits,credits(100,'settled','scoped-v1','logical_browser_operation'));
 assert.equal((await v2.usage(project)).request_credits.available,12);
 legacy=fetch.fetch(project,scoped('legacy',before),identity);
 await Promise.race([dnsStarted.promise,legacy.then(()=>assert.fail('Legacy request returned before the simulated resolver'))]);
 await assert.rejects(fetch.fetch(project,scoped('scoped-http',http),identity),{code:'client_quota_exhausted'});
 await store.tx(async c=>{
  const order=randomUUID();
  await c.query(`INSERT INTO control_stripe_customers(mode,account_id,project,creation_key,api_version,request_body)
   VALUES('live',$1,$2,$3,'fixture','{}')`,[accountId,project,randomUUID()]);
  await c.query(`INSERT INTO control_stripe_orders(id,mode,account_id,project,operation_key,plan,return_origin,api_version,state,session_id)
   VALUES($1,'live',$2,$3,$4,'{}','https://fixture.example.net','fixture','complete',$5)`,[order,accountId,project,randomUUID(),checkoutSessionId]);
  await c.query(`INSERT INTO control_stripe_purchases(mode,account_id,session_id,order_id,project,payment_intent_id,charge_id,state,paid_at)
   VALUES('live',$1,$2,$3,$4,$5,$6,'paid',now())`,[accountId,checkoutSessionId,order,project,paymentIntentId,'ch_'+order]);
  await v2.controlPaidCredits.grantPaidCredits(c,{project,mode:'live',accountId,checkoutSessionId,paymentIntentId,amountMinor:200,currency:'usd',credits:10_000});
  assert.equal(await v2.controlPaidCredits.upgradeEligibleProject(c,project),true);
 });
 assert.equal((await v2.usage(project)).credit_balance.available,10_010);
 dnsReleased.resolve();
 assert.deepEqual((await legacy).usage.accounting.request_credits,credits(2,'released','legacy-v1','logical_http_operation'));
 assert.equal(targetCalls,0);
 assert.equal((await v2.usage(project)).credit_balance.available,10_012);

 const prepared=await prepare('http',url);assert.equal(prepared.ready,true);
 const first=await fetch.fetch(project,scoped('scoped-http',prepared),identity);
 assert.deepEqual(first.usage.accounting.request_credits,credits(2,'settled','legacy-v1','logical_http_operation'));
 assert.equal(first.usage.accounting.paid_credits,undefined);
 assert.equal((await fetch.fetch(project,scoped('scoped-http',prepared),identity)).operation_id,first.operation_id);
 const rendered=await render.render(project,scoped('scoped-browser',browser),identity);
 assert.deepEqual(rendered.usage.accounting.request_credits,credits(4,'settled','scoped-v1','logical_browser_operation'));
 assert.deepEqual((await v2.recentOperations(project)).operations.find(op=>op.id===rendered.operation_id).request_credits,rendered.usage.accounting.request_credits);
 const modeWeights=config.controlPlane.creditPolicy.modeWeights;
 modeWeights.browserResidentialMaxEstimatedMicroUsd=browserResidentialCap-1;
 assert.ok((await prepare('browser',canadaUrl,browserResidential)).errors.some(issue=>issue.code==='cost_ceiling_exceeded'));
 await assert.rejects(render.render(project,scoped('cap-canada-browser',canada,browserResidential),identity),{code:'cost_ceiling_exceeded'});
 assert.equal(browserCalls,2);
 modeWeights.browserResidentialMaxEstimatedMicroUsd=browserResidentialCap;
 const netherlands={class:'residential',country:'NL'};
 const purchasedPrepare=await prepare('browser',url+'netherlands',netherlands);
 assert.deepEqual(purchasedPrepare.quote,canada.quote);
 const purchasedResidential=await render.render(project,scoped('paid-netherlands-browser',purchasedPrepare,netherlands),identity);
 assert.deepEqual(purchasedResidential.routing,{...netherlands,provider:'dataimpulse'});
 assert.deepEqual(purchasedResidential.usage.accounting.request_credits,credits(100,'settled','scoped-v1','logical_browser_operation'));
 assert.equal((await v2.usage(project)).credit_balance.available,9_906);
 const paid=await publicFetch('paid-http');
 assert.equal(paid.usage.accounting.paid_credits.used_credits,5);
 assert.equal(paid.usage.accounting.paid_credits.billable_bytes,700);
 await assert.rejects(publicFetch('public-quota'),{code:'paid_public_url_daily_quota_exhausted'});
 assert.equal(targetCalls,2);
 const pending={...scoped('uncertain-http',http),url:url+'unknown'};
 const uncertain=await fetch.fetch(project,pending,identity);
 assert.equal(uncertain.state,'unknown');assert.equal(uncertain.usage.accounting.request_credits.state,'held');
 assert.equal((await fetch.fetch(project,pending,identity)).operation_id,uncertain.operation_id);
 assert.equal(targetCalls,3);
 const usage=await v2.usage(project);
 assert.deepEqual(usage.entitlement,{mode:'unmetered',max_daily_operations:null});
 assert.deepEqual(usage.credit_balance,{mode:'unified',...usage.paid_credits});
 assert.equal(usage.request_credits.available,0);assert.equal(usage.credit_balance.available,9_899);

 holdDuringBrowser=true;
 const blocked=await render.render(project,scoped('held-browser',browser),identity);
 assert.equal(blocked.error.code,'paid_credit_payment_hold');assert.equal(blocked.usage.accounting.request_credits.state,'released');
 assert.equal(browserCalls,3);
 assert.equal((await prepare('http',url)).errors.find(issue=>issue.field==='credits').code,'paid_credit_payment_hold');
 await assert.rejects(fetch.fetch(project,scoped('held-http',http),identity),{code:'paid_credit_payment_hold'});
 assert.equal(targetCalls,3);
 config.controlPlane.playground.version='unified-routes-v2';
 assert.equal((await render.lookup(project,canadaTrialBody.idempotency_key)).operation_id,trialResidential.operation_id);
 assert.equal(browserCalls,3);
});
