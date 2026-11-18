import {CaptchaSolver} from './captcha.mjs';
import {reconcileResidential} from './residential.mjs';
// Run inside the gateway container by an operator. Never dispatches source work.
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {Store} from './store.mjs';
import {Sealer} from './crypto.mjs';
import {gatewayStatus} from './status.mjs';
import {loadProviderRules,providerRuleSources,saveProviderRule,setProviderRuleEnabled,deleteProviderRule,providerRuleAudit} from './provider-rules.mjs';
const store=new Store(process.env.DATABASE_URL);
try{
 if(process.argv[2]==='status'){
  const config=JSON.parse(await readFile(process.env.GATEWAY_CONFIG??'/run/secrets/gateway.json','utf8'));
  console.log(JSON.stringify(await gatewayStatus(store,config)));
 }else if(process.argv[2]==='reconcile-captcha'){
  const config=JSON.parse(await readFile(process.env.GATEWAY_CONFIG??'/run/secrets/gateway.json','utf8'));
  console.log(JSON.stringify(await new CaptchaSolver(store,config).reconcile(process.argv[3])));
 }else if(process.argv[2]==='reconcile-residential'){
  console.log(JSON.stringify(await reconcileResidential(store,JSON.parse(await readFile(process.argv[3],'utf8')))));
 }else if(process.argv[2]==='reconcile'){
  // Evidence must be supplied as a protected file; no secrets in command arguments.
  const input=JSON.parse(await readFile(process.argv[3],'utf8'));
  if(!/^[a-f0-9-]{36}$/.test(input.attempt)||!Number.isSafeInteger(input.credits)||input.credits<0||!/^sha256:[a-f0-9]{64}$/.test(input.evidence))throw Error('invalid_reconciliation');
  await store.tx(async c=>{
   const row=(await c.query('SELECT * FROM attempts WHERE id=$1 FOR UPDATE',[input.attempt])).rows[0];
   if(!row||row.provider!=='scrapedo'||row.state!=='unknown')throw Error('not_unknown_metered_attempt');
   await c.query("INSERT INTO ledger(attempt,event,credits) VALUES($1,$2,$3)",[input.attempt,'reconcile:'+input.evidence,input.credits]);
   await c.query("UPDATE attempts SET state='settled',credits=$2,error=NULL WHERE id=$1",[input.attempt,input.credits]);
  });console.log('reconciled_without_redispatch');
 }else if(process.argv[2]==='snapshot'){
  const config=JSON.parse(await readFile(process.env.GATEWAY_CONFIG,'utf8'));
  const data={};
  // Small operational export, encrypted and owner-protected. Captures are separate files.
  for(const name of ['captcha_tasks','fetch_jobs','residential_reconciliations','residential_usage','browser_state','workflows','operations','attempts','ledger','source_limits','pool_cursor','project_admission','admission_queue','operation_outcomes','route_health','route_health_workflows','route_health_pools'])data[name]=(await store.pool.query('SELECT * FROM '+name)).rows;
  await writeFile(process.argv[3],new Sealer(config.artifactKey).seal({created_at:new Date().toISOString(),tables:data}),{mode:0o600});
  console.log('encrypted_operator_snapshot_written');
 }else if(process.argv[2]==='rules'){
  // Routing rules (admin portal step 1). Actor comes from FETCHX_OPERATOR; rule
  // bodies come from a file, never command-line JSON.
  const config=JSON.parse(await readFile(process.env.GATEWAY_CONFIG??'/run/secrets/gateway.json','utf8'));
  const actor=process.env.FETCHX_OPERATOR??'operator-cli',[,,,action,arg,...rest]=process.argv;
  await loadProviderRules(store.pool,config);
  if(action==='list')console.log(JSON.stringify(providerRuleSources(config),null,1));
  else if(action==='save'){const rule=JSON.parse(await readFile(arg,'utf8'));const current=providerRuleSources(config).find(r=>r.id===rule.id&&r.source==='database');console.log(JSON.stringify(await saveProviderRule(store,rule,{actor,expectedVersion:current?.version??null})));}
  else if(action==='enable'||action==='disable')console.log(JSON.stringify(await setProviderRuleEnabled(store,config,arg,action==='enable',{actor,reason:rest.join(' ')})));
  else if(action==='delete')console.log(JSON.stringify(await deleteProviderRule(store,arg,{actor})));
  else if(action==='audit')console.log(JSON.stringify(await providerRuleAudit(store.pool,{ruleId:arg??null}),null,1));
  else throw Error('usage_rules_list_save_enable_disable_delete_audit');
 }else throw Error('usage_status_reconcile_snapshot_or_rules');
}finally{await store.close();}
