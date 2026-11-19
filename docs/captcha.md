# Captcha solving

Browser steps solve the captchas they meet, through [2Captcha](https://2captcha.com/api-docs), without any per-site setup. HTTP steps never solve; a challenge on HTTP moves auto mode to a browser.

| Captcha | How it is solved | 2Captcha task |
| --- | --- | --- |
| Cloudflare Turnstile | The token goes into the widget's response field, then the widget's callback or form | `TurnstileTaskProxyless` |
| reCAPTCHA v2 | The same, through `g-recaptcha-response` | `RecaptchaV2TaskProxyless` |
| hCaptcha | The challenge's image grid is screenshotted, the worker's clicks are applied, round by round, then the checkbox | `GridTask` |
| DataDome slider | The returned `datadome` cookie is set and the page reloaded (with `captcha.datadome: true`, residential browser steps only) | `DataDomeSliderTask` |

2Captcha no longer offers a dedicated hCaptcha token task, so hCaptcha is solved as image grids. DataDome requires solving from the same IP as the page, so the task carries the login of the attempt's residential proxy session (one exit IP, 30-minute lifetime) to 2Captcha. That is why it needs `captcha.datadome: true` (approved for production on 2026-11-19), and why it never runs on a datacenter step: datacenter credentials are never sent, and auto mode moves on instead. A DataDome captcha URL with `t=bv` means the IP is banned: the step fails with `captcha_ip_banned` without a task, and auto mode moves on.

## Waiting first

A wall that is a device check, not a captcha, passes by itself in a real browser on a clean IP. So a browser page that is a wall gets up to 45 seconds to clear by itself before anything is solved ([browser](browser.md#sessions-warm-up-and-walls)); a solve starts only if a captcha is still there afterwards. For DataDome, prefer a fresh IP over a solve: a long DataDome crawl measured that 2Captcha's DataDome cookie was refused because its workers solve from their own IPs, and on Expedia (2026-11-19) the cookie did not clear the page either. Setting `captcha.datadome: false` stops paying for those solves; auto mode then moves to a fresh IP instead.

## Where it happens

Detection and the page work run in the browser (`src/browser/page-captcha.mjs`), reading only public widget attributes. Solving runs in the gateway (`src/captcha/solver.mjs`), so the 2Captcha key never reaches a worker or a page. A capture asks the gateway for each solve through the `captcha` callback.

## Time

A solve starts only when at least 30 seconds of the request's `timeout_ms` remain, so FetchX does not pay for one that cannot finish. 2Captcha usually answers in 15-40 seconds, which is why `timeout_ms` defaults to 120 seconds (180 at most). A synchronous call still answers 202 after 60 seconds; poll or use a webhook for the rest.

## Budgets and records

`config.captcha` sets the limits: `maxTaskMicroUsd` (per task), `maxDailyMicroUsd`, `maxTotalMicroUsd`, `maxTotalTasks`, and `maxTasksPerRequest` (4). A task's cost is reserved before it is created; a budget that would be exceeded fails the solve with `captcha_budget_exhausted` and the step continues without it. `captcha_solves` records each task with the host only, never the URL path or the token. An uncertain task creation is never retried.

`node src/operator.mjs status` shows today's and total spend.

## Billing

A solve is FetchX's cost. The customer pays only if the request succeeds, and then 10 credits more for the step that solved one.

## Tests

`test/billing.test.mjs` covers the solver against a fake 2Captcha (budgets, DataDome's proxy, the banned case). `test/browser.test.mjs` runs Turnstile, reCAPTCHA and DataDome pages in a real browser when `BROWSER_TEST_EXECUTABLE` is set.
