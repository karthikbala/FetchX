import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createCipheriv} from 'node:crypto';
import {Sealer} from '../src/crypto.mjs';
import {compactArtifacts} from '../src/compact-artifacts.mjs';

test('compressed encrypted captures preserve all fields and authenticate before decoding',()=>{
 const key='21'.repeat(32),s=new Sealer(key);
 const value={id:'capture',captured_at:'2026-10-22T12:00:00Z',credits:null,cookies:['private'],body_base64:Buffer.from('source HTML '.repeat(100000)).toString('base64')};
 const iv=Buffer.alloc(12),cipher=createCipheriv('aes-256-gcm',Buffer.from(key,'hex'),iv);
 const legacy=Buffer.concat([iv,cipher.update(JSON.stringify(value)),cipher.final(),cipher.getAuthTag()]);
 assert.deepEqual(s.open(legacy),value);
 const compact=s.seal(value,{compress:true});
 assert.ok(compact.length<legacy.length/20);assert.deepEqual(s.open(compact),value);
 compact[20]^=1;assert.throws(()=>s.open(compact));
 assert.throws(()=>s.open(Buffer.alloc(20)),/invalid_artifact/);
});

test('offline compaction preserves capture identity, time and accounting and safely repeats',async()=>{
 const root=await mkdtemp(join(tmpdir(),'gateway-compact-'));
 const config={artifactDir:root,artifactKey:'31'.repeat(32)},s=new Sealer(config.artifactKey);
 const path=join(root,'11111111-1111-4111-8111-111111111111.bin');
 const value={id:'11111111-1111-4111-8111-111111111111',credits:1,captured_at:'original',body_base64:Buffer.from('source'.repeat(10000)).toString('base64')};
 try{
  await writeFile(path,s.seal(value));
  const result=await compactArtifacts(config);assert.equal(result.compacted,1);assert.ok(result.after_bytes<result.before_bytes/10);
  assert.deepEqual(s.open(await readFile(path)),value);
  const second=await compactArtifacts(config);assert.equal(second.compacted,0);assert.equal(second.before_bytes,second.after_bytes);
 }finally{await rm(root,{recursive:true,force:true});}
});
