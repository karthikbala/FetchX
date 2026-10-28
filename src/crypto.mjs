import {createCipheriv,createDecipheriv,randomBytes,createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
export const sha=value=>createHash('sha256').update(value).digest('hex');
export class Sealer {
 constructor(key){this.key=Buffer.from(key,'hex');if(this.key.length!==32)throw Error('invalid_artifact_key');}
 // The codec marker is inside the authenticated payload. Existing raw JSON captures
 // remain readable; request inputs stay raw so their durable comparison is unchanged.
 seal(value,{compress=false}={}){
  const raw=Buffer.from(JSON.stringify(value));
  const compressed=compress?gzipSync(raw):null;
  const payload=compressed&&compressed.length<raw.length?compressed:raw;
  const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',this.key,iv);
  return Buffer.concat([iv,c.update(payload),c.final(),c.getAuthTag()]);
 }
 open(value){
  const b=Buffer.from(value);
  if(b.length<28)throw Error('invalid_artifact');
  const d=createDecipheriv('aes-256-gcm',this.key,b.subarray(0,12));d.setAuthTag(b.subarray(-16));
  const plain=Buffer.concat([d.update(b.subarray(12,-16)),d.final()]);
  const json=plain[0]===0x1f&&plain[1]===0x8b?gunzipSync(plain,{maxOutputLength:64*1024*1024}):plain;
  return JSON.parse(json.toString());
 }
}
