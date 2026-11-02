import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Gateway} from '../src/gateway.mjs';
import {Sealer} from '../src/crypto.mjs';
import {connectRelay} from '../src/connect-relay.mjs';
import {residentialTrafficCharge} from '../src/customer-traffic.mjs';
import {residentialTrafficObservation,totalResidentialTraffic,settleResidential,reserveResidential} from '../src/residential.mjs';

const profile={hosts:['source.example']},resolve=async()=>[{address:'93.184.216.34'}];
const connectRequest='CONNECT source.example:443 HTTP/1.1\r\nHost: source.example:443\r\nProxy-Authorization: Basic '+Buffer.from('user:secret').toString('base64')+'\r\n\r\n';
const charge=(status,bytes,maxBillableBytes)=>residentialTrafficCharge({status,bytes,maxBillableBytes});

test('V1 sums attempted provider observations once and caps each attempt before summing',()=>{
 const primary=charge('measured',1500,1000),backup=charge('measured',350,1000);
 assert.deepEqual(totalResidentialTraffic([primary,backup]),charge('measured',1850,1350));
 assert.equal(totalResidentialTraffic([primary,backup]).cost_usd,'0.000002700');
 for(const incomplete of [charge('unknown'),charge('pending'),null]){
  const total=totalResidentialTraffic([primary,incomplete]);assert.equal(total.status,'unknown');assert.equal(total.cost_usd,null);assert.equal(total.billable_bytes,null);
 }
 assert.deepEqual(totalResidentialTraffic([charge('no_traffic'),charge('no_traffic')]),charge('no_traffic'));
 assert.equal(totalResidentialTraffic([]),undefined);assert.equal(totalResidentialTraffic([null]),undefined);
});

test('V1 requires a separate valid actual proxy observation and retains incomplete byte evidence',async()=>{
 for(const observation of [undefined,{status:'measured'},{status:'measured',bytes:-1},{status:'no_traffic',bytes:12},{status:'pending',bytes:12}])assert.equal(residentialTrafficObservation(observation,1000).charge.status,'unknown');
 assert.deepEqual(residentialTrafficObservation({status:'no_traffic',bytes:0},1000).charge,charge('no_traffic'));
 assert.deepEqual(residentialTrafficObservation({status:'unknown',bytes:23},1000),{bytes:23,charge:charge('unknown')});
 const updates=[],c={query:async(sql,args)=>{updates.push({sql,args});return {rows:sql.startsWith('SELECT')?[{reserved_bytes:'1000',customer_traffic:charge('pending')}]:[]};}};
 await settleResidential(c,{},'attempt','evomi',{wireBytes:512,proxyTraffic:{status:'measured',bytes:1500}});
 assert.equal(updates[0].args[1],512);assert.deepEqual(updates.at(-1).args,['attempt',1500,charge('measured',1500,1000)]);
 updates.length=0;await settleResidential(c,{},'attempt','evomi',{wireBytes:512});assert.deepEqual(updates.at(-1).args,['attempt',null,charge('unknown')]);
 updates.length=0;await settleResidential({query:async(sql,args)=>{updates.push({sql,args});return {rows:sql.startsWith('SELECT')?[{reserved_bytes:'1000',customer_traffic:null}]:[]};}}, {},'old','evomi',{proxyTraffic:{status:'measured',bytes:30}});assert.equal(updates.length,2);
});

test('V1 capture replay preserves the recorded price and leaves historical captures unpriced',async()=>{
 const root=await mkdtemp(join(tmpdir(),'v1-price-replay-')),sealer=new Sealer('22'.repeat(32)),path=join(root,'capture.bin');
 const row={id:'operation',workflow:'workflow',result_path:path},gateway={store:{pool:{query:async()=>({rows:[row]})}},sealer};
 try{
  for(const capture of [{id:row.id,workflow:row.workflow,customer_traffic:charge('measured',1850,1350)},{id:row.id,workflow:row.workflow,wire_bytes:512}]){
   await writeFile(path,sealer.seal(capture));assert.deepEqual(await Gateway.prototype.result.call(gateway,'project',row.id),capture);assert.deepEqual(await Gateway.prototype.result.call(gateway,'project',row.id),capture);
  }
 }finally{await rm(root,{recursive:true,force:true});}
});

