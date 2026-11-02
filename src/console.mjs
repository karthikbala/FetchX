import {readFile} from 'node:fs/promises';
const files=new Map([['/console',['index.html','text/html; charset=utf-8']],['/console/',['index.html','text/html; charset=utf-8']],['/console/app.css',['app.css','text/css; charset=utf-8']],['/console/app.js',['app.js','text/javascript; charset=utf-8']]]);
export function publicConsoleRequest(req){return ['GET','HEAD'].includes(req.method)&&files.has(req.url.split('?')[0]);}
export function registerConsole(app){
 for(const [path,[file,type]]of files)app.get(path,async(req,reply)=>reply.type(type).header('cache-control','no-store').header('content-security-policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'").header('referrer-policy','no-referrer').header('x-content-type-options','nosniff').send(await readFile(new URL('./console/'+file,import.meta.url),'utf8')));
}
