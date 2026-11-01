# FetchX v2 qualified browser network probe

This is a bounded navigation/network-observation operation, not a live browser
lease or an automatic fallback. Runtime and profile approval are independent.
`features.browser_network_probe` and `browser_probe.available` are false unless
both are satisfied. The broad `transports.browser` session capability remains
false. Existing HTTP session/profile APIs stay the default route.

**New probes are currently disabled.** Chromium can follow redirects without
Playwright's request route handler, so the present implementation cannot prove
per-hop admission through the pinned relay. Even an otherwise accepted runtime
returns `browser_probe_redirect_admission_unqualified`; capabilities remain false
and new probes are refused before browser/source execution. Existing operation
and artifact reads, including same-key replay, remain available. The following
contract describes the retained interface; operator qualification alone does not
enable new probes until redirect handling is corrected and qualified.

## Profile, runtime and bounds

An explicit server profile field supplies the request/storage envelope:

```json
{"browser_probe":{"enabled":true,"max_requests":8,"max_network_bytes":4194304,"max_decoded_bytes":4194304,"max_dom_bytes":524288,"settle_ms":750}}
```

Hard ceilings are 32 admitted target requests, 16 MiB aggregate network bytes,
8 MiB total retained native decoded bodies, 1 MiB generated DOM and a 2-second
settling window. Profile/session request and byte ceilings intersect these limits.
Public `browser_probe.route_reservations` quotes the whole-probe reservation and
estimate separately from HTTP quotes. Unpriced routes cannot satisfy a finite
caller cost ceiling. Discovery can receive the same field only through explicit
server `v2_discovery_policy.browser_probe` approval of future immutable profiles;
its GET/HEAD/direct/zero-paid restrictions stay intact.

The initial runtime supports an already installed, pinned, eligible **unlicensed
free CloakBrowser** build only. Paid/trial tiers and arbitrary installed Chrome
are not substituted. An operator must explicitly enable `v2.browser_probe.enabled`,
choose `tier:"free"`, and supply a current `qualification` record:

```text
status: accepted
kind: pinned-relay-egress-v1
binary_sha256: exact browser.free hash
version: exact browser.free version
entitlement: unlicensed
platform / arch: actual host runtime
expires_at: future ISO timestamp
evidence: sha256:<reviewed qualification evidence hash>
```

These match `browser.free` and the installed executable's hash/accessibility.
This is trusted operator evidence, not an automatically created entitlement or
permission to download a build. Capability checks make no vendor/entitlement
requests. The worker independently verifies the binary before launch. Missing,
expired, unqualified or changed evidence fails closed. Current local source
qualification has no approved free Cloak runtime and remains unavailable.

## Operation

Authenticated `POST /v2/browser-probes`:

```json
{"idempotency_key":"durable-probe-key","session_id":"UUID","url":"https://source.example/","max_physical_requests":8,"max_estimated_micro_usd":0}
```

`max_physical_requests`, when supplied, must be 1 through the profile bound. Only
a URL and ceilings are accepted: no caller scripts, selectors, actions, form
submissions or browser/CDP handles. Every target request is **GET/HEAD only**,
even if the broader HTTP profile allows POST. Source-generated POST/GraphQL
mutations, other methods, unapproved origins/paths, credential headers and excess
requests are blocked before target HTTP admission. An opaque query or source JS
does not authorize a mutation.

The existing session supplies its immutable profile, source cookie jar and sticky
route. A fresh browser context restores cookies and saves their domain/path/
security state after a known receipt. localStorage and live server circuits are
not persisted. There is no provider retry or fallback.

Every target connection uses the private metered relay. DNS answers are fully
checked, direct sockets or upstream CONNECT use a pinned public IP, and origin
TLS remains end-to-end with normal certificate verification. No TLS interception
or certificate exception is introduced. Each request/redirect has independent
method/path/pacing/expiry/cooldown admission, serialized across parallel events.
Dispatch is durable before transport begins. WebSockets, service workers,
downloads, popups, QUIC, proxy bypass and nonproxied WebRTC are disabled/blocked;
the browser resolver cannot create another source DNS route.

The usual operation envelope and GET operation/key/artifact routes are reused.
`result.kind` is required: `browser_network_probe`. Normal results include:

```text
status, final_url, artifacts, physical_requests,
physical_requests_basis: admitted_browser_target_attempts,
blocked_requests, blocked_reasons, capture_complete,
encoded_bytes: number|null, decoded_bytes, dom_bytes,
tunnel_bytes, target_connections, network_byte_basis
```

An admitted attempt does not prove the source received HTTP. Blocked requests
are unadmitted and do not increment target-request count. Background target
preconnections can consume network bytes; reservations and target-connection
counts include them. `decoded_bytes` counts native bodies only; `dom_bytes` is
separate. `capture_complete:false` identifies blocked, missing or partial capture.

`max_network_bytes` bounds both directions of the encrypted relay stream,
including request/response headers and TLS. Proxy routes include the upstream
CONNECT exchange; direct measurement excludes the local CONNECT acknowledgement.
These are neither encoded response-body bytes nor invoice dollars. A final
already-received chunk can overshoot a threshold; observed paid traffic retains
at least that allowance and triggers a cost hold if it exceeds the reservation.
Residential reservations intersect existing v1/v2 historical allowance and stay
held pending authoritative reconciliation.

## Evidence variants

Both variants have these common fields:

```text
id, operation_id, kind, url, method, status, headers, raw_headers, captured_at,
content_encoding, decoded_body_base64, decoded_sha256, decoded_bytes,
encoded_body_base64:null, encoded_sha256:null, original_encoded_available:false,
encoded_bytes:number|null, encoded_size_basis:playwright_request_sizes|null,
tunnel_bytes:null, provider_status:null, decoding_error
```

`browser_response` requires
`request:{url,method,headers,body_base64:null,resource_type}`. Its body comes from
the native browser response, distinct from DOM. **Original encoded browser body
bytes are unavailable** and never reconstructed. When available, Playwright's
request-size observation gives an independent encoded-body length; a null length
has a null basis. Content-Encoding can still describe the native compression
while retained body bytes are already decoded. Do not decode them again.
Unavailable/oversized bodies stay null with an explicit decoding error.

Request metadata may contain managed source cookies. It stays encrypted/private,
is omitted from summaries/console, and must be sanitized before model input or
sharing. `rendered_dom` requires `generated:true` and has no request object. Its
HTML is generated, with null original/encoded fields, null Content-Encoding and
null raw headers. It cannot satisfy original-document or source-PDF requirements.
There are at most 32 native response artifacts plus one DOM artifact. Per-artifact
tunnel/provider values are null because multiplexed encrypted traffic cannot be
accurately attributed to a response. Existing HTTP artifact variants are unchanged.

Byte caps are retained/read-body bounds. Worker isolation, browser process
cleanup and the deadline protect the parent and bound traffic; these are not an
OS total-browser-memory guarantee. Runtime/container memory limits are a separate
deployment/qualification responsibility. Actual Chrome fixture execution tests
mechanics only; it establishes no county acceptance, stealth qualification or
Cloak license entitlement.

Same-key replay returns the existing failed/unknown/completed operation. Restart
never reruns a probe. Callback/artifact failures after network dispatch retain
unknown status and allowance; source-cookie continuity is not guessed. Recovered
partial results keep `kind`, `capture_complete:false`, `partial:true`,
`additional_dispatches_unknown:true`, and null physical/blocked counts when final
receipts are missing. Retained totals are lower bounds. Clients must discriminate
browser evidence from native HTTP originals.
