import {binarySha,browserProbeLaunchOptions} from './v2-browser-policy.mjs';
import {captureBrowserProbe} from './v2-browser-capture.mjs';
let server,browser,input,next=0;const pending=new Map();
process.on('message',message=>{const task=pending.get(message?.id);if(!task)return;pending.delete(message.id);clearTimeout(task.timer);message.error?task.reject(Object.assign(new Error(),{code:message.error})):task.resolve(message.result);});
function rpc(kind,data){return new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(Object.assign(new Error(),{code:'browser_probe_ipc_unknown'}));},Math.max(1,input.deadline-Date.now()));pending.set(id,{resolve,reject,timer});process.send({id,kind,data},error=>{if(error){clearTimeout(timer);pending.delete(id);reject(Object.assign(new Error(),{code:'browser_probe_ipc_unknown'}));}});});}
let output;
try{
 input=await new Promise((resolve,reject)=>{let value='';process.stdin.setEncoding('utf8');process.stdin.on('data',part=>{value+=part;if(value.length>2097152)reject(new Error());});process.stdin.on('end',()=>{try{resolve(JSON.parse(value));}catch{reject(new Error());}});});
 for(const method of ['log','warn','info','debug','error'])console[method]=()=>{};
 if(!Number.isFinite(Date.parse(input.runtime.expires_at))||Date.parse(input.runtime.expires_at)<=Date.now()||await binarySha(input.runtime.executablePath)!==input.runtime.sha256)throw Object.assign(new Error(),{code:'browser_probe_build_mismatch'});
 const options=await browserProbeLaunchOptions(input.runtime,{relay:input.relay,denyRelay:input.deny_relay,cacheDir:input.cache_dir,deadline:input.deadline});
 const {chromium}=await import('playwright-core');
 server=await chromium.launchServer(options);await rpc('browser_started',{pid:server.process().pid});
 browser=await chromium.connect(server.wsEndpoint());
 output=await captureBrowserProbe(browser,input,input.policy,{admit:data=>rpc('admit',data),artifact:data=>rpc('artifact',data),cooldown:data=>rpc('cooldown',data)});
}catch(error){output={error:['browser_probe_build_mismatch','browser_probe_runtime_unqualified'].includes(error.code)?error.code:'browser_probe_interrupted_unknown',capture_complete:false,counts_complete:false,blocked_requests:null,blocked_reasons:{},encoded_bytes:null,decoded_bytes:0,dom_bytes:0,status:null,cookies:null};}
finally{await browser?.close().catch(()=>{});const pid=server?.process().pid;await server?.close().catch(()=>{});if(pid)await rpc('browser_stopped',{pid}).catch(()=>{});for(const task of pending.values())clearTimeout(task.timer);}
process.stdout.write(JSON.stringify(output));if(process.connected)process.disconnect();
