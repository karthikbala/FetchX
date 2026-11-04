import {createReadStream} from 'node:fs';
import {access,stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {fail} from './policy.mjs';

export const BROWSER_SCREENSHOT_MAX_BYTES=1048576;
export const BROWSER_PROBE_QUALIFICATION_KIND='pinned-relay-egress-v2';

export function browserProbePolicy(raw){
 if(raw===undefined)return null;
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!['enabled','max_requests','max_network_bytes','max_decoded_bytes','max_dom_bytes','settle_ms'].includes(k))||typeof raw.enabled!=='boolean')fail('browser_probe_configuration',503);
 if(!raw.enabled)return null;
 const policy={enabled:true,max_requests:8,max_network_bytes:4194304,max_decoded_bytes:4194304,max_dom_bytes:524288,settle_ms:750,...raw};
 for(const [name,min,max]of [['max_requests',1,32],['max_network_bytes',1024,16777216],['max_decoded_bytes',1024,8388608],['max_dom_bytes',1024,1048576],['settle_ms',0,2000]])if(!Number.isSafeInteger(policy[name])||policy[name]<min||policy[name]>max)fail('browser_probe_configuration',503);
 return policy;
}
export async function binarySha(path){const hash=createHash('sha256');for await(const part of createReadStream(path))hash.update(part);return hash.digest('hex');}

let verifiedBinary;
async function binaryStamp(path){
 const file=await stat(path,{bigint:true});
 if(!file.isFile())throw new Error('browser executable is not a regular file');
 return [path,file.dev,file.ino,file.size,file.mtimeNs,file.ctimeNs].join('\0');
}
async function verifiedBinarySha(path){
 const stamp=await binaryStamp(path);
 if(verifiedBinary?.stamp!==stamp){
  const digest=(async()=>{
   const hash=await binarySha(path);
   if(await binaryStamp(path)!==stamp)throw new Error('browser executable changed during verification');
   return hash;
  })();
  verifiedBinary={stamp,digest};
 }
 const check=verifiedBinary;
 try{return await check.digest;}catch(error){if(verifiedBinary===check)verifiedBinary=undefined;throw error;}
}

// An explicit Chromium pin and the legacy keyless Cloak pin are separate
// platform contracts. Neither is discovered or downloaded at request time.
export async function browserProbeRuntime(config){
 const settings=config.v2?.browser_probe;
 const unavailable=reason=>({available:false,reason});
 if(settings?.enabled!==true)return unavailable('browser_probe_disabled');
 const engine=settings.engine??'cloakbrowser';
 let tier;
 if(engine==='chromium'){
  tier=settings.runtime;
  if(settings.tier!==undefined||!tier||typeof tier!=='object'||Array.isArray(tier)||Object.keys(tier).some(key=>!['executablePath','version','sha256'].includes(key))||
   typeof tier.executablePath!=='string'||!isAbsolute(tier.executablePath)||typeof tier.version!=='string'||!/^\d+\.\d+\.\d+\.\d+$/.test(tier.version))return unavailable('browser_probe_runtime_unqualified');
 }else if(engine==='cloakbrowser'){
  tier=config.browser?.free;
  if(settings.tier!=='free'||!tier||tier.entitlement!=='unlicensed'||!tier.executablePath||!tier.version)return unavailable('browser_probe_runtime_unqualified');
 }else return unavailable('browser_probe_runtime_unqualified');
 if(typeof tier.sha256!=='string'||!/^[a-f0-9]{64}$/.test(tier.sha256))return unavailable('browser_probe_runtime_unqualified');
 const q=settings.qualification;
 if(!q||q.status!=='accepted'||q.kind!==BROWSER_PROBE_QUALIFICATION_KIND||q.binary_sha256!==tier.sha256||q.version!==tier.version||
  q.platform!==process.platform||q.arch!==process.arch||!/^sha256:[a-f0-9]{64}$/.test(q.evidence??'')||
  !Number.isFinite(Date.parse(q.expires_at))||Date.parse(q.expires_at)<=Date.now())return unavailable('browser_probe_runtime_unqualified');
 if(engine==='chromium'?q.engine!==engine||q.entitlement!==undefined:q.engine!==undefined&&q.engine!==engine||q.entitlement!=='unlicensed')return unavailable('browser_probe_runtime_unqualified');
 try{await access(tier.executablePath,constants.X_OK);if(await verifiedBinarySha(tier.executablePath)!==tier.sha256)return unavailable('browser_probe_build_mismatch');}catch{return unavailable('browser_probe_runtime_unavailable');}
 return {available:true,runtime:{engine,executablePath:tier.executablePath,version:tier.version,sha256:tier.sha256,expires_at:q.expires_at,...(engine==='cloakbrowser'?{entitlement:'unlicensed'}:{})}};
}

