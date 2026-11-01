import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {cp,mkdir,mkdtemp,readFile,realpath,rm,symlink,writeFile,chmod,access} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseEnv} from 'node:util';

// Owned synthetic files/processes only. No config, credentials, database or providers.
const repository=fileURLToPath(new URL('..',import.meta.url));
let root,checkout;
before(async()=>{
 root=await realpath(await mkdtemp(join(tmpdir(),'fetchx relocation space ')));checkout=join(root,'FetchX # percent%');await mkdir(checkout);
 await cp(join(repository,'src'),join(checkout,'src'),{recursive:true});await mkdir(join(checkout,'scripts'));
 for(const name of ['provision-v2-project.mjs','init-config.mjs'])await cp(join(repository,'scripts',name),join(checkout,'scripts',name));
 await symlink(join(repository,'node_modules'),join(checkout,'node_modules'),'dir');
});
after(async()=>{if(root)await rm(root,{recursive:true,force:true});});
const environment=()=>({PATH:process.env.PATH??'/usr/bin:/bin',HOME:root,TMPDIR:root,GATEWAY_CONFIG:join(root,'owned-missing-config.json')});
function run(script,args=[]){return spawnSync(process.execPath,[join(checkout,script),...args],{cwd:checkout,env:environment(),encoding:'utf8',timeout:10000});}

test('relocated CLI entrypoints execute their guards before any config/database/provider work',()=>{
 const main=run('src/main.mjs');assert.notEqual(main.status,0,'main must enter startup instead of silently returning');assert.match(main.stderr,/ENOENT/);assert.ok(main.stderr.includes('owned-missing-config.json'));
 const compact=run('src/compact-artifacts.mjs');assert.notEqual(compact.status,0);assert.match(compact.stderr,/stop_gateway_before_compaction/);
 const provision=run('scripts/provision-v2-project.mjs',['--config']);assert.notEqual(provision.status,0);assert.match(provision.stderr,/usage: --config PATH/);
});

test('legacy and v2 launchers execute synthetic sibling workers from encoded directory names',async()=>{
 await writeFile(join(checkout,'src/browser-worker.mjs'),`let raw='';for await(const part of process.stdin)raw+=part;const input=JSON.parse(raw);process.stdout.write(JSON.stringify({status:200,headers:{'x-fixture':'synthetic-child'},cookies:[],body_base64:Buffer.from('synthetic legacy worker').toString('base64'),synthetic_url:input.url}));if(process.connected)process.disconnect();`);
 const {browserRequest}=await import(pathToFileURL(join(checkout,'src/browser.mjs')).href);
 const result=await browserRequest({url:'https://offline.invalid/synthetic',headers:{}},{maxResponseBytes:4096},{browser:{free:{executablePath:process.execPath,sha256:'synthetic-unused-pin',version:'synthetic',entitlement:'unlicensed'}}},'free','http://offline.invalid',null,null);
 assert.equal(result.status,200);assert.equal(result.body.toString(),'synthetic legacy worker');assert.equal(result.synthetic_url,'https://offline.invalid/synthetic');
 await writeFile(join(checkout,'src/v2-browser-worker.mjs'),`let raw='';for await(const part of process.stdin)raw+=part;const input=JSON.parse(raw);process.on('message',message=>{if(message.id!==7)return;process.stdout.write(JSON.stringify({status:200,error:null,capture_complete:true,counts_complete:true,synthetic_ack:message.result,synthetic_url:input.url}));if(process.connected)process.disconnect();});process.send({id:7,kind:'admit',data:{synthetic:true}});`);
 const {runBrowserProbe}=await import(pathToFileURL(join(checkout,'src/v2-browser-runner.mjs')).href);let admissions=0;
 const probe=await runBrowserProbe({url:'https://offline.invalid/synthetic',deadline:Date.now()+5000},{admit:async data=>{admissions++;assert.deepEqual(data,{synthetic:true});return{synthetic:true};},artifact:async()=>assert.fail('No artifacts expected')});
 assert.equal(admissions,1);assert.equal(probe.status,200);assert.equal(probe.error,null);assert.deepEqual(probe.synthetic_ack,{synthetic:true});
});

test('Python transport hands a decoded sibling filename and stdin to a synthetic interpreter',async()=>{
 const interpreter=join(root,'synthetic interpreter.mjs');
 await writeFile(interpreter,`#!/usr/bin/env node\nimport{readFile}from'node:fs/promises';try{const script=await readFile(process.argv[2],'utf8');if(!script.includes('Private child transport'))throw Error();let raw='';for await(const part of process.stdin)raw+=part;const input=JSON.parse(raw);if(input.url!=='https://offline.invalid/synthetic')throw Error();process.stdout.write(JSON.stringify({status:200,headers:[],body_base64:Buffer.from('synthetic transport').toString('base64'),received_bytes:19}));}catch{process.exitCode=2;}`);await chmod(interpreter,0o700);
 const old=process.env.GATEWAY_PYTHON;process.env.GATEWAY_PYTHON=interpreter;
 try{const{oxylabsRequest}=await import(pathToFileURL(join(checkout,'src/transport.mjs')).href);const result=await oxylabsRequest({url:'https://offline.invalid/synthetic',method:'GET',headers:{}},{url:'http://offline.invalid'},{maxResponseBytes:4096});assert.equal(result.status,200);assert.equal(result.body.toString(),'synthetic transport');assert.equal(result.error,null);}
 finally{old===undefined?delete process.env.GATEWAY_PYTHON:process.env.GATEWAY_PYTHON=old;}
});

test('quickstart accepts a literal space path, quotes it in dotenv, and rejects interpolation/control characters',async()=>{
 const setup=join(root,'local config');const result=run('scripts/init-config.mjs',[setup]);assert.equal(result.status,0,result.stderr);
 const content=await readFile(join(setup,'compose.env'),'utf8'),parsed=parseEnv(content);assert.equal(parsed.FETCHX_HOME,resolve(setup));assert.ok(content.startsWith(`FETCHX_HOME='${resolve(setup)}'\n`));
 const again=run('scripts/init-config.mjs',[setup]);assert.notEqual(again.status,0);assert.match(again.stderr,/already exists/);
 for(const suffix of ['$literal',"quote'",'back`tick','line\nbreak']){const rejected=join(root,'unsafe '+suffix),attempt=run('scripts/init-config.mjs',[rejected]);assert.notEqual(attempt.status,0);await assert.rejects(access(rejected),{code:'ENOENT'});}
});
