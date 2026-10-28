import http from 'node:http';
import net from 'node:net';
import {checkedURL} from './policy.mjs';
// Private per-attempt CONNECT relay: exact reviewed hosts, no direct fallback,
// bounded wire traffic, no source/provider credentials in logs or client URLs.
export async function connectRelay({proxy,profile,maxBytes,resolve,allowLicense=false}){
 const upstream=new URL(proxy.url),sockets=new Set();let bytes=0,tunnels=0,error=null,closed=false;
 const stop=code=>{error??=code;for(const s of sockets)s.destroy();};
 const add=s=>{sockets.add(s);s.on('error',()=>{});s.on('close',()=>sockets.delete(s));};
 const pump=(from,to)=>from.on('data',chunk=>{if(bytes+chunk.length>maxBytes){stop('residential_byte_limit');return;}bytes+=chunk.length;if(!to.write(chunk)){from.pause();to.once('drain',()=>from.resume());}});
 const server=http.createServer((req,res)=>{res.writeHead(403);res.end();});
 server.on('connect',async(req,client,head)=>{
  add(client);client.pause();
  try{
   if(closed||head.length||!/^([a-z0-9.-]+):443$/.test(req.url)||++tunnels>(profile.maxConnects??40))throw Error();
   const host=req.url.slice(0,-4),license=allowLicense&&host==='cloakbrowser.dev';
   await checkedURL(`https://${host}/`,{hosts:license?['cloakbrowser.dev']:profile.hosts},resolve);
   if(closed||client.destroyed)return;
   const remote=net.connect({host:upstream.hostname,port:Number(upstream.port)});add(remote);remote.setTimeout(45000,()=>remote.destroy());
   remote.once('connect',()=>remote.write(`CONNECT ${req.url} HTTP/1.1\r\nHost: ${req.url}\r\nProxy-Authorization: Basic ${Buffer.from(decodeURIComponent(upstream.username)+':'+decodeURIComponent(upstream.password)).toString('base64')}\r\n\r\n`));
   let header=Buffer.alloc(0);
   const ready=part=>{
    header=Buffer.concat([header,part]);if(header.length>16384){remote.destroy();client.destroy();return;}
    const i=header.indexOf('\r\n\r\n');if(i<0)return;
    remote.removeListener('data',ready);
    const status=Number(/^HTTP\/1\.[01] (\d{3})/.exec(header.toString())?.[1]);
    if(status!==200){error=[401,402,407].includes(status)?'provider_account_rejected':'proxy_connect_failed';remote.destroy();client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');return;}
    if(bytes+512>maxBytes){stop('residential_byte_limit');return;}bytes+=512;
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    pump(client,remote);pump(remote,client);
    const rest=header.subarray(i+4);if(rest.length)remote.emit('data',rest);
    client.resume();
   };
   remote.on('data',ready);remote.on('close',()=>client.destroy());client.on('close',()=>remote.destroy());
  }catch{client.end('HTTP/1.1 403 Forbidden\r\n\r\n');}
 });
 await new Promise((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r);});
 return {url:`http://127.0.0.1:${server.address().port}`,get bytes(){return bytes;},get error(){return error;},close:async()=>{closed=true;for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));}};
}
