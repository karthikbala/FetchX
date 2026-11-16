import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as wait} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {BrowserAdmissionQueue,browserQueuePolicy,recoverBrowserQueue} from '../src/v2-browser-queue.mjs';
import {BrowserWorkerPool} from '../src/v2-browser-pool.mjs';
import {BROWSER_PROBE_QUALIFICATION_KIND,binarySha} from '../src/v2-browser-policy.mjs';
import {startBrowserWorker} from '../src/v2-browser-worker-service.mjs';
import {requestJson,WORKER_TRANSPORT_ERROR} from '../src/v2-browser-worker-wire.mjs';
import {Store} from '../src/store.mjs';
import {Gateway} from '../src/gateway.mjs';
import {V2Gateway,recoverV2} from '../src/v2.mjs';
import {GatewayError} from '../src/policy.mjs';
import {sha} from '../src/crypto.mjs';
import {PublicRenderGateway,publicRenderFailure} from '../src/v2-public-render.mjs';
import {publicScrapeFailure} from '../src/v2-public-scrape.mjs';

const database={skip:!process.env.TEST_DATABASE_URL,timeout:15000};
async function until(condition,message='condition did not become true'){
 for(let i=0;i<200;i++){if(await condition())return;await wait(10);}
 assert.fail(message);
}

class Slots{
 healthy=false;
 busy=0;
 acquireCalls=0;
 capacity=1;
 async acquire(){
  this.acquireCalls++;
  if(!this.healthy||this.busy>=this.capacity)throw new GatewayError('browser_capacity',503);
  this.busy++;
  let held=true;
  return {release:()=>{if(held){held=false;this.busy--;}}};
 }
}

async function fixture(t,policy={}){
 assert.match(new URL(process.env.TEST_DATABASE_URL).pathname,/^\/gateway_test_[A-Za-z0-9_]+$/);
 const store=new Store(process.env.TEST_DATABASE_URL);
 await store.init();
 const clean=()=>store.pool.query('TRUNCATE v2_browser_queue,v2_browser_queue_timeouts,v2_ledger_events,v2_artifacts,v2_ledger,v2_operations,v2_sessions,workflows,source_limits RESTART IDENTITY CASCADE');
 await clean();await store.pool.query('UPDATE v2_browser_queue_cursor SET project=NULL');
 const slots=new Slots(),requests=[],beforeClose=[];
 const config={maxConcurrentRequests:2,v2:{browser_queue:{enabled:true,max_pending:8,max_pending_per_project:4,wait_timeout_ms:2500,...policy}}};
 const queue=new BrowserAdmissionQueue(store,config,slots);
 const start=(project,key,hash=sha(key))=>{
  const promise=queue.acquire(project,key,hash,{});
  // Cleanup must also reap promises when an assertion fails mid-wait.
  requests.push(promise);void promise.catch(()=>{});return promise;
 };
 t.after(async()=>{
  for(const close of beforeClose)await close();
  await recoverBrowserQueue(store.pool);
  const claims=await Promise.allSettled(requests);
  for(const claim of claims)if(claim.status==='fulfilled'){claim.value.worker?.release();await claim.value.finish?.();}
  await clean();await store.close();
 });
 return {store,slots,queue,config,start,beforeClose,pending:count=>until(async()=>(await queue.metrics()).pending===count)};
}

test('browser queue is explicit, bounded and requires a worker pool',()=>{
 assert.equal(browserQueuePolicy(undefined),null);
 assert.equal(browserQueuePolicy({enabled:false}),null);
 assert.deepEqual(browserQueuePolicy({enabled:true}),{enabled:true,max_pending:64,max_pending_per_project:8,wait_timeout_ms:45000});
 for(const policy of [{},{enabled:'true'},{enabled:true,max_pending:0},{enabled:true,max_pending:4097},{enabled:true,max_pending:2,max_pending_per_project:3},{enabled:true,wait_timeout_ms:300001},{enabled:true,url:'https://private.example'}])assert.throws(()=>browserQueuePolicy(policy),{code:'browser_queue_configuration'});
 assert.throws(()=>new BrowserAdmissionQueue({}, {v2:{browser_queue:{enabled:true}}}),{code:'browser_queue_configuration'});
});

