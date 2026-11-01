# FetchX v2 HTTP foundation

This additive API does not migrate v1 workflows, ledger rows, or captures. The
current implementation supports native HTTP with direct, configured datacenter,
and configured residential routing. Broad browser sessions, DOM selectors,
screenshots, WebSockets, persistent localStorage, live leases and arbitrary client
scripts remain unsupported. A separately qualified one-shot
[browser network probe](api-v2-browser-probe.md) is optional; HTTP remains the
default. Source access requires a server-reviewed profile or an explicitly
enabled project discovery policy. Clients cannot expand methods, credentials or
paid routes through discovery. No model inference occurs in FetchX.

All routes require the existing project Bearer token. IDs are UUIDs; keys are
durable caller-generated strings matching `[A-Za-z0-9_.:-]{1,160}`. Both POSTs
require an explicit idempotency key. A reused key with a different canonical body
returns `409 idempotency_conflict`. Recovery never replays dispatched operations.
Store keys before calling; recover by GET after a lost response.

## Client contract

`GET /v2/capabilities`:

```json
{"api_version":"2","transports":{"http":true,"browser":false},"proxy_classes":{"direct":true,"datacenter":true,"residential":true},"features":{"native_responses":true,"downloads":true,"encoded_bodies":true,"cookie_jar":true,"json_pointers":true,"dom_selectors":false,"websockets":false,"local_storage":false,"live_leases":false},"retries":{"owner":"gateway","max_physical_retries":0},"profile_approval":"server_configuration"}
```

Proxy class support describes implementation. A configured, entitled route,
approved country and current budget must still be available for a session.
`GET /v2/access-profiles` returns `{ "access_profiles": [...] }`. Each profile is
`{id,version,origins,paths,method_paths,methods,headers,proxy_classes,countries,limits,route_reservations}`.
An optional `method_paths` map narrows each HTTP method to reviewed path
expressions; when present, a method without an entry is denied. Both this map
and the shared `paths` restrictions apply on every request/redirect.
`route_reservations` contains `{class,country,provider,reserved_tunnel_bytes,
estimated_micro_usd}` for each reviewed route. A null provider/estimate means
availability/pricing is unknown, and never means a free paid route.
`GET /v2/recipes` returns `{ "recipes": [...] }`. Each recipe is separately
versioned and binds to one access-profile version. The supported kind is `http`,
with optional `request:{method,path_pattern}` and
`json_pointers:{fieldName:"/json/pointer"}`. A recipe never expands source access.

`POST /v2/sessions`:

```json
{"idempotency_key":"job-123-session","access_profile":{"id":"county.lookup","version":1},"transport":"http","proxy":{"class":"direct","country":null,"affinity":"session"}}
```

For a proxy, set `class` to `datacenter` or `residential` and `country` to an
approved uppercase ISO two-letter code. Direct requires `country:null`: the
gateway does not claim a verified egress country. `affinity` must be `session`.
Proxy country is requested provider configuration; an independent exit-country
verification is not performed by this foundation.
The response is:

```json
{"id":"UUID","access_profile":{"id":"county.lookup","version":1},"transport":"http","proxy":{"class":"direct","country":null,"affinity":"session","provider":"direct"},"state":"open","expires_at":"ISO timestamp","requests":0,"encoded_bytes":0,"state_support":{"cookie_jar":true,"local_storage":false,"live_connection":false}}
```

`GET /v2/sessions/:id` reads the same envelope. Sessions pin their immutable
approved security profile and route; cookie state is separately encrypted.
Only one operation can run in a session at a time. Browser circuits cannot be
recreated from a cookie jar.

`POST /v2/operations`:

```json
{"idempotency_key":"job-123-lookup","session_id":"UUID","request":{"url":"https://source.example/data","method":"GET","headers":{"accept":"application/json"}},"recipe":{"id":"county.lookup-json","version":1}}
```

