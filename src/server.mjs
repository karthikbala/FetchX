// FetchX platform: builds the public HTTP app (the /v1 API, the console API,
// the Stripe webhook) and the private engine-events listener, and, when run
// directly, starts the process. Fetching itself is the engine's
// (karthikbala/fetchx-engine), reached over a private network.
import Fastify from 'fastify';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {timingSafeEqual} from 'node:crypto';
import {GatewayError} from './policy.mjs';
import {sha} from './crypto.mjs';
import {Store} from './store.mjs';
import {Ledger} from './billing/ledger.mjs';
import {Purchases} from './billing/purchases.mjs';
import {EngineClient} from './engine/client.mjs';
import {eventsServer} from './engine/events.mjs';
import {FetchFront} from './fetch/front.mjs';
import {WebhookSender} from './fetch/webhooks.mjs';
import {BatchRunner, BatchService} from './fetch/batches.mjs';
import {FeedbackService} from './fetch/feedback.mjs';
import {registerApi, apiError, API_SCOPES, ANY_SCOPE, UNAVAILABLE_RETRY_SECONDS} from './api/v1.mjs';
import {registerLifecycle} from './api/lifecycle.mjs';
import {Estimator} from './fetch/estimate.mjs';
import {StatusBoard, linksOf} from './status.mjs';
import {ControlIdentity} from './control-identity.mjs';
import {isControlRequest, registerControl} from './control.mjs';
import {ControlStripe, isStripeWebhookRequest, registerStripeWebhook} from './control-stripe.mjs';
import {loadBudgets} from './budgets.mjs';

// Wires the services for one platform. Tests pass their own fakes in `deps`.
export function createPlatform({store, config, deps = {}}) {
  const platform = {store, config};
  if (config.controlPlane?.enabled === true) platform.controlIdentity = deps.identity ?? new ControlIdentity({store, config, mail: deps.mail});
  platform.ledger = deps.ledger ?? new Ledger({store, config});
  platform.purchases = deps.purchases ?? new Purchases({store});
  platform.engine = deps.engine ?? new EngineClient(config.engine, {fetchImpl: deps.engineFetch});
  platform.front = new FetchFront({store, config, ledger: platform.ledger, engine: platform.engine,
    onSettled: () => platform.webhooks?.kick()});
  platform.estimator = new Estimator({config, ledger: platform.ledger, engine: platform.engine, front: platform.front});
  platform.board = deps.board ?? new StatusBoard({store, config, engine: platform.engine});
  // Batches: their items are FetchFront jobs, started by the runner at each site's pace.
  platform.batches = new BatchService({store, config, front: platform.front, engine: platform.engine, ledger: platform.ledger});
  platform.front.batches = platform.batches;
  // Callers' reports of how FetchX handled a page, read by staff in the admin portal.
  platform.feedback = new FeedbackService({store, config, engine: platform.engine, metadataDays: platform.front.limits.metadataDays});
  platform.batchRunner = new BatchRunner({batches: platform.batches, engine: platform.engine, intervalMs: deps.batchIntervalMs});
  platform.batches.kickRunner = () => { if (platform.batchRunner.timer) void platform.batchRunner.kick(); };
  platform.webhooks = new WebhookSender({store, front: platform.front, batches: platform.batches, config, intervalMs: deps.webhookIntervalMs,
    ...(deps.webhookResolve ? {resolve: deps.webhookResolve} : {}), ...(deps.webhookPost ? {post: deps.webhookPost} : {})});
  return platform;
}

