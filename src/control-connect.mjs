import {createHash,randomBytes,randomInt,randomUUID,timingSafeEqual} from 'node:crypto';
import {GatewayError,fail} from './policy.mjs';

const TTL=600;
export const CONNECT_INTERVAL=5;
const SCOPES=Object.freeze(['fetch:read','fetch:write','profiles:read']);
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const DEVICE_CODE=/^[A-Za-z0-9_-]{43}$/;
const USER_CODE=/^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const ALPHABET='ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const MAX_ATTEMPTS=5;
const INELIGIBLE=new Set(['project_not_found','project_disabled','project_template_changed','key_limit']);
const state=value=>({state:value});
const hash=value=>createHash('sha256').update(value,'utf8');
const idValid=value=>typeof value==='string'&&UUID.test(value);
const loopback=url=>['localhost','127.0.0.1','[::1]'].includes(url.hostname);

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
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((state IN ('approved','connected'))=(project IS NOT NULL)),
  CHECK((state='connected')=(key_id IS NOT NULL)),
  CHECK(state NOT IN ('approved','connected') OR user_id IS NOT NULL)
 );
 CREATE INDEX IF NOT EXISTS control_connect_expiry ON control_connect_requests(expires_at);
 `);
}

export class ControlConnect{
 constructor(identity){this.identity=identity;this.store=identity.store;}

 async start({client_name,origin,ip}){
  const input=this.identity.keyInput({name:client_name,scopes:SCOPES});
  await this.identity.rate([['connect-start-ip',this.identity.ip(ip),20,TTL]]);
  const request_id=randomUUID(),device_code=randomBytes(32).toString('base64url');
  const characters=Array.from({length:8},()=>ALPHABET[randomInt(ALPHABET.length)]).join('');
  const user_code=characters.slice(0,4)+'-'+characters.slice(4);
  await this.store.tx(async c=>{
   await c.query(`DELETE FROM control_connect_requests WHERE id IN (SELECT id FROM control_connect_requests
    WHERE expires_at<statement_timestamp()-interval '1 day' ORDER BY expires_at LIMIT 64 FOR UPDATE SKIP LOCKED)`);
   await c.query(`INSERT INTO control_connect_requests(id,origin,client_name,device_hash,user_code_hash,expires_at)
    VALUES($1,$2,$3,$4,$5,clock_timestamp()+$6*interval '1 second')`,
    [request_id,origin,input.name,hash(device_code).digest('hex'),this.userCodeHash(request_id,user_code),TTL]);
  });
  return {request_id,device_code,user_code,verification_uri:`${origin}/connect#${request_id}`,expires_in:TTL,interval:CONNECT_INTERVAL};
 }

 userCodeHash(id,code){return this.identity.digest('connect-user-code',`${id}\0${code}`);}

 async review({request_id,origin,userId,ip}){
  await this.identity.rate([['connect-review-ip',this.identity.ip(ip),120,TTL],['connect-review-user',userId,120,TTL]]);
  if(!idValid(request_id))fail('connect_not_found',404);
  const row=(await this.store.pool.query(`SELECT client_name,expires_at,
   CASE WHEN state IN ('pending','approved') AND expires_at<=clock_timestamp() THEN 'expired' ELSE state END AS state
   FROM control_connect_requests WHERE id=$1 AND origin=$2 AND (user_id IS NULL OR user_id=$3)`,[request_id,origin,userId])).rows[0];
  if(!row)fail('connect_not_found',404);
  return {...row,scopes:SCOPES};
 }

 async decision({request_id,user_code,decision,project_id,origin,userId,ip}){
  await this.identity.rate([['connect-decision-ip',this.identity.ip(ip),60,TTL],['connect-decision-user',userId,20,TTL]]);
  if(!idValid(request_id))fail('connect_not_found',404);
  if(!(decision==='approve'&&typeof project_id==='string'||decision==='deny'&&project_id===undefined))fail('request_invalid');
  const chosen=decision==='approve'?'approved':'denied',project=project_id??null;
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
    if(row.user_id===userId&&row.project===project&&(row.state===chosen||row.state==='connected'&&chosen==='approved'))return state(chosen);
    fail('connect_request_closed',409);
   }
   if(chosen==='approved')await this.identity.assertCanCreateKey(c,userId,project);
   const updated=await c.query(`UPDATE control_connect_requests SET state=$2,project=$3,user_id=$4
    WHERE id=$1 AND expires_at>clock_timestamp()`,[row.id,chosen,project,userId]);
   if(!updated.rowCount)fail('connect_request_closed',409);
   return state(chosen);
  });
  if(!result)fail('connect_code_invalid');
  return result;
 }

 async expired(c,id){
  return (await c.query('SELECT expires_at<=clock_timestamp() AS expired FROM control_connect_requests WHERE id=$1',[id])).rows[0].expired;
 }

 async claim({request_id,device_code,origin,apiBaseUrl,ip}){
  await this.identity.rate([['connect-claim-ip',this.identity.ip(ip),600,TTL]]);
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
      const key=await this.identity.createKeyInTransaction(c,row.user_id,row.project,{name:row.client_name,scopes:SCOPES},token);
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
    return {state:'connected',project_id:row.project,key_id:keyId,api_base_url:apiBaseUrl};
   });
  }catch(error){
   if(error instanceof GatewayError&&error.code==='connect_expired')return state('expired');
   throw error;
  }
 }
}
