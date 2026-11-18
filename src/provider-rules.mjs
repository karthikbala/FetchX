// Provider routing rules are data, not code: which provider must not be used
// for which destination hosts. Reviewed defaults ship in
// provider-rules-defaults.mjs; operators add or override rules through
// config.providerRules (and later the admin portal). Rules only ever remove a
// provider from consideration; they never add routes or bypass profiles.
import defaults from './provider-rules-defaults.mjs';
import {fail,GatewayError} from './policy.mjs';

export const RULE_PROVIDERS=Object.freeze(['oxylabs','scrapedo','evomi','dataimpulse']);
const ID=/^[a-z0-9][a-z0-9._-]{0,63}$/,HOST=/^(?=.{1,253}$)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/,SUFFIX=/^\.[a-z0-9-]+(?:\.[a-z0-9-]+)*$/;
const cache=new WeakMap();

export function validRule(rule){
 if(!rule||typeof rule!=='object'||Array.isArray(rule))return false;
 if(Object.keys(rule).some(k=>!['id','provider','match','action','reason','evidence','enabled'].includes(k)))return false;
 if(!ID.test(rule.id??'')||!RULE_PROVIDERS.includes(rule.provider)||rule.action!=='exclude')return false;
 if(typeof rule.reason!=='string'||!rule.reason||rule.reason.length>300)return false;
 if(rule.enabled!==undefined&&typeof rule.enabled!=='boolean')return false;
 const m=rule.match;if(!m||typeof m!=='object'||Array.isArray(m)||Object.keys(m).length!==1)return false;
 if(m.host!==undefined)return typeof m.host==='string'&&HOST.test(m.host);
 if(m.hostSuffix!==undefined)return typeof m.hostSuffix==='string'&&SUFFIX.test(m.hostSuffix);
 return false;
}
// Effective rules by precedence: shipped defaults < config.providerRules <
// database (portal/operator) rows. A later layer with the same id replaces the
// earlier rule entirely, so {"id":"oxylabs-gov",...,"enabled":false} disables it.
const databaseLayer=new WeakMap();
function layered(config){
 const extra=config?.providerRules??[];
 if(!Array.isArray(extra)||extra.length>500)fail('provider_rules_invalid',500);
 const byId=new Map();
 for(const rule of defaults.rules)byId.set(rule.id,{rule,source:'default'});
 for(const rule of extra){if(!validRule(rule))fail('provider_rules_invalid',500);byId.set(rule.id,{rule,source:'config',overrides:byId.get(rule.id)?.source??null});}
 for(const row of (config&&databaseLayer.get(config))??[])byId.set(row.rule.id,{rule:row.rule,source:'database',overrides:byId.get(row.rule.id)?.source??null,version:row.version,updated_by:row.updated_by,updated_at:row.updated_at});
 return byId;
}
export function providerRules(config){
 if(config&&cache.has(config))return cache.get(config);
 const rules=Object.freeze([...layered(config).values()].map(x=>Object.freeze(structuredClone(x.rule))));
 if(config)cache.set(config,rules);
 return rules;
}
// The effective rules with where each came from, for operators and the portal.
export function providerRuleSources(config){
 return [...layered(config).values()].map(x=>({...structuredClone(x.rule),source:x.source,overrides:x.overrides??null,version:x.version??null,updated_by:x.updated_by??null,updated_at:x.updated_at??null}));
}

// ---- Database layer (admin portal step 1) ----
const BASE_FIELDS=['id','provider','match','action','reason','evidence','enabled'];
export async function initProviderRules(pool){await pool.query(`
 CREATE TABLE IF NOT EXISTS routing_rules(id text PRIMARY KEY,provider text NOT NULL,match jsonb NOT NULL,action text NOT NULL DEFAULT 'exclude',reason text NOT NULL,evidence jsonb,enabled boolean NOT NULL DEFAULT true,version int NOT NULL DEFAULT 1,updated_by text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS routing_rule_audit(id bigserial PRIMARY KEY,rule_id text NOT NULL,action text NOT NULL,before jsonb,after jsonb,actor text NOT NULL,at timestamptz NOT NULL DEFAULT now());
 CREATE INDEX IF NOT EXISTS routing_rule_audit_rule ON routing_rule_audit(rule_id,at);
 `);}
