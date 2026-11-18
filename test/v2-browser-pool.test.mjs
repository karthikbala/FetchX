import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {chmod,mkdtemp,readFile,rename,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as wait} from 'node:timers/promises';
import {BrowserWorkerPool} from '../src/v2-browser-pool.mjs';
import {BROWSER_PROBE_QUALIFICATION_KIND,binarySha,browserProbePolicy} from '../src/v2-browser-policy.mjs';
import {browserRelay} from '../src/v2-browser-relay.mjs';
import {runBrowserProbe} from '../src/v2-browser-runner.mjs';
import {startBrowserWorker} from '../src/v2-browser-worker-service.mjs';
import {openWorkerTunnel,requestJson,WORKER_TRANSPORT_ERROR} from '../src/v2-browser-worker-wire.mjs';
import {Gateway} from '../src/gateway.mjs';
import {GatewayError} from '../src/policy.mjs';
import {sha} from '../src/crypto.mjs';
import {Store} from '../src/store.mjs';
import {V2Gateway,recoverV2} from '../src/v2.mjs';

const target='source.example',url='https://'+target+'/';
const policy=browserProbePolicy({enabled:true,max_requests:4,max_network_bytes:4096,max_decoded_bytes:4096,max_dom_bytes:1024,settle_ms:0});
const success={capture_complete:false,counts_complete:true,status:200,cookies:[]};
const browserRequest={url,method:'GET',headers:{},body_base64:null,resource_type:'document',redirect_depth:0,redirected_from:null};
const connect=(relay,hostname=target)=>openWorkerTunnel({host:'127.0.0.1',port:Number(new URL(relay).port)},hostname+':443',{signal:AbortSignal.timeout(1500)});
const waitForAbort=signal=>signal.aborted?Promise.resolve():new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
const closed=server=>new Promise(resolve=>server.close(resolve));

async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'fx-pool-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const executablePath=join(directory,'browser');
 await writeFile(executablePath,'synthetic pinned browser fixture');
 await chmod(executablePath,0o700);
 const pin={engine:'chromium',version:'151.0.7922.34',sha256:await binarySha(executablePath),executablePath};
 const runtime={...pin,platform:process.platform,arch:process.arch,expires_at:'2099-01-01'};
 const config={registry_path:join(directory,'registry.json'),callback_socket:join(directory,'callback.sock')};
 const workers=[];
 const pool=new BrowserWorkerPool(config);
 t.after(async()=>{await pool.close();await Promise.all(workers.map(worker=>worker.close()));});
 const add=async(id,runner)=>{
  const socket_path=join(directory,id+'.sock');
  const worker=await startBrowserWorker({socketPath:socket_path,callbackSocket:config.callback_socket,pin,runner});
  workers.push(worker);
  return {id,socket_path,state:'active',close:worker.close};
 };
 const registry=async(...entries)=>{
  await writeFile(config.registry_path+'.new',JSON.stringify(entries.map(({id,socket_path,state})=>({id,socket_path,state}))));
  await rename(config.registry_path+'.new',config.registry_path);
 };
 const input=(relay='http://127.0.0.1:1',timeout_ms=5000)=>({url,policy,runtime,relay,timeout_ms,deadline:Date.now()+timeout_ms,screenshot:false,cookies:[]});
 return {pool,add,registry,input,runtime,config,executablePath};
}

async function echoRelay(t){
 const sockets=new Set();
 const backend=net.createServer(socket=>{
  sockets.add(socket);
  socket.on('error',()=>{});
  socket.once('close',()=>sockets.delete(socket));
  socket.on('data',bytes=>socket.write(bytes.toString().toUpperCase()));
 });
 await new Promise((resolve,reject)=>backend.once('error',reject).listen(0,'127.0.0.1',resolve));
 t.after(async()=>{for(const socket of sockets)socket.destroy();await closed(backend);});
 const destination={address:'93.184.216.34',url:new URL(url),family:4};
 const dial=actual=>{
  assert.equal(actual.address,destination.address);
  return net.connect({host:'127.0.0.1',port:backend.address().port});
 };
 return {destination,dial};
}