`recipe` is optional. `body_base64` is optional within `request`; GET/HEAD bodies
are rejected. Source credentials require explicit approved header scope; caller
cookie headers and gateway tokens are rejected. The gateway manages source
Set-Cookie state. Requests are synchronous but first create a durable operation.
The operation may include `max_estimated_micro_usd` as a predispatch ceiling.
Direct has estimate zero. Residential compares its conservative full reservation
estimate; a route with an unknown estimate rejects a supplied finite ceiling.
This ceiling uses configured rates and is not an authoritative invoice or a
substitute for the campaign's shared source/model spending authority.
The operation response, `GET /v2/operations/:id`, and
`GET /v2/operations/by-key/:key` have the same shape:

```json
{"id":"UUID","idempotency_key":"job-123-lookup","session_id":"UUID","state":"completed","error":null,"access_profile":{"id":"county.lookup","version":1},"recipe":null,"created_at":"ISO timestamp","finished_at":"ISO timestamp","result":{"status":200,"final_url":"https://source.example/data","artifacts":[{"id":"UUID","kind":"native_response","status":200,"encoded_bytes":51,"decoded_bytes":31,"content_encoding":"gzip"}],"extracted":{},"physical_requests":1,"encoded_bytes":51,"decoded_bytes":31,"tunnel_bytes":null,"provider_status":null,"retry_after":null},"accounting":{"provider":"direct","reserved_tunnel_bytes":0,"observed_tunnel_bytes":null,"invoice_micro_usd":null,"basis":"direct_no_provider_invoice"}}
```

States are `reserved`, `running`, `completed`, `failed`, and `unknown`.
`unknown` requires operator investigation; repeating POST with the same key only
returns that state, and changing the key is not recovery. Source HTTP errors are
retained native outcomes; HTTP 200 alone does not establish application acceptance.
Failed/unknown operations can have partial artifacts and measured byte counts.
After a crash between an artifact commit and final result commit, recovery
exposes retained artifacts with `result.partial:true`,
`additional_dispatches_unknown:true` and `physical_requests:null`. Those byte
totals describe retained evidence, not a complete traffic bill. Recovery does
not dispatch or infer a missing invoice.

`GET /v2/artifacts/:id` returns an authenticated project-scoped JSON artifact:

```json
{"id":"UUID","operation_id":"UUID","kind":"native_response","url":"https://source.example/data","method":"GET","status":200,"headers":{"content-type":"application/json","content-encoding":"gzip"},"raw_headers":["Content-Type","application/json"],"captured_at":"ISO timestamp","content_encoding":"gzip","encoded_body_base64":"...","decoded_body_base64":"...","encoded_bytes":51,"decoded_bytes":31,"encoded_sha256":"hex","decoded_sha256":"hex","tunnel_bytes":null,"provider_status":null,"decoding_error":null}
```

A Content-Disposition attachment has `kind:"download"`; original PDF/ZIP/image
bytes are preserved. Each completed redirect hop also has a native artifact.
If decoding fails or a decompression cap rejects a body, encoded evidence is
retained and decoded fields are null. Encoded body size excludes HTTP headers,
TLS and CONNECT overhead. `tunnel_bytes` measures both directions at the gateway
proxy tunnel, including its CONNECT exchange; it is not a provider invoice.
HEAD and 204/205/304 responses preserve their representation headers and empty
body evidence without attempting decompression of an absent message body.
Direct tunnel bytes are null. Residential reservations stay conservatively held
until reconciliation. Unknown invoice/old compression values stay null.
Operation `accounting.estimated_micro_usd` is zero for direct, the configured
reservation estimate for residential, and null for an unpriced datacenter route.

## Key access, entitlements and usage

Project Bearer keys are the simple authentication boundary. The operator can
provision a dedicated application key after approving source profiles:

```sh
node scripts/provision-v2-project.mjs --config /private/gateway.json \
  --project application --profiles county.lookup@1 --output /private/application.env \
  --url http://127.0.0.1:8788 --mode unmetered
```

