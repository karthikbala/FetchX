# Browser

Browser steps run [Camoufox](https://github.com/daijro/camoufox), a hardened Firefox, through Playwright. There is one engine; there is no fallback to another browser.

## The pin

`CAMOUFOX_PIN` in `src/browser/engine.mjs` fixes the build: browser `158.0.1-beta.41` from the `camoufox@0.5.9` launcher, `playwright-core@1.62.1`, and the `fpgen-js@1.3.0` fingerprint model (archive SHA-256 `6530b832…9936`). `config.browser.camoufox` names the installed files:

```json
{"version": "158.0.1-beta.41", "sha256": "<sha256 of the executable>",
 "executablePath": "/opt/gateway-browser/camoufox/camoufox-bin", "modelDir": "/opt/gateway-browser/camoufox-model"}
```

Before every launch `verifyCamoufox` checks the executable's SHA-256, the version, the `.pinned-model` marker and every model file. A mismatch fails the step with `browser_build_mismatch` or `browser_model_unavailable`; auto mode then has no browser step. Install the official release outside the gateway, check its release digest, preinstall the model, and mount the directory read-only at `/opt/gateway-browser` (readable by UID 10001). FetchX does not ship browser binaries.

## How a capture runs

1. `browser-attempt.mjs` starts a relay: a loopback CONNECT proxy that is the browser's only way out. It tunnels only to hosts that have been checked and pinned to one public address, through the step's route proxy, and meters every byte.
2. The page's requests go through Playwright interception and the `admit` hook: https only, GET or HEAD (plus small page POSTs from scripts), public address after DNS, provider rules, at most 250 requests. Hops the interception does not see, such as redirects, are checked by the relay through `admitHost` before it opens a tunnel.
3. `capture.mjs` loads the page, waits (`wait_for`, then a short settle), solves captchas if any ([captcha](captcha.md)), and returns the rendered DOM (or the document as received for non-HTML), an optional JPEG screenshot and the cookies.
4. The caller's own headers and cookies go only to the requested origin. Cookies are also sent as a header and read back from `Set-Cookie`, because Camoufox runs in private browsing and its automation cookie API addresses the wrong jar.

Launch options (`camoufoxOptions`) turn off GeoIP, WebRTC, DNS prefetch, DNS-over-HTTPS, HTTP/3, updates and telemetry, set the locale and timezone from the exit country, and allow no direct connection around the relay. Service workers are disabled by private browsing.

## Where browsers run

- **On the gateway host** (default): `config.browser.maxConcurrent` browsers at once, each in a child process (`runner.mjs` → `worker-process.mjs`) that is killed with its process group at the deadline.
- **On a worker pool**: set `config.browser.pool` (`registry_path`, `callback_socket`). Workers run `src/browser/worker-service.mjs` in a container with no network (`network_mode: none`); the gateway reaches each over a Unix socket listed in the registry, and the worker sends its page's requests, artifacts, captcha solves and CONNECT tunnels back over the callback socket. A worker serves one capture at a time. Its runtime pin (`/run/fx/pin/runtime.json`) must equal the gateway's.

Compose files: `compose.browser-worker.yaml` (a worker), `compose.browser-pool.yaml` (a staging gateway with a pool), `deploy/browser-pool/compose.production.*.yaml` (production overlays), and `deploy/browser-pool/prepare-layout.sh` (host directories and the tunnel user). The [Hetzner autoscaler](hetzner-autoscaling.md) adds and removes workers; it reads `GET /v1/pool-metrics` on the callback socket, which reports waiting and running captures from `BrowserSlots`.

## Tests

`test/browser.test.mjs` covers capture, captchas, cookies, the relay and the pool with fakes. Set `BROWSER_TEST_EXECUTABLE` to a Chromium build to run the capture tests in a real browser; capture uses only the Playwright API. A real Camoufox run (launch, a redirecting site, a captcha page) is part of each release's qualification on the server, where the pinned build is installed.
