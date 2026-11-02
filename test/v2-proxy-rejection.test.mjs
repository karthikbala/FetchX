import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {CookieJar} from 'tough-cookie';
import {nativeHttp} from '../src/v2-http.mjs';
import {createSourceResolver} from '../src/v2-dns.mjs';
import {safeFailure} from '../src/v2-diagnostics.mjs';
import {V2Gateway} from '../src/v2.mjs';
import {ControlCredits} from '../src/control-credits.mjs';
import {GatewayError} from '../src/policy.mjs';
import {publicFetchResponse} from '../src/v2-public-fetch.mjs';

const destination={url:new URL('https://source.example/data'),address:'93.184.216.34',family:4};
const limits={timeout_ms:1000,max_tunnel_bytes:8192,max_encoded_bytes:4096,max_decoded_bytes:4096,max_expansion_ratio:20,max_redirects:2};
async function fakeProxy(status,header,run,{body='private-body https://secret.invalid/?password=secret-token',response=null}={}){
 const sockets=new Set();let requests=0;
 const server=net.createServer(socket=>{sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));socket.once('data',()=>{requests++;socket.end(response??`HTTP/1.1 ${status} Private proxy reason with password and source address\r\n${header}X-Private: secret-token\r\n\r\n${body}`);});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{await run({url:`http://username:private-password@127.0.0.1:${server.address().port}`},()=>requests);}
 finally{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}
}

test('CONNECT rejection retains only reviewed status and Squid reason through native transport',async()=>{
 for(const [status,header,reason]of [[403,'X-Squid-Error: ERR_ACCESS_DENIED 0\r\n','ERR_ACCESS_DENIED'],[407,'X-Squid-Error: ERR_CACHE_ACCESS_DENIED 0\r\n','ERR_CACHE_ACCESS_DENIED'],[403,'X-Squid-Error: ERR_ACCESS_DENIED secret-token\r\n',undefined],[403,'X-Squid-Error: ERR_PRIVATE_SECRET 0\r\n',undefined],[403,'X-Squid-Error: ERR_ACCESS_DENIED 0\r\nX-Squid-Error: ERR_DNS_FAIL 0\r\n',undefined],[403,'',undefined]]){
  await fakeProxy(status,header,async(proxy,count)=>{
   await assert.rejects(nativeHttp({method:'GET',headers:{}},destination,limits,{proxy}),error=>{
    assert.equal(error.code,status===407?'provider_account_rejected':'proxy_connect_rejected');assert.equal(error.provider_status,status);assert.equal(error.provider_reason,reason);
    const evidence=safeFailure(error,'transport',{dispatched:true});assert.equal(evidence.provider_status,status);assert.equal(evidence.provider_reason,reason);assert.equal(evidence.proxy_connected,true);assert.equal(evidence.proxy_request_dispatched,true);assert.equal(evidence.transport_phase,'proxy_connect');assert.ok(error.observed_tunnel_bytes>0);
    assert.doesNotMatch(JSON.stringify(evidence),/password|secret|127\.0|93\.184|https:|Private proxy/);return true;
   });assert.equal(count(),1);
  });
 }
 const uncertain=safeFailure(Object.assign(new GatewayError('proxy_connect_unknown',502),{provider_status:403,provider_reason:'ERR_ACCESS_DENIED',message:'unsanitized password https://secret.invalid'}),'transport');
 assert.equal(uncertain.provider_status,undefined);assert.equal(uncertain.proxy_connected,undefined);assert.doesNotMatch(JSON.stringify(uncertain),/secret|password/);
});

