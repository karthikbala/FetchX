import {createHash,randomBytes,randomInt,randomUUID,timingSafeEqual} from 'node:crypto';
import {GatewayError,fail} from './policy.mjs';

// A request lasts 20 minutes, time for a new user to sign up and approve. The
// device code is 256 bits and the user code allows 5 tries, so a longer window
// does not make either easier to guess.
const TTL=1200;
const RATE_WINDOW=600;
export const CONNECT_INTERVAL=5;
const SCOPES=Object.freeze(['fetch:read','fetch:write','usage:read']);
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const DEVICE_CODE=/^[A-Za-z0-9_-]{43}$/;
const USER_CODE=/^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const ALPHABET='ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const MAX_ATTEMPTS=5;
const INELIGIBLE=new Set(['project_not_found','project_disabled','project_template_changed','key_limit']);
const LIMIT_FIELDS=Object.freeze(['credits_per_day','credits_per_month','expires_at','expires_in_days']);
const NO_LIMITS=Object.freeze({credits_per_day:null,credits_per_month:null,expires_at:null});
const state=value=>({state:value});
const hash=value=>createHash('sha256').update(value,'utf8');
const idValid=value=>typeof value==='string'&&UUID.test(value);
const loopback=url=>['localhost','127.0.0.1','[::1]'].includes(url.hostname);
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
// Stored limits ({credits_per_day, credits_per_month, expires_at}) as the
// key's columns (control-identity insertKey).
const keyColumns=limits=>({credit_limit_day:limits?.credits_per_day??null,credit_limit_month:limits?.credits_per_month??null,expires_at:limits?.expires_at??null});
const limitsOf=value=>plain(value)?{credits_per_day:value.credits_per_day??null,credits_per_month:value.credits_per_month??null,expires_at:value.expires_at??null}:{...NO_LIMITS};

export function connectApiBase(config,origin){
 if(config.enabled!==true||config.agentConnectEnabled!==true||!Array.isArray(config.origins)||!config.origins.includes(origin)||typeof config.apiBaseUrl!=='string')return null;
 try{
  const site=new URL(origin),api=new URL(config.apiBaseUrl);
  const local=config.allowLoopbackDevelopment===true&&loopback(site)&&loopback(api)&&['http:','https:'].includes(site.protocol)&&['http:','https:'].includes(api.protocol);
  const secure=site.protocol==='https:'&&api.protocol==='https:'&&!loopback(site)&&!loopback(api);
  if((local||secure)&&site.origin===origin&&(config.apiBaseUrl===api.origin||config.apiBaseUrl===api.origin+'/'))return api.origin;
 }catch{}
 return null;
}

export async function initControlConnect(pool){
 await pool.query(`
 CREATE TABLE IF NOT EXISTS control_connect_requests(
  id uuid PRIMARY KEY,
  origin text NOT NULL,
  client_name text NOT NULL,
  device_hash text NOT NULL CHECK(device_hash ~ '^[a-f0-9]{64}$'),
  user_code_hash text NOT NULL CHECK(user_code_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','denied','connected')),
  attempts int NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND ${MAX_ATTEMPTS}),
  user_id uuid REFERENCES control_users(id) ON DELETE CASCADE,
  project text REFERENCES control_projects(id) ON DELETE CASCADE,
  key_id uuid REFERENCES control_keys(id) ON DELETE CASCADE,
  last_poll_at timestamptz,
  requested_limits jsonb,
  key_limits jsonb,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((state IN ('approved','connected'))=(project IS NOT NULL)),
  CHECK((state='connected')=(key_id IS NOT NULL)),
  CHECK(state NOT IN ('approved','connected') OR user_id IS NOT NULL)
 );
 CREATE INDEX IF NOT EXISTS control_connect_expiry ON control_connect_requests(expires_at);
 ALTER TABLE control_connect_requests ADD COLUMN IF NOT EXISTS requested_limits jsonb;
 ALTER TABLE control_connect_requests ADD COLUMN IF NOT EXISTS key_limits jsonb;
 `);
}

export class ControlConnect{
 constructor(identity){this.identity=identity;this.store=identity.store;}

 // The limits a client asks for on the key ({credits_per_day, credits_per_month,
 // expires_at or expires_in_days}), checked like a console key's. The user
 // sees them on the approval page and may change or remove them.
 limitsInput(value,{relative=false}={}){
  if(value===undefined||value===null)return {...NO_LIMITS};
  if(!plain(value)||Object.keys(value).some(k=>!(relative?LIMIT_FIELDS:LIMIT_FIELDS.slice(0,3)).includes(k)))fail('key_limits_invalid');
  let {expires_in_days:days,...limits}=value;
  if(days!==undefined&&days!==null){
   if(limits.expires_at!==undefined&&limits.expires_at!==null)fail('key_limits_invalid');
   if(!Number.isSafeInteger(days)||days<1||days>1825)fail('key_expiry_invalid');
   limits.expires_at=new Date(Date.now()+days*86400_000).toISOString();
  }
  const checked=this.identity.keyInput({name:'Connect',scopes:SCOPES,limits});
  return {credits_per_day:checked.credit_limit_day,credits_per_month:checked.credit_limit_month,expires_at:checked.expires_at};
 }

