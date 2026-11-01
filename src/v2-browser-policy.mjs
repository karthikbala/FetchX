import {createReadStream} from 'node:fs';
import {access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {fail} from './policy.mjs';

export function browserProbePolicy(raw){
 if(raw===undefined)return null;
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!['enabled','max_requests','max_network_bytes','max_decoded_bytes','max_dom_bytes','settle_ms'].includes(k))||typeof raw.enabled!=='boolean')fail('browser_probe_configuration',503);
 if(!raw.enabled)return null;
 const policy={enabled:true,max_requests:8,max_network_bytes:4194304,max_decoded_bytes:4194304,max_dom_bytes:524288,settle_ms:750,...raw};
 for(const [name,min,max]of [['max_requests',1,32],['max_network_bytes',1024,16777216],['max_decoded_bytes',1024,8388608],['max_dom_bytes',1024,1048576],['settle_ms',0,2000]])if(!Number.isSafeInteger(policy[name])||policy[name]<min||policy[name]>max)fail('browser_probe_configuration',503);
 return policy;
}
export async function binarySha(path){const hash=createHash('sha256');for await(const part of createReadStream(path))hash.update(part);return hash.digest('hex');}

// No vendor/entitlement requests are made here. Initial v2 probes support only
// an explicitly qualified, locally pinned unlicensed free Cloak build. A paid
// license, a trial, an installed Chrome, or fixture success cannot satisfy this.
export async function browserProbeRuntime(config){
 const settings=config.v2?.browser_probe,tier=config.browser?.free;
 const unavailable=reason=>({available:false,reason});
 if(settings?.enabled!==true)return unavailable('browser_probe_disabled');
 if(settings.tier!=='free'||!tier||tier.entitlement!=='unlicensed'||!tier.executablePath||!tier.version||!(/^[a-f0-9]{64}$/.test(tier.sha256??'')))return unavailable('browser_probe_runtime_unqualified');
 const q=settings.qualification;
 if(!q||q.status!=='accepted'||q.kind!=='pinned-relay-egress-v1'||q.binary_sha256!==tier.sha256||q.version!==tier.version||q.entitlement!=='unlicensed'||q.platform!==process.platform||q.arch!==process.arch||!/^sha256:[a-f0-9]{64}$/.test(q.evidence??'')||!Number.isFinite(Date.parse(q.expires_at))||Date.parse(q.expires_at)<=Date.now())return unavailable('browser_probe_runtime_unqualified');
 try{await access(tier.executablePath,constants.X_OK);if(await binarySha(tier.executablePath)!==tier.sha256)return unavailable('browser_probe_build_mismatch');}catch{return unavailable('browser_probe_runtime_unavailable');}
 // Playwright route.continue() does not intercept subsequent redirect hops.
 // Until every hop is admitted through the same pinned browser transport, even
 // an otherwise qualified build must not enable source execution.
 return unavailable('browser_probe_redirect_admission_unqualified');
}

export const BROWSER_PROBE_ARGS=Object.freeze(['--proxy-bypass-list=<-loopback>','--disable-quic','--disable-background-networking','--disable-component-update','--disable-sync','--disable-default-apps','--no-first-run','--no-default-browser-check','--force-webrtc-ip-handling-policy=disable_non_proxied_udp','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']);
