import {isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {browserProbePolicy,verifyBrowserExecutable} from './v2-browser-policy.mjs';
import {runBrowserProbe} from './v2-browser-runner.mjs';
import {GatewayError} from './policy.mjs';
import {bridgeTunnels,codePattern,jsonLength,jsonResponse,listen,listenPrivate,matchesRuntime,object,openWorkerTunnel,privateServer,PROBE_JSON_LIMIT,readJson,readSmallFile,requestJson,requestToken,socketPathValid,targetPattern,trackSocket,WORKER_TRANSPORT_ERROR} from './v2-browser-worker-wire.mjs';

const deadlineError='browser_probe_deadline_unknown';
const callbackError='browser_probe_callback_unknown';
const validPin=pin=>object(pin)&&Object.keys(pin).length===4&&pin.engine==='chromium'&&typeof pin.executablePath==='string'&&isAbsolute(pin.executablePath)&&
 typeof pin.version==='string'&&/^\d+\.\d+\.\d+\.\d+$/.test(pin.version)&&typeof pin.sha256==='string'&&/^[a-f0-9]{64}$/.test(pin.sha256);
const failedResult=error=>({error,capture_complete:false,counts_complete:false,cookies:null});

async function workerRelay(callbackSocket,token,controller,maxRequests){
 const signal=controller.signal,sockets=new Set();
 const denyRequest=(_req,res)=>res.writeHead(403,{'connection':'close'}).end();
 const denyConnect=(_req,socket)=>socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
 const relay=privateServer(denyRequest),deny=privateServer(denyRequest);
 let connections=0,closing;
 for(const server of [relay,deny])server.on('connection',socket=>trackSocket(sockets,socket));
 deny.on('connect',denyConnect);
 relay.on('connect',async(req,client,head)=>{
  if(signal.aborted||head.length||!targetPattern.test(req.url)||++connections>maxRequests*2){denyConnect(req,client);return;}
  client.pause();
  try{
   const remote=await openWorkerTunnel({socketPath:callbackSocket},req.url,{token,signal});
   trackSocket(sockets,remote.socket);
   if(signal.aborted||client.destroyed||remote.status!==200){
    remote.socket.destroy();
    if(remote.status!==200)denyConnect(req,client);
    return;
   }
   remote.socket.on('error',()=>{if(!closing)controller.abort(WORKER_TRANSPORT_ERROR);});
   bridgeTunnels(client,remote.socket,remote.head);
   client.resume();
  }catch{
   client.destroy();
   if(!closing&&!signal.aborted)controller.abort(WORKER_TRANSPORT_ERROR);
  }
 });
 const close=()=>closing??=(async()=>{
  const closed=Promise.all([relay,deny].filter(server=>server.listening).map(server=>new Promise(resolve=>server.close(resolve))));
  for(const socket of sockets)socket.destroy();
  await closed;
 })();
 try{
  for(const server of [relay,deny])await listen(server,{host:'127.0.0.1',port:0});
 }catch(error){await close();throw error;}
 const relayUrl=server=>'http://127.0.0.1:'+server.address().port;
 const url=relayUrl(relay),deny_url=relayUrl(deny);
 signal.addEventListener('abort',close,{once:true});
 if(signal.aborted)await close();
 return {url,deny_url,close:async()=>{signal.removeEventListener('abort',close);await close();}};
}

function renderInput(value,runtime){
 // captcha is optional so older gateways keep working during a rolling deploy.
 if(!object(value)||Object.keys(value).length!==(Object.hasOwn(value,'captcha')?8:7)||value.captcha!==undefined&&value.captcha!==true||typeof value.url!=='string'||value.url.length>12000||!/^https:\/\//i.test(value.url)||
  !Number.isSafeInteger(value.deadline)||value.deadline<=Date.now()||
  !Number.isSafeInteger(value.timeout_ms)||value.timeout_ms<1||value.timeout_ms>45000||typeof value.screenshot!=='boolean'||!Array.isArray(value.cookies)||
  !matchesRuntime(value.runtime,runtime)||!Number.isFinite(Date.parse(value.runtime.expires_at))||value.deadline>Date.parse(value.runtime.expires_at))throw new Error('invalid worker render input');
 const policy=browserProbePolicy(value.policy);
 if(!policy)throw new Error('invalid browser policy');
 return {...value,deadline:Math.min(value.deadline,Date.now()+value.timeout_ms),policy,runtime:{...runtime,expires_at:value.runtime.expires_at}};
}

export async function startBrowserWorker({socketPath,callbackSocket,pin,runner=runBrowserProbe}){
 if(!validPin(pin)||!socketPathValid(callbackSocket)||callbackSocket===socketPath)throw new Error('invalid browser worker configuration');
 const runtime={...pin,platform:process.platform,arch:process.arch};
 const {executablePath,...advertised}=runtime,sockets=new Set();
 let active,stopping=false,closing;
 const healthy=async()=>{
  if(stopping||await verifyBrowserExecutable(executablePath,runtime.sha256))return false;
  try{
   const {status,value}=await requestJson(callbackSocket,'/healthz',{signal:AbortSignal.timeout(400),responseLimit:8192});
   return status===200&&value?.ready===true;
  }catch{return false;}
 };
 const server=privateServer(async(req,res)=>{
  if(req.method==='GET'&&req.url==='/healthz'){
   const ready=await healthy();
   jsonResponse(res,ready?200:503,{ready,busy:!!active,runtime:advertised});
   return;
  }
  const token=requestToken(req);
  if(req.method!=='POST'||req.url!=='/v1/render'||!token){
   jsonResponse(res,403,{error:WORKER_TRANSPORT_ERROR});
   return;
  }
  if(active||stopping){
   jsonResponse(res,409,{error:'browser_capacity'});
   return;
  }
  const controller=new AbortController(),signal=controller.signal;
  const work={controller};
  active=work;
  const disconnected=()=>{if(!res.writableFinished)controller.abort(WORKER_TRANSPORT_ERROR);};
  res.once('close',disconnected);
  work.done=(async()=>{
   let local,timer,result;
   try{
    const input=renderInput(await readJson(req,jsonLength(req,PROBE_JSON_LIMIT)),runtime);
    timer=setTimeout(()=>controller.abort(deadlineError),Math.max(1,input.deadline-Date.now()));
    const reason=await verifyBrowserExecutable(executablePath,runtime.sha256);
    if(reason)throw new GatewayError(reason,409);
    signal.throwIfAborted();
    local=await workerRelay(callbackSocket,token,controller,input.policy.max_requests);
    signal.throwIfAborted();
    const hook=kind=>async data=>{
     let response;
     try{
      response=await requestJson(callbackSocket,'/v1/'+kind,{data,token,signal,limit:12*1024*1024,responseLimit:kind==='captcha'?32768:8192});
     }catch{
      controller.abort(WORKER_TRANSPORT_ERROR);
      throw new GatewayError(WORKER_TRANSPORT_ERROR,502);
     }
     if(response.status===403&&typeof response.value?.error==='string'&&codePattern.test(response.value.error)){
      if(response.value.error===WORKER_TRANSPORT_ERROR)controller.abort(WORKER_TRANSPORT_ERROR);
      throw new GatewayError(response.value.error,403);
     }
     if(response.status!==200||response.value?.ok!==true){
      controller.abort(WORKER_TRANSPORT_ERROR);
      throw new GatewayError(callbackError,502);
     }
     return response.value;
    };
    result=await runner({...input,timeout_ms:Math.max(1,Math.min(input.timeout_ms,input.deadline-Date.now())),relay:local.url,deny_relay:local.deny_url},
     {admit:hook('admit'),artifact:hook('artifact'),cooldown:hook('cooldown'),captcha:hook('captcha')},{signal});
    signal.throwIfAborted();
   }catch(error){
    const code=signal.aborted?signal.reason:error instanceof GatewayError?error.code:WORKER_TRANSPORT_ERROR;
    result=failedResult(code);
   }finally{
    clearTimeout(timer);
    await local?.close();
    res.off('close',disconnected);
    active=null;
   }
   jsonResponse(res,200,result);
  })();
  try{await work.done;}catch{res.destroy();}
 });
 server.on('connection',socket=>trackSocket(sockets,socket));
 server.on('connect',(_req,socket)=>socket.destroy());
 await listenPrivate(server,socketPath);
 return {close:()=>closing??=(async()=>{
  stopping=true;
  const work=active;
  work?.controller.abort(WORKER_TRANSPORT_ERROR);
  const closed=new Promise(resolve=>server.close(resolve));
  for(const socket of sockets)socket.destroy();
  await Promise.allSettled([closed,work?.done]);
 })()};
}

async function main(){
 const runtimePath=process.env.FETCHX_WORKER_RUNTIME;
 if(!runtimePath||!isAbsolute(runtimePath))throw new Error('invalid browser worker runtime path');
 const worker=await startBrowserWorker({socketPath:process.env.FETCHX_WORKER_SOCKET,callbackSocket:process.env.FETCHX_WORKER_CALLBACK_SOCKET,pin:await readSmallFile(runtimePath,8192)});
 const close=()=>worker.close().catch(()=>{process.exitCode=1;});
 process.once('SIGINT',close);
 process.once('SIGTERM',close);
}

if(process.argv[1]===fileURLToPath(import.meta.url))main().catch(()=>{
 console.error('Browser worker could not start. Check the private socket directory and runtime configuration.');
 process.exitCode=1;
});
