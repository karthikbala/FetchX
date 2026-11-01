import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {GatewayError,ID,fail} from './policy.mjs';
import {nativeHttp,pinnedDestination,decodeNative} from './v2-http.mjs';
import {safeCauseCode} from './v2-diagnostics.mjs';

const DNS_CODES=new Set(['ENOTFOUND','ENODATA','ESERVFAIL','EREFUSED','ETIMEOUT','EAI_AGAIN','ECANCELLED','ECONNREFUSED','EFORMERR','EBADRESP','ENONAME']);
const trimDot=host=>host.toLowerCase().replace(/\.$/,'');
const domain=host=>typeof host==='string'&&host.length<=253&&/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(trimDot(host));
function dnsFailure(cause,{rcode=null,extendedErrors=[]}={}){
 const code=safeCauseCode(cause),ede=extendedErrors.filter(n=>Number.isInteger(n)&&n>=0&&n<=65535);
 const category=ede.includes(22)?'source_dns_authority_unreachable':ede.some(n=>n>=5&&n<=12)?'source_dns_validation_failed':rcode===2||code==='ESERVFAIL'?'source_dns_servfail':rcode===3||['ENOTFOUND','ENODATA','ENONAME'].includes(code)?'source_dns_not_found':rcode===5||code==='EREFUSED'?'source_dns_refused':['ETIMEOUT','EAI_AGAIN'].includes(code)?'source_dns_timeout':'source_dns_unavailable';
 const error=new GatewayError(category,502);error.cause_code=code;error.rcode=rcode;error.extended_dns_errors=ede;return error;
}
function invalidResponse(){return new GatewayError('source_dns_invalid_response',502);}
async function bounded(promise,milliseconds,onTimeout){
 let timer;try{return await Promise.race([promise,new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(onTimeout()),milliseconds);})]);}finally{clearTimeout(timer);}
}
function validate(settings){
 if(settings===undefined)return {allowed_hosts:[],fallback_resolvers:[],system_timeout_ms:3000,timeout_ms:5000};
 if(!settings||typeof settings!=='object'||Array.isArray(settings)||Object.keys(settings).some(k=>!['allowed_hosts','fallback_resolvers','system_timeout_ms','timeout_ms'].includes(k)))fail('dns_configuration_invalid',503);
 const s={system_timeout_ms:3000,timeout_ms:5000,...settings};
 for(const n of [s.system_timeout_ms,s.timeout_ms])if(!Number.isSafeInteger(n)||n<100||n>10000)fail('dns_configuration_invalid',503);
 if(!Array.isArray(s.allowed_hosts)||s.allowed_hosts.length>100||s.allowed_hosts.some(h=>!domain(h)||h!==trimDot(h)||isIP(h))||!Array.isArray(s.fallback_resolvers)||s.fallback_resolvers.length>2)fail('dns_configuration_invalid',503);
 for(const resolver of s.fallback_resolvers){
  if(!resolver||Object.keys(resolver).some(k=>!['id','endpoint'].includes(k))||typeof resolver.id!=='string'||!ID.test(resolver.id))fail('dns_configuration_invalid',503);
  let u;try{u=new URL(resolver.endpoint);}catch{fail('dns_configuration_invalid',503);}
  if(u.protocol!=='https:'||u.port&&u.port!=='443'||u.username||u.password||u.search||u.hash||!domain(u.hostname)||isIP(u.hostname)||!['/resolve','/dns-query'].includes(u.pathname)||u.href!==resolver.endpoint)fail('dns_configuration_invalid',503);
 }
 return s;
}

export function parseDnsJson(value,hostname,type){
 if(!value||typeof value!=='object'||!Number.isInteger(value.Status)||value.Status<0||value.Status>15||value.TC===true||value.CD===true||!Array.isArray(value.Question)||value.Question.length!==1||typeof value.Question[0]?.name!=='string'||trimDot(value.Question[0].name)!==hostname||value.Question[0]?.type!==type||value.extended_dns_errors!==undefined&&!Array.isArray(value.extended_dns_errors))throw invalidResponse();
 const extendedErrors=(value.extended_dns_errors??[]).filter(e=>e&&Number.isInteger(e.info_code)).map(e=>e.info_code).slice(0,16);
 if(value.Status!==0)throw dnsFailure(null,{rcode:value.Status,extendedErrors});
 const answers=value.Answer??[];if(!Array.isArray(answers)||answers.length>128||answers.some(a=>!a||typeof a!=='object'))throw invalidResponse();
 const names=new Set([hostname]);
 for(let i=0;i<16;i++){let changed=false;for(const answer of answers)if(answer.type===5&&typeof answer.name==='string'&&names.has(trimDot(answer.name))&&domain(answer.data)&&!names.has(trimDot(answer.data))){names.add(trimDot(answer.data));changed=true;}if(!changed)break;}
 const addresses=[];
 for(const answer of answers){
  if(answer.type!==type)continue;
  if(typeof answer.name!=='string'||!names.has(trimDot(answer.name))||typeof answer.data!=='string'||isIP(answer.data)!==(type===1?4:6))throw invalidResponse();
  addresses.push({address:answer.data,family:type===1?4:6});
 }
 return {addresses,authenticated_data:value.AD===true,extended_dns_errors:extendedErrors};
}

