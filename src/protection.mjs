// Passive observations only. This module cannot dispatch, solve a challenge,
// select a proxy, change acceptance, or grant a retry/fallback allowance.
export const PROTECTION_VERSION='1.0.1';
export const PROTECTION_VENDORS=Object.freeze(['cloudflare','datadome','aws_waf','human','amazon','unknown']);
export const PROTECTION_KINDS=Object.freeze(['challenge','rate_limited','access_denied','authentication_required','source_unavailable','upstream_error','transport_failure','provider_failure','no_block_observed','unknown']);
const confidences=['explicit','corroborated','indicative','unknown'];
const layers=['source','provider','transport','unknown'];
const widgets=['turnstile','recaptcha','hcaptcha'];
export const PROTECTION_PLAYBOOKS=Object.freeze(['inspect_transport','inspect_provider','honor_source_cooldown','check_authentication','inspect_denial','check_source_availability','inspect_upstream','inspect_challenge_dependencies','preserve_session_identity','qualify_browser_engine','inspect_source_evidence']);
const signals=Object.freeze(['cf_edge','cf_cookie','cf_mitigated','cf_interstitial','dd_cookie','dd_tag','dd_response_frame','aws_challenge','aws_captcha','human_cookie','human_challenge','amazon_captcha','security_title','turnstile_widget','recaptcha_widget','hcaptcha_widget','status_429','status_401','status_403','status_404_410','status_5xx','provider_error','transport_error']);
const limit=65536;
const bounded=value=>typeof value==='string'?value.slice(0,8192):'';
const hostIs=(host,domain)=>host===domain||host.endsWith('.'+domain);

