# Reviewed browser engines

New `residential-v1` workflows with `execution: "browser"` snapshot the intended default `browserEngine: "camoufox"`, unless a reviewed profile or `browser.defaultEngine` explicitly selects `"cloakbrowser"`. Existing persisted workflows without an engine retain the legacy CloakBrowser interpretation. Configuration files and stored sessions are not rewritten. Native HTTP remains available for known APIs; the v2 browser probe remains disabled.

**Camoufox execution is currently unavailable.** This release returns `browser_runtime_unqualified` before source/provider work, even when configuration says `qualified: true`. The pinned build did not demonstrate the required combination of request interception, native service-worker exclusion and durable cookie continuity. Direct HTTP and an explicitly configured, qualified legacy CloakBrowser runtime remain separate available routes. The gateway never switches engine automatically.

## Pinned candidate and qualification blocker

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

No current configuration flag overrides this service-level gate. A future enabling change requires a demonstrated native policy that preserves routing and cookie/localStorage restoration in the intended service environment. Do not promote this candidate by changing `qualified` or by disabling sandbox/destination controls.

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

Future provisioning must install the complete exact official distribution outside the gateway worker, verify its release asset digest, preinstall the pinned model, and retain a private receipt. For Linux, `version.json` belongs beside `camoufox-bin`; for the official macOS app it belongs in the directory containing `Camoufox.app`. The metadata names `version: "158.0.1"` and `release: "beta.41"`. Nothing should be enabled by a latest/unpinned automatic download.

Profiles specify a reviewed locale and IANA timezone; a country cannot determine an exact timezone. The generated example explicitly uses `en-US` and `UTC` as synthetic settings. `browserActionDelayMs` accepts integers 0–1000 (default 150ms). Existing element readiness waits exit when controls become actionable, within `browserWaitMs` and the overall child deadline (60 seconds, or 180 seconds for reviewed CAPTCHA profiles).

The existing compose mount exposes `${FETCHX_HOME}/browser` read-only at `/opt/gateway-browser`, sufficient for a full binary distribution and preinstalled model. Files must be readable/traversable by UID 10001 and binaries executable. The image installs Firefox and Chromium OS dependencies. Seccomp, sandbox, privilege, process, memory and tmpfs restrictions remain intact. Linux/container qualification is unperformed and separate from macOS diagnostics.

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

`test/camoufox.test.mjs` verifies the hard gate, defaults/legacy interpretation, build/model rejection, route admission and engine-aware status. Optional actual-engine tests use the official launcher directly in a synthetic diagnostic context, never a production bypass flag. They demonstrate fill/select/click/wait/extract/screenshot, locale/timezone, routing/header/socket restrictions, normal-mode script and HTTP-only cookie plus localStorage restoration, redirect containment, and the native service-worker positive control that prevents qualification. Passing diagnostics do not mean Camoufox production acceptance passed.

The macOS diagnostic used selective extraction of the exact official archive, omitting bundled fonts and UBO with local host fonts. Retained members passed ZIP CRC checks and have private hashes; the full archive SHA-256 was not verified. It must not be promoted as the complete production distribution. Full-font parity, Linux/container operation, live source acceptance and the native service-worker/cookie conflict remain unresolved. Never commit binaries, model files, credentials, source captures or private receipts.

Primary references: [official TypeScript launcher](https://github.com/daijro/camoufox/blob/main/typescript/README.md), [pinned launcher](https://www.npmjs.com/package/camoufox/v/0.5.9), [paired browser release](https://github.com/daijro/camoufox/releases/tag/v158.0.1-beta.41), and [pinned fingerprint generator](https://www.npmjs.com/package/fpgen-js/v/1.3.0).
