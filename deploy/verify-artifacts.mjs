// Offline restore validation: every database capture must have exactly its own authenticated artifact.
import {readFile,readdir,lstat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Sealer} from '../src/crypto.mjs';

export async function verifyBackupArtifacts(root,references){
 const config=JSON.parse(await readFile(join(root,'secrets/gateway.json'),'utf8'));
 if(!Array.isArray(references)||typeof config.artifactDir!=='string')throw Error('artifact_reference_manifest_invalid');
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 const expected=new Map();
 for(const row of references){
  if(!row||!uuid.test(row.id??'')||!uuid.test(row.workflow??'')||row.result_path!==join(config.artifactDir,row.id+'.bin')||expected.has(row.id+'.bin'))throw Error('artifact_reference_manifest_invalid');
  expected.set(row.id+'.bin',row);
 }
 const directory=join(root,'artifacts'),names=(await readdir(directory)).filter(name=>name.endsWith('.bin'));
 if(names.length!==expected.size||names.some(name=>!expected.has(name)))throw Error('artifact_reference_mismatch');
 const sealer=new Sealer(config.artifactKey);
 for(const name of names){
  const path=join(directory,name);
  if(!(await lstat(path)).isFile())throw Error('artifact_file_invalid');
  const capture=sealer.open(await readFile(path)),reference=expected.get(name);
  if(capture?.id!==reference.id||capture?.workflow!==reference.workflow)throw Error('artifact_identity_mismatch');
 }
 return {referenced_artifacts:expected.size,authenticated_artifacts:names.length};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const [root,referenceFile]=process.argv.slice(2);
 const references=JSON.parse(await readFile(referenceFile,'utf8'));
 console.log(JSON.stringify(await verifyBackupArtifacts(root,references)));
}
