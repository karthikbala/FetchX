// The admin portal: an operator role on control-plane users, and the admin
// API. Disabled unless controlPlane.admin.enabled is true. Operators are
// granted out of band with the operator CLI; a project member cannot reach
// these routes. Provider rules, reachability probes and site knowledge live in
// the engine: these routes check the operator and forward to the engine's
// /internal/v1/admin with the operator's email as the actor, and pass the
// engine's answer (or refusal) back unchanged. Responses never contain secrets.
import {fail} from './policy.mjs';

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
// exact-input helpers. Each entry is [method, path, sends a body].
export const ADMIN_ROUTES = Object.freeze([
 ['GET','/admin/rules',false],['POST','/admin/rules',true],['POST','/admin/rules/test',true],['PUT','/admin/rules/:id',true],
 ['POST','/admin/rules/:id/enable',true],['POST','/admin/rules/:id/disable',true],['DELETE','/admin/rules/:id',false],
 ['GET','/admin/rules/:id/audit',false],['GET','/admin/audit',false],
 ['GET','/admin/probes',false],['POST','/admin/probes',true],['GET','/admin/probes/:pid',false],['POST','/admin/probes/:pid/apply',true],
 ['GET','/admin/sites',false],['GET','/admin/sites/:host',false],['DELETE','/admin/sites/:host',false],
]);
const PARAM=/^[A-Za-z0-9._-]{1,253}$/;

export function registerAdminRoutes(route,{gateway,config,authenticated,body,noQuery}){
 const store=gateway.store;
 async function operator(req){
  if(config.admin?.enabled!==true)fail('not_found',404);
  const auth=await authenticated(req);
  if(!await isOperator(store.pool,auth.user.id))fail('operator_required',403);
  return auth;
 }
 route('GET','/admin/session',async req=>{noQuery(req);const auth=await operator(req);return {operator:true,email:auth.user.email};});
 for(const [method,path,sendsBody] of ADMIN_ROUTES)route(method,path,async req=>{
  noQuery(req);const auth=await operator(req);
  // Path values are checked here only for shape; the engine validates them.
  const target=path.slice('/admin'.length).replace(/:([a-z]+)/g,(_,name)=>{
   const value=req.params?.[name];if(typeof value!=='string'||!PARAM.test(value))fail(name==='host'?'host_invalid':name==='pid'?'probe_id_invalid':'rule_id_invalid',400);
   return encodeURIComponent(value);
  });
  const input=sendsBody?body(req,Object.keys(req.body??{})):undefined;
  return gateway.engine.admin(method,target,{body:input,actor:method==='GET'?undefined:auth.user.email});
 });
}
