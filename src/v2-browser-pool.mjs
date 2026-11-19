import {randomBytes} from 'node:crypto';
import {ID,GatewayError,fail} from './policy.mjs';
import {BROWSER_SCREENSHOT_MAX_BYTES} from './v2-browser-policy.mjs';
import {bridgeTunnels,codePattern,jsonLength,jsonResponse,listenPrivate,matchesRuntime,object,openWorkerTunnel,privateServer,readJson,readSmallFile,requestJson,requestToken,socketPathValid,targetPattern,trackSocket,WORKER_TRANSPORT_ERROR} from './v2-browser-worker-wire.mjs';
import {isAbsolute} from 'node:path';

const CALLBACK_ENVELOPE_BYTES=512*1024;
const callbackLimits={
 '/v1/admit':{kind:'admit',limit:128*1024,multiplier:4,extra:0},
 '/v1/cooldown':{kind:'cooldown',limit:64*1024,extra:0},
 // At most one solve per render.
 '/v1/captcha':{kind:'captcha',limit:16*1024,multiplier:0,extra:1},
 '/v1/artifact':{kind:'artifact',extra:2}
};
const connectFailure=socket=>socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
const unavailable=()=>new GatewayError('browser_capacity',503);

function attemptContext(input,hooks){
 const relay=/^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(input.relay);
 if(!relay||Number(relay[1])>65535)throw new Error('invalid gateway relay');
 const maxRequests=input.policy.max_requests;
 const artifactBytes=4*Math.ceil((input.policy.max_decoded_bytes+input.policy.max_dom_bytes+(input.screenshot?BROWSER_SCREENSHOT_MAX_BYTES:0))/3)+CALLBACK_ENVELOPE_BYTES*(maxRequests+2);
 return {port:Number(relay[1]),maxRequests,deadline:input.deadline,hooks,artifactBytes,
  controller:new AbortController(),sockets:new Set(),tasks:new Set(),counts:{admit:0,cooldown:0,artifact:0,connect:0,captcha:0}};
}

export class BrowserWorkerPool{
 #entries=[];
 #registryRead=Promise.resolve();
 #held=new Map();
 #attempts=new Map();
 #sockets=new Set();
 #server;
 #start;
 #closing=false;
 #registryValid=false;

 constructor(config,{metrics,runtime,onClose}={}){
  if(!object(config)||Object.keys(config).some(k=>!['registry_path','callback_socket'].includes(k))||
   typeof config.registry_path!=='string'||!isAbsolute(config.registry_path)||!socketPathValid(config.callback_socket)||config.registry_path===config.callback_socket)fail('browser_worker_pool_configuration',503);
  this.registryPath=config.registry_path;
  this.callbackSocket=config.callback_socket;
  this.metrics=metrics;this.runtime=runtime;this.onClose=onClose;
 }

