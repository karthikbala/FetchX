// Solver API credentials never enter a page or the browser worker. Each paid
// create is preceded by a durable reservation; uncertain creates are not retried.
import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {fail,GatewayError} from './policy.mjs';
export const CAPTCHA_TYPES=Object.freeze(['recaptcha_v2','turnstile']);
const selector=s=>typeof s==='string'&&s.length>0&&s.length<=512;
export function validateCaptchaProfile(p){
 const c=p.captcha;if(c===undefined)return;
 if(!c||typeof c!=='object'||Array.isArray(c)||Object.keys(c).some(k=>!['type','websiteURL','siteKey','triggerSelector','widgetSelector','responseSelector','submitSelector','successSelector','isInvisible'].includes(k))||p.execution!=='browser'||!CAPTCHA_TYPES.includes(c.type))fail('captcha_profile_invalid',500);
 let url;try{url=new URL(c.websiteURL);}catch{fail('captcha_profile_invalid',500);}
 if(typeof c.websiteURL!=='string'||c.websiteURL.length>12000||url.protocol!=='https:'||url.username||url.password||url.hash||url.port||!p.hosts.includes(url.hostname)||typeof c.siteKey!=='string'||!/^[a-zA-Z0-9_-]{10,200}$/.test(c.siteKey))fail('captcha_profile_invalid',500);
 for(const key of ['triggerSelector','widgetSelector','responseSelector','submitSelector','successSelector'])if(!selector(c[key]))fail('captcha_profile_invalid',500);
 if(c.isInvisible!==undefined&&typeof c.isInvisible!=='boolean')fail('captcha_profile_invalid',500);
}
export async function initCaptcha(pool){await pool.query(`
 CREATE TABLE IF NOT EXISTS captcha_tasks(id uuid PRIMARY KEY,attempt uuid NOT NULL REFERENCES attempts(id),operation uuid NOT NULL REFERENCES operations(id),workflow uuid NOT NULL UNIQUE REFERENCES workflows(id),project text NOT NULL,type text NOT NULL,provider_task_id text,state text NOT NULL DEFAULT 'reserved',reserved_micro_usd bigint NOT NULL,actual_micro_usd bigint,error text,verification text NOT NULL DEFAULT 'not_submitted',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
 CREATE INDEX IF NOT EXISTS captcha_tasks_project_created ON captcha_tasks(project,created_at);
`);}
export function microUsd(value){
 if(typeof value!=='string'||!/^\d{1,6}(?:\.\d{1,6})?$/.test(value))fail('captcha_cost_unverified',502);
 const [whole,fraction='']=value.split('.');return Number(whole)*1000000+Number(fraction.padEnd(6,'0'));
}
const bounded=(value,max)=>{if(!Number.isSafeInteger(value)||value<1||value>max)fail('captcha_budget_unconfigured',503);return value;};
export class CaptchaSolver {
 constructor(store,config,{fetchImpl=fetch,wait=sleep,now=Date.now}={}){Object.assign(this,{store,config,fetchImpl,wait,now});}
 async post(method,body,signal){
  try{
   const r=await this.fetchImpl('https://api.2captcha.com/'+method,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify({clientKey:this.config.captcha.apiKey,...body}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});
   if(!r.ok)throw Error();
   let raw='',bytes=0;for await(const chunk of r.body){bytes+=chunk.length;if(bytes>65536)throw Error();raw+=Buffer.from(chunk).toString('utf8');}
   const data=JSON.parse(raw);if(!data||!Number.isInteger(data.errorId)||data.errorId<0)throw Error();return data;
  }catch{fail('captcha_provider_outcome_unknown',502);}
 }
 async reserve(w,attempt,operation,candidate){
  const settings=this.config.captcha,c=w.config.captcha;validateCaptchaProfile(w.config);
  if(!settings?.enabled||!settings.apiKey)fail('captcha_solver_unavailable',503);
  if(!c||!candidate||Object.keys(candidate).some(k=>!['type','websiteURL','siteKey','userAgent'].includes(k))||candidate.type!==c.type||candidate.siteKey!==c.siteKey||candidate.websiteURL!==c.websiteURL||typeof candidate.userAgent!=='string'||candidate.userAgent.length>512||/[\r\n]/.test(candidate.userAgent))fail('captcha_identity_mismatch');
  const maximum=bounded(settings.maxTaskMicroUsd,20000),daily=bounded(settings.maxDailyMicroUsd,5000000),total=bounded(settings.maxTotalMicroUsd,20000000),tasks=bounded(settings.maxTotalTasks,10000);
  return this.store.tx(async db=>{
   await db.query('SELECT pg_advisory_xact_lock(1009)');
   if((await db.query('SELECT 1 FROM captcha_tasks WHERE workflow=$1',[w.id])).rowCount)fail('captcha_already_attempted',409);
   const current=(await db.query("SELECT 1 FROM attempts a JOIN workflows w ON w.id=a.workflow WHERE a.id=$1 AND a.operation=$2 AND a.workflow=$3 AND w.project=$4 AND a.state='sent' AND w.state='open' AND w.expires_at>now()",[attempt,operation,w.id,w.project])).rowCount;
   if(!current)fail('captcha_session_closed',409);
   if((await db.query("SELECT 1 FROM captcha_tasks WHERE error IN ('captcha_account_rejected','captcha_cost_overrun') LIMIT 1")).rowCount)fail('captcha_account_held',409);
   const used=(await db.query("SELECT count(*)::int tasks,coalesce(sum(coalesce(actual_micro_usd,reserved_micro_usd)),0)::text total,coalesce(sum(coalesce(actual_micro_usd,reserved_micro_usd)) FILTER(WHERE created_at>now()-interval '24 hours'),0)::text daily,coalesce(sum(coalesce(actual_micro_usd,reserved_micro_usd)) FILTER(WHERE project=$1 AND created_at>now()-interval '24 hours'),0)::text project FROM captcha_tasks",[w.project])).rows[0];
   if(used.tasks>=tasks||Number(used.total)+maximum>total||Number(used.daily)+maximum>daily||Number(used.project)+maximum>bounded(this.config.projects[w.project].maxDailyCaptchaMicroUsd??daily,5000000))fail('captcha_budget_exhausted',429);
   const id=randomUUID();await db.query('INSERT INTO captcha_tasks(id,attempt,operation,workflow,project,type,reserved_micro_usd) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,attempt,operation,w.id,w.project,c.type,maximum]);return {id,maximum};
  });
 }
 async solve(w,attempt,operation,candidate,{signal}={}){
  if(signal?.aborted)fail('captcha_session_closed',409);
  const reservation=await this.reserve(w,attempt,operation,candidate),c=w.config.captcha;
  const task={type:c.type==='recaptcha_v2'?'RecaptchaV2TaskProxyless':'TurnstileTaskProxyless',websiteURL:c.websiteURL,websiteKey:c.siteKey,...(c.type==='recaptcha_v2'?{isInvisible:c.isInvisible??false,userAgent:candidate.userAgent}:{})};
  let state='unknown',actual=null,error=null;
  try{
   const created=await this.post('createTask',{task},signal);
   if(created.errorId){state='rejected';actual=0;fail(['ERROR_KEY_DOES_NOT_EXIST','ERROR_ZERO_BALANCE','ERROR_ACCOUNT_SUSPENDED','ERROR_IP_NOT_ALLOWED'].includes(created.errorCode)?'captcha_account_rejected':'captcha_task_rejected',503);}
   if(!Number.isSafeInteger(created.taskId)||created.taskId<=0)fail('captcha_provider_outcome_unknown',502);
   await this.store.pool.query("UPDATE captcha_tasks SET provider_task_id=$2,state='processing',updated_at=now() WHERE id=$1",[reservation.id,String(created.taskId)]);
   const timeout=bounded(this.config.captcha.timeoutMs??120000,120000),deadline=this.now()+timeout;
   while(this.now()<deadline){
    if(signal?.aborted)fail('captcha_session_closed',409);
    await this.wait(5000,undefined,{signal});if(this.now()>=deadline)break;
    const data=await this.post('getTaskResult',{taskId:created.taskId},signal);
    if(data.errorId)fail('captcha_solver_failed',502);
    if(data.status==='processing')continue;
    if(data.status!=='ready')fail('captcha_provider_outcome_unknown',502);
    actual=microUsd(data.cost);state='ready';
    if(actual>reservation.maximum)fail('captcha_cost_overrun',503);
    const token=data.solution?.[c.type==='recaptcha_v2'?'gRecaptchaResponse':'token'];
    if(typeof token!=='string'||!/^\S{20,16384}$/.test(token))fail('captcha_solution_invalid',502);
    return {token,id:reservation.id,provider:'2captcha',type:c.type,cost_micro_usd:actual};
   }
   fail('captcha_timeout',504);
  }catch(e){error=e instanceof GatewayError?e.code:'captcha_provider_outcome_unknown';throw new GatewayError(error,e instanceof GatewayError?e.status:502);}
  finally{await this.store.pool.query('UPDATE captcha_tasks SET state=$2,actual_micro_usd=$3,error=$4,updated_at=now() WHERE id=$1',[reservation.id,state,actual,error]);}
 }
 async report(w,attempt,verification){
  if(!['submitted','verified','rejected','unknown'].includes(verification))fail('captcha_report_invalid');
  await this.store.pool.query("UPDATE captcha_tasks SET verification=$3,updated_at=now() WHERE workflow=$1 AND attempt=$2 AND state='ready' AND verification NOT IN ('verified','rejected')",[w.id,attempt,verification]);
 }
 async reconcile(id){
  if(typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id))fail('captcha_reconciliation_invalid');
  const row=(await this.store.pool.query('SELECT * FROM captcha_tasks WHERE id=$1',[id])).rows[0];
  if(!row||row.state!=='unknown'||!row.provider_task_id||row.actual_micro_usd!==null)fail('captcha_reconciliation_rejected',409);
  const data=await this.post('getTaskResult',{taskId:Number(row.provider_task_id)});
  if(data.errorId)fail('captcha_reconciliation_unverified',502);
  if(data.status==='processing')return {state:'processing',redispatched:false};
  if(data.status!=='ready')fail('captcha_reconciliation_unverified',502);
  const cost=microUsd(data.cost),error=cost>Number(row.reserved_micro_usd)?'captcha_cost_overrun':'captcha_solution_not_applied';
  await this.store.pool.query("UPDATE captcha_tasks SET state='reconciled',actual_micro_usd=$2,error=$3,updated_at=now() WHERE id=$1 AND state='unknown' AND actual_micro_usd IS NULL",[id,cost,error]);
  return {state:'reconciled',cost_micro_usd:cost,redispatched:false,solution_applied:false};
 }
 async recover(){await this.store.pool.query("UPDATE captcha_tasks SET state='unknown',error='captcha_interrupted_unknown',updated_at=now() WHERE state IN ('reserved','processing')");}
}
export async function captchaStatus(pool,config,project){
 const usage=(await pool.query("SELECT type,state,verification,count(*)::int tasks,sum(coalesce(actual_micro_usd,reserved_micro_usd))::text accounted_micro_usd,sum(actual_micro_usd)::text known_micro_usd FROM captcha_tasks WHERE ($1::text IS NULL OR project=$1) GROUP BY type,state,verification",[project])).rows;
 return {configured:!!config.captcha?.enabled&&!!config.captcha?.apiKey,supported_types:CAPTCHA_TYPES,usage,billing_basis:'known_solver_cost_or_retained_reservation',scope:'FetchX_only_not_other_account_consumers'};
}
