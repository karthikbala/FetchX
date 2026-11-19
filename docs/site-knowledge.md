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
