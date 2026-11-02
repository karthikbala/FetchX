import {access,readFile,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {isAbsolute,dirname,join,basename} from 'node:path';
import {fail,checkedURL,checkedHeaders} from './policy.mjs';

// A launcher upgrade must review its paired browser, protocol and model together.
export const CAMOUFOX_PIN=Object.freeze({launcher:'0.5.9',playwright:'1.62.1',version:'158.0.1-beta.41',model:'6530b8322cdaa4ec042921c8d9a0369a0e6e0269ba636c01a7203e4a2f109936'});
const MODEL_FILES=Object.freeze({
 'fingerprint-network.json.zst':'e1b0a7e60837c347f4b7d5dad4a20c356d521e0593e1bf4a8be39ea1e6a41ac4',
 'values.dat.zst':'3da2cf0891a4a85ef6458f0fbdf9346acfcd04e5fd279a0ea22d7919e4eaf122',
 'values.json.zst':'294decde5b6a1a52ed53d50a894130fa5c58f7cc804b78198f5c33f55b3ba66f',
 'values.dat':'9ce7d16630e91654e73988f7d37e8c99987c09b9c779a7bb9dc7ad6355dcc2f0'
});
export function browserEngine(profile={}){
 const engine=profile.browserEngine??'cloakbrowser';
 if(!['camoufox','cloakbrowser'].includes(engine))fail('browser_engine_unavailable',503);
 return engine;
}
export function newBrowserEngine(profile,config){return browserEngine({browserEngine:profile.browserEngine??config.browser?.defaultEngine??'camoufox'});}
export function browserRedirectBlocked(error,profile){return browserEngine(profile)==='camoufox'&&/\bNS_ERROR_REDIRECT_LOOP\b/.test(error?.message??'');}
export async function fileSha256(path){const hash=createHash('sha256');for await(const part of createReadStream(path))hash.update(part);return hash.digest('hex');}
function versionDirectory(executablePath){const dir=dirname(executablePath);return basename(dir)==='MacOS'?dirname(dirname(dirname(dir))):dir;}
export async function verifyCamoufoxBuild(tier){
 if(!tier?.executablePath||!isAbsolute(tier.executablePath)||!isAbsolute(tier.modelDir??'')||!/^[a-f0-9]{64}$/.test(tier.sha256??''))fail('browser_tier_unavailable',503);
 if(tier.qualified!==true)fail('browser_not_qualified',503);
 if(tier.version!==CAMOUFOX_PIN.version)fail('browser_version_mismatch',503);
 try{await access(tier.executablePath);if(!(await stat(tier.executablePath)).isFile())throw Error();}catch{fail('browser_tier_unavailable',503);}
 if(await fileSha256(tier.executablePath)!==tier.sha256)fail('browser_build_mismatch',503);
 let metadata;try{metadata=JSON.parse(await readFile(join(versionDirectory(tier.executablePath),'version.json'),'utf8'));}catch{fail('browser_version_mismatch',503);}
 if(`${metadata.version}-${metadata.release??metadata.tag??metadata.build}`!==CAMOUFOX_PIN.version)fail('browser_version_mismatch',503);
 try{
  if((await readFile(join(tier.modelDir,'.pinned-model'),'utf8')).trim()!==CAMOUFOX_PIN.model)throw Error();
  for(const [name,digest]of Object.entries(MODEL_FILES))if(await fileSha256(join(tier.modelDir,name))!==digest)throw Error();
 }catch{fail('browser_model_unavailable',503);}
 return tier;
}
export function camoufoxLaunchOptions(tier,profile,relay,cacheDir){
 let proxy;try{proxy=new URL(relay);}catch{fail('browser_proxy_required',503);}
 // Only the gateway's private, bounded CONNECT relay can be a browser proxy.
 if(proxy.protocol!=='http:'||proxy.hostname!=='127.0.0.1'||!proxy.port||proxy.username||proxy.password||proxy.pathname!=='/'||proxy.search||proxy.hash)fail('browser_proxy_required',503);
 if(typeof profile.locale!=='string'||typeof profile.timezone!=='string')fail('browser_identity_unconfigured',500);
 try{new Intl.DateTimeFormat(profile.locale,{timeZone:profile.timezone});}catch{fail('browser_identity_invalid',500);}
 const delay=profile.browserActionDelayMs??150;
 if(!Number.isInteger(delay)||delay<0||delay>1000)fail('browser_pacing_invalid',500);
 return {executable_path:tier.executablePath,headless:true,geoip:false,block_webrtc:true,
  // Avoid the launcher's separate, unproxied host-GPU probe.
  canvas_noise:true,os:process.platform==='darwin'?'macos':process.platform==='win32'?'windows':'linux',
  locale:profile.locale,config:{timezone:profile.timezone},humanize:true,
  proxy:{server:relay,bypass:''},timeout:20000,slowMo:delay,exclude_addons:['UBO'],
  env:{...process.env,HOME:cacheDir,CAMOUFOX_EXECUTABLE_PATH:tier.executablePath,CAMOUFOX_FPGEN_DATA:tier.modelDir,MOZ_CRASHREPORTER_DISABLE:'1',MOZ_DATA_REPORTING:'0'},
  firefox_user_prefs:{
   'network.proxy.failover_direct':false,'network.proxy.no_proxies_on':'','network.proxy.allow_hijacking_localhost':true,
   'network.dns.disablePrefetch':true,'network.prefetch-next':false,'network.predictor.enabled':false,
   'network.http.speculative-parallel-limit':0,'network.trr.mode':5,'network.http.http3.enable':false,'network.http.redirection-limit':0,
   // Provisional diagnostic settings only: Juggler needs this engine enabled.
   // Private browsing blocks native workers but FAILS cookie continuity;
   // the production launcher is hard gated until a compatible policy exists.
   'dom.serviceWorkers.enabled':true,'browser.privatebrowsing.autostart':true,'dom.serviceWorkers.privateBrowsing.enabled':false,'media.peerconnection.enabled':false,
   'app.update.auto':false,'app.update.enabled':false,'extensions.update.enabled':false,'extensions.systemAddon.update.enabled':false,
   'toolkit.telemetry.enabled':false,'toolkit.telemetry.unified':false,'toolkit.telemetry.server':'',
   'datareporting.healthreport.uploadEnabled':false,'datareporting.policy.dataSubmissionEnabled':false,
   'browser.discovery.enabled':false,'browser.newtabpage.activity-stream.feeds.telemetry':false,'browser.newtabpage.activity-stream.telemetry':false,
   'browser.safebrowsing.downloads.remote.enabled':false,'network.captive-portal-service.enabled':false,'network.connectivity-service.enabled':false
  }};
}
export async function launchPinnedBrowser(tier,profile,relay,cacheDir){
 const engine=browserEngine(profile);
 // This paired build cannot simultaneously preserve routing, native service-worker
 // exclusion and cookie continuity. Configuration cannot override this service gate.
 if(engine==='camoufox')fail('browser_runtime_unqualified',503);
 if(await fileSha256(tier.executablePath)!==tier.sha256)fail('browser_build_mismatch',503);
 process.env.CLOAKBROWSER_BINARY_PATH=tier.executablePath;process.env.CLOAKBROWSER_AUTO_UPDATE='false';
 process.env.CLOAKBROWSER_LICENSE_KEY='';process.env.CLOAKBROWSER_CACHE_DIR=cacheDir;
 const {launch}=await import('cloakbrowser');
 return launch({licenseKey:tier.licenseKey,headless:true,geoip:false,humanize:true,browserVersion:tier.version,
  proxy:{server:relay},chromiumSandbox:true,launchOptions:{chromiumSandbox:true,timeout:20000},
  args:['--fingerprint-platform=linux','--proxy-bypass-list=<-loopback>','--disable-quic','--disable-background-networking','--force-webrtc-ip-handling-policy=disable_non_proxied_udp','--license-through-proxy']});
}
// Shared by both engines. The injected resolver is for synthetic tests; workers
// use checkedURL's real public-IP resolver and never accept resolver input.
export async function installBrowserRestrictions(context,input,{resolve}={}){
 const counts={requests:0,blocked:0,webSockets:0},origin=new URL(input.url).origin;
 await context.routeWebSocket('**/*',ws=>{counts.webSockets++;ws.close();});
 await context.route('**/*',async route=>{
  try{
   const request=route.request();
   if(++counts.requests>(input.profile.maxBrowserRequests??50)||['image','media','font'].includes(request.resourceType()))throw Error();
   const u=await checkedURL(request.url(),input.profile,resolve);
   if(!input.profile.methods.includes(request.method())||(request.postDataBuffer()?.length??0)>input.profile.maxInputBytes)throw Error();
   const supplied=u.origin===origin?input.headers:{};
   checkedHeaders(supplied,input.profile,u,request.method());
   const headers={...request.headers()};
   if(u.origin!==origin)for(const name of Object.keys(headers))if(['authorization','proxy-authorization',...Object.keys(input.headers).map(n=>n.toLowerCase())].includes(name.toLowerCase()))delete headers[name];
   await route.fallback({headers:{...headers,...supplied}});
  }catch{counts.blocked++;await route.abort('blockedbyclient').catch(()=>{});}
 });
 return counts;
}
