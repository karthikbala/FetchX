// DNS over HTTPS through a route's own proxy, so a proxied request resolves the
// site the way a visitor in that country would. The resolver is operator
// configured ({endpoint, address}) and pinned to its address; callers cannot
// choose it. Answers are checked by the caller (destination.checkAddresses).
import {isIP} from 'node:net';
import {GatewayError} from '../policy.mjs';
import {exchange, decodeBody} from './transport.mjs';

const RECORD_TYPES = [[1, 4], [28, 6]];
const trimDot = host => host.toLowerCase().replace(/\.$/, '');

export function dohSettings(config) {
  const dns = config.dns;
  if (!dns) return null;
  let endpoint;
  try { endpoint = new URL(dns.endpoint); } catch { return null; }
  const family = isIP(dns.address ?? '');
  if (endpoint.protocol !== 'https:' || !family || !['/resolve', '/dns-query'].includes(endpoint.pathname)) return null;
  return {endpoint, address: dns.address, family, timeoutMs: dns.timeoutMs ?? 5000};
}

export function parseDnsJson(value, host, type, family) {
  if (!value || typeof value !== 'object' || !Number.isInteger(value.Status) || value.TC === true) {
    throw new GatewayError('source_dns_failed', 502);
  }
  if (value.Status !== 0) {
    const error = new GatewayError(value.Status === 3 ? 'source_dns_not_found' : 'source_dns_failed', 502);
    error.dispatched = false;
    throw error;
  }
  const answers = Array.isArray(value.Answer) ? value.Answer.slice(0, 128) : [];
  // Follow CNAME chains from the asked name only.
  const names = new Set([host]);
  for (let round = 0; round < 16; round++) {
    let grew = false;
    for (const answer of answers) {
      if (answer?.type === 5 && names.has(trimDot(String(answer.name))) && typeof answer.data === 'string'
        && !names.has(trimDot(answer.data))) {
        names.add(trimDot(answer.data));
        grew = true;
      }
    }
    if (!grew) break;
  }
  return answers
    .filter(answer => answer?.type === type && names.has(trimDot(String(answer.name))) && isIP(String(answer.data)) === family)
    .map(answer => ({address: answer.data, family}));
}

export function createDoh(settings, {exchangeImpl = exchange} = {}) {
  return async (host, {proxy, signal}) => {
    const addresses = [];
    for (const [type, family] of RECORD_TYPES) {
      const url = new URL(settings.endpoint);
      url.searchParams.set('name', host);
      url.searchParams.set('type', String(type));
      const response = await exchangeImpl(
        {method: 'GET', headers: {accept: 'application/dns-json', 'accept-encoding': 'identity'}},
        {url, address: settings.address, family: settings.family},
        {timeoutMs: settings.timeoutMs, maxBodyBytes: 32768, maxWireBytes: 262144},
        {proxy, signal},
      );
      if (response.status !== 200) throw new GatewayError('source_dns_failed', 502);
      let value;
      try {
        value = JSON.parse(decodeBody(response.encoded, response.headers['content-encoding'], {maxDecodedBytes: 32768}).toString('utf8'));
      } catch {
        throw new GatewayError('source_dns_failed', 502);
      }
      addresses.push(...parseDnsJson(value, host, type, family));
    }
    if (!addresses.length) {
      const error = new GatewayError('source_dns_not_found', 502);
      error.dispatched = false;
      throw error;
    }
    return addresses;
  };
}
