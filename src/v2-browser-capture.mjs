import {sha} from './crypto.mjs';
import {GatewayError} from './policy.mjs';
import {BROWSER_SCREENSHOT_MAX_BYTES} from './v2-browser-policy.mjs';

const REQUEST_TYPES=new Set(['document','script','stylesheet','image','font','xhr','fetch']);
const NETWORK_HOP_LIMIT=128,NETWORK_HOP_WAIT_MS=250;
const BLOCK_REASONS=new Set(['method_rejected','resource_type_blocked','browser_request_limit','frame_blocked','capture_window_closed','destination_rejected','endpoint_rejected','endpoint_method_rejected','headers_rejected','credential_scope_rejected','source_cooldown','source_pacing_deadline','session_expired','redirect_limit','redirect_origin_rejected','dns_deadline']);
const safeBrowserError=error=>/net::(ERR_[A-Z_]+)/.exec(error?.message??'')?.[1]??(error?.name==='TimeoutError'?'browser_probe_deadline':'browser_probe_capture_failed');
const redirectResponse=(status,location)=>[301,302,303,307,308].includes(status)&&!!location;
const remaining=input=>Math.max(1,input.deadline-Date.now());
const key=(method,url)=>JSON.stringify([method,url]);
function artifactBase(kind,url,method,status,headers){return {kind,url,method,status,headers,raw_headers:null,captured_at:new Date().toISOString(),content_encoding:null,decoded_body_base64:null,decoded_sha256:null,decoded_bytes:null,encoded_body_base64:null,encoded_sha256:null,original_encoded_available:false,encoded_bytes:null,encoded_size_basis:null,tunnel_bytes:null,provider_status:null,decoding_error:null};}
function bodyEvidence(body){return {decoded_body_base64:body?.toString('base64')??null,decoded_sha256:body?sha(body):null,decoded_bytes:body?.length??null};}

// The trusted fixture dispatch hook uses this subset of Playwright's Route
// API. Production always continues the original, paused Chromium request.
function fixtureRoute(send,requestId){
 return {
  fulfill({status=200,contentType,headers={},body=''}) {
   const responseHeaders=Object.entries(headers).map(([name,value])=>({name,value}));
   if(contentType)responseHeaders.push({name:'content-type',value:contentType});
   return send('Fetch.fulfillRequest',{requestId,responseCode:status,responseHeaders,body:Buffer.from(body).toString('base64')});
  },
  abort(){return send('Fetch.failRequest',{requestId,errorReason:'BlockedByClient'});}
 };
}

