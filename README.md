# FetchX

**One API for fetching, rendering and interacting with public web pages.**

FetchX is a self-hosted crawling gateway built around Evomi residential proxies and CloakBrowser. Crawlers describe the source and request; FetchX owns proxy selection, browser execution, sticky sessions, bounded fallback, durable recovery and bandwidth budgets.

Native requests use **Evomi → DataImpulse**. Browser requests use **Evomi/free → DataImpulse/free → Evomi/paid → DataImpulse/paid**, when configured and entitled. Fallback responds to qualified failures; it does not make four attempts on every page.

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

Requires Node.js 24+, Docker Compose and provider credentials. Browser rendering additionally requires an officially obtained Linux x86-64 CloakBrowser binary. FetchX does not redistribute browser binaries or licenses.

```sh
git clone https://github.com/karthikbala/FetchX.git
cd FetchX
npm ci --ignore-scripts
node scripts/init-config.mjs ./local
docker compose --env-file ./local/compose.env build
```

The initializer creates a private configuration, a project token and database credentials. Edit `local/secrets/gateway.json` to configure provider credentials, reviewed source profiles and limits. Providers start disabled when credentials are absent. Optional initializer environment variables: `EVOMI_USERNAME`, `EVOMI_PASSWORD`, `DATAIMPULSE_USERNAME`, `DATAIMPULSE_PASSWORD`.

For browser profiles, put the complete officially obtained browser distribution in `local/browser/free/` and configure `browser.free` with its container `executablePath` (`/opt/gateway-browser/free/chrome`), exact `version`, SHA-256 and `entitlement:"unlicensed"` only for an eligible unlicensed build. Configure paid builds separately, with a valid paid license. Never commit these files. Verify compatibility and entitlement with the vendor.

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

Database tests intentionally truncate their disposable database and run serially. Never use a production database. They use fake providers and synthetic fixtures. To include actual local browser interaction tests, set `BROWSER_TEST_EXECUTABLE` to a compatible sandbox-capable Chromium/CloakBrowser executable. Without the database/browser, the relevant integration tests are skipped. CI provisions both.

## Repository boundaries

This repository starts with clean public history. Production credentials, account configuration, retained source captures, client-specific profiles, operational reports and private experiment evidence are excluded. An empty reviewed-evidence registry and synthetic regression fixtures are provided. Legacy provider adapters remain for explicitly configured migrations; they are not the default for new sources.

Third-party services, packages and browser binaries have their own licenses and terms. See [CloakBrowser's binary license](https://github.com/CloakHQ/CloakBrowser/blob/main/BINARY-LICENSE.md).