test('proxied DNS CONNECT rejection survives operation and public response without retry or source artifacts',async()=>{
 await fakeProxy(403,'X-Squid-Error: ERR_ACCESS_DENIED 0\r\n',async(proxy,count)=>{
  const settings={allowed_hosts:['source.example'],use_session_proxy:true,system_timeout_ms:100,timeout_ms:1000,fallback_resolvers:[{id:'approved-dns',endpoint:'https://resolver.example/resolve'},{id:'unused-dns',endpoint:'https://unused.example/resolve'}]};
  const resolver=createSourceResolver(settings,{systemLookup:async()=>[{address:'93.184.216.34',family:4}]});
  const queries=[],v2=Object.create(V2Gateway.prototype),ledger={reserved_requests:3,reserved_encoded_bytes:4096,reserved_tunnel_bytes:24576};
  const query=async(sql,args)=>{queries.push({sql,args});return {rows:sql.startsWith('SELECT * FROM v2_ledger')?[ledger]:sql.startsWith('SELECT input,kind')?[{input:{request:{method:'GET'}},kind:'http'}]:[]};};
  Object.assign(v2,{store:{pool:{query},tx:async fn=>fn({query})},sealer:{open:value=>value,seal:value=>value},config:{v2:{dns:settings},proxies:[]},resolve:resolver,assertPricingDispatch:()=>{},resolveProxy:()=>proxy,dispatchable:async()=>{},http:async()=>assert.fail('source transport must not dispatch')});
  v2.controlCredits=new ControlCredits({store:v2.store,config:v2.config});
  await v2.execute('synthetic','operation',{id:'session',cookie_jar:new CookieJar().serializeSync()},{id:'source',origins:['https://source.example'],limits},{class:'datacenter'},{url:destination.url.href,method:'GET',headers:{}},null);
  const saved=queries.find(q=>q.sql.startsWith('UPDATE v2_operations SET state=')).args,result=saved[3];
  assert.equal(saved[1],'unknown');assert.equal(saved[2],'proxy_connect_rejected');assert.equal(result.status,null);assert.equal(result.provider_status,403);assert.equal(result.physical_requests,0);assert.equal(result.dns_requests,1);assert.deepEqual(result.artifacts,[]);assert.ok(result.tunnel_bytes>0);
  const failure=result.diagnostics.failure;assert.equal(result.diagnostics.stage,'dns');assert.equal(failure.request_dispatched,false);assert.equal(failure.proxy_request_dispatched,true);assert.equal(failure.provider_status,403);assert.equal(failure.failure_code,'proxy_connect_rejected');assert.equal(failure.provider_reason,'ERR_ACCESS_DENIED');
  assert.equal(failure.dns.attempts.length,1);assert.equal(failure.dns.attempts[0].resolver_id,'approved-dns');assert.equal(failure.dns.attempts[0].provider_status,403);assert.equal(failure.dns.attempts[0].provider_reason,'ERR_ACCESS_DENIED');
  const accounting=queries.find(q=>q.sql.startsWith('UPDATE v2_ledger SET state=')).args;assert.equal(accounting[1],'unknown');assert.equal(accounting[5],24576);
  v2.owned=async()=>({policy:{}});v2.sessionView=()=>({proxy:{class:'datacenter',country:'US',provider:'synthetic'}});
  const response=await publicFetchResponse(v2,'synthetic','retained-key',{id:'operation',session_id:'session',state:saved[1],error:saved[2],result,accounting:{}});
  assert.equal(response.data.status,null);assert.equal(response.error.code,'proxy_connect_rejected');assert.equal(response.error.stage,'dns');assert.equal(response.diagnostics.failure.provider_status,403);assert.equal(response.diagnostics.failure.provider_reason,'ERR_ACCESS_DENIED');assert.equal(response.retry.new_request_allowed,false);assert.equal(response.retry.safe_to_retry,false);assert.equal(response.retry.next_action,'recover_first');assert.equal(response.usage.native_requests,0);assert.equal(response.usage.dns_requests,1);assert.deepEqual(response.artifacts,[]);
  assert.doesNotMatch(JSON.stringify(response),/password|secret|127\.0|93\.184|https:|Private proxy/);assert.equal(count(),1);
 });
});

