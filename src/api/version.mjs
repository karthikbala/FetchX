// The public API's version: the newest release in docs/changelog.json, which
// docs/openapi.json info.version matches (test/api-contract.test.mjs).
import changelog from '../../docs/changelog.json' with {type: 'json'};

export {changelog};
export const API_VERSION = changelog.releases[0].version;
