// POST /v1/estimate: what a request, or a batch of them, would cost and how
// long it would take, before anything is sent. Nothing is reserved or charged.
//
// The engine plans each request as it would run it and reports what each
// host's recent requests took (POST /internal/v1/estimates: the tier that got
// the data, its wire bytes, captcha solves and seconds, shared across every
// project by host name). This module prices that with the platform's price
// table, applies the caller's max_credits and the project's balance, and
// times a batch with the engine's per-host pace.
//
// Body: one POST /v1/fetch body, or a POST /v1/batches body
// ({items: [url | {url, ...}], defaults, webhook_url?, idempotency_key?, tags?}),
// each item merged over `defaults`.
import {GatewayError} from '../policy.mjs';
import {STEPS, priceOf} from '../billing/ledger.mjs';
import {budget} from '../budgets.mjs';

export const MAX_ESTIMATE_ITEMS = 1000;
// A host's own history is used once it has this many recent requests.
export const MIN_HISTORY = 3;
// What a step is assumed to take when FetchX has no history for any host on
// that tier: [median, high] wire bytes and seconds.
export const ASSUMED = Object.freeze({
  http: {bytes: [200_000, 2_000_000], seconds: [2, 10]},
  http_residential: {bytes: [200_000, 2_000_000], seconds: [4, 15]},
  browser: {bytes: [3_000_000, 10_000_000], seconds: [30, 60]},
  browser_residential: {bytes: [12_000_000, 25_000_000], seconds: [45, 90]},
});
// A page read past 10 screens loads about this much more per screen (the
// engine's PAGE_DEPTH, and its reading time per screen).
const DEEP = Object.freeze({screens: 10, bytes: 2_500_000, seconds: 3});
// Fields a batch sets once for all its items, never per item.
const BATCH_ONLY = ['async', 'webhook_url', 'idempotency_key'];
const BATCH_FIELDS = ['items', 'defaults', 'webhook_url', 'idempotency_key', 'tags'];

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = (field, reason) => Object.assign(new GatewayError('invalid_request', 400), {details: {field, ...(reason ? {reason} : {})}});
const round1 = value => Math.round(value * 10) / 10;

// The requests a body stands for: [{index, request} | {index, error}].
export function expandEstimateBody(body) {
  if (!plain(body)) throw invalid('body', 'a POST /v1/fetch body, or a batch body with items');
  if (!('items' in body)) {
    if (typeof body.url !== 'string') throw invalid('url', 'a POST /v1/fetch body (with url), or a batch body with items');
    return {kind: 'fetch', items: [{index: 0, request: body}]};
  }
  for (const key of Object.keys(body)) if (!BATCH_FIELDS.includes(key)) throw invalid(key, 'unknown field');
  const {items, defaults = {}} = body;
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_ESTIMATE_ITEMS) {
    throw invalid('items', `1 to ${MAX_ESTIMATE_ITEMS} URLs or requests`);
  }
  if (!plain(defaults)) throw invalid('defaults', 'an object of POST /v1/fetch fields');
  for (const key of ['url', ...BATCH_ONLY]) if (key in defaults) throw invalid(`defaults.${key}`, key === 'url' ? 'set per item' : 'set once for the batch');
  return {kind: 'batch', items: items.map((item, index) => {
    if (typeof item === 'string') return {index, request: {...defaults, url: item}};
    if (!plain(item)) return {index, error: invalid(`items[${index}]`, 'a URL or an object with url')};
    const own = BATCH_ONLY.find(key => key in item);
    if (own) return {index, error: invalid(`items[${index}].${own}`, 'set once for the batch')};
    return {index, request: {...defaults, ...item}};
  })};
}

// One tier's figures: from the host's history, else the per-tier defaults
// across recent hosts, else ASSUMED.
function tierFigures(step, {history, defaults}) {
  const own = history?.steps?.find(entry => entry.step === step);
  const shared = defaults?.steps?.find(entry => entry.step === step && entry.samples >= MIN_HISTORY);
  const source = own ?? shared;
  if (source) {
    return {captcha: source.captcha_share, bytes: [source.wire_bytes.p50 ?? 0, source.wire_bytes.p90 ?? source.wire_bytes.p50 ?? 0],
      seconds: [source.seconds.p50 ?? ASSUMED[step].seconds[0], source.seconds.p90 ?? source.seconds.p50 ?? ASSUMED[step].seconds[1]],
      basis: own ? 'history' : 'defaults'};
  }
  return {captcha: 0, bytes: ASSUMED[step].bytes, seconds: ASSUMED[step].seconds, basis: 'assumed'};
}

export class Estimator {
  // front: the FetchFront (for each request's reservation ceiling).
  constructor({config, ledger, engine, front}) {
    Object.assign(this, {config, ledger, engine, front});
  }

