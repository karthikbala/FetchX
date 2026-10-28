import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {Gateway} from '../src/gateway.mjs';
import {server} from '../src/main.mjs';
import {sha} from '../src/crypto.mjs';
import {artifactUsage,artifactAdmission,recordArtifact} from '../src/artifacts.mjs';

test('authenticated status separates billing warnings from hard holds without other project records',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const url=new URL(process.env.TEST_DATABASE_URL);
 assert.match(url.pathname,/^\/(?:gateway_conformance|gateway_test)(?:_[A-Za-z0-9]+)?$/);
 const schema='status_'+randomUUID().replaceAll('-',''),admin=new Store(url.href);
 await admin.pool.query('CREATE SCHEMA '+schema);url.searchParams.set('options','-c search_path='+schema);
 const store=new Store(url.href),root=await mkdtemp(join(tmpdir(),'gateway-status-'));
 const profile={hosts:['source.example'],methods:['GET'],headers:[],country:'IN',maxRequests:4,maxBytes:4096,maxResponseBytes:1024,maxInputBytes:1024,ttlSeconds:30,maxFallbackCredits:1,fallbackMaxCost:1,minIntervalMs:0};
 const config={release:'review-test',artifactDir:root,artifactKey:'11'.repeat(32),maxDailyFallbackCredits:10,scrapeDoToken:'private',projects:{a:{tokenHash:sha('a-token'),profiles:['source']},b:{tokenHash:sha('b-token'),profiles:['private-profile']}},proxies:[{id:'in1',country:'IN',url:'http://private.example'}]};
 const gateway=new Gateway({store,config,profiles:{source:profile,'private-profile':profile}}),app=server(gateway);
 try{
  await store.init();
  const own=await gateway.workflow('a',{idempotency_key:'a',profile:'source'});
  const other=await gateway.workflow('b',{idempotency_key:'b',profile:'private-profile'}),op=randomUUID(),attempt=randomUUID();
  await store.pool.query("INSERT INTO operations(id,workflow,key,input,state,error) VALUES($1,$2,'private',decode('00','hex'),'failed','metered_outcome_unknown')",[op,other.id]);
  await store.pool.query("INSERT INTO attempts(id,workflow,operation,provider,state,reserved_credits,error) VALUES($1,$2,$3,'scrapedo','unknown',1,'metered_outcome_unknown')",[attempt,other.id,op]);
  const result=await app.inject({method:'GET',url:'/v1/status',headers:{authorization:'Bearer a-token'}});
  assert.equal(result.statusCode,200);
  const status=result.json();assert.equal(status.fallback.available,true);assert.deepEqual(status.fallback.blocked_by,[]);
  assert.equal(status.fallback.unknown_attempts,1);assert.equal(status.fallback.unknown_reserved_credits,1);
  assert.equal(status.fallback.daily_reserved_or_spent,1);assert.deepEqual(status.billing_warnings,[]);
  assert.equal(status.financial_holds.length,0);assert.equal(status.workflows.length,1);assert.equal(status.workflows[0].profile,'source');
  for(const secret of ['private-profile',attempt,other.id,'private.example','a-token'])assert.ok(!result.body.includes(secret));
  const addAttempt=async(workflow,key,error,credits)=>{
   const operation=randomUUID(),id=randomUUID();
   await store.pool.query("INSERT INTO operations(id,workflow,key,input,state,error) VALUES($1,$2,$3,decode('00','hex'),'failed',$4)",[operation,workflow,key,error]);
   await store.pool.query("INSERT INTO attempts(id,workflow,operation,provider,state,reserved_credits,credits,error) VALUES($1,$2,$3,'scrapedo',$4,1,$5,$6)",[id,workflow,operation,credits===null?'unknown':'settled',credits,error]);
   return id;
  };
  const ownWarning=await addAttempt(own.id,'own-unknown','provider_unattested',null);
  const warned=(await app.inject({url:'/v1/status',headers:{authorization:'Bearer a-token'}})).json();
  assert.equal(warned.fallback.available,true);assert.equal(warned.fallback.unknown_attempts,2);assert.equal(warned.fallback.unknown_reserved_credits,2);
  assert.equal(warned.billing_warnings.length,1);assert.equal(warned.financial_holds.length,0);
  assert.equal(warned.billing_warnings[0].attempt,ownWarning);assert.equal(warned.billing_warnings[0].profile,'source');
  assert.equal(warned.billing_warnings[0].error,'provider_unattested');assert.equal(warned.billing_warnings[0].reserved_credits,1);
  assert.equal(warned.billing_warnings[0].blocking,false);assert.ok(warned.billing_warnings[0].created_at);assert.ok(Number(warned.billing_warnings[0].age_seconds)>=0);
  const privateHard=await addAttempt(other.id,'private-hard','cost_overrun',2);
  const blockedResponse=await app.inject({url:'/v1/status',headers:{authorization:'Bearer a-token'}}),blocked=blockedResponse.json();
  assert.equal(blocked.fallback.available,false);assert.deepEqual(blocked.fallback.blocked_by,['metered_account_held']);
  assert.equal(blocked.financial_holds.length,0);assert.equal(blocked.billing_warnings.length,1);
  for(const secret of ['private-profile',attempt,privateHard,other.id,'private.example','a-token'])assert.ok(!blockedResponse.body.includes(secret));
  const ownHard=await addAttempt(own.id,'own-hard','provider_account_rejected',null);
  const ownBlocked=(await app.inject({url:'/v1/status',headers:{authorization:'Bearer a-token'}})).json();
  assert.equal(ownBlocked.financial_holds.length,1);assert.equal(ownBlocked.financial_holds[0].attempt,ownHard);
  assert.equal(ownBlocked.billing_warnings.length,1);assert.equal(ownBlocked.billing_warnings[0].attempt,ownWarning);
  assert.equal((await app.inject('/v1/status')).statusCode,401);
  assert.equal((await app.inject({url:'/v1/status',headers:{authorization:'a-token'}})).statusCode,401);
  assert.equal((await app.inject({url:'/v1/workflows/not-a-uuid',headers:{authorization:'Bearer a-token'}})).statusCode,400);
  const bad=await app.inject({method:'POST',url:'/v1/workflows',headers:{authorization:'Bearer a-token','content-type':'application/json'},payload:'{broken'});
  assert.equal(bad.statusCode,400);assert.deepEqual(bad.json(),{error:'request_invalid'});
 }finally{await app.close();await store.close();await admin.pool.query('DROP SCHEMA '+schema+' CASCADE');await admin.close();await rm(root,{recursive:true,force:true});}
});

test('cached artifact inventory accounts for newly published files before the next disk scan',async()=>{
 const root=await mkdtemp(join(tmpdir(),'gateway-inventory-'));
 const config={artifactDir:root,maxArtifactBytes:100,minFreeDiskBytes:0};
 try{
  assert.equal((await artifactUsage(config)).bytes,0);
  await writeFile(join(root,'capture.bin'),Buffer.alloc(80));recordArtifact(config,80);
  assert.equal((await artifactUsage(config)).bytes,80);
  await assert.rejects(artifactAdmission(config,21),/artifact_quota/);
  await artifactAdmission(config,20);
  assert.equal((await artifactUsage(config,{refresh:true})).bytes,80);
 }finally{await rm(root,{recursive:true,force:true});}
});
