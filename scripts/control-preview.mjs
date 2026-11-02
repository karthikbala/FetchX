#!/usr/bin/env node
import {randomBytes,createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir,chmod,lstat,readFile,writeFile,open} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {Store} from '../src/store.mjs';
import {Gateway} from '../src/gateway.mjs';
import {GatewayError} from '../src/policy.mjs';
import {ControlIdentity} from '../src/control-identity.mjs';
import {ControlCredits} from '../src/control-credits.mjs';
import {V2Gateway} from '../src/v2.mjs';
import {server} from '../src/main.mjs';

const ROOT=resolve(fileURLToPath(new URL('..',import.meta.url)),'.local/selfservice-preview');
const BASE='http://127.0.0.1:8789';
const HELP=`Usage: node scripts/control-preview.mjs --database-url <local gateway_test_* PostgreSQL URL> [--fixture] [--origin <loopback website origin>]

CONTROL_PREVIEW_DATABASE_URL may supply the explicitly disposable database URL.
The database is created if absent and reused without truncation. Bind: ${BASE}.
Default origin: http://127.0.0.1:4331.
Default source: real native HTTPS to example.com, GET/HEAD, direct route only.
--fixture: offline source.example transport with /success, /forbidden, /not-found,
           /unknown and /slow scenarios; no source/provider network requests.
Verification codes go only to a private local mailbox file; no email is sent.
Generated secrets and encrypted captures stay in ignored .local/selfservice-preview.
No provider credentials, paid routes, jobs, checkout, or production configuration.
`;

function argumentsFor(argv){
 const options={database:process.env.CONTROL_PREVIEW_DATABASE_URL,fixture:false,origin:'http://127.0.0.1:4331'};
 for(let i=0;i<argv.length;i++){
  const arg=argv[i];
  if(arg==='--help'||arg==='-h')return {help:true};
  if(arg==='--fixture'){options.fixture=true;continue;}
  if(arg==='--database-url'||arg==='--origin'){
   const value=argv[++i];if(!value||value.startsWith('--'))throw Error('preview_argument_missing');
   options[arg==='--database-url'?'database':'origin']=value;continue;
  }
  throw Error('preview_argument_unknown');
 }
 if(!options.database)throw Error('preview_disposable_database_required');
 let url,origin;try{url=new URL(options.database);origin=new URL(options.origin);}catch{throw Error('preview_url_invalid');}
 if(!['postgres:','postgresql:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!/^\/gateway_test_[A-Za-z0-9_]+$/.test(decodeURIComponent(url.pathname))||url.hash||url.search)throw Error('preview_disposable_local_database_required');
 if(!['http:','https:'].includes(origin.protocol)||!['127.0.0.1','localhost','[::1]'].includes(origin.hostname)||origin.origin!==options.origin||origin.username||origin.password)throw Error('preview_exact_loopback_origin_required');
 return {...options,url,databaseName:decodeURIComponent(url.pathname.slice(1))};
}

async function privateDirectory(path){
 await mkdir(path,{recursive:true,mode:0o700});
 const stat=await lstat(path);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('preview_private_directory_required');
 await chmod(path,0o700);
}
async function privateWrite(path,value,{exclusive=false}={}){
 // O_NOFOLLOW prevents an existing local symlink redirecting a secret write.
 const file=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_NOFOLLOW|(exclusive?constants.O_EXCL:constants.O_TRUNC),0o600);
 try{await file.chmod(0o600);await file.writeFile(value);}finally{await file.close();}
}
async function stateFor(options){
 await privateDirectory(ROOT);
 const identity=JSON.stringify({host:options.url.hostname,port:options.url.port||'5432',user:options.url.username,database:options.databaseName});
 const databaseFingerprint=createHash('sha256').update(identity).digest('hex');
 const path=join(ROOT,'state.json'),mode=options.fixture?'fixture':'native';
 let state;
 try{
  const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink())throw Error('preview_state_invalid');
  await chmod(path,0o600);state=JSON.parse(await readFile(path,'utf8'));
  if(state.version!==1||state.databaseFingerprint!==databaseFingerprint||state.mode!==mode||! /^[a-f0-9]{64}$/.test(state.artifactKey)||! /^[a-f0-9]{64}$/.test(state.bridgeSecret))throw Error('preview_state_mismatch_use_existing_database_and_mode');
 }catch(error){
  if(error.code!=='ENOENT')throw error;
  state={version:1,mode,databaseFingerprint,artifactKey:randomBytes(32).toString('hex'),bridgeSecret:randomBytes(32).toString('hex')};
  await privateWrite(path,JSON.stringify(state,null,2)+'\n',{exclusive:true});
 }
 return state;
}

