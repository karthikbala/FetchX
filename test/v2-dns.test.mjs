import test from 'node:test';
import assert from 'node:assert/strict';
import {createSourceResolver,parseDnsJson} from '../src/v2-dns.mjs';
import {pinnedDestination} from '../src/v2-http.mjs';
import {safeFailure,safeCauseCode} from '../src/v2-diagnostics.mjs';
import {GatewayError} from '../src/policy.mjs';

const host='source.example',profile={origins:['https://source.example']};
const settings={allowed_hosts:[host],fallback_resolvers:[{id:'approved-dns',endpoint:'https://resolver.example/resolve'}],system_timeout_ms:100,timeout_ms:100};
const dnsError=code=>Object.assign(new Error('private message with source token and SQL text'),{code});
const systemLookup=async name=>{if(name===host)throw dnsError('ENOTFOUND');return [{address:'93.184.216.34',family:4}];};
function jsonReply(dest,patch={}){const type=Number(dest.url.searchParams.get('type'));return {status:200,headers:{'content-type':'application/dns-json'},encoded:Buffer.from(JSON.stringify({Status:0,CD:false,AD:true,Question:[{name:host+'.',type}],Answer:[{name:host+'.',type,data:type===1?'93.184.216.34':'2606:4700:4700::1111'}],...patch}))};}

test('v2 DNS errors have explicit safe categories before target dispatch',async()=>{
 for(const [code,expected]of [['ENOTFOUND','source_dns_not_found'],['ENODATA','source_dns_not_found'],['ESERVFAIL','source_dns_servfail'],['EAI_AGAIN','source_dns_timeout'],['EREFUSED','source_dns_refused']]){
  const resolver=createSourceResolver(undefined,{systemLookup:async()=>{throw dnsError(code);}});
  await assert.rejects(resolver(host,{all:true}),error=>{
   assert.equal(error.code,expected);const safe=safeFailure(error,'dns');assert.equal(safe.cause_code,code);assert.equal(safe.request_dispatched,false);assert.ok(!JSON.stringify(safe).includes('private message'));assert.deepEqual(safe.dns.attempts,[{resolver_id:'system',code,rcode:null,extended_dns_errors:[]}]);return true;
  });
 }
 const sql=dnsError('23503');await assert.rejects(createSourceResolver(undefined,{systemLookup:async()=>{throw sql;}})(host,{all:true}),error=>error===sql);
 assert.deepEqual(safeFailure(sql,'pacing'),{stage:'pacing',cause_code:'23503',error_class:'Error',request_dispatched:false});assert.equal(safeCauseCode(dnsError('private-secret-code')),null);
});

test('v2 approved DoH fallback checks both address families and retains resolver provenance',async()=>{
 const calls=[];const resolver=createSourceResolver(settings,{systemLookup,http:async(input,dest,limits)=>{
  calls.push(dest);assert.equal(dest.address,'93.184.216.34');assert.equal(dest.url.origin,'https://resolver.example');assert.equal(dest.url.searchParams.get('cd'),'0');assert.equal(input.headers.accept,'application/dns-json');assert.ok(limits.timeout_ms<=100);return jsonReply(dest);
 }});
 const result=await pinnedDestination('https://source.example/data',profile,resolver);
 assert.equal(result.address,'93.184.216.34');assert.equal(result.dns_diagnostics.fallback_used,true);assert.equal(result.dns_diagnostics.resolver_id,'approved-dns');assert.equal(result.dns_diagnostics.answer_count,2);assert.equal(calls.length,2);
 const cname=parseDnsJson({Status:0,CD:false,Question:[{name:host,type:1}],Answer:[{name:host,type:5,data:'canonical.example.'},{name:'canonical.example.',type:1,data:'93.184.216.34'}]},host,1);assert.equal(cname.addresses.length,1);
});