test('public queue errors report waiting duplicates as running and retry pre-dispatch failures with the original key',async()=>{
 const session={id:randomUUID(),proxy:{class:'direct',country:null,provider:'direct'}},fingerprints=new Map();
 const stub={controlCredits:{keyId:()=>null,managed:()=>false},profile:async()=>({browser_probe:{enabled:true},origins:['https://source.example']}),request:request=>request,headers:()=>{},renderSession:async()=>session,
  store:{pool:{query:async(sql,args)=>{
   const k=args.slice(0,2).join(':');
   if(sql.startsWith('INSERT')){fingerprints.set(k,args[2]);return {rows:[]};}
   return {rows:fingerprints.has(k)?[{hash:fingerprints.get(k)}]:[]};
  }}}};
 for(const code of ['browser_queue_running','browser_queue_full','browser_queue_timeout','browser_queue_cancelled']){
  stub.browserProbe=async()=>{throw new GatewayError(code,code==='browser_queue_running'?409:503);};
  const render=new PublicRenderGateway(stub),input={idempotency_key:code,access_profile:{id:'profile',version:1},url:'https://source.example/',proxy:{class:'direct',country:null}};
  await assert.rejects(render.render('a',input),error=>{
   const response=publicRenderFailure(error,{key:input.idempotency_key});
   assert.equal(response.state,code==='browser_queue_running'?'running':'rejected');
   assert.equal(response.error.code,code);assert.equal(response.session_id,session.id);
   assert.equal(response.retry.same_key_replay_safe,true);
   assert.equal(response.retry.safe_to_retry,code!=='browser_queue_running');
   assert.equal(response.retry.next_action,code==='browser_queue_running'?'recover_first':'retry_same_key');
   return true;
  });
 }
 assert.match(publicScrapeFailure(new GatewayError('browser_queue_timeout',503)).error,/same X-Idempotency-Key/);
});

test('private aggregate metrics include busy and draining workers and fail closed on broken registry',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'fx-queue-metrics-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const executablePath=join(directory,'browser');
 await writeFile(executablePath,'synthetic pinned executable');await chmod(executablePath,0o700);
 const pin={engine:'chromium',version:'151.0.7922.34',sha256:await binarySha(executablePath),executablePath};
 const runtime={...pin,platform:process.platform,arch:process.arch,expires_at:'2099-01-01'};
 const config={registry_path:join(directory,'registry.json'),callback_socket:join(directory,'callback.sock')};
 const row={id:'base',state:'active',socket_path:join(directory,'worker.sock')};
 await writeFile(config.registry_path,JSON.stringify([row]));
 const pool=new BrowserWorkerPool(config,{runtime:()=>({available:true,runtime}),metrics:async()=>({queue:{pending:2,active:1,oldest_wait_ms:32,recent_timeouts:3},max_concurrent_requests:4})});
 await pool.start();t.after(()=>pool.close());
 const worker=await startBrowserWorker({socketPath:row.socket_path,callbackSocket:config.callback_socket,pin,runner:async()=>({})});
 t.after(()=>worker.close());
 const slot=await pool.acquire(runtime);
 let response=await requestJson(config.callback_socket,'/v1/pool-metrics');
 assert.equal(response.status,200);
 assert.deepEqual(Object.keys(response.value).sort(),['generated_at','max_concurrent_requests','queue','version','workers']);
 assert.equal(response.value.version,1);assert.equal(response.value.max_concurrent_requests,4);
 assert.deepEqual(response.value.queue,{pending:2,active:1,oldest_wait_ms:32,recent_timeouts:3});
 assert.deepEqual(response.value.workers,[{id:'base',state:'active',ready:true,busy:true}]);
 assert.ok(Number.isFinite(Date.parse(response.value.generated_at)));
 await writeFile(config.registry_path,JSON.stringify([{...row,state:'draining'}]));
 response=await requestJson(config.callback_socket,'/v1/pool-metrics');
 assert.deepEqual(response.value.workers,[{id:'base',state:'draining',ready:true,busy:true}]);
 slot.release();await worker.close();
 response=await requestJson(config.callback_socket,'/v1/pool-metrics');
 assert.deepEqual(response.value.workers,[{id:'base',state:'draining',ready:false,busy:true}]);
 await writeFile(config.registry_path,'invalid');
 assert.equal((await requestJson(config.callback_socket,'/v1/pool-metrics')).status,503);
});

