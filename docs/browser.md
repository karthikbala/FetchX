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
3. `capture.mjs` loads the page (from the site's home page first when the step warms up, see below), waits (`wait_for`, then a short settle), lets a bot check clear by itself, solves captchas if any remain ([captcha](captcha.md)), and returns the rendered DOM (or the document as received for non-HTML), an optional JPEG screenshot and the cookies.
4. The caller's own headers and cookies go only to the requested origin. Cookies are also sent as a header and read back from `Set-Cookie`, because Camoufox runs in private browsing and its automation cookie API addresses the wrong jar.

Launch options (`camoufoxOptions`) turn off Camoufox's own GeoIP, WebRTC, DNS prefetch, DNS-over-HTTPS, HTTP/3, updates and telemetry, and allow no direct connection around the relay. The timezone, position and locale are the exit IP's: before the step the gateway asks `browser.exitGeo` (ipinfo.io by default) through the step's own proxy where that IP is, cached per proxy session; if the lookup fails, the route country's timezone is used. There is no viewport override, so the window has the size the device identity claims. Service workers are disabled by private browsing.

The persona is Windows. Its fonts come from the Camoufox bundle, which ships each persona's fonts and points fontconfig at that persona's set only, so the fonts a page can measure match the claimed device; nothing has to be copied onto workers (copying real fonts is a Chromium-stealth step). Measured on production on 2026-11-19 with `scripts/browser-live-check.mjs --fonts`: a page detects the Windows fonts, and none of the gateway image's own fonts (FreeSans, WenQuanYi, Unifont) or the bundle's macOS and Linux fonts. Repeat that check after changing the image or the bundle.

## Sessions, warm-up and walls

These follow what a long crawl behind DataDome taught ([cloak-setup](https://github.com/karthikbala/cloak-setup)): IP reputation decides most walls, a known-good residential session is the most valuable thing to keep, sessions age out under load, and a steady pace is tolerated where bursts are not.

- **Kept sessions.** When a residential browser step succeeds, its session (exit IP) and the device identity Camoufox drew for it are kept for that host in the gateway's memory (`src/fetch/sessions.mjs`). The next residential browser step for the host reuses them, so repeat visits look like one returning device. One browser uses a session at a time. A session is retired after 40 pages or 25 minutes, and dropped at the first wall, rate limit, or change of exit IP (providers sometimes move a sticky session). Only routing data is kept: never cookies, URLs or anything a caller sent.
- **Pacing.** Pages on a kept session are at least 4 s apart, with jitter. On a host that has refused FetchX before (site knowledge, or a block earlier in the same request), browser steps from all sessions are spaced 1 s apart. Pacing never waits so long that the step could not finish before the request's deadline.
- **Warm-up.** On those same hosts a browser step visits the site's home page first and reaches the URL from it (with the home page as referrer), the way a visitor does. A bot check on the home page gets 20 s to clear by itself; if it stays, the step ends there with that wall and auto mode moves to a fresh IP. Each step reports `warmup` in `attempts`.
- **Fresh draws.** A wall on a fresh residential IP is mostly that IP's reputation, so the next attempt draws another, and site knowledge cools a residential browser route only after six walls in a row ([site knowledge](site-knowledge.md#route-states)). Measured on Expedia on 2026-11-19 with `scripts/browser-live-check.mjs`: 5 of 12 fresh draws passed (3 of 6 with the warm-up, 2 of 6 without, so the warm-up neither helped nor hurt there), and a session that passed then passed 6 of 6 pages.
- **Walls clear themselves.** Interstitial device checks (DataDome, Cloudflare) usually pass on their own in a real browser on a clean IP and then reload into the page. A page that is a wall (a block status, a challenge title, or a DataDome frame) is given up to 45 s (`fetchLimits.selfClearMs`) to clear before any captcha is solved, with small pointer moves meanwhile. A captcha frame waits for a person rather than clearing, so a DataDome captcha gets only 8 s, and DataDome's blocked-visitor frame (`t=bv`) none. Each step reports `wall: cleared | stayed` in `attempts`.

## Where browsers run

- **On the gateway host** (default): `config.browser.maxConcurrent` browsers at once, each in a child process (`runner.mjs` → `worker-process.mjs`) that is killed with its process group at the deadline.
- **On a worker pool**: set `config.browser.pool` (`registry_path`, `callback_socket`). Workers run `src/browser/worker-service.mjs` in a container with no network (`network_mode: none`); the gateway reaches each over a Unix socket listed in the registry, and the worker sends its page's requests, artifacts, captcha solves and CONNECT tunnels back over the callback socket. A worker serves one capture at a time. Its runtime pin (`/run/fx/pin/runtime.json`) must equal the gateway's.

Compose files: `compose.browser-worker.yaml` (a worker), `compose.browser-pool.yaml` (a staging gateway with a pool), `deploy/browser-pool/compose.production.*.yaml` (production overlays), and `deploy/browser-pool/prepare-layout.sh` (host directories and the tunnel user). The [Hetzner autoscaler](hetzner-autoscaling.md) adds and removes workers; it reads `GET /v1/pool-metrics` on the callback socket, which reports waiting and running captures from `BrowserSlots`.

## Tests

`test/browser.test.mjs` covers capture, captchas, cookies, the relay and the pool with fakes. Set `BROWSER_TEST_EXECUTABLE` to a Chromium build to run the capture tests in a real browser; capture uses only the Playwright API. A real Camoufox run (launch, a redirecting site, a captcha page) is part of each release's qualification on the server, where the pinned build is installed.