const rowRule=row=>Object.fromEntries(Object.entries({id:row.id,provider:row.provider,match:row.match,action:row.action,reason:row.reason,evidence:row.evidence??undefined,enabled:row.enabled}).filter(([,v])=>v!==undefined));
// Loads database rules into the config's rule set. Invalid rows are skipped
// (and reported) rather than failing the gateway; writes validate first.
export async function loadProviderRules(pool,config){
 const rows=(await pool.query('SELECT * FROM routing_rules ORDER BY id')).rows,loaded=[],rejected=[];
 for(const row of rows){const rule=rowRule(row);if(validRule(rule))loaded.push({rule,version:row.version,updated_by:row.updated_by,updated_at:row.updated_at});else rejected.push(row.id);}
 databaseLayer.set(config,loaded);cache.delete(config);
 return {loaded:loaded.length,rejected};
}
const ACTOR=/^[\w@.+:-]{1,128}$/;
function checkActor(actor){if(typeof actor!=='string'||!ACTOR.test(actor))fail('rule_actor_invalid',400);}
function checkRule(rule){
 if(!rule||typeof rule!=='object'||Object.keys(rule).some(k=>!BASE_FIELDS.includes(k))||!validRule(rule))fail('rule_invalid',400);
 if(rule.evidence!==undefined&&(rule.evidence===null||typeof rule.evidence!=='object'||Array.isArray(rule.evidence)||Buffer.byteLength(JSON.stringify(rule.evidence))>4096))fail('rule_invalid',400);
}
async function audit(c,ruleId,action,before,after,actor){await c.query('INSERT INTO routing_rule_audit(rule_id,action,before,after,actor) VALUES($1,$2,$3,$4,$5)',[ruleId,action,before,after,actor]);await c.query("SELECT pg_notify('fetchx_provider_rules',$1)",[ruleId]);}
// Create or replace a database rule. expectedVersion guards concurrent edits:
// null/undefined creates (409 if it exists); a number must match the current row.
export async function saveProviderRule(store,rule,{actor,expectedVersion=null}){
 checkActor(actor);checkRule(rule);
 return store.tx(async c=>{
  const before=(await c.query('SELECT * FROM routing_rules WHERE id=$1 FOR UPDATE',[rule.id])).rows[0];
  if(expectedVersion===null&&before||expectedVersion!==null&&(!before||before.version!==expectedVersion))fail('rule_version_conflict',409);
  const row=(await c.query(`INSERT INTO routing_rules(id,provider,match,action,reason,evidence,enabled,version,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,1,$8)
   ON CONFLICT(id) DO UPDATE SET provider=EXCLUDED.provider,match=EXCLUDED.match,action=EXCLUDED.action,reason=EXCLUDED.reason,evidence=EXCLUDED.evidence,enabled=EXCLUDED.enabled,version=routing_rules.version+1,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`,
   [rule.id,rule.provider,rule.match,rule.action,rule.reason,rule.evidence??null,rule.enabled??true,actor])).rows[0];
  await audit(c,rule.id,before?'update':'create',before?rowRule(before):null,rowRule(row),actor);
  return {...rowRule(row),version:row.version};
 });
}
// Enable or disable a rule by id. For a default/config rule with no database
// row yet, this writes a database override copying it with the new state.
export async function setProviderRuleEnabled(store,config,id,enabled,{actor,reason}){
 checkActor(actor);if(typeof enabled!=='boolean')fail('rule_invalid',400);
 if(typeof reason!=='string'||!reason||reason.length>300)fail('rule_reason_required',400);
 const base=layered(config).get(id);
 return store.tx(async c=>{
  const before=(await c.query('SELECT * FROM routing_rules WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(!before&&!base)fail('rule_not_found',404);
  const after=before?{...rowRule(before),enabled}:{...structuredClone(base.rule),enabled};
  const row=(await c.query(`INSERT INTO routing_rules(id,provider,match,action,reason,evidence,enabled,version,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,1,$8)
   ON CONFLICT(id) DO UPDATE SET enabled=EXCLUDED.enabled,version=routing_rules.version+1,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`,
   [id,after.provider,after.match,after.action,after.reason,after.evidence??null,enabled,actor])).rows[0];
  await audit(c,id,enabled?'enable':'disable',before?rowRule(before):{...structuredClone(base.rule),source:base.source},{...rowRule(row),note:reason},actor);
  return {...rowRule(row),version:row.version};
 });
}
// Removes a database row. Default and config rules cannot be deleted: removing
// their override restores them (disable them instead).
export async function deleteProviderRule(store,id,{actor}){
 checkActor(actor);
 return store.tx(async c=>{
  const before=(await c.query('DELETE FROM routing_rules WHERE id=$1 RETURNING *',[id])).rows[0];
  if(!before)fail('rule_not_found',404);
  await audit(c,id,'delete',rowRule(before),null,actor);
  return {deleted:id};
 });
}
export async function providerRuleAudit(pool,{ruleId=null,limit=100}={}){
 return (await pool.query('SELECT id,rule_id,action,before,after,actor,at FROM routing_rule_audit WHERE ($1::text IS NULL OR rule_id=$1) ORDER BY id DESC LIMIT $2',[ruleId,Math.min(Math.max(1,limit),500)])).rows;
}
export const validateProviderRules=config=>{providerRules(config);};
export function hostMatches(match,host){
 const h=String(host).toLowerCase().replace(/\.$/,'');
 return match.host!==undefined?h===match.host:h.endsWith(match.hostSuffix)||h===match.hostSuffix.slice(1);
}
// The first enabled rule that excludes this provider for this host, or null.
export function providerRule(config,provider,host){
 return providerRules(config).find(r=>r.enabled!==false&&r.provider===provider&&hostMatches(r.match,host))??null;
}
export function assertProviderAllowed(config,provider,host){
 const rule=providerRule(config,provider,host);if(!rule)return;
 const e=new GatewayError('provider_host_excluded',409);e.details={provider,rule:rule.id,host:String(host).toLowerCase()};throw e;
}
