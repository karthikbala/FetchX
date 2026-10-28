// Operator-only streaming AEAD archive encryption. Key material is read from a protected file.
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {createReadStream,createWriteStream} from 'node:fs';
import {readFile,open,stat,appendFile} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';
const [action,input,output,keyFile]=process.argv.slice(2),key=Buffer.from((await readFile(keyFile,'utf8')).trim(),'hex');
if(key.length!==32||!['encrypt','decrypt'].includes(action))throw Error('invalid_backup_arguments');
if(action==='encrypt'){
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
 const sink=createWriteStream(output,{mode:0o600,flags:'wx'});sink.write(Buffer.concat([Buffer.from('CGW1'),iv]));
 await pipeline(createReadStream(input),cipher,sink);await appendFile(output,cipher.getAuthTag());
}else{
 const size=(await stat(input)).size,fd=await open(input),header=Buffer.alloc(16),tag=Buffer.alloc(16);
 try{await fd.read(header,0,16,0);await fd.read(tag,0,16,size-16);}finally{await fd.close();}
 if(size<32||header.subarray(0,4).toString()!=='CGW1')throw Error('invalid_backup');
 const cipher=createDecipheriv('aes-256-gcm',key,header.subarray(4));cipher.setAuthTag(tag);
 await pipeline(createReadStream(input,{start:16,end:size-17}),cipher,createWriteStream(output,{mode:0o600,flags:'wx'}));
 // Never extract the output unless pipeline completed and authenticated the whole archive.
}