The script exclusively creates an environment file with mode 0600, stores only
the key hash and a public key ID in configuration, and prints paths/key ID only.
It refuses an existing project or environment file. It does not create profiles,
buy entitlements or deploy services. Store the file privately and give the
application its server-side URL/token through its own secret mechanism.

`projects.PROJECT.v2_entitlement.mode` is `unmetered` by default. This waives the
client operation quota while retaining source/session limits, shared provider
caps, physical request limits, pacing and accounting. `metered` additionally
requires positive `max_daily_operations`, measured on UTC dates and counting
every reserved v2 operation. It does not create or fund a vendor allowance.

`GET /v2/usage` returns `{project,key_id,entitlement,outcomes,outcomes_by_key,
by_key_and_state,scope,application_acceptance,invoice_basis}`. `outcomes` and each
entry in `outcomes_by_key` count source HTTP successes (2xx/3xx), source HTTP
failures (4xx/5xx), gateway failures, unknown outcomes, actual known physical
requests and encoded/decoded bytes. `by_key_and_state` adds reserved-or-actual
requests/encoded bytes, held tunnel bytes, measured tunnel bytes, configured cost
estimates, known invoices and unknown-invoice operation counts. Null invoice
values remain unknown. Source transport success does not establish application
acceptance. Scope is this project's lifetime v2 operations; v1 history continues
to constrain shared residential allowance and is not relabelled as v2 usage.

`GET /v2/operations?limit=25` returns recent project-scoped metadata only:
`{operations:[{id,key_id,state,error,created_at,finished_at,access_profile,
source_http_status,physical_requests,encoded_bytes,decoded_bytes,tunnel_bytes,
diagnostics,provider,estimated_micro_usd,invoice_micro_usd}],scope,limit}`.
The limit is 1–50. It omits request URLs/bodies, cookies, response bodies,
extracted values and artifacts. Usage groups also report
`unknown_estimate_operations`, so a known subtotal is not presented as a complete
cost when some routes remain unpriced. New operations retain a small safe summary
for usage/recent reads; historical encrypted results remain readable without
altering their original evidence.

## Read-only console

Open `/console` on the private gateway listener. Its public static login page
contains no project data or credentials. Enter a project Bearer key to read that
project's usage and recent metadata. The key is kept only in tab memory, cleared
from the input and on disconnect/page exit, and never saved to a URL, cookies,
localStorage or sessionStorage. Every JSON API continues to require the key.

The console uses same-origin read-only GETs, manual refresh, a restrictive content
security policy, no external assets and no frames. It has no crawl, replay,
source-profile approval or configuration actions. Successful HTTP responses,
source/gateway failures, unknown outcomes, known body bytes, conservative tunnel
reservations, measured tunnel bytes and estimates remain separate. Unmetered
client access does not waive provider budgets or source safeguards. Keep the
listener private or serve authenticated TLS at the deployment boundary as before.

## Server approval configuration

Version keys are immutable: changing an existing profile/recipe under the same
id/version is rejected against its durable registry, including after restart.
Add a new version for every policy or recipe change. Example (synthetic only):

```json
{"v2":{"accessProfiles":{"county.lookup@1":{"id":"county.lookup","version":1,"origins":["https://source.example"],"paths":["^/data$"],"methods":["GET"],"headers":["accept"],"proxy_classes":["direct"],"countries":[],"limits":{"max_requests":20,"max_encoded_bytes":1048576,"max_decoded_bytes":4194304,"max_session_encoded_bytes":20971520,"max_input_bytes":65536,"max_tunnel_bytes":2097152,"max_redirects":2,"max_expansion_ratio":100,"timeout_ms":20000,"min_interval_ms":1000,"ttl_seconds":900}}},"recipes":{"county.lookup-json@1":{"id":"county.lookup-json","version":1,"access_profile":{"id":"county.lookup","version":1},"kind":"http","request":{"method":"GET","path_pattern":"^/data$"},"json_pointers":{"value":"/value"}}}},"projects":{"PROJECT":{"v2_access_profiles":["county.lookup@1"]}}}
```

