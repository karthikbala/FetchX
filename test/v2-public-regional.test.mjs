import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {grantInitialCredits} from '../src/control-credits.mjs';
import {sha} from '../src/crypto.mjs';
import {Gateway} from '../src/gateway.mjs';
import {PAID_WIRE_READ_BYTES} from '../src/paid-wire-limits.mjs';
import {Store} from '../src/store.mjs';
import {fixedFeePoolFingerprint} from '../src/v2-pricing.mjs';
import {PublicFetchGateway} from '../src/v2-public-fetch.mjs';
import {PUBLIC_URL_REF,PUBLIC_URL_V2_REF} from '../src/v2-public-url.mjs';
import {V2Gateway} from '../src/v2.mjs';

const dc=country=>({class:'datacenter',country});
const res=country=>({class:'residential',country});
const paidRule=(accessProfile,proxy,provider)=>({accessProfile,...proxy,provider});
const minimumHold=250_000+PAID_WIRE_READ_BYTES;
const providerLimit=540_000;

function pool(country){
 const name=country.toLowerCase(),provider='oxylabs',pool_id=`fixture-${name}`;
 const proxies=['a','b'].map(suffix=>({id:`regional-${name}-${suffix}`,country,url:`http://${name}-${suffix}.proxy.sample.net:80`}));
 const pricing={schema_version:1,id:pool_id,reviewed:true,provider,pool_id,countries:[country],cost_scope:'incremental_traffic_only',
  fixed_subscription_allocation_micro_usd:null,provenance:{id:'fixture',sha256:'a'.repeat(64),reviewed_at:new Date().toISOString()},
  pool_fingerprint_sha256:fixedFeePoolFingerprint(proxies.map(member=>({...member,provider,pool_id})),[country])};
 return {proxies,binding:{proxyIds:proxies.map(member=>member.id),pricing}};
}

