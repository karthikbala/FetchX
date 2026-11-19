# API contract and SDK consistency

Implement the approved API standards work locally while preserving the existing
v1 workflow and v2 execution, authorization, accounting and recovery behavior.

1. Publish a canonical OpenAPI document for the customer-facing v2 endpoints.
   Describe Fetch and Render inputs, retained-result and admission errors,
   managed-key scopes, read-only recovery, and conditional Render availability.
   Reference the separate provisioned native API explicitly rather than imply
   that managed keys can submit native sessions or browser probes.
2. Derive the website endpoint reference and downloadable contract from that
   document. Align the existing guides, add Render guidance, and state the API
   compatibility policy. API majors, service releases, and immutable profile or
   recipe versions remain separate concepts.
3. Add the public Fetch/Render helpers to both bundled SDKs and bring Python to
   parity with the existing JavaScript native v2 helpers. Keep v1 methods intact,
   require caller-owned idempotency keys for explicit submissions, and preserve
   facade error/recovery information without automatic retries.

Acceptance: the published contract describes actual registered routes and
representative wire responses; generated references cannot drift unnoticed;
SDK fixture tests cover requests, encoded recovery keys, structured errors,
ambiguous transport failures and unchanged v1 calls. Run the relevant website,
JavaScript and Python checks, then serial gateway tests against a disposable
`gateway_test_*` PostgreSQL database. No real providers or credentials in tests.

The existing V2 browser redirect test failure is a recorded baseline issue and
must remain distinguishable from regressions in this change. Browser behavior,
new retry headers, pagination, async jobs and deployment are outside these first
two implementation phases.

## Implementation and verification

Completed locally on 2026-11-04. `docs/openapi.json` describes all 13 customer
endpoints. The website imports that contract for its reference, examples and
download, and both SDKs cover Fetch, Render and recovery. Python also covers the
existing JavaScript native v2 helpers. TypeScript declarations derive from the
contract; CI checks generation drift and compiles client examples.

Contract tests (6), JavaScript client tests (10), Python client tests (10), and
the declaration/type checks passed. The full serial gateway run against a fresh
disposable PostgreSQL database recorded 317 passes, two optional skips and the
same pre-existing browser redirect failure at `test/v2-browser-tls.test.mjs:126`.
The disposable database was removed after verification.

Website type checks, all 139 unit tests, the 40-route static build and all six
browser checks passed. Website verification used a temporary copy with fresh
locked dependencies because macOS had evicted part of the workspace dependency
tree. The served OpenAPI JSON matched the canonical file; desktop/mobile layout
and the Render/reference pages were inspected. No deployment was performed.
