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
import {registerApi, apiError} from './api/v1.mjs';
import {ControlIdentity} from './control-identity.mjs';
import {isControlRequest, registerControl} from './control.mjs';
import {ControlStripe, isStripeWebhookRequest, registerStripeWebhook} from './control-stripe.mjs';

// Wires the services for one platform. Tests pass their own fakes in `deps`.
export function createPlatform({store, config, deps = {}}) {
  const platform = {store, config};
  if (config.controlPlane?.enabled === true) platform.controlIdentity = deps.identity ?? new ControlIdentity({store, config, mail: deps.mail});
  platform.ledger = deps.ledger ?? new Ledger({store, config});
  platform.purchases = deps.purchases ?? new Purchases({store});
  platform.engine = deps.engine ?? new EngineClient(config.engine, {fetchImpl: deps.engineFetch});
  platform.front = new FetchFront({store, config, ledger: platform.ledger, engine: platform.engine,
    onSettled: () => platform.webhooks?.kick()});
  platform.webhooks = new WebhookSender({store, front: platform.front, config, intervalMs: deps.webhookIntervalMs,
    ...(deps.webhookResolve ? {resolve: deps.webhookResolve} : {}), ...(deps.webhookPost ? {post: deps.webhookPost} : {})});
  return platform;
}

export function server(platform, {stripeFetch, stripeAutoProcess = true} = {}) {
  const {config} = platform;
  const app = Fastify({logger: false, bodyLimit: 2 * 1024 * 1024, requestTimeout: 150_000});
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
      if (!principal.scopes.includes(scope)) throw new GatewayError('api_key_scope_forbidden', 403);
      req.project = principal.project;
      req.keyId = principal.key_id;
      return;
    }
    const digest = Buffer.from(sha(token), 'hex');
    for (const [id, project] of Object.entries(config.projects ?? {})) {
      if (typeof project.tokenHash === 'string' && /^[a-f0-9]{64}$/i.test(project.tokenHash)
        && timingSafeEqual(digest, Buffer.from(project.tokenHash, 'hex'))) {
        req.project = id;
        req.keyId = null;
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
    if (body.error.retry_after_seconds) reply.header('retry-after', String(body.error.retry_after_seconds));
    reply.code(status).send(body);
  });
  app.get('/healthz', async () => {
    await platform.store.pool.query('SELECT 1');
    return {ok: true, service: 'FetchX', release: config.release ?? null};
  });
  registerApi(app, {service: platform.front, ledger: platform.ledger});
  registerControl(app, platform, {identity: platform.controlIdentity, ledger: platform.ledger, service: platform.front, stripe});
  registerStripeWebhook(app, stripe, {autoProcess: stripeAutoProcess});
  app.addHook('onClose', async () => {
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
  const platform = createPlatform({store, config});
  if (!platform.engine.configured) process.stderr.write('engine_not_configured\n');
  const app = server(platform);
  const events = eventsServer(platform);
  platform.webhooks.start();
  // Jobs whose event never came are settled from the engine; jobs it never
  // started are released.
  let reconciling = null;
  const reconcile = setInterval(async () => {
    if (reconciling) return;
    reconciling = platform.front.reconcile().catch(() => process.stderr.write('reconcile_failed\n'));
    try { await reconciling; } finally { reconciling = null; }
  }, 30_000);
  reconcile.unref();
  const retention = setInterval(() => platform.front.prune().catch(() => process.stderr.write('retention_failed\n')), 3_600_000);
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