export const BROWSER_PROBE_ARGS=Object.freeze(['--proxy-bypass-list=<-loopback>','--disable-quic','--disable-http2','--dns-prefetch-disable','--disable-background-networking','--disable-component-update','--disable-sync','--disable-default-apps','--no-first-run','--no-default-browser-check','--force-webrtc-ip-handling-policy=disable_non_proxied_udp','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']);

// Chromium sends ws/wss to the "other" proxy list (socks=), ahead of
// either HTTP list. Only HTTPS has a route to the metered CONNECT listener.
export function browserProxyArg(relay,deny){
 const local=/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/;
 if(!local.test(relay)||!local.test(deny)||relay===deny)fail('browser_probe_runtime_unqualified',503);
 return `--proxy-server=https=${relay};http=${deny};socks=${deny}`;
}

// Shared with the operator fixture so production and qualification use the
// same sandbox, proxy arguments, local executable and browser server settings.
export async function browserProbeLaunchOptions(runtime,{relay,denyRelay,cacheDir,deadline}){
 if(typeof cacheDir!=='string'||!isAbsolute(cacheDir))fail('browser_probe_runtime_unqualified',503);
 const engine=runtime.engine??'cloakbrowser';
 const args=[...BROWSER_PROBE_ARGS,browserProxyArg(relay,denyRelay)];
 const timeout=Math.min(15000,Math.max(1,deadline-Date.now()));
 let options;
 if(engine==='chromium'){
  options={executablePath:runtime.executablePath,headless:true,args,timeout};
 }else if(engine==='cloakbrowser'&&runtime.entitlement==='unlicensed'){
  process.env.CLOAKBROWSER_BINARY_PATH=runtime.executablePath;
  process.env.CLOAKBROWSER_AUTO_UPDATE='false';
  process.env.CLOAKBROWSER_LICENSE_KEY='';
  process.env.CLOAKBROWSER_CACHE_DIR=cacheDir;
  const sdk=await import('cloakbrowser');
  // CloakBrowser's SDK defaults include --no-sandbox. Use reviewed args only.
  options=await sdk.buildLaunchOptions({headless:true,stealthArgs:false,geoip:false,humanize:false,browserVersion:runtime.version,args:[...args,'--fingerprint-platform=linux'],launchOptions:{chromiumSandbox:true,timeout}});
 }else fail('browser_probe_runtime_unqualified',503);
 if(options.executablePath!==runtime.executablePath||options.args?.some(arg=>/^(?:--no-sandbox|--disable-web-security|--ignore-certificate-errors[^=]*|--allow-insecure-localhost)(?:=|$)/.test(arg)))fail('browser_probe_runtime_unqualified',503);
 // The service has a read-only root and launches as a numeric user.
 // Chromium's config, cache and Crashpad paths stay inside the private tmpdir.
 const env={...(options.env??process.env),XDG_CONFIG_HOME:cacheDir,XDG_CACHE_HOME:cacheDir};
 return {...options,env,ignoreDefaultArgs:[...(options.ignoreDefaultArgs??[]),'--disable-popup-blocking','--disable-ipc-flooding-protection'],chromiumSandbox:true,host:'127.0.0.1',port:0};
}
