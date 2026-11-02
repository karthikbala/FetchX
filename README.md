# FetchX

**One API for fetching, rendering and interacting with public web pages.**

FetchX is a self-hosted crawling gateway with a [one-call HTTP API](docs/fetch-api.md) in the Firecrawl/Scrape.do model. Clients explicitly select an approved proxy class and country, inspect source failures, and choose their next request. Oxylabs supplies datacenter IPs; Evomi is the primary residential provider, with DataImpulse as residential backup. New rendered workflows default to Camoufox once installed, pinned and qualified; existing CloakBrowser workflows and explicit engine selections remain supported.

The current Camoufox pairing is **blocked from service execution** with `browser_runtime_unqualified`. Local browser checks have not demonstrated request interception, native service-worker blocking and reliable cookie restoration together. A configuration flag cannot override this gate. Native HTTP and explicitly configured legacy CloakBrowser workflows remain available; see the [qualification findings](docs/browser-engines.md).

The existing v1 native residential default remains **Evomi → DataImpulse**. V2 pins the approved provider and country to a session and does not switch providers after dispatch. Browser requests use **Evomi/free → DataImpulse/free → Evomi/paid → DataImpulse/paid**, when configured and entitled. Fallback responds to qualified failures; it does not make four attempts on every page.

## What works

- One-call fetch API and project-scoped profile discovery.
- HTTP requests and managed, sandboxed browser rendering.
- Reviewed click, fill, select, press, wait and scroll recipes.
- Structured selector extraction and PNG screenshots.
- Sticky workflow sessions with encrypted cookies/localStorage.
- Durable asynchronous jobs, polling and queued-job cancellation.
- Central reCAPTCHA v2 and standalone Turnstile form solving with cost reservations and source verification.
- Idempotent capture replay without repeating provider charges.
- Encrypted request/capture storage, destination restrictions, project isolation, rate limits and spending reservations.
- JavaScript and Python clients; diagnostics and application acceptance reporting.

FetchX is not yet a complete Scrape.do replacement. It does not include universal managed unblocking, arbitrary browser scripts/CDP, webhooks or horizontal workers. CAPTCHA support requires a reviewed form profile; hCaptcha, DataDome and managed Cloudflare challenge pages are not supported. Actual source acceptance must be qualified per site. Residential bandwidth can cost money on failed requests. Paid browser builds require an active entitlement; a trial key is not perpetual.

## Quick start

Requires Node.js 24+, Docker Compose and provider credentials. Browser rendering additionally requires a locally installed, pinned compatible browser. See [browser engines](docs/browser-engines.md) for Camoufox setup and existing CloakBrowser compatibility. FetchX does not redistribute browser binaries or licenses.

Use [`POST /v2/fetch`](docs/fetch-api.md) for one-call HTTP fetching with an explicit
`proxy.class` and `proxy.country`, an approved `access_profile`, and an idempotency
key. It returns native status/body, the pinned route, retained hashes, safe failure
guidance and accounting; `GET /v2/fetch/:key` recovers without source traffic.
Rendering options are rejected on this HTTP endpoint. Existing v1 rendered recipes
remain separate.

The additive [v2 HTTP foundation](docs/api-v2.md) also works with a local Node
process and PostgreSQL, including direct native HTTP, independently requested
proxy class/country, encrypted source cookie sessions, original compressed
responses/downloads, durable operations, key usage analytics and optional client
quotas. Its security profiles and recipes are separately versioned and require
server approval. Broad v2 browser sessions and live connections remain unsupported;
existing v1 browser recipes continue to use the v1 API. An optional
[one-shot browser network probe](docs/api-v2-browser-probe.md) interface separates
decoded native responses from generated DOM. New probes are currently disabled
until browser redirect admission is qualified. It never claims original compressed
browser bodies.

Open `/console` on your private gateway to inspect v2 project usage and recent
operations with its API key. The key stays in tab memory, and the console is
read-only: it does not start crawls or grant source access.

The website also has a [self-service account workspace](docs/self-service-backend.md):
email verification, projects, scoped API keys, a native HTTP playground, retained
history and request credits. It is disabled until an operator configures the
gateway bridge, verification mail, reviewed source grants and credit policy.
New account keys support native HTTP only; existing provisioned workflow tokens
retain their contracts. Paid subscriptions and automatic refills are not enabled.

```sh
git clone https://github.com/karthikbala/FetchX.git
cd FetchX
npm ci --ignore-scripts
node scripts/init-config.mjs ./local
docker compose --env-file ./local/compose.env build
```

The initializer creates a private configuration, a project token and database credentials. Edit `local/secrets/gateway.json` to configure provider credentials, reviewed source profiles and limits. Providers start disabled when credentials are absent. Optional initializer environment variables: `EVOMI_USERNAME`, `EVOMI_PASSWORD`, `DATAIMPULSE_USERNAME`, `DATAIMPULSE_PASSWORD`.

For new browser profiles, follow the [Camoufox installation and pinning instructions](docs/browser-engines.md). Existing CloakBrowser configurations retain their reviewed binary/version/hash and entitlement requirements; configure paid builds separately with a valid paid license. Never commit browser distributions or credentials.

On Linux, make the generated secret readable by the service UID:

```sh
sudo chown 10001:10001 local/secrets/gateway.json
docker compose --env-file ./local/compose.env up -d
export FETCHX_TOKEN="$(cat local/secrets/client.token)"
curl http://localhost:8788/v1/profiles -H "Authorization: Bearer $FETCHX_TOKEN"
curl http://localhost:8788/v1/fetch \
  -H "Authorization: Bearer $FETCHX_TOKEN" -H 'Content-Type: application/json' \
  -d '{"profile":"example.http","url":"https://example.com/","idempotency_key":"saved-example-key"}'
```

Example profiles are limited to `example.com`; configure your own reviewed profiles before onboarding real sources. Keep the listener private or put authenticated TLS access in front of it. Read the [CAPTCHA setup and limits](docs/captcha.md), [API contract](docs/api.md), [operations guide](docs/operations.md), and [client examples](clients/README.md).

## Test

```sh
npm test
createdb gateway_test_fetchx
TEST_DATABASE_URL=postgresql:///gateway_test_fetchx npm test
```

Database tests intentionally truncate their disposable database and run serially. Never use a production database. They use fake providers and synthetic fixtures. Set `BROWSER_TEST_EXECUTABLE` to a compatible sandbox-capable Chromium/CloakBrowser executable. For the actual Camoufox diagnostics, also set `CAMOUFOX_TEST_EXECUTABLE`, `CAMOUFOX_TEST_MODEL` and `CAMOUFOX_TEST_SHA256` as described in [browser verification](docs/browser-engines.md). Missing database/browser prerequisites skip their corresponding integration tests. CI provisions the database and Chromium; Camoufox diagnostics require its separately provisioned pinned runtime and model and do not lift the service qualification gate.

## Repository boundaries

This repository starts with clean public history. Production credentials, account configuration, retained source captures, client-specific profiles, operational reports and private experiment evidence are excluded. An empty reviewed-evidence registry and synthetic regression fixtures are provided. Legacy provider adapters remain for explicitly configured migrations; they are not the default for new sources.

Third-party services, packages and browser binaries have their own licenses and terms. See [CloakBrowser's binary license](https://github.com/CloakHQ/CloakBrowser/blob/main/BINARY-LICENSE.md).