  async estimate(project, body) {
    const {kind, items} = expandEstimateBody(body);
    const table = this.ledger.prices;
    const metered = this.ledger.metered(project);
    const balance = metered ? await this.ledger.balance(project) : null;
    const available = balance ? balance.available : null;
    const valid = items.filter(item => item.request);
    const engine = valid.length ? await this.engine.estimate(valid.map(item => item.request)) : {items: [], hosts: {}, defaults: null};
    const planned = new Map(valid.map((item, position) => [item.index, engine.items[position]]));

    const results = items.map(item => {
      if (item.error) return this.#refused(item, item.error);
      const plan = planned.get(item.index);
      if (!plan || plan.error) return this.#refused(item, Object.assign(new GatewayError(plan?.error?.code ?? 'invalid_request', 400),
        {details: plan?.error?.details}));
      let hold;
      try { hold = this.front.holdFor(item.request); } catch (error) { return this.#refused(item, error); }
      return this.#priced(item, plan, {host: engine.hosts?.[plan.host] ?? {}, defaults: engine.defaults, table, hold, metered, available});
    });
    const estimated = results.filter(result => !result.error);
    const sum = key => estimated.reduce((total, result) => total + result.credits[key], 0);
    const credits = {expected: sum('expected'), typical: sum('typical'), high: sum('high')};
    const notes = [];
    if (metered && estimated.length) {
      if (available < credits.expected) {
        notes.push({code: 'insufficient_credits', message: `The balance (${available} credits) is below the ${credits.expected} credits this is expected to use. Top up before sending it, or send fewer requests.`});
      } else if (available < credits.high) {
        notes.push({code: 'balance_may_run_out', message: `The balance (${available} credits) covers the expected ${credits.expected} credits but not the high estimate of ${credits.high}.`});
      }
    }
    return {
      kind,
      requests: items.length,
      estimated: estimated.length,
      credits,
      seconds: kind === 'batch' ? this.#batchSeconds(estimated, engine.hosts ?? {}) : estimated[0]?.seconds ?? {typical: 0, high: 0},
      balance: {credits: available, covers_expected: !metered || available >= credits.expected, covers_high: !metered || available >= credits.high},
      ...(kind === 'batch' ? {hosts: this.#hosts(estimated, engine.hosts ?? {})} : {}),
      items: results,
      notes,
    };
  }

  #refused(item, error) {
    const code = error instanceof GatewayError ? error.code : 'invalid_request';
    return {index: item.index, url: typeof item.request?.url === 'string' ? item.request.url : null,
      error: {code, message: code === 'url_not_allowed' ? 'The URL must be public http or https.' : 'This request would be refused; error.details says why.',
        ...(error.details ? {details: error.details} : {})}};
  }

  #priced(item, {host, plan}, {host: hostInfo, defaults, table, hold, metered, available}) {
    const request = item.request;
    const history = hostInfo.history && hostInfo.history.requests >= MIN_HISTORY ? hostInfo.history : null;
    // The tiers the reservation would allow, as POST /v1/fetch decides them.
    const reserve = metered ? Math.min(hold, available) : hold;
    const allowed = new Set(STEPS.filter(step => !metered || table[step] <= reserve));
    const usable = plan.steps.filter(step => allowed.has(step));
    const notes = [];
    const maxCredits = Number.isSafeInteger(request.max_credits) ? request.max_credits : null;

    // Which tiers are likely to get the data, with their shares.
    let mix = null;
    let basis;
    if (history?.steps?.length) {
      const wins = history.steps.filter(entry => usable.includes(entry.step));
      const total = wins.reduce((sum, entry) => sum + entry.share, 0);
      if (wins.length) mix = wins.map(entry => ({step: entry.step, share: entry.share / total}));
      // When no step is open at all, the note below says so instead.
      const lost = usable.length ? history.steps.filter(entry => !usable.includes(entry.step) && entry.share >= 0.5) : [];
      for (const entry of lost) {
        const price = priceOf(table, {step: entry.step, wireBytes: entry.wire_bytes.p50 ?? 0});
        notes.push(plan.steps.includes(entry.step) && !allowed.has(entry.step)
          ? {code: 'likely_needs_more_credits', message: `Recent requests to this host mostly needed the ${entry.step} step (about ${price} credits), which ${maxCredits !== null ? `max_credits ${maxCredits}` : 'the balance'} rules out. FetchX would try only cheaper steps, which have not worked here: ${maxCredits !== null ? 'raise max_credits or remove it' : 'top up'}.`}
          : {code: 'likely_needs_other_options', message: `Recent requests to this host mostly needed the ${entry.step} step, which this request's options rule out (render, route or max_attempts). Remove them to let FetchX use it.`});
      }
      basis = 'history';
    }
    if (!mix && usable.length) {
      const step = plan.proven && usable.includes(plan.proven) ? plan.proven : usable[0];
      mix = [{step, share: 1}];
      basis = plan.proven === step ? 'routes' : 'defaults';
      if (!history) notes.push({code: 'no_history', message: `FetchX has no recent requests to ${host} to go by, so the figures are typical for the ${step} step. The estimate improves once a page from this host has been fetched.`});
    }
    if (!usable.length) {
      const cheapest = Math.min(...plan.steps.map(step => table[step]));
      notes.push(maxCredits !== null && maxCredits < cheapest
        ? {code: 'max_credits_too_low', message: `max_credits ${maxCredits} is below the cheapest step this request needs (${cheapest} credits); POST /v1/fetch would refuse it. Raise max_credits or remove it.`}
        : plan.steps.length && metered && available < cheapest
          ? {code: 'insufficient_credits', message: `The balance (${available} credits) is below the cheapest step this request needs (${cheapest} credits). Top up first.`}
          : {code: 'no_route', message: 'No route is open for this request right now; see plan and cooling.'});
    }
    if (plan.cooling) {
      notes.push({code: 'cooling_down', message: `Every route to ${host} is resting after recent failures; sent now, the request would fail with cooling_down. Retry after ${plan.cooling.retry_after_seconds} s.`});
    }
    const successRate = history ? history.success_rate : null;
    if (successRate !== null && successRate < 0.8) {
      notes.push({code: 'low_success_rate', message: `About ${Math.round(successRate * 100)}% of recent requests to this host succeeded. Failed requests are free, so expected credits count only successes.`});
    }