// Fetch pauses before dispatch on each hop. Playwright route.continue() skips
// redirect admission. Playwright remains responsible for navigation and capture.
export async function captureBrowserProbe(browser,input,policy,hooks){
 let context,page,root,cdp,mainResponse=null,stopped=false,decoded=0,encoded=0,encodedComplete=true,domBytes=0,screenshotBytes=0,blocked=0,admitted=0,admitting=0,error=null;
 const blockedReasons={},pending=new Set(),accepted=new Map(),redirects=new Map(),networkHops=new Map(),networkParents=new Map(),networkWaiters=new Map();
 const block=reason=>{blocked++;blockedReasons[reason]=(blockedReasons[reason]??0)+1;};
 const track=promise=>{const task=promise.catch(()=>{error??='browser_probe_artifact_unknown';});pending.add(task);task.finally(()=>pending.delete(task)).catch(()=>{});};
 function takeAccepted(request){
  const k=key(request.method(),request.url()),queue=accepted.get(k);
  const metadata=queue?.shift();
  if(queue?.length===0)accepted.delete(k);
  return metadata;
 }
 async function takeNetworkHop(id){
  if(!id||networkWaiters.has(id))return null;
  if(!networkHops.has(id)){
   if(networkWaiters.size>=NETWORK_HOP_LIMIT)return null;
   // Network and Fetch can deliver the matching events in either order.
   let timer;
   try{
    await new Promise(resolve=>{
     networkWaiters.set(id,resolve);
     timer=setTimeout(resolve,Math.min(NETWORK_HOP_WAIT_MS,remaining(input)));
    });
   }finally{clearTimeout(timer);networkWaiters.delete(id);}
  }
  const hop=networkHops.get(id);
  networkHops.delete(id);
  return hop;
 }
 try{
  context=await browser.newContext({serviceWorkers:'block',acceptDownloads:false,ignoreHTTPSErrors:false,permissions:[],viewport:{width:1280,height:720},deviceScaleFactor:1});
  if(input.cookies?.length)await context.addCookies(input.cookies);
  page=await context.newPage();
  context.on('page',candidate=>{if(candidate!==page)candidate.close().catch(()=>{});});
  page.on('dialog',dialog=>dialog.dismiss().catch(()=>{}));
  page.on('download',download=>{block('download_blocked');download.cancel().catch(()=>{});});
  cdp=await context.newCDPSession(page);root=await browser.newBrowserCDPSession();
  const send=(method,params)=>cdp.send(method,params);
  const [{targetInfo},{frameTree}]=await Promise.all([send('Target.getTargetInfo'),send('Page.getFrameTree')]);
  const mainFrameId=frameTree.frame.id;
  // Close independently scheduled targets on attachment, before resuming
  // their debugger. Main-target requests still need an allowed frame/type.
  const closeTarget=({targetInfo:target})=>{
   if(target.targetId===targetInfo.targetId||target.browserContextId!==targetInfo.browserContextId)return;
   block(target.type==='page'?'popup_blocked':'secondary_target_blocked');
   root.send('Target.closeTarget',{targetId:target.targetId}).catch(()=>{});
  };
  root.on('Target.attachedToTarget',closeTarget);
  cdp.on('Target.attachedToTarget',closeTarget);
  await root.send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:true,flatten:true,filter:[{type:'page'},{type:'shared_worker'},{type:'service_worker'}]});
  await send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:true,flatten:true});
  cdp.on('Page.windowOpen',()=>block('popup_blocked'));
  cdp.on('Network.webSocketCreated',()=>block('websocket_blocked'));
  // Chromium can create a new Fetch interception job on a cross-origin
  // redirect without a redirectedRequestId. Network preserves the request
  // id and previous response across that boundary.
  cdp.on('Network.requestWillBeSent',({requestId,request,frameId,redirectResponse})=>{
   if(frameId!==mainFrameId||!/^https?:/.test(request.url))return;
   networkHops.delete(requestId);
   networkHops.set(requestId,{url:request.url,method:request.method,from:redirectResponse?.url??null});
   if(networkHops.size>NETWORK_HOP_LIMIT)networkHops.delete(networkHops.keys().next().value);
   networkWaiters.get(requestId)?.();
  });
  cdp.on('Fetch.authRequired',({requestId})=>track(send('Fetch.continueWithAuth',{requestId,authChallengeResponse:{response:'CancelAuth'}})));
  cdp.on('Fetch.requestPaused',event=>track((async()=>{
   const {requestId,networkId,request,frameId,redirectedRequestId,responseStatusCode,responseErrorReason,responseHeaders=[]}=event;
   const resourceType=event.resourceType.toLowerCase();
   try{
    if(responseStatusCode!==undefined||responseErrorReason!==undefined){
     const retryAfter=responseHeaders.find(h=>h.name.toLowerCase()==='retry-after')?.value;
     if(responseStatusCode===429||retryAfter)await hooks.cooldown?.({url:request.url,status:responseStatusCode,retry_after:retryAfter});
     await send('Fetch.continueResponse',{requestId});
     return;
    }
    if(stopped||Date.now()>=input.deadline)throw new GatewayError('capture_window_closed');
    if(frameId!==mainFrameId)throw new GatewayError('frame_blocked');
    if(!['GET','HEAD'].includes(request.method)||request.hasPostData||request.postData)throw new GatewayError('method_rejected');
    if(!REQUEST_TYPES.has(resourceType))throw new GatewayError('resource_type_blocked');
    if(admitted+admitting>=policy.max_requests)throw new GatewayError('browser_request_limit');
    const hop=await takeNetworkHop(networkId);
    if(!hop||hop.url!==request.url||hop.method!==request.method)throw new GatewayError('redirect_limit');
    if(stopped||Date.now()>=input.deadline)throw new GatewayError('capture_window_closed');
    if(admitted+admitting>=policy.max_requests)throw new GatewayError('browser_request_limit');
    const prior=networkParents.get(networkId);
    if((hop.from??null)!==(prior?.url??null)||(redirectedRequestId&&redirects.get(redirectedRequestId)!==prior))throw new GatewayError('redirect_limit');
    const depth=prior?prior.depth+1:0;
    const requestMetadata={url:request.url,method:request.method,headers:request.headers,body_base64:null,resource_type:resourceType};
    admitting++;
    try{await hooks.admit({...requestMetadata,redirect_depth:depth,redirected_from:prior?.url??null});admitted++;}finally{admitting--;}
    if(stopped||Date.now()>=input.deadline)throw new GatewayError('capture_window_closed');
    const parent={url:request.url,depth};
    redirects.set(requestId,parent);
    networkParents.set(networkId,parent);
    const k=key(request.method,request.url);
    const queue=accepted.get(k)??[];queue.push(requestMetadata);accepted.set(k,queue);
    if(hooks.dispatch)await hooks.dispatch(fixtureRoute(send,requestId),requestMetadata);
    else await send('Fetch.continueRequest',{requestId,interceptResponse:true});
   }catch(e){
    const reason=BLOCK_REASONS.has(e.code)?e.code:'request_policy_rejected';
    if(responseStatusCode!==undefined||responseErrorReason!==undefined)error??='browser_probe_response_callback_unknown';
    else if(resourceType==='document'&&frameId===mainFrameId)error??=reason;
    block(reason);
    await send('Fetch.failRequest',{requestId,errorReason:'BlockedByClient'}).catch(()=>{});
   }
  })()));
  await Promise.all([
   send('Page.enable'),
   send('Network.enable'),
   send('Network.setCacheDisabled',{cacheDisabled:true}),
   // HTTP/1.1 plus Connection: close prevents the reused-connection error
   // replay path in Chromium's network transaction layer.
   send('Network.setExtraHTTPHeaders',{headers:{Connection:'close'}}),
   send('Network.setBypassServiceWorker',{bypass:true}),
   send('Fetch.enable',{handleAuthRequests:true,patterns:[{urlPattern:'*',requestStage:'Request'}]})
  ]);
  page.on('response',response=>{
   const request=response.request(),admittedMetadata=takeAccepted(request);if(!admittedMetadata)return;
   const mainDocument=request.isNavigationRequest()&&request.frame()===page.mainFrame()&&!redirectResponse(response.status(),response.headers().location);
   if(mainDocument)mainResponse={status:response.status(),url:response.url()};
   track((async()=>{
    let body=null,headers={},rawHeaders=null,size=null,decodingError=null;
    try{
     headers=await response.allHeaders();
     rawHeaders=(await response.headersArray()).flatMap(({name,value})=>[name,value]);
     const redirect=redirectResponse(response.status(),headers.location);
     if(!redirect){
      await response.finished();
      try{const value=(await request.sizes()).responseBodySize;if(Number.isSafeInteger(value)&&value>=0)size=value;}catch{}
      const received=request.method()==='HEAD'||[204,304].includes(response.status())?Buffer.alloc(0):await response.body();
      if(decoded+received.length>policy.max_decoded_bytes)throw new GatewayError('browser_decoded_byte_limit');
      decoded+=received.length;body=received;
     }
    }catch(e){decodingError=e.code==='browser_decoded_byte_limit'?e.code:'browser_body_unavailable';error??=decodingError;}
    if(size===null)encodedComplete=false;else encoded+=size;
    const headersAtAdmission=Object.fromEntries(Object.entries(admittedMetadata.headers).map(([name,value])=>[name.toLowerCase(),value]));
    const requestMetadata={...admittedMetadata,headers:{...(hooks.dispatch?headersAtAdmission:{}),...await request.allHeaders()}};
    await hooks.artifact({...artifactBase('browser_response',requestMetadata.url,requestMetadata.method,response.status(),headers),request:requestMetadata,raw_headers:rawHeaders,main_document:mainDocument,content_encoding:headers['content-encoding']??'identity',...bodyEvidence(body),encoded_bytes:size,encoded_size_basis:size===null?null:'playwright_request_sizes',decoding_error:decodingError});
   })());
  });
  page.on('requestfailed',request=>{
   if(request.failure()?.errorText==='net::ERR_BLOCKED_BY_CLIENT'||!takeAccepted(request))return;
   encodedComplete=false;
   const certificateError=/^net::(ERR_CERT_[A-Z_]+)$/.exec(request.failure()?.errorText??'')?.[1];
   error??=certificateError??'browser_request_incomplete';
  });
  try{await page.goto(input.url,{waitUntil:'domcontentloaded',timeout:Math.min(input.timeout_ms,remaining(input))});}catch(e){error??=safeBrowserError(e);}
  if(!page.isClosed()&&policy.settle_ms)await page.waitForTimeout(Math.min(policy.settle_ms,remaining(input)));
  stopped=true;
  let timer;
  try{await Promise.race([Promise.allSettled([...pending]),new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new GatewayError('browser_request_incomplete')),remaining(input));})]);}catch{error??='browser_request_incomplete';}finally{clearTimeout(timer);}
  if(!page.isClosed()&&mainResponse&&page.url()===mainResponse.url&&Date.now()<input.deadline){
   const body=Buffer.from(await page.content());
   if(body.length>policy.max_dom_bytes)error??='browser_dom_byte_limit';
   else{await hooks.artifact({...artifactBase('rendered_dom',page.url(),'GET',mainResponse.status,{'content-type':'text/html; charset=utf-8'}),generated:true,...bodyEvidence(body)});domBytes=body.length;}
   if(input.screenshot){
    try{
     const screenshot=await page.screenshot({type:'jpeg',quality:75,timeout:remaining(input)});
     if(screenshot.length>BROWSER_SCREENSHOT_MAX_BYTES)throw new GatewayError('browser_screenshot_byte_limit');
     await hooks.artifact({...artifactBase('browser_screenshot',page.url(),'GET',mainResponse.status,{'content-type':'image/jpeg'}),generated:true,...bodyEvidence(screenshot)});
     screenshotBytes=screenshot.length;
    }catch(e){error??=e.code==='browser_screenshot_byte_limit'?e.code:'browser_screenshot_unavailable';}
   }
  }
  const cookies=await context.cookies();
  return {status:mainResponse?.status??null,final_url:mainResponse?.url??null,physical_requests:admitted,blocked_requests:blocked,blocked_reasons:blockedReasons,counts_complete:true,capture_complete:!!domBytes&&!error&&blocked===0&&pending.size===0&&accepted.size===0,encoded_bytes:encodedComplete?encoded:null,decoded_bytes:decoded,dom_bytes:domBytes,screenshot_bytes:screenshotBytes,error,cookies};
 }finally{
  stopped=true;
  for(const resolve of networkWaiters.values())resolve();
  await context?.close().catch(()=>{});
  await root?.detach().catch(()=>{});
 }
}