 async start({client_name,limits,origin,ip}){
  const input=this.identity.keyInput({name:client_name,scopes:SCOPES});
  const requested=this.limitsInput(limits,{relative:true});
  await this.identity.rate([['connect-start-ip',this.identity.ip(ip),20,RATE_WINDOW]]);
  const request_id=randomUUID(),device_code=randomBytes(32).toString('base64url');
  const characters=Array.from({length:8},()=>ALPHABET[randomInt(ALPHABET.length)]).join('');
  const user_code=characters.slice(0,4)+'-'+characters.slice(4);
  await this.store.tx(async c=>{
   await c.query(`DELETE FROM control_connect_requests WHERE id IN (SELECT id FROM control_connect_requests
    WHERE expires_at<statement_timestamp()-interval '1 day' ORDER BY expires_at LIMIT 64 FOR UPDATE SKIP LOCKED)`);
   await c.query(`INSERT INTO control_connect_requests(id,origin,client_name,device_hash,user_code_hash,requested_limits,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+$7*interval '1 second')`,
    [request_id,origin,input.name,hash(device_code).digest('hex'),this.userCodeHash(request_id,user_code),JSON.stringify(requested),TTL]);
  });
  // verification_uri_complete (RFC 8628 3.3.1) carries the user code in the
  // fragment, which browsers never send to a server. The page shows it and asks
  // the user to check that their tool shows the same code.
  return {request_id,device_code,user_code,verification_uri:`${origin}/connect#${request_id}`,
   verification_uri_complete:`${origin}/connect#${request_id}&code=${user_code}`,expires_in:TTL,interval:CONNECT_INTERVAL,limits:requested};
 }

 userCodeHash(id,code){return this.identity.digest('connect-user-code',`${id}\0${code}`);}

 // What the user reviews: the client, the scopes, and the limits requested
 // (or, once approved, the limits the user approved).
 async review({request_id,origin,userId,ip}){
  await this.identity.rate([['connect-review-ip',this.identity.ip(ip),120,RATE_WINDOW],['connect-review-user',userId,120,RATE_WINDOW]]);
  if(!idValid(request_id))fail('connect_not_found',404);
  const row=(await this.store.pool.query(`SELECT client_name,expires_at,COALESCE(key_limits,requested_limits) AS limits,
   CASE WHEN state IN ('pending','approved') AND expires_at<=clock_timestamp() THEN 'expired' ELSE state END AS state
   FROM control_connect_requests WHERE id=$1 AND origin=$2 AND (user_id IS NULL OR user_id=$3)`,[request_id,origin,userId])).rows[0];
  if(!row)fail('connect_not_found',404);
  return {state:row.state,client_name:row.client_name,scopes:SCOPES,expires_at:row.expires_at,limits:limitsOf(row.limits)};
 }

