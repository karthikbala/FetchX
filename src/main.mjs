import Fastify from 'fastify';
import {JobQueue} from './jobs.mjs';
import {fetchOnce,lookupFetch,publicProfiles} from './fetch.mjs';
import {readFile} from 'node:fs/promises';
import {timingSafeEqual} from 'node:crypto';
import {Store} from './store.mjs';
import {Gateway} from './gateway.mjs';
import {profiles} from './profiles.mjs';
import {sha} from './crypto.mjs';
import {GatewayError} from './policy.mjs';
import {pruneArtifacts} from './artifacts.mjs';
import {gatewayStatus} from './status.mjs';
import {operationDiagnostics,recordOutcome} from './diagnostics.mjs';
export function server(gateway){
 const app=Fastify({logger:false,bodyLimit:24*1024*1024,requestTimeout:90000});
 app.addHook('onRequest',async(req,reply)=>{
  if(req.url==='/healthz')return;
  const token=/^Bearer (\S+)$/i.exec(req.headers.authorization??'')?.[1];
  if(!token)return reply.code(401).send({error:'unauthorized'});
  const hash=Buffer.from(sha(token),'hex');
  for(const [id,p]of Object.entries(gateway.config.projects))if(timingSafeEqual(hash,Buffer.from(p.tokenHash,'hex'))){req.project=id;return;}
  reply.code(401).send({error:'unauthorized'});
 });
 app.setErrorHandler((error,req,reply)=>{
  const clientError=error.validation||error.statusCode===400||error.statusCode===413||error.statusCode===415;
  const status=error instanceof GatewayError?error.status:clientError?(error.statusCode??400):500;
  reply.code(status).send({error:error instanceof GatewayError?error.code:clientError?'request_invalid':'internal_error',...(error instanceof GatewayError&&error.details?{details:error.details}:{})});
 });
 app.get('/healthz',async()=>{await gateway.store.pool.query('SELECT 1');return {ok:true,service:'FetchX',release:gateway.config.release,default_provider:gateway.config.defaultRouting==='residential-v1'?'evomi':'oxylabs'};});
 app.get('/v1/profiles',req=>publicProfiles(gateway,req.project));
 app.post('/v1/fetch',req=>fetchOnce(gateway,req.project,req.body));
 app.get('/v1/fetch/:key',req=>lookupFetch(gateway,req.project,req.params.key));
 app.post('/v1/workflows',req=>gateway.workflow(req.project,req.body));
 app.get('/v1/status',req=>gatewayStatus(gateway.store,gateway.config,req.project));
 const jobs=new JobQueue(gateway);
 app.decorate('jobs',jobs);
 app.addHook('onClose',()=>jobs.stop());
 app.post('/v1/jobs',async(req,reply)=>reply.code(202).send(await jobs.submit(req.project,req.body)));
 const route={schema:{params:{type:'object',required:['id'],properties:{id:{type:'string',pattern:'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$'}}}}};
 app.get('/v1/jobs/:id',route,req=>jobs.read(req.project,req.params.id));
 app.delete('/v1/jobs/:id',route,req=>jobs.cancel(req.project,req.params.id));
 app.get('/v1/workflows/:id',route,req=>gateway.read(req.project,req.params.id));
 app.post('/v1/workflows/:id/close',route,req=>gateway.close(req.project,req.params.id));
 app.post('/v1/workflows/:id/fallback',route,req=>gateway.fallback(req.project,req.params.id,req.body));
 app.post('/v1/workflows/:id/operations',route,req=>gateway.operation(req.project,req.params.id,req.body));
 app.get('/v1/workflows/:id/operations/:key',route,req=>gateway.lookup(req.project,req.params.id,req.params.key));
 app.get('/v1/operations/:id',route,req=>gateway.result(req.project,req.params.id));
 app.get('/v1/operations/:id/diagnostics',route,req=>operationDiagnostics(gateway.store.pool,req.project,req.params.id));
 app.post('/v1/operations/:id/outcome',route,req=>recordOutcome(gateway.store.pool,req.project,req.params.id,req.body));
 return app;
}
if(process.argv[1]===new URL(import.meta.url).pathname){
 const config=JSON.parse(await readFile(process.env.GATEWAY_CONFIG??'/run/secrets/gateway.json','utf8'));
 const store=new Store(process.env.DATABASE_URL);
 await store.acquireRunnerLock(()=>{process.stderr.write('gateway_ownership_lost\n');process.exit(1);});
 await store.init();await store.recover();
 for(const id of Object.keys(config.sourceProfiles??{}))if(Object.hasOwn(profiles,id))throw Error('profile_override_rejected');
 const gateway=new Gateway({store,config,profiles:{...profiles,...config.sourceProfiles}});
 const recovery=await gateway.recoverCaptures();
 if(recovery.invalid)process.stderr.write('capture_recovery_invalid\n');
 const app=server(gateway);
 await app.jobs.recover();
 if(config.jobs?.enabled)app.jobs.start();
 const expiry=setInterval(()=>store.expire().catch(()=>{}),30000);expiry.unref();
 let pruning=null;
 const retention=setInterval(async()=>{
  if(pruning)return;
  pruning=pruneArtifacts(store,config).catch(()=>{process.stderr.write('artifact_retention_failed\n');});
  try{await pruning;}finally{pruning=null;}
 },300000);retention.unref();
 await app.listen({host:'0.0.0.0',port:8788});
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{clearInterval(expiry);clearInterval(retention);await app.close();await pruning;await store.close();process.exit(0);});
}
