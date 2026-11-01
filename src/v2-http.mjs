import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import {Duplex} from 'node:stream';
import {lookup} from 'node:dns/promises';
import {gunzipSync,brotliDecompressSync,inflateSync} from 'node:zlib';
import {checkedURL,GatewayError,fail} from './policy.mjs';
import {safeCauseCode} from './v2-diagnostics.mjs';

function transportFailure(error){const failure=error instanceof GatewayError?error:new GatewayError('source_transport_unknown',502);failure.cause_code=safeCauseCode(error);return failure;}

// The returned address is the one used by the socket or the proxy CONNECT.
// A second provider-side hostname lookup must never undo the SSRF check.
export async function pinnedDestination(raw,profile,resolve=lookup){
 let addresses;
 const url=await checkedURL(raw,{hosts:profile.origins.map(o=>new URL(o).hostname),paths:profile.paths},async(host,options)=>{
  addresses=await resolve(host,options);return addresses;
 });
 if(!profile.origins.includes(url.origin))fail('destination_rejected');
 return {url,address:addresses[0].address,family:net.isIP(addresses[0].address),...(addresses.dns_diagnostics?{dns_diagnostics:addresses.dns_diagnostics}:{})};
}

export function decodeNative(encoded,encoding,limits){
 const code=(encoding??'identity').trim().toLowerCase();let decoded;
 try{
  if(code==='identity'||code==='')decoded=encoded;
  else if(code==='gzip'||code==='x-gzip')decoded=gunzipSync(encoded,{maxOutputLength:limits.max_decoded_bytes});
  else if(code==='br')decoded=brotliDecompressSync(encoded,{maxOutputLength:limits.max_decoded_bytes});
  else if(code==='deflate')decoded=inflateSync(encoded,{maxOutputLength:limits.max_decoded_bytes});
  else fail('content_encoding_unsupported',502);
 }catch(e){
  if(e instanceof GatewayError)throw e;
  fail(e.code==='ERR_BUFFER_TOO_LARGE'?'decoded_body_limit':'content_decoding_failed',502);
 }
 if(decoded.length>limits.max_decoded_bytes)fail('decoded_body_limit',502);
 if(decoded.length>Math.max(1024,encoded.length*limits.max_expansion_ratio))fail('decompression_ratio_limit',502);
 return decoded;
}

// Count encrypted tunnel traffic in both directions, including the CONNECT
// exchange. TLS wraps this Duplex rather than bypassing the accounting stream.
class MeteredTunnel extends Duplex{
 constructor(socket,meter,limit){
  super();this.socket=socket;this.meter=meter;this.limit=limit;
  socket.on('data',b=>{if(!this.count(b.length))return;if(!this.push(b))socket.pause();});
  socket.on('end',()=>this.push(null));socket.on('error',e=>this.destroy(e));
  socket.on('close',()=>this.destroy());
 }
 count(n){this.meter.bytes+=n;if(this.meter.bytes>this.limit){this.destroy(new GatewayError('tunnel_byte_limit',502));return false;}return true;}
 _read(){this.socket.resume();}
 _write(b,encoding,cb){if(this.count(b.length))this.socket.write(b,encoding,cb);else cb(new GatewayError('tunnel_byte_limit',502));}
 _destroy(error,cb){this.socket.destroy();cb(error);}
}