Existing project settings remain required. Profiles permitting residential routes
also require the existing residential provider enablement/country/rate and global,
provider and project byte caps. V2 intersects the same history and reservations;
it never creates a second spendable allowance. Datacenter routes use reviewed
server `proxies` entries with the requested country and configured URL.

DNS is checked for every hop, all resolved addresses must be public, and the
actual direct socket or proxy CONNECT uses a checked IP. HTTPS SNI and certificate
verification remain bound to the approved original host. Redirects are bounded
and revalidated; cross-origin redirects are rejected. Caller-controlled proxy
endpoints, private destinations, arbitrary credential forwarding and automatic
provider fallback are unsupported. Global origin pacing and Retry-After cooldown
apply before physical dispatch. No physical retries are implemented in v2.

V1 browser behavior is unchanged. HTTP and attachment capture keep their original
semantics; optional browser-probe evidence is a separate variant. Browser download
capture is unsupported. V1 captures are not relabelled as encoded originals.

## Project-scoped discovery profiles

An operator may enable bounded onboarding of caller-supplied public origins for
one project. It is disabled by default and is separate from unmetered client
quota. Example server configuration (no credentials):

```json
{"projects":{"PROJECT":{"v2_discovery_policy":{"enabled":true,"max_profiles":100,"max_origins":6,"limits":{"max_requests":8,"max_encoded_bytes":1048576,"max_decoded_bytes":4194304,"max_session_encoded_bytes":8388608,"max_redirects":0,"timeout_ms":20000,"min_interval_ms":1000,"ttl_seconds":900,"max_expansion_ratio":100}}}}}
```

`max_profiles` is a lifetime project cap (1–1000), and `max_origins` bounds each
request (1–20). Optional `limits` override conservative server defaults, within
hard safety ceilings. Callers cannot supply limits, methods, headers, paths,
regular expressions, proxy selection or paid allowances. Input body and tunnel
limits are fixed placeholders for a bodyless direct-only request; paid allowance
is always zero. Discovery remains HTTP-only unless the server explicitly supplies
`v2_discovery_policy.browser_probe` using the bounded profile field described in
[the probe contract](api-v2-browser-probe.md). That grant applies only to future
immutable profiles and cannot add methods, proxy classes, paid allowance or source
credentials. Existing profiles are not upgraded.

Authenticated `POST /v2/discovery-profiles`:

```json
{"idempotency_key":"crawler-manual-sources-001","origins":["https://assessor.county.gov","https://collector.county.gov"]}
```

Response:

```json
{"access_profile":{"id":"discovery:SERVER-UUID","version":1},"profile":{"id":"discovery:SERVER-UUID","version":1,"kind":"discovery","origins":["https://assessor.county.gov","https://collector.county.gov"],"paths":["^/"],"method_paths":{"GET":["^/"],"HEAD":["^/"]},"methods":["GET","HEAD"],"headers":["accept","accept-language","user-agent"],"proxy_classes":["direct"],"countries":[],"limits":{"max_redirects":0},"route_reservations":[{"class":"direct","country":null,"provider":"direct","reserved_tunnel_bytes":0,"estimated_micro_usd":0}],"max_paid_cost_micro_usd":0},"created_at":"ISO timestamp"}
```

The abbreviated `limits` above is returned in full in actual responses.
The server generates the ID; the `discovery:` namespace is reserved and rejected
for static profile configuration. The complete profile body/hash, reference,
original input hash and creation time are durable in PostgreSQL. Exact replay
under the same project/key returns the same profile/reference/time, even if future
creation ceilings change. A changed valid payload under that key returns
`409 idempotency_conflict`. Project count/check/insertion is atomic under a shared
project lock. There is no mutation/delete endpoint or allowance-reset behavior.

Origins must be canonical HTTPS origins with public-looking DNS names. An
explicit standard `:443` is normalized. IP literals (public or private), single
labels, reserved/internal suffixes, wildcards, userinfo, nonstandard ports,
whitespace, fragments, queries and any path—including a trailing `/`—are rejected.
Creation performs no DNS or target request and does not certify public
reachability, county identity or official source authority. Every actual request
still resolves all addresses, rejects private/mixed answers, pins the selected
address and verifies TLS. The caller must supply trusted manual seeds; any model
proposal or source link remains untrusted and cannot expand this profile.

