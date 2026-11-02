import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {CookieJar} from 'tough-cookie';
import {nativeHttp,openPinnedTunnel} from '../src/v2-http.mjs';
import {createSourceResolver} from '../src/v2-dns.mjs';
import {V2Gateway} from '../src/v2.mjs';
import {ControlCredits} from '../src/control-credits.mjs';
import {GatewayError} from '../src/policy.mjs';
import {publicFetchFailure} from '../src/v2-public-fetch.mjs';

const destination={url:new URL('https://source.example/data'),address:'93.184.216.34',family:4};
const limits={timeout_ms:1000,max_tunnel_bytes:8192,max_encoded_bytes:4096,max_decoded_bytes:4096,max_expansion_ratio:20,max_redirects:2};
async function closedProxy(){
 const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
 await new Promise(resolve=>server.close(resolve));return {url:`http://127.0.0.1:${port}`};
}
const refusal=()=>Object.assign(new GatewayError('proxy_connect_refused',502),{cause_code:'ECONNREFUSED',proxy_connected:false,proxy_request_dispatched:false,observed_encoded_bytes:0,observed_tunnel_bytes:0});

test('TCP refusal before proxy connect has explicit non-dispatch evidence through native HTTPS',async()=>{
 const proxy=await closedProxy();
 await assert.rejects(nativeHttp({method:'POST',headers:{},body:Buffer.from('synthetic')},destination,limits,{proxy}),error=>{
  assert.equal(error.code,'proxy_connect_refused');assert.equal(error.cause_code,'ECONNREFUSED');assert.equal(error.proxy_connected,false);assert.equal(error.proxy_request_dispatched,false);assert.equal(error.observed_tunnel_bytes,0);assert.equal(error.observed_encoded_bytes,0);return true;
 });
 const guidance=publicFetchFailure(refusal(),{key:'refused-dial'});
 assert.equal(guidance.retry.safe_to_retry,false);assert.equal(guidance.retry.new_request_allowed,false);assert.equal(guidance.retry.same_key_replay_safe,true);assert.equal(guidance.retry.next_action,'review_proxy_configuration');
});

test('proxy connect followed by reset or deadline retains uncertainty and CONNECT bytes',async()=>{
 for(const mode of ['reset','timeout']){
  const sockets=new Set();let received=0;
  const proxy=net.createServer(socket=>{sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));socket.on('data',bytes=>{received+=bytes.length;if(mode==='reset')socket.destroy();});});
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  try{
   const meter={bytes:0,provider_status:null};
   // A peer closing without a handshake reaches the transport deadline too.
   await assert.rejects(openPinnedTunnel({url:`http://127.0.0.1:${proxy.address().port}`},destination,{...limits,timeout_ms:50},meter),error=>{assert.equal(error.code,'proxy_connect_unknown');assert.notEqual(error.proxy_request_dispatched,false);return true;});
   assert.ok(received>0);assert.ok(meter.bytes>0);
  }finally{for(const socket of sockets)socket.destroy();await new Promise(resolve=>proxy.close(resolve));}
 }
});

