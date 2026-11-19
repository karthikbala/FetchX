#!/usr/bin/env node
// Runs the gateway on loopback for working on the console (website/) locally.
// Sign-in codes go to a private mailbox file; no email, provider, browser or
// payment is used. --fixture answers every fetch from an offline fake site.
import {randomBytes, createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir, chmod, lstat, readFile, open} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {Store} from '../src/store.mjs';
import {GatewayError} from '../src/policy.mjs';
import {createGateway, server} from '../src/server.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)), '.local/console-preview');
const BASE = 'http://127.0.0.1:8789';
const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];
const HELP = `Usage: node scripts/control-preview.mjs --database-url <local gateway_test_* PostgreSQL URL> [--fixture] [--agent-connect] [--origin <loopback website origin>]

CONTROL_PREVIEW_DATABASE_URL may supply the database URL. The database is created
if absent and reused. The gateway listens on ${BASE}; the default website origin
is http://127.0.0.1:4331.
--fixture        answer fetches from an offline fake site: /success, /forbidden,
                 /not-found, /unknown and /slow on any host. Nothing leaves the machine.
--agent-connect  enable FetchX Connect.
Without --fixture, fetches go to the real site over direct HTTP only.
Codes go to .local/console-preview/mailbox.jsonl. No email is sent.
`;

function parseArguments(argv) {
  const options = {database: process.env.CONTROL_PREVIEW_DATABASE_URL, fixture: false, agentConnect: false, origin: 'http://127.0.0.1:4331'};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return {help: true};
    if (arg === '--fixture') { options.fixture = true; continue; }
    if (arg === '--agent-connect') { options.agentConnect = true; continue; }
    if (arg === '--database-url' || arg === '--origin') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('preview_argument_missing');
      options[arg === '--database-url' ? 'database' : 'origin'] = value;
      continue;
    }
    throw new Error('preview_argument_unknown');
  }
  if (!options.database) throw new Error('preview_disposable_database_required');
  let url, origin;
  try { url = new URL(options.database); origin = new URL(options.origin); } catch { throw new Error('preview_url_invalid'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !LOOPBACK.includes(url.hostname)
    || !/^\/gateway_test_[A-Za-z0-9_]+$/.test(decodeURIComponent(url.pathname)) || url.hash || url.search) {
    throw new Error('preview_disposable_local_database_required');
  }
  if (!['http:', 'https:'].includes(origin.protocol) || !LOOPBACK.includes(origin.hostname) || origin.origin !== options.origin) {
    throw new Error('preview_exact_loopback_origin_required');
  }
  return {...options, url, databaseName: decodeURIComponent(url.pathname.slice(1))};
}

async function privateDirectory(path) {
  await mkdir(path, {recursive: true, mode: 0o700});
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('preview_private_directory_required');
  await chmod(path, 0o700);
}

// O_NOFOLLOW stops an existing symlink from redirecting a secret write.
async function privateWrite(path, value, {append = false, exclusive = false} = {}) {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW
    | (append ? constants.O_APPEND : exclusive ? constants.O_EXCL : constants.O_TRUNC);
  const file = await open(path, flags, 0o600);
  try { await file.chmod(0o600); await file.writeFile(value); } finally { await file.close(); }
}

// Secrets are generated once per database, so sessions and stored content survive restarts.
async function stateFor(options) {
  await privateDirectory(ROOT);
  const fingerprint = createHash('sha256').update(JSON.stringify([options.url.hostname, options.url.port, options.url.username, options.databaseName])).digest('hex');
  const path = join(ROOT, 'state.json');
  try {
    const state = JSON.parse(await readFile(path, 'utf8'));
    if (state.version !== 2 || state.fingerprint !== fingerprint) throw new Error('preview_state_mismatch_use_the_same_database');
    return state;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const state = {version: 2, fingerprint, artifactKey: randomBytes(32).toString('hex'), bridgeSecret: randomBytes(32).toString('hex')};
    await privateWrite(path, JSON.stringify(state, null, 2) + '\n', {exclusive: true});
    return state;
  }
}

