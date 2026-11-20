# Budgets

A budget is a limit with hard bounds in code, a value from config (or a code default), and an optional override an operator saves in the admin portal at `https://fetchx.ai/app/admin` (Budgets tab), without a redeploy:

```
effective value = portal override ?? config ?? code default
```

The platform keeps the budgets on what accounts get, in its own database (`src/budgets.mjs`). The engine keeps the budgets on what it spends with providers (2Captcha, residential traffic per provider, worker VMs, attempts per job, reachability probes) in its database, behind its private admin API; see `docs/budgets.md` in the engine repository. The Budgets tab shows both lists together, and the audit log shows changes from both.

- **Bounded.** A value outside the bounds is refused (`budget_value_invalid`, 400), and a config value outside them stops what it guards (`budget_unconfigured` or, for trial credits, `credit_policy_invalid`, 503) rather than running unbounded.
- **Versioned.** A change names the version it read; a stale version is refused (`budget_version_conflict`, 409).
- **Audited.** Every change records the operator, a required reason, and the value and source before and after (`budget_audit`). Budget changes appear in the portal's audit log as `rule_id` `budget:<key>`.
- **Live.** A change applies to the platform at once; the platform also reloads overrides every 30 s. Reset removes the override, so the config value applies again.

| Budget | Config key | Default | Bounds | Effect |
| --- | --- | --- | --- | --- |
| `fetch.maxCreditsPerRequest` | `fetchLimits.maxCreditsPerRequest` | 100,000 | 1 to 100,000 | The most a metered request may reserve, with or without `max_credits`. Steps that cost more are not allowed; a request whose cheapest planned step costs more gets `max_credits_too_low`. |
| `fetch.maxConcurrentPerProject` | `fetchLimits.maxConcurrentPerProject` | 10 | 1 to 1,000 | Requests running at once per project (`too_many_requests`, 429). A project's own `projects.<id>.maxConcurrentRequests` still wins. |
| `billing.trialCredits` | `controlPlane.creditPolicy.trialCredits` | 1,000 | 0 to 1,000 | Trial credits per new verified user. Grants already made are not changed. |

## API

Operator-only, through the console bridge (`/api/control`). A key the platform owns is answered here; any other key is forwarded to the engine's `/internal/v1/admin/budgets` with the operator as `X-FetchX-Actor`, and the engine's answer or refusal comes back unchanged.

- `GET /admin/budgets`: every budget, the engine's first, with `owner` (`engine` or `platform`), `value`, `default` (without the override), `source` (`database`, `config`, `default`), `min`, `max`, `version`, `used` (engine budgets with a window), and `autoscaler`, the autoscaler's last report.
- `PUT /admin/budgets/:key` with `{value, version, reason}`: `value` is an integer, or `null` where the budget allows it. `version` is 0 for a budget that was never changed.
- `POST /admin/budgets/:key/reset` with `{version, reason}`.
- `GET /admin/budgets/:key/audit`.
- `GET /admin/audit`: the engine's audit trail (rules, forgotten sites, its budgets) and the platform's budget changes, newest first.

Before the split, the single gateway kept every budget in this database. The one-time migration (`scripts/split-migrate.mjs`) copies the engine's overrides and their audit rows to the engine; the platform never reads the engine's rows left here, and they are dropped with the gateway's other tables after the cutover.