function execution({dns=false,earlierDns=false,earlierTarget=false,uncertain=false}={}){
 const queries=[],v2=Object.create(V2Gateway.prototype);
 const ledger={reserved_requests:3,reserved_encoded_bytes:4096,reserved_tunnel_bytes:24576};
 const query=async(sql,args)=>{queries.push({sql,args});return {rows:sql.startsWith('SELECT * FROM v2_ledger')?[ledger]:[]};};
 Object.assign(v2,{store:{pool:{query},tx:async fn=>fn({query})},sealer:{open:value=>value,seal:value=>value},config:{v2:{dns:{use_session_proxy:dns}},proxies:[]},assertPricingDispatch:()=>{},resolveProxy:()=>({url:'http://synthetic.invalid:8080'}),pace:async()=>{},dispatchable:async()=>{},headers:()=>({}),cooldown:async()=>{},rejectSecrets:()=>{}});
 v2.controlCredits=new ControlCredits({store:v2.store,config:v2.config});
 let lookups=0,calls=0;
 v2.destination=async(raw,p,deadline,context)=>{
  lookups++;
  if(dns){
   if(earlierDns){await context.beforeDispatch('source.example');context.observe(100,{uncertain:false});}
   await context.beforeDispatch('source.example');const error=refusal();context.observe(0,{uncertain:false,dispatched:false});throw error;
  }
  return {...destination,url:new URL(raw)};
 };
 v2.http=async()=>{calls++;if(earlierTarget&&calls===1)return {status:302,headers:{location:'/next'},encoded:Buffer.alloc(0),tunnel_bytes:100};if(uncertain)throw Object.assign(new GatewayError('proxy_connect_unknown',502),{cause_code:'ECONNREFUSED',observed_tunnel_bytes:40});throw refusal();};
 return {v2,queries,run:async()=>{
  await v2.execute('synthetic','operation',{id:'session',cookie_jar:new CookieJar().serializeSync()},{id:'source',limits},{class:'datacenter'},{url:destination.url.href,method:'POST',headers:{}},null);
  return {operation:queries.find(q=>q.sql.startsWith('UPDATE v2_operations SET state=')).args,ledger:queries.find(q=>q.sql.startsWith('UPDATE v2_ledger SET state=')).args,calls,lookups};
 }};
}

test('terminal refusal removes only current dispatch and preserves earlier DNS/native reservation',async()=>{
 for(const options of [{},{dns:true},{dns:true,earlierDns:true},{earlierTarget:true},{uncertain:true}]){
  const {run}=execution(options),{operation,ledger}=await run(),result=operation[3];
  assert.equal(operation[1],options.uncertain?'unknown':'failed');assert.equal(operation[2],options.uncertain?'proxy_connect_unknown':'proxy_connect_refused');
  assert.equal(result.physical_requests,options.earlierTarget||options.uncertain?1:0);
  assert.equal(result.dns_requests,options.dns?(options.earlierDns?2:1):0);
  assert.equal(result.tunnel_bytes,options.earlierDns||options.earlierTarget?100:options.uncertain?40:0);
  assert.equal(result.diagnostics.stage,options.uncertain?'transport':'proxy_connect');
  assert.equal(result.diagnostics.failure.request_dispatched,!!(options.earlierTarget||options.uncertain));
  if(!options.uncertain){assert.equal(result.diagnostics.failure.proxy_request_dispatched,false);assert.equal(result.diagnostics.failure.transport_phase,'proxy_tcp_connect');}
  const dispatched=options.earlierDns||options.earlierTarget||options.uncertain;
  assert.equal(ledger[1],options.uncertain?'unknown':dispatched?'unreconciled':'cancelled_before_dispatch');assert.equal(ledger[5],dispatched?24576:0);
 }
});

test('session-proxy DoH refusal records attempt, no uncertainty, and never falls back or retries',async()=>{
 const proxy=await closedProxy(),observed=[];let admissions=0;
 const resolver=createSourceResolver({allowed_hosts:['source.example'],use_session_proxy:true,system_timeout_ms:100,timeout_ms:1000,fallback_resolvers:[{id:'first',endpoint:'https://resolver.example/resolve'},{id:'second',endpoint:'https://second.example/resolve'}]},{systemLookup:async()=>[{address:'93.184.216.34',family:4}]});
 await assert.rejects(resolver('source.example',{all:true},{proxy,deadline:Date.now()+1000,remainingTunnel:()=>8192,beforeDispatch:async()=>{admissions++;},observe:(bytes,evidence)=>observed.push({bytes,...evidence})}),error=>{
  assert.equal(error.code,'proxy_connect_refused');assert.deepEqual(error.dns_diagnostics.attempts,[{resolver_id:'first',code:'ECONNREFUSED',rcode:null,extended_dns_errors:[]}]);return true;
 });
 assert.equal(admissions,1);assert.deepEqual(observed,[{bytes:0,uncertain:false,dispatched:false}]);
});
