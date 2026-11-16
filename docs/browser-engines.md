# Reviewed browser engines

New `residential-v1` workflows with `execution: "browser"` snapshot the intended default `browserEngine: "camoufox"`, unless a reviewed profile or `browser.defaultEngine` explicitly selects `"cloakbrowser"`. Existing persisted workflows without an engine retain the legacy CloakBrowser interpretation. Configuration files and stored sessions are not rewritten. Native HTTP remains available for known APIs; the v2 browser probe remains disabled.

**Camoufox runs in native private browsing with FetchX-managed cookies.** A tier is admitted only when its build and model verify and an operator has set `qualified: true` after source acceptance. Unqualified tiers return `browser_not_qualified`; each run also refuses to start (`browser_runtime_unqualified`) unless a locally fulfilled page on the target host is a secure context with no service-worker API. Direct HTTP and an explicitly configured legacy CloakBrowser runtime remain separate routes. The gateway never switches engine automatically.

## Pinned build and qualification findings

| Component | Pin |
| --- | --- |
| Official npm launcher | `camoufox@0.5.9` |
| Playwright protocol client | `playwright-core@1.62.1` (launcher peer range `<1.63`) |
| Paired browser | `158.0.1-beta.41`, interface 1 |
| Fingerprint generator | `fpgen-js@1.3.0` |
| Model archive SHA-256 | `6530b8322cdaa4ec042921c8d9a0369a0e6e0269ba636c01a7203e4a2f109936` |

Synthetic tests of this exact candidate established:

- `dom.serviceWorkers.enabled: false` also disables Juggler request interception. Requests reached the local TLS tripwire without either route handler running. The initial assumption that Firefox required CONNECT before interception was incorrect.
- Enabling Gecko's interception engine restores routing. Playwright's `serviceWorkers: "block"` uses an injected registration no-op; that does not establish native exclusion.
- Native private browsing plus `dom.serviceWorkers.privateBrowsing.enabled: false` removes site service-worker access, but Juggler `storageState` loses script and HTTP-only cookies. This fails workflow continuity.
- With a valid script and native registration enabled as a positive control, both ordinary settings and `dom.serviceWorkers.maxPerDomain: 0` register an active worker. That candidate quota preference is ineffective.

Linux container tests (2026-11) then established:

- Service-worker script fetches and service-worker-originated requests never reach Juggler routing. The route handler does not see them, so they cannot be denied there; workers must be natively absent.
- Native private browsing removes `navigator.serviceWorker` entirely while request interception keeps working.
- The cookie loss is a Juggler defect: its `getCookies`/`setCookies` use origin attributes `{userContextId}` only and ignore `privateBrowsingId`, so `storageState`, `addCookies` and `cookies()` address the non-private jar. localStorage export/import works.
- Session-only cookie preferences (`network.cookie.lifetimePolicy`, sanitize-on-shutdown) do not block service-worker registration.

FetchX therefore keeps workflow cookies itself (`src/camoufox-cookies.mjs`). Before navigation, saved cookies are replayed into the private jar through a locally fulfilled `https://<reviewed host>/__fetchx_state` response carrying their `Set-Cookie` lines (attributes, HttpOnly and expiry preserved); this never reaches the source or consumes request budget. During the run, `Set-Cookie` headers from reviewed-host responses are recorded with full attributes. Script cookies are reconciled from `document.cookie` of reviewed frames at the end; their attributes are unknown, so they are saved host-only with path `/`. Cookies for hosts outside the profile are neither recorded nor replayed. If a later Camoufox release fixes the Juggler cookie APIs, this layer can be dropped. Do not lift these controls by disabling private browsing, sandbox or destination restrictions.

## Configuration and compatibility

Generated configurations select the intended Camoufox default and leave it uninstalled/unqualified:

```json
{
  "browser": {
    "maxConcurrent": 1,
    "defaultEngine": "camoufox",
    "camoufox": {
      "free": {
        "executablePath": "",
        "sha256": "",
        "version": "158.0.1-beta.41",
        "modelDir": "",
        "qualified": false
      }
    }
  }
}
```

The candidate verifier requires absolute executable/model paths, the exact executable SHA-256, matching installed `version.json`, the paired version and all pinned model members, including decompressed `values.dat`. These build checks are necessary and do not establish runtime qualification. Browser/model downloads and external GeoIP discovery are not performed during a gateway request. Camoufox has only free proxy routes in this integration; the legacy paid browser tier returns `browser_tier_unsupported`. No paid Camoufox license/product claim is made.

