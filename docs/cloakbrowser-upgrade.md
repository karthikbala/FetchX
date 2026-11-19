# CloakBrowser 0.7 in FetchX

The [CloakBrowser 0.7.0 wrapper](https://github.com/CloakHQ/CloakBrowser/blob/main/CHANGELOG.md#070--2026-11-01) requires a key for current builds. The vendor's email-issued free key gets the latest build and one concurrent session. This is separate from an expiring trial and from the old keyless Chromium 146 build. The wrapper now uses the browser's native headless geometry and adds maximized window behavior by default. Credentialed HTTP proxies move to Chromium's native proxy argument; FetchX continues to give the browser its private local relay, without credentials.

[Chromium 156.0.8078.47.1](https://github.com/CloakHQ/CloakBrowser/releases/tag/chromium-v156.0.8078.47.1-pro) is the November 3 stable release for Linux, macOS and Windows. It improves license retries and seat release, window geometry and fingerprint consistency, and keeps native popup blocking enabled. The viewport is shorter; recheck recipes and screenshot assumptions. Its SOCKS5 WebRTC improvement does not change FetchX's HTTP relay or WebRTC restrictions.

| FetchX configuration | Wrapper and entitlement |
| --- | --- |
| v1 `browser.free` with `entitlement: "unlicensed"` | `cloakbrowser-legacy` (0.6.5) for a pinned, installed keyless build. No key lookup at the vendor. |
| v1 `browser.free` with a licensed entitlement and explicit `licenseKey` | `cloakbrowser` (0.7.0). A valid current free key can use this route. |
| v1 `browser.paid` with explicit `licenseKey` | `cloakbrowser` (0.7.0). A current paid plan is still required for this route. |
| v2 browser probe and public Render | The existing qualified, unlicensed pinned runtime only, via 0.6.5. A licensed build does not satisfy this gate. |

For a reviewed v1 upgrade, provision the release for the gateway's platform in a separate operator step. Verify the vendor's signed archive manifest, then compute the SHA-256 of the **executable** for the private `browser.free` or `browser.paid` configuration. Set `version`, `executablePath`, `sha256` and the tier's `licenseKey` together. Use the explicit 0.7 package entry point (`node node_modules/cloakbrowser/dist/cli.js`) for any operator CLI use; the alias also exports a `cloakbrowser` command. Keep keys and browser distributions out of Git.

FetchX validates licensed tiers before source/provider work and checks the executable hash in the worker before launch. Missing explicit keys fail with `browser_entitlement_unavailable`. The worker uses only the configured executable and its per-capture cache; there is no runtime download, signup, update, or switch to a different binary. Chromium's sandbox remains on. Native license and session calls are configured to use the metered CONNECT relay with `--license-route=proxy` (with the older alias for pinned builds). The separate gateway entitlement validation uses the fixed vendor HTTPS endpoint and refuses redirects.

Installing the wrapper does not install or qualify Chromium 156. Before selecting a new binary for traffic, verify startup, clean shutdown, metered relay egress and source acceptance in the intended service environment. Keep the previous reviewed pin available for a deliberate rollback. Existing route order, v2 qualification evidence and source permissions are unchanged by the wrapper update.

On macOS, the licensed v1 launcher uses the native macOS fingerprint. With Chromium 156, forcing the Linux fingerprint on macOS rendered default text at zero height and caused visible-element waits to time out.