async function ensureDatabase(options) {
  const adminUrl = new URL(options.url);
  adminUrl.pathname = '/postgres';
  const admin = new pg.Client({connectionString: adminUrl.href, connectionTimeoutMillis: 5000});
  try {
    await admin.connect();
    if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [options.databaseName])).rowCount) {
      // The name matched gateway_test_[A-Za-z0-9_]+ above.
      try { await admin.query(`CREATE DATABASE "${options.databaseName}"`); } catch (error) { if (error.code !== '42P04') throw error; }
    }
  } finally {
    await admin.end();
  }
}

// The offline fake site used by --fixture.
async function fixtureExchange(request, destination) {
  const path = destination.url.pathname;
  if (path === '/slow') await new Promise(done => setTimeout(done, 1500));
  if (path === '/unknown') throw Object.assign(new GatewayError('source_timeout', 504), {dispatched: true});
  const status = path === '/forbidden' ? 403 : path === '/not-found' ? 404 : 200;
  const body = request.method === 'HEAD' ? Buffer.alloc(0) : Buffer.from(`<html><head><title>Fixture ${status}</title></head><body><main>
    <h1>Offline fixture</h1><p>Status ${status} for ${destination.url.href}</p><a href="/success">success</a></main></body></html>`);
  return {status, headers: {'content-type': 'text/html; charset=utf-8'}, encoded: body, wire_bytes: body.length + 200, provider_status: null};
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) { process.stdout.write(HELP); return; }
  const state = await stateFor(options);
  const mailbox = join(ROOT, 'mailbox.jsonl');
  await privateWrite(mailbox, '', {append: true});
  const config = {
    release: 'console-preview', artifactKey: state.artifactKey, projects: {}, proxies: [],
    controlPlane: {enabled: true, origins: [options.origin], bridgeSecret: state.bridgeSecret, sessionSecure: false, allowLoopbackDevelopment: true,
      apiBaseUrl: BASE, agentConnectEnabled: options.agentConnect, creditPolicy: {trialCredits: 1000}},
  };
  const env = [`FETCHX_CONTROL_URL=${BASE}`, `FETCHX_CONTROL_SECRET=${state.bridgeSecret}`, 'FETCHX_CONTROL_ALLOW_LOOPBACK=true',
    'SITE_ENV=development', `ALLOWED_ORIGINS=${options.origin}`].join('\n') + '\n';
  await privateWrite(join(ROOT, 'bridge.env'), env);
  await ensureDatabase(options);
  const store = new Store(options.url.href);
  let app;
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try { await app?.close(); } finally { await store.close(); }
  };
  try {
    await store.acquireRunnerLock(() => { process.stderr.write('preview_database_ownership_lost\n'); void stop().finally(() => { process.exitCode = 1; }); });
    await store.init();
    const gateway = createGateway({store, config, deps: {
      runtime: null, browserPool: null,
      ...(options.fixture ? {exchange: fixtureExchange, resolve: async () => [{address: '93.184.216.34', family: 4}]} : {}),
      mail: {configured: true, delivery: 'local_private_mailbox', sendCode: async message =>
        privateWrite(mailbox, JSON.stringify({delivered_by: 'local_private_mailbox', ...message}) + '\n', {append: true})},
    }});
    await gateway.service.recover();
    app = server(gateway, {stripeAutoProcess: false});
    await app.listen({host: '127.0.0.1', port: 8789});
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stop(); });
    process.stdout.write(`FetchX console preview: ${BASE}\nWebsite origin: ${options.origin}\nDatabase: ${options.databaseName}\n`
      + `Fetches: ${options.fixture ? 'offline fixture site' : 'real sites, direct HTTP only'}\nSign-in codes: ${mailbox}\nWebsite bridge settings: ${join(ROOT, 'bridge.env')}\n`);
  } catch (error) {
    await stop();
    throw error;
  }
}

main().catch(error => {
  // Never print database URLs, mail contents, exception text or secrets.
  const safe = /^preview_[a-z0-9_]+$/.test(error?.message ?? '') ? error.message
    : error?.code === 'EADDRINUSE' ? 'preview_port_8789_in_use' : 'preview_startup_failed';
  process.stderr.write(safe + '\n');
  process.exitCode = 1;
});
