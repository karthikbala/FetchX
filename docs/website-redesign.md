# FetchX website and product preview

## Approved outcome

Replace managed dataset positioning with a developer API product for difficult public web access. Use the headline “Unlock the web. With one API.” and a graphite, lime and cyan visual system. The primary journey is signup, project creation, API key, first request and response inspection.

The initial deliverable was a non-indexed, clickable design preview. The subsequent P0 implementation connects signup and the workspace to the real gateway and PostgreSQL; marketing illustrations and proposed commercial terms remain labelled. The gateway contracts remain the documented v1 reviewed workflows and v2 native HTTP fetch. A proposed intelligence layer is shown as a product concept.

## Implementation ownership

The lead owns the shared layout and theme, discoverability exports, documentation integration, acceptance checks and this backlog. Sol marketing owns the homepage, pricing and developer introduction. Sol content owns product/use-case pages and initial resources. Sol product owns the synthetic signup and console journey. Shared changes are integrated serially. Existing backend edits belong to their ongoing work.

## Planned public content

Four product pages cover the scraping API, web unblocker, JavaScript rendering and proxy management. Three use cases cover AI agents, price monitoring and real estate. Four guides explain web unblockers, scraping APIs versus proxies, JavaScript rendering and web data for AI. Retain all eight documentation routes and provide Markdown exports from their source content. About, contact, pricing and the developer introduction complete the public journey.

## Prioritized launch backlog

The P0 software implementation and operator setup are documented in [self-service backend](self-service-backend.md). Identity, projects, scoped keys, approved HTTP source admission, the first-request bridge, retained history and conservative credits are implemented locally. Commercial approval, production mail delivery, measured paid-route economics and deployment are release gates; a local passing test does not approve or activate them. Account keys deliberately remain HTTP-only while the P1 browser and AI work is outstanding.

| Priority | Capability | Required backend work | Acceptance before publication |
| --- | --- | --- | --- |
| P0 | Self-service identity and projects | Verified account authentication, project provisioning, session lifecycle and abuse limits | Signup, verification, login, expiry and account isolation work end to end |
| P0 | Scoped API keys | Server-generated credentials, one-time disclosure, hashed storage, rotate/revoke and project ownership | Revocation takes effect and another project cannot use/read keys |
| P0 | Safe source admission | Resolve user URLs into reviewed source policies, enforce destination/method/redirect and credential restrictions | SSRF/redirect rejection, forbidden destinations and approved sources tested |
| P0 | First real request | Connect authenticated playground to existing gateway operations through a server boundary | Source outcome, gateway status and application acceptance remain distinct |
| P0 | Recovery and request history | Project-scoped durable operation lookup and retained diagnostics | Lost responses and unknown work recover without duplicate source activity |
| P0 | Pricing and credits | Cost measurement, route/render weights, conservative holds, settlement and limits | Unit economics approved; reservations and uncertain charges survive retries/concurrency |
| P0 | Commercial approval | Approve proposed trial and plan allowances, billing terms and account-related notices | Displayed prices match billing and failure/usage treatment is explained |
| P1 | Unified execution options | Versioned additive request facade for approved native/rendered workflows | HTTP and browser capabilities accurately advertised; existing callers remain compatible |
| P1 | Browser runtime qualification | Complete runtime, network containment, state restoration and source qualification | Real browser recipe suite and source-specific acceptance pass |
| P1 | AI request diagnosis | Define input provenance, model/provider boundaries, cost caps, evaluation dataset and review process | Measured diagnostic accuracy, sensitive-data handling and failure behavior verified |
| P1 | Strategy recommendations | Rank only approved route/recipe choices, with explicit application gates | No policy widening or retry/provider switch after uncertain/stateful work |
| P1 | Response evaluation | Source-specific schema/context checks, evidence-backed classification | HTTP success alone never becomes application acceptance |
| P1 | Billing integration | Authoritative payment webhook processing, ledger reconciliation and idempotency | Concurrent events, duplicate deliveries, failed payments and credits exhausted verified |
| P2 | AI-agent integration | Publish tested framework/MCP interfaces and integration guides when implemented | Examples run through actual supported interfaces |
| P2 | Search measurement | Verify Search Console access, publish sitemap, review referral and conversion reports | Track relevant queries and real citations after the approved launch |

## Discoverability and release checks

Use server-rendered HTML, unique metadata, canonical URLs, structured data matching visible content, public-page sitemaps and machine-readable documentation. Auth, console and preview routes stay non-indexed. Production indexing requires both the production environment and an explicit product-launch-ready flag.

Review Googlebot, OpenAI search and Anthropic search/retrieval access against current official crawler guidance and the actual Cloudflare settings at launch. Google-Extended covers Gemini grounding and training uses. The local preview can verify generated directives; the hosting crawl policy must be independently checked during release.

Before public launch, each advertised capability needs implementation evidence and approved commercial terms. Keep synthetic metrics labelled in the design. Approve original benchmarks, testimonials or logos before adding them.

## Verification

Check the build, types, website unit tests, responsive layouts, keyboard flow, copy controls, docs search, metadata, internal links, structured data and Markdown exports. Routine product browser tests use synthetic control responses and make no source/provider calls. The separate, manually invoked `control-live-check.mjs` requires the guarded local review configuration and tests one actual direct example.com request through the real backend; it never retries uncertain work. Check mobile Lighthouse on representative marketing pages, targeting performance of at least 90.

