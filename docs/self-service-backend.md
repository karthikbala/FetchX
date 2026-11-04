# FetchX self-service backend

## Outcome and boundaries

Connect the existing website to verified users, project membership, server-issued keys, native HTTP fetch, retained request history and authoritative usage. The gateway remains the source of truth. Existing configured projects and v1/v2 contracts retain their behavior. New self-service credentials initially support the native HTTP API; browser execution remains independently qualified.

Implementation is local until release authorization. No paid source calls, production migration, email sends or commercial activation are part of verification. Proposed prices are not activated by a user clicking a plan.

## Shared implementation contract

Operator configuration lives in `config.controlPlane`. `enabled` defaults false. An enabled service needs `origins` (exact website origins), a private `bridgeSecret` of at least 32 bytes, `sessionSecure` (true outside explicit loopback development), a `projectTemplate` and a reviewed `creditPolicy`. Mail is an explicitly configured private Pages relay, direct Gmail OAuth transport or injected local-test adapter; codes never appear in HTTP responses.

`projectTemplate` has `id`, `v2_access_profiles`, `v2_entitlement` and optional `v2_discovery_policy`; it grants no v1 profiles. All grants come from operator configuration, never request fields. Persist a canonical template hash and fail closed if the template changes until an operator migration explicitly approves the change. New project identifiers use `cp_` plus a UUID. Configuration projections contain no plaintext credentials and no legacy `tokenHash`.

`creditPolicy` has `reviewed: true`, `version`, `trialCredits`, `weights` (`direct`, optionally `datacenter`) and `maxEstimatedMicroUsdPerOperation`. The free plan grants 1,000 trial credits once per verified account. The allocation belongs to the account's first project. Each request must meet the configured route, source, cost and daily-operation limits. The trial ledger is separate from prepaid credit packs and provider invoices.

### Identity service

`initControlIdentity(pool)` and `ControlIdentity({store,config,mail})` in `src/control-identity.mjs`. It owns `control_users`, `control_codes`, `control_sessions`, `control_projects`, `control_memberships`, `control_keys`, `control_rates`. `control_projects` has `id text`, `user_id uuid`, `name`, `template_hash`, `status`; `control_keys` has `id uuid`, `project text`, `token_hash`, `scopes jsonb`, `revoked_at`. Further columns are service-owned.

Methods: `requestCode({email,ip})`, `verifyCode({challenge_id,email,code,ip})`, `session(token)`, `revokeSession(token)`, `projects(userId)`, `createProject(userId,{name})`, `keys(userId,projectId)`, `createKey(userId,projectId,{name,scopes})`, `rotateKey(userId,projectId,keyId)`, `revokeKey(userId,projectId,keyId)`, `authenticateKey(token)`, `hydrateProject(projectId)`, `isCredential(value)`, `requireProject(userId,projectId)`.

Verification creates a verified user/session; project creation is a separate explicit step. `verifyCode` returns `{user,session:{token,expires_at}}`. `session` returns `{user,session:{id,expires_at}}`. Keys return safe metadata; create/rotate additionally return `token` once. Tokens use `fxk_` / sessions `fxs_` followed by cryptographically random 32-byte base64url values. Scopes are `fetch:read`, `fetch:write`, `usage:read`, `profiles:read`. `authenticateKey` returns `{project,key_id,scopes}` only for active key/project/template. Runtime authentication queries durable state each time. Membership checks are mandatory on every project resource.

### Credits service

`initControlCredits(pool)`, `grantInitialCredits(c,project,amount)`, `ControlCredits({store,config})` in `src/control-credits.mjs`. Identity calls the initial grant within its project-creation transaction. Separate `control_credit_accounts` and `control_credit_reservations` tables own credits. Reserve/settle is integrated into the existing v2 admission/completion transactions. `reserve(c,{project,operation,keyId,route,profile,transport,estimatedMicroUsd})`, `finish(c,{project,operation,dispatched,unknown})`, `usage(project)`, `operation(project,operationId)` and `recover(c)` are the shared methods.

Managed v2 operations receive explicit identity `{keyId}` from trusted route code; no body-provided identity is accepted. Session-authorized playground uses `keyId: 'console'`; API keys use their UUID. In admission, recheck the active project and (unless console) nonrevoked key under a row lock. Key scopes and ownership are checked at authentication. Reservations serialize on the project credit account. Replays add no charge. Unknown results retain holds; known predispatch cancellations release. Restart recovery reconciles only provably undispatched work and holds possible dispatches. Existing provider reservations remain intact.

