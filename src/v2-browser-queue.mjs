import {randomUUID} from 'node:crypto';
import {GatewayError,fail} from './policy.mjs';

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export function browserQueuePolicy(raw){
 if(raw===undefined)return null;
 if(!object(raw)||Object.keys(raw).some(key=>!['enabled','max_pending','max_pending_per_project','wait_timeout_ms'].includes(key))||typeof raw.enabled!=='boolean')fail('browser_queue_configuration',503);
 if(!raw.enabled)return null;
 const policy={max_pending:64,max_pending_per_project:8,wait_timeout_ms:45000,...raw};
 for(const [key,max]of [['max_pending',4096],['max_pending_per_project',4096],['wait_timeout_ms',300000]])if(!Number.isSafeInteger(policy[key])||policy[key]<1||policy[key]>max)fail('browser_queue_configuration',503);
 if(policy.max_pending_per_project>policy.max_pending)fail('browser_queue_configuration',503);
 return policy;
}

export async function initBrowserQueue(pool){
 await pool.query(`CREATE TABLE IF NOT EXISTS v2_browser_queue(
  id uuid PRIMARY KEY,position bigserial NOT NULL,project text NOT NULL,key text NOT NULL,input_hash text NOT NULL,
  state text NOT NULL CHECK(state IN ('waiting','claimed','finished','cancelled','timed_out')),
  queued_at timestamptz NOT NULL DEFAULT clock_timestamp(),deadline timestamptz NOT NULL,finished_at timestamptz,
  UNIQUE(project,key));
  CREATE INDEX IF NOT EXISTS v2_browser_queue_waiting ON v2_browser_queue(project,position) WHERE state='waiting';
  CREATE INDEX IF NOT EXISTS v2_browser_queue_finished ON v2_browser_queue(finished_at) WHERE state='timed_out';
  CREATE TABLE IF NOT EXISTS v2_browser_queue_cursor(id int PRIMARY KEY CHECK(id=1),project text);
  INSERT INTO v2_browser_queue_cursor(id) VALUES(1) ON CONFLICT DO NOTHING;
  CREATE TABLE IF NOT EXISTS v2_browser_queue_timeouts(at timestamptz NOT NULL DEFAULT clock_timestamp());
  CREATE INDEX IF NOT EXISTS v2_browser_queue_timeouts_at ON v2_browser_queue_timeouts(at);`);
}

// Tickets belong to live handlers, never to a background source executor.
// Restart cancels both waiting tickets and claims; operation recovery separately
// retains any dispatched operation and its original accounting reservations.
export async function recoverBrowserQueue(pool){
 await pool.query("UPDATE v2_browser_queue SET state='cancelled',finished_at=clock_timestamp() WHERE state IN ('waiting','claimed')");
}

async function expire(client){
 await client.query(`WITH expired AS (UPDATE v2_browser_queue SET state='timed_out',finished_at=clock_timestamp() WHERE state='waiting' AND deadline<=clock_timestamp() RETURNING deadline)
  INSERT INTO v2_browser_queue_timeouts(at) SELECT deadline FROM expired`);
 await client.query("DELETE FROM v2_browser_queue_timeouts WHERE at<=clock_timestamp()-interval '5 minutes'");
}

export class BrowserAdmissionQueue{
 #closing=false;
 #waiters=new Map();
 #timer;
 #pumping=false;
 constructor(store,config,pool){
  this.store=store;this.config=config;this.pool=pool;
  this.policy=browserQueuePolicy(config.v2?.browser_queue);
  if(!this.policy||!pool)fail('browser_queue_configuration',503);
 }

