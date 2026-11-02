import http from 'node:http';
import net from 'node:net';
import {pinnedDestination,openPinnedTunnel} from './v2-http.mjs';
import {GatewayError} from './policy.mjs';

// Source TLS stays end-to-end between Chromium and the approved host. This
// relay never terminates TLS, changes certificates, or re-resolves a pinned
// target at the upstream proxy. HTTP request paths are independently admitted
// before Chromium continues them; CONNECT handles only host-level transport.
export async function browserRelay({profile,resolve,proxy=null,limits,deadline,beforeConnect=async()=>{},dial=destination=>net.connect({host:destination.address,port:443}),openTunnel=openPinnedTunnel}){
 const sockets=new Set(),pending=new Set(),upstreamMeter={bytes:0,provider_status:null};let directBytes=0,error=null,closed=false,connections=0,targetConnections=0,dispatched=false;
 const bytes=()=>proxy?upstreamMeter.bytes:directBytes;
 const stop=code=>{error??=code;for(const socket of sockets)socket.destroy();};
 const track=socket=>{sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));return socket;};
 const server=http.createServer((req,res)=>{res.writeHead(403);res.end();});
 function pump(from,to){from.on('data',chunk=>{if(!proxy){directBytes+=chunk.length;if(directBytes>limits.max_network_bytes){stop('browser_network_byte_limit');return;}}if(!to.write(chunk)){from.pause();to.once('drain',()=>from.resume());}});}
 server.on('connect',(req,client,head)=>{
  const work=(async()=>{
  track(client);client.pause();
  try{
   if(closed||head.length||!/^([a-z0-9.-]+):443$/.test(req.url)||connections>=limits.max_requests)throw new GatewayError('browser_connect_rejected');
   const hostname=req.url.slice(0,-4);
   if(!profile.origins.some(origin=>new URL(origin).hostname===hostname))throw new GatewayError('browser_connect_rejected');
   connections++;
   const destination=await pinnedDestination(`https://${hostname}`,{origins:profile.origins},resolve);
   if(closed||client.destroyed||Date.now()>=deadline)throw new GatewayError('browser_connect_rejected');
   await beforeConnect(destination);dispatched=true;targetConnections++;
   let remote;
   if(proxy)remote=await openTunnel(proxy,destination,{timeout_ms:Math.max(1,deadline-Date.now()),max_tunnel_bytes:limits.max_network_bytes},upstreamMeter);
   else remote=await new Promise((accept,reject)=>{const socket=dial(destination);track(socket);const timer=setTimeout(()=>{socket.destroy();reject(new GatewayError('browser_connect_unknown'));},Math.max(1,deadline-Date.now()));socket.once('connect',()=>{clearTimeout(timer);accept(socket);});socket.once('error',()=>{clearTimeout(timer);reject(new GatewayError('browser_connect_unknown'));});});
   track(remote);
   remote.on('error',e=>{if(e.code==='tunnel_byte_limit')stop('browser_network_byte_limit');else{upstreamMeter.incomplete=true;stop('browser_transport_unknown');}});
   if(closed||client.destroyed){remote.destroy();return;}
   client.write('HTTP/1.1 200 Connection Established\r\n\r\n');pump(client,remote);pump(remote,client);remote.on('close',()=>client.destroy());client.on('close',()=>remote.destroy());client.resume();
  }catch(e){if(e.code==='tunnel_byte_limit')stop('browser_network_byte_limit');else if(!['destination_rejected','browser_connect_rejected'].includes(e.code))error??=e.code==='provider_account_rejected'?'provider_account_rejected':'browser_connect_unknown';client.end('HTTP/1.1 403 Forbidden\r\n\r\n');}
  })();
  pending.add(work);work.finally(()=>pending.delete(work));
 });
 await new Promise((accept,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',accept);});
 return {url:`http://127.0.0.1:${server.address().port}`,get bytes(){return bytes();},get meter_complete(){return closed&&pending.size===0&&!upstreamMeter.incomplete&&!(upstreamMeter.pending_writes>0)&&!/unknown|incomplete/.test(error??'');},get error(){return error;},get connections(){return targetConnections;},get dispatched(){return dispatched;},get provider_status(){return upstreamMeter.provider_status;},close:async()=>{closed=true;const closing=new Promise(r=>server.close(r));for(const socket of sockets)socket.destroy();
  // A pending upstream CONNECT owns the same meter. Wait for it to settle
  // before returning a final count; its transport has a bounded deadline.
  await Promise.allSettled([...pending]);for(const socket of sockets)socket.destroy();await closing;}};
}