 start(){
  if(this.#closing)throw unavailable();
  return this.#start??=(async()=>{
   this.#server=privateServer((req,res)=>{
    if(req.method==='GET'&&req.url==='/healthz')jsonResponse(res,this.#closing?503:200,{ready:!this.#closing});
    else if(req.method==='GET'&&req.url==='/v1/pool-metrics'&&this.metrics)void this.#metrics(res);
    else this.#callback(req,res);
   });
   this.#server.on('connection',socket=>trackSocket(this.#sockets,socket));
   this.#server.on('connect',(req,socket,head)=>this.#connect(req,socket,head));
   await listenPrivate(this.#server,this.callbackSocket);
  })();
 }

 async close(){
  this.#closing=true;
  const closing=Promise.resolve().then(()=>this.onClose?.());
  void closing.catch(()=>{});
  await this.#start?.catch(()=>{});
  const attempts=[...this.#attempts.values()];
  for(const attempt of attempts)attempt.controller.abort();
  for(const socket of this.#sockets)socket.destroy();
  if(this.#server?.listening)await new Promise(resolve=>this.#server.close(resolve));
  await Promise.allSettled(attempts.map(attempt=>attempt.done));
  await closing;
 }

 async #refreshRegistry(){
  const read=this.#registryRead.then(async()=>{
   try{
    const rows=await readSmallFile(this.registryPath,64*1024),ids=new Set(),paths=new Set();
    if(!Array.isArray(rows)||rows.length>64)throw new Error('invalid registry');
    for(const row of rows){
     if(!object(row)||Object.keys(row).length!==3||typeof row.id!=='string'||!ID.test(row.id)||!['active','draining'].includes(row.state)||
      !socketPathValid(row.socket_path)||row.socket_path===this.callbackSocket||ids.has(row.id)||paths.has(row.socket_path))throw new Error('invalid registry row');
     ids.add(row.id);paths.add(row.socket_path);
    }
    this.#entries=rows;this.#registryValid=true;
   }catch{this.#entries=[];this.#registryValid=false;}
   return this.#entries;
  });
  this.#registryRead=read;
  return read;
 }

 #active(entry){
  return !this.#closing&&this.#entries.some(row=>row.id===entry.id&&row.socket_path===entry.socket_path&&row.state==='active');
 }

 #occupied(entry){
  return this.#held.has(entry.id)||[...this.#held.values()].some(slot=>slot.entry.socket_path===entry.socket_path);
 }

 async #healthy(runtime,idleOnly){
  const entries=await this.#refreshRegistry();
  const candidates=entries.filter(entry=>entry.state==='active'&&(!idleOnly||!this.#occupied(entry)));
  const signal=AbortSignal.timeout(750);
  return (await Promise.all(candidates.map(async entry=>{
   try{
    const {status,value}=await requestJson(entry.socket_path,'/healthz',{signal,responseLimit:8192});
    return status===200&&value?.ready===true&&(!idleOnly||value.busy===false)&&matchesRuntime(value.runtime,runtime)?entry:null;
   }catch{return null;}
  }))).filter(Boolean);
 }

 async ready(runtime){
  await this.start();
  return (await this.#healthy(runtime,false)).some(entry=>this.#active(entry));
 }

 async #metrics(res){
  try{
   if(this.#closing)throw unavailable();
   const qualified=await this.runtime();
   if(!qualified.available)throw unavailable();
   const entries=await this.#refreshRegistry();
   if(!this.#registryValid)throw unavailable();
   const snapshot=[...entries];
   for(const {entry}of this.#held.values())if(!snapshot.some(row=>row.id===entry.id))snapshot.push({...entry,state:'draining'});
   const workers=await Promise.all(snapshot.map(async entry=>{
    try{
     const {status,value}=await requestJson(entry.socket_path,'/healthz',{signal:AbortSignal.timeout(750),responseLimit:8192});
     if(status!==200||value?.ready!==true||typeof value.busy!=='boolean'||!matchesRuntime(value.runtime,qualified.runtime))throw unavailable();
     return {id:entry.id,state:entry.state,ready:true,busy:this.#occupied(entry)||value.busy};
    }catch{return {id:entry.id,state:entry.state,ready:false,busy:true};}
   }));
   const aggregate=await this.metrics();
   jsonResponse(res,200,{version:1,generated_at:new Date().toISOString(),queue:aggregate.queue,workers,max_concurrent_requests:aggregate.max_concurrent_requests});
  }catch{jsonResponse(res,503,{error:'browser_pool_metrics_unavailable'});}
 }

 async acquire(runtime){
  await this.start();
  const ready=await this.#healthy(runtime,true);
  // A registry edit during the health probes takes effect before this claim.
  await this.#refreshRegistry();
  const entry=ready.find(candidate=>this.#active(candidate)&&!this.#occupied(candidate));
  if(!entry)throw unavailable();
  const slot={entry,used:false};
  this.#held.set(entry.id,slot);
  return {run:(input,hooks)=>this.#run(slot,input,hooks),release:()=>{if(this.#held.get(entry.id)===slot)this.#held.delete(entry.id);}};
 }

 async #run(slot,input,hooks){
  if(slot.used||this.#held.get(slot.entry.id)!==slot||this.#closing)throw unavailable();
  slot.used=true;
  if(input.deadline<=Date.now())fail('browser_probe_deadline_unknown',504);
  const token=randomBytes(32).toString('base64url'),attempt=attemptContext(input,hooks);
  const run=async()=>{
   try{
    const {engine,version,sha256,platform,arch,expires_at}=input.runtime;
    const payload={url:input.url,timeout_ms:input.timeout_ms,deadline:input.deadline,policy:input.policy,runtime:{engine,version,sha256,platform,arch,expires_at},screenshot:input.screenshot,cookies:input.cookies,...(input.captcha===true?{captcha:true}:{})};
    const {status,value}=await requestJson(slot.entry.socket_path,'/v1/render',{data:payload,token,signal:attempt.controller.signal});
    if(status===409&&value?.error==='browser_capacity')throw unavailable();
    if(status!==200||!object(value)||typeof value.capture_complete!=='boolean'||typeof value.counts_complete!=='boolean'||
     (value.error!=null&&!codePattern.test(value.error))||!Array.isArray(value.cookies)&&value.cookies!==null)throw new Error('invalid browser worker result');
    return value;
   }catch(error){
    if(error instanceof GatewayError)throw error;
    throw new GatewayError(Date.now()>=input.deadline?'browser_probe_deadline_unknown':WORKER_TRANSPORT_ERROR,502);
   }finally{
    clearTimeout(timer);
    this.#attempts.delete(token);
    attempt.controller.abort();
    for(const socket of attempt.sockets)socket.destroy();
    await Promise.allSettled([...attempt.tasks]);
   }
  };
  this.#attempts.set(token,attempt);
  const timer=setTimeout(()=>attempt.controller.abort(),input.deadline-Date.now());
  attempt.done=run();
  return attempt.done;
 }

 #attempt(req){
  const attempt=this.#attempts.get(requestToken(req));
  return attempt&&!attempt.controller.signal.aborted&&Date.now()<attempt.deadline?attempt:null;
 }

 #track(attempt,task){
  attempt.tasks.add(task);
  void task.then(()=>attempt.tasks.delete(task),()=>attempt.tasks.delete(task));
 }

 #callback(req,res){
  const rule=Object.hasOwn(callbackLimits,req.url)?callbackLimits[req.url]:null,attempt=this.#attempt(req);
  if(req.method!=='POST'||!rule||!attempt){jsonResponse(res,403,{error:WORKER_TRANSPORT_ERROR});return;}
  trackSocket(attempt.sockets,req.socket);
  const {kind,limit=attempt.artifactBytes,multiplier=1,extra}=rule;
  if(++attempt.counts[kind]>attempt.maxRequests*multiplier+extra){
   jsonResponse(res,403,{error:kind==='admit'?'browser_request_limit':'browser_probe_callback_unknown'});
   return;
  }
  const task=(async()=>{
   try{
    const length=jsonLength(req,limit);
    if(kind==='artifact')attempt.artifactBytes-=length;
    const data=await readJson(req,length);
    const signal=attempt.controller.signal;
    if(signal.aborted)throw new Error('expired callback');
    const output=await attempt.hooks[kind](data,{signal});
    jsonResponse(res,200,output??{ok:true});
   }catch(error){
    const code=error instanceof GatewayError&&codePattern.test(error.code)?error.code:'browser_probe_callback_unknown';
    jsonResponse(res,403,{error:code});
   }
  })();
  this.#track(attempt,task);
 }

 #connect(req,socket,head){
  const attempt=this.#attempt(req);
  if(!attempt||head.length||!targetPattern.test(req.url)||++attempt.counts.connect>attempt.maxRequests*2){connectFailure(socket);return;}
  socket.pause();
  trackSocket(attempt.sockets,socket);
  const task=(async()=>{
   try{
    const signal=attempt.controller.signal;
    const remote=await openWorkerTunnel({host:'127.0.0.1',port:attempt.port},req.url,{signal});
    trackSocket(attempt.sockets,remote.socket);
    if(remote.status!==200||signal.aborted||socket.destroyed){remote.socket.destroy();connectFailure(socket);return;}
    bridgeTunnels(socket,remote.socket,remote.head);
    socket.resume();
   }catch{socket.destroy();}
  })();
  this.#track(attempt,task);
 }
}
