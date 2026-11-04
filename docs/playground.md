# Self-service playground implementation

## Outcome

Make the playground useful for ordinary public-website experiments: enter a URL,
choose HTTP or Browser, select an available proxy and country, use a named project
key, and inspect the response and its cost. Browser access has no per-user
qualification. Platform runtime readiness, destination restrictions and ordinary
credit/resource limits remain server responsibilities.

The implementation is local until deployment is separately authorized. No new
provider purchase, paid entitlement or production policy activation is included.
The existing workflow and native fetch contracts remain compatible.

## Shared contract

- Project details add `capabilities.playground` describing execution modes and
  route/country availability with actionable reasons.
- `POST /control/projects/:id/playground/prepare` accepts a URL, execution,
  method, proxy and optional named `key_id`. It performs no source or DNS
  request. It returns `ready`, a deterministic project-owned profile reference,
  eligible key metadata and selection, capabilities, a bounded credit/cost quote,
  and field-specific errors.
- HTTP dispatch stays at `/control/projects/:id/fetch` and `/v2/fetch`.
  Browser dispatch adds `/control/projects/:id/render` and `/v2/render`, with
  original-key GET recovery. Control `key_id` is metadata, never a raw secret;
  trusted membership/identity fields are derived by the server.
- Public render results retain the fetch envelope's distinction between
  gateway outcome, source HTTP status and application acceptance. Browser DOM,
  safe response headers and optional bounded screenshots are retained artifacts.
- Existing operations keep their original attribution on replay/recovery.
  Replays do not create sessions, provider work or another charge.

## Access and accounting

An explicit, reviewed, versioned `controlPlane.playground` policy is separate
from the identity project template. Existing template hashes, keys, project IDs
and credit grants do not need to change to activate that policy. Legacy static
profiles retain their restrictions and existing unconfigured-console behavior.

Preparation derives an exact-origin reference scoped to project, policy version
and execution. Dispatch validates and materializes the bound policy durably;
clients cannot supply origins, grants or limits. Profiles are reused and capped
per project. Private/internal destinations and forbidden paths/redirects remain
blocked before dispatch. Cross-origin browser resources require an explicitly
permitted origin; blocked resources must be visible in result diagnostics.

Usable route/country pairs are the intersection of platform configuration,
policy, provider health, transport support, pricing and credits. Direct never
claims a country. The UI uses country names and ISO codes, but cannot enable a
country the selected route does not support.

The sole active eligible key is selected automatically; multiple keys require a
named choice. Transactions recheck key scope/revocation, project membership and
balance. Secrets stay hashed server-side and never enter client storage or
generated examples. Reviewed mode weights extend customer credits to Browser
and residential traffic. HTTP-only datacenter pricing attestations do not
implicitly authorize browser pricing.

Browser interception admits every hop before allowing dispatch on a pinned
transport. Do not retry uncertain source work, change provider/country after
stateful work, disable browser security, or confuse a local fixture with source
acceptance. Possible dispatch retains conservative credit/provider reservations.

## Work and verification

1. **Recovery and inspector repair:** snapshot project/operation identity around
   asynchronous work; keep one or many pending keys accessible from a fresh
   draft; retain unknown keys; bound body fields without slicing JSON envelopes.
2. **Managed backend:** preparation, durable profiles, selected-key enforcement,
   route/country discovery, mode-aware credits and preserved old-project access.
3. **Browser path:** per-hop admission, pinned transport, bounded DOM/screenshot
   artifacts, durable render facade, recovery and accounting.
4. **UI:** URL-first form, automatic profile resolution, named key selection,
   mode/route/country controls, cost summary, clear response views, separate send
   and recovery examples with fresh operation keys, and compact responsive layout.
5. **Integration:** compatibility, identity isolation, concurrent reservations,
   uncertain recovery, redirect/private-address tripwires, and real local browser
   fixtures. Run database tests serially on an explicitly disposable
   `gateway_test_*` PostgreSQL database, using synthetic providers only.

Ownership is divided between control/policy, browser execution, V2 facade/bridge
and UI workers. Recovery repair precedes the UI's changes to its shared script.
The lead owns contract review, integration, documentation and serial validation.
Workers do not delegate. Concurrent unrelated changes must be preserved.

## Local verification — 2026-11-04

The implementation passed the serial gateway suite against a disposable
PostgreSQL database: 303 tests passed and two optional Camoufox checks were
skipped. The real Chrome recipe and pinned TLS transport fixtures passed,
including redirect admission, blocked egress and uncertain-dispatch behavior.
These fixtures verify browser mechanics. Runtime qualification is tied to the deployed executable and host.

The website passed 139 unit tests, type checking with zero diagnostics, a
38-page production build, and nine browser check groups with 18 accessibility
audits. A separate signed-in integration used the actual built Astro UI,
control bridge, Fastify gateway and disposable PostgreSQL, with synthetic
source responses, DNS, proxy transport and browser execution. Native HTTP and
US datacenter Browser operations retained the selected named key, and GET
recovery returned the original operation without another dispatch or charge.
Desktop and 390 × 844 mobile layouts were also inspected manually.

Production configuration and deployment are still separate rollout steps. See
[Playground configuration](playground-configuration.md) and the acceptance
criteria below; no live US egress or Cuyahoga source acceptance is claimed by
these local checks.

## Release acceptance

A normal account should be able to enter `https://myplace.cuyahogacounty.gov/`,
select United States and an available proxy, choose HTTP or Browser, and inspect
the source result. Verify actual egress and expected source content, not a bare
HTTP 200 or a successful fixture. Verify key attribution, history, conservative
cost accounting and recovery without redispatch. A missing configured US route
or platform browser build is a deployment-readiness gap, not a successful test.

Rollout must retain operations, artifacts and held reservations. Disabling new
playground admission must not disable read-only recovery of retained work.
Existing identity templates and trial allocations are not reset during rollout.