async function roundTrip(tunnel){
 assert.equal(tunnel.status,200);
 const data=new Promise((resolve,reject)=>{
  tunnel.socket.once('data',resolve);
  tunnel.socket.once('error',reject);
 });
 tunnel.socket.write('hello');
 assert.equal((await data).toString(),'HELLO');
}

test('registry reloads on admission, drains running slots and refuses duplicate or unpinned workers',async t=>{
 const {pool,add,registry,input,runtime,config,executablePath}=await fixture(t);
 const entered=Promise.withResolvers(),finish=Promise.withResolvers();
 const a=await add('a',async()=>{entered.resolve();await finish.promise;return success;});
 const b=await add('b',async()=>success);
 t.after(()=>finish.resolve());
 await registry(a);
 assert.equal(await pool.ready(runtime),true);
 assert.equal(await pool.ready({...runtime,sha256:'0'.repeat(64)}),false);
 assert.equal((await stat(a.socket_path)).mode&0o777,0o600);
 const attempts=await Promise.allSettled([pool.acquire(runtime),pool.acquire(runtime)]);
 assert.equal(attempts.filter(attempt=>attempt.status==='fulfilled').length,1);
 assert.equal(attempts.find(attempt=>attempt.status==='rejected').reason.code,'browser_capacity');
 const slot=attempts.find(attempt=>attempt.status==='fulfilled').value;
 const pending=slot.run(input(),{});
 try{
  await entered.promise;
  assert.equal((await requestJson(a.socket_path,'/healthz')).value.busy,true);
  assert.equal((await stat(config.callback_socket)).mode&0o777,0o600);
  const duplicate=await requestJson(a.socket_path,'/v1/render',{data:{},token:'z'.repeat(43)});
  assert.equal(duplicate.status,409);
  await registry({...a,state:'draining'},b);
  const other=await pool.acquire(runtime);
  assert.equal((await other.run(input(),{})).status,200);
  other.release();
  await registry({...a,state:'draining'});
  await assert.rejects(pool.acquire(runtime),{code:'browser_capacity'});
  assert.equal(await pool.ready(runtime),false);
 }finally{finish.resolve();await pending;slot.release();}
 await registry(a);
 const restored=await pool.acquire(runtime);
 restored.release();
 await registry(a,{...a,id:'alias'});
 assert.equal(await pool.ready(runtime),false);
 await registry(a);
 await writeFile(executablePath,'mutated pinned executable');
 assert.equal(await pool.ready(runtime),false);
});

test('worker forwards only authenticated attempt CONNECT and bounded callbacks to the gateway relay',async t=>{
 const {pool,add,registry,input,runtime,config}=await fixture(t);
 const {destination,dial}=await echoRelay(t);
 const pinnedDestinations=new Map();
 let admissions=0,dispatches=0,artifacts=0,cooldowns=0;
 const relay=await browserRelay({profile:{origins:[destination.url.origin]},pinnedDestinations,limits:policy,deadline:Date.now()+8000,dial,beforeConnect:async()=>{dispatches++;}});
 t.after(()=>relay.close());
 const worker=await add('worker',async(probe,hooks)=>{
  assert.equal(probe.url,url);
  assert.equal(probe.runtime.executablePath,runtime.executablePath);
  assert.notEqual(probe.relay,relay.url);
  for(const [listener,hostname] of [[probe.deny_relay,target],[probe.relay,'private.example']]){
   const denied=await connect(listener,hostname);
   assert.equal(denied.status,403);
   denied.socket.destroy();
  }
  const ordinary=await new Promise((resolve,reject)=>http.get(probe.relay,res=>{res.resume();resolve(res.statusCode);}).on('error',reject));
  assert.equal(ordinary,403);
  await assert.rejects(hooks.admit({...browserRequest,method:'POST'}),{code:'method_rejected'});
  await hooks.admit(browserRequest);
  const tunnel=await connect(probe.relay);
  try{await roundTrip(tunnel);}finally{tunnel.socket.destroy();}
  await hooks.artifact({kind:'rendered_dom'});
  await hooks.cooldown({url,status:429,retry_after:'2'});
  return success;
 });
 await registry(worker);
 const slot=await pool.acquire(runtime);
 const unauthenticated=await openWorkerTunnel({socketPath:config.callback_socket},target+':443',{token:'x'.repeat(43),signal:AbortSignal.timeout(1000)});
 assert.equal(unauthenticated.status,403);
 unauthenticated.socket.destroy();
 try{
  const result=await slot.run(input(relay.url),{
   admit:async request=>{
    if(request.method!=='GET')throw new GatewayError('method_rejected');
    assert.deepEqual(request,browserRequest);
    admissions++;
    pinnedDestinations.set(target,{destination,permits:1});
    return {ok:true};
   },
   artifact:async value=>{assert.deepEqual(value,{kind:'rendered_dom'});artifacts++;},
   cooldown:async value=>{assert.deepEqual(value,{url,status:429,retry_after:'2'});cooldowns++;}
  });
  assert.deepEqual(result,success);
 }finally{slot.release();await relay.close();}
 assert.deepEqual([admissions,dispatches,artifacts,cooldowns,relay.bytes,relay.meter_complete],[1,1,1,1,10,true]);
});

