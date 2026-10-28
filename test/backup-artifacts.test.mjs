import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {verifyBackupArtifacts} from '../deploy/verify-artifacts.mjs';
import {Sealer} from '../src/crypto.mjs';

const operation='11111111-1111-4111-8111-111111111111';
const other='22222222-2222-4222-8222-222222222222';
const workflow='33333333-3333-4333-8333-333333333333';
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'gateway-backup-artifacts-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'secrets'));await mkdir(join(root,'artifacts'));
 const key='11'.repeat(32),sealer=new Sealer(key);
 await writeFile(join(root,'secrets/gateway.json'),JSON.stringify({artifactDir:'/data/artifacts',artifactKey:key}));
 const path=join(root,'artifacts',operation+'.bin');
 await writeFile(path,sealer.seal({id:operation,workflow,body_base64:'source'}));
 return {root,sealer,path,references:[{id:operation,workflow,result_path:'/data/artifacts/'+operation+'.bin'}]};
}

test('restore verification matches database references and authenticates each capture identity',async t=>{
 const f=await fixture(t);
 assert.deepEqual(await verifyBackupArtifacts(f.root,f.references),{referenced_artifacts:1,authenticated_artifacts:1});
});
test('a missing capture fails restore proof even when database counts still match',async t=>{
 const f=await fixture(t);await rm(f.path);
 await assert.rejects(verifyBackupArtifacts(f.root,f.references),/artifact_reference_mismatch/);
});
test('equal file counts cannot hide an incorrect or unreferenced artifact',async t=>{
 const f=await fixture(t);await rm(f.path);
 await writeFile(join(f.root,'artifacts',other+'.bin'),f.sealer.seal({id:other,workflow}));
 await assert.rejects(verifyBackupArtifacts(f.root,f.references),/artifact_reference_mismatch/);
});
test('authenticated artifacts cannot be swapped between operation or workflow identities',async t=>{
 const f=await fixture(t);
 for(const capture of [{id:other,workflow},{id:operation,workflow:other}]){
  await writeFile(f.path,f.sealer.seal(capture));
  await assert.rejects(verifyBackupArtifacts(f.root,f.references),/artifact_identity_mismatch/);
 }
});
test('corrupt captures and duplicate or invalid database references fail verification',async t=>{
 const f=await fixture(t),body=await readFile(f.path);body[20]^=1;await writeFile(f.path,body);
 await assert.rejects(verifyBackupArtifacts(f.root,f.references));
 await assert.rejects(verifyBackupArtifacts(f.root,[...f.references,...f.references]),/artifact_reference_manifest_invalid/);
 await assert.rejects(verifyBackupArtifacts(f.root,[{...f.references[0],result_path:'/elsewhere/'+operation+'.bin'}]),/artifact_reference_manifest_invalid/);
});
test('a linked artifact cannot satisfy a restored capture reference',async t=>{
 const f=await fixture(t);await rm(f.path);await symlink('../secrets/gateway.json',f.path);
 await assert.rejects(verifyBackupArtifacts(f.root,f.references),/artifact_file_invalid/);
});
