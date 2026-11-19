// Where a proxied browser appears to be. A residential exit can be anywhere in
// its country, and a browser whose timezone and position disagree with its IP
// is an easy bot tell, so before a browser step FetchX asks a lookup service,
// through the step's own proxy, which IP and place the site will see. The
// answer is cached per proxy session (one session is one exit IP).
//
// config.browser.exitGeo: {endpoint} (an ipinfo.io-compatible JSON endpoint,
// default https://ipinfo.io/json), or false to turn the lookup off. Nothing
// about the request or the caller is sent: only a GET of the endpoint.
import {exchange, decodeBody} from './transport.mjs';
import {checkAddresses} from './destination.mjs';

const DEFAULT_ENDPOINT = 'https://ipinfo.io/json';
const CACHE_MS = 20 * 60_000;
const CACHE_MAX = 2000;
const LOOKUP_TIMEOUT_MS = 8000;
const COUNTRY = /^[A-Z]{2}$/;

export function exitGeoSettings(config) {
  const settings = config.browser?.exitGeo;
  if (settings === false) return null;
  let endpoint;
  try { endpoint = new URL(settings?.endpoint ?? DEFAULT_ENDPOINT); } catch { return null; }
  return endpoint.protocol === 'https:' ? {endpoint} : null;
}

export function validTimezone(value) {
  if (typeof value !== 'string' || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){1,2}$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', {timeZone: value});
    return true;
  } catch {
    return false;
  }
}

// Reads an ipinfo.io-style answer: {ip, country, timezone, loc: "lat,lon"}.
export function parseExitGeo(value) {
  if (!value || typeof value !== 'object') return null;
  const ip = typeof value.ip === 'string' && value.ip.length <= 45 ? value.ip : null;
  const country = typeof value.country === 'string' && COUNTRY.test(value.country) ? value.country : null;
  const timezone = validTimezone(value.timezone) ? value.timezone : null;
  let geolocation = null;
  const [lat, lon] = String(value.loc ?? '').split(',').map(Number);
  if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && (lat || lon)) {
    geolocation = {latitude: lat, longitude: lon};
  }
  return ip && timezone ? {ip, country, timezone, geolocation} : null;
}

export class ExitGeo {
  // resolve: the service's resolver (system DNS for the lookup host).
  constructor(config, {resolve, exchangeImpl = exchange, now = Date.now} = {}) {
    Object.assign(this, {settings: exitGeoSettings(config), resolve, exchangeImpl, now});
    this.cache = new Map();
  }

  // The exit's IP and place for one proxy session, or null when unknown. Never throws.
  async lookup(proxy) {
    if (!this.settings || !proxy?.url) return null;
    const key = proxy.id ?? proxy.url;
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.at < CACHE_MS) return cached.geo;
    try {
      const {endpoint} = this.settings;
      const [address] = checkAddresses(await this.resolve(new URL(endpoint.origin), {}));
      const response = await this.exchangeImpl({method: 'GET', headers: {accept: 'application/json', 'user-agent': 'curl/8.5.0'}},
        {url: endpoint, address: address.address, family: address.family},
        {timeoutMs: LOOKUP_TIMEOUT_MS, maxBodyBytes: 16_384, maxWireBytes: 262_144}, {proxy: {url: proxy.url}});
      if (response.status !== 200) return null;
      const body = decodeBody(response.encoded, response.headers['content-encoding'], {maxDecodedBytes: 65_536});
      const geo = parseExitGeo(JSON.parse(body.toString('utf8')));
      if (!geo) return null;
      if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(key, {geo, at: this.now()});
      return geo;
    } catch {
      return null;
    }
  }

  forget(proxy) {
    if (proxy) this.cache.delete(proxy.id ?? proxy.url);
  }
}
