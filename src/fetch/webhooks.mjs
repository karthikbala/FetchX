// Customer webhooks. When a job with webhook_url settles, a row is queued in
// webhook_deliveries in the same transaction. This sender POSTs the finished
// result (without the body), signed with the project's webhook secret
// (HMAC-SHA256 over "<timestamp>.<raw body>"), and tries 3 times with backoff
// (2 s, 8 s). The URL is checked again at delivery: public http(s) only, every
// DNS answer public, and the socket pinned to the address checked. Redirects
// are not followed.
import {createHmac} from 'node:crypto';
import {lookup} from 'node:dns/promises';
import https from 'node:https';
import http from 'node:http';
import {blockedHosts, checkAddresses, checkUrl, literalAddress, urlPort} from './destination.mjs';

const BATCH = 25;
const MAX_TRIES = 3;
const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 65_536;

export const signWebhook = (secret, timestamp, body) =>
  'sha256=' + createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');

// POSTs to one checked address. Resolves with the HTTP status.
export function postPinned(url, {address, family}, {headers, body}) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request({protocol: url.protocol, hostname: url.hostname, port: urlPort(url), path: url.pathname + url.search,
      method: 'POST', headers: {...headers, 'content-length': String(body.length)}, servername: literalAddress(url) ? undefined : url.hostname,
      lookup: (_host, options, callback) => (options?.all ? callback(null, [{address, family}]) : callback(null, address, family)),
      timeout: TIMEOUT_MS});
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
    request.on('response', response => {
      let received = 0;
      response.on('data', chunk => {
        received += chunk.length;
        if (received > MAX_RESPONSE_BYTES) response.destroy();
      });
      response.on('close', () => resolve(response.statusCode));
      response.on('error', () => resolve(response.statusCode));
    });
    request.end(body);
  });
}

async function publicAddresses(url, resolve) {
  const literal = literalAddress(url);
  return checkAddresses(literal ? [literal] : await resolve(url.hostname));
}

export class WebhookSender {
  // front: FetchFront (reads the result and the project's secret).
  constructor({store, front, config, resolve = host => lookup(host, {all: true, verbatim: true}), post = postPinned, intervalMs = 2000}) {
    Object.assign(this, {store, front, resolve, post, intervalMs});
    this.blocked = blockedHosts(config);
    this.running = null;
    this.again = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.kick(), this.intervalMs);
    this.timer.unref();
    this.kick();
  }

  kick() {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.deliverDue().catch(() => {
      process.stderr.write('webhooks_failed\n');
      return 0;
    }).finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        void this.kick();
      }
    });
    return this.running;
  }

  async deliverDue() {
    const due = (await this.store.pool.query(`SELECT request, project, url, attempts FROM webhook_deliveries
      WHERE delivered_at IS NULL AND gave_up_at IS NULL AND next_attempt_at <= clock_timestamp() ORDER BY next_attempt_at LIMIT $1`,
    [BATCH])).rows;
    let delivered = 0;
    for (const row of due) {
      let error = null;
      try {
        const url = checkUrl(this.front.sealer.open(row.url), {blocked: this.blocked});
        const [address] = await publicAddresses(url, this.resolve);
        const view = await this.front.get(row.project, row.request, {includeBody: false});
        const body = Buffer.from(JSON.stringify(view));
        const timestamp = Math.floor(Date.now() / 1000);
        const secret = await this.front.webhookSecret(row.project);
        const status = await this.post(url, address, {body, headers: {'content-type': 'application/json', 'user-agent': 'FetchX-Webhook/1',
          'x-fetchx-timestamp': String(timestamp), 'x-fetchx-signature': signWebhook(secret, timestamp, body)}});
        if (!(status >= 200 && status < 300)) error = `http_${status}`;
      } catch (failure) {
        error = failure?.code === 'url_not_allowed' ? 'url_not_allowed' : failure?.message === 'timeout' ? 'timeout' : 'network';
      }
      if (!error) {
        await this.store.pool.query(`UPDATE webhook_deliveries SET delivered_at = clock_timestamp(), attempts = attempts + 1, last_error = NULL
          WHERE request = $1`, [row.request]);
        delivered++;
      } else {
        const tries = row.attempts + 1;
        const giveUp = tries >= MAX_TRIES || error === 'url_not_allowed';
        await this.store.pool.query(`UPDATE webhook_deliveries SET attempts = $2, last_error = $3,
          next_attempt_at = clock_timestamp() + make_interval(secs => $4), gave_up_at = CASE WHEN $5 THEN clock_timestamp() END
          WHERE request = $1`, [row.request, tries, error, 2 * 4 ** (tries - 1), giveUp]);
      }
    }
    return delivered;
  }

  async close() {
    clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }
}