 async #enqueue(project,key,hash){
  if(this.#closing)fail('browser_queue_cancelled',503);
  return this.store.tx(async client=>{
   await client.query('SELECT pg_advisory_xact_lock(1002)');
   if(this.#closing)fail('browser_queue_cancelled',503);
   await expire(client);
   const operation=(await client.query('SELECT * FROM v2_operations WHERE project=$1 AND key=$2',[project,key])).rows[0];
   if(operation){if(operation.input_hash!==hash)fail('idempotency_conflict',409);return {operation};}
   const prior=(await client.query('SELECT * FROM v2_browser_queue WHERE project=$1 AND key=$2',[project,key])).rows[0];
   if(prior){
    if(prior.input_hash!==hash)fail('idempotency_conflict',409);
    if(['waiting','claimed'].includes(prior.state))fail('browser_queue_running',409);
   }
   const {rows:[counts]}=await client.query("SELECT count(*)::int pending,count(*) FILTER(WHERE project=$1)::int project_pending FROM v2_browser_queue WHERE state='waiting'",[project]);
   if(counts.pending>=this.policy.max_pending||counts.project_pending>=this.policy.max_pending_per_project)fail('browser_queue_full',503);
   const id=randomUUID();
   const {rows:[ticket]}=await client.query(`INSERT INTO v2_browser_queue(id,project,key,input_hash,state,deadline) VALUES($1,$2,$3,$4,'waiting',clock_timestamp()+$5*interval '1 millisecond')
    ON CONFLICT(project,key) DO UPDATE SET id=EXCLUDED.id,position=EXCLUDED.position,state='waiting',queued_at=EXCLUDED.queued_at,deadline=EXCLUDED.deadline,finished_at=NULL RETURNING *`,[id,project,key,hash,this.policy.wait_timeout_ms]);
   return {ticket};
  });
 }

 async #turn(client,ticket){
   await expire(client);
   if(this.#closing)return {error:'browser_queue_cancelled'};
   const current=(await client.query('SELECT state FROM v2_browser_queue WHERE id=$1',[ticket.id])).rows[0];
   if(current?.state!=='waiting')return {error:current?.state==='timed_out'?'browser_queue_timeout':'browser_queue_cancelled'};
   const {rows:[head]}=await client.query(`SELECT q.id FROM v2_browser_queue q CROSS JOIN v2_browser_queue_cursor c
    WHERE q.state='waiting' AND c.id=1 ORDER BY CASE WHEN c.project IS NULL OR q.project COLLATE "C">c.project COLLATE "C" THEN 0 ELSE 1 END,q.project COLLATE "C",q.position LIMIT 1`);
   if(head?.id!==ticket.id)return null;
   // Count claims not yet represented by an operation. Once admitted, the
   // normal transaction owns the global slot and remains authoritative.
   const {rows:[active]}=await client.query(`SELECT
    (SELECT count(*) FROM v2_operations WHERE state IN ('reserved','running'))+
    (SELECT count(*) FROM attempts WHERE state IN ('reserved','sent'))+
    (SELECT count(*) FROM v2_browser_queue q WHERE q.state='claimed' AND NOT EXISTS(SELECT 1 FROM v2_operations o WHERE o.project=q.project AND o.key=q.key)) AS n`);
   if(Number(active.n)>=(this.config.maxConcurrentRequests??4))return null;
   return true;
 }

 async #claim(ticket,runtime){
  // Worker health may take hundreds of milliseconds during an outage. Never
  // hold the global admission lock or a DB transaction during those probes.
  let worker;
  try{worker=await this.pool.acquire(runtime);}catch(error){if(error instanceof GatewayError&&error.code==='browser_capacity')return null;throw error;}
  try{
   const claimed=await this.store.tx(async client=>{
    await client.query('SELECT pg_advisory_xact_lock(1002)');
    const current=await this.#turn(client,ticket);
    if(current!==true)return current;
    const updated=await client.query("UPDATE v2_browser_queue SET state='claimed' WHERE id=$1 AND state='waiting' AND deadline>clock_timestamp() RETURNING id",[ticket.id]);
    if(!updated.rowCount)return null;
    await client.query('UPDATE v2_browser_queue_cursor SET project=$1 WHERE id=1',[ticket.project]);
    return true;
   });
   if(claimed===true)return worker;
   worker.release();return claimed;
  }catch(error){worker.release();throw error;}
 }

 async acquire(project,key,hash,runtime){
  const {ticket,operation}=await this.#enqueue(project,key,hash);
  if(operation)return {operation};
  try{
   if(this.#closing)fail('browser_queue_cancelled',503);
   return await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>void this.#timeout(ticket.id),Math.max(1,new Date(ticket.deadline).getTime()-Date.now()));
    this.#waiters.set(ticket.id,{ticket,runtime,resolve,reject,timer});
    this.#schedule(0);
   });
  }catch(error){await this.#finish(ticket.id).catch(()=>{});throw error;}
 }

