// Destination policy: which URLs FetchX may fetch, and which addresses they
// may resolve to. Any public http(s) URL is allowed. Private, local, link-local,
// cloud-metadata and documentation addresses are refused, checked after DNS and
// again for every redirect. The socket always connects to the address checked
// here (DNS pinning), so a second lookup can never undo the check.
import {isIP} from 'node:net';
import ipaddr from 'ipaddr.js';
import {fail} from '../policy.mjs';

export const MAX_URL_LENGTH = 12000;
const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);
const LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?$/;
const BAD_URL_BYTES = /[\s\u0000-\u001f\u007f\\]/u;
const UNROUTABLE_NAMES = ['localhost', 'local', 'localdomain', 'internal', 'intranet', 'lan', 'home', 'corp',
  'invalid', 'test', 'example', 'onion', 'alt', 'arpa'];
const GLOBAL_IPV6 = ipaddr.parse('2000::');
const DOCUMENTATION_IPV6 = ipaddr.parse('3fff::');
// Azure's wire server answers on a public-looking address inside every VM.
const METADATA_ADDRESSES = new Set(['168.63.129.16']);
const FETCHX_KEY = /\bfx[ks]_[A-Za-z0-9_-]{20,}/;

const matchesHost = (host, suffix) => host === suffix || host.endsWith('.' + suffix);
const dnsName = host => typeof host === 'string' && host.length <= 253 && host.includes('.')
  && host.split('.').every(label => LABEL.test(label));

export function isPublicAddress({address, family} = {}) {
  const detected = isIP(address ?? '');
  if (!detected || (family !== undefined && family !== detected)) return false;
  if (METADATA_ADDRESSES.has(address)) return false;
  let ip;
  try { ip = ipaddr.parse(address); } catch { return false; }
  if (ip.range() !== 'unicast') return false;
  if (detected === 4) return true;
  return ip.match(GLOBAL_IPV6, 3) && !ip.match(DOCUMENTATION_IPV6, 20);
}

// Hosts that must never be fetched, whatever DNS says: FetchX's own sites and
// any the operator adds (config.destinations.blockedHosts).
export function blockedHosts(config) {
  const hosts = new Set(['fetchx.ai', ...(config?.destinations?.blockedHosts ?? [])]);
  for (const origin of config?.controlPlane?.origins ?? []) {
    try { hosts.add(new URL(origin).hostname.toLowerCase()); } catch { /* validated with the control plane */ }
  }
  return hosts;
}

// Parses and checks a caller URL. The fragment is dropped (never sent to a site).
export function checkUrl(raw, {blocked = new Set()} = {}) {
  if (typeof raw !== 'string' || raw.length > MAX_URL_LENGTH || BAD_URL_BYTES.test(raw)) fail('url_not_allowed');
  let url;
  try { url = new URL(raw); } catch { fail('url_not_allowed'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !ALLOWED_PORTS.has(url.port)) {
    fail('url_not_allowed');
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const literal = host.startsWith('[') ? host.slice(1, -1) : host;
  if (isIP(literal)) {
    if (!isPublicAddress({address: literal})) fail('url_not_allowed');
  } else if (!dnsName(host) || UNROUTABLE_NAMES.some(suffix => matchesHost(host, suffix))) {
    fail('url_not_allowed');
  }
  if ([...blocked].some(suffix => matchesHost(host, suffix))) fail('url_not_allowed');
  // Never forward a FetchX credential to a third-party site.
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch { /* keep the raw form */ }
  if (FETCHX_KEY.test(decoded)) fail('url_not_allowed');
  url.hash = '';
  return url;
}

// A redirect target gets the same checks as a caller URL.
export function checkRedirect(location, base, options) {
  if (typeof location !== 'string' || location.length > MAX_URL_LENGTH) fail('url_not_allowed');
  let target;
  try { target = new URL(location, base); } catch { fail('url_not_allowed'); }
  return checkUrl(target.href, options);
}

// Every answer must be public: a mixed public/private answer is refused, so a
// DNS rebinding answer cannot slip a private address in beside a public one.
export function checkAddresses(answers) {
  if (!Array.isArray(answers) || !answers.length || answers.some(answer => !isPublicAddress(answer))) {
    fail('url_not_allowed');
  }
  return answers;
}

export const urlPort = url => Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
export const literalAddress = url => {
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  return isIP(host) ? {address: host, family: isIP(host)} : null;
};
