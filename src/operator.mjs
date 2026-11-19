// Operator CLI, run inside the platform container. Never sends work to a site.
//   status                         release, the engine's status, the last day's jobs, webhook backlog
//   credits <project> <n> <note>   adjust a project's balance (audited)
//   operators list|grant|revoke <email>
// Provider rules, probes and site knowledge are the engine's (its own operator CLI, or the admin portal).
import {readFile} from 'node:fs/promises';
import {Store} from './store.mjs';
import {Ledger} from './billing/ledger.mjs';
import {EngineClient} from './engine/client.mjs';
import {grantOperator, revokeOperator, listOperators} from './control-admin.mjs';

const loadConfig = async () => JSON.parse(await readFile(process.env.PLATFORM_CONFIG ?? '/run/secrets/platform.json', 'utf8'));
const actor = process.env.FETCHX_OPERATOR ?? 'operator-cli';
const print = value => console.log(JSON.stringify(value, null, 1));
const store = new Store(process.env.DATABASE_URL);
const [command, action, arg, ...rest] = process.argv.slice(2);
try {
  if (command === 'status') {
    const config = await loadConfig();
    const jobs = (await store.pool.query(`SELECT status, count(*)::int AS n FROM fetch_settlements
      WHERE created_at > now() - interval '24 hours' GROUP BY status`)).rows;
    const overdue = (await store.pool.query(`SELECT count(*)::int AS n FROM fetch_settlements
      WHERE status = 'pending' AND deadline < now() - interval '2 minutes'`)).rows[0].n;
    const webhooks = (await store.pool.query(`SELECT count(*) FILTER (WHERE delivered_at IS NULL AND gave_up_at IS NULL)::int AS queued,
      count(*) FILTER (WHERE gave_up_at > now() - interval '24 hours')::int AS gave_up_24h FROM webhook_deliveries`)).rows[0];
    let engine;
    try { engine = await new EngineClient(config.engine).status(); } catch (error) { engine = {error: error.code ?? 'unavailable'}; }
    print({release: config.release ?? null, engine, last_24h: jobs, overdue_settlements: overdue, webhooks});
  } else if (command === 'credits') {
    const credits = Number(arg);
    const note = rest.join(' ');
    await store.tx(client => new Ledger({store, config: {}}).adjust(client, {project: action, credits, note, actor}));
    print(await new Ledger({store, config: {}}).balance(action));
  } else if (command === 'operators') {
    if (action === 'list') print(await listOperators(store.pool));
    else if (action === 'grant') print(await grantOperator(store, arg, actor));
    else if (action === 'revoke') print(await revokeOperator(store, arg, actor));
    else throw new Error('usage: operators list|grant <email>|revoke <email>');
  } else {
    throw new Error('usage: status | credits <project> <n> <note> | operators ...');
  }
} finally {
  await store.close();
}
