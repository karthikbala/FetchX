// Operator-run reachability probe for onboarding a source host. It sends one
// HEAD per {provider, country} cell, each capped at a few KB, and turns the
// matrix into a PROPOSED routing rule for review. It never writes config.
import {randomBytes} from 'node:crypto';
import {connectRelay} from './connect-relay.mjs';
import {oxylabsRequest} from './transport.mjs';
import {providerProxy} from './residential.mjs';
import {providerExcluded} from './policy.mjs';
import {classifyOutcome} from './diagnostics.mjs';

export const PROBE_RESULTS=Object.freeze(['ok','provider_refused','unreachable','denied','rate_limited','error','excluded','unconfigured']);
const PROBE_BYTES=32*1024;

// Collapse one response into a probe cell result.
export function probeResult(response){
 if(response.error==='provider_excluded')return 'excluded';
 const category=classifyOutcome(response,{});
 if(category==='success')return 'ok';
 if(category==='provider_refused')return 'provider_refused';
 if(category==='source_unreachable'||category==='transport_failure'||response.error==='tls_verification_failed')return 'unreachable';
 if(category==='source_denied')return 'denied';
 if(category==='rate_limited')return 'rate_limited';
 if(Number.isInteger(response.status)&&response.status>=300&&response.status<400)return 'ok';
 return 'error';
}

// cells: [{provider, class:'datacenter'|'residential', country, result}]
export function proposeRule(host,cells){
 const ok=cells.filter(c=>c.result==='ok'),tested=cells.filter(c=>!['excluded','unconfigured'].includes(c.result));
 const countries=[...new Set(tested.map(c=>c.country))].sort(),allowed=[...new Set(ok.map(c=>c.country))].sort();
 const providers=[...new Set(tested.map(c=>c.provider))];
 const refusing=providers.filter(p=>tested.filter(c=>c.provider===p).every(c=>c.result==='provider_refused'));
 const okIn=cls=>ok.some(c=>c.class===cls);
 const dcBlocked=!okIn('datacenter')&&okIn('residential')&&tested.some(c=>c.class==='datacenter'&&['unreachable','denied'].includes(c.result)&&allowed.includes(c.country));
 const findings=[];
 if(allowed.length&&allowed.length<countries.length)findings.push(`country_restricted: reachable only from ${allowed.join(', ')}`);
 for(const p of refusing)findings.push(`provider_refused: ${p} refuses this host`);
 if(dcBlocked)findings.push('datacenter_blocked: datacenter IPs fail where residential IPs in the same country succeed');
 if(!allowed.length)findings.push('unreachable: no tested route reached the host');
 return {
  host,status:'proposed',
  allowedCountries:allowed.length&&allowed.length<countries.length?allowed:null,
  excludedProviders:refusing,
  startRoute:okIn('datacenter')?'datacenter':okIn('residential')?'residential_http':null,
  // HEAD cannot see a JavaScript challenge; a browser need is decided by a page fetch.
  browserNeeded:null,
  findings,matrix:cells
 };
}

async function headThrough(proxyUrl,host,{residential}){
 const profile={hosts:[host],maxResponseBytes:PROBE_BYTES,routingPolicy:residential?'residential-v1':'legacy'};
 const input={method:'HEAD',url:`https://${host}/`,headers:{}};
 if(!residential)return oxylabsRequest(input,{url:proxyUrl},profile);
 const relay=await connectRelay({proxy:{url:proxyUrl},profile,maxBytes:PROBE_BYTES});
 try{const r=await oxylabsRequest(input,{url:relay.url},profile);return {...r,error:relay.error??r.error??null};}
 finally{await relay.close();}
}

// Runs the matrix. request is injectable for tests.
export async function probeHost(config,host,countries,{request=headThrough}={}){
 if(!/^[a-z0-9.-]+$/i.test(host)||!countries.length||countries.some(c=>!/^[A-Z]{2}$/.test(c)))throw Error('probe_input_invalid');
 const cells=[],run=async(cell,proxyUrl,residential)=>{
  let response;
  try{response=await request(proxyUrl,host,{residential});}catch(e){response={status:null,error:e?.code??'transport_failed'};}
  cells.push({...cell,result:probeResult(response),status:response.status??null,error:response.error??null});
 };
 for(const country of countries){
  const dc=config.proxies?.find(x=>x.country===country);
  if(providerExcluded(config,'oxylabs',host))cells.push({provider:'oxylabs',class:'datacenter',country,result:'excluded',status:null,error:'provider_excluded'});
  else if(!dc)cells.push({provider:'oxylabs',class:'datacenter',country,result:'unconfigured',status:null,error:null});
  else await run({provider:'oxylabs',class:'datacenter',country},dc.url,false);
  for(const provider of ['evomi','dataimpulse']){
   let proxy;try{proxy=providerProxy(config,{country,residentialSession:randomBytes(5).toString('hex')},provider);}catch{cells.push({provider,class:'residential',country,result:'unconfigured',status:null,error:null});continue;}
   await run({provider,class:'residential',country},proxy.url,true);
  }
 }
 return proposeRule(host,cells);
}
