# Plan: routing rules admin portal

Status: steps 1–2 built (database rules, loader, refresh, operator CLI; operator role and admin API). Steps 3–5 are planned.

## Goal

Let operators see and change FetchX's routing knowledge without editing the gateway config by hand or redeploying:

- **Provider rules:** which proxy provider must not be used for which hosts (for example, no Oxylabs for `.gov`).
- **Source profiles' routing fields:** country, proxy class, execution (HTTP/browser), engine and engine fallback, `maxRouteAttempts`, `maxSessionRenewals`.
- **Reachability probe results:** run a probe for a host, review the proposal, and apply it with one click.

## Where it lives

FetchX already has a control plane (`src/control.mjs`: Fastify routes, sessions, CSRF, project membership) and a static console (`src/console/`). The portal is a new **operator-only** area in that console, under `/console/admin`, backed by `/control/admin/*` routes. It is not a separate app.

## Data model (moving rules from config to the database)

Today rules come from `src/provider-rules-defaults.mjs` plus `config.providerRules`. The portal needs editable, audited storage:

```sql
CREATE TABLE routing_rules(
  id text PRIMARY KEY,                -- e.g. oxylabs-gov
  provider text NOT NULL,             -- oxylabs|scrapedo|evomi|dataimpulse
  match jsonb NOT NULL,               -- {"host": ...} | {"hostSuffix": ...}
  action text NOT NULL DEFAULT 'exclude',
  reason text NOT NULL,
  evidence jsonb,                     -- probe id, statuses, observed_at
  enabled boolean NOT NULL DEFAULT true,
  source text NOT NULL,               -- default|config|portal|probe
  version int NOT NULL DEFAULT 1,
  updated_by text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE routing_rule_audit(id bigserial PRIMARY KEY, rule_id text NOT NULL, action text NOT NULL, before jsonb, after jsonb, actor text NOT NULL, at timestamptz NOT NULL DEFAULT now());
CREATE TABLE reachability_probes(id uuid PRIMARY KEY, host text NOT NULL, countries text[] NOT NULL, report jsonb NOT NULL, requested_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), applied_at timestamptz);
```

- **Precedence:** shipped defaults < config < portal (database). A database row with the same `id` overrides the default or config rule; `enabled=false` disables it.
- **Loading:** `provider-rules.mjs` keeps the same interface (`providerRule(config, provider, host)`). The gateway loads the effective rule set at start and refreshes it on a short interval (or a Postgres `NOTIFY` after each write), validating with the existing `validRule`. A rule that fails validation is rejected at write time and never loaded.
- **Profiles:** routing fields move to a `source_profile_overrides` table (profile id → validated JSON patch of an allow-listed set of fields). They are applied through `residentialPolicy` validation, so the portal can never set an invalid value. Secrets (proxy URLs, credentials, license keys) are never stored or shown here.

## API (operator role only)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/control/admin/rules` | Effective rules with source (default/config/portal), enabled, evidence and last change |
| POST | `/control/admin/rules` | Create a rule (validated; 409 on duplicate id) |
| PUT | `/control/admin/rules/:id` | Edit; optimistic concurrency with `version` |
| POST | `/control/admin/rules/:id/disable` / `enable` | Toggle without deleting |
| DELETE | `/control/admin/rules/:id` | Portal rules only; defaults can only be disabled |
| GET | `/control/admin/rules/test?provider=&host=` | "Would this provider be used for this host?" |
| GET | `/control/admin/profiles` / PUT `/control/admin/profiles/:id/routing` | View and edit allow-listed routing fields |
| POST | `/control/admin/probes` | Run the reachability probe (async job; rate-limited; bounded hosts and countries) |
| GET | `/control/admin/probes/:id` | The matrix and proposal |
| POST | `/control/admin/probes/:id/apply` | Apply selected proposed rules and profile fields (each change audited) |
| GET | `/control/admin/audit` | Change history |

**Authorization:** a new `operator` role on control-plane users. The first operator is granted out of band (operator CLI); a project member cannot reach these routes. Writes use the existing CSRF token and session checks, and every change writes the audit row in the same transaction.

## UI

1. **Rules:** a table of provider, match, reason, source badge, enabled toggle, last changed by and when, with filters and a "test a host" box.
2. **Rule editor:** a form with a provider select, match type (host or suffix) and value, reason and evidence. Live validation and a preview of which known profile hosts it affects.
3. **Profiles:** routing fields per source profile, with the current effective values and an edit form limited to safe fields.
4. **Probe:** enter a host and countries, then watch the matrix fill in (`provider × class × country` → result chip). Review the proposal (countries, refusing providers, recommended route) and apply the selected items.
5. **Audit log:** who changed what and when, with before/after diffs.

## Safety

- Rules can only exclude; the portal cannot add providers, widen countries beyond the profile's reviewed list or touch budgets.
- Probes use the existing probe limits (CONNECT → TLS → one capped GET, paced, no browser) and a per-day probe budget.
- Defaults cannot be deleted, only disabled, with a reason.
- No secrets in any response; responses are redacted like other control-plane views.

## Delivery steps

1. **Done:** database tables plus a loader with the precedence rules; the gateway reads rules from the database and refreshes them (config and defaults still work); audited, versioned save/enable/disable/delete; operator CLI (`node src/operator.mjs rules …`). Tests.
2. **Done:** operator role (`control_operators` + `control_operator_audit`, granted with `node src/operator.mjs operators grant <email>`) and the admin API (rules list/create/edit/enable/disable/delete, host test, audit), gated by `controlPlane.admin.enabled`, plus the website bridge allowlist. No query strings: the host test is `POST /admin/rules/test`, and per-rule audit is `GET /admin/rules/:id/audit`. Profile routing-field edits move to step 3 with the probe. Tests.
3. Probe as an async job with stored reports, and the apply endpoint.
4. Console UI pages (rules, editor, probe, audit), then profiles editing.
5. Docs and a migration note: existing `config.providerRules` keep working and show up as source "config".