// Configuration is operator-approved and host-scoped. Source callers cannot
// choose resolver endpoints, disable DNSSEC checks, or supply target IPs.
export function createSourceResolver(settings,{systemLookup=lookup,http=nativeHttp}={}){
 const config=validate(settings);
 return async(host,options)=>{
  const attempts=[];
  try{
   const addresses=await bounded(Promise.resolve().then(()=>systemLookup(host,options)),config.system_timeout_ms,()=>Object.assign(new Error(),{code:'ETIMEOUT'}));
   if(!Array.isArray(addresses)||!addresses.length||addresses.some(a=>!a||typeof a.address!=='string'||!isIP(a.address)))throw Object.assign(new Error(),{code:'ENODATA'});
   // Do not try another resolver after any answer, including a private/mixed
   // answer. checkedURL inspects the entire set and rejects it before dispatch.
   addresses.dns_diagnostics={resolver_id:'system',fallback_used:false,answer_count:addresses.length};return addresses;
  }catch(error){
   const code=safeCauseCode(error);if(!DNS_CODES.has(code))throw error;
   attempts.push({resolver_id:'system',code,rcode:null,extended_dns_errors:[]});
   if(!config.allowed_hosts.includes(host)||!config.fallback_resolvers.length){const failed=dnsFailure(error);failed.dns_diagnostics={attempts};throw failed;}
  }
  let last;
  for(const resolver of config.fallback_resolvers){
   try{
    const endpoint=new URL(resolver.endpoint),deadline=Date.now()+config.timeout_ms;
    // Resolve/pin the trusted resolver through the system resolver only, so a
    // resolver outage cannot recurse into itself or evade endpoint SSRF checks.
    const endpointDestination=await bounded(pinnedDestination(endpoint.href,{origins:[endpoint.origin]},systemLookup),config.timeout_ms,()=>Object.assign(new Error(),{code:'ETIMEOUT'}));
    const families=await Promise.all([1,28].map(async type=>{
     const u=new URL(endpoint);u.searchParams.set('name',host);u.searchParams.set('type',String(type));u.searchParams.set('cd','0');u.searchParams.set('do','1');
     const limits={timeout_ms:Math.max(1,deadline-Date.now()),max_encoded_bytes:32768,max_decoded_bytes:32768,max_expansion_ratio:20};
     const response=await bounded(http({method:'GET',headers:{accept:'application/dns-json','accept-encoding':'identity'}},{...endpointDestination,url:u},limits),limits.timeout_ms,()=>Object.assign(new Error(),{code:'ETIMEOUT'}));
     if(response.status!==200)throw dnsFailure(null);
     let value;try{value=JSON.parse(decodeNative(response.encoded,response.headers['content-encoding'],limits).toString('utf8'));}catch{throw invalidResponse();}
     return parseDnsJson(value,host,type);
    }));
    const addresses=families.flatMap(r=>r.addresses);if(!addresses.length)throw dnsFailure(Object.assign(new Error(),{code:'ENODATA'}));
    attempts.push({resolver_id:resolver.id,code:null,rcode:0,extended_dns_errors:[]});
    addresses.dns_diagnostics={resolver_id:resolver.id,fallback_used:true,answer_count:addresses.length,authenticated_data:families.every(r=>r.authenticated_data),attempts};return addresses;
   }catch(error){
    // A private/mixed resolver endpoint is a security rejection, never an
    // invitation to shop for a different endpoint or skip address validation.
    if(error instanceof GatewayError&&error.code==='destination_rejected')throw error;
    last=error instanceof GatewayError&&error.code.startsWith('source_dns_')?error:dnsFailure(error);
    attempts.push({resolver_id:resolver.id,code:safeCauseCode(error),rcode:last.rcode??null,extended_dns_errors:last.extended_dns_errors??[]});
   }
  }
  last??=dnsFailure(null);last.dns_diagnostics={attempts};throw last;
 };
}
