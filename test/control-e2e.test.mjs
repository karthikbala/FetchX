import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {Store} from '../src/store.mjs';
import {Gateway} from '../src/gateway.mjs';
import {GatewayError} from '../src/policy.mjs';
import {server} from '../src/main.mjs';
import {ControlIdentity} from '../src/control-identity.mjs';
import {ControlCredits} from '../src/control-credits.mjs';
import {V2Gateway} from '../src/v2.mjs';

const ORIGIN='http://127.0.0.1:4331';
const ALL_SCOPES=['fetch:read','fetch:write','usage:read','profiles:read'];

function configuration(root){
 const profile={id:'control-source',version:1,origins:['https://source.example'],paths:['^/'],methods:['GET','HEAD'],headers:['accept','content-type'],proxy_classes:['direct'],countries:[],limits:{max_requests:100,max_encoded_bytes:16384,max_decoded_bytes:32768,max_session_encoded_bytes:65536,max_input_bytes:1024,max_tunnel_bytes:16384,max_redirects:0,max_expansion_ratio:100,timeout_ms:2000,min_interval_ms:0,ttl_seconds:900}};
 return {release:'control-offline-acceptance',artifactDir:root,artifactKey:randomBytes(32).toString('hex'),projects:{},proxies:[],maxDailyFallbackCredits:0,
  v2:{accessProfiles:{'control-source@1':profile}},controlPlane:{enabled:true,origins:[ORIGIN],bridgeSecret:randomBytes(32).toString('hex'),sessionSecure:false,allowLoopbackDevelopment:true,apiBaseUrl:'http://127.0.0.1:8789',
   projectTemplate:{id:'control-test-v1',v2_access_profiles:['control-source@1'],v2_entitlement:{mode:'metered',max_daily_operations:100}},
   creditPolicy:{reviewed:true,version:'control-test-v1',trialCredits:10,weights:{direct:1},maxEstimatedMicroUsdPerOperation:0}}};
}

