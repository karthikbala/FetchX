// The public API's version: the newest release in docs/changelog.json, which
// docs/openapi.json info.version matches (test/api-contract.test.mjs).
import changelog from '../../docs/changelog.json' with {type: 'json'};

export {changelog};
export const API_VERSION = changelog.releases[0].version;

// What this server supports, by feature id (GET /v1/me features). A client
// checks for an id before relying on a newer feature. Add an id when its
// feature ships; removing one is a breaking change (see docs/api.md).
export const FEATURES = Object.freeze(['batches', 'capture', 'estimate', 'extract', 'feedback', 'key_limits', 'limits', 'next_page', 'usd']);
