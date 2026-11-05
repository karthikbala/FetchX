# FetchX v2 Render API

`POST /v2/render` opens a dedicated browser session for one GET navigation to
an approved HTTPS destination. The endpoint requires a project Bearer token
with `fetch:write` for managed keys. Use `GET /v2/render/:key` with `fetch:read`
to retrieve the operation by the original, URL-encoded key. A project can read
its own retained artifacts through `GET /v2/artifacts/:id` with `fetch:read`.
Check `features.browser_render` in `GET /v2/capabilities` with
`profiles:read` before submitting. Each request still requires an approved
destination, route, qualified browser runtime and sufficient allowance.

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
use the browser profile reference issued by their playground for the selected URL,
with a reviewed browser credit weight for that route. The `fetch:write` scope
authorizes submission to the Render endpoint. Native browser probes require a
provisioned credential with the applicable profile and runtime policy.
Use `direct` with `country: null`, or an approved `datacenter` or `residential`
route with an uppercase country code. The optional `wait_ms` is an integer from
zero through the profile's post-load wait limit, at most 2,000 milliseconds.
Omission uses the profile default. `screenshot` defaults to `false` and captures
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

`usage` records browser requests, blocked requests, bytes, duration and
accounting as available. For managed keys, `usage.accounting.request_credits`
shows the original attribution and reservation state. Known challenge markers
can produce `source_challenge` with a source HTTP 200. The result always reports
`application_acceptance: "not_evaluated"`.

Datacenter estimates for browser traffic require explicit operator review. A
scoped `datacenterPricingAttestations` entry uses `schema_version: 2` and
`transport: "browser"`. A service-wide `datacenterFixedFeePool` uses
`schema_version: 2` and an explicit `transports` list containing `"browser"`.
Include `"http"` in that list to cover native HTTP as well. Version 1 pricing
remains HTTP-scoped. Managed browser credits require reviewed browser mode
weights in addition to available route pricing.
