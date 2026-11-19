// Admin portal step 2: an operator role on control-plane users and an admin API
// for provider routing rules. Disabled unless controlPlane.admin.enabled is
// true. Operators are granted out of band with the operator CLI; a project
// member cannot reach these routes. Every rule change goes through the
// provider-rules data layer (validated, versioned, audited) and is applied to
// the running gateway immediately. Responses never contain secrets.
import {fail} from './policy.mjs';
import {startProbe,listProbes,readProbe,applyProbe,loadProfileOverrides,profileView,saveProfileOverride,deleteProfileOverride,PROFILE_ID} from './admin-ops.mjs';
import {RULE_PROVIDERS,loadProviderRules,providerRule,providerRuleSources,saveProviderRule,setProviderRuleEnabled,deleteProviderRule,providerRuleAudit} from './provider-rules.mjs';

import {OVERRIDE_FIELDS as OVERRIDE_FIELDS_PUBLIC} from './admin-ops.mjs';
const RULE_ID=/^[a-z0-9][a-z0-9._-]{0,63}$/,HOST=/^(?=.{1,253}$)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
const plain=v=>!!v&&typeof v==='object'&&!Array.isArray(v);

export async function initControlAdmin(pool){await pool.query(`
 CREATE TABLE IF NOT EXISTS control_operators(user_id uuid PRIMARY KEY REFERENCES control_users(id),granted_by text NOT NULL,granted_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS control_operator_audit(id bigserial PRIMARY KEY,user_id uuid NOT NULL,email text NOT NULL,action text NOT NULL CHECK(action IN ('grant','revoke')),actor text NOT NULL,at timestamptz NOT NULL DEFAULT now());
 `);}
export async function isOperator(pool,userId){return (await pool.query('SELECT 1 FROM control_operators WHERE user_id=$1',[userId])).rowCount===1;}
async function userByEmail(c,email){
 const value=typeof email==='string'?email.trim().toLowerCase():'';
 const row=(await c.query('SELECT id,email FROM control_users WHERE email=$1',[value])).rows[0];
 if(!row)fail('operator_user_not_found',404);return row;
}
// Operator CLI only. The actor is the operator running the CLI.
export async function grantOperator(store,email,actor){
 return store.tx(async c=>{
  const user=await userByEmail(c,email);
  const added=(await c.query('INSERT INTO control_operators(user_id,granted_by) VALUES($1,$2) ON CONFLICT DO NOTHING',[user.id,actor])).rowCount;
  if(added)await c.query("INSERT INTO control_operator_audit(user_id,email,action,actor) VALUES($1,$2,'grant',$3)",[user.id,user.email,actor]);
  return {email:user.email,operator:true,changed:added===1};
 });
}
export async function revokeOperator(store,email,actor){
 return store.tx(async c=>{
  const user=await userByEmail(c,email);
  const removed=(await c.query('DELETE FROM control_operators WHERE user_id=$1',[user.id])).rowCount;
  if(removed)await c.query("INSERT INTO control_operator_audit(user_id,email,action,actor) VALUES($1,$2,'revoke',$3)",[user.id,user.email,actor]);
  return {email:user.email,operator:false,changed:removed===1};
 });
}
export async function listOperators(pool){
 return (await pool.query('SELECT u.email,o.granted_by,o.granted_at FROM control_operators o JOIN control_users u ON u.id=o.user_id ORDER BY o.granted_at')).rows;
}