test('v2 fallback never follows private/mixed answers or unapproved resolver/host scope',async()=>{
 let calls=0;
 const mixed=createSourceResolver(settings,{systemLookup:async()=>[{address:'93.184.216.34'},{address:'127.0.0.1'}],http:async()=>{calls++;}});
 await assert.rejects(pinnedDestination('https://source.example/data',profile,mixed),{code:'destination_rejected'});assert.equal(calls,0);
 const second={id:'second',endpoint:'https://second.example/resolve'};
 const privateFallback=createSourceResolver({...settings,fallback_resolvers:[...settings.fallback_resolvers,second]},{systemLookup,http:async(input,dest)=>{calls++;return jsonReply(dest,{Answer:[{name:host,type:Number(dest.url.searchParams.get('type')),data:dest.url.searchParams.get('type')==='1'?'10.0.0.1':'::1'}]});}});
 await assert.rejects(pinnedDestination('https://source.example/data',profile,privateFallback),{code:'destination_rejected'});assert.equal(calls,2);
 calls=0;const privateEndpoint=createSourceResolver(settings,{systemLookup:async name=>{if(name===host)throw dnsError('ENOTFOUND');return [{address:'169.254.169.254'}];},http:async()=>{calls++;}});
 await assert.rejects(privateEndpoint(host,{all:true}),{code:'destination_rejected'});assert.equal(calls,0);
 const unapproved=createSourceResolver({...settings,allowed_hosts:[]},{systemLookup,http:async()=>{calls++;}});await assert.rejects(unapproved(host,{all:true}),{code:'source_dns_not_found'});assert.equal(calls,0);
 for(const endpoint of ['http://resolver.example/resolve','https://user:secret@resolver.example/resolve','https://127.0.0.1/resolve','https://resolver.example/resolve?cd=1'])assert.throws(()=>createSourceResolver({...settings,fallback_resolvers:[{id:'bad',endpoint}]}),{code:'dns_configuration_invalid'});
});

test('v2 authoritative DNS failures retain RCODE/EDE without resolver comments or source data',async()=>{
 const resolver=createSourceResolver(settings,{systemLookup,http:async(input,dest)=>jsonReply(dest,{Status:2,Comment:'private sensitive diagnostic response',extended_dns_errors:[{info_code:22,extra_text:'secret source details'}]})});
 await assert.rejects(resolver(host,{all:true}),error=>{
  assert.equal(error.code,'source_dns_authority_unreachable');assert.equal(error.rcode,2);assert.deepEqual(error.dns_diagnostics.attempts.at(-1),{resolver_id:'approved-dns',code:null,rcode:2,extended_dns_errors:[22]});assert.ok(!JSON.stringify(safeFailure(error,'dns')).includes('secret'));assert.ok(!JSON.stringify(safeFailure(error,'dns')).includes('sensitive'));return true;
 });
 for(const [status,extra,expected]of [[3,[],'source_dns_not_found'],[2,[{info_code:6}],'source_dns_validation_failed']])assert.throws(()=>parseDnsJson({Status:status,Question:[{name:host,type:1}],extended_dns_errors:extra},host,1),{code:expected});
});

test('v2 resolver rejects malformed/unchecked DNS and bounds slow system/fallback lookups',async()=>{
 const value={Status:0,CD:false,Question:[{name:host,type:1}],Answer:[{name:host,type:1,data:'93.184.216.34'}]};
 for(const patch of [{CD:true},{TC:true},{Question:[{name:'unrelated.example',type:1}]},{Question:[{name:23,type:1}]},{Answer:[null]},{Answer:[{name:'unrelated.example',type:1,data:'93.184.216.34'}]},{extended_dns_errors:{}}])assert.throws(()=>parseDnsJson({...value,...patch},host,1),{code:'source_dns_invalid_response'});
 const slow=createSourceResolver({...settings,fallback_resolvers:[]},{systemLookup:async()=>new Promise(()=>{})});const start=Date.now();await assert.rejects(slow(host,{all:true}),{code:'source_dns_timeout'});assert.ok(Date.now()-start<1000);
 const slowFallback=createSourceResolver(settings,{systemLookup,http:async()=>new Promise(()=>{})});await assert.rejects(slowFallback(host,{all:true}),{code:'source_dns_timeout'});
});

