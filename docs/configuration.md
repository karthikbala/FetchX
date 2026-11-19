# Configuration

The platform reads one JSON file, `PLATFORM_CONFIG` (default `/run/secrets/platform.json`), at start. `scripts/init-config.mjs` writes a starting point. Keep it mode 0600, readable only by the service user (UID 10001), and out of Git. Environment: `DATABASE_URL`, `PLATFORM_PORT` (8788) and `PLATFORM_HOST` (0.0.0.0) for the public app, `PLATFORM_EVENTS_PORT` (8789) and `PLATFORM_EVENTS_HOST` (0.0.0.0) for the private engine-events listener.

Fetching is configured in the engine's own `engine.json` (proxies, residential providers, browser, captcha, provider rules, site knowledge); see the engine repository.

```json
{
  "release": "fetchx-2026-11-20",
  "sealingKey": "64 hex characters",
  "engine": {"url": "http://engine:8790", "serviceToken": "…", "eventKey": "…"},
  "projects": {"local": {"tokenHash": "sha256 of the token"}},
  "controlPlane": {"enabled": true, "origins": ["https://fetchx.ai"], "bridgeSecret": "…", "apiBaseUrl": "https://app.fetchx.ai"}
}
```

## Core

| Key | Meaning |
| --- | --- |
| `release` | Shown by `/healthz`. |
| `sealingKey` | 64 hex characters. Seals webhook secrets and queued webhook URLs (AES-256-GCM). Changing it makes them unreadable. |
| `projects` | Projects provisioned here instead of in the console: `{id: {tokenHash, maxConcurrentRequests?}}`. They are unmetered. |
| `fetchLimits` | Overrides for `DEFAULT_LIMITS` in `src/fetch/front.mjs`: `maxCredits` (the largest `max_credits`, 100,000), `maxConcurrentPerProject` (10), `maxWireBytes` (the engine's response cap, used for the worst-case reservation), `settleGraceMs` (how long past its deadline a job without an event is looked up, 30 s), `metadataDays` (90). |
| `destinations.blockedHosts` | Extra host names customer webhooks are never sent to. `fetchx.ai` and the console origins are always blocked. |
| `pricing` | Overrides for `DEFAULT_PRICES` in `src/billing/ledger.mjs`; see [billing](billing.md). |

## Engine

| Key | Meaning |
| --- | --- |
| `engine.url` | The engine on the private network, `http://engine:8790` in Compose. |
| `engine.serviceToken` | At least 32 characters; the engine keeps its SHA-256 in `platform.tokenHashes`. Without it every fetch answers 503 `unavailable`. |
| `engine.eventKey` | The key the engine signs `job.finished` events with (its `platform.eventKey`), at least 32 characters. |
| `engine.previousEventKey` | During a rotation, the old event key, still accepted. |
| `engine.timeoutMs` | How long to wait for an engine answer (90 s; a synchronous fetch waits for its own `wait_ms` plus 30 s). |

The engine's `scripts/init-config.mjs` writes `platform-link.json` with a fresh service token and event key; pass it to this repository's `init-config.mjs`, or copy the two values by hand.

### Rotating the service token or the event key

Service token: add the new token's SHA-256 to the engine's `platform.tokenHashes` (it accepts two), restart the engine, put the new token in `engine.serviceToken` here, restart the platform, then remove the old hash. Event key: put the old key in `engine.previousEventKey` and the new one in `engine.eventKey` here, restart the platform, change the engine's `platform.eventKey`, restart it, then drop `previousEventKey`.

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
| `admin.enabled` | The operator portal at `/app/admin`. Its rules, probes and site pages are forwarded to the engine's admin API, with the operator's email as the actor. |
