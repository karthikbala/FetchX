// Camoufox runs in native private browsing, which removes service workers
// entirely; their script and fetch traffic would otherwise bypass Juggler
// routing. Juggler's cookie APIs (storageState/addCookies/cookies) ignore
// privateBrowsingId and address the wrong jar, so FetchX keeps workflow cookies
// itself: it replays saved cookies through a locally fulfilled response and
// records Set-Cookie headers plus script cookies. No source traffic is used.
import {Cookie,CookieJar} from 'tough-cookie';
import {fail} from './policy.mjs';

export const CAMOUFOX_STATE_PATH='/__fetchx_state';
const MAX_COOKIES=3000;
const sameSite={strict:'Strict',lax:'Lax',none:'None'};
const domainMatch=(host,domain)=>host===domain||host.endsWith('.'+domain);

// The reviewed host that should receive a saved cookie, or null when none does.
export function cookieHost(cookie,hosts){
 if(!cookie||typeof cookie.domain!=='string'||typeof cookie.name!=='string')return null;
 const domain=cookie.domain.replace(/^\./,'').toLowerCase();
 if(!cookie.domain.startsWith('.'))return hosts.includes(domain)?domain:null;
 return hosts.find(host=>domainMatch(host,domain))??null;
}
export function setCookieLine(c){
 if(/[;\r\n]/.test(`${c.name}${c.value}${c.path??''}${c.domain}`)||!c.name)return null;
 const parts=[`${c.name}=${c.value??''}`,`Path=${c.path||'/'}`];
 if(c.domain.startsWith('.'))parts.push(`Domain=${c.domain.slice(1)}`);
 if(Number.isFinite(c.expires)&&c.expires>=0){if(c.expires*1000<=Date.now())return null;parts.push(`Expires=${new Date(c.expires*1000).toUTCString()}`);}
 if(c.secure)parts.push('Secure');
 if(c.httpOnly)parts.push('HttpOnly');
 if(c.sameSite==='Strict'||c.sameSite==='Lax'||c.sameSite==='None'&&c.secure)parts.push(`SameSite=${c.sameSite}`);
 return parts.join('; ');
}
function exportCookie(c){
 const expiry=c.expiryTime();
 return {name:c.key,value:c.value,domain:(c.hostOnly?'':'.')+c.domain,path:c.path??'/',expires:Number.isFinite(expiry)?Math.floor(expiry/1000):-1,httpOnly:!!c.httpOnly,secure:!!c.secure,sameSite:sameSite[c.sameSite]??'Lax'};
}

// Opens the engine-state page on the target host (and on each host owning a
// saved cookie), checks native service-worker exclusion, and replays cookies.
// Call after installBrowserRestrictions so this narrower route takes precedence.
export async function prepareCamoufoxContext(context,{url,cookies=[],profile}){
 if(!Array.isArray(cookies)||cookies.length>MAX_COOKIES)fail('browser_cookie_state_invalid',502);
 const target=new URL(url).hostname,groups=new Map([[target,[]]]),jar=new CookieJar();
 for(const cookie of cookies){
  const host=cookieHost(cookie,profile.hosts),line=host&&setCookieLine(cookie);if(!line)continue;
  if(!groups.has(host))groups.set(host,[]);groups.get(host).push(line);
  try{jar.setCookieSync(line,`https://${host}${cookie.path||'/'}`);}catch{}
 }
 const matcher=u=>u.protocol==='https:'&&u.pathname===CAMOUFOX_STATE_PATH&&groups.has(u.hostname);
 const handler=route=>{const lines=groups.get(new URL(route.request().url()).hostname)??[];return route.fulfill({status:200,headers:{'content-type':'text/html','cache-control':'no-store',...(lines.length?{'set-cookie':lines.join('\n')}:{})},body:'<!doctype html><title>state</title>'});};
 await context.route(matcher,handler);
 const page=await context.newPage();
 try{
  for(const host of groups.keys()){
   await page.goto(`https://${host}${CAMOUFOX_STATE_PATH}`,{waitUntil:'load',timeout:10000});
   const engine=await page.evaluate(()=>({secure:window.isSecureContext,serviceWorker:'serviceWorker' in navigator}));
   // Private browsing must be in force: a secure page with no service-worker API.
   if(!engine.secure||engine.serviceWorker)fail('browser_runtime_unqualified',503);
  }
 }finally{await page.close().catch(()=>{});await context.unroute(matcher,handler).catch(()=>{});}
 return cookieRecorder(context,jar,profile);
}

export function cookieRecorder(context,jar,profile){
 const onResponse=async response=>{
  let header;try{header=await response.headerValue('set-cookie');}catch{return;}
  if(!header)return;
  let url;try{url=new URL(response.url());}catch{return;}
  if(url.protocol!=='https:'||!profile.hosts.includes(url.hostname))return;
  for(const line of header.split('\n'))try{jar.setCookieSync(line,url.href);}catch{}
 };
 context.on('response',onResponse);
 return {
  jar,
  // Script cookies have no response header; reconcile them from each reviewed
  // frame. Their attributes are unknown, so they are kept as host-only, path /.
  async capture(page){
   for(const frame of page?.frames()??[]){
    let url;try{url=new URL(frame.url());}catch{continue;}
    if(url.protocol!=='https:'||!profile.hosts.includes(url.hostname))continue;
    let documentCookie;try{documentCookie=await frame.evaluate(()=>document.cookie);}catch{continue;}
    const visible=new Map(String(documentCookie).split(/;\s*/).filter(Boolean).map(pair=>{const i=pair.indexOf('=');return i<0?['',pair]:[pair.slice(0,i),pair.slice(i+1)];}));
    for(const cookie of jar.getCookiesSync(url.href,{http:false}))if(!visible.has(cookie.key))await jar.store.removeCookie(cookie.domain,cookie.path,cookie.key);
    const known=new Map(jar.getCookiesSync(url.href,{http:false}).map(c=>[c.key,c]));
    for(const [name,value] of visible){
     const existing=known.get(name);
     if(existing){if(existing.value!==value){const updated=existing.clone();updated.value=value;await jar.store.updateCookie(existing,updated);}continue;}
     try{jar.setCookieSync(new Cookie({key:name,value,path:'/',domain:url.hostname,hostOnly:true,secure:true}),url.href);}catch{}
    }
   }
  },
  cookies(){return jar.serializeSync().cookies.map(c=>Cookie.fromJSON(c)).filter(c=>c&&cookieHost(exportCookie(c),profile.hosts)).slice(0,MAX_COOKIES).map(exportCookie);},
  stop(){context.off('response',onResponse);}
 };
}
