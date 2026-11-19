// FetchX gateway: builds the HTTP app (public API, console API, Stripe webhook)
// and, when run directly, starts the process.
import Fastify from 'fastify';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {timingSafeEqual} from 'node:crypto';
import {GatewayError} from './policy.mjs';
import {sha} from './crypto.mjs';
import {Store} from './store.mjs';
import {Ledger} from './billing/ledger.mjs';
import {Purchases} from './billing/purchases.mjs';
import {CaptchaSolver} from './captcha/solver.mjs';
import {FetchService} from './fetch/service.mjs';
import {BrowserSlots} from './browser/queue.mjs';
import {BrowserWorkerPool} from './browser/pool.mjs';
import {browserRuntime} from './browser/engine.mjs';
import {registerApi, apiError} from './api/v1.mjs';
import {ControlIdentity} from './control-identity.mjs';
import {isControlRequest, registerControl} from './control.mjs';
import {ControlStripe, isStripeWebhookRequest, registerStripeWebhook} from './control-stripe.mjs';
import {loadProviderRules} from './provider-rules.mjs';
import {interruptProbes} from './admin-ops.mjs';

// Wires the services for one gateway. Tests pass their own fakes in `deps`.
export function createGateway({store, config, deps = {}}) {
  const gateway = {store, config};
  if (config.controlPlane?.enabled === true) gateway.controlIdentity = deps.identity ?? new ControlIdentity({store, config, mail: deps.mail});
  gateway.ledger = deps.ledger ?? new Ledger({store, config});
  gateway.purchases = deps.purchases ?? new Purchases({store});
  gateway.captchaSolver = deps.solver ?? new CaptchaSolver(store, config, deps.solverOptions);
  const runtime = deps.runtime !== undefined ? deps.runtime : (browserRuntime(config).runtime ?? null);
  // The pool serves the autoscaler its queue metrics from the slots below.
  const pool = deps.browserPool !== undefined ? deps.browserPool
    : config.browser?.pool ? new BrowserWorkerPool(config.browser.pool, {runtime: async () => browserRuntime(config),
      metrics: async () => ({queue: gateway.slots.metrics(), max_concurrent_requests: config.browser.maxConcurrentRequests ?? 64})}) : null;
  gateway.browserPool = pool;
  gateway.slots = deps.slots ?? new BrowserSlots({pool, localConcurrency: config.browser?.maxConcurrent ?? 1, runner: deps.browserRunner});
  gateway.service = deps.service ?? new FetchService({store, config, ledger: gateway.ledger, solver: gateway.captchaSolver,
    slots: gateway.slots, runtime, resolve: deps.resolve, exchangeImpl: deps.exchange});
  return gateway;
}

export function server(gateway, {stripeFetch, stripeAutoProcess = true} = {}) {
  const {config} = gateway;
  const app = Fastify({logger: false, bodyLimit: 2 * 1024 * 1024, requestTimeout: 150_000});
  const stripe = new ControlStripe({store: gateway.store, config, purchases: gateway.purchases, fetchStripe: stripeFetch});
  app.decorate('stripe', stripe);
  app.decorate('gateway', gateway);

  // API keys: console keys (fxk_...) carry scopes; keys provisioned in config
  // (config.projects[id].tokenHash) may call everything.
  app.decorate('authenticate', async (req, scope) => {
    const token = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
    if (!token) throw new GatewayError('unauthorized', 401);
    if (token.startsWith('fxk_')) {
      if (!gateway.controlIdentity) throw new GatewayError('unauthorized', 401);
      const principal = await gateway.controlIdentity.authenticateKey(token);
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
    const {status, body} = apiError(error);
    if (body.error.retry_after_seconds) reply.header('retry-after', String(body.error.retry_after_seconds));
    reply.code(status).send(body);
  });
  app.get('/healthz', async () => {
    await gateway.store.pool.query('SELECT 1');
    return {ok: true, service: 'FetchX', release: config.release ?? null};
  });
  registerApi(app, {service: gateway.service, ledger: gateway.ledger});
  registerControl(app, gateway, {identity: gateway.controlIdentity, ledger: gateway.ledger, service: gateway.service, stripe});
  registerStripeWebhook(app, stripe, {autoProcess: stripeAutoProcess});
  app.addHook('onClose', async () => {
    await gateway.service.close();
    await gateway.browserPool?.close();
  });
  return app;
}

export {isControlRequest, isStripeWebhookRequest};

async function main() {
  const config = JSON.parse(await readFile(process.env.GATEWAY_CONFIG ?? '/run/secrets/gateway.json', 'utf8'));
  const store = new Store(process.env.DATABASE_URL);
  await store.acquireRunnerLock(() => {
    process.stderr.write('gateway_ownership_lost\n');
    process.exit(1);
  });
  await store.init();
  const rules = await loadProviderRules(store.pool, config);
  if (rules.rejected.length) process.stderr.write(`provider_rules_rejected:${rules.rejected.length}\n`);
  await interruptProbes(store.pool);
  const gateway = createGateway({store, config});
  await gateway.captchaSolver.recover();
  const recovered = await gateway.service.recover();
  if (recovered) process.stderr.write(`fetch_requests_recovered_uncertain:${recovered}\n`);
  await gateway.browserPool?.start();
  const app = server(gateway);
  const refreshMs = config.providerRulesRefreshMs ?? 30_000;
  const refresh = setInterval(() => loadProviderRules(store.pool, config)
    .catch(() => process.stderr.write('provider_rules_refresh_failed\n')), refreshMs);
  refresh.unref();
  let pruning = null;
  const retention = setInterval(async () => {
    if (pruning) return;
    pruning = gateway.service.prune().catch(() => process.stderr.write('retention_failed\n'));
    try { await pruning; } finally { pruning = null; }
  }, 300_000);
  retention.unref();
  const port = process.env.GATEWAY_PORT === undefined ? 8788 : Number(process.env.GATEWAY_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('gateway_port_invalid');
  await app.listen({host: process.env.GATEWAY_HOST ?? '0.0.0.0', port});
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      clearInterval(refresh);
      clearInterval(retention);
      await app.close();
      await pruning;
      await store.close();
      process.exit(0);
    });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
