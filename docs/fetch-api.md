# One-call HTTP fetch API

`POST /v2/fetch` fetches one URL through an explicitly selected proxy class and
country using an approved access profile. It is a native HTTP facade over the
existing v2 session/operation APIs. It follows a one-call request/response model;
it is not a drop-in Firecrawl or Scrape.do protocol implementation.

Every endpoint requires `Authorization: Bearer <project-token>`. Project tokens,
profiles, sessions, idempotency keys and artifacts remain isolated by project.
Use authenticated TLS or a private listener.

## Request

```sh
curl "$FETCHX_URL/v2/fetch" \
  -H "Authorization: Bearer $FETCHX_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "idempotency_key": "source-us-dc-001",
    "access_profile": {"id": "source.http", "version": 1},
    "url": "https://source.example/data",
    "proxy": {"class": "datacenter", "country": "US"}
  }'
```

The example profile and destination must first be reviewed and configured by the
server operator. This API never creates a discovery profile, widens approved
hosts, or grants source access automatically. Read `GET /v2/access-profiles` for
the project's approved profiles, route reservations and limits.

| Field | Contract |
| --- | --- |
| `idempotency_key` | Required, 1–160 letters, digits, `_`, `.`, `:` or `-`. |
| `access_profile` | Required exact `{id, version}` reference to an approved profile. |
| `url` | Required HTTPS URL within that profile's origins and paths. |
| `proxy` | Required exact `{class, country}` object. No class or country default. |
| `proxy.class` | `direct`, `datacenter` or `residential`, explicitly approved by the profile. |
| `proxy.country` | Explicit uppercase two-letter approved country for proxies; explicitly `null` for direct. A direct request does not verify its source country. |
| `session_id` | Optional owned v2 HTTP session UUID for cookie continuity. Its profile, class, country and provider remain pinned. |
| `method` | Optional, defaults to `GET`; the profile must approve it. |
| `headers` | Optional object, defaults to `{}`. Existing header/credential restrictions apply. |
| `body_base64` | Optional canonical base64 body. Body size and method restrictions apply; GET/HEAD cannot carry a body. |
| `max_estimated_micro_usd` | Optional nonnegative integer ceiling on the conservative reservation estimate. An unavailable estimate fails closed. |
| `retry` | Optional boolean, defaults to `false`. `true` permits at most one extra known-safe attempt for an eligible fresh HTTP read; see [bounded retries](#bounded-retries). Other types are rejected. |

Affinity is always `session`. Without `session_id`, a deterministic internal
session is allocated for this key. Session allocation grants no quota, bandwidth
or spending allowance; operation admission applies the existing reservations.

Datacenter routing uses the configured country pool (Oxylabs in the intended
deployment). The returned provider label is `configured_datacenter`, because a
proxy ID alone does not prove its vendor. Residential selection chooses Evomi
first, then DataImpulse when Evomi is not configured/available for that country at
session creation. It never changes an existing session's pinned provider, class
or country. Explicit bounded retries can select another verified member of the
same fixed-fee datacenter pool before session state is established.

This endpoint supports HTTP only. `render`, `browser`, `formats`, browser actions,
scripts, extraction options and other unsupported browser/render parameters return
`capability_unsupported` before dispatch. Unknown parameters are rejected.
Reviewed v1 rendered recipes remain separate. V2 browser probes remain disabled;
this endpoint does not enable them. The intended new Camoufox engine is currently
blocked from service execution by a [runtime qualification gate](browser-engines.md).

## Response and status

A successful native HTTP response has this shape; IDs and hashes below are
illustrative:

```json
{
  "success": true,
  "state": "completed",
  "gateway_http_status": 200,
  "operation_id": "00000000-0000-4000-8000-000000000001",
  "session_id": "00000000-0000-4000-8000-000000000002",
  "idempotency_key": "source-us-dc-001",
  "idempotency_key_scope": "caller",
  "routing": {"class": "datacenter", "country": "US", "provider": "configured_datacenter"},
  "data": {
    "status": 200,
    "final_url": "https://source.example/data",
    "content_type": "text/plain; charset=utf-8",
    "body_base64": "b2s=",
    "text": "ok",
    "retry_after": null
  },
  "artifacts": [],
  "diagnostics": {"stage": "completed", "failure": null, "dns": []},
  "error": null,
  "retry": {
    "safe_to_retry": false,
    "same_key_replay_safe": true,
    "new_request_allowed": false,
    "next_action": "complete",
    "lookup_url": "/v2/fetch/source-us-dc-001"
  },
  "usage": {
    "accounting": {
      "provider": "configured_datacenter",
      "reserved_tunnel_bytes": 8192,
      "observed_tunnel_bytes": 500,
      "estimated_micro_usd": null,
      "invoice_micro_usd": null,
      "basis": "conservative_bandwidth_reservation_not_invoice"
    },
    "native_requests": 1,
    "dns_requests": 0,
    "encoded_bytes": 2,
    "decoded_bytes": 2,
    "tunnel_bytes": 500,
    "dns_encoded_bytes": null,
    "dns_decoded_bytes": null,
    "dns_tunnel_bytes": null,
    "byte_basis": "encoded_and_decoded_are_native_response_bytes; tunnel_includes_native_and_session_proxy_dns; separate_dns_bytes_unavailable"
  },
  "application_acceptance": "not_evaluated"
}
```

Actual `artifacts` include each retained artifact ID, kind, native status,
`encoded_sha256`, `decoded_sha256`, original/decoded sizes, content encoding and
decoding error. `GET /v2/artifacts/:id` returns the original encrypted-at-rest
capture's encoded and decoded base64 bodies to its owning project. The facade's
`data.body_base64` is the final **decoded** native body, or `null` when unavailable.
It does not replace the original encoded evidence. `text` is populated only for
recognized textual MIME types with supported UTF-8/ASCII charset declarations and
valid UTF-8; binary or undecodable bodies remain base64.

`gateway_http_status` matches the gateway response status. Once an operation is
available, the facade returns HTTP 200 and places the independent source HTTP
status in `data.status`. Thus a completed operation can have `success: false`,
`state: "completed"`, `data.status: 403` and `error.code: "source_forbidden"`.
`success` requires a completed operation, a native 2xx status, and no recognized
HTML challenge or gateway error. HTTP 200 challenge pages are not reported as
successful merely because their transport completed. Detection reuses FetchX's
bounded known-marker classifier; it does not establish generic page semantics,
extraction accuracy or application acceptance.

Admission failures use their relevant gateway HTTP status (400/401/403/409/429,
etc.) and a structured envelope with `state: "rejected"`. Unclassified errors that
may occur after source dispatch report `state: "unknown"` and recovery guidance;
they never claim that the source was untouched. Errors contain stable codes,
reviewed messages and a stage, not raw exception strings. `diagnostics` preserves
the native safe diagnostics, including failure stage, reviewed cause code,
`request_dispatched` and DNS resolver provenance when retained.

For newly retained non-200 proxy CONNECT failures, safe diagnostics also preserve
the remote `provider_status`, CONNECT `failure_code` and explicit proxy dispatch
phase. During supporting DNS, `error.stage` remains `dns` and
`diagnostics.failure.dns.attempts` identifies the approved resolver; native
`data.status` remains null when no source response exists. An optional
`provider_reason` contains only a reviewed standardized Squid token, never raw
headers, bodies or provider explanations. A proxy HTTP 403 alone does not prove
an ACL, allowlist, geographic or source denial. Unknown operations keep their
reservation and recovery guidance; this evidence does not authorize a retry.

Native response byte counts and DNS request counts remain separate by default.
For retry-eligible operations, `encoded_bytes` also includes metered supporting
session-proxy DNS response bytes within the shared reservation; `decoded_bytes`
still measures native response bodies. `byte_basis` identifies this difference.
Aggregate `tunnel_bytes` includes native and any session-proxy DNS traffic.
Separate DNS byte counts are not retained by the native operation, so the facade
reports those fields as `null`. Partial/interrupted observations remain unknown rather than
being converted to zero. Reservation estimates and observed bytes are not provider
invoices; missing invoice values stay `null`, and uncertain-charge holds survive
replay and recovery.

### Residential traffic charges

For new Evomi and DataImpulse requests, read
`usage.accounting.customer_traffic.cost_usd` for the customer charge. FetchX
charges **$2 per 1,000,000,000 proxy bytes**. For example, a request that
transfers 2,000,000 bytes returns this value in `usage.accounting.customer_traffic`:

```json
{
  "currency": "USD",
  "rate_usd_per_gb": 2,
  "bytes_per_gb": 1000000000,
  "basis": "bidirectional_proxy_bytes",
  "status": "measured",
  "metered_bytes": 2000000,
  "billable_bytes": 2000000,
  "cost_usd": "0.004000000"
}
```

The meter includes uploads, downloads, the proxy connection, and any redirects
and DNS lookups sent through that proxy for the operation. Read `billable_bytes`
for the amount priced. It is capped at the reserved byte allowance. A rejected
or blocked page can still consume measurable traffic. `cost_usd` is an exact
decimal string, so even one byte has a representable price. `no_traffic` has
zero cost. `pending` and `unknown` have a null cost.

Before dispatch, read `customer_traffic_reservation.max_cost_usd` on the
profile's residential route for the maximum customer charge. A supplied
`max_estimated_micro_usd` must cover both the customer and provider estimates.
The operation also returns the reservation under `usage.accounting`.
Use the saved charge once per operation ID. Looking it up or replaying its key
returns the same charge. Older operations retain their original response fields.

For an operator-attested prepaid Oxylabs pool, new matching HTTP requests may
return `accounting.estimated_micro_usd:0` with
`accounting.pricing.basis:"operator_attested_prepaid_included_traffic"`,
`cost_scope:"incremental_traffic_only"` and
`customer_traffic_charge_micro_usd:0`. This is the customer's traffic charge for
the approved operation. Fixed subscription allocation and provider invoice
remain `null`; platform/model costs are outside this traffic policy.
The safe pricing metadata includes the attestation ID, validity times and status.
Read authenticated profile `route_reservations` for the current quote.

The operator grant binds the exact project, profile version, HTTP transport and
entire configured country pool. Missing, expired, ambiguous or mismatched grants
leave the estimate unavailable and never imply a customer zero. A grant too near
expiry reports `pricing.reason:"insufficient_validity"`; it must cover the full
profile timeout. A supplied ceiling fails with `cost_estimate_unavailable`
before DNS/source dispatch or native operation/ledger insertion. Existing tunnel
reservations still cover redirects and supporting proxied DNS. Callers cannot
override the policy or enable browser traffic with it.

Pricing decisions are saved only for new operations. Replays after expiry return
the saved decision without new source work; older accounting and invoices are
never recomputed. Operator schema and binding details are documented in
[API v2](api-v2.md#included-datacenter-traffic-pricing).

## Durable recovery and deliberate retries

`GET /v2/fetch/:idempotency_key` reconstructs the envelope from the saved operation,
session and artifacts. It performs no DNS lookup, route selection or source
request. An exact repeat of `POST /v2/fetch` returns the existing operation (which
may still be running). Concurrent exact POSTs cannot duplicate source work. A
changed URL, body, headers, method, profile, route, country, supplied session,
cost ceiling or enabled retry policy under a bound key returns HTTP 409
`idempotency_conflict`. `retry: false` and omission are equivalent, including for
keys bound before the flag existed. Changing either to `true` requires a new key.

The canonical request fingerprint uses a dedicated immutable registry namespace;
its registry key and value are hashes, with no plaintext source URL, headers,
body or session secrets. Source request inputs and captures retain the native
encrypted storage. A pre-dispatch admission failure may be reconsidered with
the exact same input after quota/configuration is fixed; it is not a new allowance.

`retry.same_key_replay_safe` means exact unchanged replay/recovery preserves
idempotency. `retry.safe_to_retry` and `retry.new_request_allowed` describe whether
the returned guidance permits a **deliberate new source attempt now**, subject to
all existing approvals and budgets. They never authorize automatic fallback.

| Outcome | Guidance |
| --- | --- |
| Datacenter GET returns 403 or a recognized challenge | If the saved profile also approves residential in the same country, suggest that route with a **new key and fresh session**. No suggested request is dispatched. |
| Other 403/challenge | Review source access; no implicit escalation. |
| 429 or source cooldown | Wait for source `Retry-After`; do not rotate providers or countries. |
| 404 | Check the URL before considering another request. |
| Permission, profile or route configuration failure | Fix the approved request/configuration. |
| Quota or budget exhausted | Review the quota/budget; creating sessions does not bypass it. |
| Active, unknown, incomplete, interrupted or failed non-GET work | Recover first. No new source replay is suggested. |

To deliberately try approved residential after a known datacenter GET 403, submit
the original URL with a **new** key, `proxy: {"class":"residential","country":"US"}`
and **omit** `session_id`. A provided session cannot change profile, class or
country. Reusing the original key only returns its original 403; it does not retry
through the new route.

## Bounded retries

For a low-level cacheable GET or HEAD read, add `"retry": true` to the request.
Either omit `session_id` to create a session or pass an unused HTTP session
with the same profile and route. The caller still
receives one response for one durable operation. FetchX may make **one extra
attempt**, using a distinct dedicated IP and endpoint in the same reviewed
fixed-fee datacenter pool, country and proxy class. It never escalates to
residential or changes countries. Existing profile, source, pacing, quota,
deadline, byte and cost controls apply to both attempts together.

```json
{
  "idempotency_key": "source-us-dc-retry-001",
  "access_profile": {"id": "source.http", "version": 1},
  "url": "https://source.example/data",
  "proxy": {"class": "datacenter", "country": "US"},
  "retry": true
}
```

The operator must have a valid fixed-fee Oxylabs pool policy and reviewed
dedicated-IP inventory with a distinct eligible member. A proxy ID, different
password or random session suffix does not establish a different physical IP.
No second attempt runs when that evidence or an allowance is unavailable.

Eligible failures are an explicitly proven proxy TCP refusal before any proxy
request, an explicit proxy CONNECT 502/503/504 rejection, or a complete native
502/503/504 response without cookies, `Retry-After`, a redirect or a recognized
challenge. Source 403, 404, 429 and challenges do not trigger rotation. Neither
do uncertain transport results, incomplete captures, decoding failures, account
rejections or policy errors. State-changing methods, source credentials,
recipes and sessions with prior work or cookies are ineligible and execute at
most the normal single attempt. Browser traffic is unsupported by this endpoint.

Use the returned `session_id` for a later cookie or stateful follow-up. The
effective route stays pinned to that session after the initial read. Do not add
your own loop, switch providers, or replay a stateful follow-up after uncertainty;
recover the saved operation using the same key or its lookup URL.

`retry` in the response remains the existing advice object. An opted-in operation
adds `requested`, the `attempts` count, `route_changed`, `effective_session_id`
and `stop_reason`. `diagnostics.attempts` retains each attempt's `provider_status`
and `source_status`. A null `source_status` means no target response was recorded
for that attempt. It also records the stage, safe failure evidence, error code,
request and DNS counts, and measured bytes, including a
failed first attempt when the second succeeds. No upstream proxy address,
credentials, private proxy ID or physical IP is returned. For example:

```json
{
  "retry": {
    "safe_to_retry": false,
    "same_key_replay_safe": true,
    "new_request_allowed": false,
    "next_action": "complete",
    "lookup_url": "/v2/fetch/source-us-dc-retry-001",
    "requested": true,
    "attempts": 2,
    "route_changed": true,
    "effective_session_id": "00000000-0000-4000-8000-000000000002",
    "stop_reason": null
  }
}
```

`stop_reason` explains why another attempt did not run: `retry_ineligible`,
`retry_route_unavailable`, `retry_not_transient`, `retry_limit`, `retry_deadline`,
`retry_request_limit` or `retry_byte_limit`, or the specific admission/policy
code. The final source response remains in `data`; retained response artifacts
include both native responses when both were received. `usage` and
`usage.accounting` total the entire operation, including failed-attempt traffic
and conservative reservations. A zero included traffic estimate is not a known
provider invoice. Replay and GET recovery preserve the attempts and accounting
without new source work. Older and non-opted-in operations retain their existing
response shape.

## Project-owned native operation projection

`GET /v2/fetch/operations/:operation_id` reads any project-owned v2 **HTTP**
operation through this response format, including operations created before this
facade existed. It does not start or resume work. Browser-probe operations return
`capability_unsupported`; browser evidence retains its separate API.

For a native operation, `idempotency_key` is its stored native key and
`idempotency_key_scope` is `native_operation`. For facade operations addressed only
by operation ID, the durable registry intentionally does not retain the caller key
in plaintext: `idempotency_key` is `null`, `idempotency_key_scope` is
`internal_operation`, and `internal_idempotency_key` identifies the hashed native
key. It is never presented as the original caller key. The returned recovery URL
uses the operation-ID route, and `same_key_replay_safe` is `false` for these
projections: a native key is not a facade POST binding, and an internal key is not
the caller key. Recover using the read-only URL. Canonical facade POST and key lookup responses
retain the actual supplied caller key and scope `caller`.

Existing v1 and native [v2 APIs](api-v2.md) remain compatible.
