import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {Gateway} from '../src/gateway.mjs';
import {V2Gateway} from '../src/v2.mjs';
import {server} from '../src/main.mjs';
import {sha} from '../src/crypto.mjs';
import {discoveryOrigins,discoveryPolicy} from '../src/v2-discovery.mjs';

test('discovery origins are canonical public HTTPS names, with no path, credentials, literals or internal names',()=>{
 assert.deepEqual(discoveryOrigins(['https://county.gov:443','https://collector.county.gov','https://county.gov']),['https://collector.county.gov','https://county.gov']);
 for(const raw of [null,[],[23],['http://county.gov'],['https://county.gov/'],['https://county.gov/path'],['https://county.gov?'],['https://county.gov#'],['https://county.gov/#token'],['https://user:secret@county.gov'],['https://county.gov:8443'],['https://127.0.0.1'],['https://8.8.8.8'],['https://2130706433'],['https://0x7f000001'],['https://[::1]'],['https://[2606:4700::1111]'],['https://localhost'],['https://metadata.google.internal'],['https://service.cluster.local'],['https://county.lan'],['https://county.invalid'],['https://county.test'],['https://county.example'],['https://county.gov.'],['https://*.county.gov'],['https://county.gov\\@evil.gov'],[' https://county.gov'],['https://county.gov\n'],Array(21).fill('https://county.gov')])assert.throws(()=>discoveryOrigins(raw));
});

test('discovery policy chooses bounded read-only direct limits and fails closed on caller-like configuration expansion',()=>{
 const config={projects:{a:{v2_discovery_policy:{enabled:true,max_profiles:5,max_origins:6}}}};
 const policy=discoveryPolicy(config,'a');assert.equal(policy.limits.max_redirects,0);assert.equal(policy.limits.max_input_bytes,1);assert.equal(policy.limits.max_tunnel_bytes,1);assert.equal(discoveryPolicy(config,'missing').enabled,false);
 for(const patch of [{max_profiles:0},{max_profiles:1001},{max_origins:21},{methods:['POST']},{limits:{max_requests:101}},{limits:{max_tunnel_bytes:100000}},{limits:{min_interval_ms:0}},{limits:{max_requests:1,max_redirects:2}}])assert.throws(()=>discoveryPolicy({projects:{a:{v2_discovery_policy:{...config.projects.a.v2_discovery_policy,...patch}}}},'a'),{code:'discovery_policy_configuration'});
});