Future provisioning must install the complete exact official distribution outside the gateway worker, verify its release asset digest, preinstall the pinned model, and retain a private receipt. For Linux, `version.json` belongs beside `camoufox-bin`; for the official macOS app it belongs in the directory containing `Camoufox.app`. The metadata names `version: "158.0.1"` and `release: "beta.41"`; the official Linux zip does not contain it (the launcher writes it at install), so manual provisioning must write it. The Linux x86_64 zip used in testing had SHA-256 `3f2eb1d0451fa58e45e43e55f5e6181565069791ae60c0574f0ceb1f01341c33`; confirm it against the release asset digest before production use. Nothing should be enabled by a latest/unpinned automatic download.

Profiles specify a reviewed locale and IANA timezone; a country cannot determine an exact timezone. The generated example explicitly uses `en-US` and `UTC` as synthetic settings. `browserActionDelayMs` accepts integers 0–1000 (default 150ms). Existing element readiness waits exit when controls become actionable, within `browserWaitMs` and the overall child deadline (60 seconds, or 180 seconds for reviewed CAPTCHA profiles).

The existing compose mount exposes `${FETCHX_HOME}/browser` read-only at `/opt/gateway-browser`, sufficient for a full binary distribution and preinstalled model. Files must be readable/traversable by UID 10001 and binaries executable. The image installs Firefox and Chromium OS dependencies. Seccomp, sandbox, privilege, process, memory and tmpfs restrictions remain intact. The actual-engine tests and a two-request worker round trip (login cookie and localStorage restored on the second request) pass on Linux against the complete official distribution.

## Intended controls and diagnostic evidence

The browser worker retains reviewed recipes, source header scoping, encrypted cookie/localStorage state, sticky residential sessions, bounded child lifecycle, CAPTCHA handling, extraction bounds and no replay after stateful actions. Responses add safe `browser_engine` metadata. Status distinguishes configured from qualified and reports the Camoufox qualification reason. HTTP success remains separate from extraction and application acceptance.

The candidate options disable external GeoIP, WebRTC, direct proxy failover, DNS prefetch/DoH, HTTP/3, updates and telemetry. `canvas_noise: true` avoids a separate unproxied GPU probe; it can affect source compatibility. UBO is excluded. Request routing retains host/path/public-IP/method/body/count checks, source headers remain origin scoped, and the CONNECT relay separately bounds destinations/bytes.

HTTP redirects are disabled with native `network.http.redirection-limit: 0`, because Juggler does not reliably intercept redirected requests. The actual candidate test proves same-host disallowed-path and cross-host redirects never reach their targets. The worker maps native `NS_ERROR_REDIRECT_LOOP` to actionable `browser_redirect_blocked`, with no retry or engine/provider change. This guard is necessary and does not lift the overall qualification gate.

WebSocket routing is invoked and closed without upstream traffic. In the pinned Firefox diagnostic a blocked socket can remain `CONNECTING` without a close/error event; source waits remain bounded by page/child deadlines. No caller download is accepted.

Run tests serially with a disposable database and compatible local binaries:

```sh
BROWSER_TEST_EXECUTABLE=/absolute/compatible/chromium \
CAMOUFOX_TEST_EXECUTABLE=/absolute/paired/camoufox \
CAMOUFOX_TEST_MODEL=/absolute/preinstalled/fpgen \
CAMOUFOX_TEST_SHA256=<installed-executable-sha256> \
TEST_DATABASE_URL=postgresql:///gateway_test_disposable \
npm test
```

`test/camoufox.test.mjs` verifies qualification admission, defaults/legacy interpretation, build/model rejection, route admission, engine-aware status and cookie replay encoding. Optional actual-engine tests launch through the production launcher and demonstrate fill/select/click/wait/extract/screenshot, locale/timezone, routing/header/socket restrictions, redirect containment, absence of the service-worker API, and HTTP-only, script and localStorage continuity across contexts. A normal-mode positive control shows a registered worker's traffic bypassing routing. Passing diagnostics do not replace per-site source acceptance.

The macOS diagnostic used selective extraction of the exact official archive, omitting bundled fonts and UBO with local host fonts. Retained members passed ZIP CRC checks and have private hashes; the full archive SHA-256 was not verified. It must not be promoted as the complete production distribution. Full-font parity and live source acceptance remain to be completed per deployment. Never commit binaries, model files, credentials, source captures or private receipts.

Primary references: [official TypeScript launcher](https://github.com/daijro/camoufox/blob/main/typescript/README.md), [pinned launcher](https://www.npmjs.com/package/camoufox/v/0.5.9), [paired browser release](https://github.com/daijro/camoufox/releases/tag/v158.0.1-beta.41), and [pinned fingerprint generator](https://www.npmjs.com/package/fpgen-js/v/1.3.0).
