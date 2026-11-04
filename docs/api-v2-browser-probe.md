# FetchX v2 qualified browser network probe

A browser probe navigates to one HTTPS page in an isolated context and records
bounded network evidence and rendered output. The [Playground](playground.md)
and `POST /v2/render` use the same runtime and a dedicated Browser session.
Browser availability depends on platform readiness, the reviewed route and
the project's ordinary credit allowance. Users do not qualify their own
runtime. The legacy `POST /v2/browser-probes` contract remains available to
unmanaged projects with enabled profiles and the standard HTTP session API.

## Profile, runtime and bounds

An explicit server profile field supplies the request/storage envelope:

```json
{"browser_probe":{"enabled":true,"max_requests":8,"max_network_bytes":4194304,"max_decoded_bytes":4194304,"max_dom_bytes":524288,"settle_ms":750}}
```

Hard ceilings are 32 admitted target requests, 16 MiB aggregate network bytes,
8 MiB total retained native decoded bodies, 1 MiB generated DOM, a 1 MiB viewport
screenshot and a 2-second settling window. Profile/session request and byte ceilings intersect these limits.
Public `browser_probe.route_reservations` quotes the whole-probe reservation and
estimate separately from HTTP quotes. Unpriced routes cannot satisfy a finite
caller cost ceiling. Discovery can receive the same field only through explicit
server `v2_discovery_policy.browser_probe` approval of future immutable profiles;
its GET/HEAD/direct/zero-paid restrictions stay intact.

The customer-facing Browser deployment uses an installed, pinned Chromium
build through Playwright. The operator sets `v2.browser_probe.enabled: true`,
`engine: "chromium"` and `runtime: {executablePath, version, sha256}`. The
path must identify a local executable. FetchX verifies its SHA-256 before
marking the platform ready and the worker hashes it again before launch.

The `v2.browser_probe.qualification` record must identify the exact runtime:

```text
status: accepted
kind: pinned-relay-egress-v2
engine: chromium
binary_sha256: exact runtime executable hash
version: exact runtime version
platform / arch: actual host runtime
expires_at: future ISO timestamp
evidence: sha256:<reviewed qualification evidence hash>
```

Legacy configurations can retain the separate `tier: "free"` and
`browser.free` pin for an installed keyless CloakBrowser build. For that
configuration the qualification carries `entitlement: unlicensed` and may
omit `engine` or identify it as `cloakbrowser`. The legacy path and any
rights to use its binary are independent of the Chromium deployment.

Qualification evidence covers the pinned binary and service environment,
including sandboxed launch, TLS and destination pinning, denied redirect
hops, secondary targets, WebSocket blocking, caps and failure handling.
Older v1 evidence is insufficient for the current admission path. Capability
checks read local state. The worker launches the configured executable with
reviewed flags and the Chromium sandbox enabled. Missing, expired,
mismatched or unreadable evidence keeps Browser unavailable. A fixture with
a local development browser verifies mechanics and does not qualify the
production pin.

## Operation

Authenticated `POST /v2/browser-probes`:

```json
{"idempotency_key":"durable-probe-key","session_id":"UUID","url":"https://source.example/","max_physical_requests":8,"max_estimated_micro_usd":0}
```

`max_physical_requests`, when supplied, must be 1 through the profile bound.
`wait_ms` can shorten the profile's settling window and `screenshot: true`
requests a JPEG of the 1280 × 720 viewport. The probe API accepts a navigation
URL and bounded capture options. Every target request is **GET/HEAD only**,
even if the broader HTTP profile allows POST. Source-generated POST/GraphQL
mutations, other methods, unapproved origins/paths, credential headers and excess
requests are blocked before target HTTP admission. An opaque query or source JS
does not authorize a mutation.

The existing session supplies its immutable profile, source cookie jar and sticky
route. A fresh browser context restores cookies and saves their domain/path/
security state after a known receipt. localStorage and live server circuits are
not persisted. The route remains fixed for the operation. A managed render
reserves and settles the selected project key's Browser credits with the same
operation and provider ledger. Uncertain dispatch holds the reservation and
recovery reads the original operation.

Every target connection uses the private metered relay. DNS answers are fully
checked, direct sockets or upstream CONNECT use a pinned public IP, and origin
TLS remains end-to-end with normal certificate verification. No TLS interception
or certificate exception is introduced. Chromium's request-stage Fetch interception pauses each hop before it dispatches.
The parent independently checks method, origin, path, DNS answers, pacing and
cooldown, then records durable dispatch admission and issues one CONNECT
permit for the pinned hostname. HTTP/1.1 with `Connection: close` avoids
Chromium's automatic replay of requests on failed reused connections. The main
document and supported same-frame resources can use the transport. Secondary
targets, unsupported resource types, service workers, downloads, QUIC, proxy
bypass and nonproxied WebRTC are restricted. Chromium routes plaintext HTTP and
WebSockets to a separate local listener that rejects all traffic without an
outbound connection. Only HTTPS can use an admitted permit.

The usual operation envelope and GET operation/key/artifact routes are reused.
`result.kind` is required: `browser_network_probe`. Normal results include:

```text
status, final_url, artifacts, physical_requests,
physical_requests_basis: admitted_browser_target_attempts,
blocked_requests, blocked_reasons, capture_complete,
encoded_bytes: number|null, decoded_bytes, dom_bytes, screenshot_bytes,
main_artifact_id, dom_artifact_id, screenshot_artifact_id,
tunnel_bytes, target_connections, network_byte_basis
```

An admitted attempt does not prove the source received HTTP. Blocked requests
are unadmitted and do not increment target-request count. Each outbound tunnel
consumes an admitted permit. `decoded_bytes` counts native bodies only. DOM and
screenshot sizes are separate. `capture_complete:false` identifies blocked,
missing or partial capture.

`max_network_bytes` bounds both directions of the encrypted relay stream,
including request/response headers and TLS. Proxy routes include the upstream
CONNECT exchange; direct measurement excludes the local CONNECT acknowledgement.
These are neither encoded response-body bytes nor invoice dollars. A final
already-received chunk can overshoot a threshold; observed paid traffic retains
at least that allowance and triggers a cost hold if it exceeds the reservation.
Residential reservations intersect existing v1/v2 historical allowance and stay
held pending authoritative reconciliation.

New residential probes expose the [customer traffic charge](fetch-api.md#residential-traffic-charges)
under `accounting.customer_traffic`. The charge covers measured proxy traffic
for the whole probe at $2 per decimal GB. A missing page artifact can leave
`capture_complete:false` even when the relay measured every byte. An incomplete
traffic measurement leaves `cost_usd` null.

## Evidence variants

All browser variants share these fields:

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
Redirects retain response metadata with a null body. Other unavailable or
oversized bodies stay null with a decoding error. `main_document:true`
identifies a top-level response eligible for the render result.

Request metadata may contain managed source cookies. It stays encrypted/private,
is omitted from summaries/console, and must be sanitized before model input or
sharing. `rendered_dom` requires `generated:true` and has no request object. Its
HTML is generated, with null original/encoded fields, null Content-Encoding and
null raw headers. It cannot satisfy original-document or source-PDF requirements.
`browser_screenshot` requires `generated:true` and stores the bounded JPEG in
`decoded_body_base64`. There are at most 32 native response artifacts, one DOM
artifact and one optional screenshot. Artifacts are encrypted at rest. The relay
reports tunnel bytes and provider status for the operation as a whole.

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
