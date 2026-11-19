# Site knowledge

FetchX learns, for each destination host, which route has reached it: execution
(`http` or `browser`), proxy class, provider, country and browser engine, plus
what a success cost. Auto mode (next phase) reads this to start its escalation
ladder at the cheapest route known to work, instead of rediscovering it.

This first phase only observes. It never dispatches a request, changes a route,
or touches billing.

## What is stored

One row per host and route in `site_routes`: success and failure counts,
consecutive failures, last success and failure times, a `retry_not_before`
cooldown, and the average credits of successful requests.

Only the host name is stored. URLs, paths, queries, headers, cookies, bodies,
credentials and the requesting project are never stored. Because a row is
routing metadata only, knowledge is shared across all projects: one customer's
success teaches the route for everyone.

## Where it learns from

- Settled v2 HTTP operations and v2 browser operations.
- v1 workflow attempts on main documents (datacenter and residential routes).
- Completed admin reachability probes (`http` routes only).

Recording runs after settlement, with short lock and statement timeouts, and a
failure to record is logged and ignored.

## How outcomes are classified

| Outcome | Meaning | Effect |
|---|---|---|
| success | 2xx/3xx, no challenge page | resets failures, records cost |
| blocked | 401/403 or a challenge page (even with HTTP 200) | counts a failure |
| unreachable | source timeout, connect, TLS or DNS failure | counts a failure |
| rate_limited | 429 or a rate-limit error | sets a cooldown from Retry-After (15 s to 1 h), never counts as a failure |

Uncertain results, customer input errors, quota refusals, provider and proxy
faults, FetchX internal errors, and 404/5xx responses teach nothing.

## Route states

- **proven**: succeeded within the last 7 days and has fewer than 2 consecutive failures.
- **cooling**: `retry_not_before` is in the future. Two consecutive blocks cool a
  route for 24 hours, and two consecutive unreachable results cool it for 1 hour.
- **stale**: worked before, but more than 7 days ago.
- **failing**: recent failures below the threshold, or never succeeded.

Tunable with `siteKnowledge` in config: `freshMs`, `demoteAfter`,
`blockedRetryMs` and `unreachableRetryMs`.

## Admin API (operators only)

- `GET /control/admin/sites` returns the most recently updated hosts with route state counts.
- `GET /control/admin/sites/:host` returns every known route for a host.
- `DELETE /control/admin/sites/:host` forgets a host so it is relearned. This is
  written to the routing audit log as `site:<host>`.

## Auto mode (`POST /v2/fetch` with `proxy.class: "auto"`)

```json
{"idempotency_key": "k1", "url": "https://example.com/page", "proxy": {"class": "auto"}, "max_attempts": 5}
```

`proxy.country` is optional. `max_attempts` runs from 1 to 5 and defaults to 5.

- **Ladder, cheapest first:** HTTP direct, HTTP datacenter, HTTP residential,
  a rendered browser on residential, the same on a fresh residential session
  (a new IP), then a browser on datacenter. It is limited to what the access
  profile allows. Routes proven for the host (either transport) come first.
  Routes that are cooling, or excluded by a provider rule (such as Oxylabs for
  `.gov`), are skipped. A step the profile cannot use (for example, no browser)
  is refused at admission. It costs nothing and does not count as an attempt.
- **Each attempt** is an ordinary fetch or render under a derived key, so admission, cost
  ceilings, budgets and provider rules all apply. The route for each attempt is
  recorded before dispatch. A same-key replay or `GET /v2/fetch/:key` returns
  the same final attempt without new source work.
- **Stops** on success, a real 404, an uncertain result (never retried), a
  genuine rate limit (429 with Retry-After), or a caller limit (credits, quota,
  cost ceiling). A challenge page served with a 429 counts as a block and
  escalates. A short site cooldown (20 seconds or less) is waited out once
  inside the request.
- **Only GET and HEAD escalate.** Browser steps are GET only. Other methods
  make one attempt.
- **Fixing client mistakes:** an automation or missing User-Agent is replaced
  with a browser one (or removed if the profile does not allow the header), and
  missing `accept` and `accept-language` headers are added when allowed. All
  other headers are sent as given.
- **Billing:** only the successful attempt is billed. Failed attempts are released.

The response is the final attempt's normal response (render-shaped when the
final attempt was a browser) plus an `auto` object. It holds `attempts`, `max_attempts`, `routes_tried` (class, country and
result; never providers), `routes_skipped`, `billed_attempt`,
`headers_adjusted` and `next`. `next` is null on success, and otherwise one of:

- `{"action": "retry_after", "retry_after_seconds": N}` when the site is rate limiting.
- `{"action": "retry_later", "retry_after_seconds": N}` when every allowed route was blocked.
- `{"action": "recover"}` when the outcome is uncertain: look up the same key first.
- `{"action": "retry_later", "retry_after_seconds": N}` when the site was unreachable.

If every allowed route is cooling, the request is refused with no dispatch. It
returns HTTP 429 with `source_cooldown`, and `error.details.auto.next` gives
the wait.

Explicit routes (`direct`, `datacenter`, `residential`) never escalate. Their
error codes report exactly what happened, as before.

- **Residential providers:** after a residential attempt fails or is rate
  limited, the next residential attempt uses the other provider (Evomi and
  DataImpulse alternate), when it is enabled and allowed.
- **CAPTCHA:** browser steps in auto mode may solve one Turnstile or reCAPTCHA v2
  widget per attempt through 2captcha. See `docs/captcha.md`. Explicit
  `/v2/render` calls never solve.

The browser steps run on the v2 render pool's qualified engine (pinned Chromium
or keyless CloakBrowser, as configured), not Camoufox. Camoufox is used only in
v1 residential workflows. CloakBrowser as a separate last-resort step stays out
of auto mode until there is evidence of a challenge Camoufox cannot pass and
CloakBrowser can.
