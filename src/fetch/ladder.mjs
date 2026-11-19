// Auto mode's escalation ladder. Cheapest first:
//   1 HTTP direct   2 HTTP datacenter   3 HTTP residential
//   4 browser residential   5 browser residential, fresh IP   6 browser datacenter
// plus two HTTP residential rotations used only right after a rate limit.
// Steps proven for the host by site knowledge move to the front; cooling steps
// and steps a provider rule excludes are skipped; steps that cost more than the
// request's reservation are skipped.
import {providerRule} from '../provider-rules.mjs';
import {siteRoutes} from '../site-knowledge.mjs';
import {datacenterPool, datacenterProvider, residentialAvailable, RESIDENTIAL_PROVIDERS} from './routes.mjs';
import {needsBrowser} from './request.mjs';
import {stepFor} from '../billing/ledger.mjs';

const step = (transport, routeClass, country, extra = {}) => ({transport, class: routeClass, country, ...extra});
export const sameStep = (a, b) => a.transport === b.transport && a.class === b.class && a.country === b.country
  && (a.rotation ?? 0) === (b.rotation ?? 0);

// The countries FetchX can exit from, by route class.
export function availableRoutes(config) {
  const datacenter = [...new Set((config.proxies ?? []).map(proxy => proxy.country))].sort();
  const residential = [...new Set(RESIDENTIAL_PROVIDERS.flatMap(provider => {
    const settings = config.residential?.providers?.[provider];
    return settings?.enabled ? settings.countries ?? config.residential?.countries ?? ['US'] : [];
  }))].sort();
  return {direct: config.routes?.direct !== false, datacenter, residential};
}

function chooseCountry(request, available, knowledge) {
  const countries = [...new Set([...available.datacenter, ...available.residential])];
  if (request.country) return request.country;
  const proven = knowledge.find(row => row.state === 'proven' && row.country && countries.includes(row.country));
  if (proven) return proven.country;
  return countries.includes('US') ? 'US' : countries[0] ?? null;
}

export async function planLadder({config, pool, request, host, prices, reservation, now = Date.now()}) {
  const available = availableRoutes(config);
  const knowledge = await siteRoutes(pool, host, {config, now});
  const country = chooseCountry(request, available, knowledge);
  const skipped = [];
  const affordable = candidate => reservation === null || prices[stepFor(candidate)] <= reservation;

  // An explicit route is one attempt on exactly that route.
  if (request.route) {
    const fixed = step(request.route.render ? 'browser' : 'http', request.route.class, request.route.country);
    return {steps: [fixed], skipped, country: fixed.country, explicit: true};
  }

  const browserOnly = needsBrowser(request);
  const httpAllowed = !browserOnly;
  const browserAllowed = request.method === 'GET' && request.render !== 'never';
  const datacenter = country && available.datacenter.includes(country);
  const residential = country && available.residential.includes(country)
    && RESIDENTIAL_PROVIDERS.some(provider => residentialAvailable(config, provider, country));
  const candidates = [];
  if (httpAllowed) {
    if (available.direct) candidates.push(step('http', 'direct', null));
    if (datacenter) candidates.push(step('http', 'datacenter', country));
    if (residential) {
      candidates.push(step('http', 'residential', country));
      candidates.push(step('http', 'residential', country, {rotation: 1, afterRateLimit: true}));
      candidates.push(step('http', 'residential', country, {rotation: 2, afterRateLimit: true}));
    }
  }
  if (browserAllowed) {
    if (residential) {
      candidates.push(step('browser', 'residential', country));
      candidates.push(step('browser', 'residential', country, {rotation: 1}));
    }
    if (datacenter) candidates.push(step('browser', 'datacenter', country));
  }

  const stateOf = candidate => {
    const rows = knowledge.filter(row => row.execution === candidate.transport && row.proxy_class === candidate.class
      && (candidate.class === 'direct' || row.country === candidate.country));
    if (rows.some(row => row.state === 'proven')) return 'proven';
    // A residential rate limit is per IP; a fresh session gets another one.
    if (rows.length && rows.every(row => row.state === 'cooling'
      && !(row.proxy_class === 'residential' && row.last_outcome === 'rate_limited'))) return 'cooling';
    return 'unknown';
  };
  const steps = [];
  for (const [order, candidate] of candidates.entries()) {
    if (candidate.class === 'datacenter' && providerRule(config, datacenterProvider(config, candidate.country), host)) {
      skipped.push({...candidate, reason: 'excluded_by_provider_rule'});
      continue;
    }
    if (candidate.class === 'residential' && RESIDENTIAL_PROVIDERS.every(provider => providerRule(config, provider, host))) {
      skipped.push({...candidate, reason: 'excluded_by_provider_rule'});
      continue;
    }
    if (!affordable(candidate)) {
      skipped.push({...candidate, reason: 'over_max_credits'});
      continue;
    }
    const state = stateOf(candidate);
    if (state === 'cooling' && !candidate.rotation) {
      skipped.push({...candidate, reason: 'cooling'});
      continue;
    }
    steps.push({...candidate, known: state, order});
  }
  // Rotations need their base step.
  const usable = steps.filter(s => !s.rotation || steps.some(b => !b.rotation && b.transport === s.transport && b.class === s.class));
  usable.sort((a, b) => (a.known === 'proven' ? 0 : 1) - (b.known === 'proven' ? 0 : 1) || a.order - b.order);
  const cooling = knowledge.filter(row => row.state === 'cooling').map(row => Date.parse(row.retry_not_before));
  return {
    steps: usable.map(({known, order, ...rest}) => rest),
    skipped: skipped.map(({afterRateLimit, ...rest}) => rest),
    country,
    explicit: false,
    retryAfterSeconds: cooling.length ? Math.max(1, Math.ceil((Math.min(...cooling) - now) / 1000)) : null,
  };
}

// The next step to try. After a rate limit, a fresh residential IP comes
// first (HTTP before browser); rotation steps are used only then.
export function nextStep(plan, tried, lastResult) {
  const open = plan.steps.filter(candidate => !tried.some(attempt => sameStep(attempt, candidate)));
  if (lastResult === 'rate_limited') {
    const fresh = open.find(candidate => candidate.class === 'residential');
    if (fresh) return fresh;
  }
  // After a JavaScript shell over HTTP, go straight to a browser.
  if (lastResult === 'needs_browser') {
    const browser = open.find(candidate => candidate.transport === 'browser');
    if (browser) return browser;
  }
  return open.find(candidate => !candidate.afterRateLimit) ?? null;
}

export {datacenterPool};
