# FetchX

**Get any public URL with one API call.** FetchX picks the cheapest route that gets the site's real answer, uses a browser and solves captchas when it must, remembers what worked per site, and charges only when it gets the data.

```sh
curl https://app.fetchx.ai/v1/fetch \
  -H "Authorization: Bearer $FETCHX_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com/", "formats": ["markdown"]}'
```

## Two repositories

FetchX is two services:

- **This repository, the platform:** the public API at `/v1`, accounts, projects and keys, credits and payments, customer webhooks, the console API behind fetchx.ai, the admin portal, and the website.
- **[fetchx-engine](https://github.com/karthikbala/fetchx-engine) (private), the engine:** fetching. Proxies, residential IPs, Camoufox, captcha solving, provider rules and site knowledge, and the results it stores.

The platform calls the engine over a private network with a service token ([the engine contract](docs/engine-api.json), pinned here). The engine never sees prices, credits or users: each job carries the project id as an opaque tenant and the cost tiers the project's credits cover. When a job finishes the engine sends a signed `job.finished` event, and the platform charges or releases the reservation exactly once.

## How it works

- **One endpoint.** `POST /v1/fetch` takes a URL and returns the body as received, plus markdown, text, links, metadata, parsed JSON or a screenshot on request. Six more endpoints read results, download files, list, delete and report usage. See the [API guide](docs/api.md) and the [OpenAPI contract](docs/openapi.json).
- **Auto mode** (in the engine). Requests climb from plain HTTP through datacenter and residential routes to a Camoufox browser until the site answers, solving captchas on the way.
- **Budgets.** Every spend limit can be changed in the admin portal without a redeploy, within hard bounds in code, with each change audited. The platform keeps its own (credits per request, requests at once per project, trial credits); provider spend (2Captcha, residential traffic, worker VMs, attempts) is capped by the engine's budgets, shown in the same list. See [budgets](docs/budgets.md).
- **Success-only billing.** A request reserves credits up front and is charged only if it succeeds, at the price of the step that worked. See [billing](docs/billing.md).
- **Safe by default.** The engine fetches only public addresses, checked after DNS and on every redirect; the platform does the same for customer webhooks.

## Repository

| Path | What it is |
| --- | --- |
| `src/server.mjs` | The platform: wires the services and serves the API, the console API, the Stripe webhook and the private engine-events listener |
| `src/engine/` | The engine client and the signed-event listener |
| `src/fetch/front.mjs` | Admission, reservations, settlement and the reconciler for fetches |
| `src/fetch/webhooks.mjs` | Customer webhook delivery |
| `src/billing/` | The credit ledger, purchases and trial grants |
| `src/budgets.mjs` | The platform's budgets, adjustable in the admin portal ([budgets](docs/budgets.md)) |
| `src/api/v1.mjs` | The public API routes and error format |
| `src/control*.mjs` | Console accounts, projects, keys, Connect, Stripe and the admin portal (forwarded to the engine) |
| `clients/` | JavaScript and Python clients, and the Connect helper for agents |
| `website/` | fetchx.ai: marketing pages, docs and the console (Astro on Cloudflare Pages) |

## Run it locally

Requires Node.js 24, PostgreSQL 16, Docker Compose, and the engine running from its own repository.

```sh
# In fetchx-engine: writes local/secrets/platform-link.json with the service token and event key.
node scripts/init-config.mjs ./local
docker network create fetchx-internal
docker compose --env-file ./local/compose.env up -d --build

# Here:
npm ci --ignore-scripts
node scripts/init-config.mjs ./local ../fetchx-engine/local/secrets/platform-link.json
docker compose --env-file ./local/compose.env up -d --build
curl http://localhost:8788/v1/fetch -H "Authorization: Bearer $(cat local/secrets/client.token)" \
  -H 'Content-Type: application/json' -d '{"url": "https://example.com/"}'
```

`init-config.mjs` writes `local/secrets/platform.json` with one unmetered project token and the engine link ([configuration](docs/configuration.md)). For the console alone, `node scripts/control-preview.mjs --fixture --database-url postgresql://…/gateway_test_preview` runs the platform with an in-process fake engine; see [console](docs/console.md).

## Test

```sh
createdb gateway_test_fetchx
TEST_DATABASE_URL=postgresql:///gateway_test_fetchx npm test
```

Tests run serially against a database whose name starts with `gateway_test_`; they never touch the network, a paid service or a real engine. Platform tests use the fake engine in `test/fake-engine.mjs`, which `test/engine-contract.test.mjs` holds to the pinned contract. `npm run api:check` keeps the TypeScript client types in step with the public contract. The website has its own `npm run check`, `npm test` and `npm run test:browser` in `website/`.

## Operating

[Operations](docs/operations.md) covers deploying, retention, backups, rollback and incidents. [The split migration](docs/split-migration.md) is the one-time runbook for moving production from the single gateway to the platform and the engine.
