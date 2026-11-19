import {isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
// A browser worker host: serves one capture at a time on a private socket for
// the gateway's pool. The browser's egress goes back to the gateway through
// the callback socket (CONNECT bridging), so the gateway still admits, pins and
// meters every connection.
import {CAMOUFOX_PIN,fileSha256} from './engine.mjs';
import {runCapture} from './runner.mjs';
import {GatewayError} from '../policy.mjs';
import {bridgeTunnels,codePattern,jsonLength,jsonResponse,listen,listenPrivate,matchesRuntime,object,openWorkerTunnel,privateServer,OUTPUT_LIMIT,readJson,readSmallFile,requestJson,requestToken,socketPathValid,targetPattern,trackSocket,WORKER_TRANSPORT_ERROR} from './wire.mjs';
import {checkCaptureInput} from './capture-input.mjs';

const deadlineError='browser_deadline';
const callbackError='browser_callback_failed';
const validPin=pin=>object(pin)&&Object.keys(pin).length===5&&pin.engine==='camoufox'&&pin.version===CAMOUFOX_PIN.version&&
 typeof pin.executablePath==='string'&&isAbsolute(pin.executablePath)&&typeof pin.modelDir==='string'&&isAbsolute(pin.modelDir)&&
 typeof pin.sha256==='string'&&/^[a-f0-9]{64}$/.test(pin.sha256);
const failedResult=error=>({error,status:null,requests:0,blocked:0,captcha:[],cookies:[]});
let verified;
// The binary is hashed once per change of its file identity, not per capture.
async function binaryReady(pin){
 try{
  const stamp=JSON.stringify(await import('node:fs/promises').then(fs=>fs.stat(pin.executablePath)).then(s=>[s.ino,s.size,s.mtimeMs]));
  if(verified?.stamp!==stamp)verified={stamp,ok:fileSha256(pin.executablePath).then(hash=>hash===pin.sha256)};
  return await verified.ok?null:'browser_build_mismatch';
 }catch{return 'browser_runtime_unavailable';}
}

async function workerRelay(callbackSocket,token,controller,maxRequests){
 const signal=controller.signal,sockets=new Set();
 const denyRequest=(_req,res)=>res.writeHead(403,{'connection':'close'}).end();
 const denyConnect=(_req,socket)=>socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
 const relay=privateServer(denyRequest);
 let connections=0,closing;
 relay.on('connection',socket=>trackSocket(sockets,socket));
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
   // One reset or refused connection is one failed request in the page, as in any
   // browser; it must not end the capture. A lost gateway fails the navigation itself.
   remote.socket.on('error',()=>client.destroy());
   bridgeTunnels(client,remote.socket,remote.head);
   client.resume();
  }catch{
   client.destroy();
  }
 });
 const close=()=>closing??=(async()=>{
  const closed=relay.listening?new Promise(resolve=>relay.close(resolve)):Promise.resolve();
  for(const socket of sockets)socket.destroy();
  await closed;
 })();
 try{
  await listen(relay,{host:'127.0.0.1',port:0});
 }catch(error){await close();throw error;}
 const relayUrl=server=>'http://127.0.0.1:'+server.address().port;
 const url=relayUrl(relay);
 signal.addEventListener('abort',close,{once:true});
 if(signal.aborted)await close();
 return {url,close:async()=>{signal.removeEventListener('abort',close);await close();}};
}

function captureInput(value,runtime){
 const input=checkCaptureInput(value);
 if(!matchesRuntime(input.runtime,runtime))throw new Error('runtime mismatch');
 return {...input,runtime:{...runtime}};
}

export async function startBrowserWorker({socketPath,callbackSocket,pin,runner=runCapture}){
 if(!validPin(pin)||!socketPathValid(callbackSocket)||callbackSocket===socketPath)throw new Error('invalid browser worker configuration');
 const runtime={...pin,platform:process.platform,arch:process.arch};
 const {executablePath,modelDir,...advertised}=runtime,sockets=new Set();
 let active,stopping=false,closing;
 const healthy=async()=>{
  if(stopping||await binaryReady(runtime))return false;
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
    const input=captureInput(await readJson(req,jsonLength(req,OUTPUT_LIMIT)),runtime);
    timer=setTimeout(()=>controller.abort(deadlineError),Math.max(1,input.deadline-Date.now()));
    const reason=await binaryReady(runtime);
    if(reason)throw new GatewayError(reason,409);
    signal.throwIfAborted();
    local=await workerRelay(callbackSocket,token,controller,input.limits.max_requests);
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
    result=await runner({...input,relay:local.url},
     {admit:hook('admit'),artifact:hook('artifact'),captcha:hook('captcha')},{signal});
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
