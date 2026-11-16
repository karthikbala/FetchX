// Operator reachability probe. For one destination host it measures, per
// {provider, proxy class, country}, how far a minimal request gets:
// proxy CONNECT -> TLS -> one HTTP GET (body capped). It never runs a browser,
// sends no cookies or credentials to the source, and returns only metadata
// (statuses, stages, timings, byte counts) — no bodies, proxy URLs or secrets.
// The summary turns the matrix into generic routing facts: which countries can
// reach the host, which providers refuse it, whether datacenter IPs are
// blocked, and the cheapest route that worked. Its output is a proposal for an
// operator to review (profile fields and provider rules); nothing is applied.
import net from 'node:net';
import tls from 'node:tls';
import {randomBytes} from 'node:crypto';
import {providerProxy} from './residential.mjs';
import {providerRule} from './provider-rules.mjs';
import {hasHtmlChallenge} from './source-challenge.mjs';

const HOST=/^(?=.{1,253}$)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
export const PROBE_RESULTS=Object.freeze(['ok','challenge','denied','rate_limited','upstream_error','provider_refused','account_rejected','unreachable','proxy_failed','excluded_by_rule']);
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

// One cell: CONNECT through `proxyUrl` to host:443, then TLS, then GET /.
export async function probeCell({proxyUrl,host,path='/',timeoutMs=20000,maxBytes=65536,tlsConnect=defaultTls}){
 const started=Date.now(),cell={stage:'connect',result:null,connect_status:null,tls:false,http_status:null,bytes:0,ms:0};
 const done=result=>({...cell,result,ms:Date.now()-started});
 const upstream=new URL(proxyUrl);
 let socket;
 try{
  socket=await withTimeout(new Promise((resolve,reject)=>{const s=net.connect({host:upstream.hostname,port:Number(upstream.port)||80});s.once('connect',()=>resolve(s));s.once('error',reject);}),timeoutMs);
 }catch{return done('proxy_failed');}
 try{
  const auth=upstream.username||upstream.password?'Proxy-Authorization: Basic '+Buffer.from(decodeURIComponent(upstream.username)+':'+decodeURIComponent(upstream.password)).toString('base64')+'\r\n':'';
  socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n${auth}\r\n`);
  const head=await withTimeout(readHead(socket,16384),timeoutMs);cell.bytes+=head.length;
  const status=Number(/^HTTP\/1\.[01] (\d{3})/.exec(head.toString('latin1'))?.[1])||null;cell.connect_status=status;
  if(status!==200){
   if([401,402,407].includes(status))return done('account_rejected');
   if(status>=400&&status<500)return done('provider_refused');
   // 5xx: the proxy could not reach the destination on our behalf.
   return done(status>=500?'unreachable':'proxy_failed');
  }
  cell.stage='tls';
  let secure;
  try{secure=await withTimeout(tlsConnect(socket,host),timeoutMs);}catch{return done('unreachable');}
  cell.tls=true;cell.stage='http';
  secure.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: ${UA}\r\nAccept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8\r\nAccept-Language: en-US,en;q=0.9\r\nConnection: close\r\n\r\n`);
  const raw=await withTimeout(readUntil(secure,maxBytes),timeoutMs).catch(()=>null);
  if(!raw||!raw.length)return done('unreachable');
  cell.bytes+=raw.length;
  const text=raw.toString('latin1'),end=text.indexOf('\r\n\r\n');
  const http=Number(/^HTTP\/1\.[01] (\d{3})/.exec(text)?.[1])||null;cell.http_status=http;
  if(!http)return done('unreachable');
  const headers=Object.fromEntries(text.slice(0,end<0?text.length:end).split('\r\n').slice(1).map(l=>[l.split(':',1)[0].trim().toLowerCase(),l.slice(l.indexOf(':')+1).trim()]));
  const body=end<0?'':text.slice(end+4);
  if(http===429)return done('rate_limited');
  if(hasHtmlChallenge({headers,body})||/<title[^>]*>\s*(bot or not|access denied|just a moment|attention required)/i.test(body))return done('challenge');
  if(http===401||http===403)return done('denied');
  if(http>=500)return done('upstream_error');
  return done('ok');
 }catch{return done(cell.stage==='connect'?'proxy_failed':'unreachable');}
 finally{socket?.destroy();}
}
function defaultTls(socket,host){return new Promise((resolve,reject)=>{const s=tls.connect({socket,servername:host,ALPNProtocols:['http/1.1']});s.once('secureConnect',()=>resolve(s));s.once('error',reject);});}
function withTimeout(promise,ms){let t;return Promise.race([promise,new Promise((_,reject)=>{t=setTimeout(()=>reject(Error('timeout')),ms);})]).finally(()=>clearTimeout(t));}
function readHead(socket,cap){return new Promise((resolve,reject)=>{let buf=Buffer.alloc(0);const on=d=>{buf=Buffer.concat([buf,d]);const i=buf.indexOf('\r\n\r\n');if(i>=0||buf.length>cap){socket.removeListener('data',on);socket.pause();resolve(buf.subarray(0,i>=0?i+4:cap));}};socket.on('data',on);socket.once('error',reject);socket.once('close',()=>resolve(buf));});}
function readUntil(stream,cap){return new Promise((resolve,reject)=>{const parts=[];let n=0;stream.on('data',d=>{parts.push(d);n+=d.length;if(n>=cap){stream.destroy();resolve(Buffer.concat(parts).subarray(0,cap));}});stream.once('end',()=>resolve(Buffer.concat(parts)));stream.once('close',()=>resolve(Buffer.concat(parts)));stream.once('error',e=>n?resolve(Buffer.concat(parts)):reject(e));stream.resume();});}