// Every table, including migrations and source cooldowns, lives in a fresh schema.
// Neither setup nor teardown truncates data belonging to another test file.
test('self-service: verified identity, tenant isolation, native fetch and conservative credits',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const url=new URL(process.env.TEST_DATABASE_URL);
 assert.ok(['postgres:','postgresql:'].includes(url.protocol),'PostgreSQL URL required');
 assert.match(decodeURIComponent(url.pathname),/^\/gateway_test_[A-Za-z0-9_]+$/,'explicit disposable gateway_test_* database required');
 const schema='control_e2e_'+randomUUID().replaceAll('-','');
 const admin=new pg.Pool({connectionString:url.href,max:1});
 const root=await mkdtemp(join(tmpdir(),'fetchx-control-e2e-'));
 let store,app,releaseBlocked;
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set('options',`-csearch_path=${schema}`);
  store=new Store(url.href);await store.init();
  assert.equal((await store.pool.query('SELECT current_schema() AS name')).rows[0].name,schema);
  const config=configuration(root),mailbox=[],dispatches=[];
  const gateway=new Gateway({store,config,profiles:{},resolve:async()=>[{address:'93.184.216.34',family:4}]});
  gateway.controlIdentity=new ControlIdentity({store,config,mail:{configured:true,sendCode:async message=>{mailbox.push(message);}}});
  gateway.controlCredits=new ControlCredits({store,config});
  let mode='success',entered;
  gateway.v2=new V2Gateway(gateway,{browserRuntime:async()=>({available:false,reason:'offline_fixture'}),http:async(input,destination,limits,{proxy})=>{
   assert.equal(proxy,null,'offline control profile never selects a paid provider');
   assert.equal(destination.address,'93.184.216.34');
   dispatches.push({url:input.url,method:input.method,headers:{...input.headers}});
   if(mode==='blocked'){entered.resolve();await new Promise(resolve=>{releaseBlocked=resolve;});}
   if(mode==='unknown')throw Object.assign(new GatewayError('source_timeout_unknown',504),{observed_encoded_bytes:0,observed_tunnel_bytes:0});
   const encoded=Buffer.from(JSON.stringify({fixture:true,value:42}));
   return {status:mode==='forbidden'?403:200,headers:{'content-type':'application/json; charset=utf-8'},raw_headers:['content-type','application/json; charset=utf-8'],encoded,tunnel_bytes:null,provider_status:null};
  }});
  app=server(gateway);
  const bridge={origin:ORIGIN,'x-fetchx-control-secret':config.controlPlane.bridgeSecret};
  const request=async(method,path,payload,actor,overrides={})=>{
   const headers={...bridge,...(actor?{cookie:actor.cookie,'x-csrf-token':actor.csrf}:{}),...overrides};
   for(const key of Object.keys(headers))if(headers[key]===undefined)delete headers[key];
   const response=await app.inject({method,url:'/control'+path,headers,...(payload===undefined?{}:{payload})});
   assert.equal(response.headers['cache-control'],'no-store');
   return {status:response.statusCode,body:response.json(),headers:response.headers};
  };
  const native=async(method,path,payload,token)=>{
   const response=await app.inject({method,url:path,headers:token?{authorization:'Bearer '+token}:{},...(payload===undefined?{}:{payload})});
   return {status:response.statusCode,body:response.json()};
  };
  const payload=key=>({idempotency_key:key,access_profile:{id:'control-source',version:1},url:'https://source.example/data',proxy:{class:'direct',country:null},max_estimated_micro_usd:0});
  const noDispatch=async fn=>{const before=dispatches.length;await fn();assert.equal(dispatches.length,before,'rejected/read-only requests must not dispatch');};
  const codeFor=async email=>{
   const result=await request('POST','/auth/code',{email});assert.equal(result.status,200);
   assert.deepEqual(Object.keys(result.body).sort(),['accepted','challenge_id','expires_in']);assert.equal(result.body.accepted,true);
   const message=mailbox.findLast(m=>m.challenge_id===result.body.challenge_id);assert.ok(message);assert.match(message.code,/^\d{8}$/);
   assert.ok(!JSON.stringify(result.body).includes(message.code),'HTTP response must not contain the verification code');
   const saved=(await store.pool.query('SELECT * FROM control_codes WHERE id=$1',[message.challenge_id])).rows[0];
   assert.notEqual(saved.code_hash,message.code);assert.notEqual(saved.email_hash,email);return message;
  };
  const verify=message=>request('POST','/auth/verify',{email:message.email,challenge_id:message.challenge_id,code:message.code});
  const signIn=async email=>{
   const message=await codeFor(email),result=await verify(message);assert.equal(result.status,200);assert.deepEqual(result.body.projects,[]);
   const cookie=result.headers['set-cookie'];assert.equal(typeof cookie,'string');assert.match(cookie,/^fetchx_session=fxs_[A-Za-z0-9_-]{43};/);
   assert.match(cookie,/; Path=\/api\/control(?:;|$)/);assert.match(cookie,/; HttpOnly(?:;|$)/);assert.match(cookie,/; SameSite=Lax(?:;|$)/);assert.ok(!cookie.includes('; Secure'));
   assert.ok(!JSON.stringify(result.body).includes('fxs_'));
   return {user:result.body.user,cookie:cookie.split(';')[0],csrf:result.body.csrf_token,message};
  };
  let a,b,projectA,projectB,keyA,keyB,first,unknown;

  await t.test('exact bridge/origin, nonexposed codes, wrong/expired/reused challenges and rates',async()=>{
   await noDispatch(async()=>{
    assert.equal((await request('GET','/status',undefined,null,{'x-fetchx-control-secret':undefined})).body.error.code,'bridge_rejected');
    for(const origin of [undefined,'http://localhost:4331',ORIGIN+'/',ORIGIN+'.attacker.example'])assert.equal((await request('GET','/status',undefined,null,{origin})).body.error.code,'origin_rejected');
    const status=await request('GET','/status');assert.equal(status.status,200);assert.equal(status.body.enabled,true);assert.equal(status.body.mail_configured,true);assert.equal(status.body.api_base_url,'http://127.0.0.1:8789');assert.deepEqual(status.body.capabilities.routes,['direct']);
    assert.ok(!JSON.stringify(status.body).includes(config.controlPlane.bridgeSecret));
    assert.equal((await request('GET','/session')).status,401);
    const wrong=await codeFor('wrong@example.com');
    const invalid=await request('POST','/auth/verify',{email:wrong.email,challenge_id:wrong.challenge_id,code:wrong.code==='00000000'?'99999999':'00000000'});assert.equal(invalid.status,401);assert.equal(invalid.body.error.code,'verification_invalid');
    assert.equal((await request('POST','/auth/verify',{email:'other@example.com',challenge_id:wrong.challenge_id,code:wrong.code})).status,401);
    const expired=await codeFor('expired@example.com');await store.pool.query("UPDATE control_codes SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[expired.challenge_id]);assert.equal((await verify(expired)).status,401);
    a=await signIn('owner-a@example.com');b=await signIn('owner-b@example.com');assert.notEqual(a.user.id,b.user.id);
    assert.equal((await verify(a.message)).status,401);
    for(let i=0;i<3;i++)await codeFor('limited@example.com');
    const sent=mailbox.length;assert.equal((await request('POST','/auth/code',{email:'limited@example.com'})).status,429);assert.equal(mailbox.length,sent);
   });
  });

  await t.test('session CSRF and operator-only grants; only the first project receives trial credits',async()=>{
   const session=await request('GET','/session',undefined,a);assert.equal(session.body.user.id,a.user.id);assert.equal(session.body.csrf_token,a.csrf);
   for(const headers of [{'x-csrf-token':undefined},{'x-csrf-token':b.csrf}])assert.equal((await request('POST','/projects',{name:'rejected'},a,headers)).body.error.code,'csrf_rejected');
   const injected=await request('POST','/projects',{name:'injected',trialCredits:1000000,v2_access_profiles:['unapproved@1']},a);assert.equal(injected.status,400);
   projectA=(await request('POST','/projects',{name:'A acceptance project'},a)).body.project;
   projectB=(await request('POST','/projects',{name:'B acceptance project'},b)).body.project;
   assert.match(projectA.id,/^cp_[a-f0-9-]{36}$/);assert.notEqual(projectA.id,projectB.id);
   const second=(await request('POST','/projects',{name:'A second project'},a)).body.project;
   assert.equal((await request('GET',`/projects/${projectA.id}/usage`,undefined,a)).body.credits.granted,10);
   const secondUsage=await request('GET',`/projects/${second.id}/usage`,undefined,a);assert.equal(secondUsage.body.credits.granted,0);assert.equal(secondUsage.body.credits.available,0);
   await noDispatch(async()=>{const denied=await request('POST',`/projects/${second.id}/fetch`,payload('zero-trial'),a);assert.equal(denied.status,429);assert.equal(denied.body.error.code,'credit_balance_exhausted');});
   const detail=await request('GET',`/projects/${projectA.id}`,undefined,a);assert.equal(detail.body.capabilities.render,false);assert.equal(detail.body.capabilities.browser_probe.available,false);assert.deepEqual(detail.body.access_profiles[0].proxy_classes,['direct']);
   assert.deepEqual(config.projects[projectA.id].profiles,[]);assert.equal(config.projects[projectA.id].tokenHash,undefined);
   const billing=await request('GET',`/projects/${projectA.id}/billing`,undefined,a);assert.equal(billing.body.commercial_enabled,false);assert.equal(billing.body.status,'trial');
  });

  await t.test('real session fetch, retained data, measured history and separate authoritative credits',async()=>{
   const before=dispatches.length;first=await request('POST',`/projects/${projectA.id}/fetch`,payload('first'),a);
   assert.equal(first.status,200);assert.equal(first.body.success,true);assert.equal(first.body.state,'completed');assert.equal(first.body.application_acceptance,'not_evaluated');assert.equal(first.body.data.text,'{"fixture":true,"value":42}');assert.equal(dispatches.length,before+1);
   assert.equal(first.body.usage.accounting.request_credits.credits,1);assert.equal(first.body.usage.accounting.request_credits.key_id,'console');
   await noDispatch(async()=>{
    assert.deepEqual((await request('GET',`/projects/${projectA.id}/fetch/first`,undefined,a)).body,first.body);
    const detail=await request('GET',`/projects/${projectA.id}/requests/${first.body.operation_id}`,undefined,a);assert.equal(detail.body.operation_id,first.body.operation_id);assert.equal(detail.body.data.text,first.body.data.text);
    const history=await request('GET',`/projects/${projectA.id}/requests?limit=5`,undefined,a);assert.equal(history.body.operations.length,1);const row=history.body.operations[0];assert.equal(row.id,first.body.operation_id);assert.equal(row.state,'completed');assert.equal(row.routing.class,'direct');assert.ok(row.latency_ms>=0);assert.equal(row.data,undefined);assert.equal(row.body_base64,undefined);
    const usage=await request('GET',`/projects/${projectA.id}/usage`,undefined,a);assert.equal(usage.body.credits.settled,1);assert.equal(usage.body.credits.available,9);assert.equal(usage.body.gateway.latency_ms.completed_operations,1);
   });
  });

  await t.test('every project resource enforces membership and keys cannot cross project boundaries',async()=>{
   keyA=(await request('POST',`/projects/${projectA.id}/keys`,{name:'A native key',scopes:ALL_SCOPES},a)).body;
   keyB=(await request('POST',`/projects/${projectB.id}/keys`,{name:'B native key',scopes:ALL_SCOPES},b)).body;
   assert.match(keyA.token,/^fxk_[A-Za-z0-9_-]{43}$/);assert.equal(keyA.key.token,undefined);
   const paths=[['GET',`/projects/${projectA.id}`],['GET',`/projects/${projectA.id}/keys`],['POST',`/projects/${projectA.id}/keys`,{name:'intruder',scopes:ALL_SCOPES}],['POST',`/projects/${projectA.id}/keys/${keyA.key.id}/rotate`,{}],['DELETE',`/projects/${projectA.id}/keys/${keyA.key.id}`],['POST',`/projects/${projectA.id}/fetch`,payload('intruder')],['GET',`/projects/${projectA.id}/fetch/first`],['GET',`/projects/${projectA.id}/requests`],['GET',`/projects/${projectA.id}/requests/${first.body.operation_id}`],['GET',`/projects/${projectA.id}/usage`],['GET',`/projects/${projectA.id}/billing`]];
   await noDispatch(async()=>{
    for(const [method,path,body]of paths){const denied=await request(method,path,body,b);assert.equal(denied.status,404,method+' '+path);assert.equal(denied.body.error.code,'project_not_found');}
    const projects=await request('GET','/projects',undefined,b);assert.deepEqual(projects.body.projects.map(p=>p.id),[projectB.id]);
    const keys=await request('GET',`/projects/${projectA.id}/keys`,undefined,a);assert.ok(!JSON.stringify(keys.body).includes(keyA.token));assert.ok(!JSON.stringify(keys.body).includes('token_hash'));
    assert.equal((await native('GET','/v2/fetch/first',undefined,keyB.token)).status,404);
    assert.equal((await native('GET','/v2/fetch/operations/'+first.body.operation_id,undefined,keyB.token)).status,404);
    assert.equal((await request('POST',`/projects/${projectA.id}/keys/${keyB.key.id}/rotate`,{},a)).status,404);
    assert.equal((await request('DELETE',`/projects/${projectA.id}/keys/${keyB.key.id}`,undefined,a)).status,404);
   });
   const other=await native('POST','/v2/fetch',payload('first'),keyB.token);assert.equal(other.body.success,true);assert.notEqual(other.body.operation_id,first.body.operation_id);
   const otherHistory=await request('GET',`/projects/${projectB.id}/requests`,undefined,b);assert.deepEqual(otherHistory.body.operations.map(o=>o.id),[other.body.operation_id]);
   assert.equal((await request('GET',`/projects/${projectB.id}/usage`,undefined,b)).body.credits.settled,1);
  });

  await t.test('scoped API keys authorize native HTTP only, then rotate/revoke durably',async()=>{
   const readOnly=(await request('POST',`/projects/${projectA.id}/keys`,{name:'read only',scopes:['usage:read']},a)).body;
   await noDispatch(async()=>{
    assert.equal((await native('GET','/v2/usage',undefined,readOnly.token)).status,200);
    const forbidden=await native('POST','/v2/fetch',payload('scope-denied'),readOnly.token);assert.equal(forbidden.status,403);assert.equal(forbidden.body.error.code,'api_key_scope_forbidden');
    for(const [method,path,body]of [['GET','/v1/profiles'],['POST','/v1/workflows',{}],['POST','/v2/sessions',{}],['POST','/v2/browser-probes',{}]])assert.equal((await native(method,path,body,keyA.token)).status,403);
    const browser=await native('POST','/v2/fetch',{...payload('render-denied'),render:true},keyA.token);assert.equal(browser.status,409);assert.equal(browser.body.error.code,'capability_unsupported');
    const caps=await native('GET','/v2/capabilities',undefined,keyA.token);assert.equal(caps.body.browser_probe.available,false);assert.equal(caps.body.proxy_classes.residential,false);
   });
   const result=await native('POST','/v2/fetch',payload('api-key'),keyA.token);assert.equal(result.body.success,true);assert.equal(result.body.usage.accounting.request_credits.key_id,keyA.key.id);
   const old=keyA;keyA=(await request('POST',`/projects/${projectA.id}/keys/${old.key.id}/rotate`,{},a)).body;assert.notEqual(keyA.token,old.token);assert.notEqual(keyA.key.id,old.key.id);
   await noDispatch(async()=>{assert.equal((await native('GET','/v2/usage',undefined,old.token)).status,401);assert.equal((await native('GET','/v2/usage',undefined,keyA.token)).status,200);});
   const revoke=await request('DELETE',`/projects/${projectA.id}/keys/${keyA.key.id}`,undefined,a);assert.equal(revoke.body.revoked,true);
   await noDispatch(async()=>{assert.equal((await native('POST','/v2/fetch',payload('revoked'),keyA.token)).status,401);});
  });

  await t.test('same-key concurrency dispatches and charges once; conflicting payload cannot reuse the key',async()=>{
   mode='blocked';entered=Promise.withResolvers();const before=dispatches.length;
   const pending=request('POST',`/projects/${projectA.id}/fetch`,payload('concurrent'),a);
   await entered.promise;
   try{
    const duplicate=await request('POST',`/projects/${projectA.id}/fetch`,payload('concurrent'),a);assert.equal(duplicate.status,200);assert.ok(['reserved','running'].includes(duplicate.body.state));assert.equal(duplicate.body.retry.next_action,'recover_first');assert.equal(dispatches.length,before+1);
    const conflict=await request('POST',`/projects/${projectA.id}/fetch`,{...payload('concurrent'),url:'https://source.example/different'},a);assert.equal(conflict.status,409);assert.equal(conflict.body.error.code,'idempotency_conflict');
   }finally{releaseBlocked();releaseBlocked=undefined;mode='success';}
   const completed=await pending;assert.equal(completed.body.success,true);
   await noDispatch(async()=>{assert.deepEqual((await request('POST',`/projects/${projectA.id}/fetch`,payload('concurrent'),a)).body,completed.body);assert.deepEqual((await request('GET',`/projects/${projectA.id}/fetch/concurrent`,undefined,a)).body,completed.body);});
   const reservation=(await store.pool.query('SELECT count(*)::int AS n,sum(credits)::int AS credits FROM control_credit_reservations WHERE operation=$1',[completed.body.operation_id])).rows[0];assert.deepEqual(reservation,{n:1,credits:1});assert.equal(dispatches.length,before+1);
  });

  await t.test('source/SSRF restrictions and credential forwarding fail before source dispatch or credit charge',async()=>{
   const before=await gateway.controlCredits.usage(projectA.id);
   await noDispatch(async()=>{
    for(const url of ['http://source.example/data','https://unapproved.example/data','https://127.0.0.1/','https://source.example@127.0.0.1/']){const denied=await request('POST',`/projects/${projectA.id}/fetch`,{...payload('forbidden-'+randomUUID()),url},a);assert.equal(denied.body.success,false);assert.equal(denied.body.error.code,'destination_rejected');}
    const original=gateway.v2.resolve;gateway.v2.resolve=async()=>[{address:'127.0.0.1',family:4}];
    try{const ssrf=await request('POST',`/projects/${projectA.id}/fetch`,payload('private-dns'),a);assert.equal(ssrf.body.error.code,'destination_rejected');}finally{gateway.v2.resolve=original;}
    for(const value of [keyA.token,a.cookie.split('=')[1],'Bearer '+keyB.token]){const denied=await request('POST',`/projects/${projectA.id}/fetch`,{...payload('credential-'+randomUUID()),headers:{accept:value}},a);assert.equal(denied.body.error.code,'credential_scope_rejected');}
    const paid=await request('POST',`/projects/${projectA.id}/fetch`,{...payload('paid-route'),proxy:{class:'datacenter',country:'US'}},a);assert.equal(paid.body.success,false);assert.ok(paid.status>=400);
    const after=await gateway.controlCredits.usage(projectA.id);for(const field of ['available','settled','held','reserved'])assert.equal(after[field],before[field]);
   });
  });

  await t.test('HTTP 403 is retained as source failure and unknown results retain a hold through read/restart recovery',async()=>{
   mode='forbidden';const forbidden=await request('POST',`/projects/${projectA.id}/fetch`,payload('source-forbidden'),a);assert.equal(forbidden.status,200);assert.equal(forbidden.body.success,false);assert.equal(forbidden.body.data.status,403);assert.equal(forbidden.body.error.code,'source_forbidden');assert.equal(forbidden.body.state,'completed');
   await store.pool.query('DELETE FROM source_limits');mode='unknown';const before=dispatches.length;
   unknown=await request('POST',`/projects/${projectA.id}/fetch`,payload('unknown'),a);assert.equal(unknown.body.state,'unknown');assert.equal(unknown.body.error.code,'source_timeout_unknown');assert.equal(unknown.body.retry.next_action,'recover_first');assert.equal(unknown.body.retry.new_request_allowed,false);assert.equal(unknown.body.usage.accounting.request_credits.state,'held');assert.equal(dispatches.length,before+1);
   assert.equal((await gateway.controlCredits.usage(projectA.id)).held,1);mode='success';
   await noDispatch(async()=>{
    for(const [method,path,body]of [['GET',`/projects/${projectA.id}/fetch/unknown`],['GET',`/projects/${projectA.id}/requests/${unknown.body.operation_id}`],['POST',`/projects/${projectA.id}/fetch`,payload('unknown')]]){const recovered=await request(method,path,body,a);assert.equal(recovered.body.state,'unknown');assert.equal(recovered.body.operation_id,unknown.body.operation_id);assert.equal(recovered.body.usage.accounting.request_credits.state,'held');}
    await store.recover();
    const restarted=server({...gateway,v2:new V2Gateway(gateway,{http:async()=>{assert.fail('restart lookup dispatched');},browserRuntime:async()=>({available:false})})});
    try{const result=await restarted.inject({url:`/control/projects/${projectA.id}/fetch/unknown`,headers:{...bridge,cookie:a.cookie}});assert.equal(result.statusCode,200);assert.equal(result.json().state,'unknown');assert.equal(result.json().usage.accounting.request_credits.state,'held');}finally{await restarted.close();}
   });
  });

  await t.test('credit account serializes concurrent final admissions and never permits an overdraft',async()=>{
   let remaining=(await gateway.controlCredits.usage(projectA.id)).available;
   assert.ok(remaining>0&&remaining<=10);
   for(let i=0;remaining>1;i++,remaining--){const drained=await request('POST',`/projects/${projectA.id}/fetch`,payload('drain-'+i),a);assert.equal(drained.body.success,true);}
   const before=dispatches.length;
   const pair=await Promise.all(['last-a','last-b'].map(key=>request('POST',`/projects/${projectA.id}/fetch`,payload(key),a)));
   assert.equal(pair.filter(r=>r.body.success).length,1);const denied=pair.find(r=>!r.body.success);assert.equal(denied.status,429);assert.equal(denied.body.error.code,'credit_balance_exhausted');assert.equal(dispatches.length,before+1);
   const usage=await request('GET',`/projects/${projectA.id}/usage`,undefined,a);assert.equal(usage.body.credits.available,0);assert.equal(usage.body.credits.held,1);assert.equal(usage.body.credits.settled+usage.body.credits.held,usage.body.credits.granted);
   await noDispatch(async()=>{const exhausted=await request('POST',`/projects/${projectA.id}/fetch`,payload('overdraft'),a);assert.equal(exhausted.body.error.code,'credit_balance_exhausted');const replay=await request('GET',`/projects/${projectA.id}/fetch/first`,undefined,a);assert.equal(replay.body.success,true);});
   assert.equal((await request('GET',`/projects/${projectA.id}/billing`,undefined,a)).body.status,'approval_required');
  });

  await t.test('logout revokes the real session and clears the path-scoped cookie',async()=>{
   const logout=await request('POST','/auth/logout',{},a);assert.equal(logout.body.logged_out,true);assert.match(logout.headers['set-cookie'],/Path=\/api\/control/);assert.match(logout.headers['set-cookie'],/Max-Age=0/);
   assert.equal((await request('GET','/session',undefined,a)).status,401);assert.equal((await request('GET','/session',undefined,b)).status,200);
  });
 }finally{
  releaseBlocked?.();
  if(app)await app.close();
  if(store)await store.close();
  try{await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);}finally{await admin.end();await rm(root,{recursive:true,force:true});}
 }
});
