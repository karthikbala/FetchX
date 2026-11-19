# Configuration

The gateway reads one JSON file, `GATEWAY_CONFIG` (default `/run/secrets/gateway.json`), at start. `scripts/init-config.mjs` writes a starting point. Keep it mode 0600, readable only by the service user (UID 10001), and out of Git. Environment: `DATABASE_URL`, `GATEWAY_PORT` (8788), `GATEWAY_HOST` (0.0.0.0).

```json
{
  "release": "fetchx-2026-11-20",
  "artifactKey": "64 hex characters",
  "projects": {"local": {"tokenHash": "sha256 of the token"}},
  "proxies": [{"id": "dc-us-1", "country": "US", "provider": "oxylabs", "url": "http://user:pass@dc.oxylabs.io:8001/"}],
  "residential": {"providers": {
    "evomi": {"enabled": true, "username": "…", "password": "…", "countries": ["US", "IN"]},
    "dataimpulse": {"enabled": true, "username": "…", "password": "…"}
  }},
  "browser": {"maxConcurrent": 1, "camoufox": {"version": "158.0.1-beta.41", "sha256": "…", "executablePath": "/opt/gateway-browser/camoufox/camoufox-bin", "modelDir": "/opt/gateway-browser/camoufox-model"}},
  "captcha": {"enabled": true, "apiKey": "…", "maxTaskMicroUsd": 3000, "maxDailyMicroUsd": 1000000, "maxTotalMicroUsd": 10000000, "maxTotalTasks": 10000},
  "controlPlane": {"enabled": true, "origins": ["https://fetchx.ai"], "bridgeSecret": "…", "apiBaseUrl": "https://app.fetchx.ai"}
}
```

## Core

| Key | Meaning |
| --- | --- |
| `release` | Shown by `/healthz`. |
| `artifactKey` | 64 hex characters. Seals stored requests and results (AES-256-GCM). Changing it makes stored results unreadable. |
| `projects` | Projects provisioned here instead of in the console: `{id: {tokenHash, maxConcurrentRequests?}}`. They are unmetered. |
| `fetchLimits` | Overrides for `DEFAULT_LIMITS` in `src/fetch/service.mjs`: body and wire caps, `contentDays` (7), `metadataDays` (90), `syncWaitMs` (60 s), `maxConcurrentPerProject` (10). |
| `destinations.blockedHosts` | Extra host names never fetched. `fetchx.ai` and the console origins are always blocked. |

## Routes

| Key | Meaning |
| --- | --- |
| `routes.direct` | `false` removes the direct route (every request then uses a proxy). |
| `proxies` | Datacenter proxies: `{id, country, provider, url}`. `provider` defaults to `oxylabs`. |
| `residential.providers.evomi`, `.dataimpulse` | `{enabled, username, password, countries?}`. The exit countries offered are `countries`, else `residential.countries`, else US. Requests alternate between the two after a rate limit. |
| `dns` | `{endpoint, address, timeoutMs?}`: resolve names for proxied requests over DNS-over-HTTPS (`/resolve` or `/dns-query`) through the same proxy, so the exit country's answer is used. Without it, the gateway's resolver is used. |
| `providerRules` | Extra provider rules; see [provider rules](provider-rules.md). Rules saved in the admin portal are loaded from the database every `providerRulesRefreshMs` (30 s). |
| `siteKnowledge` | Overrides for `SITE_KNOWLEDGE_DEFAULTS`: `freshMs` (7 days), `demoteAfter` (2), `blockedRetryMs` (1 day), `unreachableRetryMs` (1 hour). |

## Browser

| Key | Meaning |
| --- | --- |
| `browser.camoufox` | `{version, sha256, executablePath, modelDir}`. `version` must match the pin in `src/browser/engine.mjs`; without a valid entry, auto mode never uses a browser. See [browser](browser.md). |
| `browser.maxConcurrent` | Browsers run on the gateway host at once when there is no pool (1). |
| `browser.pool` | `{registry_path, callback_socket}`: run captures on the worker pool instead. |
| `browser.maxConcurrentRequests` | Reported to the autoscaler as the gateway's browser concurrency (64). |

## Captchas and prices

| Key | Meaning |
| --- | --- |
| `captcha` | `{enabled, apiKey, maxTaskMicroUsd, maxDailyMicroUsd, maxTotalMicroUsd, maxTotalTasks, maxTasksPerRequest?, timeoutMs?, datadome?}`. `datadome: true` allows DataDome solving, which sends the attempt's proxy credentials to 2Captcha. See [captcha](captcha.md). |
| `pricing` | Overrides for `DEFAULT_PRICES` in `src/billing/ledger.mjs`: `http`, `http_residential`, `browser`, `browser_residential`, `captcha`, `residential_included_mb`, `residential_overage_per_mb`. See [billing](billing.md). |

## Console

`controlPlane` enables accounts, projects, keys and billing behind the website's bridge; see [console](console.md).

| Key | Meaning |
| --- | --- |
| `enabled`, `origins`, `bridgeSecret` | The website origins and the shared secret its bridge sends (at least 32 characters). |
| `apiBaseUrl` | The public API origin shown in the console and given to Connect clients. |
| `sessionSecure` | `false` only for loopback development (with `allowLoopbackDevelopment`). |
| `creditPolicy.trialCredits` | Trial credits per account (1,000, at most 1,000). |
| `mail`, `google`, `github` | Sign-in methods; see [GitHub sign-in](github-sign-in.md) and [Google sign-in](google-sign-in.md). |
| `agentConnectEnabled` | The Connect device flow for agents. |
| `stripe` | Checkout; see [Stripe payments](stripe-payments.md) and [INR UPI](inr-upi-backend.md). |
| `admin.enabled` | The operator portal at `/app/admin`. |
