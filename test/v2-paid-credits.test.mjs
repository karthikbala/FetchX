import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import {gzipSync} from 'node:zlib';
import {sha} from '../src/crypto.mjs';
import {Gateway} from '../src/gateway.mjs';
import {GatewayError} from '../src/policy.mjs';
import {Store} from '../src/store.mjs';
import {grantInitialCredits} from '../src/control-credits.mjs';
import {nativeHttp,PAID_WIRE_READ_BYTES} from '../src/v2-http.mjs';
import {estimatePaidPublicDatacenter,estimateRoutePricing,fixedFeePoolFingerprint} from '../src/v2-pricing.mjs';
import {PublicFetchGateway} from '../src/v2-public-fetch.mjs';
import {PUBLIC_URL_REF,checkedPublicAddresses,checkedPublicSourceUrl,reviewedPublicUrlPolicy} from '../src/v2-public-url.mjs';
import {V2Gateway} from '../src/v2.mjs';

const dc={class:'datacenter',country:'US'},res={class:'residential',country:'US'},direct={class:'direct',country:null};

function datacenterFixture(){
 const proxies=[
  {id:'fixture-dc-us-a',country:'US',url:'http://fixture-user:fixture-pass@first-proxy.sample.net:80'},
  {id:'fixture-dc-us-b',country:'US',url:'http://fixture-user:fixture-pass@second-proxy.sample.net:80'}
 ];
 const metadata={provider:'oxylabs',pool_id:'fixture'};
 const datacenterPool={proxyIds:proxies.map(proxy=>proxy.id),pricing:{
  schema_version:1,id:'fixture-pool',reviewed:true,...metadata,countries:['US'],
  cost_scope:'incremental_traffic_only',fixed_subscription_allocation_micro_usd:null,
  provenance:{id:'fixture',sha256:'a'.repeat(64),reviewed_at:new Date().toISOString()},
  pool_fingerprint_sha256:fixedFeePoolFingerprint(proxies.map(proxy=>({...proxy,...metadata})),['US'])
 }};
 return {proxies,datacenterPool};
}

test('paid datacenter pool binds the full current US inventory in a legacy-neutral projection',()=>{
 const {proxies,datacenterPool}=datacenterFixture();
 const config={proxies,controlPlane:{paidCreditPolicy:{datacenterPool}}};
 const route={...dc,provider:'configured_datacenter',proxy_id:proxies[0].id};
 const original=structuredClone(config);
 const result=estimatePaidPublicDatacenter({config,route,duration_ms:1000});
 assert.equal(result.estimated_micro_usd,0);
 assert.equal(result.binding.pool_fingerprint_sha256,datacenterPool.pricing.pool_fingerprint_sha256);
 assert.deepEqual(config,original);
 assert.equal(estimateRoutePricing({config,route,project:'private',profile:{id:'private',version:1}}).pricing.reason,'attestation_missing');
 assert.equal(estimatePaidPublicDatacenter({config:{proxies,datacenterFixedFeePool:datacenterPool.pricing},route}).estimated_micro_usd,null);
 for(const change of [
  candidate=>{candidate.proxies[1].url='http://different-proxy.sample.net:80';},
  candidate=>{candidate.proxies.pop();},
  candidate=>{candidate.proxies.push({id:'unreviewed',country:'US',url:'http://unreviewed.sample.net:80'});},
  candidate=>{candidate.proxies.push({...candidate.proxies[0],country:'GB'});},
  candidate=>{candidate.proxies[1].provider='other';},
  candidate=>{candidate.controlPlane.paidCreditPolicy.datacenterPool.proxyIds.reverse().push(candidate.proxies[0].id);}
 ]){
  const candidate=structuredClone(config);
  change(candidate);
  assert.equal(estimatePaidPublicDatacenter({config:candidate,route}).estimated_micro_usd,null);
 }
 assert.equal(estimatePaidPublicDatacenter({config,route:{...route,proxy_id:'unknown'}}).estimated_micro_usd,null);
 assert.equal(estimatePaidPublicDatacenter({config,route,transport:'browser'}).estimated_micro_usd,null);
 const unrelated={id:'unrelated',country:'GB',url:'http://unrelated.sample.net:80'};
 assert.equal(estimatePaidPublicDatacenter({config:{...config,proxies:[unrelated,...proxies.toReversed()]},route}).estimated_micro_usd,0);
});

