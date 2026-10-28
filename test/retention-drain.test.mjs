import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {artifactUsage,pruneArtifacts} from '../src/artifacts.mjs';

function eligibleStore(rows){
 const pending=new Map(rows.map(row=>[row.id,row])),expired=[],batches=[];
 const store={pool:{query:async(sql,args)=>{
  if(sql.startsWith('SELECT')){const selected=[...pending.values()].slice(0,args[1]);batches.push(selected.length);return {rows:selected};}
  assert.ok(pending.has(args[0]));pending.delete(args[0]);expired.push(args[0]);return {rows:[]};
 }}};
 return {store,pending,expired,batches};
}

test('retention drains more than one batch and invalidates storage usage after deletion',async t=>{
 const root=await mkdtemp(join(tmpdir(),'gateway-retention-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const rows=Array.from({length:450},(_,i)=>({id:'operation-'+i,result_path:join(root,i+'.bin')}));
 await Promise.all(rows.map(row=>writeFile(row.result_path,'capture')));
 const config={artifactDir:root};assert.equal((await artifactUsage(config)).bytes,450*7);
 const fixture=eligibleStore(rows);
 assert.equal(await pruneArtifacts(fixture.store,config),450);
 assert.deepEqual(fixture.batches,[200,200,50]);assert.equal(fixture.pending.size,0);
 assert.equal((await artifactUsage(config)).bytes,0);
 await assert.rejects(access(rows[0].result_path));
});

test('one retention sweep is bounded and safely continues after an already missing file',async t=>{
 const root=await mkdtemp(join(tmpdir(),'gateway-retention-bound-'));t.after(()=>rm(root,{recursive:true,force:true}));
 // Missing files model a prior interruption between unlink and row expiry.
 const rows=Array.from({length:5001},(_,i)=>({id:'operation-'+i,result_path:join(root,i+'.bin')}));
 const fixture=eligibleStore(rows);
 assert.equal(await pruneArtifacts(fixture.store,{artifactDir:root}),5000);
 assert.equal(fixture.pending.size,1);assert.equal(fixture.expired.length,5000);
 assert.equal(await pruneArtifacts(fixture.store,{artifactDir:root}),1);
 assert.equal(fixture.pending.size,0);
});
