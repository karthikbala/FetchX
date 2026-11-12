# FetchX Scrape API

`POST /v2/scrape` renders a single page using FetchX's browser capture path and converts the retained DOM into the requested formats. It accepts a project Bearer token and requires `fetch:write` for managed keys. The request and response follow the [Firecrawl v2 Scrape contract](https://docs.firecrawl.dev/api-reference/endpoint/scrape) for the fields below.

```sh
curl --silent --show-error "$FETCHX_URL/v2/scrape" \
  -H "Authorization: Bearer $FETCHX_TOKEN" \
  -H 'Content-Type: application/json' \
  -H "X-Idempotency-Key: $SCRAPE_KEY" \
  -d '{"url":"https://example.com/","formats":["markdown","links"]}'
```

| Field | Behavior |
| --- | --- |
| `url` | Required absolute HTTPS URL on the selected profile. |
| `formats` | One to four entries from `markdown`, `html`, `rawHtml`, and `links`. Each entry can be a string or a `{ "type": "markdown" }` object. Defaults to `["markdown"]`. |
| `onlyMainContent` | Defaults to `true`. Uses a `main` element or main landmark when present and removes common navigation and footer elements. Set to `false` to use the whole cleaned body. Applies to `markdown`, `html`, and `links`. |
| `waitFor` | Additional settle time after navigation, in integer milliseconds. Defaults to zero. Maximum is the profile's browser settle limit, up to 2,000 ms. |
| `timeout` | Requested browser operation deadline in integer milliseconds, from 1,000 through 300,000. The gateway caps it at the profile and dispatch limits. Omit it to use the existing browser operation deadline. |
| `origin`, `integration` | Optional SDK attribution strings of up to 256 characters. FetchX accepts and discards them. |
| Python SDK defaults | FetchX accepts and discards `mobile: false`, `removeBase64Images: true`, `fastMode: false`, `blockAds: true`, `maxAge: 14400000`, and `storeInCache: true`. Other values for these fields return HTTP 400. |

Unknown request fields return HTTP 400. The browser uses a dedicated session with the existing destination checks, request and byte limits, metering, and encrypted retention.

A success returns `{ "success": true, "data": { ... } }`. The data includes `metadata` and the requested formats. Metadata has `sourceURL`, the final `url`, and the source `statusCode`. It includes `contentType`, `title`, `description`, and `language` when available.

`html` is a cleaned HTML fragment with active markup and event attributes stripped. `markdown` is generated from the same fragment and preserves headings, lists, links, and ordinary tables. Complex tables may remain as cleaned HTML in Markdown. `rawHtml` is the retained rendered DOM as captured, including any page-supplied markup. `links` contains up to 1,024 distinct HTTP(S) anchor URLs resolved against the final page URL. Conversion reads the retained capture locally.

## Recovery

Store your `X-Idempotency-Key` before sending the request. Use 1–160 letters, digits, underscores, periods, colons, or hyphens. If the header is omitted, FetchX generates a key and returns it in `X-Idempotency-Key`. A caller-generated key remains available when a response is lost.

Recover by posting the same options with the original key. Format order, repeated formats, equivalent URL spelling, explicit defaults, and SDK attribution do not change the request identity. A different request under a bound key returns HTTP 409 with `idempotency_conflict`. An active or uncertain operation returns HTTP 409 with `scrape_running` or `scrape_outcome_unknown`. Replaying the original key checks the existing operation without dispatching it again.

Failures return `{ "success": false, "code": "...", "error": "..." }`. The response uses the corresponding gateway HTTP status. If a capture expires, replay still cannot dispatch a replacement under that key.

## SDK compatibility

Point the official JavaScript SDK's `apiUrl` or Python SDK's `api_url` to the FetchX base URL, without a `/v2` suffix. Call `scrape()` with the FetchX key and supported options. The JavaScript SDK uses `onlyMainContent` and `waitFor`. The Python SDK uses `only_main_content` and `wait_for`. Both SDKs return the document from the response's `data` field. For requests that need recoverable idempotency, use a client that can set and retain the `X-Idempotency-Key` header. When using the SDK without a caller-generated key, configure a single transport attempt so a lost connection cannot create a second scrape.

The [OpenAPI contract](scrape-openapi.json) defines the wire types. To regenerate the TypeScript definitions, run `npx openapi-typescript@7.13.0 docs/scrape-openapi.json --default-non-nullable=false -o clients/scrape-v2.d.ts` from the repository root.

## Operator configuration

Add an entry for the project under `v2.scrape.projects` in the gateway configuration:

```json
{
  "v2": {
    "scrape": {
      "projects": {
        "example-project": {
          "access_profile": {"id": "example-browser", "version": 1},
          "proxy": {"class": "direct", "country": null},
          "max_estimated_micro_usd": 0
        }
      }
    }
  }
}
```

Use a browser-enabled access profile already approved for the provisioned project. For managed projects, use the browser profile reference from [render preparation](render-api.md#prepare-a-managed-render) for the reviewed origin and the same proxy class and country. The optional `max_estimated_micro_usd` tightens the existing spending controls. Only projects with an explicit entry can submit new scrapes.
