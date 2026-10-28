# FetchX API, version 0.2

FetchX provides authenticated HTTP fetching, managed CloakBrowser rendering and reviewed interactions through one service. It is a self-hosted service, not a claim that every protected site is supported. Source profiles define destinations, country, rendering, methods, readiness and budgets. All routes except `/healthz` require `Authorization: Bearer <project-token>`.

## Fetch and recover

`GET /v1/profiles` lists the calling project's profile IDs, execution mode, country, methods, recipe names and response limit. Provider credentials and source recipes are not disclosed.

```sh
curl http://localhost:8788/v1/fetch \
  -H "Authorization: Bearer $FETCHX_TOKEN" -H 'Content-Type: application/json' \
  -d '{"profile":"example.http","url":"https://example.com/","idempotency_key":"example-2026-10-29"}'
```

Persist the key before calling. `POST /v1/fetch` creates a sticky workflow, executes one operation, and closes it after capture. The provider may make bounded first-request fallback attempts within that workflow. Repeating the same payload/key returns the original capture; changing the payload conflicts. A lost response is recovered with `GET /v1/fetch/:key`. Do not create another key to retry an uncertain dispatch. Do not mix the same key across synchronous and queued calls. Stored results eventually expire according to retention policy; expiry does not grant a fresh source request.

The response includes `id`, `workflow`, `status` (source HTTP status), `provider_status`, `provider`, `country`, `headers`, `body_base64`, `captured_at`, `error`, `fallback_blocked` and accounting metadata. Browser responses include `browser_tier` and `browser_version`. API HTTP 200 means a retained result is available: inspect its source status/error and validate its content before accepting a record.

Optional request fields are `method`, `headers`, `body_base64`, `main_document`, `resource_type`, `zipcode` (legacy profiles) and `browser`. Browser captures require GET and `main_document:true` (the fetch facade defaults it to true). Rendering is selected by the reviewed profile, not by an unreviewed caller flag. Use the existing workflow API for multi-operation sessions; each capture restores cookies/localStorage, not in-memory JavaScript state.

## Browser recipes

Recipes live in the server-side source profile. A caller selects a recipe and supplies only its declared text variables:

```json
{"profile":"catalog.browser","url":"https://catalog.example/search","idempotency_key":"search-001","browser":{"recipe":"search","values":{"query":"desk"}}}
```

Example profile fragment (replace selectors and approve destination/method rules before using):

```json
{
  "execution": "browser",
  "readySelector": "#results",
  "browserRecipes": {
    "search": {
      "steps": [
        {"action":"fill","selector":"#query","valueFrom":"query"},
        {"action":"click","selector":"#search"},
        {"action":"wait","selector":"#results"}
      ],
      "extract": {
        "titles":{"selector":"#results .title","all":true},
        "first_link":{"selector":"#results a","attribute":"href"}
      },
      "screenshot":"viewport"
    }
  }
}
```

Actions: `fill`, `select`, `click`, `press` (Enter/Tab/Escape/arrows), `wait`, `scroll` into view. Selectors and static values are reviewed configuration. `fill`/`select` accept either `value` or `valueFrom`. Wait states are visible, hidden, attached or detached. No caller JavaScript or arbitrary CDP endpoint is exposed. Up to 20 steps, 20 extraction fields and 100 matches per field; text values are bounded to 4,096 characters. The entire worker has a 60-second deadline. Screenshots are PNG viewport or a reviewed element selector, and share the response-byte ceiling with HTML and extraction. `extracted`, `screenshot`, `actions_completed`, `action_step` identify outputs and progress without logging submitted values.

Any action other than a wait makes the capture non-replayable across providers. A subsequent denial or timeout cannot automatically submit the form again. Initial navigation blocks can still qualify for normal bounded fallback. Source 429 cooldowns and uncertain transport outcomes never authorize rotation. A saved page or extracted selector value is not application acceptance.

## Durable asynchronous jobs

Enable `jobs.enabled:true` in server configuration. `POST /v1/jobs` accepts the same payload as `/v1/fetch` and returns HTTP 202 with a job ID and `queued` state. `GET /v1/jobs/:id` returns state and, when retained, the result. `DELETE /v1/jobs/:id` cancels only queued jobs. Identical job submissions replay the same job; changed payloads conflict.

One worker executes jobs under the gateway's database ownership lock. Queued work survives restart and expires after 30 minutes if not started. Running jobs interrupted by a crash become `unknown`; FetchX looks up any retained capture but never blindly repeats a source operation. Completed means processing finished, not that the source returned usable data. Inspect the nested result. Queue defaults: 20 pending/running jobs per project and 100 globally; configure `maxQueuedJobs` on a project and `jobs.maxQueued` globally. Existing bandwidth/admission limits also apply at dispatch. Polling and cancellation are project-scoped. Webhooks and horizontal workers are not part of 0.2.

## Routing and limits

New native profiles: Evomi, then DataImpulse. Browser profiles: Evomi/free, DataImpulse/free, Evomi/paid, DataImpulse/paid. Fallback is qualified, bounded and restricted to the first eligible operation. Paid browser builds require a valid paid entitlement; the free trial is not perpetual. No binaries, trial keys or subscriptions are included in this repository. Scrape.do/Oxylabs adapters remain available for explicitly configured legacy routes.

Residential usage is reserved before dispatch. Local byte counters are not provider invoices; failed or uncertain attempts retain reservations until authoritative reconciliation. FetchX does not promise success-only billing. Status and diagnostics remain at `/v1/status` and `/v1/operations/:id/diagnostics`.

## Remaining capability work

Automatic CAPTCHA solving, vendor-specific managed unblocking, general interactive browser sessions/CDP, durable webhook delivery, cross-process browser pools and distributed job ownership are not implemented. Qualify real source identity, context and completeness before migrating a crawler. Provider connectivity, fixture tests and HTTP 200 alone do not establish source acceptance.