function configuration(options,state){
 const source=options.fixture?'https://source.example':'https://example.com';
 const profile={id:options.fixture?'preview-fixture':'preview-example',version:1,origins:[source],paths:options.fixture?['^/(?:success|forbidden|not-found|unknown|slow)?$']:['^/$'],methods:['GET','HEAD'],headers:['accept'],proxy_classes:['direct'],countries:[],
  limits:{max_requests:100,max_encoded_bytes:262144,max_decoded_bytes:1048576,max_session_encoded_bytes:4194304,max_input_bytes:1024,max_tunnel_bytes:262144,max_redirects:0,max_expansion_ratio:100,timeout_ms:15000,min_interval_ms:options.fixture?0:1000,ttl_seconds:900}};
 return {release:'selfservice-local-'+state.mode,artifactDir:join(ROOT,'captures'),artifactKey:state.artifactKey,maxDailyFallbackCredits:0,maxConcurrentRequests:4,projects:{},proxies:[],jobs:{enabled:false},
  v2:{maxArtifactBytes:64*1024*1024,accessProfiles:{[profile.id+'@1']:profile}},controlPlane:{enabled:true,origins:[options.origin],bridgeSecret:state.bridgeSecret,sessionSecure:false,allowLoopbackDevelopment:true,apiBaseUrl:BASE,
   projectTemplate:{id:'local-preview-'+state.mode+'-v1',v2_access_profiles:[profile.id+'@1'],v2_entitlement:{mode:'metered',max_daily_operations:100}},
   creditPolicy:{reviewed:true,version:'local-preview-direct-v1',trialCredits:25,weights:{direct:1},maxEstimatedMicroUsdPerOperation:0}}};
}

async function ensureDatabase(options){
 const adminURL=new URL(options.url);adminURL.pathname='/postgres';
 const admin=new pg.Client({connectionString:adminURL.href,connectionTimeoutMillis:5000});
 try{
  await admin.connect();
  if(!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[options.databaseName])).rowCount){
   // Name is restricted to gateway_test_[A-Za-z0-9_]+ before identifier use.
   try{await admin.query(`CREATE DATABASE "${options.databaseName}"`);}catch(error){if(error.code!=='42P04')throw error;}
  }
 }finally{await admin.end();}
}

function fixtureHttp(){
 return async(input,destination,limits,{proxy})=>{
  const url=new URL(input.url);
  if(proxy!==null||url.origin!=='https://source.example'||!['GET','HEAD'].includes(input.method)||destination.address!=='93.184.216.34')throw new GatewayError('preview_fixture_scope_rejected',403);
  if(url.pathname==='/slow')await new Promise(resolve=>setTimeout(resolve,500));
  if(url.pathname==='/unknown')throw Object.assign(new GatewayError('source_timeout_unknown',504),{observed_encoded_bytes:0,observed_tunnel_bytes:0});
  const status=url.pathname==='/forbidden'?403:url.pathname==='/not-found'?404:200;
  const encoded=input.method==='HEAD'?Buffer.alloc(0):Buffer.from(JSON.stringify({fixture:true,source:'offline source.example',status,records:[{id:'synthetic-001',name:'Synthetic fixture record'}]}));
  return {status,headers:{'content-type':'application/json; charset=utf-8'},raw_headers:['content-type','application/json; charset=utf-8'],encoded,tunnel_bytes:null,provider_status:null};
 };
}