// The probe plan from configured routes: one datacenter proxy per country and
// each enabled residential provider per country. Provider rules mark cells
// excluded instead of probing them (unless includeExcluded).
export function probePlan(config,host,countries,{includeExcluded=false}={}){
 if(!HOST.test(host))throw Error('probe_host_invalid');
 if(!Array.isArray(countries)||!countries.length||countries.some(c=>!/^[A-Z]{2}$/.test(c)))throw Error('probe_countries_invalid');
 const cells=[];
 for(const country of countries){
  const dc=(config.proxies??[]).find(p=>p.country===country);
  if(dc){const provider=dc.provider??'oxylabs';cells.push({provider,class:'datacenter',country,proxy:()=>dc.url,excluded:!includeExcluded&&providerRule(config,provider,host)?.id||null});}
  for(const provider of ['evomi','dataimpulse']){
   const c=config.residential?.providers?.[provider];if(!c?.enabled||!c.username||!c.password||c.countries&&!c.countries.includes(country))continue;
   cells.push({provider,class:'residential',country,proxy:()=>providerProxy(config,{country,residentialSession:randomBytes(5).toString('hex')},provider).url,excluded:!includeExcluded&&providerRule(config,provider,host)?.id||null});
  }
 }
 return cells;
}
export async function runProbe(config,host,countries,{includeExcluded=false,paceMs=1000,probe=probeCell,now=()=>new Date()}={}){
 const cells=[];
 for(const cell of probePlan(config,host,countries,{includeExcluded})){
  const meta={provider:cell.provider,class:cell.class,country:cell.country};
  if(cell.excluded){cells.push({...meta,result:'excluded_by_rule',rule:cell.excluded});continue;}
  if(cells.length&&paceMs)await new Promise(r=>setTimeout(r,paceMs));
  cells.push({...meta,...await probe({proxyUrl:cell.proxy(),host})});
 }
 return {host,probed_at:now().toISOString(),countries,cells,summary:summarizeProbe(host,countries,cells)};
}

const reached=r=>['ok','challenge','denied','rate_limited','upstream_error'].includes(r);
// Generic inference from a probe matrix. Pure; unit-tested.
export function summarizeProbe(host,countries,cells){
 const byCountry=Object.fromEntries(countries.map(c=>[c,cells.filter(x=>x.country===c)]));
 const reachable=countries.filter(c=>byCountry[c].some(x=>reached(x.result)));
 const unreachable=countries.filter(c=>!reachable.includes(c)&&byCountry[c].some(x=>x.result==='unreachable'));
 const providers=[...new Set(cells.map(x=>x.provider))];
 const refusing=providers.filter(p=>{const own=cells.filter(x=>x.provider===p&&x.result!=='excluded_by_rule');return own.length>0&&own.every(x=>x.result==='provider_refused');});
 // A datacenter route is blocked by the source when residential in the same
 // country reaches the source at HTTP level but the datacenter does not succeed.
 const datacenterBlocked=countries.filter(c=>{const dc=byCountry[c].find(x=>x.class==='datacenter'&&x.result!=='excluded_by_rule'&&x.result!=='provider_refused');return dc&&dc.result!=='ok'&&byCountry[c].some(x=>x.class==='residential'&&x.result==='ok');});
 const order=[['datacenter','ok'],['residential','ok']];
 let recommended=null;
 for(const country of reachable){for(const [cls,res] of order){const hit=byCountry[country].find(x=>x.class===cls&&x.result===res);if(hit){recommended={country,class:cls,provider:hit.provider,execution:'http'};break;}}if(recommended)break;}
 if(!recommended){const hit=cells.find(x=>x.class==='residential'&&['challenge','denied','rate_limited'].includes(x.result));if(hit)recommended={country:hit.country,class:'residential',provider:hit.provider,execution:'browser',verified:false};}
 const geoRestricted=reachable.length>0&&unreachable.length>0;
 const proposedRules=refusing.map(provider=>({id:`${provider}-${host.replace(/[^a-z0-9]+/g,'-')}`.slice(0,64),provider,match:{host},action:'exclude',reason:`${provider} refused CONNECT to ${host} in every probed country`}));
 // v1 profiles carry one country and route; v2 access profiles list countries and classes.
 const proposedProfile=recommended?{v1:{country:recommended.country,...(recommended.class==='residential'?{routingPolicy:'residential-v1',execution:recommended.execution}:{})},v2:{countries:reachable,proxy_classes:[...new Set(cells.filter(x=>x.result==='ok').map(x=>x.class))]}}:null;
 return {reachable_countries:reachable,unreachable_countries:unreachable,geo_restricted:geoRestricted,provider_refused:refusing,datacenter_blocked_countries:datacenterBlocked,recommended_route:recommended,proposed_profile:proposedProfile,proposed_provider_rules:proposedRules};
}
