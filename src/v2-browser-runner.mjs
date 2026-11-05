import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

export async function runBrowserProbe(input,hooks){
 const directory=await mkdtemp(join(tmpdir(),'fetchx-probe-'));
 try{return await new Promise(resolve=>{
  const env={PATH:process.env.PATH??'/usr/bin:/bin',LANG:'en_US.UTF-8',CLOAKBROWSER_AUTO_UPDATE:'false',CLOAKBROWSER_LICENSE_KEY:'',CLOAKBROWSER_CACHE_DIR:directory};
  const child=spawn(process.execPath,['--max-old-space-size=128',fileURLToPath(new URL('./v2-browser-worker.mjs',import.meta.url))],{detached:true,env,stdio:['pipe','pipe','ignore','ipc']});
  let bytes=0,output=[],forced=null,browserPid=null;const tasks=new Set(),controller=new AbortController();
  const kill=()=>{controller.abort();if(browserPid){try{process.kill(-browserPid,'SIGKILL');}catch{}browserPid=null;}try{process.kill(-child.pid,'SIGKILL');}catch{}};
  const timer=setTimeout(()=>{forced='browser_probe_deadline_unknown';kill();},Math.max(1,input.deadline-Date.now()));
  child.on('message',message=>{
   const task=(async()=>{let result,error;
    try{
     if(message?.kind==='browser_started'){if(!Number.isSafeInteger(message.data?.pid)||message.data.pid<2||browserPid)throw new Error();browserPid=message.data.pid;result={ok:true};}
     else if(message?.kind==='browser_stopped'){if(message.data?.pid!==browserPid)throw new Error();browserPid=null;result={ok:true};}
     else if(message?.kind==='admit')result=await hooks.admit(message.data,{signal:controller.signal});
     else if(message?.kind==='artifact')result=await hooks.artifact(message.data);
     else if(message?.kind==='cooldown')result=await hooks.cooldown(message.data);
     else throw new Error();
    }catch(e){error=/^[a-z][a-z0-9_]{1,100}$/.test(e.code??'')?e.code:'browser_probe_callback_unknown';}
    try{if(child.connected)child.send({id:message?.id,result,error},()=>{});}catch{}
   })();tasks.add(task);task.finally(()=>tasks.delete(task));
  });
  child.stdout.on('data',part=>{bytes+=part.length;if(bytes>2097152){forced='browser_probe_output_limit_unknown';kill();}else output.push(part);});
  child.on('error',()=>{forced='browser_probe_launch_failed';});
  child.on('close',async()=>{clearTimeout(timer);controller.abort();if(browserPid){forced??='browser_probe_cleanup_unknown';kill();}await Promise.allSettled([...tasks]);try{if(forced)throw new Error();const result=JSON.parse(Buffer.concat(output));if(!result||typeof result!=='object')throw new Error();resolve(result);}catch{resolve({error:forced??'browser_probe_protocol_unknown',capture_complete:false,counts_complete:false,status:null,encoded_bytes:null,decoded_bytes:0,dom_bytes:0,blocked_requests:null,blocked_reasons:{},cookies:null});}});
  child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({...input,cache_dir:directory}));
 });}finally{await rm(directory,{recursive:true,force:true});}
}
