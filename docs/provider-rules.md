# Provider rules, failure layers and reachability probes

FetchX keeps site-specific behaviour out of code. A provider rule keeps one proxy provider away from some hosts; [site knowledge](site-knowledge.md) learns the rest from traffic.

## Provider rules

A provider rule removes one proxy provider from consideration for matching destination hosts:

```json
{
  "providerRules": [
    {"id": "evomi-shop", "provider": "evomi", "match": {"host": "shop.example.com"}, "action": "exclude", "reason": "Provider refuses this host"}
  ]
}
```

- `provider`: `oxylabs`, `evomi` or `dataimpulse`.
- `match`: exactly one of `host` (exact hostname) or `hostSuffix` (starting with a dot, for example `.gov`; matches `x.gov` and the bare label `gov`).
- `action`: `exclude` (the only action). Rules never add routes or bypass budgets.
- `enabled: false` disables a rule. A config rule with the same `id` as a default replaces it.

Precedence: shipped defaults (`src/provider-rules-defaults.mjs`) < `config.providerRules` < database rules (operator CLI and admin portal). A later layer with the same `id` replaces the rule entirely.

Reviewed defaults ship in `src/provider-rules-defaults.mjs`. The first default is `oxylabs-gov`, which excludes Oxylabs for `.gov` hosts. On 2026-11-16 Oxylabs answered CONNECT with HTTP 444 for `myplace.cuyahogacounty.gov`, `www.cuyahogacounty.gov`, `www.usa.gov`, `ohio.gov`, `www.irs.gov` and `www.clevelandohio.gov`, from US, CA and GB exits, while `example.com` worked through the same proxy.

Enforcement, always before anything is sent:

- **Planning:** a datacenter step whose provider is excluded for the host is skipped, and so is a residential step when both residential providers are excluded. Skipped steps are listed in the response's `skipped` with `excluded_by_provider_rule`.
- **Residential choice:** when one residential provider is excluded, the other carries the step.
- **Browser:** every host the page reaches, including redirect hops, is checked against the step's provider; a match is refused with `provider_excluded`.

## Failure layers

A refused CONNECT says which layer failed (`openProxyTunnel` in `src/fetch/transport.mjs`):

| Error | Meaning | In auto mode |
| --- | --- | --- |
| `provider_target_refused` | The proxy provider answered CONNECT with another 4xx (for example 403, 444, 451). The site was never contacted. | `not_admitted`: the next step runs; no attempt is used |
| `provider_account_rejected` | CONNECT 401/402/407: our provider credentials or access. | `not_admitted` |
| `source_unreachable` | The proxy answered CONNECT 502/503/504: the exit could not reach the site, the usual sign of a country or IP-type firewall. | `unreachable`, learned for the route |
| `proxy_connect_refused`, `proxy_connect_failed` | The proxy itself could not be reached. | `not_admitted` |

Answers from the site itself (403, a challenge page, 429, 5xx) are classified by `src/fetch/outcome.mjs`.

## Reachability probe

Operators can measure how a host can be reached, for example before writing a rule:

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

The output is a proposal. An operator reviews it and applies the proposed rules. A completed probe also seeds site knowledge for its `http` routes. Nothing else changes automatically.

## Database rules and the operator CLI

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

The admin portal builds on these same functions.

## Admin API

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

## Probe jobs and applying proposals

Probes run in the background on the gateway. `POST /admin/probes` returns at once with a probe id. Only one probe runs at a time (`probe_busy`, 409), and at most `controlPlane.admin.maxProbesPerDay` start in 24 hours (default 20, `probe_daily_limit`, 429). Each probe takes a public hostname and 1–6 country codes. A gateway restart marks unfinished probes `interrupted`; they never resume on their own. Reports are stored in `admin_probes` and hold metadata only (see "Reachability probe" above).


| Method | Path | Body | Result |
| --- | --- | --- | --- |
| GET | `/admin/probes` | — | The last 50 probes with state and a short summary |
| POST | `/admin/probes` | `{host, countries, include_excluded?}` | Starts a probe: `{probe: {id, state: "queued", …}}` |
| GET | `/admin/probes/:id` | — | The probe with its full stored report |
| POST | `/admin/probes/:id/apply` | `{rules: [id…]}` | Saves the chosen *proposed* rules, with the probe as evidence (`probe_not_complete`, `probe_apply_empty`, `probe_rule_not_proposed`) |

## Admin page

Operators manage all of this at `https://fetchx.ai/app/admin`: provider rules (list, add, edit, enable or disable with a reason, delete, host test), reachability probes (start, watch, per-cell results, apply proposed rules), site knowledge (hosts, their routes, forget a host) and the audit log.
