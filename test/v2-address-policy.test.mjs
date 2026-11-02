import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {CookieJar} from 'tough-cookie';
import {reviewedAddressPreference} from '../src/v2-address-policy.mjs';
import {pinnedDestination,nativeHttp} from '../src/v2-http.mjs';
import {createSourceResolver} from '../src/v2-dns.mjs';
import {datacenterPoolFingerprint} from '../src/v2-pricing.mjs';
import {V2Gateway} from '../src/v2.mjs';
import {ControlCredits} from '../src/control-credits.mjs';
import {GatewayError} from '../src/policy.mjs';

const ipv6={address:'2606:4700:4700::1111',family:6},ipv4={address:'93.184.216.34',family:4};
const source='source.example',url='https://source.example/data';
const limits={timeout_ms:1000,max_tunnel_bytes:8192,max_encoded_bytes:4096,max_decoded_bytes:4096,max_expansion_ratio:20,max_redirects:0};
const profile={id:'source',version:1,origins:['https://source.example'],countries:['US'],proxy_classes:['datacenter'],limits};
const route={class:'datacenter',country:'US',provider:'configured_datacenter',proxy_id:'us-1'};
function fixture(){
 const config={projects:{p:{v2_access_profiles:['source@1']}},proxies:[{id:'us-1',country:'US',provider:'oxylabs',pool_id:'assigned',url:'http://127.0.0.1:18001/'},{id:'us-2',country:'US',provider:'oxylabs',pool_id:'assigned',url:'http://127.0.0.1:18002/'}],v2:{}};
 const policy={schema_version:1,id:'reviewed-source-us',reviewed:true,project:'p',access_profiles:[{id:'source',version:1}],country:'US',provider:'oxylabs',pool_id:'assigned',pool_fingerprint_sha256:datacenterPoolFingerprint(config.proxies,'US'),transport:'http',preference:'ipv4'};
 config.v2.datacenterAddressPreferences=[policy];return {config,policy};
}

test('IPv4 preference is explicit and project/profile/country/provider/pool scoped',()=>{
 const {config}=fixture();assert.equal(reviewedAddressPreference(config,'p',profile,route),'ipv4');
 for(const [project,p,r]of [['other',profile,route],['p',{...profile,version:2},route],['p',profile,{...route,country:'IN'}],['p',profile,{class:'direct',provider:'direct'}],['p',profile,{class:'residential',provider:'evomi',country:'US'}]])assert.equal(reviewedAddressPreference(config,project,p,r),undefined);
 assert.equal(reviewedAddressPreference({...config,v2:{}},'p',profile,route),undefined);
 config.proxies[0].provider='other';assert.equal(reviewedAddressPreference(config,'p',profile,route),undefined);
});

test('preference configuration rejects malformed review, ambiguous scope, unapproved profile and changed pool',()=>{
 for(const patch of [{reviewed:false},{country:'us'},{preference:'ipv6'},{transport:'browser'},{provider:'other'},{access_profiles:[{id:'source',version:1},{id:'source',version:1}]},{extra:'private-value'}]){
  const {config,policy}=fixture();Object.assign(policy,patch);assert.throws(()=>reviewedAddressPreference(config,'p',profile,route),{code:'address_preference_configuration'});
 }
 {const {config,policy}=fixture();config.v2.datacenterAddressPreferences.push({...policy,id:'second'});assert.throws(()=>reviewedAddressPreference(config,'p',profile,route),{code:'address_preference_ambiguous'});}
 for(const change of ['project','country','class','discovery']){
  const {config}=fixture(),p=structuredClone(profile);
  if(change==='project')config.projects.p.v2_access_profiles=[];
  if(change==='country')p.countries=['IN'];if(change==='class')p.proxy_classes=['direct'];if(change==='discovery')p.kind='discovery';
  assert.throws(()=>reviewedAddressPreference(config,'p',p,route),{code:'address_preference_profile_forbidden'});
 }
 for(const change of ['url','provider','add']){
  const {config}=fixture();if(change==='url')config.proxies[1].url='http://127.0.0.1:18003/';if(change==='provider')config.proxies[1].provider='other';if(change==='add')config.proxies.push({...config.proxies[1],id:'us-3'});
  assert.throws(()=>reviewedAddressPreference(config,'p',profile,route),{code:'address_preference_pool_changed'});
 }
});

