// Operator CLI, run inside the gateway container. Never sends work to a site.
//   status                         service, captcha and pending-request summary
//   credits <project> <n> <note>   adjust a project's balance (audited)
//   rules list|save|enable|disable|delete|audit ...
//   operators list|grant|revoke <email>
import {readFile} from 'node:fs/promises';
import {Store} from './store.mjs';
import {Ledger} from './billing/ledger.mjs';
import {CaptchaSolver} from './captcha/solver.mjs';
import {grantOperator, revokeOperator, listOperators} from './control-admin.mjs';
import {loadProviderRules, providerRuleSources, saveProviderRule, setProviderRuleEnabled, deleteProviderRule, providerRuleAudit} from './provider-rules.mjs';

const loadConfig = async () => JSON.parse(await readFile(process.env.GATEWAY_CONFIG ?? '/run/secrets/gateway.json', 'utf8'));
const actor = process.env.FETCHX_OPERATOR ?? 'operator-cli';
const print = value => console.log(JSON.stringify(value, null, 1));
const store = new Store(process.env.DATABASE_URL);
const [command, action, arg, ...rest] = process.argv.slice(2);
try {
  if (command === 'status') {
    const config = await loadConfig();
    const requests = (await store.pool.query(`SELECT status, count(*)::int AS n FROM fetch_requests
      WHERE created_at > now() - interval '24 hours' GROUP BY status`)).rows;
    print({release: config.release ?? null, last_24h: requests, captcha: await new CaptchaSolver(store, config).status()});
  } else if (command === 'credits') {
    const credits = Number(arg);
    const note = rest.join(' ');
    await store.tx(client => new Ledger({store, config: {}}).adjust(client, {project: action, credits, note, actor}));
    print(await new Ledger({store, config: {}}).balance(action));
  } else if (command === 'rules') {
    const config = await loadConfig();
    await loadProviderRules(store.pool, config);
    if (action === 'list') print(providerRuleSources(config));
    else if (action === 'save') {
      // Rule bodies come from a file, never from command-line JSON.
      const rule = JSON.parse(await readFile(arg, 'utf8'));
      const current = providerRuleSources(config).find(r => r.id === rule.id && r.source === 'database');
      print(await saveProviderRule(store, rule, {actor, expectedVersion: current?.version ?? null}));
    } else if (action === 'enable' || action === 'disable') {
      print(await setProviderRuleEnabled(store, config, arg, action === 'enable', {actor, reason: rest.join(' ')}));
    } else if (action === 'delete') print(await deleteProviderRule(store, arg, {actor}));
    else if (action === 'audit') print(await providerRuleAudit(store.pool, {ruleId: arg ?? null}));
    else throw new Error('usage: rules list|save <file>|enable <id> <reason>|disable <id> <reason>|delete <id>|audit [id]');
  } else if (command === 'operators') {
    if (action === 'list') print(await listOperators(store.pool));
    else if (action === 'grant') print(await grantOperator(store, arg, actor));
    else if (action === 'revoke') print(await revokeOperator(store, arg, actor));
    else throw new Error('usage: operators list|grant <email>|revoke <email>');
  } else {
    throw new Error('usage: status | credits <project> <n> <note> | rules ... | operators ...');
  }
} finally {
  await store.close();
}
