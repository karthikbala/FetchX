import {connectRelay} from './connect-relay.mjs';
import {providerProxy,selectedRoute} from './residential.mjs';
import {oxylabsRequest} from './transport.mjs';
import {browserRequest} from './browser.mjs';
import {GatewayError} from './policy.mjs';
export async function residentialRequest(input,w,config,storageState,captcha){
 const p=w.config,{provider,tier}=selectedRoute(p),proxy=providerProxy(config,p,provider);
 const relay=await connectRelay({proxy,profile:p,maxBytes:p.maxAttemptBytes,allowLicense:(p.browserEngine??'cloakbrowser')==='cloakbrowser'&&!!tier&&config.browser?.[tier]?.entitlement!=='unlicensed'});
 let r;
 try{r=p.execution==='browser'?await browserRequest(input,p,config,tier,relay.url,storageState,captcha):await oxylabsRequest(input,{url:relay.url},p);}
 catch(e){r={status:null,providerStatus:null,headers:{},cookies:[],body:Buffer.alloc(0),credits:null,error:e instanceof GatewayError?e.code:'transport_outcome_unknown'};}
 finally{await relay.close();}
 return {...r,wireBytes:relay.bytes,proxyTraffic:relay.traffic,error:relay.error??r.error??null};
}