export async function openPinnedTunnel(proxy,destination,{timeout_ms,max_tunnel_bytes},meter){
 const upstream=new URL(proxy.url);
 if(upstream.protocol!=='http:'||upstream.pathname!=='/'||upstream.search||upstream.hash)fail('proxy_configuration_invalid',503);
 const target=(destination.family===6?'['+destination.address+']':destination.address)+':443';
 return new Promise((resolve,reject)=>{
  let complete=false,header=Buffer.alloc(0);
  const socket=net.connect({host:upstream.hostname,port:Number(upstream.port)||80});
  const timer=setTimeout(()=>finish(new GatewayError('proxy_connect_unknown',502)),timeout_ms);
  function finish(error,tunnel){if(complete)return;complete=true;clearTimeout(timer);socket.removeListener('data',ready);socket.removeListener('error',failed);error?(socket.destroy(),reject(error)):resolve(tunnel);}
  function failed(error){const failure=new GatewayError('proxy_connect_unknown',502);failure.cause_code=safeCauseCode(error);finish(failure);}
  socket.once('error',failed);
  socket.once('connect',()=>{
   const auth=upstream.username||upstream.password?'Proxy-Authorization: Basic '+Buffer.from(decodeURIComponent(upstream.username)+':'+decodeURIComponent(upstream.password)).toString('base64')+'\r\n':'';
   const request=`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`;
   meter.bytes+=Buffer.byteLength(request);
   if(meter.bytes>max_tunnel_bytes)return finish(new GatewayError('tunnel_byte_limit',502));
   socket.write(request);
  });
  function ready(part){
   meter.bytes+=part.length;header=Buffer.concat([header,part]);
   if(meter.bytes>max_tunnel_bytes)return finish(new GatewayError('tunnel_byte_limit',502));
   if(header.length>16384)return finish(new GatewayError('proxy_response_invalid',502));
   const end=header.indexOf('\r\n\r\n');if(end<0)return;
   const status=Number(/^HTTP\/1\.[01] (\d{3})(?: [^\r\n]*)?\r?\n/.exec(header.toString('latin1'))?.[1]);
   meter.provider_status=status||null;
   if(status!==200)return finish(new GatewayError([401,402,407].includes(status)?'provider_account_rejected':'proxy_connect_rejected',502));
   socket.pause();socket.removeListener('data',ready);
   // A CONNECT peer must wait for our ClientHello; unexpected bytes cannot be
   // mistaken for native source response or counted twice.
   if(header.length!==end+4)return finish(new GatewayError('proxy_response_invalid',502));
   finish(null,new MeteredTunnel(socket,meter,max_tunnel_bytes));
  }
  socket.on('data',ready);
 });
}

export async function nativeHttp(input,destination,limits,{proxy=null,requestImpl=https.request,openTunnel=openPinnedTunnel,tlsImpl=tls.connect}={}){
 const meter={bytes:0,provider_status:null};let agent;
 if(proxy){
  agent=new https.Agent({keepAlive:false});
  agent.createConnection=(options,callback)=>{
   openTunnel(proxy,destination,limits,meter).then(socket=>{
    const secure=tlsImpl({socket,servername:destination.url.hostname,rejectUnauthorized:true,ALPNProtocols:['http/1.1']});
    callback(null,secure);
   },callback);
  };
 }
 try{
  return await new Promise((resolve,reject)=>{
   let done=false,total=0,req;
   const timer=setTimeout(()=>finish(new GatewayError('source_timeout_unknown',502)),limits.timeout_ms);
   const pin=(host,options,cb)=>options?.all?cb(null,[{address:destination.address,family:destination.family}]):cb(null,destination.address,destination.family);
   try{req=requestImpl(destination.url,{method:input.method,headers:input.headers,agent:agent??false,lookup:pin,servername:destination.url.hostname,rejectUnauthorized:true,maxHeaderSize:32768},res=>{
    const parts=[];
    res.on('data',part=>{
     total+=part.length;
     if(total>limits.max_encoded_bytes){res.destroy();finish(new GatewayError('encoded_body_limit',502));return;}
     parts.push(part);
    });
    res.on('aborted',()=>finish(new GatewayError('source_body_incomplete',502)));
    res.on('error',()=>finish(new GatewayError('source_body_incomplete',502)));
    res.on('end',()=>finish(null,{status:res.statusCode,headers:res.headers,raw_headers:res.rawHeaders,encoded:Buffer.concat(parts),encoded_bytes:total,tunnel_bytes:proxy?meter.bytes:null,provider_status:meter.provider_status}));
   });}catch(error){finish(transportFailure(error));return;}
   function finish(error,result){
    if(done)return;done=true;clearTimeout(timer);
    if(error){error.observed_encoded_bytes=total;error.observed_tunnel_bytes=proxy?meter.bytes:null;error.provider_status=meter.provider_status;req?.destroy();reject(error);}else resolve(result);
   }
   req.on('error',e=>finish(transportFailure(e)));
   req.end(input.body??undefined);
  });
 }finally{agent?.destroy();}
}