async function fakeProxy(handler,maxBytes=10000){
 const received=[],sockets=new Set(),upstream=net.createServer(socket=>{sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));socket.on('data',part=>{received.push(part);handler(socket,part);});});
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 const relay=await connectRelay({proxy:{url:`http://user:secret@127.0.0.1:${upstream.address().port}`},profile,maxBytes,resolve});
 return {relay,received,close:async()=>{await relay.close();for(const socket of sockets)socket.destroy();await new Promise(r=>upstream.close(r));}};
}
function openTunnel(relay,onConnect,allowFailure=false){
 return new Promise((resolve,reject)=>{const req=http.request(relay.url,{method:'CONNECT',path:'source.example:443'});req.on('connect',(response,socket,head)=>{socket.on('error',()=>{});socket.on('close',resolve);onConnect(response,socket,head);});req.on('error',allowFailure?resolve:reject);req.end();});
}

test('V1 actual proxy meter includes CONNECT headers and coalesced tunnel bytes exactly once',async()=>{
 const header='HTTP/1.1 200 Connection Established\r\nX-Proxy: fixture\r\n\r\n',source=[];let connected=false,sent=0;
 const fake=await fakeProxy((socket,part)=>{if(!connected){connected=true;const reply=header+'hello';sent+=Buffer.byteLength(reply);socket.write(reply);}else{assert.equal(part.toString(),'ping');sent+=4;socket.write('pong');}});
 try{
  await openTunnel(fake.relay,(response,socket,head)=>{assert.equal(response.statusCode,200);if(head.length)source.push(head);socket.on('data',part=>{source.push(part);if(Buffer.concat(source).toString()==='hellopong')socket.destroy();});socket.write('ping');});
  await fake.relay.close();assert.equal(Buffer.concat(fake.received).toString(),connectRequest+'ping');assert.equal(Buffer.concat(source).toString(),'hellopong');assert.equal(fake.relay.bytes,512+4+5+4);assert.deepEqual(fake.relay.traffic,{status:'measured',bytes:Buffer.byteLength(connectRequest)+4+sent});
 }finally{await fake.close();}
});

test('V1 actual proxy meter includes rejected CONNECTs and measurable failed handshakes',async()=>{
 for(const reply of ['HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 4\r\n\r\nnope','HTTP/1.1 200 Incomplete']){
  const fake=await fakeProxy(socket=>socket.end(reply));
  try{
   await openTunnel(fake.relay,(_response,socket)=>socket.destroy(),true);await fake.relay.close();assert.equal(fake.relay.bytes,0);assert.deepEqual(fake.relay.traffic,{status:'measured',bytes:Buffer.byteLength(connectRequest+reply)});
   if(reply.includes('407'))assert.equal(fake.relay.error,'provider_account_rejected');
  }finally{await fake.close();}
 }
});

test('V1 visible account rejections outrank byte limits and retain the provider hold',async()=>{
 for(const status of [401,402,407]){
  const reply=`HTTP/1.1 ${status} Account Rejected\r\nX-Large: ${'h'.repeat(status===407?17000:2000)}\r\n\r\n${'b'.repeat(4096)}`;
  const fake=await fakeProxy(socket=>socket.end(reply),1024);
  try{
   await openTunnel(fake.relay,(_response,socket)=>socket.destroy(),true);await fake.relay.close();
   assert.equal(fake.relay.error,'provider_account_rejected');assert.equal(fake.relay.bytes,0);assert.deepEqual(fake.relay.traffic,{status:'measured',bytes:Buffer.byteLength(connectRequest+reply)});assert.equal(residentialTrafficObservation(fake.relay.traffic,1024).charge.billable_bytes,1024);
   const provider={enabled:true,username:'user',password:'secret',maxTotalBytes:100000,microUsdPerGB:1000000},config={projects:{project:{}},residential:{maxDailyBytes:100000,maxTotalBytes:100000,providers:{evomi:provider}}};
   const queries=[],c={query:async(sql,args)=>{queries.push(sql);if(sql.startsWith('SELECT COALESCE'))return {rows:[{total:0,daily:0,workflow:0,project_daily:0,provider_total:0}]};assert.ok(sql.startsWith('SELECT 1 FROM attempts'));return {rowCount:args[1].includes(fake.relay.error)?1:0,rows:[]};}};
   await assert.rejects(reserveResidential(c,config,{id:'workflow',project:'project',config:{country:'US',residentialSession:'aaaaaaaaaa',maxAttemptBytes:1024,maxResidentialBytes:10000}},'attempt','evomi'),e=>e.code==='residential_provider_held');assert.equal(queries.length,2);
  }finally{await fake.close();}
 }
});