### Browser-facing contract

Same-origin website calls `/api/control/*`. A Pages Function proxies only known paths/methods to gateway `/control/*` with an operator-configured bridge secret; it forwards the website origin, session cookie and CSRF header but never a customer API key. The gateway verifies the bridge and exact origin. Session cookie is HttpOnly, SameSite=Lax, path `/api/control`; Secure in production. State-changing authenticated routes also require `X-CSRF-Token`; derive it with HMAC from the session token and private bridge secret and return it from session/verification responses.

- `GET /status`: `{enabled,mail_configured,api_base_url,capabilities}`; no secrets.
- `POST /auth/code`: `{email}` → `{challenge_id,expires_in,accepted:true}`.
- `POST /auth/verify`: `{email,challenge_id,code}` → `{user,csrf_token,projects}` plus cookie.
- `GET /session`: `{user,csrf_token,projects}`; unauthenticated 401.
- `POST /auth/logout`: revoke session, clear cookie.
- `GET, POST /projects`: `{projects}` / `{project}`.
- `GET /projects/:id`: `{project,capabilities,access_profiles}`.
- `GET, POST /projects/:id/keys`; `POST /projects/:id/keys/:key/rotate`; `DELETE /projects/:id/keys/:key`.
- `POST /projects/:id/fetch`: exact current `/v2/fetch` body, including `max_transfer_mb` and `max_credits` for eligible paid HTTP requests. Persist operation key before sending, return the real public fetch envelope.
- `GET /projects/:id/fetch/:key`: original-key recovery; no redispatch.
- `GET /projects/:id/requests`: bounded `{operations}` list with real IDs, state, timestamps, route/profile context and latency. No raw source captures in list.
- `GET /projects/:id/requests/:operationId`: retained public fetch projection by operation ID.
- `GET /projects/:id/usage`: `{gateway,credits}` with outcome and latency counts and authoritative balances. Active or held paid allocations also expose `paid_credits`.
- `GET /projects/:id/billing`: `{status:'trial'|'approval_required',credits,commercial_enabled}`. Configured projects can buy [prepaid credit packs](stripe-payments.md) through separate Stripe checkout routes. The reviewed free-plan policy adds `trial:{trial_target:1000,grant_scope:'account',grant_frequency:'once',eligible_routes,max_daily_operations}` to billing and usage.

Errors use `{error:{code,message}}` for control paths; public fetch envelopes remain unchanged. All authenticated responses are no-store. Source content is rendered as text, never inserted as HTML. The browser stores only selected project and pending operation keys; never session tokens, API keys, source URLs/bodies or private account data in web storage.

## Operator configuration

Add this section to an existing private gateway configuration, replacing placeholders with reviewed values. `reviewed: false` deliberately prevents project grants and source dispatch until the operator approves the policy. `approved-http@1` must already exist in `v2.accessProfiles`; its origins, path expressions, methods, headers, redirect targets, byte bounds and deadlines remain the admission boundary. Never accept these grants from signup input.

```json
{
  "controlPlane": {
    "enabled": true,
    "origins": ["https://YOUR_WEBSITE_HOST"],
    "bridgeSecret": "REPLACE_WITH_PRIVATE_RANDOM_SECRET_AT_LEAST_32_BYTES",
    "sessionSecure": true,
    "apiBaseUrl": "https://YOUR_GATEWAY_HOST",
    "projectTemplate": {
      "id": "approved-http-trial-v1",
      "v2_access_profiles": ["approved-http@1"],
      "v2_entitlement": {"mode": "metered", "max_daily_operations": 100}
    },
    "creditPolicy": {
      "reviewed": false,
      "version": "direct-http-v1",
      "trialCredits": 1000,
      "weights": {"direct": 1},
      "maxEstimatedMicroUsdPerOperation": 0
    },
    "mail": {
      "transport": "pages",
      "url": "https://YOUR_WEBSITE_HOST/api/control-mail",
      "secret": "REPLACE_WITH_SEPARATE_PRIVATE_RANDOM_MAIL_SECRET_AT_LEAST_32_BYTES"
    }
  }
}
```

The example config grants free credits for reviewed direct HTTP access once enabled. Datacenter trial access needs a reviewed integer weight and known bounded route cost. Paid public HTTP routes require their own policy and funding. Account-key endpoint scopes are enforced independently from profiles and credits.

Configure the Pages environment separately:

