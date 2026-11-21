// How the API tells callers about routes that are not, or no longer, there,
// about routes on their way out, and about maintenance. docs/changelog.json is
// the one record of what changed: the website's changelog is built from it too.
//   - a retired route answers 410 route_retired with what replaces it
//   - a deprecated route still answers, with Deprecation, Sunset and Link headers
//   - any other unknown route answers 404 route_not_found with links
//   - while a maintenance notice pauses the API (src/status.mjs), every /v1
//     route except GET /v1/status answers 503 maintenance with Retry-After
import {GatewayError} from '../policy.mjs';
import {linksOf} from '../status.mjs';
import {API_VERSION, changelog} from './version.mjs';

const API_PATH = /^\/v[0-9]+(?:\/|$)/;
const pathOf = url => (url ?? '/').split('?')[0];
const shown = value => String(value).slice(0, 200);

export function retiredRoute(method, url) {
  const path = pathOf(url);
  return changelog.retired.find(entry => (!entry.method || entry.method === method)
    && (entry.match === 'prefix' ? path === entry.path || path.startsWith(entry.path + '/') : path === entry.path)) ?? null;
}

// A deprecation in force for a registered route (`route` as Fastify names it, /v1/fetch/:id).
export function deprecationFor(method, route) {
  const path = (route ?? '').replace(/:([A-Za-z_]+)/g, '{$1}');
  return changelog.deprecations.find(entry => entry.path === path && (!entry.method || entry.method === method)
    && !changelog.retired.some(gone => gone.path === entry.path)) ?? null;
}

const httpDate = day => new Date(`${day}T00:00:00Z`).toUTCString();

export function registerLifecycle(app, {board, config}) {
  const links = linksOf(config);

  app.addHook('onRequest', async req => {
    const path = pathOf(req.url);
    if (!board || !path.startsWith('/v1') || path === '/v1/status') return;
    const notice = await board.paused();
    if (notice) throw board.maintenanceError(notice);
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const deprecation = deprecationFor(req.method, req.routeOptions?.url);
    if (deprecation) {
      // RFC 9745: when it was deprecated, as @unix-seconds; RFC 8594: when it goes.
      reply.header('deprecation', `@${Math.floor(Date.parse(`${deprecation.deprecated_on}T00:00:00Z`) / 1000)}`);
      if (deprecation.sunset_on) reply.header('sunset', httpDate(deprecation.sunset_on));
      reply.header('link', `<${links.changelog}>; rel="deprecation"; type="text/html"`);
    }
    return payload;
  });

  app.setNotFoundHandler(async (req, reply) => {
    const path = pathOf(req.url);
    const retired = retiredRoute(req.method, path);
    if (retired) {
      throw Object.assign(new GatewayError('route_retired', 410), {details: {method: req.method, path: shown(path),
        retired_in: retired.retired_in, retired_on: retired.retired_on, replacement: retired.replacement,
        changelog_url: links.changelog, docs_url: links.docs}});
    }
    throw Object.assign(new GatewayError('route_not_found', 404), {details: {method: req.method, path: shown(path),
      ...(API_PATH.test(path) ? {api_version: API_VERSION} : {}), docs_url: links.docs, changelog_url: links.changelog, status_url: links.status_page}});
  });
}