test('waiting queue enforces global/project bounds and durable key hashes without reserving source or credits',database,async t=>{
 const {store,queue,start,pending}=await fixture(t,{max_pending:3,max_pending_per_project:2});
 start('a','a1');await pending(1);start('a','a2');await pending(2);
 await assert.rejects(start('a','a3'),{code:'browser_queue_full'});
 await assert.rejects(start('a','a1'),{code:'browser_queue_running'});
 await assert.rejects(start('a','a1',sha('different')),{code:'idempotency_conflict'});
 start('b','a1');await pending(3);
 await assert.rejects(start('c','c1'),{code:'browser_queue_full'});
 const {rows:[counts]}=await store.pool.query(`SELECT
  (SELECT count(*)::int FROM v2_operations) operations,(SELECT count(*)::int FROM v2_ledger) ledger,
  (SELECT count(*)::int FROM v2_ledger_events) events,(SELECT count(*)::int FROM control_credit_reservations) credits,
  (SELECT count(*)::int FROM paid_credit_reservations) paid`);
 assert.deepEqual(counts,{operations:0,ledger:0,events:0,credits:0,paid:0});
 const {rows:[columns]}=await store.pool.query("SELECT array_agg(column_name::text ORDER BY ordinal_position) columns FROM information_schema.columns WHERE table_name='v2_browser_queue'");
 assert.deepEqual(columns.columns,['id','position','project','key','input_hash','state','queued_at','deadline','finished_at']);
 assert.equal((await queue.metrics()).active,0);
});

test('simultaneous waiters claim one worker fairly across projects and FIFO within each project',database,async t=>{
 const {slots,queue,start,pending}=await fixture(t);
 const a1=start('a','a1');await pending(1);
 const a2=start('a','a2');await pending(2);
 const b1=start('b','b1');await pending(3);
 const b2=start('b','b2');await pending(4);
 slots.healthy=true;
 for(const [index,promise]of [a1,b1,a2,b2].entries()){
  const claim=await promise;
  assert.equal(slots.busy,1);
  assert.equal((await queue.metrics()).active,1);
  await pending(3-index);
  await claim.finish();claim.worker.release();
 }
 assert.deepEqual(await queue.metrics(),{pending:0,active:0,oldest_wait_ms:0,recent_timeouts:0});
});

test('queue timeout is separate, counted across original-key retries and never executes autonomously after restart',database,async t=>{
 const {store,slots,queue,start,pending}=await fixture(t,{wait_timeout_ms:80});
 await assert.rejects(start('a','timeout'),{code:'browser_queue_timeout'});
 assert.equal((await queue.metrics()).recent_timeouts,1);
 await assert.rejects(start('a','timeout'),{code:'browser_queue_timeout'});
 assert.equal((await queue.metrics()).recent_timeouts,2);
 await assert.rejects(start('a','timeout',sha('changed')),{code:'idempotency_conflict'});
 const interrupted=start('b','interrupted');await pending(1);
 await recoverBrowserQueue(store.pool);
 await assert.rejects(interrupted,{code:'browser_queue_cancelled'});
 slots.healthy=true;const calls=slots.acquireCalls;
 await wait(120);assert.equal(slots.acquireCalls,calls);
 const retried=await start('b','interrupted');
 assert.equal((await queue.metrics()).active,1);
 await recoverBrowserQueue(store.pool);
 assert.equal((await queue.metrics()).active,0);
 retried.worker.release();await retried.finish();
 assert.equal((await store.pool.query('SELECT count(*)::int n FROM v2_operations')).rows[0].n,0);
});

test('claimed tickets count against the global limit before an operation exists',database,async t=>{
 const {slots,config,start,pending,queue}=await fixture(t);
 config.maxConcurrentRequests=1;slots.capacity=2;slots.healthy=true;
 const first=await start('a','one');
 const second=start('b','two');await pending(1);await wait(150);
 assert.equal(slots.busy,1);assert.equal((await queue.metrics()).active,1);
 await first.finish();first.worker.release();
 const claim=await second;assert.equal(slots.busy,1);
 await claim.finish();claim.worker.release();
});

