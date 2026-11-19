import http from 'node:http';
import net from 'node:net';
import {chmod,lstat,open,stat,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname,isAbsolute,normalize} from 'node:path';

// Browser worker wire protocol: private Unix sockets between the gateway and
// its browser workers, JSON with fixed size limits, bearer tokens per capture.
export const OUTPUT_LIMIT=2*1024*1024;
export const WORKER_TRANSPORT_ERROR='browser_worker_transport_failed';
export const targetPattern=/^[a-z0-9.-]{1,253}:443$/;
export const codePattern=/^[a-z][a-z0-9_]{1,100}$/;
export const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
export const socketPathValid=path=>typeof path==='string'&&isAbsolute(path)&&normalize(path)===path&&!path.includes('\0')&&Buffer.byteLength(path)<=103;

// Same engine build; platform and arch must match when both sides state them.
export function matchesRuntime(actual,expected){
 const same=key=>actual?.[key]===undefined||expected?.[key]===undefined||actual[key]===expected[key];
 return actual?.engine===expected.engine&&actual?.version===expected.version&&actual?.sha256===expected.sha256&&same('platform')&&same('arch');
}

export async function readSmallFile(path,limit){
 const file=await open(path,constants.O_RDONLY|constants.O_NONBLOCK);
 try{
  const info=await file.stat();
  if(!info.isFile()||info.size>limit)throw new Error('invalid file');
  const buffer=Buffer.alloc(limit+1);
  const {bytesRead}=await file.read(buffer,0,buffer.length,0);
  if(bytesRead!==info.size)throw new Error('invalid file length');
  return JSON.parse(buffer.subarray(0,bytesRead));
 }finally{await file.close();}
}

export const authHeaders=token=>({authorization:'Bearer '+token});
export const requestToken=req=>/^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization??'')?.[1];

export function jsonResponse(res,status,value,limit=OUTPUT_LIMIT){
 if(res.destroyed)return;
 const body=JSON.stringify(value);
 if(Buffer.byteLength(body)>limit){
  res.destroy();
  return;
 }
 res.writeHead(status,{'connection':'close','content-type':'application/json','content-length':Buffer.byteLength(body)});
 res.end(body);
}

export function jsonLength(message,limit){
 const raw=message.headers['content-length'];
 const bytes=typeof raw==='string'&&/^\d{1,8}$/.test(raw)?Number(raw):0;
 if(message.headers['content-type']!=='application/json'||message.headers['transfer-encoding']||!bytes||bytes>limit)throw new Error('invalid JSON length');
 return bytes;
}

export async function readJson(message,length){
 const chunks=[];
 let bytes=0;
 for await(const chunk of message){
  bytes+=chunk.length;
  if(bytes>length)throw new Error('invalid JSON length');
  chunks.push(chunk);
 }
 if(bytes!==length)throw new Error('incomplete JSON');
 return JSON.parse(Buffer.concat(chunks,bytes));
}

export function requestJson(socketPath,path,{data,token,signal,limit=OUTPUT_LIMIT,responseLimit=OUTPUT_LIMIT}={}){
 return new Promise((resolve,reject)=>{
  const body=data===undefined?null:JSON.stringify(data);
  if(body!==null&&Buffer.byteLength(body)>limit)throw new Error('JSON request too large');
  const headers={connection:'close',...(body!==null?{'content-type':'application/json','content-length':Buffer.byteLength(body)}:{}),...(token?authHeaders(token):{})};
  const req=http.request({socketPath,path,method:body===null?'GET':'POST',headers,agent:false,signal},async res=>{
   try{resolve({status:res.statusCode,value:await readJson(res,jsonLength(res,responseLimit))});}
   catch(error){res.destroy();reject(error);}
  });
  req.once('error',reject);
  req.end(body);
 });
}

export function openWorkerTunnel(peer,authority,{token,signal}){
 return new Promise((resolve,reject)=>{
  const req=http.request({...peer,method:'CONNECT',path:authority,headers:{host:authority,...(token?authHeaders(token):{})},agent:false,signal});
  req.once('error',reject);
  req.once('connect',(res,socket,head)=>resolve({status:res.statusCode,socket,head}));
  req.once('response',res=>{res.destroy();reject(new Error('CONNECT protocol mismatch'));});
  req.end();
 });
}

export function bridgeTunnels(client,remote,head){
 remote.on('error',()=>client.destroy());
 client.on('error',()=>remote.destroy());
 remote.once('close',()=>{if(!client.writableEnded)client.destroy();});
 client.once('close',()=>{if(!remote.writableEnded)remote.destroy();});
 client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
 if(head.length)client.write(head);
 client.pipe(remote);
 remote.pipe(client);
}

export function trackSocket(sockets,socket){
 sockets.add(socket);
 socket.on('error',()=>{});
 socket.once('close',()=>sockets.delete(socket));
 return socket;
}

export function privateServer(handler){
 const server=http.createServer({maxHeaderSize:4096,headersTimeout:5000,requestTimeout:10000,connectionsCheckingInterval:1000},handler);
 server.maxRequestsPerSocket=1;
 server.on('upgrade',(_req,socket)=>socket.destroy());
 return server;
}

export function listen(server,options){
 return new Promise((resolve,reject)=>{
  server.once('error',reject);
  server.listen(options,()=>{
   server.off('error',reject);
   resolve();
  });
 });
}

async function staleSocket(path){
 return await new Promise(resolve=>{
  const socket=net.connect({path});
  const timer=setTimeout(()=>{socket.destroy();resolve(false);},500);
  socket.once('connect',()=>{clearTimeout(timer);socket.destroy();resolve(false);});
  socket.once('error',error=>{clearTimeout(timer);resolve(error.code==='ECONNREFUSED');});
 });
}

export async function listenPrivate(server,path){
 if(!socketPathValid(path))throw new Error('invalid browser worker socket path');
 const directory=await stat(dirname(path));
 if(!directory.isDirectory()||directory.uid!==process.getuid()||(directory.mode&0o077))throw new Error('browser worker socket directory must be private and owned by service UID');
 let existing;
 try{existing=await lstat(path);}catch(error){if(error.code!=='ENOENT')throw error;}
 if(existing){
  if(!existing.isSocket()||existing.uid!==process.getuid()||!await staleSocket(path))throw new Error('browser worker socket path is in use');
  const current=await lstat(path);
  if(current.dev!==existing.dev||current.ino!==existing.ino)throw new Error('browser worker socket changed');
  await unlink(path);
 }
 await listen(server,{path});
 try{await chmod(path,0o600);}catch(error){server.close();throw error;}
}
