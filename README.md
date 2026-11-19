# FetchX

**Get any public URL with one API call.** FetchX picks the cheapest route that gets the site's real answer, uses a browser and solves captchas when it must, remembers what worked per site, and charges only when it gets the data.

```sh
curl https://app.fetchx.ai/v1/fetch \
  -H "Authorization: Bearer $FETCHX_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com/", "formats": ["markdown"]}'
```

## How it works

- **One endpoint.** `POST /v1/fetch` takes a URL and returns the body as received, plus markdown, text, links, metadata, parsed JSON or a screenshot on request. Six more endpoints read results, download files, list, delete and report usage. See the [API guide](docs/api.md) and the [OpenAPI contract](docs/openapi.json).
- **Auto mode.** Requests climb a ladder until the site answers: HTTP direct, a datacenter proxy, residential IPs (a fresh IP after each 429, alternating between Evomi and DataImpulse), then a Camoufox browser over residential and datacenter routes. Empty JavaScript shells go straight to a browser. Methods other than GET and HEAD get exactly one attempt.
- **Site knowledge.** Every attempt is recorded per host; the next request starts at the step that worked, and failing routes rest instead of being retried. See [site knowledge](docs/site-knowledge.md).
- **Captchas.** In the browser, Turnstile, reCAPTCHA v2 and hCaptcha are solved through 2Captcha, and DataDome when enabled. See [captcha solving](docs/captcha.md).
- **Budgets.** Every spend limit (2Captcha, residential traffic, worker VMs, attempts, credits per request, trial credits) has hard bounds in code and can be changed in the admin portal without a redeploy, with each change audited. See [budgets](docs/budgets.md).
- **Success-only billing.** A request reserves credits up front and is charged only if it succeeds, at the price of the step that worked. See [billing](docs/billing.md).
- **Safe by default.** Only public addresses are fetched, checked after DNS and on every redirect, in HTTP and in the browser. Provider rules keep some providers off some hosts (Oxylabs never carries `.gov`). See [provider rules](docs/provider-rules.md).

## Repository

| Path | What it is |
| --- | --- |
| `src/server.mjs` | The gateway: wires the services and serves the API, the console API and the Stripe webhook |
| `src/fetch/` | Request parsing, address checks, HTTP transport, the auto-mode ladder, browser attempts, outputs |
| `src/browser/` | Camoufox launch, page capture, captcha handling, the egress relay and the worker pool |
| `src/billing/` | The credit ledger, purchases and trial grants |
| `src/captcha/` | The 2Captcha client |
| `src/budgets.mjs` | Spend budgets and limits, adjustable in the admin portal ([budgets](docs/budgets.md)) |
| `src/api/v1.mjs` | The public API routes and error format |
| `src/control*.mjs` | Console accounts, projects, keys, Connect, Stripe and the admin API |
| `clients/` | JavaScript and Python clients, and the Connect helper for agents |
| `website/` | fetchx.ai: marketing pages, docs and the console (Astro on Cloudflare Pages) |
| `deploy/`, `ops/` | Browser worker pool and Hetzner autoscaler |

## Run it locally

Requires Node.js 24, PostgreSQL 16 and Docker Compose. Browser steps need a pinned Camoufox build ([browser setup](docs/browser.md)); without one, auto mode stops at HTTP.

```sh
npm ci --ignore-scripts
node scripts/init-config.mjs ./local
docker compose --env-file ./local/compose.env up -d --build
curl http://localhost:8788/v1/fetch -H "Authorization: Bearer $(cat local/secrets/client.token)" \
  -H 'Content-Type: application/json' -d '{"url": "https://example.com/"}'
```

`init-config.mjs` writes `local/secrets/gateway.json` with one unmetered project token; add proxy, captcha and browser settings there ([configuration](docs/configuration.md)). For the console, run `node scripts/control-preview.mjs --fixture --database-url postgresql://…/gateway_test_preview` and the website ([console](docs/console.md)).

## Test

```sh
createdb gateway_test_fetchx
TEST_DATABASE_URL=postgresql:///gateway_test_fetchx npm test
```

Tests run serially against a database whose name starts with `gateway_test_`; they never touch the network or a paid service. Set `BROWSER_TEST_EXECUTABLE` to a Chromium build to run the real-browser capture tests. `npm run api:check` keeps the TypeScript client types in step with the contract, and `python -m unittest discover -s test/autoscaler` covers the autoscaler. The website has its own `npm run check`, `npm test` and `npm run test:browser` in `website/`.

## Operating

[Operations](docs/operations.md) covers deploying, upgrading from the earlier releases, retention, backups and rollback.
