# Central CAPTCHA solving

FetchX 0.3 supports reviewed reCAPTCHA v2 forms and standalone Turnstile forms through 2Captcha. Browser clients use `POST /v1/jobs` and poll the returned job ID. The gateway detects the configured visible challenge, verifies the exact page and public site key, obtains one token, rechecks the same browser form, submits once, and waits for the reviewed source success selector. A solver token is not source acceptance. Application parsing and record acceptance remain with the crawler.

A CAPTCHA profile requires `execution: "browser"` and a server-owned `captcha` object:

```json
{
  "type": "recaptcha_v2",
  "websiteURL": "https://source.example/check",
  "siteKey": "PUBLIC_SITE_KEY",
  "triggerSelector": "#challenge",
  "widgetSelector": "#challenge",
  "responseSelector": "textarea[name=\"g-recaptcha-response\"]",
  "submitSelector": "#form button[type=submit]",
  "successSelector": "#fresh-result"
}
```

Use `type: "turnstile"` and `input[name="cf-turnstile-response"]` for a standalone Turnstile form. The widget must expose the matching `data-sitekey`. The success selector must be absent before solving and become visible after submission. Configure allowed hosts, methods, endpoint patterns, browser request limits, residential byte budgets, and the form recipe together. Caller-supplied scripts, selectors, solver options and credentials are rejected. Existing profiles without `captcha` only report passive challenge observations and never incur solver charges.

Private gateway configuration holds `captcha.enabled`, `captcha.apiKey`, `maxTaskMicroUsd`, `maxDailyMicroUsd`, `maxTotalMicroUsd`, `maxTotalTasks` and optional `timeoutMs` (at most 120000). Amounts are integer millionths of USD. Each project's `maxDailyCaptchaMicroUsd` can further constrain admission. Solving is disabled without an enabled account and explicit positive limits. These limits cover FetchX usage only, not other applications sharing the vendor account. The maximum task amount is a pre-dispatch reservation, not a vendor-enforced price ceiling: a reported overrun is recorded and holds further solves.

The gateway reserves cost transactionally before creating a task. It permits one task per workflow and does not recreate a task after timeout, disconnect, restart or ambiguous vendor response. Known costs settle from the vendor receipt; uncertain charges retain the reservation. `node src/operator.mjs reconcile-captcha TASK_UUID` polls an existing unknown task without submitting another task or applying an old token. A ready token is kept only in memory, removed from the response field, and redacted from text captures and extracted output. The API key stays in the parent gateway process. Solver state and verification outcomes appear in project-scoped `/v1/status`.

The browser stays on the existing proxy, cookies and user agent throughout solving. 401/429 responses, invalid widget configuration, site-key mismatch and repeated challenges do not start another solve. A solve or form action makes the workflow non-replayable across providers. Sync fetch/operation calls for CAPTCHA profiles return `captcha_async_required` before dispatch; queue jobs allow the browser and solver time to finish. Drain shutdown uses a 240-second grace period.

Unsupported flows fail without paid guessing: hCaptcha, DataDome, reCAPTCHA v3/Enterprise-specific tasks, managed Cloudflare challenge pages requiring challenge data or user-agent replacement, callback-only widgets, and external login/MFA. This release does not claim universal site unblocking. Public tests use synthetic fixtures and a real local Chromium process; live source qualification is separate.

Provider contracts: [reCAPTCHA v2](https://2captcha.com/api-docs/recaptcha-v2), [Turnstile](https://2captcha.com/api-docs/cloudflare-turnstile), [task creation](https://2captcha.com/api-docs/create-task), [result polling](https://2captcha.com/api-docs/get-task-result).