test('closing gateway transport aborts the worker slot and revokes its callbacks',async t=>{
 const {pool,add,registry,input,runtime}=await fixture(t);
 const entered=Promise.withResolvers(),aborted=Promise.withResolvers();
 const worker=await add('worker',async(_probe,hooks,{signal})=>{
  entered.resolve();
  await waitForAbort(signal);
  await assert.rejects(hooks.admit(browserRequest),{code:WORKER_TRANSPORT_ERROR});
  aborted.resolve();
  return success;
 });
 await registry(worker);
 const slot=await pool.acquire(runtime);
 const pending=slot.run(input(),{admit:()=>assert.fail('expired callback reached admission')});
 const rejected=assert.rejects(pending,{code:WORKER_TRANSPORT_ERROR});
 await entered.promise;
 await pool.close();
 await rejected;
 await aborted.promise;
 slot.release();
 for(let i=0;i<20&&(await requestJson(worker.socket_path,'/healthz')).value.busy;i++)await wait(10);
 assert.equal((await requestJson(worker.socket_path,'/healthz')).value.busy,false);
});

test('the executor reaps a browser interrupted before reporting its PID',{timeout:8000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'fx-pool-exit-'));
 const executablePath=join(directory,'launch-fixture');
 let pid;
 t.after(async()=>{
  if(pid){try{process.kill(-pid,'SIGKILL');}catch{}}
  await rm(directory,{recursive:true,force:true});
 });
 await writeFile(executablePath,'#!/bin/sh\nprintf "%s" "$$" > "$0.pid"\nwhile :; do sleep 1; done\n',{mode:0o700});
 const runtime={engine:'chromium',executablePath,version:'151.0.7922.34',sha256:await binarySha(executablePath),expires_at:'2099-01-01'};
 const controller=new AbortController();
 const deadline=Date.now()+6000;
 const pending=runBrowserProbe({url,deadline,timeout_ms:6000,policy,runtime,relay:'http://127.0.0.1:1',deny_relay:'http://127.0.0.1:2'},
  {},{signal:controller.signal});
 try{
  for(let i=0;i<100&&!pid;i++){
   pid=Number(await readFile(executablePath+'.pid','utf8').catch(error=>{if(error.code!=='ENOENT')throw error;return '';}));
   if(!pid)await wait(20);
  }
  assert.ok(Number.isSafeInteger(pid)&&pid>1,'browser fixture launched');
 }finally{controller.abort();}
 assert.equal((await pending).error,WORKER_TRANSPORT_ERROR);
 const alive=()=>{
  try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}
 };
 for(let i=0;i<100&&alive();i++)await wait(10);
 assert.equal(alive(),false);
 pid=null;
});