test('pinned destination validates every answer before selecting a public IPv4 and retains IPv6-only/default behavior',async()=>{
 for(const [answers,preference,expected]of [[[ipv6,ipv4],'ipv4',ipv4],[[ipv6,ipv4],undefined,ipv6],[[ipv6],'ipv4',ipv6],[[ipv4,ipv6],'ipv4',ipv4]]){
  let calls=0;const result=await pinnedDestination(url,profile,async()=>{calls++;return answers.map(a=>({...a}));},{addressPreference:preference});
  assert.equal(result.address,expected.address);assert.equal(result.family,expected.family);assert.equal(result.url.href,url);assert.equal(calls,1);
  if(preference){assert.equal(result.dns_diagnostics.address_preference,'ipv4');assert.equal(result.dns_diagnostics.selected_family,expected.family);assert.doesNotMatch(JSON.stringify(result.dns_diagnostics),/93\.184|2606/);}
 }
 for(const privateAddress of ['127.0.0.1','::1','::ffff:127.0.0.1','169.254.169.254'])await assert.rejects(pinnedDestination(url,profile,async()=>[ipv6,ipv4,{address:privateAddress}],{addressPreference:'ipv4'}),{code:'destination_rejected'});
});

const dnsSettings={allowed_hosts:[source],fallback_resolvers:[{id:'reviewed-dns',endpoint:'https://resolver.example/resolve'},{id:'unused-dns',endpoint:'https://unused.example/resolve'}],use_session_proxy:true,system_timeout_ms:100,timeout_ms:1000};
function context(){const c={addressPreference:'ipv4',proxy:{url:'http://127.0.0.1:18001'},deadline:Date.now()+1000,bytes:0,dispatches:0};c.remainingTunnel=()=>8192-c.bytes;c.beforeDispatch=async()=>{c.dispatches++;};c.observe=bytes=>{c.bytes+=bytes;};return c;}
function dnsReply(dest){const type=Number(dest.url.searchParams.get('type'));return {status:200,headers:{},encoded:Buffer.from(JSON.stringify({Status:0,Question:[{name:source,type}],Answer:[{name:source,type,data:type===1?ipv4.address:ipv6.address}]})),tunnel_bytes:100};}

test('trusted resolver bootstrap also prefers IPv4, preserves TLS hostname and checks IPv6 answers',async()=>{
 const c=context(),calls=[];
 const resolver=createSourceResolver(dnsSettings,{systemLookup:async name=>{assert.equal(name,'resolver.example');return [ipv6,ipv4];},http:async(input,dest,limits,{proxy})=>{
  assert.equal(dest.address,ipv4.address);assert.equal(dest.url.hostname,'resolver.example');assert.equal(proxy,c.proxy);calls.push(dest.url.searchParams.get('type'));return dnsReply(dest);
 }});
 const result=await pinnedDestination(url,profile,(host,options)=>resolver(host,options,c),{addressPreference:c.addressPreference});
 assert.deepEqual(calls,['1','28']);assert.equal(c.dispatches,2);assert.equal(result.address,ipv4.address);assert.equal(result.dns_diagnostics.answer_count,2);assert.equal(result.dns_diagnostics.resolver_bootstrap_family,4);
 for(const preference of [undefined,'ipv4']){
  let calls=0;const only6=createSourceResolver({...dnsSettings,fallback_resolvers:dnsSettings.fallback_resolvers.slice(0,1)},{systemLookup:async()=>[ipv6],http:async(input,dest)=>{calls++;assert.equal(dest.address,ipv6.address);return dnsReply(dest);}});
  await only6(source,{all:true},{...context(),addressPreference:preference});assert.equal(calls,2);
 }
});