test('V1 recognizes a split account status before an oversized final header chunk',async()=>{
 const first='HTTP/1.1 4',last=`07 Rejected\r\nX-Large: ${'h'.repeat(4096)}\r\n\r\n`;
 const fake=await fakeProxy(socket=>socket.write(first,()=>setImmediate(()=>socket.end(last))),1024);
 try{await openTunnel(fake.relay,(_response,socket)=>socket.destroy(),true);await fake.relay.close();assert.equal(fake.relay.error,'provider_account_rejected');assert.deepEqual(fake.relay.traffic,{status:'measured',bytes:Buffer.byteLength(connectRequest+first+last)});}finally{await fake.close();}
});

test('V1 later generic CONNECT failures cannot replace a known account hold',async()=>{
 let calls=0;const replies=['HTTP/1.1 407 Rejected\r\n\r\n','HTTP/1.1 502 Failed\r\n\r\n'],fake=await fakeProxy(socket=>socket.end(replies[calls++]));
 try{
  for(let n=0;n<2;n++)await openTunnel(fake.relay,(_response,socket)=>socket.destroy(),true);
  await fake.relay.close();assert.equal(calls,2);assert.equal(fake.relay.error,'provider_account_rejected');assert.deepEqual(fake.relay.traffic,{status:'measured',bytes:Buffer.byteLength(connectRequest.repeat(2)+replies.join(''))});
  const response={status:null,error:fake.relay.error,headers:{},body:Buffer.alloc(0)};
  assert.equal(await Gateway.prototype.residentialFallback.call({attempt:async()=>assert.fail('account rejection must not fall back')},{requests:0,config:{}},'operation',{method:'GET',headers:{}},response),response);
 }finally{await fake.close();}
});

test('V1 failed upstream writes retain measured evidence and make the charge unknown',async()=>{
 const reply=Buffer.from('HTTP/1.1 200 Connection Established\r\n\r\n'),remote=new EventEmitter();let writes=0;
 remote.destroyed=false;remote.setTimeout=()=>{};remote.destroy=()=>{if(!remote.destroyed){remote.destroyed=true;queueMicrotask(()=>remote.emit('close'));}};
 remote.write=(part,done)=>{if(++writes===1){assert.equal(part,connectRequest);queueMicrotask(()=>{done();remote.emit('data',reply);});return true;}assert.equal(part.toString(),'ping');queueMicrotask(()=>{done(Error('uncertain partial upstream write'));remote.destroy();});return false;};
 const connect=mock.method(net,'connect',()=>{queueMicrotask(()=>remote.emit('connect'));return remote;}),relay=await connectRelay({proxy:{url:'http://user:secret@127.0.0.1:1'},profile,maxBytes:1024,resolve});
 try{await openTunnel(relay,(_response,socket)=>socket.write('ping'));await relay.close();assert.equal(writes,2);assert.deepEqual(relay.traffic,{status:'unknown',bytes:Buffer.byteLength(connectRequest)+reply.length});assert.equal(residentialTrafficObservation(relay.traffic,1024).charge.cost_usd,null);}finally{connect.mock.restore();await relay.close();}
});