test('v2 fallback classifies native HTTPS deadlines and socket timeouts as DNS timeouts',async()=>{
 for(const error of [new GatewayError('source_timeout_unknown',502),dnsError('ETIMEDOUT')]){
  const resolver=createSourceResolver(settings,{systemLookup,http:async()=>{throw error;}});
  await assert.rejects(resolver(host,{all:true}),failure=>{
   assert.equal(failure.code,'source_dns_timeout');
   assert.equal(failure.cause_code,error.code==='ETIMEDOUT'?'ETIMEDOUT':null);
   assert.equal(safeFailure(failure,'dns').request_dispatched,false);
   assert.equal(failure.dns_diagnostics.attempts.at(-1).resolver_id,'approved-dns');
   return true;
  });
 }
});

function proxyContext(){
 const context={proxy:{url:'http://synthetic-us-proxy.example:8080'},deadline:Date.now()+1000,bytes:0,dispatches:0,uncertain:false};
 context.remainingTunnel=()=>1000-context.bytes;
 context.beforeDispatch=async()=>{context.dispatches++;};
 context.observe=(bytes,{uncertain})=>{context.bytes+=bytes;context.uncertain||=uncertain;};
 return context;
}

test('v2 exact-host session DNS uses one immutable proxy and sequential shared limits',async()=>{
 const context=proxyContext(),calls=[];
 const resolver=createSourceResolver({...settings,use_session_proxy:true},{systemLookup:async name=>{assert.equal(name,'resolver.example');return [{address:'93.184.216.34'}];},http:async(input,dest,limits,{proxy})=>{
  assert.equal(proxy,context.proxy);assert.equal(context.dispatches,calls.length+1);assert.equal(limits.max_tunnel_bytes,1000-calls.length*100);assert.ok(limits.timeout_ms<=100);calls.push(dest.url.searchParams.get('type'));
  return {...jsonReply(dest),tunnel_bytes:100};
 }});
 const result=await pinnedDestination('https://source.example/data',profile,(host,options)=>resolver(host,options,context));
 assert.deepEqual(calls,['1','28']);assert.equal(context.bytes,200);assert.equal(result.dns_diagnostics.session_proxy_used,true);
});

test('v2 proxied DNS keeps public checks and never repeats failed paid resolution',async()=>{
 for(const mode of ['private','servfail','unknown']){
  const context=proxyContext();let calls=0;
  const resolver=createSourceResolver({...settings,use_session_proxy:true,fallback_resolvers:[...settings.fallback_resolvers,{id:'second',endpoint:'https://second.example/resolve'}]},{systemLookup:async()=>[{address:'93.184.216.34'}],http:async(input,dest)=>{
   calls++;
   if(mode==='unknown')throw Object.assign(new GatewayError('source_timeout_unknown',502),{observed_tunnel_bytes:17});
   return {...jsonReply(dest,mode==='servfail'?{Status:2}:{Answer:[{name:host,type:Number(dest.url.searchParams.get('type')),data:dest.url.searchParams.get('type')==='1'?'10.0.0.1':'::1'}]}),tunnel_bytes:100};
  }});
  await assert.rejects(pinnedDestination('https://source.example/data',profile,(host,options)=>resolver(host,options,context)),{code:mode==='private'?'destination_rejected':mode==='servfail'?'source_dns_servfail':'source_dns_timeout'});
  assert.equal(calls,mode==='private'?2:1);assert.equal(context.bytes,mode==='private'?200:mode==='unknown'?17:100);assert.equal(context.uncertain,mode==='unknown');
 }
});

test('v2 session DNS opt-in leaves disabled, direct and unapproved hosts on system DNS',async()=>{
 for(const [config,context,name]of [[settings,proxyContext(),host],[{...settings,use_session_proxy:true},undefined,host],[{...settings,use_session_proxy:true},proxyContext(),'other.example']]){
  let lookups=0;const resolver=createSourceResolver(config,{systemLookup:async actual=>{lookups++;assert.equal(actual,name);return [{address:'93.184.216.34'}];},http:async()=>assert.fail('unexpected DoH dispatch')});
  await resolver(name,{all:true},context);assert.equal(lookups,1);assert.equal(context?.dispatches??0,0);
 }
 assert.throws(()=>createSourceResolver({...settings,use_session_proxy:'yes'}),{code:'dns_configuration_invalid'});
});
