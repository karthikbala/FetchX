// Receives the engine's job.finished events, on a listener of its own that is
// reachable only on the private network (never through the public port).
// Each event is signed: x-fetchx-signature = sha256=HMAC-SHA256(eventKey,
// "<x-fetchx-timestamp>.<raw body>"), and the timestamp must be within 5
// minutes. Settling is idempotent per job, so the engine's retries are safe.
//   POST /internal/engine-events   200 {settled} | 200 {unknown: true} | 401
import Fastify from 'fastify';
import {createHmac, timingSafeEqual} from 'node:crypto';

const WINDOW_S = 300;
const SIGNATURE = /^sha256=([a-f0-9]{64})$/;

const sign = (key, timestamp, body) => createHmac('sha256', key).update(`${timestamp}.`).update(body).digest();

// keys: the current event key, and the previous one during a rotation.
export function verifyEvent(keys, headers, body, now = Date.now()) {
  const timestamp = Number(headers['x-fetchx-timestamp']);
  const signature = SIGNATURE.exec(headers['x-fetchx-signature'] ?? '')?.[1];
  if (!Number.isSafeInteger(timestamp) || Math.abs(now / 1000 - timestamp) > WINDOW_S || !signature) return false;
  const given = Buffer.from(signature, 'hex');
  let ok = false;
  for (const key of keys) ok = timingSafeEqual(sign(key, headers['x-fetchx-timestamp'], body), given) || ok;
  return ok;
}

export function eventsServer(platform) {
  const settings = platform.config.engine ?? {};
  const keys = [settings.eventKey, settings.previousEventKey].filter(key => typeof key === 'string' && key.length >= 32);
  const app = Fastify({logger: false, bodyLimit: 64 * 1024});
  app.addContentTypeParser('application/json', {parseAs: 'buffer'}, (_req, body, done) => done(null, body));
  app.post('/internal/engine-events', async (req, reply) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!keys.length || !verifyEvent(keys, req.headers, raw)) return reply.code(401).send({error: {code: 'unauthorized'}});
    let event;
    try { event = JSON.parse(raw.toString('utf8')); } catch { return reply.code(400).send({error: {code: 'invalid_request'}}); }
    if (event?.type !== 'job.finished') return {ignored: true};
    const row = await platform.front.settle(event.job_id, {tenant: event.tenant, status: event.status, error_code: event.error_code,
      usage: event.usage, webhook_url: event.webhook_url});
    return row ? {settled: row.request} : {unknown: true};
  });
  app.setErrorHandler((error, req, reply) => {
    process.stderr.write(JSON.stringify({event: 'engine_event_failed', name: error?.name ?? null}) + '\n');
    reply.code(error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 503).send({error: {code: 'unavailable'}});
  });
  return app;
}
