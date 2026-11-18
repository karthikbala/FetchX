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
 registerControl(app,gateway,{identity,credits:{usage:async()=>({})}});await app.ready();
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
