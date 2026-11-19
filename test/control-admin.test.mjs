import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {randomUUID} from 'node:crypto';
import {GatewayError} from '../src/policy.mjs';
import {registerControl,controlCsrf,CONTROL_COOKIE} from '../src/control.mjs';
import {Store} from '../src/store.mjs';
import {grantOperator,revokeOperator,listOperators} from '../src/control-admin.mjs';
import {providerRule} from '../src/provider-rules.mjs';

const origin='https://fetchx.ai',secret='synthetic-bridge-secret-32-bytes-minimum';
const opToken='fxs_'+'o'.repeat(43),userToken='fxs_'+'u'.repeat(43);

test('admin rules API: operator-only, CSRF-bound, validated, versioned, audited and applied live',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 assert.match(new URL(process.env.TEST_DATABASE_URL).pathname,/^\/gateway_test_[A-Za-z0-9]+$/);
 const store=new Store(process.env.TEST_DATABASE_URL);await store.init();
 await store.pool.query('TRUNCATE control_operators,control_operator_audit,routing_rules,routing_rule_audit RESTART IDENTITY');
 const op={id:randomUUID(),email:'ops@example.com'},member={id:randomUUID(),email:'member@example.com'};
 for(const u of [op,member])await store.pool.query('INSERT INTO control_users(id,email) VALUES($1,$2) ON CONFLICT(email) DO UPDATE SET id=control_users.id',[u.id,u.email]);
 for(const u of [op,member])u.id=(await store.pool.query('SELECT id FROM control_users WHERE email=$1',[u.email])).rows[0].id;
 const controlPlane={enabled:true,origins:[origin],bridgeSecret:secret,creditPolicy:{weights:{direct:1}},admin:{enabled:true}};
 const gateway={config:{controlPlane,providerRules:[]},store};
 const identity={session:async value=>{if(value===opToken)return {user:op};if(value===userToken)return {user:member};throw new GatewayError('unauthorized',401);}};
 const app=Fastify();app.decorate('v2',{store});app.decorate('publicFetch',{});
 registerControl(app,gateway,{identity,ledger:{prices:{},metered:()=>true,balance:async()=>null,usage:async()=>({credits:0,by_step:[],daily:[]})},service:{}});await app.ready();
 t.after(async()=>{await app.close();await store.close();});
 const send=(method,path,payload,{token=opToken,csrf}={})=>app.inject({method,url:'/control'+path,
  headers:{origin,'x-fetchx-control-secret':secret,cookie:`${CONTROL_COOKIE}=${token}`,'x-csrf-token':csrf??controlCsrf(token,secret),...(payload===undefined?{}:{'content-type':'application/json'})},
  ...(payload===undefined?{}:{payload})});
 const code=r=>r.json().error?.code;

 // Disabled by default; then operator-only.
 controlPlane.admin.enabled=false;assert.equal((await send('GET','/admin/rules')).statusCode,404);controlPlane.admin.enabled=true;
 let r=await send('GET','/admin/session');assert.equal(r.statusCode,403);assert.equal(code(r),'operator_required');
 assert.deepEqual(await grantOperator(store,'OPS@example.com','cli-test'),{email:'ops@example.com',operator:true,changed:true});
 assert.equal((await grantOperator(store,'ops@example.com','cli-test')).changed,false);
 await assert.rejects(grantOperator(store,'nobody@example.com','cli-test'),e=>e.code==='operator_user_not_found');
 assert.deepEqual((await send('GET','/admin/session')).json(),{operator:true,email:'ops@example.com'});
 assert.equal(code(await send('GET','/admin/rules',undefined,{token:userToken})),'operator_required');
 assert.equal((await send('GET','/admin/rules',undefined,{token:'fxs_'+'x'.repeat(43)})).statusCode,401);

 // List shows the shipped default with its source.
 r=await send('GET','/admin/rules');assert.equal(r.statusCode,200);
 assert.deepEqual(r.json().rules.map(x=>`${x.id}:${x.source}`),['oxylabs-gov:default']);assert.ok(r.json().providers.includes('evomi'));

 // Create (CSRF required), duplicate conflict, validation.
 const rule={id:'evomi-records',provider:'evomi',match:{hostSuffix:'.records.example'},action:'exclude',reason:'portal test'};
 assert.equal((await send('POST','/admin/rules',{rule},{csrf:''})).statusCode,403);
 r=await send('POST','/admin/rules',{rule});assert.equal(r.statusCode,200);assert.equal(r.json().rule.version,1);
 assert.equal(providerRule(gateway.config,'evomi','a.records.example')?.id,'evomi-records','applied to the running gateway at once');
 assert.equal(code(await send('POST','/admin/rules',{rule})),'rule_version_conflict');
 assert.equal(code(await send('POST','/admin/rules',{rule:{...rule,id:'other',provider:'nope'}})),'rule_invalid');
 assert.equal((await send('POST','/admin/rules',{rule,extra:1})).statusCode,400);

 // Edit with optimistic version; id must match the path.
 assert.equal(code(await send('PUT','/admin/rules/evomi-records',{rule:{...rule,reason:'x'},version:7})),'rule_version_conflict');
 assert.equal(code(await send('PUT','/admin/rules/evomi-records',{rule:{...rule,id:'other'},version:1})),'rule_id_mismatch');
 assert.equal(code(await send('PUT','/admin/rules/evomi-records',{rule})),'rule_version_required');
 r=await send('PUT','/admin/rules/evomi-records',{rule:{...rule,reason:'edited'},version:1});assert.equal(r.json().rule.version,2);assert.equal(r.json().rule.reason,'edited');

 // Host test, then disable/enable a shipped default (reason required).
 assert.deepEqual((await send('POST','/admin/rules/test',{provider:'oxylabs',host:'WWW.Ohio.GOV.'})).json(),{provider:'oxylabs',host:'www.ohio.gov',excluded:true,rule:'oxylabs-gov',reason:'Oxylabs refuses CONNECT to .gov destinations (HTTP 444), from every country tested.'});
 assert.equal(code(await send('POST','/admin/rules/test',{provider:'oxylabs',host:'not a host'})),'rule_host_invalid');
 assert.equal(code(await send('POST','/admin/rules/test',{provider:'proxyco',host:'ohio.gov'})),'rule_provider_invalid');
 assert.equal(code(await send('POST','/admin/rules/oxylabs-gov/disable',{reason:''})),'rule_reason_required');
 r=await send('POST','/admin/rules/oxylabs-gov/disable',{reason:'Oxylabs enabled .gov'});assert.equal(r.json().rule.enabled,false);
 assert.equal((await send('POST','/admin/rules/test',{provider:'oxylabs',host:'ohio.gov'})).json().excluded,false);
 assert.equal((await send('GET','/admin/rules')).json().rules.find(x=>x.id==='oxylabs-gov').overrides,'default');
 await send('POST','/admin/rules/oxylabs-gov/enable',{reason:'re-check failed'});
 assert.equal(providerRule(gateway.config,'oxylabs','ohio.gov')?.id,'oxylabs-gov');

 // Delete, unknown id, invalid id, then the audit trail with the operator as actor.
 assert.equal((await send('DELETE','/admin/rules/evomi-records')).json().deleted,'evomi-records');
 assert.equal(providerRule(gateway.config,'evomi','a.records.example'),null);
 assert.equal(code(await send('DELETE','/admin/rules/evomi-records')),'rule_not_found');
 assert.equal(code(await send('DELETE','/admin/rules/Bad_ID')),'rule_id_invalid');
 const audit=(await send('GET','/admin/audit')).json().entries;
 assert.deepEqual(audit.map(a=>`${a.rule_id}:${a.action}`).reverse(),['evomi-records:create','evomi-records:update','oxylabs-gov:disable','oxylabs-gov:enable','evomi-records:delete']);
 assert.ok(audit.every(a=>a.actor==='ops@example.com'));
 assert.equal((await send('GET','/admin/rules/oxylabs-gov/audit')).json().entries.length,2);
 assert.equal((await send('GET','/admin/rules?x=1')).statusCode,400,'no query strings');

 // Revocation takes effect immediately.
 assert.deepEqual((await listOperators(store.pool)).map(o=>o.email),['ops@example.com']);
 await revokeOperator(store,'ops@example.com','cli-test');assert.equal(code(await send('GET','/admin/rules')),'operator_required');
 assert.deepEqual((await store.pool.query('SELECT action,actor FROM control_operator_audit ORDER BY id')).rows,[{action:'grant',actor:'cli-test'},{action:'revoke',actor:'cli-test'}]);
});