| Setting | Value |
| --- | --- |
| `FETCHX_CONTROL_URL` | HTTPS gateway origin; optional `/control` suffix |
| `FETCHX_CONTROL_SECRET` | Same private bridge secret, stored as a Pages secret |
| `FETCHX_CONTROL_MAIL_SECRET` | Separate random ASCII secret, 32–256 bytes, matching gateway `controlPlane.mail.secret`; store as a Pages secret |
| `ALLOWED_ORIGINS` | Exact website origins, comma-separated; gateway must allow each too |
| `SITE_ENV` | `preview` or `production` remotely |
| `FETCHX_CONTROL_ALLOW_LOOPBACK` | Omit remotely; `true` only for explicit local development |

Do not put gateway/mail/bridge secrets in client code, build-time `PUBLIC_*` variables, command arguments or logs. The bridge sends no customer Bearer key upstream. It forwards the authenticated session and trusted client IP, bounds requests/responses, and does not retry POSTs or follow redirects. Production cookie security cannot be disabled using a browser field.

The `pages` mail transport reuses the website's approved Gmail authorization without copying Gmail credentials to the gateway. Pages requires its existing private `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` secrets and validated `MAIL_FROM` (`FetchX <hello@fetchx.ai>`). The Google authorization must belong to that mailbox or have verified send-as permission for it; changing the sender alone does not repair an invalid OAuth grant. The configured mail URL must be an HTTPS DNS host on the default port with exactly `/api/control-mail`, without credentials, query or fragment. The dedicated mail secret must differ from the account bridge secret. A missing or invalid URL/secret leaves gateway mail unconfigured.

`/api/control-mail` is a private server-to-server POST endpoint, separate from the browser `/api/control/*` allowlist. It requires `X-FetchX-Control-Mail-Secret`, rejects browser-originated requests and accepts only an email, eight-digit code, UUID challenge and unexpired canonical ISO timestamp no more than eleven minutes ahead (including clock skew). The sender and verification message template are fixed by server code/configuration; arbitrary recipients lists, subjects and bodies are rejected. Requests and responses are bounded and uncached. Mail payloads and credentials are never logged by application code. Neither hop follows redirects or retries an uncertain send. It does not create enquiry records. Deploying the function alone does not enable mail: configure the matching dedicated secret privately on both services.

Operators may issue an authenticated server-to-server `GET /api/control-mail` using the same dedicated mail secret and browser-origin restrictions. This uncached readiness probe makes one bounded Google OAuth token refresh and never constructs a verification message or calls Gmail's send endpoint. It returns only `{ "ready": true }` or `{ "ready": false, "error": "..." }`. Authentication failures expose only a fixed allowlist of Google OAuth error identifiers (for example, `mail_auth_invalid_grant`); provider descriptions, tokens, recipients and credentials are never returned or logged. An unknown provider error becomes `mail_auth_failed`, a transport failure becomes `mail_provider_unreachable`, and a malformed successful token response becomes `mail_auth_invalid_response`. Readiness proves that Google accepted the refresh credentials; it does not establish sender permission or inbox delivery. Keep this probe in operator tooling with secrets supplied privately, outside command arguments and logs.

The existing direct Gmail transport remains supported for gateways with separately authorized credentials: `controlPlane.mail` may instead contain `transport: "gmail"`, `from` (a bare verified sender email), `clientId`, `clientSecret` and `refreshToken`. Do not copy the website's Gmail credentials to use that option.

Codes have eight digits, expire after ten minutes and allow five attempts. Request limits are three codes per email and twenty per IP in fifteen minutes; verification attempts have separate limits. A resend invalidates the previous challenge. Login and signup deliberately share the same accepted response. A failed or uncertain mail send invalidates that challenge without revealing whether an account exists or blindly resending mail. Sessions expire after seven days. Configure and independently verify real inbox delivery before remote rollout.

## Local connected review

This command creates or reuses only the named disposable local database, initializes the actual gateway and binds it to loopback port 8789:

```sh
node scripts/control-preview.mjs \
  --database-url postgresql://YOUR_LOCAL_USER@127.0.0.1:5432/gateway_test_fetchx_preview
```

The website origin defaults to `http://127.0.0.1:4331`. The runner grants 25 local review credits to the first project and approves only GET/HEAD of `https://example.com/` over direct native HTTPS, with no paid-provider allowance. It does not fetch on startup. Real email is replaced with a private local mailbox at `.local/selfservice-preview/mailbox.jsonl`; the UI explicitly identifies this delivery mode, and codes never appear in an HTTP response. This adapter exists only in the local runner, not a production configuration flag.