test('paid public destination rules reject ambiguous URL authority and special or mixed answers',()=>{
 const policy=reviewedPublicUrlPolicy({controlPlane:{enabled:true,origins:['https://control.sample.net'],paidCreditPolicy:{publicUrl:{reviewed:true,maxDailyOperations:10}}}});
 for(const url of ['http://source.sample.net','https://127.0.0.1','https://2130706433','https://0x7f000001','https://[2001:4860:4860::8888]',
  'https://source.sample.net:444/','https://source.sample.net@public.net','https://source.sample.net./','https://example.internal','https://metadata.google.internal/',
  'https://control.sample.net/','https://sub.fetchx.ai/','https://source.sample.net/a/../b','https://source.sample.net/a#secret'])
  assert.throws(()=>checkedPublicSourceUrl(url,policy),{code:'destination_rejected'});
 for(const address of ['127.0.0.1','169.254.169.254','168.63.129.16','100.100.100.200','192.0.2.1','::1','::ffff:8.8.8.8','3fff::1','64:ff9b::a00:1'])
  assert.throws(()=>checkedPublicAddresses([{address:'8.8.8.8',family:4},{address,family:net.isIP(address)}]),{code:'destination_rejected'});
 assert.equal(checkedPublicSourceUrl('https://source.sample.net:443/a?q=a%2fb',policy).href,'https://source.sample.net/a?q=a%2fb');
});

test('paid native transport meters TLS and CONNECT and bounds the final raw read on direct and proxy routes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'fetchx-wire-')),sockets=new Set();
 let source,proxy;
 const connected=socket=>{sockets.add(socket);socket.on('error',()=>{});socket.once('close',()=>sockets.delete(socket));return socket;};
 try{
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(root,'key.pem'),'-out',join(root,'cert.pem'),'-days','1',
   '-subj','/CN=source.sample.net','-addext','subjectAltName=DNS:source.sample.net'],{stdio:'ignore'});
  const cert=await readFile(join(root,'cert.pem'));
  source=https.createServer({key:await readFile(join(root,'key.pem')),cert},(req,reply)=>{
   const size=req.url==='/two-megabytes'?2_000_000:req.url==='/large'?80_000:0;
   reply.end(size?Buffer.alloc(size,42):'fixture');
  });
  source.on('connection',connected);
  await new Promise(resolve=>source.listen(0,'127.0.0.1',resolve));
  let connectBytes=0;
  proxy=net.createServer(socket=>{
   connected(socket);
   socket.once('data',header=>{
    assert.match(header.toString(),/^CONNECT 93\.184\.216\.34:443 HTTP\/1.1/);
    const remote=connected(net.connect({host:'127.0.0.1',port:source.address().port}));
    remote.once('connect',()=>{
     const response='HTTP/1.1 200 Connection Established\r\n\r\n';
     connectBytes=header.length+Buffer.byteLength(response);
     socket.write(response);socket.pipe(remote);remote.pipe(socket);
    });
   });
  });
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  const destination={url:new URL('https://source.sample.net/'),address:'93.184.216.34',family:4};
  const limits={timeout_ms:2000,max_encoded_bytes:100_000,max_tunnel_bytes:8000},options={wireMeter:true,tlsImpl:args=>tls.connect({...args,ca:cert}),
   connectImpl:args=>{assert.equal(args.host,destination.address);return net.connect({...args,host:'127.0.0.1',port:source.address().port});}};
  for(const route of [null,{url:`http://127.0.0.1:${proxy.address().port}`}]){
   const response=await nativeHttp({method:'GET',headers:{}},destination,limits,{...options,proxy:route});
   assert.equal(response.encoded.toString(),'fixture');
   assert.ok(response.wire_bytes>1500+(route?connectBytes:0));
   assert.equal(response.wire_bytes_lower_bound,response.wire_bytes);
   assert.equal(response.tunnel_bytes,route?response.wire_bytes:null);
   if(route){
    const large=await nativeHttp({method:'GET',headers:{}},{...destination,url:new URL('/two-megabytes',destination.url)},
     {...limits,max_encoded_bytes:2_250_000,max_tunnel_bytes:2_250_000},{...options,proxy:route});
    assert.equal(large.encoded.length,2_000_000);
    assert.ok(large.wire_bytes>large.encoded.length&&large.wire_bytes<2_250_000);
   }
   await assert.rejects(nativeHttp({method:'GET',headers:{}},destination,{...limits,max_encoded_bytes:3},{...options,proxy:route}),error=>{
    assert.equal(error.code,'encoded_body_limit');
    assert.ok(error.observed_wire_bytes>1500);
    assert.equal(error.observed_wire_bytes,error.wire_bytes_lower_bound);
    return true;
   });
   await assert.rejects(nativeHttp({method:'GET',headers:{}},{...destination,url:new URL('/large',destination.url)},limits,{...options,proxy:route}),error=>{
    assert.equal(error.code,'tunnel_byte_limit');
    assert.ok(error.wire_bytes_lower_bound>limits.max_tunnel_bytes);
    assert.ok(error.wire_bytes_lower_bound<=limits.max_tunnel_bytes+PAID_WIRE_READ_BYTES);
    return true;
   });
  }
 }finally{
  for(const socket of sockets)socket.destroy();
  if(proxy)await new Promise(resolve=>proxy.close(resolve));
  if(source)await new Promise(resolve=>source.close(resolve));
  await rm(root,{recursive:true,force:true});
 }
});

