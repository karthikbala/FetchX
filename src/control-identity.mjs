import {createHash,createHmac,randomBytes,randomInt,randomUUID,timingSafeEqual} from 'node:crypto';
import {fail} from './policy.mjs';
import {createControlMail} from './control-mail.mjs';
import {TRIAL_CREDITS_PER_ACCOUNT,grantAccountTrialCredits,grantInitialCredits,reviewedCreditPolicy} from './control-credits.mjs';
import {initPlayground} from './control-playground.mjs';
import {createControlGoogle,googleConfiguration} from './control-google.mjs';
import {createControlGithub,githubConfiguration,githubSettings,githubAuthorizationUrl} from './control-github.mjs';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const PROJECT=/^cp_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SCOPES=Object.freeze(['fetch:read','fetch:write','usage:read','profiles:read']);
const TTL=600,SESSION_TTL=7*86400,GOOGLE_TTL=300,GITHUB_TTL=300;
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const hash=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>JSON.stringify(sort(value));
function sort(value){return Array.isArray(value)?value.map(sort):plain(value)?Object.fromEntries(Object.keys(value).sort().map(k=>[k,sort(value[k])])):value;}
function emailAddress(value){
 if(typeof value!=='string')fail('email_invalid');
 const email=value.trim().toLowerCase();
 if(email.length>254||! /^[a-z0-9.!#$%&'*+\-/=?^_`{|}~]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(email)||email.split('@')[0].length>64||email.includes('..'))fail('email_invalid');
 return email;
}
function label(value,code){if(typeof value!=='string'||!value.trim()||value.trim().length>80||/[\u0000-\u001f\u007f]/.test(value))fail(code);return value.trim();}
const userView=row=>({id:row.id,email:row.email});
const projectView=row=>({id:row.id,name:row.name,status:row.status,created_at:row.created_at});
const keyView=row=>({id:row.id,project:row.project,name:row.name,prefix:row.prefix,scopes:row.scopes,created_at:row.created_at,last_used_at:row.last_used_at,revoked_at:row.revoked_at});
const tokenValid=(token,prefix)=>typeof token==='string'&&new RegExp(`^${prefix}_[A-Za-z0-9_-]{43}$`).test(token);
const tokenFor=prefix=>`${prefix}_${randomBytes(32).toString('base64url')}`;
const equalDigest=(left,right)=>typeof left==='string'&&typeof right==='string'&&/^[a-f0-9]{64}$/.test(left)&&/^[a-f0-9]{64}$/.test(right)&&timingSafeEqual(Buffer.from(left,'hex'),Buffer.from(right,'hex'));

export async function initControlIdentity(pool){await pool.query(`
 CREATE TABLE IF NOT EXISTS control_users(id uuid PRIMARY KEY,email text NOT NULL UNIQUE,verified_at timestamptz NOT NULL DEFAULT now(),created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS control_codes(id uuid PRIMARY KEY,email_hash text NOT NULL,code_hash text NOT NULL,attempts int NOT NULL DEFAULT 0 CHECK(attempts>=0),expires_at timestamptz NOT NULL,consumed_at timestamptz,created_at timestamptz NOT NULL DEFAULT now());
 CREATE INDEX IF NOT EXISTS control_codes_email_created ON control_codes(email_hash,created_at);
 CREATE TABLE IF NOT EXISTS control_sessions(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES control_users(id),token_hash text NOT NULL UNIQUE,expires_at timestamptz NOT NULL,revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT now());
 CREATE INDEX IF NOT EXISTS control_sessions_user ON control_sessions(user_id);
 CREATE TABLE IF NOT EXISTS control_projects(id text PRIMARY KEY,user_id uuid NOT NULL REFERENCES control_users(id),name text NOT NULL,template_hash text NOT NULL,status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS control_memberships(user_id uuid NOT NULL REFERENCES control_users(id),project text NOT NULL REFERENCES control_projects(id),role text NOT NULL DEFAULT 'owner' CHECK(role IN ('owner')),created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,project));
 CREATE INDEX IF NOT EXISTS control_memberships_project ON control_memberships(project);
 CREATE TABLE IF NOT EXISTS control_keys(id uuid PRIMARY KEY,project text NOT NULL REFERENCES control_projects(id),name text NOT NULL,prefix text NOT NULL,token_hash text NOT NULL UNIQUE,scopes jsonb NOT NULL CHECK(jsonb_typeof(scopes)='array'),created_at timestamptz NOT NULL DEFAULT now(),last_used_at timestamptz,revoked_at timestamptz);
 CREATE INDEX IF NOT EXISTS control_keys_project_created ON control_keys(project,created_at,id);
 CREATE TABLE IF NOT EXISTS control_rates(bucket text PRIMARY KEY,attempts int NOT NULL CHECK(attempts>0),expires_at timestamptz NOT NULL);
 CREATE INDEX IF NOT EXISTS control_rates_expiry ON control_rates(expires_at);
 CREATE TABLE IF NOT EXISTS control_google_challenges(id uuid PRIMARY KEY,client_id text NOT NULL,nonce_hash text NOT NULL CHECK(nonce_hash ~ '^[a-f0-9]{64}$'),binding_hash text NOT NULL CHECK(binding_hash ~ '^[a-f0-9]{64}$'),attempts int NOT NULL DEFAULT 0 CHECK(attempts>=0 AND attempts<=5),expires_at timestamptz NOT NULL,consumed_at timestamptz,created_at timestamptz NOT NULL DEFAULT now());
 CREATE INDEX IF NOT EXISTS control_google_challenges_expiry ON control_google_challenges(expires_at);
 CREATE INDEX IF NOT EXISTS control_google_challenges_binding ON control_google_challenges(binding_hash);
 CREATE TABLE IF NOT EXISTS control_google_identities(issuer text NOT NULL CHECK(issuer='https://accounts.google.com'),subject text NOT NULL CHECK(char_length(subject) BETWEEN 1 AND 255),user_id uuid NOT NULL UNIQUE REFERENCES control_users(id),created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(issuer,subject));
 CREATE TABLE IF NOT EXISTS control_github_challenges(id uuid PRIMARY KEY,state_hash text NOT NULL UNIQUE CHECK(state_hash ~ '^[a-f0-9]{64}$'),binding_hash text NOT NULL CHECK(binding_hash ~ '^[a-f0-9]{64}$'),client_id text NOT NULL,redirect_uri text NOT NULL,mode text NOT NULL CHECK(mode IN ('login','link')),user_id uuid REFERENCES control_users(id),session_id uuid REFERENCES control_sessions(id),expires_at timestamptz NOT NULL,consumed_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),CHECK((mode='login' AND user_id IS NULL AND session_id IS NULL) OR (mode='link' AND user_id IS NOT NULL AND session_id IS NOT NULL)));
 CREATE INDEX IF NOT EXISTS control_github_challenges_expiry ON control_github_challenges(expires_at);
 CREATE INDEX IF NOT EXISTS control_github_challenges_binding ON control_github_challenges(binding_hash);
 CREATE TABLE IF NOT EXISTS control_github_identities(subject text PRIMARY KEY CHECK(subject ~ '^[1-9][0-9]{0,15}$'),user_id uuid NOT NULL UNIQUE REFERENCES control_users(id),created_at timestamptz NOT NULL DEFAULT now());
 `);
 await initPlayground(pool);
}

export class ControlIdentity{
 constructor({store,config,mail,google,github}){Object.assign(this,{store,config});this.mail=mail??createControlMail(config);this.google=google??createControlGoogle();this.github=github??createControlGithub();}
 get mailConfigured(){return this.mail?.configured===true&&typeof this.mail.sendCode==='function';}
 googleStatus(){return googleConfiguration(this.config);}
 googleSettings(){const value=this.googleStatus();if(!value.enabled)fail('google_disabled',503);return value;}
 githubStatus(){return githubConfiguration(this.config);}
 githubSettings(){const value=githubSettings(this.config);if(!value)fail('github_disabled',503);return value;}
 enabled(){return this.config.controlPlane?.enabled===true;}
 settings(){
  const control=this.config.controlPlane;if(!this.enabled())fail('control_unavailable',503);
  if(typeof control.bridgeSecret!=='string'||Buffer.byteLength(control.bridgeSecret)<32)fail('control_configuration',503);
  return control;
 }
 digest(domain,value){return createHmac('sha256',this.settings().bridgeSecret).update(`${domain}\0${value}`).digest('hex');}
 template(){
  const raw=this.settings().projectTemplate;
  if(!plain(raw)||Object.keys(raw).some(k=>!['id','v2_access_profiles','v2_entitlement','v2_discovery_policy'].includes(k))||typeof raw.id!=='string'||!/^[A-Za-z0-9_.:-]{1,100}$/.test(raw.id)||!Array.isArray(raw.v2_access_profiles)||raw.v2_access_profiles.some(k=>typeof k!=='string'||!this.config.v2?.accessProfiles?.[k])||!plain(raw.v2_entitlement)||!['metered','unmetered'].includes(raw.v2_entitlement.mode)||raw.v2_entitlement.mode==='metered'&&(!Number.isSafeInteger(raw.v2_entitlement.max_daily_operations)||raw.v2_entitlement.max_daily_operations<1))fail('project_template_configuration',503);
  const policy=structuredClone(raw);delete policy.id;policy.profiles=[];
  return {hash:hash(canonical(raw)),policy};
 }
 async rate(items){
  // A separate committed transaction retains failed attempts and serializes all
  // applicable buckets. There is no in-memory counter to reset on restart.
  const allowed=await this.store.tx(async c=>{
   const time=(await c.query('SELECT extract(epoch FROM clock_timestamp()) AS epoch')).rows[0].epoch;
   let ok=true;
   for(const [domain,value,limit,seconds]of items){
    const window=Math.floor(Number(time)/seconds),bucket=this.digest(`rate:${domain}`,`${window}:${value}`);
    const row=(await c.query('INSERT INTO control_rates(bucket,attempts,expires_at) VALUES($1,1,to_timestamp($2)) ON CONFLICT(bucket) DO UPDATE SET attempts=control_rates.attempts+1 RETURNING attempts',[bucket,(window+2)*seconds])).rows[0];
    if(row.attempts>limit)ok=false;
   }
   await c.query('DELETE FROM control_rates WHERE expires_at<clock_timestamp()');
   return ok;
  });
  if(!allowed)fail('rate_limited',429);
 }
 ip(value){if(typeof value!=='string'||!value||value.length>128)fail('client_address_invalid');return value;}
 async authMethods(userId){
  this.settings();if(typeof userId!=='string'||!UUID.test(userId))fail('unauthorized',401);
  return {github:!!(await this.store.pool.query('SELECT 1 FROM control_github_identities WHERE user_id=$1',[userId])).rowCount};
 }
 githubVerifier(state,binding){return createHmac('sha256',this.settings().bridgeSecret).update(`github-pkce\0${state}\0${binding}`).digest('base64url');}
 async githubContext(c,{mode,sessionToken,csrfVerified},challenge){
  const session=tokenValid(sessionToken,'fxs')?(await c.query('SELECT s.id,s.user_id,s.expires_at,u.email FROM control_sessions s JOIN control_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR SHARE OF s',[hash(sessionToken)])).rows[0]:null;
  if(mode==='login'){if(session)fail('github_session_conflict',409);return null;}
  if(!session||challenge&&(session.id!==challenge.session_id||session.user_id!==challenge.user_id))fail('github_session_conflict',409);
  if(csrfVerified!==true)fail('csrf_rejected',403);return session;
 }
 async requestGithubStart({mode,ip,binding,sessionToken,csrfVerified=false}){
  this.settings();const github=this.githubSettings();ip=this.ip(ip);
  if(!['login','link'].includes(mode))fail('request_invalid');
  await this.rate([['github-start-ip',ip,20,900]]);
  const id=randomUUID(),state=randomBytes(32).toString('base64url'),token=tokenFor('fxh');
  const row=await this.store.tx(async c=>{
   const session=await this.githubContext(c,{mode,sessionToken,csrfVerified});
   if(tokenValid(binding,'fxh'))await c.query('UPDATE control_github_challenges SET consumed_at=COALESCE(consumed_at,clock_timestamp()) WHERE binding_hash=$1 AND consumed_at IS NULL',[this.digest('github-binding',binding)]);
   await c.query("DELETE FROM control_github_challenges WHERE expires_at<clock_timestamp()-interval '1 day'");
   return (await c.query("INSERT INTO control_github_challenges(id,state_hash,binding_hash,client_id,redirect_uri,mode,user_id,session_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()+$9*interval '1 second') RETURNING expires_at",[id,this.digest('github-state',state),this.digest('github-binding',token),github.clientId,github.redirectUri,mode,session?.user_id??null,session?.id??null,GITHUB_TTL])).rows[0];
  });
  return {authorization_url:githubAuthorizationUrl(github,{state,verifier:this.githubVerifier(state,token)}),expires_in:GITHUB_TTL,binding:token,expires_at:row.expires_at};
 }
 async completeGithub({code,state,error,binding,ip,sessionToken,csrfVerified=false}){
  this.settings();const github=this.githubSettings();ip=this.ip(ip);
  await this.rate([['github-complete-ip',ip,60,900]]);
  if(typeof state!=='string'||! /^[A-Za-z0-9_-]{43}$/.test(state)||!tokenValid(binding,'fxh')||!(error==='access_denied'&&code===undefined||error===undefined&&typeof code==='string'&&/^[A-Za-z0-9_-]{1,512}$/.test(code)))fail('github_verification_invalid',401);
  const context={sessionToken,csrfVerified},bindingHash=this.digest('github-binding',binding);
  // Commit consumption before the code exchange. A timeout, provider rejection,
  // concurrent callback or database error can never replay source work.
  const challenge=await this.store.tx(async c=>{
   const row=(await c.query('SELECT *,expires_at>clock_timestamp() AS current FROM control_github_challenges WHERE state_hash=$1 FOR UPDATE',[this.digest('github-state',state)])).rows[0];
   if(!row||row.consumed_at||!row.current||!equalDigest(row.binding_hash,bindingHash)||row.client_id!==github.clientId||row.redirect_uri!==github.redirectUri)return null;
   await this.githubContext(c,{...context,mode:row.mode},row);
   await c.query('UPDATE control_github_challenges SET consumed_at=clock_timestamp() WHERE id=$1',[row.id]);return row;
  });
  if(!challenge)fail('github_verification_invalid',401);
  if(error)fail('github_cancelled');
  const claims=await this.github.verify(code,{...github,verifier:this.githubVerifier(state,binding)});
  if(!claims||typeof claims.subject!=='string'||! /^[1-9][0-9]{0,15}$/.test(claims.subject)||!Number.isSafeInteger(Number(claims.subject)))fail('github_verification_invalid',401);
  const email=emailAddress(claims.email),token=challenge.mode==='link'?sessionToken:tokenFor('fxs');
  return this.store.tx(async c=>{
   const session=await this.githubContext(c,{...context,mode:challenge.mode},challenge);
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,170021))',[this.digest('github-subject',claims.subject)]);
   const linked=(await c.query('SELECT u.id,u.email FROM control_github_identities g JOIN control_users u ON u.id=g.user_id WHERE g.subject=$1',[claims.subject])).rows[0];
   let user=linked;
   if(challenge.mode==='link'){
    await c.query('SELECT id FROM control_users WHERE id=$1 FOR UPDATE',[session.user_id]);
    const existing=(await c.query('SELECT subject FROM control_github_identities WHERE user_id=$1',[session.user_id])).rows[0];
    if(linked&&linked.id!==session.user_id||existing&&existing.subject!==claims.subject)fail('github_identity_conflict',409);
    if(!existing)await c.query('INSERT INTO control_github_identities(subject,user_id) VALUES($1,$2)',[claims.subject,session.user_id]);
    user={id:session.user_id,email:session.email};
   }else if(!user){
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,170019))',[this.digest('email',email)]);
    if((await c.query('SELECT id FROM control_users WHERE email=$1',[email])).rowCount)fail('github_account_link_required',409);
    user=(await c.query('INSERT INTO control_users(id,email) VALUES($1,$2) RETURNING *',[randomUUID(),email])).rows[0];
    await c.query('INSERT INTO control_github_identities(subject,user_id) VALUES($1,$2)',[claims.subject,user.id]);
   }
   const expires=challenge.mode==='link'?session.expires_at:(await c.query("INSERT INTO control_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+$4*interval '1 second') RETURNING expires_at",[randomUUID(),user.id,hash(token),SESSION_TTL])).rows[0].expires_at;
   return {user:userView(user),session:{token,expires_at:expires},mode:challenge.mode};
  });
 }
 async requestGoogleChallenge({ip,binding}){
  this.settings();const google=this.googleSettings();ip=this.ip(ip);
  await this.rate([['google-challenge-ip',ip,20,900]]);
  const id=randomUUID(),nonce=randomBytes(32).toString('base64url'),token=tokenFor('fxg');
  const row=await this.store.tx(async c=>{
   if(tokenValid(binding,'fxg'))await c.query('UPDATE control_google_challenges SET consumed_at=COALESCE(consumed_at,clock_timestamp()) WHERE binding_hash=$1 AND consumed_at IS NULL',[this.digest('google-binding',binding)]);
   await c.query("DELETE FROM control_google_challenges WHERE expires_at<clock_timestamp()-interval '1 day'");
   return (await c.query("INSERT INTO control_google_challenges(id,client_id,nonce_hash,binding_hash,expires_at) VALUES($1,$2,$3,$4,clock_timestamp()+$5*interval '1 second') RETURNING expires_at",[id,google.client_id,this.digest('google-nonce',nonce),this.digest('google-binding',token),GOOGLE_TTL])).rows[0];
  });
  return {challenge_id:id,nonce,client_id:google.client_id,expires_in:GOOGLE_TTL,binding:token,expires_at:row.expires_at};
 }
 async verifyGoogle({challenge_id,credential,binding,ip}){
  this.settings();const google=this.googleSettings();ip=this.ip(ip);
  await this.rate([['google-verify-ip',ip,60,900]]);
  if(typeof challenge_id!=='string'||!UUID.test(challenge_id)||!tokenValid(binding,'fxg')||typeof credential!=='string'||!credential||credential.length>16384)fail('google_verification_invalid',401);
  const bindingHash=this.digest('google-binding',binding);
  // Commit the attempt independently so invalid provider assertions cannot reset
  // the attempt budget by rolling back a later account transaction.
  const challenge=await this.store.tx(async c=>{
   const row=(await c.query('SELECT *,expires_at>clock_timestamp() AS current FROM control_google_challenges WHERE id=$1 FOR UPDATE',[challenge_id])).rows[0];
   if(!row||row.consumed_at||!row.current||row.attempts>=5||!equalDigest(row.binding_hash,bindingHash)||row.client_id!==google.client_id)return null;
   await c.query('UPDATE control_google_challenges SET attempts=attempts+1 WHERE id=$1',[row.id]);return row;
  });
  if(!challenge)fail('google_verification_invalid',401);
  let claims;
  try{
   claims=await this.google.verify(credential,{clientId:google.client_id});
   if(!claims||typeof claims.nonce!=='string'||!equalDigest(this.digest('google-nonce',claims.nonce),challenge.nonce_hash))fail('google_verification_invalid',401);
  }catch(error){
   await this.store.pool.query('UPDATE control_google_challenges SET consumed_at=COALESCE(consumed_at,clock_timestamp()) WHERE id=$1 AND attempts>=5',[challenge_id]);
   throw error;
  }
  const token=tokenFor('fxs');
  const result=await this.store.tx(async c=>{
   const row=(await c.query('SELECT *,expires_at>clock_timestamp() AS current FROM control_google_challenges WHERE id=$1 FOR UPDATE',[challenge_id])).rows[0];
   if(!row||row.consumed_at||!row.current||!equalDigest(row.binding_hash,bindingHash)||row.client_id!==google.client_id)return null;
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,170020))',[this.digest('google-subject',`${claims.issuer}:${claims.subject}`)]);
   const linked=(await c.query('SELECT u.id,u.email FROM control_google_identities g JOIN control_users u ON u.id=g.user_id WHERE g.issuer=$1 AND g.subject=$2',[claims.issuer,claims.subject])).rows[0];
   let user=linked;
   if(!user){
    if(claims.authoritative!==true)fail('google_email_verification_required',403);
    const email=emailAddress(claims.email);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,170019))',[this.digest('email',email)]);
    user=(await c.query('INSERT INTO control_users(id,email) VALUES($1,$2) ON CONFLICT(email) DO UPDATE SET email=EXCLUDED.email RETURNING *',[randomUUID(),email])).rows[0];
    const existing=(await c.query('SELECT subject FROM control_google_identities WHERE user_id=$1',[user.id])).rows[0];
    if(existing)fail('google_identity_conflict',409);
    await c.query('INSERT INTO control_google_identities(issuer,subject,user_id) VALUES($1,$2,$3)',[claims.issuer,claims.subject,user.id]);
   }
   await c.query('UPDATE control_google_challenges SET consumed_at=clock_timestamp() WHERE id=$1',[challenge_id]);
   const session=(await c.query("INSERT INTO control_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+$4*interval '1 second') RETURNING expires_at",[randomUUID(),user.id,hash(token),SESSION_TTL])).rows[0];
   return {user:userView(user),session:{token,expires_at:session.expires_at}};
  });
  if(!result)fail('google_verification_invalid',401);return result;
 }
 async requestCode({email,ip}){
  this.settings();email=emailAddress(email);ip=this.ip(ip);
  if(!this.mailConfigured)fail('mail_unavailable',503);
  await this.rate([['code-email',email,3,900],['code-ip',ip,20,900]]);
  const id=randomUUID(),code=String(randomInt(0,100000000)).padStart(8,'0'),emailHash=this.digest('email',email);
  const row=await this.store.tx(async c=>{
   // Serialize resend against verify so a replaced challenge cannot be consumed.
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,170019))',[emailHash]);
   await c.query('UPDATE control_codes SET consumed_at=clock_timestamp() WHERE email_hash=$1 AND consumed_at IS NULL',[emailHash]);
   return (await c.query("INSERT INTO control_codes(id,email_hash,code_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+$4*interval '1 second') RETURNING expires_at",[id,emailHash,this.digest('code',`${id}:${email}:${code}`),TTL])).rows[0];
  });
  try{await this.mail.sendCode({email,code,challenge_id:id,expires_at:row.expires_at});}
  catch{await this.store.pool.query('UPDATE control_codes SET consumed_at=COALESCE(consumed_at,clock_timestamp()) WHERE id=$1',[id]);}
  // Every valid email has this same result, including a failed/uncertain send.
  return {challenge_id:id,expires_in:TTL,accepted:true};
 }
 async verifyCode({challenge_id,email,code,ip}){
  this.settings();email=emailAddress(email);ip=this.ip(ip);
  await this.rate([['verify-ip',ip,60,900],['verify-email',email,20,900]]);
  if(typeof challenge_id!=='string'||!UUID.test(challenge_id)||typeof code!=='string'||!/^\d{8}$/.test(code))fail('verification_invalid',401);
  const emailHash=this.digest('email',email),codeHash=this.digest('code',`${challenge_id}:${email}:${code}`),token=tokenFor('fxs');
  const result=await this.store.tx(async c=>{
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,170019))',[emailHash]);
   const row=(await c.query('SELECT *,expires_at>clock_timestamp() AS current FROM control_codes WHERE id=$1 FOR UPDATE',[challenge_id])).rows[0];
   if(!row||row.email_hash!==emailHash||row.consumed_at||!row.current||row.attempts>=5)return null;
   const equal=timingSafeEqual(Buffer.from(row.code_hash,'hex'),Buffer.from(codeHash,'hex'));
   await c.query('UPDATE control_codes SET attempts=attempts+1,consumed_at=CASE WHEN $2 OR attempts+1>=5 THEN clock_timestamp() ELSE consumed_at END WHERE id=$1',[row.id,equal]);
   if(!equal)return null;
   const user=(await c.query('INSERT INTO control_users(id,email) VALUES($1,$2) ON CONFLICT(email) DO UPDATE SET email=EXCLUDED.email RETURNING *',[randomUUID(),email])).rows[0];
   const session=(await c.query("INSERT INTO control_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+$4*interval '1 second') RETURNING expires_at",[randomUUID(),user.id,hash(token),SESSION_TTL])).rows[0];
   return {user:userView(user),session:{token,expires_at:session.expires_at}};
  });
  if(!result)fail('verification_invalid',401);return result;
 }
 async session(token){
  this.settings();if(!tokenValid(token,'fxs'))fail('unauthorized',401);
  const row=(await this.store.pool.query('SELECT s.id,s.expires_at,u.id AS user_id,u.email FROM control_sessions s JOIN control_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()',[hash(token)])).rows[0];
  if(!row)fail('unauthorized',401);return {user:{id:row.user_id,email:row.email},session:{id:row.id,expires_at:row.expires_at}};
 }
 async revokeSession(token){this.settings();if(tokenValid(token,'fxs'))await this.store.pool.query('UPDATE control_sessions SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE token_hash=$1',[hash(token)]);return {revoked:true};}
 assertProject(row){if(!row)fail('project_not_found',404);if(row.status!=='active')fail('project_disabled',403);if(row.template_hash!==this.template().hash)fail('project_template_changed',403);return row;}
 async projectRow(userId,projectId,c=this.store.pool){
  this.settings();if(typeof userId!=='string'||!UUID.test(userId)||typeof projectId!=='string'||!PROJECT.test(projectId))fail('project_not_found',404);
  return this.assertProject((await c.query('SELECT p.* FROM control_projects p JOIN control_memberships m ON m.project=p.id WHERE p.id=$1 AND m.user_id=$2',[projectId,userId])).rows[0]);
 }
 async requireProject(userId,projectId){const row=await this.projectRow(userId,projectId);await this.hydrateProject(projectId);return projectView(row);}
 async projects(userId){
  this.settings();if(typeof userId!=='string'||!UUID.test(userId))fail('unauthorized',401);
  return (await this.store.pool.query('SELECT p.* FROM control_projects p JOIN control_memberships m ON m.project=p.id WHERE m.user_id=$1 ORDER BY p.created_at,p.id',[userId])).rows.map(projectView);
 }
 async createProject(userId,input){
  this.settings();const template=this.template();
  if(!plain(input)||Object.keys(input).some(k=>k!=='name'))fail('project_invalid');const name=label(input.name,'project_name_invalid');
  if(typeof userId!=='string'||!UUID.test(userId))fail('unauthorized',401);
  const trial=reviewedCreditPolicy(this.config).trialCredits;
  const row=await this.store.tx(async c=>{
   if(!(await c.query('SELECT id FROM control_users WHERE id=$1 FOR UPDATE',[userId])).rowCount)fail('unauthorized',401);
   const count=Number((await c.query('SELECT count(*) AS n FROM control_projects WHERE user_id=$1',[userId])).rows[0].n);
   if(count>=10)fail('project_limit',429);
   const row=(await c.query('INSERT INTO control_projects(id,user_id,name,template_hash) VALUES($1,$2,$3,$4) RETURNING *',[`cp_${randomUUID()}`,userId,name,template.hash])).rows[0];
   await c.query('INSERT INTO control_memberships(user_id,project) VALUES($1,$2)',[userId,row.id]);
   await grantInitialCredits(c,row.id,0);
   await grantAccountTrialCredits(c,{userId,targetCredits:trial,templateHash:template.hash});
   return row;
  });
  await this.hydrateProject(row.id);return projectView(row);
 }
 async hydrateProject(projectId){
  const control=this.settings();if(typeof projectId!=='string'||!PROJECT.test(projectId))fail('project_not_found',404);
  const trial=control.creditPolicy;
  const migrate=trial?.reviewed===true&&(trial.trialCredits===undefined||trial.trialCredits===TRIAL_CREDITS_PER_ACCOUNT);
  const query=migrate?`SELECT p.*,EXISTS(SELECT 1 FROM control_trial_grant_receipts r
   WHERE r.user_id=p.user_id AND r.target_credits=$2) AS trial_claimed FROM control_projects p WHERE p.id=$1`:
   'SELECT * FROM control_projects WHERE id=$1';
  const row=this.assertProject((await this.store.pool.query(query,migrate?[projectId,TRIAL_CREDITS_PER_ACCOUNT]:[projectId])).rows[0]);
  if(migrate&&!row.trial_claimed){
   const targetCredits=reviewedCreditPolicy(this.config).trialCredits;
   await this.store.tx(c=>grantAccountTrialCredits(c,{userId:row.user_id,targetCredits,templateHash:row.template_hash}));
  }
  const policy=this.template().policy;
  this.config.projects??={};this.config.projects[row.id]=policy;return policy;
 }
 async keys(userId,projectId){await this.projectRow(userId,projectId);return (await this.store.pool.query('SELECT * FROM control_keys WHERE project=$1 ORDER BY created_at,id',[projectId])).rows.map(keyView);}
 keyInput(input){
  if(!plain(input)||Object.keys(input).some(k=>!['name','scopes'].includes(k)))fail('key_invalid');const name=label(input.name,'key_name_invalid');
  if(!Array.isArray(input.scopes)||!input.scopes.length||input.scopes.length>SCOPES.length||input.scopes.some(scope=>!SCOPES.includes(scope))||new Set(input.scopes).size!==input.scopes.length)fail('key_scopes_invalid');
  return {name,scopes:[...input.scopes].sort()};
 }
 async insertKey(c,project,input){
  const token=tokenFor('fxk');
  const row=(await c.query('INSERT INTO control_keys(id,project,name,prefix,token_hash,scopes) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[randomUUID(),project,input.name,token.slice(0,12),hash(token),JSON.stringify(input.scopes)])).rows[0];
  return {...keyView(row),token};
 }
 async createKey(userId,projectId,input){
  const value=this.keyInput(input);
  return this.store.tx(async c=>{
   await this.projectRow(userId,projectId,c);await c.query('SELECT id FROM control_projects WHERE id=$1 FOR UPDATE',[projectId]);
   if(Number((await c.query('SELECT count(*) AS n FROM control_keys WHERE project=$1 AND revoked_at IS NULL',[projectId])).rows[0].n)>=20)fail('key_limit',429);
   return this.insertKey(c,projectId,value);
  });
 }
 async rotateKey(userId,projectId,keyId){
  if(typeof keyId!=='string'||!UUID.test(keyId))fail('key_not_found',404);
  return this.store.tx(async c=>{
   await this.projectRow(userId,projectId,c);await c.query('SELECT id FROM control_projects WHERE id=$1 FOR UPDATE',[projectId]);
   const row=(await c.query('SELECT * FROM control_keys WHERE id=$1 AND project=$2 FOR UPDATE',[keyId,projectId])).rows[0];
   if(!row)fail('key_not_found',404);if(row.revoked_at)fail('key_revoked',409);
   const next=await this.insertKey(c,projectId,row);await c.query('UPDATE control_keys SET revoked_at=clock_timestamp() WHERE id=$1',[row.id]);return next;
  });
 }
 async revokeKey(userId,projectId,keyId){
  if(typeof keyId!=='string'||!UUID.test(keyId))fail('key_not_found',404);
  return this.store.tx(async c=>{
   await this.projectRow(userId,projectId,c);
   const row=(await c.query('UPDATE control_keys SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=$1 AND project=$2 RETURNING *',[keyId,projectId])).rows[0];
   if(!row)fail('key_not_found',404);return keyView(row);
  });
 }
 async authenticateKey(token){
  this.settings();if(!tokenValid(token,'fxk'))fail('unauthorized',401);
  const row=(await this.store.pool.query('SELECT k.id,k.project,k.scopes,p.template_hash,p.status FROM control_keys k JOIN control_projects p ON p.id=k.project WHERE k.token_hash=$1 AND k.revoked_at IS NULL',[hash(token)])).rows[0];
  if(!row)fail('unauthorized',401);this.assertProject(row);await this.hydrateProject(row.project);
  if(!(await this.store.pool.query('UPDATE control_keys SET last_used_at=clock_timestamp() WHERE id=$1 AND revoked_at IS NULL RETURNING id',[row.id])).rowCount)fail('unauthorized',401);
  return {project:row.project,key_id:row.id,scopes:row.scopes};
 }
 async isCredential(value){
  if(typeof value!=='string')return false;const token=value.trim().replace(/^Bearer\s+/i,'');
  if(!tokenValid(token,'fxk')&&!tokenValid(token,'fxs'))return false;
  // Revoked and expired credentials remain forbidden as source input too.
  return !!(await this.store.pool.query('SELECT 1 FROM control_keys WHERE token_hash=$1 UNION ALL SELECT 1 FROM control_sessions WHERE token_hash=$1 LIMIT 1',[hash(token)])).rowCount;
 }
}
