import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {randomUUID} from 'node:crypto';
import {GatewayError} from '../src/policy.mjs';
import {registerControl,controlCsrf,CONTROL_COOKIE} from '../src/control.mjs';
import {Store} from '../src/store.mjs';
import {grantOperator,revokeOperator,listOperators,ADMIN_ROUTES} from '../src/control-admin.mjs';
import {EngineClient} from '../src/engine/client.mjs';
import {fakeEngine} from './fake-engine.mjs';
import {SERVICE_TOKEN} from './helpers.mjs';

const origin='https://fetchx.ai',secret='synthetic-bridge-secret-32-bytes-minimum';
const opToken='fxs_'+'o'.repeat(43),userToken='fxs_'+'u'.repeat(43);

test('admin portal: operator-only and CSRF-bound; rules, probes and sites are forwarded to the engine with the operator as actor',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 assert.match(new URL(process.env.TEST_DATABASE_URL).pathname,/^\/gateway_test_[A-Za-z0-9_]+$/);
 const store=new Store(process.env.TEST_DATABASE_URL);await store.init();
 await store.pool.query('TRUNCATE control_operators,control_operator_audit RESTART IDENTITY');
 const op={id:randomUUID(),email:'ops@example.com'},member={id:randomUUID(),email:'member@example.com'};
 for(const u of [op,member])await store.pool.query('INSERT INTO control_users(id,email) VALUES($1,$2) ON CONFLICT(email) DO UPDATE SET id=control_users.id',[u.id,u.email]);
 for(const u of [op,member])u.id=(await store.pool.query('SELECT id FROM control_users WHERE email=$1',[u.email])).rows[0].id;
 const engine=fakeEngine({token:SERVICE_TOKEN});
 const controlPlane={enabled:true,origins:[origin],bridgeSecret:secret,admin:{enabled:true}};
 const gateway={config:{controlPlane},store,engine:new EngineClient({url:'http://engine.test:8790',serviceToken:SERVICE_TOKEN},{fetchImpl:engine.fetchImpl})};
 const identity={session:async value=>{if(value===opToken)return {user:op};if(value===userToken)return {user:member};throw new GatewayError('unauthorized',401);}};
 const app=Fastify();
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
 assert.equal(engine.admin.length,0,'nothing reached the engine for a non-operator');

 // Reads forward without an actor; writes carry the operator's email and the body as sent.
 r=await send('GET','/admin/rules');assert.equal(r.statusCode,200);assert.deepEqual(r.json(),{ok:true,path:'/rules'});
 const rule={id:'evomi-records',provider:'evomi',match:{hostSuffix:'.records.example'},action:'exclude',reason:'portal test'};
 assert.equal((await send('POST','/admin/rules',{rule},{csrf:''})).statusCode,403,'CSRF');
 r=await send('PUT','/admin/rules/evomi-records',{rule,version:1});assert.equal(r.statusCode,200);
 assert.deepEqual(engine.admin.at(-1),{method:'PUT',path:'/rules/evomi-records',body:{rule,version:1},actor:'ops@example.com'});
 await send('POST','/admin/probes/0b0e7d3c-9a52-4a77-9bd5-6cbbd6a0b0f1/apply',{rules:['x']});
 assert.deepEqual(engine.admin.at(-1),{method:'POST',path:'/probes/0b0e7d3c-9a52-4a77-9bd5-6cbbd6a0b0f1/apply',body:{rules:['x']},actor:'ops@example.com'});
 await send('DELETE','/admin/sites/shop.example.com');
 assert.deepEqual(engine.admin.at(-1),{method:'DELETE',path:'/sites/shop.example.com',body:null,actor:'ops@example.com'});
 assert.equal(engine.admin.filter(call=>call.method==='GET').every(call=>call.actor===null),true);
 // Engine refusals come back unchanged; bad input stops before the engine.
 assert.equal(code(await send('DELETE','/admin/rules/missing')),'rule_not_found');
 const before=engine.admin.length;
 assert.equal(code(await send('DELETE','/admin/rules/bad%20id')),'rule_id_invalid');
 assert.equal((await send('GET','/admin/rules?x=1')).statusCode,400,'no query strings');
 assert.equal((await app.inject({method:'POST',url:'/control/admin/rules',payload:'x',headers:{origin,'x-fetchx-control-secret':secret,cookie:`${CONTROL_COOKIE}=${opToken}`,'x-csrf-token':controlCsrf(opToken,secret),'content-type':'text/plain'}})).statusCode,415);
 assert.equal(engine.admin.length,before);
 // Every forwarded route is one the engine serves.
 assert.ok(ADMIN_ROUTES.every(([method,path])=>['GET','POST','PUT','DELETE'].includes(method)&&path.startsWith('/admin/')));

 // Revocation takes effect immediately.
 assert.deepEqual((await listOperators(store.pool)).map(o=>o.email),['ops@example.com']);
 await revokeOperator(store,'ops@example.com','cli-test');assert.equal(code(await send('GET','/admin/rules')),'operator_required');
 assert.deepEqual((await store.pool.query('SELECT action,actor FROM control_operator_audit ORDER BY id')).rows,[{action:'grant',actor:'cli-test'},{action:'revoke',actor:'cli-test'}]);
});