// Registers /control/admin/* on the control-plane Fastify scope. `authenticated`
// is the control plane's session + CSRF check; `body` and `noQuery` are its
// exact-input helpers.
export function registerAdminRoutes(route,{gateway,config,authenticated,body,noQuery}){
 const store=gateway.store;
 async function operator(req){
  if(config.admin?.enabled!==true)fail('not_found',404);
  const auth=await authenticated(req);
  if(!await isOperator(store.pool,auth.user.id))fail('operator_required',403);
  return auth;
 }
 const actorOf=auth=>auth.user.email;
 const ruleId=value=>{if(typeof value!=='string'||!RULE_ID.test(value))fail('rule_id_invalid',400);return value;};
 // Writes take effect at once; the periodic refresh covers other gateways.
 const refresh=()=>loadProviderRules(store.pool,gateway.config);
 const rules=async()=>{await refresh();return {rules:providerRuleSources(gateway.config),providers:RULE_PROVIDERS};};

 route('GET','/admin/session',async req=>{noQuery(req);const auth=await operator(req);return {operator:true,email:auth.user.email};});
 route('GET','/admin/rules',async req=>{noQuery(req);await operator(req);return rules();});
 route('POST','/admin/rules',async req=>{
  noQuery(req);const auth=await operator(req),input=body(req,['rule']);
  const saved=await saveProviderRule(store,input.rule,{actor:actorOf(auth),expectedVersion:null});
  await refresh();return {rule:saved};
 });
 // Read-only check: would this provider be used for this host?
 route('POST','/admin/rules/test',async req=>{
  noQuery(req);await operator(req);const input=body(req,['provider','host']);
  if(!RULE_PROVIDERS.includes(input.provider))fail('rule_provider_invalid',400);
  const host=typeof input.host==='string'?input.host.trim().toLowerCase().replace(/\.$/,''):'';
  if(!HOST.test(host))fail('rule_host_invalid',400);
  await refresh();const rule=providerRule(gateway.config,input.provider,host);
  return {provider:input.provider,host,excluded:!!rule,rule:rule?rule.id:null,reason:rule?rule.reason:null};
 });
 route('PUT','/admin/rules/:id',async req=>{
  noQuery(req);const auth=await operator(req),id=ruleId(req.params.id),input=body(req,['rule','version']);
  if(!plain(input.rule)||input.rule.id!==id)fail('rule_id_mismatch',400);
  if(!Number.isSafeInteger(input.version)||input.version<1)fail('rule_version_required',400);
  const saved=await saveProviderRule(store,input.rule,{actor:actorOf(auth),expectedVersion:input.version});
  await refresh();return {rule:saved};
 });
 for(const action of ['enable','disable'])route('POST',`/admin/rules/:id/${action}`,async req=>{
  noQuery(req);const auth=await operator(req),id=ruleId(req.params.id),input=body(req,['reason']);
  const saved=await setProviderRuleEnabled(store,gateway.config,id,action==='enable',{actor:actorOf(auth),reason:input.reason});
  await refresh();return {rule:saved};
 });
 route('DELETE','/admin/rules/:id',async req=>{
  noQuery(req);const auth=await operator(req),id=ruleId(req.params.id);
  const result=await deleteProviderRule(store,id,{actor:actorOf(auth)});
  await refresh();return result;
 });
 route('GET','/admin/rules/:id/audit',async req=>{noQuery(req);await operator(req);return {entries:await providerRuleAudit(store.pool,{ruleId:ruleId(req.params.id),limit:200})};});
 route('GET','/admin/audit',async req=>{noQuery(req);await operator(req);return {entries:await providerRuleAudit(store.pool,{limit:200})};});

 // ---- Step 3: reachability probes (background jobs) ----
 route('GET','/admin/probes',async req=>{noQuery(req);await operator(req);return {probes:await listProbes(store.pool)};});
 route('POST','/admin/probes',async req=>{
  noQuery(req);const auth=await operator(req),input=body(req,['host','countries','include_excluded']);
  const {job,...started}=await startProbe(store,gateway,input,{actor:actorOf(auth),run:gateway.adminProbeRunner});job.catch(()=>{});return {probe:started};
 });
 route('GET','/admin/probes/:pid',async req=>{noQuery(req);await operator(req);return {probe:await readProbe(store.pool,req.params.pid)};});
 route('POST','/admin/probes/:pid/apply',async req=>{
  noQuery(req);const auth=await operator(req),input=body(req,['rules','profile']);
  const applied=await applyProbe(store,gateway,req.params.pid,input,{actor:actorOf(auth)});
  await Promise.all([refresh(),loadProfileOverrides(store.pool,gateway)]);return {applied};
 });

 // ---- Step 3: profile routing overrides (new workflows only) ----
 const profileId=value=>{if(typeof value!=='string'||!PROFILE_ID.test(value)||!Object.hasOwn(gateway.profiles,value))fail('profile_not_found',404);return value;};
 route('GET','/admin/profiles',async req=>{
  noQuery(req);await operator(req);await loadProfileOverrides(store.pool,gateway);
  return {profiles:Object.keys(gateway.profiles).sort().map(id=>profileView(gateway,id)),fields:OVERRIDE_FIELDS_PUBLIC};
 });
 route('PUT','/admin/profiles/:pid/routing',async req=>{
  noQuery(req);const auth=await operator(req),id=profileId(req.params.pid),input=body(req,['patch','version']);
  if(input.version!==undefined&&input.version!==null&&(!Number.isSafeInteger(input.version)||input.version<1))fail('request_invalid',400);
  await saveProfileOverride(store,gateway,id,input.patch,{actor:actorOf(auth),expectedVersion:input.version??null});
  await loadProfileOverrides(store.pool,gateway);return {profile:profileView(gateway,id)};
 });
 route('DELETE','/admin/profiles/:pid/routing',async req=>{
  noQuery(req);const auth=await operator(req),id=profileId(req.params.pid);
  await deleteProfileOverride(store,id,{actor:actorOf(auth)});await loadProfileOverrides(store.pool,gateway);return {profile:profileView(gateway,id)};
 });
 route('GET','/admin/profiles/:pid/audit',async req=>{
  noQuery(req);await operator(req);const id=profileId(req.params.pid);
  return {entries:(await store.pool.query('SELECT id,profile,action,before,after,actor,note,at FROM source_profile_override_audit WHERE profile=$1 ORDER BY id DESC LIMIT 200',[id])).rows};
 });
}