test('admin: probe jobs and applying proposed provider rules',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const {interruptProbes}=await import('../src/admin-ops.mjs');
 const store=new Store(process.env.TEST_DATABASE_URL);await store.init();
 await store.pool.query('TRUNCATE control_operators,control_operator_audit,routing_rules,routing_rule_audit,admin_probes RESTART IDENTITY');
 const op={id:randomUUID(),email:'ops3@example.com'};
 await store.pool.query('INSERT INTO control_users(id,email) VALUES($1,$2) ON CONFLICT(email) DO NOTHING',[op.id,op.email]);
 op.id=(await store.pool.query('SELECT id FROM control_users WHERE email=$1',[op.email])).rows[0].id;await grantOperator(store,op.email,'cli-test');
 const provider={enabled:true,username:'u',password:'p',maxTotalBytes:1e6,microUsdPerGB:1};
 const controlPlane={enabled:true,origins:[origin],bridgeSecret:secret,creditPolicy:{weights:{direct:1}},admin:{enabled:true,maxProbesPerDay:2}};
 const config={controlPlane,providerRules:[],defaultRouting:'residential-v1',residential:{providers:{evomi:provider,dataimpulse:provider}},browser:{defaultEngine:'camoufox'},projects:{p:{profiles:['src.city']}}};
 const base={hosts:['records.city.example'],methods:['GET'],headers:[],country:'GB',maxConcurrent:1,maxRequests:4,maxInputBytes:1024,maxResponseBytes:1024,maxBytes:20000,ttlSeconds:120,minIntervalMs:0,maxFallbackCredits:0,maxAttemptBytes:1000,maxResidentialBytes:4000};
 let release;const gate=new Promise(r=>{release=r;});let r;
 const report={host:'records.city.example',summary:{reachable_countries:['US'],recommended_route:{country:'US',class:'residential',provider:'evomi',execution:'http'},
  proposed_profile:{v1:{country:'US',routingPolicy:'residential-v1',execution:'http'},v2:{countries:['US'],proxy_classes:['residential']}},
  proposed_provider_rules:[{id:'oxylabs-records-city-example',provider:'oxylabs',match:{host:'records.city.example'},action:'exclude',reason:'oxylabs refused CONNECT to records.city.example in every probed country'}]},cells:[]};
 const gateway={config,store,profiles:{'src.city':base},profileOverrides:new Map(),adminProbeRunner:async()=>{await gate;return report;}};
 const identity={session:async value=>{if(value===opToken)return {user:op};throw new GatewayError('unauthorized',401);}};
 const app=Fastify();app.decorate('v2',{store});app.decorate('publicFetch',{});
 registerControl(app,gateway,{identity,ledger:{prices:{},metered:()=>true,balance:async()=>null,usage:async()=>({credits:0,by_step:[],daily:[]})},service:{}});await app.ready();
 t.after(async()=>{await app.close();await store.close();});
 const send=(method,path,payload)=>app.inject({method,url:'/control'+path,headers:{origin,'x-fetchx-control-secret':secret,cookie:`${CONTROL_COOKIE}=${opToken}`,'x-csrf-token':controlCsrf(opToken,secret),...(payload===undefined?{}:{'content-type':'application/json'})},...(payload===undefined?{}:{payload})});
 const code=r=>r.json().error?.code;

 // Probes: background job, one at a time, daily cap, stored report.
 assert.equal(code(await send('POST','/admin/probes',{host:'not a host',countries:['US']})),'probe_host_invalid');
 assert.equal(code(await send('POST','/admin/probes',{host:'records.city.example',countries:['US','us']})),'probe_countries_invalid');
 r=await send('POST','/admin/probes',{host:'Records.City.example',countries:['US','GB']});assert.equal(r.statusCode,200);
 const pid=r.json().probe.id;assert.equal(r.json().probe.host,'records.city.example');
 assert.equal(code(await send('POST','/admin/probes',{host:'other.gov',countries:['US']})),'probe_busy');
 assert.equal(code(await send('POST',`/admin/probes/${pid}/apply`,{rules:['oxylabs-records-city-example']})),'probe_not_complete');
 release();for(let i=0;i<50&&(await send('GET',`/admin/probes/${pid}`)).json().probe.state!=='complete';i++)await new Promise(res=>setTimeout(res,20));
 r=await send('GET',`/admin/probes/${pid}`);assert.equal(r.json().probe.state,'complete');assert.deepEqual(r.json().probe.report.summary.reachable_countries,['US']);
 assert.equal((await send('GET','/admin/probes')).json().probes[0].summary.recommended_route.country,'US');

 // Apply: a proposed rule, recorded with the probe as evidence.
 assert.equal(code(await send('POST',`/admin/probes/${pid}/apply`,{rules:['made-up']})),'probe_rule_not_proposed');
 assert.equal(code(await send('POST',`/admin/probes/${pid}/apply`,{})),'probe_apply_empty');
 r=await send('POST',`/admin/probes/${pid}/apply`,{rules:['oxylabs-records-city-example']});assert.equal(r.statusCode,200);
 assert.equal(r.json().applied.rules[0].evidence.probe,pid);
 assert.equal((await send('POST','/admin/rules/test',{provider:'oxylabs',host:'records.city.example'})).json().rule,'oxylabs-records-city-example');
 assert.ok((await send('GET',`/admin/probes/${pid}`)).json().probe.applied_at);
 // Daily cap (2): the second probe is allowed, the third is not.
 r=await send('POST','/admin/probes',{host:'two.city.gov',countries:['US']});assert.equal(r.statusCode,200);
 for(let i=0;i<50&&(await send('GET',`/admin/probes/${r.json().probe.id}`)).json().probe.state!=='complete';i++)await new Promise(res=>setTimeout(res,20));
 assert.equal(code(await send('POST','/admin/probes',{host:'three.city.gov',countries:['US']})),'probe_daily_limit');

 // A restart interrupts unfinished probes.
 await store.pool.query("INSERT INTO admin_probes(id,host,countries,state,requested_by) VALUES($1,'x.gov','{US}','running','t')",[randomUUID()]);
 assert.equal(await interruptProbes(store.pool),1);
});