### Review receipt — 2 November 2026

- Astro and worker TypeScript checks passed with zero errors or warnings; static build produced 38 HTML pages including the 404 page.
- Website unit suite passed all 37 tests, including enquiry validation, retention, notifications and deduplication. The notice version recorded on new enquiries matches the updated visible privacy notice.
- All 29 public routes passed unique metadata, canonical, sitemap, internal-link and structured-data checks. All eight documentation pages retain search, copy, keyboard tabs and mobile navigation; their Markdown exports and `/llms.txt` passed.
- Public layouts passed 116 checks across widths 360, 768, 1024 and 1440. Eight product routes passed another 32 checks at the same widths. No horizontal page overflow remained.
- Automated WCAG A/AA checks found zero violations on 29 public pages, eight product pages and four active product states (signup key reveal, unknown recovery, request details and key reveal). Desktop and mobile screenshots were reviewed separately.
- The full synthetic journey passed: signup, invalid/correct verification, project creation, fake-key copy, first request, language generation, direct/browser route differences, all five scenarios, request filtering/details, saved-only recovery, key rotation/revocation, proposed plan selection, spending preferences, reset and replay. Interrupted samples retain an unknown outcome and reservation. No typed identity, custom URL or revealed fake-key string is persisted. No browser-side external source requests or console errors were observed.
- The existing enquiry interface passed its closed/unconfigured state and synthetic success, validation, storage-failure and network-failure flows without contacting live email or verification providers.
- Mobile Lighthouse lab results: homepage **100 performance / 100 accessibility / 100 best practices**; Web Scraping API page **100 / 100 / 100**; Resources **100 / 100 / 100**. Measured LCP was about 0.9 seconds and CLS 0.001–0.002 on the local preview. These are local lab measurements, not production field claims.

Evidence is generated locally under `website/.local/browser-reports/`: `site-checks.json`, `product-checks.json`, `form-checks.json`, `performance-summary.json`, full Lighthouse reports and desktop/mobile screenshots. Verification scripts are retained under `website/tests/ui/` and `website/ops/performance-check.mjs`.

That design-only receipt predates the P0 account integration below. The initial redesign did not change the gateway; the subsequent account work adds the reviewed backend boundary without replacing existing provisioned contracts.

### P0 account integration — 2 November 2026

- Added PostgreSQL-backed email verification, sessions, memberships, project provisioning and scoped keys. Key hashes, rotation and revocation are authoritative on the gateway. Only the first project per verified account receives the configured trial grant.
- Connected the website through a private server bridge with exact origins, HttpOnly cookies, CSRF, bounded payloads and no automatic POST retry. The workspace reads actual approved profiles, request outcomes, latency, credit balances and holds.
- Added credit reservations to existing admission/completion transactions. Concurrent admissions cannot overspend; replay does not charge again. Proven predispatch cancellations release credits; possible dispatches retain holds through recovery and restart.
- Native HTTP account keys do not grant v1/browser execution, residential access, arbitrary source grants, subscription changes or automatic refills. Source-response success remains distinct from application acceptance and provider invoice reconciliation.
- The local review is non-indexed at `http://127.0.0.1:4331/`. Its separate disposable gateway allows direct GET/HEAD of example.com only; verification goes to a private local mailbox, with no real email or paid-provider calls.

Production release still requires approved mail and bridge configuration, backup/migration review, real inbox acceptance, qualified advertised capabilities, commercial terms, measured paid-route economics and hosting crawler review. Public prices remain proposals; the local review allocation is not an offer.

#### P0 verification receipt

- Backend suite: **258 passed, zero failures, two skipped** against the explicit disposable `gateway_test_selfservice20261102` database, serially. The real Chromium recipe and network-containment checks passed. The two skipped tests are optional Camoufox diagnostics; its qualification gate remains intact.
- Website: **50 unit tests passed**, including the server proxy and existing enquiry flows. Astro/worker checks reported zero errors, warnings or hints across 64 files; the build produced 38 pages.
- Native browser acceptance: **146 checks passed**, with one deliberate source POST to example.com and one retained-result GET. Verified signup, project creation, one-time scoped-key disclosure, actual response content, usage and latency, key rotation/revocation, logout and unauthenticated gating. **30 accessibility audits and 30 layout checks passed**, with zero JavaScript errors, external browser requests or exposed bridge headers.
- All 29 public routes retained their metadata, internal links, structured data, noindex controls and machine exports; 116 public responsive checks and all public accessibility audits passed. The eight docs routes retained search, keyboard tabs, code copy and mobile navigation.
- Synthetic UI regressions separately passed six journey groups and **17 clean accessibility audits**, including populated output, diagnostics and code panels at desktop/mobile widths. They cover unknown responses, interrupted connections, missing saved results, unavailable backend, isolation of browser storage and keyboard interaction without source calls. Unknown results retain their original operation key and do not trigger an automatic POST.

Reproduction commands are in [self-service backend](self-service-backend.md). Local evidence: `.local/selfservice-backend-suite-final.log`, `.local/selfservice-browser-native-accepted.log`, website unit/check/build logs, and `website/.local/browser-reports/`. These results establish the local implementation, not production deployment, email inbox delivery or commercial approval.
