import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PROBE_JSON_LIMIT,WORKER_TRANSPORT_ERROR} from './v2-browser-worker-wire.mjs';

export async function runBrowserProbe(input,hooks,{signal}={}){
 const directory=await mkdtemp(join(tmpdir(),'fetchx-probe-'));
 try{return await new Promise(resolve=>{
  const env={PATH:process.env.PATH??'/usr/bin:/bin',LANG:'en_US.UTF-8',CLOAKBROWSER_AUTO_UPDATE:'false',CLOAKBROWSER_LICENSE_KEY:'',CLOAKBROWSER_CACHE_DIR:directory};
  const child=spawn(process.execPath,['--max-old-space-size=128',fileURLToPath(new URL('./v2-browser-worker.mjs',import.meta.url))],{detached:true,env,stdio:['pipe','pipe','ignore','ipc']});
  let bytes=0,output=[],forced=null,browserPid=null,killTimer;
  const tasks=new Set(),controller=new AbortController();
  const killGroup=pid=>{if(pid){try{process.kill(-pid,'SIGKILL');}catch{}}};
  const stop=code=>{
   forced??=code;
   controller.abort();
   killGroup(browserPid);
   // Give Playwright's exit handler a chance to reap a Chromium process
   // spawned just before the worker could report its PID over IPC.
   child.kill('SIGUSR2');
   killTimer??=setTimeout(()=>{killGroup(browserPid);killGroup(child.pid);},500);
  };
  const disconnected=()=>stop(WORKER_TRANSPORT_ERROR);
  const timer=setTimeout(()=>stop('browser_probe_deadline_unknown'),Math.max(1,input.deadline-Date.now()));
  signal?.addEventListener('abort',disconnected,{once:true});
  if(signal?.aborted)disconnected();
  child.on('message',message=>{
   const task=(async()=>{let result,error;
    try{
     if(message?.kind==='browser_started'){if(!Number.isSafeInteger(message.data?.pid)||message.data.pid<2||browserPid)throw new Error();browserPid=message.data.pid;if(forced)killGroup(browserPid);result={ok:true};}
     else if(message?.kind==='browser_stopped'){if(message.data?.pid!==browserPid)throw new Error();browserPid=null;result={ok:true};}
     else if(message?.kind==='admit')result=await hooks.admit(message.data,{signal:controller.signal});
     else if(message?.kind==='artifact')result=await hooks.artifact(message.data);
     else if(message?.kind==='cooldown')result=await hooks.cooldown(message.data);
     else if(message?.kind==='captcha'&&hooks.captcha)result=await hooks.captcha(message.data,{signal:controller.signal});
     else throw new Error();
    }catch(e){error=/^[a-z][a-z0-9_]{1,100}$/.test(e.code??'')?e.code:'browser_probe_callback_unknown';}
    try{if(child.connected)child.send({id:message?.id,result,error},()=>{});}catch{}
   })();tasks.add(task);task.finally(()=>tasks.delete(task));
  });
  child.stdout.on('data',part=>{bytes+=part.length;if(bytes>PROBE_JSON_LIMIT)stop('browser_probe_output_limit_unknown');else output.push(part);});
  child.on('error',()=>{forced='browser_probe_launch_failed';});
  child.on('close',async()=>{clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',disconnected);controller.abort();if(browserPid){forced??='browser_probe_cleanup_unknown';killGroup(browserPid);}await Promise.allSettled([...tasks]);try{if(forced)throw new Error();const result=JSON.parse(Buffer.concat(output));if(!result||typeof result!=='object')throw new Error();resolve(result);}catch{resolve({error:forced??'browser_probe_protocol_unknown',capture_complete:false,counts_complete:false,status:null,encoded_bytes:null,decoded_bytes:0,dom_bytes:0,blocked_requests:null,blocked_reasons:{},cookies:null});}});
  child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({...input,cache_dir:directory}));
 });}finally{await rm(directory,{recursive:true,force:true});}
}
