// Offline maintenance: keep the service stopped while atomically replacing captures.
// Compare the complete decrypted value before replacement, including billing and time.
import {readFile,readdir,open,rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {Sealer} from './crypto.mjs';

export async function compactArtifacts(config){
 const sealer=new Sealer(config.artifactKey);
 const result={files:0,compacted:0,before_bytes:0,after_bytes:0};
 for(const name of await readdir(config.artifactDir)){
  if(!/^[a-f0-9-]{36}\.bin$/.test(name))continue;
  const path=join(config.artifactDir,name),before=await readFile(path);
  const value=sealer.open(before),after=sealer.seal(value,{compress:true});
  if(!isDeepStrictEqual(value,sealer.open(after)))throw Error('capture_compaction_mismatch');
  result.files++;result.before_bytes+=before.length;
  if(after.length<before.length){
   const tmp=path+'.compact';let handle,created=false;
   try{
    handle=await open(tmp,'wx',0o600);created=true;await handle.writeFile(after);await handle.sync();await handle.close();handle=null;
    await rename(tmp,path);result.compacted++;result.after_bytes+=after.length;
   }finally{await handle?.close();if(created)await unlink(tmp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
  }else result.after_bytes+=before.length;
 }
 return result;
}

if(process.argv[1]===new URL(import.meta.url).pathname){
 if(process.argv[2]!=='--service-stopped')throw Error('stop_gateway_before_compaction');
 const config=JSON.parse(await readFile(process.env.GATEWAY_CONFIG??'/run/secrets/gateway.json','utf8'));
 console.log(JSON.stringify(await compactArtifacts(config)));
}