export function server(platform, {stripeFetch, stripeAutoProcess = true} = {}) {
  const {config} = platform;
  const app = Fastify({logger: false, bodyLimit: 2 * 1024 * 1024, requestTimeout: 150_000});
  // Some HTTP clients send Content-Type: application/json on every request,
  // also a DELETE or GET with no body: that is no body, not a malformed one.
  // Everything else goes to Fastify's own parser (prototype-poisoning checks included).
  const parseJson = app.getDefaultJsonParser('error', 'ignore');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', {parseAs: 'string'}, (req, body, done) => {
    if (body === '' && ['DELETE', 'GET', 'HEAD', 'OPTIONS'].includes(req.method)) return done(null, undefined);
    return parseJson(req, body, done);
  });
  const stripe = new ControlStripe({store: platform.store, config, purchases: platform.purchases, fetchStripe: stripeFetch});
  app.decorate('stripe', stripe);
  app.decorate('gateway', platform);

  // API keys: console keys (fxk_...) carry scopes; keys provisioned in config
  // (config.projects[id].tokenHash) may call everything.
  app.decorate('authenticate', async (req, scope) => {
    const token = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
    if (!token) throw new GatewayError('unauthorized', 401);
    if (token.startsWith('fxk_')) {
      if (!platform.controlIdentity) throw new GatewayError('unauthorized', 401);
      const principal = await platform.controlIdentity.authenticateKey(token);
      // ANY_SCOPE: any valid key (GET /v1/me tells a key what it may do).
      if (scope !== ANY_SCOPE && !principal.scopes.includes(scope)) throw new GatewayError('api_key_scope_forbidden', 403);
      req.project = principal.project;
      req.keyId = principal.key_id;
      req.key = {id: principal.key_id, name: principal.name ?? null, prefix: principal.prefix ?? null, scopes: principal.scopes};
      return;
    }
    const digest = Buffer.from(sha(token), 'hex');
    for (const [id, project] of Object.entries(config.projects ?? {})) {
      if (typeof project.tokenHash === 'string' && /^[a-f0-9]{64}$/i.test(project.tokenHash)
        && timingSafeEqual(digest, Buffer.from(project.tokenHash, 'hex'))) {
        req.project = id;
        req.keyId = null;
        // A token from the configuration: not a console key, allowed everything.
        req.key = {id: null, name: null, prefix: null, scopes: Object.values(API_SCOPES)};
        return;
      }
    }
    throw new GatewayError('unauthorized', 401);
  });

  app.setErrorHandler((error, req, reply) => {
    if (!(error instanceof GatewayError) && !error.validation && !(error.statusCode < 500)) {
      process.stderr.write(JSON.stringify({event: 'request_failed', path: req.routeOptions?.url ?? null, name: error?.name ?? null}) + '\n');
    }
    if (error?.code === 'unavailable' && error.engineCause) {
      process.stderr.write(JSON.stringify({event: 'engine_unavailable', cause: error.engineCause}) + '\n');
    }
    const {status, body} = apiError(error);
    // An engine that does not answer is usually restarting: the same wait the
    // front door gives when the gateway itself does not answer.
    if (body.error.code === 'unavailable' && !body.error.retry_after_seconds) {
      body.error.details = {status_url: linksOf(config).status_page, retry_after_seconds: UNAVAILABLE_RETRY_SECONDS, ...body.error.details};
      body.error.retry_after_seconds = UNAVAILABLE_RETRY_SECONDS;
    }
    if (body.error.retry_after_seconds) reply.header('retry-after', String(body.error.retry_after_seconds));
    reply.code(status).send(body);
  });
  app.get('/healthz', async () => {
    await platform.store.pool.query('SELECT 1');
    return {ok: true, service: 'FetchX', release: config.release ?? null};
  });
  registerLifecycle(app, {board: platform.board, config});
  registerApi(app, {service: platform.front, ledger: platform.ledger, estimator: platform.estimator, board: platform.board,
    batches: platform.batches, feedback: platform.feedback});
  registerControl(app, platform, {identity: platform.controlIdentity, ledger: platform.ledger, service: platform.front, stripe});
  registerStripeWebhook(app, stripe, {autoProcess: stripeAutoProcess});
  app.addHook('onClose', async () => {
    await platform.batchRunner.close();
    await platform.webhooks.close();
  });
  return app;
}

export {isControlRequest, isStripeWebhookRequest, eventsServer};

async function main() {
  const config = JSON.parse(await readFile(process.env.PLATFORM_CONFIG ?? '/run/secrets/platform.json', 'utf8'));
  const store = new Store(process.env.DATABASE_URL);
  await store.acquireRunnerLock(() => {
    process.stderr.write('platform_ownership_lost\n');
    process.exit(1);
  });
  await store.init();
  const budgets = await loadBudgets(store.pool, config);
  if (budgets.rejected.length) process.stderr.write(`budgets_rejected:${budgets.rejected.join(',')}\n`);
  const platform = createPlatform({store, config});
  if (!platform.engine.configured) process.stderr.write('engine_not_configured\n');
  const app = server(platform);
  const events = eventsServer(platform);
  platform.webhooks.start();
  platform.batchRunner.start();
  // Jobs whose event never came are settled from the engine; jobs it never
  // started are released.
  let reconciling = null;
  const reconcile = setInterval(async () => {
    if (reconciling) return;
    reconciling = platform.front.reconcile().catch(() => process.stderr.write('reconcile_failed\n'));
    try { await reconciling; } finally { reconciling = null; }
  }, 30_000);
  reconcile.unref();
  // Budgets saved in the admin portal by another process.
  const refresh = setInterval(() => loadBudgets(store.pool, config).catch(() => process.stderr.write('budgets_refresh_failed\n')),
    30_000);
  refresh.unref();
  const retention = setInterval(() => Promise.all([platform.front.prune(), platform.batches.prune(), platform.feedback.prune()])
    .catch(() => process.stderr.write('retention_failed\n')), 3_600_000);
  retention.unref();
  const port = (name, fallback) => {
    const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
    if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${name.toLowerCase()}_invalid`);
    return value;
  };
  await app.listen({host: process.env.PLATFORM_HOST ?? '0.0.0.0', port: port('PLATFORM_PORT', 8788)});
  await events.listen({host: process.env.PLATFORM_EVENTS_HOST ?? '0.0.0.0', port: port('PLATFORM_EVENTS_PORT', 8789)});
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      clearInterval(reconcile);
      clearInterval(refresh);
      clearInterval(retention);
      await events.close();
      await app.close();
      await reconciling;
      await store.close();
      process.exit(0);
    });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
