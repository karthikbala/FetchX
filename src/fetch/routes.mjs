// Routes: how a request leaves FetchX. A route is {class, country, provider}
// plus the concrete proxy used for one attempt:
//   direct       - from FetchX's own servers, no proxy
//   datacenter   - Oxylabs datacenter IPs, one per country pool
//   residential  - Evomi or DataImpulse, a fresh session (new IP) per attempt,
//                  or a kept one that worked for the host (fetch/sessions.mjs)
// Provider rules (provider-rules.mjs) remove a provider for a host, e.g. Oxylabs
// is never used for .gov.
import {randomBytes} from 'node:crypto';
import {lookup} from 'node:dns/promises';
import {GatewayError, fail} from '../policy.mjs';
import {providerRule} from '../provider-rules.mjs';
import {residentialOverBudget} from '../budgets.mjs';
import {checkAddresses, literalAddress} from './destination.mjs';

export const RESIDENTIAL_PROVIDERS = Object.freeze(['evomi', 'dataimpulse']);
const COUNTRY = /^[A-Z]{2}$/;

export function datacenterPool(config, country) {
  return (config.proxies ?? []).filter(proxy => proxy.country === country);
}

export function residentialSettings(config, provider) {
  const settings = config.residential?.providers?.[provider];
  return settings?.enabled && settings.username && settings.password ? settings : null;
}

export function residentialAvailable(config, provider, country) {
  const settings = residentialSettings(config, provider);
  return !!settings && (!settings.countries || settings.countries.includes(country));
}

export function datacenterProvider(config, country) {
  return datacenterPool(config, country)[0]?.provider ?? 'oxylabs';
}

// The proxy URL for one residential session. The session id pins one exit IP
// for the attempt; a new id is a new IP.
export function residentialProxy(config, provider, country, session = randomBytes(5).toString('hex')) {
  const settings = residentialSettings(config, provider);
  if (!settings) fail('residential_provider_unavailable', 503);
  if (!COUNTRY.test(country) || (settings.countries && !settings.countries.includes(country))) {
    fail('residential_country_unavailable', 503);
  }
  if (!/^[a-f0-9]{10}$/.test(session)) fail('residential_session_invalid', 500);
  let url;
  if (provider === 'evomi') {
    url = new URL(settings.endpoint ?? 'http://core-residential.evomi.com:1000');
    url.username = settings.username;
    url.password = `${settings.password}_country-${country}_session-${session}_lifetime-30`;
  } else if (provider === 'dataimpulse') {
    url = new URL(settings.endpoint ?? 'http://gw.dataimpulse.com:823');
    url.username = `${settings.username}__cr.${country.toLowerCase()};sessid.${session}`;
    url.password = settings.password;
  } else {
    fail('residential_provider_invalid', 500);
  }
  return {id: `${provider}:${session}`, url: url.href, session};
}

// Picks the residential provider for an attempt: `prefer` first (auto mode
// alternates after a failure), skipping providers excluded for this host and
// providers whose traffic budget is used up.
export function pickResidentialProvider(config, country, host, {prefer = null} = {}) {
  const order = [...RESIDENTIAL_PROVIDERS].sort((a, b) => (a === prefer ? 0 : 1) - (b === prefer ? 0 : 1));
  return order.find(provider => residentialAvailable(config, provider, country) && !providerRule(config, provider, host)
    && !residentialOverBudget(config, provider)) ?? null;
}

// Resolves the concrete proxy for one attempt on a route. Throws a refusal
// (nothing sent) when the route cannot be used for this host. `session` reuses
// a kept residential session (its provider must be `preferProvider`).
export function proxyFor(config, route, host, {preferProvider = null, pickDatacenter, session} = {}) {
  if (route.class === 'direct') return {route: {...route, provider: 'direct'}, proxy: null};
  if (route.class === 'datacenter') {
    const provider = datacenterProvider(config, route.country);
    if (providerRule(config, provider, host)) fail('provider_excluded', 409);
    const pool = datacenterPool(config, route.country);
    if (!pool.length) fail('route_unavailable', 503);
    const proxy = pickDatacenter ? pickDatacenter(pool) : pool[Math.floor(Math.random() * pool.length)];
    return {route: {...route, provider}, proxy: {id: proxy.id, url: proxy.url}};
  }
  if (route.class === 'residential') {
    const provider = pickResidentialProvider(config, route.country, host, {prefer: preferProvider});
    if (!provider) {
      const capped = RESIDENTIAL_PROVIDERS.some(name => residentialAvailable(config, name, route.country)
        && !providerRule(config, name, host) && residentialOverBudget(config, name));
      fail(capped ? 'residential_budget_exhausted' : 'route_unavailable', capped ? 429 : 503);
    }
    const proxy = residentialProxy(config, provider, route.country, session && provider === preferProvider ? session : undefined);
    return {route: {...route, provider}, proxy};
  }
  fail('route_unavailable', 503);
}

// DNS for a route. Direct routes use the system resolver. Proxied routes ask a
// reviewed DNS-over-HTTPS resolver through the same proxy, so the answer is the
// one a visitor in that country would get; without one configured, the system
// resolver is used. Either way every answer must be public.
export function createResolver(config, {systemLookup = lookup, doh} = {}) {
  return async (url, {proxy = null, signal} = {}) => {
    const literal = literalAddress(url);
    if (literal) return checkAddresses([literal]);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    let answers;
    try {
      answers = proxy && doh ? await doh(host, {proxy, signal}) : await systemLookup(host, {all: true, verbatim: true});
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      const failure = new GatewayError('source_dns_failed', 502);
      failure.cause_code = typeof error?.code === 'string' && /^E[A-Z_]{2,30}$/.test(error.code) ? error.code : null;
      failure.dispatched = false;
      throw failure;
    }
    return checkAddresses(answers);
  };
}