function sourceMarkup(body){
 // Avoid treating documentation examples and comments as executable markup.
 return body.replace(/<!--[\s\S]*?(?:-->|$)/g,'').replace(/<(pre|code|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'');
}
function resources(html){
 const found=[];
 for(const match of html.matchAll(/<(script|iframe|form)\b([^>]{0,8192})>/gi)){
  const attribute=match[1].toLowerCase()==='form'?'action':'src';
  const value=new RegExp('(?:^|\\s)'+attribute+'\\s*=\\s*(?:"([^"\\r\\n]*)"|\'([^\'\\r\\n]*)\'|([^\\s>]+))','i').exec(match[2]);
  if(!value)continue;
  try{
   const url=new URL(value[1]??value[2]??value[3],'https://relative.invalid');
   if(!['https:','http:'].includes(url.protocol))continue;
   found.push({tag:match[1].toLowerCase(),host:url.hostname,path:url.pathname});
  }catch{/* Unparseable source markup is not a diagnostic failure. */}
 }
 return found;
}

export function classifyProtection(response={},input={}){
 const result={version:PROTECTION_VERSION,layer:'unknown',kind:'unknown',vendor:'unknown',confidence:'unknown',presence:[],widgets:[],signals:[],body_bytes:0,truncated:false,playbooks:[]};
 const add=signal=>{if(!result.signals.includes(signal))result.signals.push(signal);};
 const present=(vendor,confidence,signal)=>{
  add(signal);const old=result.presence.find(item=>item.vendor===vendor);
  if(!old)result.presence.push({vendor,confidence});
  else if(confidences.indexOf(confidence)<confidences.indexOf(old.confidence))old.confidence=confidence;
 };
 const finish=(layer,kind,vendor='unknown',confidence='unknown',playbooks=[])=>Object.assign(result,{layer,kind,vendor,confidence,playbooks});
 // A provider-generated/unattested response must not fingerprint the source.
 if(['provider_unattested','provider_account_rejected','provider_body_incomplete','sensitive_provider_response','cost_overrun'].includes(response.error)){
  add('provider_error');return finish('provider','provider_failure','unknown','explicit',['inspect_provider']);
 }
 const status=Number.isInteger(response.status)?response.status:null;
 if(status===null){
  if(response.error){add('transport_error');return finish('transport','transport_failure','unknown','indicative',['inspect_transport']);}
  return result;
 }
 const headers=new Map(),headerCookies=[];
 for(const [key,value] of Object.entries(response.headers??{}).slice(0,256)){
  headers.set(key.toLowerCase(),bounded(value));
  if(key.toLowerCase()==='set-cookie')headerCookies.push(...(Array.isArray(value)?value.slice(0,128):[value]));
 }
 const cookies=[...(Array.isArray(response.cookies)?response.cookies.slice(0,128):[]),...headerCookies]
  .map(cookie=>/^\s*([^=;\s]{1,128})=/.exec(bounded(cookie))?.[1]).filter(Boolean);
 if(headers.get('server')?.toLowerCase()==='cloudflare'||headers.has('cf-ray'))present('cloudflare','indicative','cf_edge');
 if(cookies.some(name=>['__cf_bm','cf_clearance'].includes(name)))present('cloudflare','indicative','cf_cookie');
 if(cookies.includes('datadome'))present('datadome','indicative','dd_cookie');
 if(cookies.some(name=>['_px','_px2','_px3','_pxvid','_pxhd'].includes(name)))present('human','indicative','human_cookie');
 const inspect=(input.main_document===true||['document','xhr','fetch'].includes(input.resource_type))&&/\b(?:text\/html|application\/xhtml\+xml)\b/i.test(headers.get('content-type')??'');
 let html='';
 if(inspect){
  if(Buffer.isBuffer(response.body)){
   result.body_bytes=Math.min(response.body.length,limit);result.truncated=response.body.length>limit;
   html=response.body.subarray(0,limit).toString('utf8');
  }else if(typeof response.body==='string'){
   const prefix=Buffer.from(response.body.slice(0,limit));
   result.body_bytes=Math.min(prefix.length,limit);result.truncated=response.body.length>limit||prefix.length>limit;
   html=prefix.subarray(0,limit).toString('utf8');
  }
 }
 html=sourceMarkup(html);
 const tags=resources(html);
 const title=/<title\b[^>]*>([^<]{0,300})<\/title\s*>/i.exec(html)?.[1]?.trim()??'';
 const securityTitle=/^(?:just a moment\.{0,3}|security check(?:\s*[|–-].*)?|robot check|verify (?:that )?you are (?:a )?human)$/i.test(title);
 if(securityTitle)add('security_title');
 const challengeCandidates=[];
 const challenge=(vendor,confidence,signal)=>{present(vendor,confidence,signal);challengeCandidates.push({vendor,confidence});};
 if(headers.get('cf-mitigated')?.trim().toLowerCase()==='challenge')challenge('cloudflare','explicit','cf_mitigated');
 const inlineCloudflare=/\b(?:window\.)?_cf_chl_opt\s*=/.test(html)&&/\.src\s*=\s*["']\/cdn-cgi\/challenge-platform\//.test(html);
 if(securityTitle&&(inlineCloudflare||tags.some(tag=>tag.tag==='script'&&tag.path.startsWith('/cdn-cgi/challenge-platform/'))))challenge('cloudflare','corroborated','cf_interstitial');
 if(tags.some(tag=>tag.tag==='script'&&hostIs(tag.host,'datadome.co')))present('datadome','indicative','dd_tag');
 if(tags.some(tag=>tag.tag==='iframe'&&hostIs(tag.host,'captcha-delivery.com'))&&(status===403||securityTitle))challenge('datadome','corroborated','dd_response_frame');
 const aws=headers.get('x-amzn-waf-action')?.trim().toLowerCase();
 if(aws==='challenge')challenge('aws_waf','explicit','aws_challenge');
 if(aws==='captcha')challenge('aws_waf','explicit','aws_captcha');
 if(tags.some(tag=>hostIs(tag.host,'px-cdn.net')&&tag.host.startsWith('captcha.'))&&(status===403||securityTitle))challenge('human','corroborated','human_challenge');
 // A site-specific form is only attributed to Amazon on an Amazon source.
 let sourceHost='';try{sourceHost=new URL(input.url).hostname;}catch{}
 if(/^(?:www\.)?amazon\.(?:com|in|co\.uk|de|fr|co\.jp)$/.test(sourceHost)&&tags.some(tag=>tag.tag==='form'&&tag.path==='/errors/validateCaptcha'))challenge('amazon','corroborated','amazon_captcha');
 for(const [name,matches] of [
  ['turnstile',tags.some(tag=>tag.tag==='script'&&tag.host==='challenges.cloudflare.com'&&tag.path.startsWith('/turnstile/'))],
  ['recaptcha',tags.some(tag=>tag.tag==='script'&&(hostIs(tag.host,'google.com')||hostIs(tag.host,'recaptcha.net'))&&tag.path.startsWith('/recaptcha/'))],
  ['hcaptcha',tags.some(tag=>tag.tag==='script'&&hostIs(tag.host,'hcaptcha.com'))],
 ])if(matches){result.widgets.push(name);add(name+'_widget');}
 // A widget or cookie may be present on a fully accessible/login page. Neither
 // establishes a blocked response, an IP ban, or the root cause of a challenge.
 if(status===429){add('status_429');return finish('source','rate_limited','unknown','explicit',['honor_source_cooldown']);}
 if(status===401){add('status_401');return finish('source','authentication_required','unknown','explicit',['check_authentication']);}
 const strongest=new Map();
 for(const candidate of challengeCandidates){
  const old=strongest.get(candidate.vendor);
  if(!old||confidences.indexOf(candidate.confidence)<confidences.indexOf(old.confidence))strongest.set(candidate.vendor,candidate);
 }
 const unique=[...strongest.values()];
 if(unique.length||securityTitle){
  const single=unique.length===1?unique[0]:null;
  return finish('source','challenge',single?.vendor??'unknown',single?.confidence??'indicative',['inspect_challenge_dependencies','preserve_session_identity','qualify_browser_engine']);
 }
 if(status===403){add('status_403');return finish('source','access_denied','unknown','explicit',['inspect_denial']);}
 if([404,410].includes(status)){add('status_404_410');return finish('source','source_unavailable','unknown','explicit',['check_source_availability']);}
 if(status>=500){add('status_5xx');return finish('source','upstream_error','unknown','explicit',['inspect_upstream']);}
 if(status>=200&&status<400)return finish('source','no_block_observed');
 return finish('source','unknown','unknown','unknown',['inspect_source_evidence']);
}

// Database rows remain untrusted at the diagnostics boundary. Only closed
// vocabulary and bounded measurements are public; no response values survive.
export function protectionView(value){
 if(!value||value.version!==PROTECTION_VERSION)return null;
 const array=(list,allowed)=>Array.isArray(list)?[...new Set(list.filter(item=>allowed.includes(item)))].slice(0,64):[];
 return {
  version:PROTECTION_VERSION,layer:layers.includes(value.layer)?value.layer:'unknown',
  kind:PROTECTION_KINDS.includes(value.kind)?value.kind:'unknown',vendor:PROTECTION_VENDORS.includes(value.vendor)?value.vendor:'unknown',
  confidence:confidences.includes(value.confidence)?value.confidence:'unknown',
  presence:Array.isArray(value.presence)?value.presence.filter(item=>item&&PROTECTION_VENDORS.includes(item.vendor)&&confidences.includes(item.confidence)).slice(0,8).map(({vendor,confidence})=>({vendor,confidence})):[],
  widgets:array(value.widgets,widgets),signals:array(value.signals,signals),playbooks:array(value.playbooks,PROTECTION_PLAYBOOKS),
  body_bytes:Number.isInteger(value.body_bytes)&&value.body_bytes>=0&&value.body_bytes<=limit?value.body_bytes:0,truncated:value.truncated===true,
 };
}

export async function observeProtection(store,{attemptId,response,input}){
 try{
  const observation=protectionView(classifyProtection(response,input));
  await store.tx(async client=>{
   await client.query("SET LOCAL lock_timeout='100ms'");
   await client.query("SET LOCAL statement_timeout='250ms'");
   await client.query('UPDATE attempts SET protection=$2 WHERE id=$1 AND protection IS NULL',[attemptId,observation]);
  });
  return observation;
 }catch{
  process.stderr.write(JSON.stringify({event:'protection_observation_failed',attempt:attemptId})+'\n');
  return null;
 }
}
