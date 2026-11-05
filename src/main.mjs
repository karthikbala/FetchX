import Fastify from 'fastify';
import {JobQueue} from './jobs.mjs';
import {fetchOnce,lookupFetch,publicProfiles} from './fetch.mjs';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {timingSafeEqual} from 'node:crypto';
import {Store} from './store.mjs';
import {Gateway} from './gateway.mjs';
import {profiles} from './profiles.mjs';
import {sha} from './crypto.mjs';
import {GatewayError} from './policy.mjs';
import {pruneArtifacts} from './artifacts.mjs';
import {gatewayStatus} from './status.mjs';
import {operationDiagnostics,recordOutcome} from './diagnostics.mjs';
import {registerV2} from './v2.mjs';
import {isPublicFetchRequest,publicFetchFailure,registerPublicFetch} from './v2-public-fetch.mjs';
import {isPublicRenderRequest,publicRenderFailure,registerPublicRender} from './v2-public-render.mjs';
import {safeFailure} from './v2-diagnostics.mjs';
import {publicConsoleRequest,registerConsole} from './console.mjs';
import {ControlIdentity} from './control-identity.mjs';
import {ControlCredits,TRIAL_CREDITS_PER_ACCOUNT,migrateAccountTrialCredits,reviewedCreditPolicy} from './control-credits.mjs';
import {ControlPaidCredits} from './control-paid-credits.mjs';
import {isControlRequest,registerControl} from './control.mjs';
import {ControlStripe,isStripeWebhookRequest,registerStripeWebhook} from './control-stripe.mjs';