 // Approve for an existing project (project_id) or for a new one created here
 // (project_name), with the limits the user approved (limits; left out: the
 // ones requested). Or deny.
 async decision({request_id,user_code,decision,project_id,project_name,limits,origin,userId,ip}){
  await this.identity.rate([['connect-decision-ip',this.identity.ip(ip),60,RATE_WINDOW],['connect-decision-user',userId,20,RATE_WINDOW]]);
  if(!idValid(request_id))fail('connect_not_found',404);
  const approving=decision==='approve'&&(typeof project_id==='string')!==(typeof project_name==='string')&&(project_id===undefined||project_name===undefined);
  if(!(approving||decision==='deny'&&project_id===undefined&&project_name===undefined&&limits===undefined))fail('request_invalid');
  const chosen=decision==='approve'?'approved':'denied';
  const approved=approving&&limits!==undefined?this.limitsInput(limits):null;
  let created=null;
  const result=await this.store.tx(async c=>{
   const row=(await c.query(`SELECT * FROM control_connect_requests
    WHERE id=$1 AND origin=$2 AND (user_id IS NULL OR user_id=$3) FOR UPDATE`,[request_id,origin,userId])).rows[0];
   if(!row)fail('connect_not_found',404);
   if(await this.expired(c,row.id))fail('connect_request_closed',409);
   const codeValid=typeof user_code==='string'&&USER_CODE.test(user_code)&&timingSafeEqual(Buffer.from(row.user_code_hash,'hex'),Buffer.from(this.userCodeHash(row.id,user_code),'hex'));
   if(!codeValid||row.attempts>=MAX_ATTEMPTS){
    if(row.state==='pending')await c.query(`UPDATE control_connect_requests SET attempts=attempts+1,
     state=CASE WHEN attempts+1=$2 THEN 'denied' ELSE state END WHERE id=$1`,[row.id,MAX_ATTEMPTS]);
    return null;
   }
   if(row.state!=='pending'){
    // A repeated decision (a retry after a lost answer) gets the same answer.
    const same=project_name===undefined?row.project===(project_id??null)
     :row.project!==null&&(await c.query('SELECT name FROM control_projects WHERE id=$1',[row.project])).rows[0]?.name===project_name.trim();
    if(row.user_id===userId&&same&&(row.state===chosen||row.state==='connected'&&chosen==='approved'))return state(chosen);
    fail('connect_request_closed',409);
   }
   let project=project_id??null;
   if(chosen==='approved'&&project_name!==undefined){
    created=await this.identity.createProjectInTransaction(c,userId,{name:project_name});
    project=created.id;
   }
   if(chosen==='approved')await this.identity.assertCanCreateKey(c,userId,project);
   const keyLimits=chosen==='approved'?JSON.stringify(approved??limitsOf(row.requested_limits)):null;
   const updated=await c.query(`UPDATE control_connect_requests SET state=$2,project=$3,user_id=$4,key_limits=$5
    WHERE id=$1 AND expires_at>clock_timestamp()`,[row.id,chosen,project,userId,keyLimits]);
   if(!updated.rowCount)fail('connect_request_closed',409);
   return state(chosen);
  });
  if(!result)fail('connect_code_invalid');
  if(created)await this.identity.hydrateProject(created.id);
  return result;
 }

 async expired(c,id){
  return (await c.query('SELECT expires_at<=clock_timestamp() AS expired FROM control_connect_requests WHERE id=$1',[id])).rows[0].expired;
 }

 async claim({request_id,device_code,origin,apiBaseUrl,ip}){
  await this.identity.rate([['connect-claim-ip',this.identity.ip(ip),600,RATE_WINDOW]]);
  if(!idValid(request_id)||typeof device_code!=='string'||!DEVICE_CODE.test(device_code))fail('connect_not_found',404);
  try{
   return await this.store.tx(async c=>{
    const row=(await c.query(`SELECT * FROM control_connect_requests
     WHERE id=$1 AND origin=$2 AND device_hash=$3 FOR UPDATE`,[request_id,origin,hash(device_code).digest('hex')])).rows[0];
    if(!row)fail('connect_not_found',404);
    if(await this.expired(c,row.id))return state('expired');
    if(row.state==='denied')return state('denied');
    if(row.state==='pending'){
     const polled=await c.query(`UPDATE control_connect_requests SET last_poll_at=clock_timestamp()
      WHERE id=$1 AND (last_poll_at IS NULL OR last_poll_at<=clock_timestamp()-$2*interval '1 second')`,[row.id,CONNECT_INTERVAL]);
     if(!polled.rowCount)fail('connect_slow_down',429);
     return state('pending');
    }
    let keyId=row.key_id;
    try{
     if(row.state==='connected'){
      await this.identity.projectRow(row.user_id,row.project,c,{lock:true});
      const active=await c.query('SELECT id FROM control_keys WHERE id=$1 AND project=$2 AND revoked_at IS NULL FOR SHARE',[keyId,row.project]);
      if(!active.rowCount)return state('denied');
      if(await this.expired(c,row.id))return state('expired');
     }else{
      const token='fxk_'+hash('fetchx-connect-key-v1\0'+device_code).digest('base64url');
      const key=await this.identity.createKeyInTransaction(c,row.user_id,row.project,{name:row.client_name,scopes:SCOPES,...keyColumns(row.key_limits)},token);
      const updated=await c.query(`UPDATE control_connect_requests SET state='connected',key_id=$2
       WHERE id=$1 AND expires_at>clock_timestamp()`,[row.id,key.id]);
      // If the project lock outlasted the request, roll back the key insert too.
      if(!updated.rowCount)fail('connect_expired');
      keyId=key.id;
     }
    }catch(error){
     if(!(error instanceof GatewayError)||!INELIGIBLE.has(error.code))throw error;
     if(await this.expired(c,row.id))return state('expired');
     if(row.state==='approved')await c.query("UPDATE control_connect_requests SET state='denied',project=NULL WHERE id=$1",[row.id]);
     return state('denied');
    }
    return {state:'connected',project_id:row.project,key_id:keyId,api_base_url:apiBaseUrl,limits:limitsOf(row.key_limits)};
   });
  }catch(error){
   if(error instanceof GatewayError&&error.code==='connect_expired')return state('expired');
   throw error;
  }
 }
}