    // Price and time each likely tier.
    const deep = Number.isSafeInteger(request.scroll) ? Math.max(0, request.scroll - DEEP.screens) : 0;
    const priced = (mix ?? []).map(({step, share}) => {
      const figures = tierFigures(step, {history, defaults});
      const extraBytes = step.startsWith('browser') ? deep * DEEP.bytes : 0;
      const extraSeconds = step.startsWith('browser') ? deep * DEEP.seconds : 0;
      const captcha = step.startsWith('browser') ? figures.captcha : 0;
      return {step, share, figures,
        typical: priceOf(table, {step, wireBytes: figures.bytes[0] + extraBytes}) + captcha * table.captcha,
        high: priceOf(table, {step, captchaSolved: captcha > 0, wireBytes: figures.bytes[1] + extraBytes}),
        seconds: [figures.seconds[0] + extraSeconds, figures.seconds[1] + extraSeconds]};
    });
    if (basis !== 'history' && priced[0]?.figures.basis === 'assumed') basis = 'assumed';
    const main = priced.filter(entry => entry.share >= 0.1);
    const typical = Math.min(hold, Math.round(priced.reduce((sum, entry) => sum + entry.share * entry.typical, 0)));
    const high = Math.min(hold, Math.max(0, ...(main.length ? main : priced).map(entry => entry.high)));
    const seconds = history
      ? {typical: round1(history.seconds.p50 + deep * DEEP.seconds), high: round1(history.seconds.p90 + deep * DEEP.seconds)}
      : {typical: round1(priced.reduce((sum, entry) => sum + entry.share * entry.seconds[0], 0)),
        high: round1(Math.max(0, ...priced.map(entry => entry.seconds[1])))};
    return {
      index: item.index,
      url: request.url,
      host,
      basis: priced.length ? basis : 'none',
      samples: hostInfo.history?.requests ?? 0,
      step: priced.length ? priced.reduce((best, entry) => entry.share > best.share ? entry : best).step : null,
      steps: priced.map(entry => ({step: entry.step, share: Math.round(entry.share * 1000) / 1000})),
      planned: plan.steps,
      success_rate: successRate,
      credits: {expected: priced.length ? Math.round(typical * (successRate ?? 1)) : 0, typical: priced.length ? typical : 0,
        high: priced.length ? high : 0, hold},
      seconds: priced.length ? seconds : {typical: 0, high: 0},
      notes,
    };
  }

  // A batch runs hosts side by side, within the project's requests-at-once
  // budget (one slot kept for single requests); one host's items start at
  // most max_running at once and start_gap_ms apart.
  #batchSeconds(items, hosts) {
    if (!items.length) return {typical: 0, high: 0};
    const slots = Math.max(1, budget(this.config, 'fetch.maxConcurrentPerProject') - 1);
    const of = key => {
      const perHost = new Map();
      for (const item of items) perHost.set(item.host, [...(perHost.get(item.host) ?? []), item.seconds[key]]);
      let slowest = 0;
      for (const [host, times] of perHost) {
        const pace = hosts[host]?.pace ?? {max_running: 1, start_gap_ms: 0};
        const work = times.reduce((sum, value) => sum + value, 0);
        slowest = Math.max(slowest, Math.max(times.length * pace.start_gap_ms / 1000, work / Math.min(pace.max_running, slots)));
      }
      const all = items.reduce((sum, item) => sum + item.seconds[key], 0);
      return round1(Math.max(slowest, all / slots));
    };
    return {typical: of('typical'), high: of('high')};
  }

  #hosts(items, hosts) {
    const out = {};
    for (const item of items) {
      const entry = out[item.host] ?? (out[item.host] = {requests: 0, pace: hosts[item.host]?.pace ?? null, credits: {expected: 0, high: 0}});
      entry.requests++;
      entry.credits.expected += item.credits.expected;
      entry.credits.high += item.credits.high;
    }
    return out;
  }
}