test('claimed tickets represented by operation rows consume exactly one global slot',database,async t=>{
 const {store,slots,start}=await fixture(t);
 slots.capacity=2;slots.healthy=true;
 const first=await start('a','one');
 const session=randomUUID();
 await store.pool.query("INSERT INTO v2_sessions(id,project,key,input_hash,policy,route,cookie_jar,expires_at) VALUES($1,'a','session',$2,'{}',$3,$3,clock_timestamp()+interval '1 minute')",[session,sha('session'),Buffer.alloc(1)]);
 await store.pool.query("INSERT INTO v2_operations(id,project,key_id,key,session_id,input_hash,input,state) VALUES($1,'a','fixture','one',$2,$3,$4,'running')",[randomUUID(),session,sha('one'),Buffer.alloc(1)]);
 const second=await start('b','two');
 assert.equal(slots.busy,2,'the first claim and its operation are counted together');
 await first.finish();first.worker.release();await second.finish();second.worker.release();
});

test('closing the pool cancels a waiting handler before any worker or source admission',database,async t=>{
 const {store,start,pending,queue,slots}=await fixture(t);
 const directory=await mkdtemp(join(tmpdir(),'fx-queue-close-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const pool=new BrowserWorkerPool({registry_path:join(directory,'registry.json'),callback_socket:join(directory,'callback.sock')},{onClose:()=>queue.close()});
 const request=start('a','close');await pending(1);
 await pool.close();
 await assert.rejects(request,{code:'browser_queue_cancelled'});
 await assert.rejects(start('a','new'),{code:'browser_queue_cancelled'});
 assert.equal((await queue.metrics()).pending,0);assert.equal(slots.busy,0);
 assert.equal((await store.pool.query('SELECT count(*)::int n FROM v2_operations')).rows[0].n,0);
});

test('unhealthy worker probes do not hold the global request admission transaction lock',database,async t=>{
 const {store,slots,start}=await fixture(t);
 const entered=Promise.withResolvers(),release=Promise.withResolvers();
 slots.acquire=async()=>{entered.resolve();await release.promise;throw new GatewayError('browser_capacity',503);};
 const request=start('a','outage');
 try{
  await entered.promise;
  const admitted=store.tx(async client=>{await client.query('SELECT pg_advisory_xact_lock(1002)');return true;});
  assert.equal(await Promise.race([admitted,wait(250).then(()=>false)]),true,'unrelated admission is responsive while worker health is stalled');
 }finally{await store.pool.query("UPDATE v2_browser_queue SET state='cancelled' WHERE key='outage'");release.resolve();}
 await assert.rejects(request,{code:'browser_queue_cancelled'});
});

test('a waiting burst shares bounded admission polling instead of one SQL loop per handler',database,async t=>{
 const {store,start,pending}=await fixture(t,{max_pending:32,max_pending_per_project:32});
 for(let i=0;i<20;i++)start('a','burst-'+i);
 await pending(20);
 const transaction=store.tx.bind(store);let polls=0;
 store.tx=async(...args)=>{polls++;return transaction(...args);};
 await wait(450);
 assert.ok(polls<=8,'twenty waiting handlers share a single 250ms pump; transactions='+polls);
});

test('opt-in queue admits a qualified zero-ready pool, preserves execution timeout and uncertain recovery',database,async t=>{
 const {store,beforeClose}=await fixture(t);
 const directory=await mkdtemp(join(tmpdir(),'fx-queue-operation-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const profile={id:'queue',version:1,origins:['https://source.example'],methods:['GET','HEAD'],headers:[],proxy_classes:['direct'],countries:[],limits:{max_requests:10,max_encoded_bytes:4096,max_decoded_bytes:4096,max_session_encoded_bytes:65536,min_interval_ms:0},browser_probe:{enabled:true,max_requests:3,max_network_bytes:4096,max_decoded_bytes:4096,max_dom_bytes:1024,settle_ms:0}};
 const runtime={version:'151.0.7922.34',sha256:'a'.repeat(64)};
 const settings={artifactDir:directory,artifactKey:'42'.repeat(32),maxConcurrentRequests:2,maxDailyFallbackCredits:0,projects:{a:{profiles:[],v2_access_profiles:['queue@1'],tokenHash:sha('fixture-token')}},proxies:[],v2:{
  browser_pool:{registry_path:join(directory,'registry.json'),callback_socket:join(directory,'callback.sock')},browser_queue:{enabled:true,wait_timeout_ms:2500},accessProfiles:{'queue@1':profile},
  browser_probe:{enabled:true,engine:'chromium',runtime,qualification:{status:'accepted',kind:BROWSER_PROBE_QUALIFICATION_KIND,engine:'chromium',binary_sha256:runtime.sha256,version:runtime.version,platform:process.platform,arch:process.arch,evidence:'sha256:'+'b'.repeat(64),expires_at:'2099-01-01'}}}};
 await writeFile(settings.v2.browser_pool.registry_path,'[]');
 const gateway=new Gateway({store,config:settings,profiles:{},resolve:async()=>[{address:'93.184.216.34',family:4}]});
 let beforeConnect,runs=0,sourceCalls=0,reservations=0,ready=false;
 const v2=new V2Gateway(gateway,{relayFactory:async options=>{
  beforeConnect=options.beforeConnect;
  return {url:'http://127.0.0.1:1',deny_url:'http://127.0.0.1:2',bytes:10,dispatched:false,meter_complete:true,close:async()=>{}};
 }});
 beforeClose.push(()=>v2.browserPool.close());
 assert.equal((await v2.browserRuntime(settings)).available,true);
 const noQueue=new V2Gateway(new Gateway({store,config:{...settings,v2:{...settings.v2,browser_queue:{enabled:false}}},profiles:{}}));
 beforeClose.push(()=>noQueue.browserPool.close());
 assert.equal((await noQueue.browserRuntime(noQueue.config)).available,false);
 const reserve=v2.reserveRequestCredits.bind(v2);
 v2.reserveRequestCredits=async(...args)=>{reservations++;return reserve(...args);};
 v2.browserPool.acquire=async()=>{
  if(!ready)throw new GatewayError('browser_capacity',503);
  return {release:()=>{},run:async(input,hooks)=>{
   runs++;assert.ok(input.timeout_ms>0&&input.timeout_ms<=1000);
   assert.ok(input.deadline>Date.now()+800,'queue wait did not consume execution timeout');
   await hooks.admit({url:input.url,method:'GET',headers:{},body_base64:null,redirect_depth:0,redirected_from:null});
   await beforeConnect({url:new URL(input.url)});sourceCalls++;
   throw new GatewayError(WORKER_TRANSPORT_ERROR,502);
  }};
 };
 const session=await v2.session('a',{idempotency_key:'session',access_profile:{id:'queue',version:1},transport:'http',proxy:{class:'direct',country:null,affinity:'session'}});
 const raw={idempotency_key:'operation',session_id:session.id,url:'https://source.example/'};
 const running=v2.browserProbe('a',raw,undefined,{timeoutMs:1000});void running.catch(()=>{});
 await until(async()=>(await v2.browserQueue.metrics()).pending===1);
 await wait(250);assert.equal(reservations,0);assert.equal(runs,0);
 await assert.rejects(v2.browserProbe('a',raw,undefined,{timeoutMs:1000}),{code:'browser_queue_running'});
 await assert.rejects(v2.browserProbe('a',{...raw,url:'https://source.example/changed'},undefined,{timeoutMs:1000}),{code:'idempotency_conflict'});
 ready=true;const result=await running;
 assert.equal(result.state,'unknown');assert.equal(result.error,WORKER_TRANSPORT_ERROR);
 assert.equal(reservations,1);assert.equal(runs,1);assert.equal(sourceCalls,1);
 const retained=await store.pool.query('SELECT state,accounted_requests,accounted_encoded_bytes FROM v2_ledger WHERE operation=$1',[result.id]);
 assert.deepEqual([retained.rows[0].state,retained.rows[0].accounted_requests,Number(retained.rows[0].accounted_encoded_bytes)],['unknown',3,4096]);
 await recoverV2(store.pool);
 assert.equal((await v2.browserProbe('a',raw,undefined,{timeoutMs:1000})).id,result.id);
 assert.equal(runs,1);assert.equal(sourceCalls,1);assert.equal(reservations,1);
});