// New self-service credentials have an explicit endpoint allowlist. Existing
// provisioned project tokens retain their established v1/v2 contract.
export function controlKeyScope(method,url){
 const path=url.split('?')[0];
 if(method==='GET'&&['/v2/capabilities','/v2/access-profiles','/v2/recipes'].includes(path))return 'profiles:read';
 if(method==='GET'&&path==='/v2/usage')return 'usage:read';
 if(method==='POST'&&['/v2/fetch','/v2/render'].includes(path))return 'fetch:write';
 if(method==='GET'&&(path==='/v2/operations'||/^\/v2\/render\/[^/]+$/.test(path)||/^\/v2\/(?:fetch|operations|artifacts)\/[^/]+(?:\/[^/]+)?$/.test(path)))return 'fetch:read';
 return null;
}
export function server(gateway,{stripeFetch,stripeAutoProcess=true}={}){
 if(gateway.config.controlPlane?.enabled===true){
  gateway.controlIdentity??=new ControlIdentity({store:gateway.store,config:gateway.config,mail:gateway.controlMail});
  gateway.controlCredits??=new ControlCredits({store:gateway.store,config:gateway.config});
 }
 const app=Fastify({logger:false,bodyLimit:24*1024*1024,requestTimeout:90000});
 const paidCredits=gateway.controlPaidCredits??new ControlPaidCredits({store:gateway.store,config:gateway.config});
 gateway.controlPaidCredits=paidCredits;
 const stripe=new ControlStripe({store:gateway.store,config:gateway.config,paidCredits,
  paidCreditReady:(project,options)=>app.v2.paidCreditReady(project,options),fetchStripe:stripeFetch});
 app.decorate('stripe',stripe);
 app.addHook('onRequest',async(req,reply)=>{
  if(req.url==='/healthz')return;
  if(publicConsoleRequest(req))return;
  if(isControlRequest(req)||isStripeWebhookRequest(req))return;
  const unauthorized=()=>{
   const error=new GatewayError('unauthorized',401);
   return reply.code(401).send(isPublicRenderRequest(req)?publicRenderFailure(error,{key:req.params?.key}):isPublicFetchRequest(req)?publicFetchFailure(error):{error:'unauthorized'});
  };
  const token=/^Bearer (\S+)$/i.exec(req.headers.authorization??'')?.[1];
  if(!token)return unauthorized();
  if(token.startsWith('fxk_')){
   if(!gateway.controlIdentity)return unauthorized();
   const principal=await gateway.controlIdentity.authenticateKey(token),scope=controlKeyScope(req.method,req.url);
   if(!scope||!principal.scopes.includes(scope))throw new GatewayError('api_key_scope_forbidden',403);
   req.project=principal.project;req.apiKeyId=principal.key_id;return;
  }
  const hash=Buffer.from(sha(token),'hex');
  for(const [id,p]of Object.entries(gateway.config.projects))if(typeof p.tokenHash==='string'&&/^[a-f0-9]{64}$/i.test(p.tokenHash)&&timingSafeEqual(hash,Buffer.from(p.tokenHash,'hex'))){req.project=id;return;}
  return unauthorized();
 });
 app.setErrorHandler((error,req,reply)=>{
  const clientError=error.validation||error.statusCode===400||error.statusCode===413||error.statusCode===415;
  const status=error instanceof GatewayError?error.status:clientError?(error.statusCode??400):500;
  if(isPublicRenderRequest(req))return reply.code(status).send(publicRenderFailure(error,{key:req.body?.idempotency_key??req.params?.key,status}));
  if(isPublicFetchRequest(req))return reply.code(status).send(publicFetchFailure(error,{key:req.body?.idempotency_key??req.params?.key,status}));
  reply.code(status).send({error:error instanceof GatewayError?error.code:clientError?'request_invalid':'internal_error',...(error instanceof GatewayError&&error.details?{details:error.details}:{}),...(req.url.startsWith('/v2/')?{diagnostics:safeFailure(error,'request_admission')}:{} )});
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
 registerV2(app,gateway);
 registerPublicFetch(app);
 registerPublicRender(app);
 registerConsole(app);
 registerControl(app,gateway,{identity:gateway.controlIdentity,credits:gateway.controlCredits,paidCredits,stripe});
 registerStripeWebhook(app,stripe,{autoProcess:stripeAutoProcess});
 return app;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const config=JSON.parse(await readFile(process.env.GATEWAY_CONFIG??'/run/secrets/gateway.json','utf8'));
 const store=new Store(process.env.DATABASE_URL);
 await store.acquireRunnerLock(()=>{process.stderr.write('gateway_ownership_lost\n');process.exit(1);});
 await store.init();await store.recover();
 for(const id of Object.keys(config.sourceProfiles??{}))if(Object.hasOwn(profiles,id))throw Error('profile_override_rejected');
 const gateway=new Gateway({store,config,profiles:{...profiles,...config.sourceProfiles}});
 const recovery=await gateway.recoverCaptures();
 if(recovery.invalid)process.stderr.write('capture_recovery_invalid\n');
 const app=server(gateway);
 if(config.controlPlane?.enabled===true&&config.controlPlane.creditPolicy?.reviewed===true&&
  (config.controlPlane.creditPolicy.trialCredits??TRIAL_CREDITS_PER_ACCOUNT)===TRIAL_CREDITS_PER_ACCOUNT){
  const trial=reviewedCreditPolicy(config);
  await migrateAccountTrialCredits(store,{targetCredits:trial.trialCredits,templateHash:gateway.controlIdentity.template().hash});
 }
 await app.jobs.recover();
 if(config.jobs?.enabled)app.jobs.start();
 const expiry=setInterval(()=>store.expire().catch(()=>{}),30000);expiry.unref();
 let pruning=null;
 const retention=setInterval(async()=>{
  if(pruning)return;
  pruning=pruneArtifacts(store,config).catch(()=>{process.stderr.write('artifact_retention_failed\n');});
  try{await pruning;}finally{pruning=null;}
 },300000);retention.unref();
 const port=process.env.GATEWAY_PORT===undefined?8788:Number(process.env.GATEWAY_PORT);
 if(!Number.isInteger(port)||port<1||port>65535)throw Error('gateway_port_invalid');
 await app.listen({host:process.env.GATEWAY_HOST??'0.0.0.0',port});
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{clearInterval(expiry);clearInterval(retention);await app.close();await pruning;await store.close();process.exit(0);});
}