test('paid public fetch reserves the shared wire ceiling and separates customer charges from trial and provider accounting',
 {skip:!process.env.TEST_DATABASE_URL},async()=>{
 assert.match(new URL(process.env.TEST_DATABASE_URL).pathname,/^\/gateway_test_[A-Za-z0-9_]+$/);
 const root=await mkdtemp(join(tmpdir(),'fetchx-paid-gateway-')),store=new Store(process.env.TEST_DATABASE_URL);
 const project='cp_'+randomUUID(),user=randomUUID(),privateProfile={id:'trial',version:1};
 const {proxies,datacenterPool}=datacenterFixture(),originalProxies=structuredClone(proxies);
 const config={release:'paid-fixture',artifactDir:root,artifactKey:'8e'.repeat(32),maxDailyFallbackCredits:0,proxies,
  projects:{[project]:{profiles:[],v2_access_profiles:['trial@1'],v2_entitlement:{mode:'metered',max_daily_operations:1}}},
  v2:{accessProfiles:{'trial@1':{...privateProfile,origins:['https://trial.sample.net'],methods:['GET'],headers:[],proxy_classes:['direct'],countries:[]}}},
  residential:{maxTotalBytes:3e9,maxDailyBytes:3e9,providers:{evomi:{enabled:true,username:'fixture-user',password:'fixture-pass',
   countries:['US'],maxTotalBytes:3e9,microUsdPerGB:1e6}}},
  controlPlane:{enabled:true,creditPolicy:{reviewed:true,version:'trial-test',trialCredits:1,weights:{direct:1},maxEstimatedMicroUsdPerOperation:0},
   paidCreditPolicy:{reviewed:true,version:'paid-test',datacenterPool,routes:[{accessProfile:PUBLIC_URL_REF,...dc,provider:'oxylabs'},
    {accessProfile:PUBLIC_URL_REF,...res,provider:'evomi'},{accessProfile:privateProfile,...direct,provider:'direct'}],
   dns:{reviewed:true,endpoint:'https://resolver.sample.net/resolve',address:'1.1.1.1'},publicUrl:{reviewed:true,maxDailyOperations:9}}}};
 const dnsCalls=[],targetCalls=[],largeFile=Buffer.alloc(2_000_000,42);
 const redirectChunk=randomBytes(16_000);
 const compressedRedirectBody=gzipSync(Buffer.concat(Array(38).fill(redirectChunk)).subarray(0,600_000));
 let mode='normal',pendingBody;
 function holdBody(path){
  const {promise:started,resolve:arrive}=Promise.withResolvers(),{promise:released,resolve:release}=Promise.withResolvers();
  pendingBody={path,arrive,released};
  return {started,release};
 }
 const gateway=new Gateway({store,config,profiles:{},resolve:async host=>{assert.equal(host,'trial.sample.net');return [{address:'93.184.216.34',family:4}];}});
 const v2=new V2Gateway(gateway,{
  dnsHttp:async(_input,destination,limits,{proxy,wireMeter})=>{
   assert.equal(wireMeter,true);assert.equal(destination.address,'1.1.1.1');
   const host=destination.url.searchParams.get('name'),type=Number(destination.url.searchParams.get('type'));
   dnsCalls.push({host,type,remaining:limits.max_tunnel_bytes,proxy:proxy?.id});
   if(mode==='pool-drift')proxies.find(member=>member.id!==proxy.id).url='http://unreviewed.sample.net:80';
   const addresses=type===1?mode==='mixed'?['93.184.216.34','127.0.0.1']:['93.184.216.34']:[];
   const encoded=Buffer.from(JSON.stringify({Status:0,Question:[{name:host,type}],Answer:addresses.map(data=>({name:host,type,data}))}));
   return {status:200,headers:{},encoded,wire_bytes:1000,wire_bytes_lower_bound:1000};
  },
  http:async(input,destination,limits,{proxy,wireMeter})=>{
   const path=destination.url.pathname;
   targetCalls.push({url:destination.url.href,remaining:limits.max_tunnel_bytes,maxEncoded:limits.max_encoded_bytes,proxy:proxy?.id});
   if(pendingBody?.path===path){pendingBody.arrive();await pendingBody.released;}
   assert.equal(destination.address,'93.184.216.34');
   assert.equal(input.headers.cookie,undefined);
   if(!wireMeter){
    assert.equal(limits.max_encoded_bytes,1048576);
    assert.equal(limits.max_decoded_bytes,4194304);
    return {status:200,headers:{},encoded:Buffer.from('trial')};
   }
   if(path==='/two-megabytes'){
    const wire=largeFile.length+1200;
    if(wire>limits.max_tunnel_bytes)throw Object.assign(new GatewayError('tunnel_byte_limit',502),{
     wire_dispatched:true,observed_wire_bytes:limits.max_tunnel_bytes+1,wire_bytes_lower_bound:limits.max_tunnel_bytes+1});
    assert.ok(largeFile.length<=limits.max_encoded_bytes);
    return {status:200,headers:{'content-type':'application/octet-stream','content-disposition':'attachment; filename="fixture.bin"'},
     encoded:largeFile,wire_bytes:wire,wire_bytes_lower_bound:wire};
   }
   if(['/compressed-redirect','/compressed-final'].includes(path)){
    const redirect=path==='/compressed-redirect',wire=compressedRedirectBody.length+1200;
    return {status:redirect?302:200,headers:{'content-encoding':'gzip',...(redirect?{location:'/compressed-final'}:{})},
     encoded:compressedRedirectBody,wire_bytes:wire,wire_bytes_lower_bound:wire};
   }
   if(['/decoded-over-default','/decoded-over-hard-max','/expansion-limit'].includes(path)){
    const sizes={'/decoded-over-default':1_100_000,'/decoded-over-hard-max':20_000_001,'/expansion-limit':50_000};
    const encoded=gzipSync(Buffer.alloc(sizes[path])),wire=encoded.length+1200;
    return {status:200,headers:{'content-encoding':'gzip'},encoded,wire_bytes:wire,wire_bytes_lower_bound:wire};
   }
   if(mode==='unknown')throw Object.assign(new GatewayError('source_timeout_unknown',502),{wire_dispatched:true,observed_wire_bytes:null,wire_bytes_lower_bound:8});
   if(mode==='cap')throw Object.assign(new GatewayError('tunnel_byte_limit',502),{wire_dispatched:true,observed_wire_bytes:null,wire_bytes_lower_bound:limits.max_tunnel_bytes+1});
   if(mode==='internal')throw Error('synthetic internal failure');
   if(destination.url.pathname==='/cross')return {status:302,headers:{location:'https://other.sample.net/'},encoded:Buffer.alloc(0),wire_bytes:400,wire_bytes_lower_bound:400};
   if(destination.url.pathname==='/redirect')return {status:302,headers:{location:'/final','set-cookie':['blocked=value; Secure']},encoded:Buffer.alloc(0),wire_bytes:400,wire_bytes_lower_bound:400};
   return {status:mode==='source-error'?503:200,headers:{},encoded:Buffer.from('fixture'),wire_bytes:mode==='res-step'?249000:500,wire_bytes_lower_bound:mode==='res-step'?249000:500};
  }
 });
 const fetch=new PublicFetchGateway(v2),identity={keyId:'console'};
 const request=(key,fields={})=>fetch.fetch(project,{idempotency_key:key,url:'https://public.sample.net/',proxy:dc,...fields},identity);
 v2.pace=async()=>{};
 try{
  await store.init();
  await store.tx(async c=>{
   await c.query('INSERT INTO control_users(id,email) VALUES($1,$2)',[user,`paid-${user}@example.test`]);
   await c.query('INSERT INTO control_projects(id,user_id,name,template_hash) VALUES($1,$2,$3,$4)',[project,user,'Paid test',sha('paid test')]);
   await grantInitialCredits(c,project,1);
  });
  assert.equal(await v2.paidCreditReady(project,{publicOnly:true,purchaseCredits:10000}),true);
  assert.equal(await v2.paidCreditReady(project,{publicOnly:true,purchaseCredits:1000000}),false);
  const {paid_http:paidCapabilities}=await v2.capabilities(project);
  assert.deepEqual(paidCapabilities.public_url_access_profile,PUBLIC_URL_REF);
  assert.equal(paidCapabilities.public_url_transfer_limits.max_decoded_bytes,20_000_000);
  const listed=(await v2.profiles(project)).access_profiles.find(profile=>profile.id===PUBLIC_URL_REF.id);
  assert.deepEqual(listed.route_reservations.map(route=>[route.class,route.paid_credit_reservation.reserved_credits]),[['datacenter',1],['residential',5]]);
  assert.equal(listed.limits.max_encoded_bytes,20_000_000);
  assert.equal(listed.limits.max_session_encoded_bytes,60_000_000);
  assert.equal(listed.transfer_limits.body_limit_basis,'aggregate_authorized_transfer_ceiling');
  proxies.push({id:'extra-unreviewed',country:'US',url:'http://unreviewed.sample.net:80'});
  assert.equal(await v2.paidCreditReady(project,{publicOnly:true,proxyClass:'datacenter'}),false);
  await assert.rejects(request('unreviewed-pool'),{code:'paid_credit_route_forbidden'});
  proxies.pop();
  assert.deepEqual(proxies,originalProxies);
  await assert.rejects(request('no-balance'),{code:'paid_credit_balance_exhausted'});
  await assert.rejects(request('too-few',{proxy:res,max_credits:4}),{code:'max_credits_exceeded'});
  await assert.rejects(request('private-ip',{url:'https://127.0.0.1/'}),{code:'destination_rejected'});
  await assert.rejects(request('credentials',{headers:{authorization:'Basic dGVzdA=='}}),{code:'credential_scope_rejected'});
  await assert.rejects(request('retry',{retry:true}),{code:'paid_credit_retry_unsupported'});
  assert.equal(dnsCalls.length,0);
  await store.tx(c=>v2.controlPaidCredits.grantPaidCredits(c,{project,mode:'live',accountId:'acct_fixture',checkoutSessionId:'cs_live_fixture',paymentIntentId:'pi_fixture',credits:10000,amountMinor:200,currency:'usd'}));
  config.v2.maxArtifactBytes=70_000_000;
  const trialGate=holdBody('/legacy-trial'),trialRequest=request('trial',{access_profile:privateProfile,url:'https://trial.sample.net/legacy-trial',proxy:direct});
  let trial;
  try{
   await Promise.race([trialGate.started,trialRequest.then(()=>assert.fail('trial must be active'))]);
   await assert.rejects(request('pending-trial-capacity',{max_transfer_mb:20}),{code:'artifact_quota'});
  }finally{trialGate.release();trial=await trialRequest;}
  assert.equal(trial.usage.accounting.request_credits.state,'settled');
  delete config.v2.maxArtifactBytes;
  const fields={url:'https://public.sample.net/redirect',max_transfer_mb:20,max_credits:20};
  const redirected=await request('redirect',fields);
  assert.equal(redirected.success,true);
  assert.equal(redirected.usage.wire_bytes,4900);
  assert.equal(redirected.usage.accounting.paid_credits.reserved_credits,20);
  assert.equal(redirected.usage.accounting.paid_credits.used_credits,1);
  assert.equal(redirected.usage.accounting.reserved_tunnel_bytes,20_000_000+PAID_WIRE_READ_BYTES);
  assert.deepEqual(dnsCalls.map(call=>call.remaining),[20_000_000,19_999_000,19_997_600,19_996_600]);
  assert.deepEqual(await request('redirect',fields),redirected);
  assert.equal(dnsCalls.length,4);
  await assert.rejects(request('redirect',{...fields,max_credits:21}),{code:'idempotency_conflict'});
  mode='res-step';
  const residential=await request('res-step',{proxy:res,max_transfer_mb:.5});
  assert.equal(residential.usage.accounting.paid_credits.used_credits,10);
  assert.equal(dnsCalls.at(-1).proxy,targetCalls.at(-1).proxy);
  mode='mixed';
  const targetsBefore=targetCalls.length,mixed=await request('mixed',{proxy:res});
  assert.equal(mixed.error.code,'destination_rejected');
  assert.equal(mixed.usage.accounting.paid_credits.used_credits,0);
  assert.equal(targetCalls.length,targetsBefore);
  assert.equal((await store.pool.query('SELECT state FROM v2_ledger WHERE operation=$1',[mixed.operation_id])).rows[0].state,'unreconciled');
  mode='source-error';
  assert.equal((await request('source-error')).usage.accounting.paid_credits.used_credits,1);
  mode='cap';
  const capped=await request('cap',{proxy:res});
  assert.equal(capped.error.code,'max_transfer_bytes_exceeded');
  assert.equal(capped.usage.accounting.paid_credits.settlement_basis,'confirmed_cap');
  assert.equal(capped.usage.accounting.paid_credits.used_credits,5);
  assert.equal(capped.state,'unknown');
  assert.equal(capped.error.details.next,undefined);
  assert.equal(capped.retry.next_action,'recover_first');
  mode='unknown';
  const uncertain=await request('unknown',{proxy:res});
  assert.equal(uncertain.state,'unknown');
  assert.equal(uncertain.usage.accounting.paid_credits.state,'held');
  assert.equal((await request('unknown',{proxy:res})).operation_id,uncertain.operation_id);
  mode='internal';
  const internal=await request('internal');
  assert.equal(internal.usage.accounting.paid_credits.used_credits,0);
  assert.equal(internal.usage.accounting.paid_credits.settlement_basis,'fetchx_failure_refund');
  assert.equal((await store.pool.query('SELECT state FROM v2_ledger WHERE operation=$1',[internal.operation_id])).rows[0].state,'unknown');
  mode='normal';
  const cross=await request('cross',{url:'https://public.sample.net/cross'});
  assert.equal(cross.error.code,'redirect_origin_rejected');
  assert.equal(targetCalls.at(-1).url,'https://public.sample.net/cross');
  mode='pool-drift';
  const beforeDrift={dns:dnsCalls.length,target:targetCalls.length},drift=await request('pool-drift');
  assert.equal(drift.error.code,'pricing_attestation_unavailable');
  assert.equal(drift.usage.accounting.paid_credits.settlement_basis,'fetchx_failure_refund');
  assert.equal(drift.usage.accounting.paid_credits.used_credits,0);
  assert.equal(dnsCalls.length,beforeDrift.dns+1);
  assert.equal(targetCalls.length,beforeDrift.target);
  assert.equal((await store.pool.query('SELECT state FROM v2_ledger WHERE operation=$1',[drift.operation_id])).rows[0].state,'unreconciled');
  assert.deepEqual(await request('redirect',fields),redirected);
  proxies.splice(0,proxies.length,...originalProxies);
  await assert.rejects(request('quota'),{code:'paid_public_url_daily_quota_exhausted'});
  config.controlPlane.paidCreditPolicy.publicUrl.maxDailyOperations=20;
  mode='normal';
  const fileFields={url:'https://public.sample.net/two-megabytes'};
  const defaultFile=await request('large-default',fileFields);
  assert.equal(defaultFile.error.code,'max_transfer_bytes_exceeded');
  assert.match(defaultFile.error.message,/max_transfer_mb.*reserves credits/);
  assert.deepEqual(defaultFile.error.details,{max_transfer_mb:1,max_allowed_transfer_mb:20,reserved_credits:1,
   next:{max_transfer_mb:1.25,max_credits:2,requires_new_idempotency_key:true}});
  const largerFields={...fileFields,max_transfer_mb:2.25,max_credits:3};
  const larger=await request('large-file',largerFields);
  assert.equal(larger.success,true);
  assert.equal(larger.artifacts[0].kind,'download');
  assert.deepEqual(Buffer.from(larger.data.body_base64,'base64'),largeFile);
  assert.equal(larger.usage.decoded_bytes,2_000_000);
  assert.equal(larger.usage.accounting.paid_credits.used_credits,3);
  assert.equal(targetCalls.at(-1).maxEncoded,2_248_000);
  const reservation=(await store.pool.query(`SELECT l.reserved_encoded_bytes,l.reserved_tunnel_bytes,e.detail
   FROM v2_ledger l JOIN v2_ledger_events e ON e.operation=l.operation AND e.event='reserve' WHERE l.operation=$1`,[larger.operation_id])).rows[0];
  assert.equal(Number(reservation.reserved_encoded_bytes),2_250_000);
  assert.equal(Number(reservation.reserved_tunnel_bytes),2_250_000+PAID_WIRE_READ_BYTES);
  assert.deepEqual(reservation.detail.body_limits,{max_encoded_bytes:2_250_000,max_decoded_bytes:2_250_000});
  const afterLarge=targetCalls.length;
  assert.deepEqual(await request('large-file',largerFields),larger);
  assert.equal(targetCalls.length,afterLarge);
  await assert.rejects(request('large-file',{...largerFields,max_transfer_mb:2.5}),{code:'idempotency_conflict'});

  const decoded=await request('decoded-over-default',{url:'https://public.sample.net/decoded-over-default'});
  assert.equal(decoded.error.code,'decoded_body_limit');
  assert.equal(decoded.error.details.next.max_transfer_mb,1.25);
  assert.equal(decoded.data.body_base64,null);
  assert.equal(decoded.usage.accounting.paid_credits.used_credits,1);
  const aggregate=await request('aggregate-decoded',{url:'https://public.sample.net/compressed-redirect'});
  assert.equal(aggregate.error.code,'decoded_body_limit');
  assert.deepEqual(aggregate.artifacts.map(artifact=>artifact.decoded_bytes),[600_000,null]);
  const hardDecoded=await request('decoded-over-hard-max',{url:'https://public.sample.net/decoded-over-hard-max',max_transfer_mb:20});
  assert.equal(hardDecoded.error.code,'decoded_body_limit');
  assert.equal(hardDecoded.error.details.max_transfer_mb,20);
  assert.equal(hardDecoded.error.details.next,undefined);
  assert.equal(hardDecoded.data.body_base64,null);
  const expansion=await request('expansion-limit',{url:'https://public.sample.net/expansion-limit'});
  assert.equal(expansion.error.code,'decompression_ratio_limit');
  assert.equal(expansion.error.details,undefined);

  config.v2.maxArtifactBytes=80_000_000;
  const storageGate=holdBody('/held-download');
  const first=request('first-storage-reservation',{url:'https://public.sample.net/held-download',max_transfer_mb:20});
  try{
   await Promise.race([storageGate.started,first.then(()=>assert.fail('first storage reservation must be active'))]);
   const beforeSecond=targetCalls.length;
   await assert.rejects(request('second-storage-reservation',{max_transfer_mb:20}),{code:'artifact_quota'});
   assert.equal(targetCalls.length,beforeSecond);
  }finally{storageGate.release();await first;}
  assert.equal((await request('second-storage-reservation',{max_transfer_mb:20})).success,true);
  assert.equal((await v2.usage(project)).request_credits.settled,1);
  assert.equal((await v2.usage(project)).paid_credits.held,5);
 }finally{
  await store.close();
  await rm(root,{recursive:true,force:true});
 }
});