test('disconnected dispatched work stays unknown with its original reservation and never reruns',{skip:!process.env.TEST_DATABASE_URL,timeout:10000},async t=>{
 assert.match(new URL(process.env.TEST_DATABASE_URL).pathname,/^\/gateway_test_[A-Za-z0-9_]+$/);
 const {add,registry,config,runtime}=await fixture(t);
 const {dial}=await echoRelay(t);
 const store=new Store(process.env.TEST_DATABASE_URL);
 await store.init();
 const clean=()=>store.pool.query('TRUNCATE v2_registry,v2_ledger_events,v2_artifacts,v2_ledger,v2_operations,v2_sessions,source_limits RESTART IDENTITY CASCADE');
 await clean();
 t.after(async()=>{await clean();await store.close();});
 const transferred=Promise.withResolvers();
 let runs=0;
 const worker=await add('worker',async(probe,hooks,{signal})=>{
  runs++;
  await hooks.admit(browserRequest);
  const tunnel=await connect(probe.relay);
  try{
   await roundTrip(tunnel);
   transferred.resolve();
   await waitForAbort(signal);
  }finally{tunnel.socket.destroy();}
  return success;
 });
 await registry(worker);
 const artifactDir=await mkdtemp(join(tmpdir(),'fx-pool-artifacts-'));
 t.after(()=>rm(artifactDir,{recursive:true,force:true}));
 const profile={id:'pool',version:1,origins:['https://'+target],methods:['GET','HEAD'],headers:[],proxy_classes:['direct'],countries:[],
  limits:{max_requests:10,max_encoded_bytes:4096,max_decoded_bytes:4096,max_session_encoded_bytes:65536,min_interval_ms:0},browser_probe:policy};
 const settings={artifactDir,artifactKey:'42'.repeat(32),maxConcurrentRequests:4,maxDailyFallbackCredits:0,projects:{a:{profiles:[],v2_access_profiles:['pool@1'],tokenHash:sha('test')}},
  proxies:[],v2:{browser_pool:config,accessProfiles:{'pool@1':profile},browser_probe:{enabled:true,engine:'chromium',runtime:{version:runtime.version,sha256:runtime.sha256},
   qualification:{status:'accepted',kind:BROWSER_PROBE_QUALIFICATION_KIND,engine:'chromium',binary_sha256:runtime.sha256,version:runtime.version,platform:runtime.platform,arch:runtime.arch,evidence:'sha256:'+'a'.repeat(64),expires_at:runtime.expires_at}}}};
 const gateway=new Gateway({store,config:settings,profiles:{},resolve:async()=>[{address:'93.184.216.34',family:4}]});
 const v2=new V2Gateway(gateway,{relayFactory:options=>browserRelay({...options,dial})});
 t.after(()=>v2.browserPool.close());
 const session=await v2.session('a',{idempotency_key:'pool-session',access_profile:{id:'pool',version:1},transport:'http',proxy:{class:'direct',country:null,affinity:'session'}});
 const input={idempotency_key:'lost',session_id:session.id,url};
 const running=v2.browserProbe('a',input,undefined,{timeoutMs:5000});
 await Promise.race([transferred.promise,running.then(result=>assert.fail('worker finished before disconnect: '+JSON.stringify(result)))]);
 await worker.close();
 const lost=await running;
 assert.equal(lost.state,'unknown');
 assert.equal(lost.error,WORKER_TRANSPORT_ERROR);
 assert.equal(lost.accounting.observed_tunnel_bytes,10);
 const {rows:[ledger]}=await store.pool.query('SELECT state,accounted_requests,accounted_encoded_bytes FROM v2_ledger WHERE operation=$1',[lost.id]);
 assert.deepEqual([ledger.state,Number(ledger.accounted_requests),Number(ledger.accounted_encoded_bytes)],['unknown',policy.max_requests,policy.max_network_bytes]);
 await recoverV2(store.pool);
 assert.equal((await v2.browserProbe('a',input,undefined,{timeoutMs:5000})).id,lost.id);
 await assert.rejects(v2.browserProbe('a',input,undefined,{timeoutMs:4000}),{code:'idempotency_conflict'});
 assert.equal(runs,1);
});
