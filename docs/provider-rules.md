# Provider rules, failure layers and reachability probes

FetchX keeps site knowledge out of code. What it learns about destinations is expressed as configuration: profile fields and provider rules.

## Provider rules

A provider rule removes one proxy provider from consideration for matching destination hosts:

```json
{
  "providerRules": [
    {"id": "evomi-shop", "provider": "evomi", "match": {"host": "shop.example.com"}, "action": "exclude", "reason": "Provider refuses this host"}
  ]
}
```

- `provider`: `oxylabs`, `scrapedo`, `evomi` or `dataimpulse`.
- `match`: exactly one of `host` (exact hostname) or `hostSuffix` (starting with a dot, for example `.gov`; matches `x.gov` and the bare label `gov`).
- `action`: `exclude` (the only action). Rules never add routes, widen profiles or bypass budgets.
- `enabled: false` disables a rule. A config rule with the same `id` as a default replaces it.

Precedence: shipped defaults (`src/provider-rules-defaults.mjs`) < `config.providerRules` < database rules (operator CLI now, admin portal later). A later layer with the same `id` replaces the rule entirely.

Reviewed defaults ship in `src/provider-rules-defaults.mjs`. The first default is `oxylabs-gov`, which excludes Oxylabs for `.gov` hosts. On 2026-11-16 Oxylabs answered CONNECT with HTTP 444 for `myplace.cuyahogacounty.gov`, `www.cuyahogacounty.gov`, `www.usa.gov`, `ohio.gov`, `www.irs.gov` and `www.clevelandohio.gov`, from US, CA and GB exits, while `example.com` worked through the same proxy.

Enforcement, always before any reservation or dispatch, so an excluded provider is never charged:

- **v1 datacenter (Oxylabs) and Scrape.do:** the operation fails with `provider_host_excluded` (HTTP 409, details: provider, rule, host). Scrape.do fallback is skipped when Scrape.do is excluded.
- **v1 residential:** excluded providers are skipped in the route ladder. A workflow whose first route is excluded for the requested host starts its first GET on the next allowed route. Provider fallback, session renewal and the CloakBrowser fallback skip excluded routes. If none is left, `provider_host_excluded`.
- **v2:** a session's datacenter or residential provider is checked against the request host and every redirect host. The request fails with `provider_host_excluded` and nothing is sent.

## Failure layers

Native transport failures now say which layer failed:

| Error | Outcome category | Meaning |
| --- | --- | --- |
| `provider_target_refused` | `provider_refused` | The proxy provider answered CONNECT with a 4xx (for example 403, 444, 451). The source was never contacted. It does not count against route health. Residential fallback and Scrape.do fallback may try another provider. |
| `provider_account_rejected` | — | CONNECT 401/402/407: provider credentials or access. |
| `source_unreachable` | `source_unreachable` | The proxy answered CONNECT 502/503/504: it could not reach the destination, which is the usual sign of a country or IP-type firewall. It does not count against route health and may fall back to another provider. |
| `proxy_connect_failed` | `transport_failure` | The proxy or the tunnel failed in another way. |
| `source_denied` / `source_challenge` / `rate_limited` | as named | The source answered at HTTP level. |

v2 already reports CONNECT status and stage in its diagnostics (`proxy_connect_rejected` with `provider_status`).

## Reachability probe

Operators can measure how a new host can be reached before writing its profile:

```bash
GATEWAY_CONFIG=/run/secrets/gateway.json node scripts/probe-reachability.mjs myplace.cuyahogacounty.gov US,CA,GB,DE
```

For each country it probes one configured datacenter proxy and each enabled residential provider. Each probe runs CONNECT → TLS → one `GET /`, with the body capped at 64 KiB and about 1 s between probes. It never runs a browser, never sends cookies or credentials to the source, and prints only metadata (no bodies, proxy URLs or secrets). Cells excluded by a provider rule are skipped unless you pass `--include-excluded`.

Per cell, `result` is one of: `ok`, `challenge`, `denied`, `rate_limited`, `upstream_error`, `provider_refused`, `account_rejected`, `unreachable` (the proxy could not reach the host, or TLS/HTTP failed through an open tunnel: the usual sign of a country or IP-type firewall), `proxy_failed` or `excluded_by_rule`.