`GET /v2/access-profiles` includes only the owning project's eligible discovery
profiles alongside its static grants. Their refs work in ordinary
`POST /v2/sessions`. Another project cannot read or use the ref, even if its own
discovery policy is enabled. `/v2/capabilities` adds project-specific
`features.discovery_profiles` and `discovery_profile_policy` metadata.

Default `max_redirects:0` allows one physical request per operation. An explicit
server override may permit bounded redirects only among origins supplied in
that immutable profile; it never adds a linked host. Credential headers remain
forbidden, and source cookies retain normal domain/path/security scoping across
origins. Static-profile redirect behavior stays unchanged. If an operator disables
the discovery policy, new sessions/operations cannot use its discovery grants.
If current ceilings become stricter than an old grant, that grant is retained
immutably but omitted from eligible discovery and rejected for new use with
`discovery_policy_changed`. Historical operation/artifact reads remain scoped to
their original owner. Existing provider ledgers and caps are untouched.

## DNS failure diagnostics and approved fallback

DNS failure is distinct from a source HTTP denial or a geographic restriction.
Before target dispatch, lookup failures now return explicit operation errors such
as `source_dns_not_found`, `source_dns_servfail`, `source_dns_timeout`,
`source_dns_refused`, `source_dns_authority_unreachable` (resolver EDE 22), or
`source_dns_validation_failed` (resolver DNSSEC validation error indication).
These are failed operations with zero target `physical_requests`, no HTTP status
and no native source artifacts. They do not establish a source block.

The optional operator-approved fallback is disabled by default:

```json
{"v2":{"dns":{"allowed_hosts":["source.example","records.source.example"],"fallback_resolvers":[{"id":"google-public-dns","endpoint":"https://dns.google/resolve"}],"system_timeout_ms":2000,"timeout_ms":6000}}}
```

Only listed source hosts may use these resolver endpoints after a recognized
system DNS failure. Source clients cannot supply a resolver or a target IP.
At most two configured HTTPS DNS-JSON endpoints are allowed. The gateway resolves
and pins each resolver endpoint with the system resolver, validates its public
address set and TLS certificate, bounds its response/deadline, and queries both
A and AAAA with checking enabled (`cd=0`). Checking-disabled, truncated,
question-mismatched and malformed replies fail closed. A DNSSEC validation
failure is never retried with checking disabled. Signed and unsigned zones can
legitimately differ in the authenticated-data flag; it is reported separately.

All returned source addresses pass the existing public-address checks before
the actual socket/CONNECT is pinned. A successful system answer containing any
private address is rejected, without trying a more permissive resolver. The
same rule applies to a fallback's private/mixed answers. No stale DNS cache,
hardcoded target IP or certificate-verification exception is introduced.
Authoritative county DNS failure may affect every validating resolver; fallback
does not promise that an unavailable authoritative service becomes reachable.

An operation result adds `diagnostics:{stage,failure,dns}`. Failure data retains
the stage, an allowlisted Node/DNS/TLS/PostgreSQL cause code, exception class,
whether a target transport attempt began, and safe resolver attempt metadata
(resolver ID, DNS RCODE and numeric EDE codes). Examples are `stage:"dns"` with
`cause_code:"ENOTFOUND"`, or `stage:"pacing"` with PostgreSQL `cause_code:"42P01"`.
Raw exception messages, stacks, SQL text, URLs, credentials, resolver comments
and EDE text are omitted. Successful fallback provenance includes the resolver
ID, answer count and authenticated-data flag. Target physical-request accounting
excludes the supporting DNS queries. An attempted transport still does not prove
that a source HTTP request reached its server. Admission failures before a durable
operation return similarly safe top-level v2 diagnostics. V1 responses remain
unchanged.