Private configuration, encryption key, bridge settings and mailbox are mode 0600 under the ignored `.local/selfservice-preview/` directory. The runner binds its persisted secrets to the database and source mode; do not overwrite that state to switch databases or abandon pending work. Database state is retained at shutdown. The optional `--fixture` mode uses an offline source adapter for `/success`, `/forbidden`, `/not-found`, `/unknown` and `/slow`, without source network calls.

For a fresh local website setup, copy the generated `bridge.env` to `website/.dev.vars` only if no existing local secret file would be overwritten; preserve existing intake configuration otherwise. Then build and run the installed Wrangler:

```sh
cd website
npm run build
npx wrangler pages dev dist --ip 127.0.0.1 --port 4331
```

Local Wrangler secrets follow the [Cloudflare secret-file rules](https://developers.cloudflare.com/workers/configuration/secrets/#local-development-with-secrets). A static Astro preview alone cannot execute the account bridge. Keep all local D1 bindings local; this review does not require remote Cloudflare writes.

## Release and rollback gates

Back up the target PostgreSQL database and private configuration before an authorized release. `Store.init()` adds the `control_*` tables after the existing v2 schema; it does not replace configured projects or change existing token hashes. Retain the gateway's single-runner lock and run recovery before accepting traffic. The credit recovery path releases only operations proved undispatched; all possible dispatches retain holds.

Validate a restricted staging account through real mail delivery, TLS, signup, project creation, key lifecycle, an approved source and retained usage. Verify the gateway and Pages origin/secret pair, cookie security, project isolation, encrypted capture retention, cost ceilings and unknown recovery on the intended host. Source content acceptance and provider invoice reconciliation remain separate from a source HTTP status.

Before enabling paid routes or publishing allowances, measure the configured routes' costs, approve logical-operation weights and failure treatment, and approve commercial terms. A dispatched source failure consumes its configured request credits; a proven predispatch cancellation releases them; an uncertain dispatch retains a hold. Request credits are not provider invoice amounts. Stripe sells one-time paid credit packs for eligible public HTTP routes. The billing and usage APIs project paid and trial credits separately.

Rollback by disabling `controlPlane.enabled` and removing the website bridge configuration from the affected environment. Retain identity tables, key hashes, operations, captures and credit holds for recovery; do not truncate them or reset allowances. Do not widen a changed project template automatically: existing projects fail closed on a template hash change until a reviewed migration approves it. Public indexing and advertised browser/AI capabilities retain the separate launch gates in the website backlog.

## Ownership and verification

Sol identity owns identity/mail service and tests. Sol execution owns credit service and v2 credit/identity hooks. Sol control routes owns gateway routes and same-origin proxy plus integration tests. Sol frontend owns real app/auth components and client integration. The lead owns shared main/store wiring, configuration, disposable local harness, documentation and integration review. Database tests run serially on an explicitly disposable `gateway_test_*` database, with synthetic providers and isolated user/project fixtures. Verify email-code expiry/replay/rates, session/logout/CSRF, project/key isolation, revoked-key rejection, admission restrictions, credit concurrency/replay/uncertainty and the complete browser journey against the actual local backend.

Use a separate disposable test database from the running review database:

```sh
TEST_DATABASE_URL=postgresql://YOUR_LOCAL_USER@127.0.0.1:5432/gateway_test_fetchx_suite npm test
```

The full suite supports the installed Chromium executable through `BROWSER_TEST_EXECUTABLE`. Browser engines that are absent or unqualified remain disabled; skipped engine diagnostics are not qualification evidence. Website checks are `npm run check`, `npm test`, `npm run build`, and `npm run test:browser` from `website/`; the last command uses API fixtures rather than contacting a real source.

For the distinct real-backend acceptance, leave the guarded **native** local review runner and Pages server running, then run this once from the repository root:

```sh
CONTROL_PREVIEW_DATABASE_URL=postgresql://YOUR_LOCAL_USER@127.0.0.1:5432/gateway_test_fetchx_preview \
  TEST_BASE_URL=http://127.0.0.1:4331 \
  node website/tests/ui/control-live-check.mjs
```

That test requires the exact matching private native-preview state, local mailbox permissions, direct example.com policy and zero paid-provider allowance before it opens the browser. It exercises actual email-code consumption, membership, key lifecycle, one native fetch, saved-only recovery, authoritative history/credits, logout, privacy checks and desktop/mobile accessibility. It outputs bounded counts and rule identifiers, never codes, tokens, user identities, source content or screenshots. A source failure or uncertain outcome ends the test without replay.
