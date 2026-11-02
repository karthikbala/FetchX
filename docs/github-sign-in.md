# GitHub sign-in

GitHub sign-in creates the same FetchX session as email and Google sign-in. It
requests only `user:email` from a dedicated GitHub OAuth app. The gateway exchanges
the authorization code and reads the authenticated `/user` and `/user/emails`
endpoints. Repository, organization, write and `offline_access` scopes are never
requested. GitHub access and refresh tokens remain transient server-side values;
they are neither stored nor returned to the website. Expiring OAuth tokens are
supported: any returned `refresh_token`, `expires_in` or refresh-expiry fields are
discarded. The two identity reads use API version `2026-03-10`.

## Account identity and connection

The immutable numeric GitHub user ID identifies an account; its login name and
public profile email never identify a FetchX user. A primary, verified email from
the authenticated email endpoint is required. A previously connected GitHub ID
returns its original FetchX account even if GitHub changes its email. FetchX does
not silently rewrite the saved account email or move projects.

A new GitHub ID with a new verified email creates one user and one identity
atomically. If the email already belongs to FetchX, login returns
`github_account_link_required`. The user signs in using an existing method and
selects **Connect GitHub**. Connection requires the same live FetchX session and
its CSRF token both at start and callback. Connecting the same GitHub ID to the
same user again succeeds; replacing a user's GitHub ID or connecting an ID owned
by another user returns `github_identity_conflict`. Users must sign out before
starting GitHub login while already signed in. No authentication flow grants a
project, API key, credit allocation or provider entitlement.

## Server configuration

Register a dedicated GitHub **OAuth app** with homepage `https://fetchx.ai` and
callback URL exactly `https://fetchx.ai/api/control/auth/github/callback`. Retain
GitHub's expiring-user-token setting when available. Keep this app separate from
mail sender credentials, Google login and any repository integration.

Merge this section into the gateway's private configuration:

```json
{
  "controlPlane": {
    "origins": ["https://fetchx.ai"],
    "github": {
      "enabled": true,
      "clientId": "YOUR_GITHUB_OAUTH_CLIENT_ID",
      "clientSecretEnv": "FETCHX_GITHUB_CLIENT_SECRET",
      "redirectUri": "https://fetchx.ai/api/control/auth/github/callback"
    }
  }
}
```

Inject the app secret into the gateway process environment as
`FETCHX_GITHUB_CLIENT_SECRET` through the existing private service secret
mechanism. No inline secret, alternate environment name or website secret fallback
is accepted. The public status endpoint exposes only `{github:{enabled:true}}`;
malformed or incomplete configuration disables the feature. For explicit local
development, `allowLoopbackDevelopment:true` and exclusively loopback origins
permit the same exact callback path on an allowed loopback origin. Production
uses the fixed HTTPS callback above. Other callback hosts, paths, credentials,
query strings and fragments are rejected.

Disable `controlPlane.github.enabled` to remove GitHub sign-in without revoking
existing FetchX sessions or affecting email/Google authentication. A connected
account remains marked connected even while GitHub login is disabled.

## Shared contract and durable challenge

- `GET /control/status` adds `github:{enabled:boolean}`.
- `POST /control/auth/github/start` accepts exactly `{mode:"login"}` or
  `{mode:"link"}`. Link mode requires the session cookie and `x-csrf-token`.
  It returns `{authorization_url,expires_in:300}` and sets
  `fetchx_github=fxh_…`, HttpOnly, SameSite=Lax, Secure remotely, Path
  `/api/control`, with a five-minute expiry.
- The authorization URL has exactly `client_id`, `redirect_uri`, `scope`,
  `state`, `code_challenge`, and `code_challenge_method:S256`. State contains 43
  base64url characters. A server HMAC derives the PKCE verifier from independent
  random state and browser binding; neither the verifier nor either raw random
  value is stored in PostgreSQL.
- The website receives GitHub's callback and calls
  `POST /control/auth/github/complete` through its existing private bridge with
  exactly `{code,state}` or `{error:"access_denied",state}`. Codes contain 1–512
  ASCII letters, digits, underscores or hyphens. Provider error descriptions and
  arbitrary callback parameters are never forwarded. A present FetchX session
  is read first so connection can forward its current CSRF token.
- The gateway matches state, browser binding, client, callback, expiry and
  captured connection session. It commits one-use challenge consumption before
  any provider request. Concurrent or replayed callbacks cannot dispatch another
  exchange. Provider failure, cancellation and uncertain transport require a
  fresh start. Every request is time and size bounded, uses fixed GitHub URLs,
  refuses redirects and makes no automatic retry.
- Success returns `{user,csrf_token,projects,auth_methods:{github:boolean},mode}`,
  sets `fetchx_session` and clears the binding. Connection retains the current
  session. `GET /control/session` and successful email/Google authentication also
  return the additive `auth_methods` boolean. No provider subject is exposed.

Both POST routes retain the existing private bridge-secret and exact-origin
checks. Existing session, project, CSRF, spending, recovery, encrypted capture and
durable idempotency boundaries remain in force. GitHub HTTP success alone never
establishes account or application acceptance.

The additive schema consists of `control_github_challenges` and
`control_github_identities`, plus indexes. Challenges store state/binding HMACs,
the fixed client/callback, mode, expiry, consumption and (for connection) captured
user/session IDs. Identities enforce one GitHub subject per FetchX user and one
FetchX user per subject. No existing table is dropped or rewritten.

## Validation and release gates

Use synthetic provider responses only. Run backend tests serially against an
explicitly disposable `gateway_test_*` PostgreSQL database. Cover wrong/tampered
state, cross-browser and duplicate cookies, expiry, replacement, replay,
concurrency, cancellation, provider timeouts/bounds/redirects, broader scope
rejection, missing/unverified primary email, email collision, stable subject,
wrong/revoked/switched connection sessions and CSRF, idempotent reconnection,
identity conflicts, disabled configuration, restarts and absence of new grants.
Run the existing Google/email/control and accounting tests as regression checks.

Before deployment:

1. Review the exact source revision and the website callback/bridge diff. Prepare
   the dedicated OAuth app, exact callback, process secret and private config;
   registration or credentials alone do not establish a working sign-in.
2. Back up the exact deployed database, configuration and encrypted capture state.
   Rehearse on a clone of that backup. Preserve all 35 pre-existing tables and
   their rows, accounting balances/holds, profiles and recovery state; verify the
   two added tables and a second idempotent initialization. Confirm the actual
   deployed table inventory rather than assuming it matches the expected count.
3. Run the serial backend suite and website type/build/bridge/callback tests.
   Confirm that browser responses, cookies and logs contain no GitHub tokens,
   secret, verifier or private identity details. Retain rollback evidence and
   the migrated database; rollback must not restore an older ledger or discard
   newly connected identities.
4. After an authorized release, verify live status, email and Google login, a
   real GitHub login, and explicit connection to an existing account. Confirm
   stable account/project/key ownership and unchanged credits before and after
   login/connection. Local fake-provider checks do not replace live acceptance.

References: [GitHub OAuth authorization and PKCE](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps),
[authenticated email endpoints](https://docs.github.com/en/rest/users/emails).
