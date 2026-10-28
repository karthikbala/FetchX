import {spawn} from 'node:child_process';
import {fetch} from 'undici';
import {GatewayError,fail} from './policy.mjs';
const drop=/^(?:connection|content-length|transfer-encoding|content-encoding|proxy-authenticate|proxy-authorization|keep-alive|trailer|upgrade)$/i;
export function redactProviderSecrets(response,secrets){
 const metadata=JSON.stringify([response.headers,response.cookies,response.extracted,response.storageState]);
 if(secrets.filter(Boolean).some(secret=>response.body.includes(Buffer.from(secret))||metadata.includes(secret)))
  return {...response,redactedBytes:response.body.length,headers:{},cookies:[],extracted:undefined,screenshot_base64:undefined,storageState:undefined,body:Buffer.alloc(0),error:'sensitive_provider_response'};
 return response;
}
export function sourceHeaders(pairs){
 const headers={},cookies=[];
 for(const [k,v]of pairs){if(drop.test(k)||k.toLowerCase().startsWith('scrape.do-'))continue;if(k.toLowerCase()==='set-cookie')cookies.push(v);else headers[k.toLowerCase()]=v;}
 return {headers,cookies};
}
export async function oxylabsRequest(input,proxy,profile){
 return new Promise((resolve,reject)=>{
  const child=spawn(process.env.GATEWAY_PYTHON??'python3',[new URL('./proxy_http.py',import.meta.url).pathname],{stdio:['pipe','pipe','ignore']});
  let output=[],size=0,done=false;
  const timer=setTimeout(()=>{child.kill('SIGKILL');finish(new GatewayError('proxy_connect_failed',502));},35000);
  function finish(error,result){if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(result);}
  child.stdout.on('data',b=>{size+=b.length;if(size>profile.maxResponseBytes*1.4+65536){child.kill('SIGKILL');finish(new GatewayError('response_too_large',502));}else output.push(b);});
  child.on('error',()=>finish(new GatewayError('transport_unavailable',503)));
  child.on('close',()=>{
   if(!size){finish(new GatewayError('transport_unavailable',503));return;}
   try{
    const r=JSON.parse(Buffer.concat(output)),errors=new Set(['proxy_connect_failed','tls_verification_failed','transport_unavailable','transport_request_invalid','transport_failed','source_body_incomplete','response_too_large','transport_outcome_unknown']);
    if(!r||typeof r!=='object'||(r.error&&!errors.has(r.error))||(!r.error&&(!Number.isInteger(r.status)||r.status<100||r.status>599)))throw Error();
    const pairs=r.headers??[],encoded=r.body_base64??'';
    if(!Array.isArray(pairs)||pairs.some(p=>!Array.isArray(p)||p.length!==2||p.some(v=>typeof v!=='string'))||typeof encoded!=='string')throw Error();
    const body=Buffer.from(encoded,'base64'),receivedBytes=r.received_bytes??body.length;
    if(body.toString('base64')!==encoded||!Number.isSafeInteger(receivedBytes)||receivedBytes<body.length)throw Error();
    finish(null,{status:r.status??null,providerStatus:null,...sourceHeaders(pairs),body,receivedBytes,error:r.error??null});
   }catch{finish(new GatewayError('transport_protocol_error',502));}
  });
  child.stdin.on('error',()=>{});
  child.stdin.end(JSON.stringify({method:input.method,url:input.url,headers:input.headers,body:input.body?.toString('base64'),proxy:proxy.url,metered:profile.routingPolicy==='residential-v1',timeout:30,maxBytes:profile.maxResponseBytes}));
 });
}
// The Amazon ZIP plugin appends th=1 to both attestation URLs. Accept only
// that observed display parameter; every product path and other query value
// must still match the requested URL. Other provider routes stay exact.
export function attestedSourceURL(reported,input,profile){
 if(reported===input.url)return true;
 if(!profile.amazonZipPlugin||!input.main_document||input.method!=='GET'||typeof reported!=='string')return false;
 try{
  const expected=new URL(input.url),actual=new URL(reported);
  if(expected.origin!=='https://www.amazon.in'||!/^\/dp\/[A-Z0-9]{10}\/?$/.test(expected.pathname)
    ||expected.searchParams.has('th')||actual.searchParams.getAll('th').length!==1
    ||actual.searchParams.get('th')!=='1')return false;
  // Remove the appended literal without reserializing unrelated query bytes.
  const parts=actual.search.slice(1).split('&');
  const index=parts.indexOf('th=1');if(index<0)return false;
  parts.splice(index,1);actual.search=parts.length?'?'+parts.join('&'):'';
  return actual.href===expected.href;
 }catch{return false;}
}
export async function scrapeDoRequest(input,session,profile,token){
 const plugin=profile.amazonZipPlugin&&input.main_document;
 const url=new URL(plugin?'https://api.scrape.do/plugin/amazon/':'https://api.scrape.do/');
 const flags={token,url:input.url,super:String(profile.fallbackSuper),render:'false',disableRetry:'true',disableRedirection:'true',transparentResponse:'true',pureCookies:'true',extraHeaders:'true',timeout:'30000',sessionId:String(session)};
 for(const [k,v]of Object.entries(flags))url.searchParams.set(k,v);
 if(plugin){if(!input.zipcode)fail('zipcode_required');url.searchParams.set('geocode','in');url.searchParams.set('zipcode',input.zipcode);}else url.searchParams.set('geoCode',profile.fallbackCountry);
 const h=Object.fromEntries(Object.entries(input.headers).map(([k,v])=>['sd-'+k,v]));
 let r;try{r=await fetch(url,{method:input.method,body:input.body??undefined,headers:h,redirect:'manual',signal:AbortSignal.timeout(35000)});}catch{throw new GatewayError('metered_outcome_unknown',502);}
 const costText=r.headers.get('scrape.do-request-cost');
 const parsedCost=costText!==null&&/^\d+$/.test(costText)?Number(costText):null;
 const credits=Number.isSafeInteger(parsedCost)&&parsedCost<=2147483647?parsedCost:null;
 const native=Number(r.headers.get('scrape.do-initial-status-code'));
 const attested=attestedSourceURL(r.headers.get('scrape.do-target-url'),input,profile)&&attestedSourceURL(r.headers.get('scrape.do-resolved-url'),input,profile)&&Number.isInteger(native)&&native>=100&&native<=599;
 const status=attested?native:null;
 const pairs=[...r.headers].filter(([k])=>k!=='set-cookie');
 for(const c of r.headers.getSetCookie())pairs.push(['set-cookie',c]);
 const output=sourceHeaders(pairs);
 const redirect=r.headers.get('scrape.do-target-redirected-location');if(redirect)output.headers.location=redirect;
 const data=[];let size=0;
 try{if(r.body)for await(const part of r.body){size+=part.length;if(size>profile.maxResponseBytes){await r.body.cancel().catch(()=>{});return {...output,status,providerStatus:r.status,credits,body:Buffer.alloc(0),receivedBytes:size,error:'response_too_large'};}data.push(part);}}
 catch{return {...output,status,providerStatus:r.status,credits,body:Buffer.alloc(0),receivedBytes:size,error:'provider_body_incomplete'};}
 return {...output,status,providerStatus:r.status,credits,body:Buffer.concat(data),receivedBytes:size,error:!attested&&[401,402,407].includes(r.status)?'provider_account_rejected':!attested?'provider_unattested':credits===null?'metered_outcome_unknown':null};
}