test('V1 releases customer and provider usage inside the proven-unsent cancellation transaction',async()=>{
 for(const state of ['reserved','sent']){
  const p={routingPolicy:'residential-v1',execution:'http',country:'US',residentialSession:'aaaaaaaaaa',maxRequests:4,maxBytes:10000,maxResponseBytes:1024,maxAttemptBytes:1000,maxResidentialBytes:4000,minIntervalMs:0},w={id:'workflow',project:'project',profile:'source.profile',proxy_id:'evomi:session',expires_at:new Date(Date.now()+60000),config:p},provider={enabled:true,username:'user',password:'secret',maxTotalBytes:100000,microUsdPerGB:1000000},config={maxDailyFallbackCredits:0,projects:{project:{}},residential:{maxDailyBytes:100000,maxTotalBytes:100000,providers:{evomi:provider}}};
  let transaction=0,attempt;const released=[],store={pool:{query:async()=>assert.fail('cancellation must not release usage outside its transaction')},tx:async fn=>{const tx=++transaction;return fn({query:async(sql,args)=>{
   if(sql.startsWith('INSERT INTO admission_queue')){attempt=args[0];return {rows:[{queued_at:new Date()}]};}
   if(sql.startsWith('SELECT * FROM workflows'))return {rows:[{...w,state:tx===3?'closed':'open',requests:0,bytes:0}]};
   if(sql.startsWith('SELECT state FROM attempts'))return {rows:[{state}]};
   if(sql.includes('FROM admission_queue q'))return {rows:[{id:attempt,project:'project',provider:'evomi'}]};
   if(sql.startsWith('SELECT COALESCE'))return {rows:[{total:0,daily:0,workflow:0,project_daily:0,provider_total:0}]};
   if(sql.startsWith('UPDATE residential_usage'))released.push({tx,args,sql});
   return {rows:[],rowCount:0};
  }});}};
  await assert.rejects(Gateway.prototype.attempt.call({store,config},w,'operation',{url:'https://source.example/',method:'GET'},'evomi'),e=>e.code===(state==='reserved'?'workflow_closed':'attempt_not_dispatchable'));
  assert.equal(transaction,3);assert.equal(released.length,state==='reserved'?1:0);if(released.length){assert.equal(released[0].tx,3);assert.deepEqual(released[0].args,[attempt,charge('no_traffic')]);assert.match(released[0].sql,/customer_traffic IS NOT NULL/);}
 }
});

test('V1 actual proxy meter excludes CONNECT and payload writes blocked before dispatch',async()=>{
 let fake=await fakeProxy(()=>assert.fail('CONNECT must not be written'),20);
 try{await openTunnel(fake.relay,(_response,socket)=>socket.destroy(),true);await fake.relay.close();assert.equal(fake.received.length,0);assert.deepEqual(fake.relay.traffic,{status:'no_traffic',bytes:0});assert.equal(fake.relay.error,'residential_byte_limit');}finally{await fake.close();}
 const reply='HTTP/1.1 200 Connection Established\r\n\r\n';fake=await fakeProxy(socket=>socket.write(reply),1024);
 try{
  await openTunnel(fake.relay,(_response,socket)=>socket.write(Buffer.alloc(2000,'x')));await fake.relay.close();assert.equal(Buffer.concat(fake.received).toString(),connectRequest);assert.deepEqual(fake.relay.traffic,{status:'measured',bytes:Buffer.byteLength(connectRequest+reply)});assert.equal(fake.relay.error,'residential_byte_limit');
 }finally{await fake.close();}
});

test('V1 actual proxy meter retains received overrun evidence while customer billing stays capped',async()=>{
 const reply='HTTP/1.1 200 Connection Established\r\n\r\n';let connected=false;
 const fake=await fakeProxy(socket=>{if(!connected){connected=true;socket.write(reply);}else socket.write(Buffer.alloc(4096,'x'));},1024);
 try{
  await openTunnel(fake.relay,(_response,socket)=>socket.write('ping'));await fake.relay.close();const measured=Buffer.byteLength(connectRequest+reply)+4+4096;assert.deepEqual(fake.relay.traffic,{status:'measured',bytes:measured});assert.equal(fake.relay.error,'residential_byte_limit');assert.equal(residentialTrafficObservation(fake.relay.traffic,1024).charge.billable_bytes,1024);assert.ok(fake.relay.bytes<=1024);
 }finally{await fake.close();}
});
