# FetchX v2 Render API

`POST /v2/render` opens a dedicated browser session for one GET navigation to
an approved HTTPS destination. The endpoint requires a project Bearer token
with `fetch:write` for managed keys. Use `GET /v2/render/:key` with `fetch:read`
to retrieve the operation by the original, URL-encoded key. A project can read
its own retained artifacts through `GET /v2/artifacts/:id` with `fetch:read`.
Check `features.browser_render` in `GET /v2/capabilities` with
`profiles:read` before submitting. Each request still requires an approved
destination, route, qualified browser runtime and sufficient allowance.

## Prepare a managed render

Send `POST /v2/render/prepare` with the project's Bearer key (`fetch:write`)
and a JSON body containing the target URL and proxy:

```json
{
  "url": "https://example.com/",
  "proxy": {"class": "direct", "country": null}
}
```

Preparation checks the same policy as the signed-in Playground. It does not
resolve or contact the source, reserve credits, or create a profile record.
The response includes `ready`, `execution`, `url`, `access_profile`, `quote`,
and `errors`. If `ready` is false, inspect `errors` before proceeding. If it
is true, use the returned URL and access profile, the same proxy, and a new
idempotency key for `POST /v2/render`. The quote reflects current conditions.
Admission checks the destination, route and allowance again before dispatch.

## Submit and recover

```json
{
  "idempotency_key": "caller-generated-operation-key",
  "access_profile": {"id": "example-browser-profile", "version": 1},
  "url": "https://example.com/",
  "proxy": {"class": "direct", "country": null},
  "max_estimated_micro_usd": 0,
  "screenshot": true,
  "wait_ms": 500
}
```

An access profile must explicitly permit browser execution. Managed project keys
use a reference returned by preparation with a reviewed browser credit weight for
the route. An HTTP profile such as `public-url-http` cannot be used to render.
Profile-related render errors can include `diagnostics.requested_execution` and,
for profiles visible to the project, `profile_kind` and `approved_executions`.
Native browser probes require a provisioned credential with the applicable
profile and runtime policy.
Use `direct` with `country: null`, or an approved `datacenter` or `residential`
route with an uppercase country code. The optional `wait_ms` is an integer from
zero through the profile's wait ceiling (`max_wait_ms`), at most 15,000
milliseconds. Render preparation returns the ceiling as `execution.max_wait_ms`
and the default as `execution.default_wait_ms`; read them instead of guessing.
Managed (Playground) render allows up to 10,000 ms. Omission uses the profile
default. `screenshot` defaults to `false` and captures
a bounded 1 MiB viewport JPEG when enabled. The optional spending ceiling
covers both the provider estimate and the maximum customer traffic reservation.

Store the key before sending the request. A replay with identical inputs returns
the retained operation, which can still be running. Changed inputs for a bound
key return `409 idempotency_conflict`. An interrupted operation with uncertain
dispatch remains recoverable and retains its reservation. Neither recovery nor
replay dispatches source work for an existing operation. Each admitted browser
operation keeps the same proxy class, country and provider throughout the render.

The response follows the public fetch envelope with `execution: "browser"`.
`data.status` is the main document's source HTTP status, independent of
`gateway_http_status`. `data.text` and `data.body_base64` contain the retained
UTF-8 generated DOM when available. `data.headers` is the allowlisted main
document response metadata, with cookies, authorization, proxy and private
headers excluded. `artifacts` lists the retained browser responses and generated
DOM. When retained, the generated `browser_screenshot` entry also includes
`content_type: "image/jpeg"` and `body_base64`. Treat returned HTML as inert text.

`usage` records browser requests, blocked requests and their reasons
(`blocked_reasons`), the number of other public origins that served
subresources (`subresource_origins`), bytes, duration and accounting as
available. `browser` names the engine and version that rendered the page. For
managed keys, `usage.accounting.request_credits` shows the original attribution
and reservation state. The result always reports
`application_acceptance: "not_evaluated"`.

### What a rendered page may load

A browser profile decides how much of the page's own traffic is admitted:

- `subresources`: `same_origin` (default for operator profiles) or `public`.
  With `public`, the page's scripts, stylesheets, images, fonts and fetch/XHR
  requests to other origins load when the origin is public HTTPS on port 443
  and every DNS answer is a public address. Subresource redirects may cross
  origins; each hop is admitted the same way. Site-set API headers (for example
  `x-api-key`) are allowed; proxy credentials, gateway headers and FetchX keys
  are always blocked.
- `frames`: child frames (challenge widgets, embedded content) and their
  requests load under the same rules.
- `page_post`: the page's own XHR/fetch POST requests (body up to 64 KiB) are
  admitted, for search and GraphQL data calls. Render callers still cannot send
  a body or headers themselves.

Managed (Playground) render enables all three. Every admitted request counts
against the same request, byte, provider-rule and cooldown limits. The main
navigation stays on the prepared origin. Cookies from all origins work during
the render; only the prepared origin's cookies are kept on the session.
Popups, downloads, WebSockets and workers stay blocked.

### Challenges, rate limits and cooldowns

A request that FetchX does not escalate on its own gets the source's outcome
back clearly, so the caller can decide what to do next. (Automatic escalation
across routes and engines is a separate, opt-in mode.)

A recognised bot-manager interstitial is `source_challenge` whatever its HTTP
status, including 200, 202, 403 and 429. `error.details.vendor` names the
vendor when it can be attributed (`datadome`, `cloudflare`, `aws_waf`, `human`,
`amazon`, otherwise `unknown`) and `error.details.http_status` keeps the source
status. On a datacenter or direct route, `retry.next_action` is
`consider_residential_new_request` with a `suggested_proxy`: prepare again for
that route, then send a new request with a new idempotency key after any
`retry_after`. A plain 429 stays `source_rate_limited`.

A 429 puts the source origin on a cooldown shared by all callers: the
`Retry-After` value when present, otherwise 60 seconds, or 15 seconds when the
429 body is a challenge page. While it lasts, requests fail with
`source_cooldown`, and `error.details` carries `scope: "origin"`, `origin`,
`cooldown_until` and `retry_after_seconds` (also in `retry.retry_after`). Wait
until then; repeating the request earlier only fails again.

Datacenter estimates for browser traffic require explicit operator review. A
scoped `datacenterPricingAttestations` entry uses `schema_version: 2` and
`transport: "browser"`. A service-wide `datacenterFixedFeePool` uses
`schema_version: 2` and an explicit `transports` list containing `"browser"`.
Include `"http"` in that list to cover native HTTP as well. Version 1 pricing
remains HTTP-scoped. Managed browser credits require reviewed browser mode
weights in addition to available route pricing.

## Optional capacity queue

An enabled [browser admission queue](hetzner-autoscaling.md) waits for a qualified worker before source dispatch or credit reservation. Queue wait is bounded separately from browser execution. On queue-full, timeout or pre-dispatch cancellation, repeat the exact request with its original idempotency key. Running or uncertain source work is never redispatched automatically.