test('mixed trusted resolver answers and failed proxy dispatch never lead to another resolver or source attempt',async()=>{
 let calls=0;const mixed=createSourceResolver(dnsSettings,{systemLookup:async()=>[ipv6,ipv4,{address:'::1'}],http:async()=>{calls++;assert.fail('no dispatch after private DNS answer');}});
 await assert.rejects(mixed(source,{all:true},context()),{code:'destination_rejected'});assert.equal(calls,0);
 const failed=createSourceResolver(dnsSettings,{systemLookup:async()=>[ipv6,ipv4],http:async()=>{calls++;throw Object.assign(new GatewayError('source_timeout_unknown',502),{observed_tunnel_bytes:17});}});
 await assert.rejects(failed(source,{all:true},context()),{code:'source_dns_timeout'});assert.equal(calls,1);
});

test('normal V2 execution passes reviewed preference to source and DNS bootstrap without a transport retry',async()=>{
 for(const proxiedDns of [false,true])for(const fails of [false,true]){
  const {config}=fixture();config.v2.dns={...dnsSettings,use_session_proxy:proxiedDns};let sourceCalls=0,dnsCalls=0;
  const queries=[],ledger={reserved_requests:3,reserved_encoded_bytes:4096,reserved_tunnel_bytes:24576};
  const query=async(sql,args)=>{queries.push({sql,args});return {rows:sql.startsWith('SELECT * FROM v2_ledger')?[ledger]:[]};};
  const v2=Object.create(V2Gateway.prototype);Object.assign(v2,{store:{pool:{query},tx:async fn=>fn({query})},sealer:{open:v=>v,seal:v=>v},config,assertPricingDispatch:()=>{},dispatchable:async()=>{},pace:async()=>{},headers:()=>({}),cooldown:async()=>{},rejectSecrets:()=>{},http:async(input,dest)=>{
   sourceCalls++;assert.equal(dest.address,ipv4.address);assert.equal(dest.url.href,url);
   if(fails)throw Object.assign(new GatewayError('source_transport_unknown',502),{observed_tunnel_bytes:40});
   return {status:200,headers:{},encoded:Buffer.from('synthetic'),tunnel_bytes:100};
  }});
  v2.controlCredits=new ControlCredits({store:v2.store,config:v2.config});
  v2.resolve=createSourceResolver(config.v2.dns,{systemLookup:async()=>[ipv6,ipv4],http:async(input,dest)=>{dnsCalls++;assert.equal(dest.address,ipv4.address);return dnsReply(dest);}});
  await v2.execute('p','operation',{id:'session',cookie_jar:new CookieJar().serializeSync()},profile,route,{url,method:'GET',headers:{}},null);
  const saved=queries.find(q=>q.sql.startsWith('UPDATE v2_operations SET state=')).args;
  assert.equal(saved[1],fails?'unknown':'completed');assert.equal(sourceCalls,1);assert.equal(dnsCalls,proxiedDns?2:0);
  assert.equal(saved[3].diagnostics.dns[0].selected_family,4);assert.equal(saved[3].physical_requests,1);
 }
});

test('native HTTPS keeps source hostname TLS/SNI after choosing the IPv4 CONNECT target',async()=>{
 const dest=await pinnedDestination(url,profile,async()=>[ipv6,ipv4],{addressPreference:'ipv4'});let sni;
 const result=await nativeHttp({method:'GET',headers:{}},dest,limits,{proxy:{url:'http://127.0.0.1:18001'},openTunnel:async(proxy,target)=>{assert.equal(target.address,ipv4.address);return new PassThrough();},tlsImpl:options=>{sni=options.servername;assert.equal(options.rejectUnauthorized,true);return options.socket;},requestImpl:(requestUrl,options,onResponse)=>{
  assert.equal(requestUrl.hostname,source);assert.equal(options.servername,source);
  const req=new EventEmitter();req.destroy=()=>{};req.end=()=>options.agent.createConnection({},(error,socket)=>{assert.ifError(error);socket.destroy();const response=new EventEmitter();Object.assign(response,{statusCode:200,headers:{},rawHeaders:[]});onResponse(response);response.emit('data',Buffer.from('ok'));response.emit('end');});return req;
 }});
 assert.equal(sni,source);assert.equal(result.status,200);
});
