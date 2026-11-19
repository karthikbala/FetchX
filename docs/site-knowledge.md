# Site knowledge

FetchX learns, for each destination host, which route has reached it: execution
(`http` or `browser`), proxy class, provider and country. Auto
mode reads this to start its ladder at the route known to work, skip routes that
are resting, and pick the exit country, instead of rediscovering them.

## What is stored

One row per host and route in `site_routes`: success and failure counts,
consecutive failures, last success and failure times, a `retry_not_before`
cooldown, and the average credits of successful requests.

Only the host name is stored. URLs, paths, queries, headers, cookies, bodies,
credentials and the requesting project are never stored. Because a row is
routing metadata only, knowledge is shared across all projects: one customer's
success teaches the route for everyone.

## Where it learns from

- Every attempt of every request (`FetchService.#learn`), as soon as it has a result. An attempt that ended without an answer because the request's own `timeout_ms` ran out (a slow captcha solve, say) is not recorded: it says nothing about the route.
- Completed admin reachability probes (`http` routes only).

Recording runs with short lock and statement timeouts, and a failure to record
is logged and ignored; it never delays or fails a request.

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

The admin portal's Site knowledge tab shows the same.

## How auto mode uses it

`planLadder` in `src/fetch/ladder.mjs` builds the steps a request may use, in this order: HTTP direct, HTTP datacenter, HTTP residential (plus two fresh-IP rotations used only after a 429), browser residential, browser residential on a fresh IP, browser datacenter. Then:

- A **proven** step moves to the front, keeping the cheapest proven first.
- A **cooling** step is skipped and listed in `skipped` with `cooling`, except that a residential step cooling only because of a rate limit stays (a fresh IP gets a fresh limit).
- The **country** is the request's `country`, else the country of the host's proven routes, else US.
- Steps excluded by a provider rule, over `max_credits`, or not allowed by `render` are skipped and listed.

If every step is cooling, the request fails with `cooling_down` and the remaining wait, without sending anything.
