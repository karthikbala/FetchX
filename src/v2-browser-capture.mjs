import {sha} from './crypto.mjs';
import {GatewayError} from './policy.mjs';

const REQUEST_TYPES=new Set(['document','script','stylesheet','xhr','fetch','other']);
const safeBrowserError=error=>/net::(ERR_[A-Z_]+)/.exec(error?.message??'')?.[1]??(error?.name==='TimeoutError'?'browser_probe_deadline':'browser_probe_capture_failed');
async function metadata(request){
 const body=request.postDataBuffer();
 return {url:request.url(),method:request.method(),headers:await request.allHeaders(),body_base64:body&&body.length<=65536?body.toString('base64'):null,resource_type:request.resourceType()};
}
function artifactBase(kind,url,method,status,headers){return {kind,url,method,status,headers,raw_headers:null,captured_at:new Date().toISOString(),content_encoding:null,decoded_body_base64:null,decoded_sha256:null,decoded_bytes:null,encoded_body_base64:null,encoded_sha256:null,original_encoded_available:false,encoded_bytes:null,encoded_size_basis:null,tunnel_bytes:null,provider_status:null,decoding_error:null};}

// The browser owns source JS execution; clients supply only a navigation URL.
// Hooks are trusted gateway functions/IPC, never caller code. No evaluate/CDP
// endpoint, actions, selectors, downloads or live leases are exposed.
export async function captureBrowserProbe(browser,input,policy,hooks){
 let context,page,mainResponse=null,stopped=false,decoded=0,encoded=0,encodedComplete=true,domBytes=0,blocked=0,admitted=0,error=null;
 const blockedReasons={},pending=new Set(),accepted=new Map();
 const block=reason=>{blocked++;blockedReasons[reason]=(blockedReasons[reason]??0)+1;};
 const track=promise=>{const task=promise.catch(()=>{error??='browser_probe_artifact_unknown';});pending.add(task);task.finally(()=>pending.delete(task)).catch(()=>{});};
 try{
  context=await browser.newContext({serviceWorkers:'block',acceptDownloads:false,ignoreHTTPSErrors:false,permissions:[]});
  if(input.cookies?.length)await context.addCookies(input.cookies);
  await context.routeWebSocket('**/*',socket=>{block('websocket_blocked');socket.close();});
  context.on('page',candidate=>{if(!page)page=candidate;else{block('popup_blocked');candidate.close().catch(()=>{});}});
  await context.route('**/*',async route=>{
   const request=route.request();
   try{
    if(stopped)throw new GatewayError('capture_window_closed');
    if(request.frame().page()!==page)throw new GatewayError('popup_blocked');
    if(!['GET','HEAD'].includes(request.method()))throw new GatewayError('method_rejected');
    if(!REQUEST_TYPES.has(request.resourceType()))throw new GatewayError('resource_type_blocked');
    if(admitted>=policy.max_requests)throw new GatewayError('browser_request_limit');
    const requestMetadata=await metadata(request);
    // Reserve a local slot before awaiting IPC so parallel routes cannot each
    // consume the final slot. The parent independently owns durable admission.
    admitted++;
    let depth=0,prior=request.redirectedFrom();for(let ancestor=prior;ancestor;ancestor=ancestor.redirectedFrom())depth++;
    try{await hooks.admit({...requestMetadata,redirect_depth:depth,redirected_from:prior?.url()??null});}catch(e){admitted--;throw e;}
    accepted.set(request,requestMetadata);
    if(hooks.dispatch)await hooks.dispatch(route,requestMetadata);else await route.continue();
   }catch(e){block(['method_rejected','resource_type_blocked','browser_request_limit','popup_blocked','capture_window_closed','destination_rejected','endpoint_method_rejected','headers_rejected','credential_scope_rejected','source_cooldown','session_expired'].includes(e.code)?e.code:'request_policy_rejected');await route.abort('blockedbyclient').catch(()=>{});}
  });
  context.on('response',response=>{
   const request=response.request(),requestMetadata=accepted.get(request);if(!requestMetadata)return;
   track((async()=>{
    let body=null,headers={},rawHeaders=null,size=null,decodingError=null;
    try{
     headers=await response.allHeaders();rawHeaders=(await response.headersArray()).flatMap(({name,value})=>[name,value]);
     if(request.isNavigationRequest()&&request.frame()===page.mainFrame())mainResponse={status:response.status(),url:response.url()};
     await response.finished();
     try{const value=(await request.sizes()).responseBodySize;if(Number.isSafeInteger(value)&&value>=0)size=value;}catch{}
     const received=await response.body();
     if(decoded+received.length>policy.max_decoded_bytes)throw new GatewayError('browser_decoded_byte_limit');
     decoded+=received.length;body=received;
    }catch(e){decodingError=e.code==='browser_decoded_byte_limit'?e.code:'browser_body_unavailable';error??=decodingError;}
    if(size===null)encodedComplete=false;else encoded+=size;
    const artifact={...artifactBase('browser_response',requestMetadata.url,requestMetadata.method,response.status(),headers),request:requestMetadata,raw_headers:rawHeaders,content_encoding:headers['content-encoding']??'identity',decoded_body_base64:body?.toString('base64')??null,decoded_sha256:body?sha(body):null,decoded_bytes:body?.length??null,encoded_bytes:size,encoded_size_basis:size===null?null:'playwright_request_sizes',decoding_error:decodingError};
    await hooks.artifact(artifact);
   })());
  });
  context.on('requestfailed',request=>{if(accepted.has(request)){encodedComplete=false;error??='browser_request_incomplete';}});
  page=await context.newPage();page.on('dialog',dialog=>dialog.dismiss().catch(()=>{}));page.on('download',download=>{block('download_blocked');download.cancel().catch(()=>{});});
  try{await page.goto(input.url,{waitUntil:'domcontentloaded',timeout:input.timeout_ms});}catch(e){error??=safeBrowserError(e);}
  if(!page.isClosed()&&policy.settle_ms)await page.waitForTimeout(Math.min(policy.settle_ms,Math.max(0,input.deadline-Date.now())));
  stopped=true;
  let timer;
  try{await Promise.race([Promise.allSettled([...pending]),new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new GatewayError('browser_request_incomplete')),Math.max(1,input.deadline-Date.now()));})]);}catch{error??='browser_request_incomplete';}finally{clearTimeout(timer);}
  if(!page.isClosed()){
   const body=Buffer.from(await page.content());if(body.length>policy.max_dom_bytes)error??='browser_dom_byte_limit';else{domBytes=body.length;await hooks.artifact({...artifactBase('rendered_dom',page.url(),'GET',mainResponse?.status??null,{'content-type':'text/html; charset=utf-8'}),generated:true,decoded_body_base64:body.toString('base64'),decoded_sha256:sha(body),decoded_bytes:body.length});}
  }
  const cookies=await context.cookies();
  return {status:mainResponse?.status??null,final_url:mainResponse?.url??null,physical_requests:admitted,blocked_requests:blocked,blocked_reasons:blockedReasons,counts_complete:true,capture_complete:!error&&blocked===0&&pending.size===0,encoded_bytes:encodedComplete?encoded:null,decoded_bytes:decoded,dom_bytes:domBytes,error,cookies};
 }finally{stopped=true;await context?.close().catch(()=>{});}
}
