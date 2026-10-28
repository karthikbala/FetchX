import {reconcileResidential} from './residential.mjs';
// Run inside the gateway container by an operator. Never dispatches source work.
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {Store} from './store.mjs';
import {Sealer} from './crypto.mjs';
import {gatewayStatus} from './status.mjs';
const store=new Store(process.env.DATABASE_URL);
try{
 if(process.argv[2]==='status'){
  const config=JSON.parse(await readFile(process.env.GATEWAY_CONFIG??'/run/secrets/gateway.json','utf8'));
  console.log(JSON.stringify(await gatewayStatus(store,config)));
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
  for(const name of ['residential_reconciliations','residential_usage','browser_state','workflows','operations','attempts','ledger','source_limits','pool_cursor','project_admission','admission_queue','operation_outcomes','route_health','route_health_workflows','route_health_pools'])data[name]=(await store.pool.query('SELECT * FROM '+name)).rows;
  await writeFile(process.argv[3],new Sealer(config.artifactKey).seal({created_at:new Date().toISOString(),tables:data}),{mode:0o600});
  console.log('encrypted_operator_snapshot_written');
 }else throw Error('usage_status_reconcile_or_snapshot');
}finally{await store.close();}
