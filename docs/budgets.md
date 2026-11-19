# Budgets

Every limit on what FetchX spends with providers, or gives away, is a budget: a value from `gateway.json` (or a code default) that an operator can change in the admin portal at `https://fetchx.ai/app/admin` (Budgets tab) without a redeploy. The definitions, bounds and enforcement helpers are in `src/budgets.mjs`.

```
effective value = portal override ?? gateway.json ?? code default
```

- **Bounded.** Each budget has hard bounds in code. A value outside them is refused (`budget_value_invalid`, 400), and a config value outside them stops the feature it guards (for captchas, `captcha_budget_unconfigured`) rather than running unbounded.
- **Versioned.** A change names the version it read; a stale version is refused (`budget_version_conflict`, 409).
- **Audited.** Every change records the operator, a required reason, and the value and source before and after (`budget_audit`). Budget changes appear in the portal's audit log next to rule changes.
- **Live.** A change applies to the gateway that saved it at once; the gateway also reloads overrides every `providerRulesRefreshMs` (30 s). Reset removes the override, so the config value applies again.

| Budget | Config key | Default | Bounds | Effect |
| --- | --- | --- | --- | --- |
| `captcha.maxDailyMicroUsd` | `captcha.maxDailyMicroUsd` | required | 0 to $5 | 2Captcha spend over a rolling 24 hours. 0 pauses solving. |
| `captcha.maxTotalMicroUsd` | `captcha.maxTotalMicroUsd` | required | 0 to $50 | 2Captcha spend ever recorded. |
| `captcha.maxProjectDailyMicroUsd` | `captcha.maxProjectDailyMicroUsd` | same as daily | 0 to $5 | One project's 2Captcha spend over 24 hours. |
| `captcha.maxTaskMicroUsd` | `captcha.maxTaskMicroUsd` | required | $0.000001 to $0.02 | Reserved before each task. |
| `captcha.maxTotalTasks` | `captcha.maxTotalTasks` | required | 0 to 100,000 | Captcha tasks ever created. |
| `captcha.maxTasksPerRequest` | `captcha.maxTasksPerRequest` | 4 | 0 to 10 | Solves one request may use. |
| `residential.<provider>.maxDailyMb` | `residential.providers.<provider>.maxDailyMb` | no cap | 0 to 10 TB | Evomi or DataImpulse traffic over 24 hours. |
| `residential.<provider>.maxMonthlyMb` | `residential.providers.<provider>.maxMonthlyMb` | no cap | 0 to 10 TB | The same per UTC calendar month. |
| `autoscaler.monthlyBudgetMicroEur` | none | host config | 0 to €1,000 | Worker VM spend per UTC month; see below. |
| `autoscaler.maxAdditionalWorkers` | none | host config | 0 to 64 | Extra worker VMs at once; see below. |
| `fetch.maxAttempts` | `fetchLimits.maxAttempts` | 5 | 1 to 5 | Attempts auto mode makes per request. A caller's `max_attempts` can only lower it. |
| `admin.maxProbesPerDay` | `controlPlane.admin.maxProbesPerDay` | 20 | 0 to 1,000 | Reachability probes started in 24 hours. |
| `fetch.maxCreditsPerRequest` | `fetchLimits.maxCreditsPerRequest` | 100,000 | 1 to 100,000 | The most a metered request may reserve, with or without `max_credits`. |
| `fetch.maxConcurrentPerProject` | `fetchLimits.maxConcurrentPerProject` | 10 | 1 to 1,000 | Requests running at once per project (`too_many_requests`). |
| `billing.trialCredits` | `controlPlane.creditPolicy.trialCredits` | 1,000 | 0 to 1,000 | Trial credits per new verified user. |

Money is stored in millionths (micro-USD, micro-EUR), traffic in MB (10^6 bytes).

## Residential traffic

Residential traffic per provider is summed from `fetch_attempts.wire_bytes` (24 hours and the current UTC month) and cached for 5 seconds; auto mode refreshes it before each request. When a provider reaches a cap, auto mode skips it and uses the other provider; when both are capped, residential steps are `not_admitted` with code `residential_budget_exhausted`, which costs the caller nothing and does not count as an attempt. A request that asked for a residential `route` explicitly fails with `route_unavailable` and `next.action: retry_later`. A cap of 0 stops the provider. Requests already running can pass a cap by at most one response each. Reachability probes are not counted.

## Worker VMs

The autoscaler runs as root on the host and keeps its own limits in `/etc/fetchx-autoscaler/config.json`. The gateway sends the portal's values in `/v1/pool-metrics` as `limits`, and the autoscaler applies them only up to two ceilings in its host config:

- `monthly_budget_ceiling_micro_eur` (default: `monthly_budget_micro_eur`)
- `max_additional_workers_ceiling` (default: `max_additional_workers`, at most 64)

Without the ceiling keys, the portal can only lower the host limits. To let it raise them, set the ceilings above the host values once. With no portal value, the host values apply. The last limits the gateway sent are kept in the autoscaler's ledger, so a restart or a failed metrics read never loosens them; malformed limits stop growth (`metrics_invalid`). With each metrics read, the autoscaler reports its effective limits, its ceilings and the month's committed spend (header `X-FetchX-Autoscaler`); the Budgets tab shows that report.

## API

Operator-only, through the console bridge (`/api/control`):

- `GET /admin/budgets`: every budget with `value`, `default` (without the override), `source` (`database`, `config`, `default`), `min`, `max`, `version`, `used` (where there is a window), and the autoscaler's last report.
- `PUT /admin/budgets/:key` with `{value, version, reason}`: `value` is an integer, or `null` where the budget allows it. `version` is 0 for a budget that was never changed.
- `POST /admin/budgets/:key/reset` with `{version, reason}`.
- `GET /admin/budgets/:key/audit`.

Each budget has an `owner`: `engine` budgets cap provider spend (captchas, residential traffic, worker VMs, attempts, probes); `platform` budgets cap what accounts get (credits per request, concurrency, trial credits). Once the engine runs as its own service, engine budgets live in the engine database behind its private admin API, and the platform's admin routes forward to it.