 #settle(id,error,worker){
  const waiter=this.#waiters.get(id);
  if(!waiter){worker?.release();return;}
  clearTimeout(waiter.timer);this.#waiters.delete(id);
  if(!this.#waiters.size){clearTimeout(this.#timer);this.#timer=null;}
  if(error)waiter.reject(error);
  else waiter.resolve({worker,finish:()=>this.#finish(id)});
 }

 async #timeout(id){
  try{
   const state=await this.store.tx(async client=>{
    await client.query('SELECT pg_advisory_xact_lock(1002)');await expire(client);
    return (await client.query('SELECT state FROM v2_browser_queue WHERE id=$1',[id])).rows[0]?.state;
   });
   if(state!=='claimed')this.#settle(id,new GatewayError(state==='timed_out'?'browser_queue_timeout':'browser_queue_cancelled',503));
  }catch(error){this.#settle(id,error);}
 }

 #schedule(delay=250){
  if(this.#closing||this.#pumping||!this.#waiters.size)return;
  if(this.#timer){if(delay)return;clearTimeout(this.#timer);}
  this.#timer=setTimeout(()=>{this.#timer=null;void this.#pump();},delay);
 }

 async #pick(){
  return this.store.tx(async client=>{
   await client.query('SELECT pg_advisory_xact_lock(1002)');await expire(client);
   const states=(await client.query('SELECT id,state FROM v2_browser_queue WHERE id=ANY($1::uuid[])',[[...this.#waiters.keys()]])).rows;
   const head=(await client.query(`SELECT q.id FROM v2_browser_queue q CROSS JOIN v2_browser_queue_cursor c
    WHERE q.state='waiting' AND c.id=1 ORDER BY CASE WHEN c.project IS NULL OR q.project COLLATE "C">c.project COLLATE "C" THEN 0 ELSE 1 END,q.project COLLATE "C",q.position LIMIT 1`)).rows[0];
   if(!head||!this.#waiters.has(head.id))return {states};
   const active=(await client.query(`SELECT
    (SELECT count(*) FROM v2_operations WHERE state IN ('reserved','running'))+
    (SELECT count(*) FROM attempts WHERE state IN ('reserved','sent'))+
    (SELECT count(*) FROM v2_browser_queue q WHERE q.state='claimed' AND NOT EXISTS(SELECT 1 FROM v2_operations o WHERE o.project=q.project AND o.key=q.key)) AS n`)).rows[0];
   return {states,head:Number(active.n)<(this.config.maxConcurrentRequests??4)?head:null};
  });
 }

 async #pump(){
  this.#pumping=true;
  try{
   // One pump serves the live handlers; queued traffic never creates a SQL
   // polling loop per request. It hands back slots and cannot execute sources.
   for(let claims=0;!this.#closing&&this.#waiters.size&&claims<64;claims++){
    const {states,head}=await this.#pick();
    for(const row of states)if(row.state!=='waiting')this.#settle(row.id,new GatewayError(row.state==='timed_out'?'browser_queue_timeout':'browser_queue_cancelled',503));
    const waiter=this.#waiters.get(head?.id);
    if(!waiter)break;
    const result=await this.#claim(waiter.ticket,waiter.runtime);
    if(!result)break;
    this.#settle(waiter.ticket.id,result.error?new GatewayError(result.error,503):null,result.error?null:result);
   }
  }catch(error){for(const id of this.#waiters.keys())this.#settle(id,error);}
  finally{this.#pumping=false;this.#schedule();}
 }

 async #finish(id){
  await this.store.pool.query("UPDATE v2_browser_queue SET state=CASE WHEN state='claimed' THEN 'finished' ELSE 'cancelled' END,finished_at=clock_timestamp() WHERE id=$1 AND state IN ('waiting','claimed')",[id]);
  this.#schedule(0);
 }

 async close(){
  this.#closing=true;
  clearTimeout(this.#timer);this.#timer=null;
  for(const id of this.#waiters.keys())this.#settle(id,new GatewayError('browser_queue_cancelled',503));
  await this.store.tx(async client=>{
   await client.query('SELECT pg_advisory_xact_lock(1002)');
   await client.query("UPDATE v2_browser_queue SET state='cancelled',finished_at=clock_timestamp() WHERE state='waiting'");
  });
 }

 async metrics(){
  const {rows:[row]}=await this.store.pool.query(`SELECT
   count(*) FILTER(WHERE state='waiting' AND deadline>clock_timestamp())::int pending,
   count(*) FILTER(WHERE state='claimed')::int active,
   coalesce(max(extract(epoch FROM (clock_timestamp()-queued_at))*1000) FILTER(WHERE state='waiting' AND deadline>clock_timestamp()),0) oldest_wait_ms,
   ((SELECT count(*) FROM v2_browser_queue_timeouts WHERE at>clock_timestamp()-interval '5 minutes')+
    count(*) FILTER(WHERE state='waiting' AND deadline<=clock_timestamp() AND deadline>clock_timestamp()-interval '5 minutes'))::int recent_timeouts
   FROM v2_browser_queue WHERE state IN ('waiting','claimed')`);
  return {pending:row.pending,active:row.active,oldest_wait_ms:Math.max(0,Math.floor(Number(row.oldest_wait_ms))),recent_timeouts:row.recent_timeouts};
 }
}
