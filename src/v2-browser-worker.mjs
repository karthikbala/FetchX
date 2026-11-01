import {binarySha,BROWSER_PROBE_ARGS} from './v2-browser-policy.mjs';
import {captureBrowserProbe} from './v2-browser-capture.mjs';
let server,browser,input,next=0;const pending=new Map();
process.on('message',message=>{const task=pending.get(message?.id);if(!task)return;pending.delete(message.id);clearTimeout(task.timer);message.error?task.reject(Object.assign(new Error(),{code:message.error})):task.resolve(message.result);});
function rpc(kind,data){return new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(Object.assign(new Error(),{code:'browser_probe_ipc_unknown'}));},Math.max(1,input.deadline-Date.now()));pending.set(id,{resolve,reject,timer});process.send({id,kind,data},error=>{if(error){clearTimeout(timer);pending.delete(id);reject(Object.assign(new Error(),{code:'browser_probe_ipc_unknown'}));}});});}
let output;
try{
 input=await new Promise((resolve,reject)=>{let value='';process.stdin.setEncoding('utf8');process.stdin.on('data',part=>{value+=part;if(value.length>2097152)reject(new Error());});process.stdin.on('end',()=>{try{resolve(JSON.parse(value));}catch{reject(new Error());}});});
 for(const method of ['log','warn','info','debug','error'])console[method]=()=>{};
 if(input.runtime.entitlement!=='unlicensed'||await binarySha(input.runtime.executablePath)!==input.runtime.sha256)throw Object.assign(new Error(),{code:'browser_probe_build_mismatch'});
 process.env.CLOAKBROWSER_BINARY_PATH=input.runtime.executablePath;process.env.CLOAKBROWSER_AUTO_UPDATE='false';process.env.CLOAKBROWSER_LICENSE_KEY='';process.env.CLOAKBROWSER_CACHE_DIR=input.cache_dir;
 const {buildLaunchOptions}=await import('cloakbrowser');const {chromium}=await import('playwright-core');
 const options=await buildLaunchOptions({headless:true,geoip:false,humanize:false,browserVersion:input.runtime.version,proxy:{server:input.relay},args:[...BROWSER_PROBE_ARGS,'--fingerprint-platform=linux'],launchOptions:{chromiumSandbox:true,timeout:Math.min(15000,Math.max(1,input.deadline-Date.now()))}});
 if(options.args?.some(arg=>/^(?:--no-sandbox|--disable-web-security|--ignore-certificate-errors)(?:=|$)/.test(arg)))throw Object.assign(new Error(),{code:'browser_probe_runtime_unqualified'});
 server=await chromium.launchServer({...options,chromiumSandbox:true,host:'127.0.0.1',port:0});await rpc('browser_started',{pid:server.process().pid});
 browser=await chromium.connect(server.wsEndpoint());
 output=await captureBrowserProbe(browser,input,input.policy,{admit:data=>rpc('admit',data),artifact:data=>rpc('artifact',data)});
}catch(error){output={error:['browser_probe_build_mismatch','browser_probe_runtime_unqualified'].includes(error.code)?error.code:'browser_probe_interrupted_unknown',capture_complete:false,counts_complete:false,blocked_requests:null,blocked_reasons:{},encoded_bytes:null,decoded_bytes:0,dom_bytes:0,status:null,cookies:null};}
finally{await browser?.close().catch(()=>{});const pid=server?.process().pid;await server?.close().catch(()=>{});if(pid)await rpc('browser_stopped',{pid}).catch(()=>{});for(const task of pending.values())clearTimeout(task.timer);}
process.stdout.write(JSON.stringify(output));if(process.connected)process.disconnect();
