# Console

The console at fetchx.ai/app (sign-in, projects, API keys, the playground, request history, credits and purchases) and the operator portal at /app/admin are static pages in `website/`. They call `/api/control/*` on the same origin; a Pages Function (`website/src/server/control.ts`) forwards only known paths, methods and query strings to the gateway's `/control/*` with a shared bridge secret, the session cookie and the CSRF header. It never forwards a customer API key. The gateway (`src/control.mjs`) is the source of truth.

## Gateway side

- `src/control-identity.mjs`: users, email codes, sessions, projects, memberships, keys (`fetch:write`, `fetch:read`, `usage:read`), rate limits. Creating a project opens its credit account and grants the account's trial if it has not been granted.
- `src/control.mjs`: the console API. Every project route checks membership; every write checks the session-bound CSRF token.
- `src/control-connect.mjs`: the Connect device flow that gives an agent a key after the user approves it.
- `src/control-stripe*.mjs`: Checkout and the webhook inbox ([Stripe payments](stripe-payments.md)).
- `src/control-admin.mjs`: the operator portal: provider rules, reachability probes and site knowledge ([provider rules](provider-rules.md), [site knowledge](site-knowledge.md)).

## Console API

All responses are `no-store`; errors are `{error: {code, message}}`.

| Path | Methods | What it does |
| --- | --- | --- |
| `/status` | GET | Sign-in methods available, `api_base_url` |
| `/auth/code`, `/auth/verify`, `/auth/logout` | POST | Email code sign-in; `/auth/google/*` and `/auth/github/*` for the others |
| `/session` | GET | The signed-in user, CSRF token and projects |
| `/projects`, `/projects/{id}` | GET, POST | List, create and read projects |
| `/projects/{id}/keys`, `/keys/{key}/rotate`, `/keys/{key}` | GET, POST, DELETE | Create (secret shown once), rotate and revoke keys |
| `/projects/{id}/fetch` | GET, POST | The playground (`POST`, same body as `POST /v1/fetch`, key id `console`) and request history (`GET`, same query as `GET /v1/fetch`) |
| `/projects/{id}/fetch/{rid}` | GET, DELETE | One result; delete its content |
| `/projects/{id}/usage` | GET | Same as `GET /v1/usage` |
| `/projects/{id}/billing` | GET | `{balance, prices, stripe?}` |
| `/projects/{id}/billing/stripe/checkout`, `/checkout/{key}` | POST, GET | Start and recover a Checkout |
| `/projects/{id}/webhook-secret`, `/webhook-secret/rotate` | GET, POST | The secret that signs webhook deliveries |

## Gateway configuration

```json
{
  "controlPlane": {
    "enabled": true,
    "origins": ["https://fetchx.ai"],
    "bridgeSecret": "a private random secret, at least 32 bytes",
    "sessionSecure": true,
    "apiBaseUrl": "https://app.fetchx.ai",
    "creditPolicy": {"trialCredits": 1000},
    "mail": {"transport": "pages", "url": "https://fetchx.ai/api/control-mail", "secret": "a separate private secret"}
  }
}
```

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

Connect FetchX is opt-in. Roll out the gateway and Pages bridge together, then set `controlPlane.agentConnectEnabled` to `true` with the existing `controlPlane.apiBaseUrl` configured. Keep the account service and exact website origins configured as above. The control status advertises `connect_enabled` when the flow is ready. The browser shows the requested permissions and asks the signed-in user to select a project and match the short code. The client holds the private verifier and activates the key after approval. Existing API key management can revoke the connected key.

The `pages` mail transport reuses the website's approved Gmail authorization without copying Gmail credentials to the gateway. Pages requires its existing private `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` secrets and validated `MAIL_FROM` (`FetchX <hello@fetchx.ai>`). The Google authorization must belong to that mailbox or have verified send-as permission for it; changing the sender alone does not repair an invalid OAuth grant. The configured mail URL must be an HTTPS DNS host on the default port with exactly `/api/control-mail`, without credentials, query or fragment. The dedicated mail secret must differ from the account bridge secret. A missing or invalid URL/secret leaves gateway mail unconfigured.

`/api/control-mail` is a private server-to-server POST endpoint, separate from the browser `/api/control/*` allowlist. It requires `X-FetchX-Control-Mail-Secret`, rejects browser-originated requests and accepts only an email, eight-digit code, UUID challenge and unexpired canonical ISO timestamp no more than eleven minutes ahead (including clock skew). The sender and verification message template are fixed by server code/configuration; arbitrary recipients lists, subjects and bodies are rejected. Requests and responses are bounded and uncached. Mail payloads and credentials are never logged by application code. Neither hop follows redirects or retries an uncertain send. It does not create enquiry records. Deploying the function alone does not enable mail: configure the matching dedicated secret privately on both services.

Operators may issue an authenticated server-to-server `GET /api/control-mail` using the same dedicated mail secret and browser-origin restrictions. This uncached readiness probe makes one bounded Google OAuth token refresh and never constructs a verification message or calls Gmail's send endpoint. It returns only `{ "ready": true }` or `{ "ready": false, "error": "..." }`. Authentication failures expose only a fixed allowlist of Google OAuth error identifiers (for example, `mail_auth_invalid_grant`); provider descriptions, tokens, recipients and credentials are never returned or logged. An unknown provider error becomes `mail_auth_failed`, a transport failure becomes `mail_provider_unreachable`, and a malformed successful token response becomes `mail_auth_invalid_response`. Readiness proves that Google accepted the refresh credentials; it does not establish sender permission or inbox delivery. Keep this probe in operator tooling with secrets supplied privately, outside command arguments and logs.

The existing direct Gmail transport remains supported for gateways with separately authorized credentials: `controlPlane.mail` may instead contain `transport: "gmail"`, `from` (a bare verified sender email), `clientId`, `clientSecret` and `refreshToken`. Do not copy the website's Gmail credentials to use that option.

Codes have eight digits, expire after ten minutes and allow five attempts. Request limits are three codes per email and twenty per IP in fifteen minutes; verification attempts have separate limits. A resend invalidates the previous challenge. Login and signup deliberately share the same accepted response. A failed or uncertain mail send invalidates that challenge without revealing whether an account exists or blindly resending mail. Sessions expire after seven days. Configure and independently verify real inbox delivery before remote rollout.

## Local review

`scripts/control-preview.mjs` runs the real gateway on `127.0.0.1:8789` against a disposable `gateway_test_*` database, with sign-in codes written to `.local/console-preview/mailbox.jsonl` instead of email. `--fixture` answers every fetch from an offline fake site (`/success`, `/forbidden`, `/not-found`, `/unknown`, `/slow` on any host).

```sh
node scripts/control-preview.mjs --fixture --database-url postgresql://127.0.0.1:5432/gateway_test_console_preview
cp .local/console-preview/bridge.env website/.dev.vars   # only if you have no .dev.vars yet
cd website && npm run build && npx wrangler pages dev dist --ip 127.0.0.1 --port 4331
node tests/ui/control-live-check.mjs                      # a real browser through the bridge to the gateway
```

## Release and rollback

Back up the database before a release; see [operations](operations.md). To turn the console off, set `controlPlane.enabled` to `false` and remove the bridge settings from Pages; keep the identity, key and billing tables.

## Tests

`test/control*.test.mjs` cover sign-in, sessions, CSRF, membership, keys, Connect, Stripe and the admin API against a disposable database; `test/control-e2e.test.mjs` walks the whole self-service path. In `website/`, `npm test` covers the bridge and `npm run test:browser` the pages against API fixtures; `tests/ui/control-live-check.mjs` checks the pages against the real gateway (see Local review).