test('project discovery provisioning is immutable, isolated, capped atomically, and dispatches only reviewed direct GET/HEAD origins',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 assert.match(new URL(process.env.TEST_DATABASE_URL).pathname,/^\/gateway_test_[A-Za-z0-9_]+$/);
 const root=await mkdtemp(join(tmpdir(),'fetchx-discovery-')),store=new Store(process.env.TEST_DATABASE_URL);await store.init();
 await store.pool.query('TRUNCATE v2_discovery_profiles,v2_registry,v2_ledger_events,v2_artifacts,v2_ledger,v2_operations,v2_sessions,workflows,source_limits RESTART IDENTITY CASCADE');
 const policy={enabled:true,max_profiles:10,max_origins:3,limits:{max_encoded_bytes:512,max_decoded_bytes:4096,max_session_encoded_bytes:8192,min_interval_ms:250}};
 const config={release:'discovery-offline',artifactDir:root,artifactKey:'31'.repeat(32),maxDailyFallbackCredits:0,projects:{a:{tokenHash:sha('key-a'),profiles:[],v2_access_profiles:['reviewed@1'],v2_discovery_policy:structuredClone(policy)},b:{tokenHash:sha('key-b'),profiles:[],v2_access_profiles:[],v2_discovery_policy:structuredClone(policy)},c:{tokenHash:sha('key-c'),profiles:[]},d:{tokenHash:sha('key-d'),profiles:[],v2_discovery_policy:{...structuredClone(policy),max_profiles:1}}},proxies:[],v2:{accessProfiles:{'reviewed@1':{id:'reviewed',version:1,origins:['https://reviewed.gov'],methods:['GET'],headers:['accept'],proxy_classes:['direct'],countries:[]}}}};
 let dnsCalls=0;const calls=[];
 const gateway=new Gateway({store,config,profiles:{},resolve:async host=>{dnsCalls++;return [{address:host==='rebound.gov'?'127.0.0.1':'93.184.216.34',family:4}];}});
 gateway.v2=new V2Gateway(gateway,{http:async(input,destination,limits,options)=>{
  calls.push({input,destination,options});
  return {status:input.url.endsWith('/hop')||input.url.endsWith('/outside')?302:200,headers:{'content-type':'text/html',...(input.url.endsWith('/hop')?{location:'https://collector.gov/landing','set-cookie':['sid=public; Domain=county.gov; Path=/; Secure']}:input.url.endsWith('/outside')?{location:'https://unseeded.gov/landing'}:{})},encoded:Buffer.from('synthetic source'),provider_status:null,tunnel_bytes:null};
 }});
 const app=server(gateway),headers=id=>({authorization:'Bearer key-'+id});
 const post=async(path,payload,id='a')=>{const result=await app.inject({method:'POST',url:path,payload,headers:headers(id)});return {status:result.statusCode,body:result.json()};};
 const get=async(path,id='a')=>{const result=await app.inject({url:path,headers:headers(id)});return {status:result.statusCode,body:result.json()};};
 const seed={idempotency_key:'manual-seed',origins:['https://county.gov','https://collector.gov']};
 const makeSession=async(ref,id='a',proxy={class:'direct',country:null,affinity:'session'})=>post('/v2/sessions',{idempotency_key:randomUUID(),access_profile:ref,transport:'http',proxy},id);
 const operation=async(session,url,extra={})=>post('/v2/operations',{idempotency_key:randomUUID(),session_id:session,request:{url,...extra},max_estimated_micro_usd:0});
 try{
  assert.equal((await app.inject({method:'POST',url:'/v2/discovery-profiles',payload:seed})).statusCode,401);
  assert.equal((await get('/v2/capabilities')).body.features.discovery_profiles,true);assert.equal((await get('/v2/capabilities','c')).body.features.discovery_profiles,false);
  assert.equal((await post('/v2/discovery-profiles',seed,'c')).body.error,'discovery_profiles_disabled');
  const first=await post('/v2/discovery-profiles',seed);assert.equal(first.status,200);assert.match(first.body.access_profile.id,/^discovery:/);assert.equal(first.body.access_profile.version,1);assert.deepEqual(first.body.profile.methods,['GET','HEAD']);assert.deepEqual(first.body.profile.proxy_classes,['direct']);assert.equal(first.body.profile.max_paid_cost_micro_usd,0);assert.equal(first.body.profile.limits.max_redirects,0);assert.equal(dnsCalls,0);assert.equal(calls.length,0);
  assert.deepEqual((await post('/v2/discovery-profiles',seed)).body,first.body);
  const restarted=new V2Gateway(gateway);assert.deepEqual((await restarted.profile('a',first.body.access_profile)).origins,first.body.profile.origins);assert.deepEqual(JSON.parse(JSON.stringify(await restarted.discoveryProfile('a',seed))),first.body);assert.deepEqual(config.projects.a.v2_access_profiles,['reviewed@1']);
  assert.equal((await post('/v2/discovery-profiles',{...seed,origins:['https://another.gov']})).body.error,'idempotency_conflict');
  const duplicates=await Promise.all(Array.from({length:5},()=>post('/v2/discovery-profiles',seed)));assert.ok(duplicates.every(r=>r.body.access_profile.id===first.body.access_profile.id));assert.equal(Number((await store.pool.query('SELECT count(*) AS n FROM v2_discovery_profiles WHERE project=$1',['a'])).rows[0].n),1);
  for(const extra of [{methods:['POST']},{headers:['authorization']},{proxy_class:'residential'},{limits:{max_requests:1000}},{paths:['.*']},{origins:['https://county.gov'],profile:{id:'reviewed',version:1}}])assert.equal((await post('/v2/discovery-profiles',{...seed,idempotency_key:randomUUID(),...extra})).status,400);
  assert.equal((await post('/v2/discovery-profiles',{idempotency_key:'too-many',origins:['https://one.gov','https://two.gov','https://three.gov','https://four.gov']})).body.error,'discovery_origins_limit');
  const profiles=(await get('/v2/access-profiles')).body.access_profiles;assert.ok(profiles.some(p=>p.id==='reviewed'));assert.ok(profiles.some(p=>p.id===first.body.access_profile.id));assert.ok(!(await get('/v2/access-profiles','b')).body.access_profiles.some(p=>p.id===first.body.access_profile.id));
  assert.equal((await makeSession(first.body.access_profile,'b')).body.error,'access_profile_forbidden');
  const bSeed=await post('/v2/discovery-profiles',seed,'b');assert.notEqual(bSeed.body.access_profile.id,first.body.access_profile.id);
  const session=(await makeSession(first.body.access_profile)).body;const ok=await operation(session.id,'https://county.gov/lookup');assert.equal(ok.body.state,'completed');assert.equal(ok.body.accounting.estimated_micro_usd,0);assert.equal(ok.body.accounting.reserved_tunnel_bytes,0);assert.equal(calls.at(-1).options.proxy,null);
  const head=await operation(session.id,'https://county.gov/lookup',{method:'HEAD'});assert.equal(head.body.state,'completed');assert.equal(calls.at(-1).input.method,'HEAD');
  const before=calls.length;assert.equal((await operation(session.id,'https://county.gov/lookup',{method:'POST'})).body.error,'method_rejected');
  for(const credentials of [{authorization:'Bearer source-secret'},{cookie:'loggedin=1'},{'x-api-key':'source-secret'}]){const rejected=await operation(session.id,'https://county.gov/lookup',{headers:credentials});assert.equal(rejected.body.state,'failed');assert.equal(rejected.body.result.physical_requests,0);}
  assert.equal((await operation(session.id,'https://unseeded.gov/lookup')).body.error,'destination_rejected');assert.equal(calls.length,before);
  assert.equal((await makeSession(first.body.access_profile,'a',{class:'residential',country:'US',affinity:'session'})).body.error,'proxy_class_forbidden');
  const redirect=await operation(session.id,'https://county.gov/hop');assert.equal(redirect.body.error,'redirect_limit');assert.equal(redirect.body.result.physical_requests,1);
  config.projects.a.v2_discovery_policy.limits.max_redirects=1;
  const cross=await post('/v2/discovery-profiles',{...seed,idempotency_key:'explicit-redirects'});const crossSession=(await makeSession(cross.body.access_profile)).body;
  const approvedRedirect=await operation(crossSession.id,'https://county.gov/hop');assert.equal(approvedRedirect.body.state,'completed');assert.equal(approvedRedirect.body.result.physical_requests,2);assert.equal(calls.at(-1).input.url,'https://collector.gov/landing');assert.equal(calls.at(-1).input.headers.cookie,undefined);
  const outside=await operation(crossSession.id,'https://county.gov/outside');assert.equal(outside.body.error,'destination_rejected');assert.equal(outside.body.result.physical_requests,1);
  const rebound=await post('/v2/discovery-profiles',{idempotency_key:'rebind',origins:['https://rebound.gov']});const reboundSession=(await makeSession(rebound.body.access_profile)).body;const noDispatch=calls.length;
  const privateResult=await operation(reboundSession.id,'https://rebound.gov/');assert.equal(privateResult.body.error,'destination_rejected');assert.equal(privateResult.body.result.physical_requests,0);assert.equal(calls.length,noDispatch);
  const cap=await Promise.all(['one','two','three'].map(id=>post('/v2/discovery-profiles',{idempotency_key:id,origins:['https://'+id+'.gov']},'d')));assert.equal(cap.filter(r=>r.status===200).length,1);assert.equal(cap.filter(r=>r.body.error==='discovery_profiles_limit').length,2);
  const saved=(await store.pool.query('SELECT profile FROM v2_discovery_profiles WHERE id=$1',[first.body.access_profile.id])).rows[0].profile;await store.pool.query("UPDATE v2_discovery_profiles SET profile=profile || '{\"methods\":[\"POST\"]}'::jsonb WHERE id=$1",[first.body.access_profile.id]);await assert.rejects(gateway.v2.profile('a',first.body.access_profile),{code:'discovery_profile_invalid'});await store.pool.query('UPDATE v2_discovery_profiles SET profile=$2 WHERE id=$1',[first.body.access_profile.id,saved]);
  config.projects.a.v2_discovery_policy.limits.max_encoded_bytes=256;
  assert.deepEqual((await post('/v2/discovery-profiles',seed)).body,first.body);assert.equal((await makeSession(first.body.access_profile)).body.error,'discovery_policy_changed');assert.ok(!(await get('/v2/access-profiles')).body.access_profiles.some(p=>p.id===first.body.access_profile.id));
  config.projects.a.v2_discovery_policy.enabled=false;assert.equal((await get('/v2/capabilities')).body.features.discovery_profiles,false);assert.equal((await makeSession(first.body.access_profile)).body.error,'access_profile_forbidden');assert.equal((await post('/v2/discovery-profiles',seed)).body.error,'discovery_profiles_disabled');assert.equal((await get('/v2/access-profiles')).body.access_profiles.length,1);
  const invalidConfig=structuredClone(config);invalidConfig.v2.accessProfiles['discovery:static@1']={...invalidConfig.v2.accessProfiles['reviewed@1'],id:'discovery:static'};assert.throws(()=>new V2Gateway({...gateway,config:invalidConfig}),{code:'discovery_namespace_reserved'});
  assert.equal(Number((await store.pool.query('SELECT count(*) AS n FROM residential_usage')).rows[0].n),0);assert.ok((await store.pool.query('SELECT reserved_tunnel_bytes FROM v2_ledger')).rows.every(r=>Number(r.reserved_tunnel_bytes)===0));
 }finally{await app.close();await store.pool.query('TRUNCATE v2_discovery_profiles,v2_registry,v2_ledger_events,v2_artifacts,v2_ledger,v2_operations,v2_sessions RESTART IDENTITY CASCADE');await store.close();await rm(root,{recursive:true,force:true});}
});
