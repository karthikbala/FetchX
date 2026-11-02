import {readFile,writeFile,stat,rename} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {sha} from '../src/crypto.mjs';

// Operator-only setup. Never invokes a provider or prints a token. Add reviewed
// access profiles before provisioning; this script cannot expand their origins.
export async function provisionV2Project({configPath,project,profileKeys,envPath,baseUrl='http://127.0.0.1:8788',mode='unmetered',maxDailyOperations}){
 if(!/^[A-Za-z0-9_.-]{1,80}$/.test(project)||!Array.isArray(profileKeys)||!profileKeys.length||!['unmetered','metered'].includes(mode))throw Error('provision_arguments_invalid');
 if(mode==='metered'&&(!Number.isSafeInteger(maxDailyOperations)||maxDailyOperations<1))throw Error('provision_quota_invalid');
 const source=resolve(configPath),output=resolve(envPath);
 if(source===output)throw Error('provision_output_conflict');
 const config=JSON.parse(await readFile(source,'utf8'));
 if(config.projects?.[project])throw Error('project_already_exists_use_explicit_key_rotation');
 for(const key of profileKeys)if(!config.v2?.accessProfiles?.[key])throw Error('reviewed_access_profile_required');
 const u=new URL(baseUrl);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw Error('gateway_url_invalid');
 try{await stat(output);throw Error('private_env_already_exists');}catch(e){if(e.code!=='ENOENT')throw e;}
 const token='fx_'+randomBytes(32).toString('base64url'),keyId='key_'+randomBytes(8).toString('hex');
 config.projects??={};config.projects[project]={tokenHash:sha(token),keyId,profiles:[],v2_access_profiles:profileKeys,v2_entitlement:{mode,...(mode==='metered'?{max_daily_operations:maxDailyOperations}:{})}};
 const temporary=source+'.v2-provision-'+randomBytes(6).toString('hex');
 // The env is the only token copy. Its exclusive creation cannot overwrite an
 // existing key; configuration replacement is atomic and contains only a hash.
 await writeFile(output,`FETCHX_URL=${u.origin}\nFETCHX_TOKEN=${token}\nFETCHX_PROJECT=${project}\nFETCHX_KEY_ID=${keyId}\n`,{mode:0o600,flag:'wx'});
 await writeFile(temporary,JSON.stringify(config,null,2)+'\n',{mode:0o600,flag:'wx'});
 await rename(temporary,source);
 return {config_path:source,private_env_path:output,key_id:keyId};
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),options={};
 for(let i=0;i<args.length;i+=2){if(!args[i]?.startsWith('--')||args[i+1]===undefined)throw Error('usage: --config PATH --project ID --profiles ID@VERSION --output PATH [--url URL] [--mode unmetered|metered] [--max-daily-operations N]');options[args[i].slice(2)]=args[i+1];}
 const result=await provisionV2Project({configPath:options.config,project:options.project,profileKeys:options.profiles?.split(','),envPath:options.output,baseUrl:options.url,mode:options.mode,maxDailyOperations:options['max-daily-operations']===undefined?undefined:Number(options['max-daily-operations'])});
 process.stdout.write(JSON.stringify(result)+'\n');
}