test('explicit public HTTP v2 advertises and pins reviewed country routes under shared spending and quota controls',
 {skip:!process.env.TEST_DATABASE_URL},async()=>{
 assert.match(new URL(process.env.TEST_DATABASE_URL).pathname,/^\/gateway_test_[A-Za-z0-9_]+$/);
 const dir=await mkdtemp(join(tmpdir(),'fetchx-regional-')),store=new Store(process.env.TEST_DATABASE_URL);
 const project='cp_'+randomUUID(),user=randomUUID(),legacy=pool('US'),regional=pool('IN');
 const legacyRules=[paidRule(PUBLIC_URL_REF,dc('US'),'oxylabs'),paidRule(PUBLIC_URL_REF,res('US'),'evomi')];
 const regionalRules=[paidRule(PUBLIC_URL_V2_REF,dc('IN'),'oxylabs'),paidRule(PUBLIC_URL_V2_REF,dc('GB'),'oxylabs'),
  paidRule(PUBLIC_URL_V2_REF,res('IN'),'dataimpulse'),paidRule(PUBLIC_URL_V2_REF,res('AU'),'dataimpulse')];
 const config={release:'regional-fixture',artifactDir:dir,artifactKey:'e3'.repeat(32),maxDailyFallbackCredits:0,
  proxies:[...legacy.proxies,...regional.proxies],projects:{[project]:{profiles:[],v2_access_profiles:[]}},
  residential:{providers:{evomi:{enabled:true,username:'fixture-evomi',password:'fixture-pass',countries:['US'],microUsdPerGB:2_000_000},
   dataimpulse:{enabled:true,username:'fixture-dataimpulse',password:'fixture-pass',countries:['IN','AU'],microUsdPerGB:4_000_000}}},
  controlPlane:{enabled:true,creditPolicy:{reviewed:true,version:'regional-trial',trialCredits:1000,weights:{direct:1},maxEstimatedMicroUsdPerOperation:0},
   paidCreditPolicy:{reviewed:true,version:'regional-paid',routes:[...legacyRules,...regionalRules],datacenterPool:legacy.binding,
    datacenterPoolsByCountry:{IN:regional.binding},residentialBudget:{reviewed:true,provider:'evomi',maxTotalBytes:1_500_000,maxDailyBytes:1_500_000,microUsdPerGB:1_000_000},
    dns:{reviewed:true,endpoint:'https://resolver.sample.net/resolve',address:'1.1.1.1'},publicUrl:{reviewed:true,maxDailyOperations:4}}}};
 const policy=config.controlPlane.paidCreditPolicy,identity={keyId:'console'},calls=[];
 const gateway=new Gateway({store,config,profiles:{},resolve:async()=>assert.fail('Paid requests use the pinned resolver')});
 const v2=new V2Gateway(gateway,{dnsHttp:async(_input,{url,address},_limits,{wireMeter,proxy})=>{
  assert.equal(address,'1.1.1.1');assert.equal(wireMeter,true);assert.ok(proxy);
  const name=url.searchParams.get('name'),type=Number(url.searchParams.get('type'));
  const encoded=Buffer.from(JSON.stringify({Status:0,Question:[{name,type}],Answer:type===1?[{name,type,data:'93.184.216.34'}]:[]}));
  return {status:200,headers:{},encoded,wire_bytes:1000,wire_bytes_lower_bound:1000};
 },http:async(_input,destination,_limits,{proxy,wireMeter})=>{
  assert.equal(destination.address,'93.184.216.34');assert.equal(wireMeter,true);calls.push(proxy.id);
  return {status:200,headers:{},encoded:Buffer.from('fixture'),wire_bytes:1000,wire_bytes_lower_bound:1000};
 }});
 v2.pace=async()=>{};
 const fetch=new PublicFetchGateway(v2);
 const request=(key,proxy,options={},admission)=>fetch.fetch(project,{idempotency_key:key,url:'https://regional.sample.net/',proxy,...options},identity,admission);
 const routePairs=async version=>(await v2.profiles(project)).access_profiles.find(profile=>profile.version===version)?.route_reservations
  .map(({class:cls,country,provider})=>[cls,country,provider]);
 try{
  await store.init();
  // The provider ceilings span projects, so start this disposable fixture with no paid dispatches.
  await store.pool.query('TRUNCATE v2_operations CASCADE');
  await store.tx(async c=>{
   await c.query('INSERT INTO control_users(id,email) VALUES($1,$2)',[user,`regional-${user}@example.test`]);
   await c.query('INSERT INTO control_projects(id,user_id,name,template_hash) VALUES($1,$2,$3,$4)',[project,user,'Regional fixture',sha('test')]);
   await grantInitialCredits(c,project,1000);
   await v2.controlPaidCredits.grantPaidCredits(c,{project,mode:'live',accountId:'acct_fixture',checkoutSessionId:'cs_live_regional',
    paymentIntentId:'pi_regional',credits:10000,amountMinor:200,currency:'usd'});
   // Hash of the released v1 profile body, as persisted by older gateways.
   await c.query("INSERT INTO v2_registry(kind,key,hash) VALUES('access_profile','public-url-http@1',$1) ON CONFLICT DO NOTHING",
    ['c6a831c40fb42486e01a90211c80b2162be8eb074e3e4cddb6389c1ca187ec9f']);
  });
  const v2Options={access_profile:PUBLIC_URL_V2_REF};
  assert.deepEqual(await routePairs(1),[['datacenter','US','configured_datacenter'],['residential','US','evomi']]);
  assert.deepEqual(await routePairs(2),[['datacenter','IN','configured_datacenter']]);
  const {paid_http:advertised}=await v2.capabilities(project);
  assert.deepEqual(advertised.public_url_access_profile,PUBLIC_URL_REF);
  assert.deepEqual(advertised.public_url_access_profiles,[PUBLIC_URL_REF,PUBLIC_URL_V2_REF]);
  assert.equal(advertised.public_url_transfer_limits.default_transfer_policy,'automatic');
  await assert.rejects(request('implicit-india',dc('IN')),{code:'country_forbidden'});
  await assert.rejects(request('unpriced-britain',dc('GB'),v2Options),{code:'paid_credit_route_forbidden'});
  await assert.rejects(request('unbudgeted-india',res('IN'),v2Options),{code:'paid_credit_route_forbidden'});
  await assert.rejects(request('regional-metadata',dc('IN'),{...v2Options,url:'https://169.254.169.254/'}),{code:'destination_rejected'});
  await assert.rejects(request('private-control-marker',dc('US'),{automatic_transfer:true}),{code:'request_invalid'});
  assert.equal(calls.length,0);

  policy.dataImpulseResidentialBudget={reviewed:true,provider:'dataimpulse',maxTotalBytes:1_000_000,maxDailyBytes:providerLimit,microUsdPerGB:1_000_000};
  const checkCapacity=v2.reserveResidential.bind(v2),capacityChecks=[];
  v2.reserveResidential=async(...args)=>{capacityChecks.push(args[3].provider);return checkCapacity(...args);};
  assert.deepEqual(await routePairs(2),[['datacenter','IN','configured_datacenter'],['residential','AU','dataimpulse'],['residential','IN','dataimpulse']]);
  assert.deepEqual(capacityChecks,['evomi','dataimpulse']);
  v2.reserveResidential=checkCapacity;
  const saleOptions={publicOnly:true,purchaseCredits:20,outstandingLiabilityBytes:0n};
  assert.equal(await v2.paidCreditReady(project,saleOptions),true);
  policy.routes=regionalRules;
  assert.equal(await v2.paidCreditReady(project,saleOptions),false);
  assert.deepEqual((await v2.capabilities(project)).paid_http.public_url_access_profiles,[PUBLIC_URL_V2_REF]);
  policy.routes=[...legacyRules,...regionalRules];

  const legacyControl={automaticTransfer:false},currentControl={automaticTransfer:true};
  const us=await request('legacy-implicit',dc('US'),{},legacyControl);
  assert.deepEqual((await v2.readSession(project,us.session_id)).access_profile,PUBLIC_URL_REF);
  assert.equal(us.usage.accounting.paid_credits.max_transfer_bytes,1_000_000);
  assert.equal(us.usage.accounting.paid_credits.reserved_credits,1);
  regional.proxies[1].enabled=false;
  assert.deepEqual(await routePairs(2),[['residential','AU','dataimpulse'],['residential','IN','dataimpulse']]);
  assert.deepEqual(await routePairs(1),[['datacenter','US','configured_datacenter'],['residential','US','evomi']]);
  delete regional.proxies[1].enabled;
  const india=await request('regional-india',dc('IN'),v2Options,currentControl);
  assert.deepEqual((await v2.readSession(project,india.session_id)).access_profile,PUBLIC_URL_V2_REF);
  assert.equal(india.usage.accounting.paid_credits.max_transfer_bytes,20_000_000);
  assert.match(calls[0],/^regional-us-/);
  assert.match(calls[1],/^regional-in-/);

  const secondary=await request('secondary-provider',res('IN'),v2Options);
  assert.equal(secondary.routing.provider,'dataimpulse');
  assert.equal(secondary.usage.accounting.paid_credits.max_transfer_bytes,500_000);
  assert.equal(secondary.usage.accounting.reserved_tunnel_bytes,500_000+PAID_WIRE_READ_BYTES);
  assert.equal(secondary.usage.accounting.estimated_micro_usd,505);
  assert.equal(await v2.paidCreditReady(project,saleOptions),false);
  assert.equal(await v2.paidCreditReady(project,{...saleOptions,purchaseCredits:19}),true);
  assert.deepEqual(await routePairs(2),[['datacenter','IN','configured_datacenter']]);
  await assert.rejects(request('second-provider-cap',res('AU'),v2Options),{code:'residential_budget_exhausted'});
  const primary=await request('primary-provider',res('US'),{},legacyControl);
  assert.equal(primary.routing.provider,'evomi');
  assert.equal(primary.usage.accounting.reserved_tunnel_bytes,minimumHold);
  assert.equal(primary.usage.accounting.paid_credits.reserved_credits,5);
  assert.equal(primary.usage.accounting.estimated_micro_usd,255);
  await assert.rejects(request('combined-quota',dc('IN'),v2Options),{code:'paid_public_url_daily_quota_exhausted'});

  policy.publicUrl.maxDailyOperations=10;
  const native=await v2.operation(project,{idempotency_key:'automatic-native',session_id:us.session_id,request:{url:'https://regional.sample.net/'}},identity);
  assert.equal(native.accounting.paid_credits.max_transfer_bytes,20_000_000);
  const reuseIndia={...v2Options,session_id:india.session_id};
  await store.pool.query('UPDATE v2_sessions SET encoded_bytes=59249958 WHERE id=$1',[india.session_id]);
  await assert.rejects(request('explicit-over-session-cap',dc('IN'),{...reuseIndia,max_transfer_mb:1}),{code:'session_limit'});
  const continued=await request('automatic-session-cap',dc('IN'),reuseIndia);
  assert.equal(continued.usage.accounting.paid_credits.max_transfer_bytes,750_000);
  await store.pool.query('UPDATE v2_sessions SET encoded_bytes=59999999 WHERE id=$1',[india.session_id]);
  await assert.rejects(request('automatic-session-exhausted',dc('IN'),reuseIndia),{code:'session_limit'});

  await assert.rejects(request('shared-provider-cap',res('US'),{max_transfer_mb:0.75}),{code:'residential_budget_exhausted'});
  policy.dataImpulseResidentialBudget.maxDailyBytes=1_000_000;
  policy.routes.push(paidRule(PUBLIC_URL_V2_REF,res('IN'),'evomi'));
  config.residential.providers.evomi.countries.push('IN');
  await store.pool.query("UPDATE v2_operations SET error='provider_account_rejected' WHERE id=$1",[primary.operation_id]);
  try{
   assert.deepEqual(await routePairs(2),[['datacenter','IN','configured_datacenter'],['residential','AU','dataimpulse']]);
   await assert.rejects(request('held-provider-no-switch',res('IN'),v2Options),{code:'residential_provider_held'});
  }finally{
   await store.pool.query('UPDATE v2_operations SET error=NULL WHERE id=$1',[primary.operation_id]);
  }

  policy.routes=legacyRules;
  assert.deepEqual(await request('regional-india',dc('IN'),v2Options),india);
  assert.deepEqual(await request('legacy-implicit',dc('US')),us);
  assert.deepEqual(await request('legacy-implicit',dc('US'),{},currentControl),us);
  assert.deepEqual(await fetch.lookup(project,'legacy-implicit'),us);
  assert.equal(calls.length,6);
 }finally{await store.close();await rm(dir,{recursive:true,force:true});}
});