The summary turns the matrix into generic facts:

- `reachable_countries` / `unreachable_countries` / `geo_restricted`
- `provider_refused`: providers that refused in every probed country. `proposed_provider_rules` holds a host rule for each.
- `datacenter_blocked_countries`: the datacenter route fails where residential in the same country succeeds.
- `recommended_route`: the cheapest route that returned `ok` (datacenter, then residential HTTP). It falls back to an unverified residential browser suggestion when residential only reached a challenge.
- `proposed_profile`: `v1` (`country`, plus `routingPolicy`/`execution` when residential) and `v2` (`countries`, `proxy_classes`).

The output is a proposal. An operator reviews it and applies the profile fields and rules. Nothing is changed automatically.

## Database rules and the operator CLI (admin portal step 1)

Rules can also live in the database (`routing_rules`), with every change recorded in `routing_rule_audit` (actor, before, after, time). The gateway loads them at start and refreshes them every `providerRulesRefreshMs` (default 30000; 1000–3600000), so edits apply without a restart. An invalid row is skipped and reported (`provider_rules_rejected`); it never breaks routing.

```bash
FETCHX_OPERATOR=you@example.com node src/operator.mjs rules list            # effective rules with source: default | config | database
FETCHX_OPERATOR=you@example.com node src/operator.mjs rules save rule.json  # create, or update the existing database rule (versioned)
FETCHX_OPERATOR=you@example.com node src/operator.mjs rules disable oxylabs-gov Oxylabs enabled .gov for our account
FETCHX_OPERATOR=you@example.com node src/operator.mjs rules enable oxylabs-gov re-check failed
FETCHX_OPERATOR=you@example.com node src/operator.mjs rules delete evomi-records   # database rows only; deleting an override restores the default/config rule
FETCHX_OPERATOR=you@example.com node src/operator.mjs rules audit [rule-id]
```

- **Versions:** saves use optimistic versions. Creating an id that already exists, or saving over a stale version, returns `rule_version_conflict`.
- **Overriding defaults and config:** enabling or disabling a default/config rule writes a database override, and requires a reason.
- **Deleting:** default and config rules cannot be deleted; disable them instead.

The admin portal (see `docs/plans/admin-portal.md`) builds on these same functions.

## Admin API (admin portal step 2)

Operators manage rules over the control plane. It is disabled unless `controlPlane.admin.enabled` is `true`. Operators are granted out of band:

```bash
FETCHX_OPERATOR=you@example.com node src/operator.mjs operators grant ops@example.com   # a verified control-plane user
FETCHX_OPERATOR=you@example.com node src/operator.mjs operators revoke ops@example.com
node src/operator.mjs operators list
```

Grants and revocations are recorded in `control_operator_audit`. Revocation takes effect on the next request. All routes use the normal control-plane session, exact origin and session-bound CSRF. They are reached through the website bridge at `/api/control/admin/...`, accept no query strings, and return `operator_required` (403) to non-operators. Writes apply to the running gateway immediately; other gateways pick them up within `providerRulesRefreshMs`.

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| GET | `/admin/session` | — | `{operator, email}` |
| GET | `/admin/rules` | — | Effective rules with `source` (default / config / database), `overrides`, `version`, plus the allowed `providers` |
| POST | `/admin/rules` | `{rule}` | Creates a database rule (`rule_version_conflict` if the id exists) |
| PUT | `/admin/rules/:id` | `{rule, version}` | Replaces it; `version` must match (optimistic concurrency) |
| POST | `/admin/rules/:id/enable`, `/disable` | `{reason}` | Toggles any rule; for a default/config rule, writes a database override |
| DELETE | `/admin/rules/:id` | — | Removes a database rule (restores the default/config rule it overrode) |
| POST | `/admin/rules/test` | `{provider, host}` | `{excluded, rule, reason}`: would this provider be used for this host? (read-only) |
| GET | `/admin/rules/:id/audit`, `/admin/audit` | — | Audit entries (actor = operator email, before, after, time) |