test('native CONNECT failure preserves provider status independently of absent or earlier source status',async()=>{
 for(const redirect of [false,true])await fakeProxy(403,'X-Squid-Error: ERR_ACCESS_DENIED 0\r\n',async(proxy,count)=>{
  const queries=[],v2=Object.create(V2Gateway.prototype),ledger={reserved_requests:3,reserved_encoded_bytes:4096,reserved_tunnel_bytes:24576};let calls=0;
  const query=async(sql,args)=>{queries.push({sql,args});return {rows:sql.startsWith('SELECT * FROM v2_ledger')?[ledger]:[]};};
  Object.assign(v2,{store:{pool:{query},tx:async fn=>fn({query})},sealer:{open:value=>value,seal:value=>value},config:{v2:{},proxies:[]},assertPricingDispatch:()=>{},resolveProxy:()=>proxy,dispatchable:async()=>{},pace:async()=>{},headers:()=>({}),cooldown:async()=>{},rejectSecrets:()=>{},destination:async raw=>({...destination,url:new URL(raw)}),http:async(input,dest,policy,options)=>{
   calls++;if(redirect&&calls===1)return {status:302,headers:{location:'/next'},encoded:Buffer.alloc(0),tunnel_bytes:100,provider_status:200};
   return nativeHttp(input,dest,policy,options);
  }});
  v2.controlCredits=new ControlCredits({store:v2.store,config:v2.config});
  await v2.execute('synthetic','operation',{id:'session',cookie_jar:new CookieJar().serializeSync()},{id:'source',origins:['https://source.example'],limits},{class:'datacenter'},{url:destination.url.href,method:'GET',headers:{}},null);
  const saved=queries.find(q=>q.sql.startsWith('UPDATE v2_operations SET state=')).args,result=saved[3];
  assert.equal(saved[1],'failed');assert.equal(saved[2],'proxy_connect_rejected');assert.equal(result.status,redirect?302:null);assert.equal(result.provider_status,403);assert.equal(result.diagnostics.failure.provider_status,403);assert.equal(result.diagnostics.stage,'transport');assert.equal(result.physical_requests,redirect?2:1);assert.equal(result.dns_requests,0);assert.equal(result.artifacts.length,redirect?1:0);assert.equal(result.diagnostics.failure.proxy_request_dispatched,true);assert.equal(count(),1);
  const accounting=queries.find(q=>q.sql.startsWith('UPDATE v2_ledger SET state=')).args;assert.equal(accounting[1],'unreconciled');assert.equal(accounting[5],24576);
 });
});

test('coalesced large CONNECT error bodies retain rejection precedence and full byte observation',async()=>{
 const body='<html><body>private password secret-token '+ 'x'.repeat(20000)+'</body></html>';
 for(const status of [403,407])for(const cap of [8192,65536])await fakeProxy(status,'X-Squid-Error: ERR_ACCESS_DENIED 0\r\n',async(proxy,count)=>{
  await assert.rejects(nativeHttp({method:'GET',headers:{}},destination,{...limits,max_tunnel_bytes:cap},{proxy}),error=>{
   assert.equal(error.code,status===407?'provider_account_rejected':'proxy_connect_rejected');assert.equal(error.provider_status,status);assert.equal(error.provider_reason,'ERR_ACCESS_DENIED');assert.ok(error.observed_tunnel_bytes>Buffer.byteLength(body));
   if(cap===8192)assert.ok(error.observed_tunnel_bytes>cap);
   assert.doesNotMatch(JSON.stringify(safeFailure(error,'dns')),/password|secret|html|127\.0|93\.184/);return true;
  });assert.equal(count(),1);
 },{body});
});

test('large or incomplete CONNECT headers remain rejected and successful CONNECT cannot bypass byte caps',async()=>{
 const longHeader='HTTP/1.1 403 Forbidden\r\nX-Squid-Error: ERR_ACCESS_DENIED 0\r\nX-Large: '+'x'.repeat(17000);
 for(const response of [longHeader,longHeader+'\r\n\r\n'])await fakeProxy(403,'',async proxy=>{
  await assert.rejects(nativeHttp({method:'GET',headers:{}},destination,{...limits,max_tunnel_bytes:65536},{proxy}),error=>{
   assert.equal(error.code,'proxy_response_invalid');assert.equal(error.provider_status,null);assert.equal(error.provider_reason,undefined);assert.ok(error.observed_tunnel_bytes>16384);return true;
  });
 },{response});
 for(const cap of [8192,65536])await fakeProxy(200,'',async proxy=>{
  await assert.rejects(nativeHttp({method:'GET',headers:{}},destination,{...limits,max_tunnel_bytes:cap},{proxy}),error=>{
   assert.equal(error.code,cap===8192?'tunnel_byte_limit':'proxy_response_invalid');assert.equal(error.provider_status,200);assert.ok(error.observed_tunnel_bytes>20000);return true;
  });
 },{body:'x'.repeat(20000)});
});
