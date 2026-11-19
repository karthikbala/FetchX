#!/usr/bin/env node
// Runs the platform on loopback for working on the console (website/) locally.
// Sign-in codes go to a private mailbox file; no email or payment is used.
// --fixture answers every fetch from an in-process fake engine; otherwise
// fetches go to a FetchX engine you run on loopback (--engine-url).
import {randomBytes, createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir, chmod, lstat, readFile, open} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {Store} from '../src/store.mjs';
import {createPlatform, server} from '../src/server.mjs';
import {fakeEngine} from '../test/fake-engine.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)), '.local/console-preview');
const BASE = 'http://127.0.0.1:8789';
const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];
const HELP = `Usage: node scripts/control-preview.mjs --database-url <local gateway_test_* PostgreSQL URL>
         (--fixture | --engine-url <loopback engine URL>) [--agent-connect] [--origin <loopback website origin>]

CONTROL_PREVIEW_DATABASE_URL may supply the database URL. The database is created
if absent and reused. The platform listens on ${BASE}; the default website origin
is http://127.0.0.1:4331.
--fixture        answer fetches from an in-process fake engine: /success, /forbidden,
                 /not-found, /unknown and /slow on any host. Nothing leaves the machine.
--engine-url     use a FetchX engine on loopback, e.g. http://127.0.0.1:8790; its
                 service token comes from CONTROL_PREVIEW_ENGINE_TOKEN.
--agent-connect  enable FetchX Connect.
Codes go to .local/console-preview/mailbox.jsonl. No email is sent.
`;

function parseArguments(argv) {
  const options = {database: process.env.CONTROL_PREVIEW_DATABASE_URL, fixture: false, agentConnect: false, origin: 'http://127.0.0.1:4331',
    engineUrl: null};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return {help: true};
    if (arg === '--fixture') { options.fixture = true; continue; }
    if (arg === '--agent-connect') { options.agentConnect = true; continue; }
    if (arg === '--database-url' || arg === '--origin' || arg === '--engine-url') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('preview_argument_missing');
      options[{'--database-url': 'database', '--origin': 'origin', '--engine-url': 'engineUrl'}[arg]] = value;
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
  if (options.fixture === Boolean(options.engineUrl)) throw new Error('preview_choose_fixture_or_engine_url');
  if (options.engineUrl) {
    let engine;
    try { engine = new URL(options.engineUrl); } catch { throw new Error('preview_url_invalid'); }
    if (engine.protocol !== 'http:' || !LOOPBACK.includes(engine.hostname) || engine.pathname !== '/' || engine.search || engine.username) {
      throw new Error('preview_loopback_engine_url_required');
    }
    if ((process.env.CONTROL_PREVIEW_ENGINE_TOKEN ?? '').length < 32) throw new Error('preview_engine_token_required');
    options.engineUrl = engine.origin;
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
    if (![2, 3].includes(state.version) || state.fingerprint !== fingerprint) throw new Error('preview_state_mismatch_use_the_same_database');
    // Version 2 called the sealing key artifactKey.
    return {sealingKey: state.sealingKey ?? state.artifactKey, bridgeSecret: state.bridgeSecret};
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const state = {version: 3, fingerprint, sealingKey: randomBytes(32).toString('hex'), bridgeSecret: randomBytes(32).toString('hex')};
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

// The offline fake site used by --fixture, as engine outcomes.
function fixtureOutcome(request) {
  let path;
  try { path = new URL(request.url).pathname; } catch { path = '/'; }
  const page = status => `<html><head><title>Fixture ${status}</title></head><body><main>
    <h1>Offline fixture</h1><p>Status ${status} for ${request.url}</p><a href="/success">success</a></main></body></html>`;
  if (path === '/forbidden') return {status: 'failed', planned: ['http'], body: page(403)};
  if (path === '/unknown') return {status: 'failed', planned: ['http'], error_code: 'uncertain', body: ''};
  // A site's 404 is an answer, and is billed as a success.
  if (path === '/not-found') return {planned: ['http'], body: page(404), data: {status_code: 404}};
  return {planned: ['http'], body: page(200), hold: path === '/slow' ? new Promise(done => setTimeout(done, 1500)) : undefined};
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) { process.stdout.write(HELP); return; }
  const state = await stateFor(options);
  const mailbox = join(ROOT, 'mailbox.jsonl');
  await privateWrite(mailbox, '', {append: true});
  const engineToken = options.fixture ? randomBytes(32).toString('hex') : process.env.CONTROL_PREVIEW_ENGINE_TOKEN;
  const config = {
    release: 'console-preview', sealingKey: state.sealingKey, projects: {},
    engine: {url: options.engineUrl ?? 'http://engine.preview:8790', serviceToken: engineToken},
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
    const platform = createPlatform({store, config, deps: {
      ...(options.fixture ? {engineFetch: fakeEngine({script: fixtureOutcome, token: engineToken}).fetchImpl} : {}),
      // Customer webhooks are not sent from the preview.
      webhookPost: async () => 200,
      mail: {configured: true, delivery: 'local_private_mailbox', sendCode: async message =>
        privateWrite(mailbox, JSON.stringify({delivered_by: 'local_private_mailbox', ...message}) + '\n', {append: true})},
    }});
    app = server(platform, {stripeAutoProcess: false});
    await app.listen({host: '127.0.0.1', port: 8789});
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stop(); });
    process.stdout.write(`FetchX console preview: ${BASE}\nWebsite origin: ${options.origin}\nDatabase: ${options.databaseName}\n`
      + `Fetches: ${options.fixture ? 'offline fixture engine' : `engine at ${options.engineUrl}`}\nSign-in codes: ${mailbox}\nWebsite bridge settings: ${join(ROOT, 'bridge.env')}\n`);
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
