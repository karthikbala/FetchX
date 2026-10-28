import {spawn} from 'node:child_process';
import {mkdtemp,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fail} from './policy.mjs';
let active=0;
export async function checkBrowserTier(config,tier,{fetchImpl=fetch}={}){
 const t=config.browser?.[tier];if(!t?.executablePath||!t.sha256||!t.version)fail('browser_tier_unavailable',503);
 await access(t.executablePath).catch(()=>fail('browser_tier_unavailable',503));
 if(tier==='free'&&t.entitlement==='unlicensed')return t;
 if(!t.licenseKey)fail('browser_entitlement_unavailable',503);
 let info;try{const r=await fetchImpl('https://cloakbrowser.dev/api/license/validate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({license_key:t.licenseKey}),signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error();info=await r.json();}catch{fail('browser_entitlement_unverified',503);}
 if(!info.valid||info.expires&&(!Number.isFinite(Date.parse(info.expires))||Date.parse(info.expires)<=Date.now()))fail('browser_entitlement_expired',503);
 if(tier==='paid'&&!['solo','team','business','scale','enterprise'].includes(String(info.plan).toLowerCase()))fail('browser_paid_subscription_required',503);
 return t;
}
export async function browserRequest(input,profile,config,tier,relay,storageState){
 if(active>=(config.browser?.maxConcurrent??1))fail('browser_capacity',503);
 active++;let dir;
 try{
  const t=await checkBrowserTier(config,tier);dir=await mkdtemp(join(tmpdir(),'gateway-browser-'));
  return await new Promise((resolve)=>{
   const child=spawn(process.execPath,[new URL('./browser-worker.mjs',import.meta.url).pathname],{detached:true,stdio:['pipe','pipe','ignore'],env:{...process.env,HOME:dir,CLOAKBROWSER_LICENSE_KEY:'',CLOAKBROWSER_CACHE_DIR:dir}});
   let chunks=[],size=0,forced=null;
   const killGroup=()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}};
   const timer=setTimeout(()=>{forced='browser_deadline';killGroup();},60000);
   child.stdout.on('data',b=>{size+=b.length;if(size>profile.maxResponseBytes*1.4+1024*1024){forced='response_too_large';killGroup();}else chunks.push(b);});
   child.on('error',()=>{forced='browser_launch_failed';});
   child.on('close',()=>{clearTimeout(timer);try{if(forced)throw Error();const r=JSON.parse(Buffer.concat(chunks));resolve({...r,body:Buffer.from(r.body_base64??'','base64'),providerStatus:null});}catch{resolve({status:null,headers:{},cookies:[],body:Buffer.alloc(0),error:forced??'browser_protocol_error'});}});
   child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({url:input.url,headers:input.headers,profile,recipeInput:input.browser,browser:t,relay,storageState,cacheDir:dir}));
  });
 }finally{active--;if(dir)await rm(dir,{recursive:true,force:true});}
}
