import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

// This is a local operator tool; it creates no public administration endpoint.
const args=process.argv.slice(2);
const [operation,environment,reference]=args;
if(!['status','retry','purge'].includes(operation)||!['preview','production'].includes(environment)) {
 console.error('Usage: node ops/enquiries.mjs status|purge preview|production [--apply]\n       node ops/enquiries.mjs retry preview|production FX-<UUID>');
 process.exit(1);
}
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const config=JSON.parse(await fs.readFile(path.join(root,'wrangler.jsonc'),'utf8'));
const accountId=JSON.parse(await fs.readFile(path.join(root,'wrangler.retention.jsonc'),'utf8')).account_id;
const settings=config.env[environment];
const database=settings.d1_databases.find(db=>db.binding==='DB').database_id;
const authPath=process.platform==='darwin'?path.join(os.homedir(),'Library/Preferences/.wrangler/config/default.toml'):path.join(os.homedir(),'.config/.wrangler/config/default.toml');
let token=process.env.CLOUDFLARE_API_TOKEN;
if(!token){const auth=await fs.readFile(authPath,'utf8');token=auth.match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1];}
if(!token)throw new Error('Run wrangler login, or provide CLOUDFLARE_API_TOKEN through your environment.');
async function query(statements){
 const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${database}/query`,{
  method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(Array.isArray(statements)?{batch:statements}:statements),signal:AbortSignal.timeout(20_000),
 });
 const data=await response.json();
 if(!response.ok||!data.success||data.result?.some(r=>!r.success))throw new Error('D1 operation failed. Check Wrangler authentication and database access.');
 return data.result;
}
class Statement {
 constructor(sql,params=[]){this.sql=sql;this.params=params;}
 bind(...params){return new Statement(this.sql,params);}
 async first(){return (await query({sql:this.sql,params:this.params}))[0].results[0]??null;}
 async run(){return (await query({sql:this.sql,params:this.params}))[0];}
}
const DB={prepare(sql){return new Statement(sql);},batch(statements){return query(statements.map(s=>({sql:s.sql,params:s.params})));}};
if(operation==='status'){
 const result=await query({sql:'SELECT reference, created_at, expires_at, notification_status, notification_attempts, notification_first_attempt_at, notification_error FROM enquiries ORDER BY created_at DESC LIMIT 100',params:[]});
 console.log(JSON.stringify({environment,enquiries:result[0].results},null,2));
} else if(operation==='purge') {
 const now=Date.now();
 if(!args.includes('--apply')){
  const counts=await query([{sql:'SELECT COUNT(*) AS expired_enquiries FROM enquiries WHERE expires_at<=?',params:[now]},{sql:'SELECT COUNT(*) AS expired_rate_buckets FROM rate_buckets WHERE expires_at<=?',params:[now]}]);
  console.log(JSON.stringify({environment,dryRun:true,counts:counts.map(r=>r.results[0])},null,2));
 } else {
  const result=await query([{sql:'DELETE FROM enquiries WHERE expires_at<=?',params:[now]},{sql:'DELETE FROM rate_buckets WHERE expires_at<=?',params:[now]}]);
  console.log(JSON.stringify({environment,purged:result.map(r=>r.meta.changes)}));
 }
} else {
 if(!/^FX-[A-F0-9]{8}-[A-F0-9]{4}-4[A-F0-9]{3}-[89AB][A-F0-9]{3}-[A-F0-9]{12}$/.test(reference||''))throw new Error('Provide one exact enquiry reference.');
 if(!process.env.RESEND_API_KEY)throw new Error('Provide RESEND_API_KEY through your environment, never a command argument.');
 const compiled=await build({entryPoints:[path.join(root,'src/server/pilot.ts')],bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'});
 const {notifyEnquiry}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
 const status=await notifyEnquiry(reference,{...settings.vars,DB,RESEND_API_KEY:process.env.RESEND_API_KEY});
 console.log(JSON.stringify({environment,reference,status}));
 if(status==='skipped')console.log('No send attempted: inspect status for an existing send, active lease, expired record, or first send more than 23 hours ago.');
}
