import {connectRelay} from './connect-relay.mjs';
import {providerProxy,selectedRoute} from './residential.mjs';
import {oxylabsRequest} from './transport.mjs';
import {browserRequest} from './browser.mjs';
export async function residentialRequest(input,w,config,storageState){
 const p=w.config,{provider,tier}=selectedRoute(p),proxy=providerProxy(config,p,provider);
 const relay=await connectRelay({proxy,profile:p,maxBytes:p.maxAttemptBytes,allowLicense:!!tier&&config.browser?.[tier]?.entitlement!=='unlicensed'});
 try{
  const r=p.execution==='browser'?await browserRequest(input,p,config,tier,relay.url,storageState):await oxylabsRequest(input,{url:relay.url},p);
  return {...r,wireBytes:relay.bytes,error:relay.error??r.error??null};
 }finally{await relay.close();}
}
