# Google sign-in

## Behavior

Google's official sign-in button appears on `/login` and `/signup`, alongside email
verification when configured. Google Identity Services uses popup mode with a server-issued
nonce and a short-lived, HttpOnly browser-binding cookie. The gateway validates
the signed Google ID token and creates the same FetchX session used by email
login. No Gmail access, Google access/refresh tokens, automatic project grants,
or additional trial allocations are part of sign-in.

The configured Google web client ID is public. Google login is disabled unless
`controlPlane.google.enabled` is true and `clientId` is valid. Use an explicitly
approved FetchX web OAuth client and exact website origins; keep the existing
mail OAuth configuration separate.

Configure the gateway's private configuration with:

```json
{
  "controlPlane": {
    "google": {
      "enabled": true,
      "clientId": "YOUR_WEB_CLIENT_ID.apps.googleusercontent.com"
    }
  }
}
```

The placeholder above must be replaced with the full Google-issued web client ID.
Register `https://fetchx.ai` as its authorized JavaScript origin. This popup flow
does not use an OAuth redirect URI or client secret. The website reads the public
client ID from the control status endpoint; do not replace the Pages mail sender's
`GOOGLE_CLIENT_ID`, secret or refresh token. Local tests use a synthetic client.

Disable `controlPlane.google.enabled` to remove Google sign-in while retaining
email login and existing FetchX sessions. Keep the additive identity tables and
latest database on rollback; reverting an image must not restore an older ledger
or erase newly linked identities. Back up and validate the migration before
enabling the feature on a deployed service.

## Shared contract

- `GET /control/status` adds `google: {enabled, client_id}`; disabled has a null ID.
- `POST /control/auth/google/challenge` accepts `{}` and returns
  `{challenge_id, nonce, client_id, expires_in}`. It sets `fetchx_google=fxg_…`,
  HttpOnly, SameSite=Lax, Secure remotely, Path `/api/control`, five-minute expiry.
- `POST /control/auth/google/verify` accepts `{challenge_id, credential}` plus the
  binding cookie. A verified, unexpired, single-use challenge must match the ID
  token nonce. Success returns the existing `{user, csrf_token, projects}` shape,
  sets `fetchx_session`, and clears the challenge cookie.
- Both routes use the existing private origin-restricted Pages bridge. The bridge
  forwards only validated session/challenge cookies, and reconstructs safe cookie
  attributes. Browser bearer keys and arbitrary headers are never forwarded.

Persist Google issuer/subject bindings, unique per subject and FetchX user.
Validate signature, algorithm, issuer, audience, authorized party where present,
expiry, issued-at, subject, nonce and verified email. Use a maintained JWT library
with bounded requests to Google's fixed public-key endpoint. Do not log tokens.

For the first Google sign-in, a verified Gmail or Google Workspace address may
join its existing email-verified FetchX account. Google accounts with an external
email not hosted by Google must use the existing email-code method. Never merge
two users or replace an existing Google subject by email. Existing subject
bindings identify the user even if Google later changes its email; do not silently
rewrite the FetchX email or transfer projects. Sign-in itself grants no credits.

Challenge creation/verification is rate limited. Store only nonce/binding hashes,
enforce short expiry and bounded attempts, and atomically consume each challenge.
Concurrent replay may create only one session. Cancellation, blocked scripts,
expired challenges and verification failures leave email login usable.

## Ownership and acceptance

The backend worker owns identity schema, Google token verification, control routes,
root dependencies and backend tests. The website worker owns the Pages allowlist
and cookie bridge, authentication UI, Google script/CSP integration and website
tests. The lead owns this contract, integration, configuration, review and release.

Run database tests serially on a disposable `gateway_test_*` database. Generate
synthetic signed tokens and fake Google responses. Cover account reuse, stable
subject binding, mismatched audience/nonce/cookie, expiry, replay/concurrency,
unverified/external email, disabled configuration and provider failures. Check
the Workers cookie boundary and runtime behavior, frontend success/fallback,
keyboard/mobile accessibility, existing email login, build and type checks.

Live acceptance requires an approved Google web client with `https://fetchx.ai`
as an authorized JavaScript origin, a real user sign-in, and evidence that it
reuses the existing FetchX account without changing projects, keys or credits.
Deployment retains the existing private profiles, accounting and rollback gates.

References: [Google Identity Services](https://developers.google.com/identity/gsi/web/guides/overview),
[server ID-token verification](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token),
[Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect).