async function main(){
 const options=argumentsFor(process.argv.slice(2));if(options.help){process.stdout.write(HELP);return;}
 const state=await stateFor(options),config=configuration(options,state);
 await privateDirectory(config.artifactDir);
 const outbox=join(ROOT,'mailbox.jsonl');
 const outboxFile=await open(outbox,constants.O_WRONLY|constants.O_CREAT|constants.O_APPEND|constants.O_NOFOLLOW,0o600);await outboxFile.chmod(0o600);await outboxFile.close();
 await privateWrite(join(ROOT,'gateway.json'),JSON.stringify(config,null,2)+'\n');
 const env=[`FETCHX_CONTROL_URL=${BASE}`,`FETCHX_CONTROL_SECRET=${state.bridgeSecret}`,'FETCHX_CONTROL_ALLOW_LOOPBACK=true','SITE_ENV=development',`ALLOWED_ORIGINS=${options.origin}`].join('\n')+'\n';
 await privateWrite(join(ROOT,'bridge.env'),env);
 await ensureDatabase(options);
 const store=new Store(options.url.href);let app,stopping=false;
 const stop=async()=>{if(stopping)return;stopping=true;try{if(app)await app.close();}finally{await store.close();}};
 try{
  // PostgreSQL advisory locks belong to this explicitly disposable database.
  await store.acquireRunnerLock(()=>{process.stderr.write('Local preview database ownership lost.\n');void stop().finally(()=>{process.exitCode=1;});});
  await store.init();await store.recover();
  const gateway=new Gateway({store,config,profiles:{},...(options.fixture?{resolve:async()=>[{address:'93.184.216.34',family:4}]}:{})});
  gateway.controlIdentity=new ControlIdentity({store,config,mail:{configured:true,delivery:'local_private_mailbox',sendCode:async message=>{
   const file=await open(outbox,constants.O_WRONLY|constants.O_CREAT|constants.O_APPEND|constants.O_NOFOLLOW,0o600);try{await file.chmod(0o600);await file.writeFile(JSON.stringify({delivered_by:'local_private_mailbox',...message})+'\n');}finally{await file.close();}
  }}});
  gateway.controlCredits=new ControlCredits({store,config});
  gateway.v2=new V2Gateway(gateway,{browserRuntime:async()=>({available:false,reason:'local_preview_http_only'}),...(options.fixture?{http:fixtureHttp()}:{})});
  app=server(gateway);await app.listen({host:'127.0.0.1',port:8789});
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void stop().catch(()=>{process.stderr.write('Local preview shutdown failed.\n');process.exitCode=1;});});
  process.stdout.write(`FetchX local self-service preview: ${BASE}\nWebsite origin: ${options.origin}\nDatabase: ${options.databaseName} (disposable; retained on shutdown)\nTransport: ${options.fixture?'offline synthetic source.example scenarios':'native HTTPS example.com GET/HEAD; direct only; zero paid-provider allowance'}\nVerification: private local mailbox; no email is sent. Read codes locally at ${outbox}\nProxy configuration: ${join(ROOT,'bridge.env')} (private; no secret printed)\nGenerated local configuration: ${join(ROOT,'gateway.json')}\nNo source request was made at startup. Press Ctrl-C to stop.\n`);
 }catch(error){await stop();throw error;}
}

main().catch(error=>{
 // Never print PostgreSQL URLs, mail payloads, arbitrary exception text or secrets.
 const safe=/^preview_[a-z0-9_]+$/.test(error?.message??'')?error.message:error?.code==='EADDRINUSE'?'preview_loopback_port_8789_in_use':'preview_startup_failed';
 process.stderr.write(safe+'\n');process.exitCode=1;
});
