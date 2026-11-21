import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {cp,mkdir,mkdtemp,readFile,realpath,rm,symlink,access} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseEnv} from 'node:util';

// Owned synthetic files/processes only. No config, credentials, database or providers.
const repository=fileURLToPath(new URL('..',import.meta.url));
let root,checkout;
before(async()=>{
 root=await realpath(await mkdtemp(join(tmpdir(),'fetchx relocation space ')));checkout=join(root,'FetchX # percent%');await mkdir(checkout);
 await cp(join(repository,'src'),join(checkout,'src'),{recursive:true});await mkdir(join(checkout,'scripts'));
 // The image's layout (Dockerfile): src, plus the changelog the API reads its version and retired routes from.
 await mkdir(join(checkout,'docs'));await cp(join(repository,'docs','changelog.json'),join(checkout,'docs','changelog.json'));
 for(const name of ['init-config.mjs'])await cp(join(repository,'scripts',name),join(checkout,'scripts',name));
 await symlink(join(repository,'node_modules'),join(checkout,'node_modules'),'dir');
});
after(async()=>{if(root)await rm(root,{recursive:true,force:true});});
const environment=()=>({PATH:process.env.PATH??'/usr/bin:/bin',HOME:root,TMPDIR:root,PLATFORM_CONFIG:join(root,'owned-missing-config.json')});
function run(script,args=[]){return spawnSync(process.execPath,[join(checkout,script),...args],{cwd:checkout,env:environment(),encoding:'utf8',timeout:10000});}

test('relocated server entrypoint enters startup before any database or provider work',()=>{
 const main=run('src/server.mjs');assert.notEqual(main.status,0,'the server must enter startup instead of silently returning');assert.match(main.stderr,/ENOENT/);assert.ok(main.stderr.includes('owned-missing-config.json'));
});

test('quickstart accepts a literal space path, quotes it in dotenv, and rejects interpolation/control characters',async()=>{
 const setup=join(root,'local config');const result=run('scripts/init-config.mjs',[setup]);assert.equal(result.status,0,result.stderr);
 const content=await readFile(join(setup,'compose.env'),'utf8'),parsed=parseEnv(content);assert.equal(parsed.FETCHX_HOME,resolve(setup));assert.ok(content.startsWith(`FETCHX_HOME='${resolve(setup)}'\n`));
 const again=run('scripts/init-config.mjs',[setup]);assert.notEqual(again.status,0);assert.match(again.stderr,/already exists/);
 for(const suffix of ['$literal',"quote'",'back`tick','line\nbreak']){const rejected=join(root,'unsafe '+suffix),attempt=run('scripts/init-config.mjs',[rejected]);assert.notEqual(attempt.status,0);await assert.rejects(access(rejected),{code:'ENOENT'});}
});
