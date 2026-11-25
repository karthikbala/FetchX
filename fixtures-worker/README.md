# fixtures.fetchx.ai

FetchX's public test site: a Cloudflare Worker (`worker.mjs`) that serves pages that behave the same every time. FetchX's own checks use it, and so do callers' acceptance tests (PortTrack's F0). The site stores nothing. A session is a signed cookie, and `/echo` answers with what it was sent. Pages load no third-party scripts, except the CAPTCHA pages, which load the vendor's widget.

The test sign-in is `fixture-user` / `fixture-password`. `GET /` lists every page:

- **Sign-in:** `/login`, `/home` and `/logout`.
- **Request inspection:** `/echo` and `/ip`.
- **Redirects:** `/chain`, a three-hop redirect chain that sets a cookie at each hop.
- **Open shadow roots:** `/shadow`, which calls `/api/lookup` for its data.
- **Cross-origin frames:** `/frame`, whose form is served from `frame.fixtures.fetchx.ai`.
- **CAPTCHAs:** `/captcha/{recaptcha-v2,recaptcha-v3,hcaptcha,turnstile,mtcaptcha}`.
- **Exfiltration attempts:** `/exfil`, for `allow_hosts`.

## CAPTCHA keys

reCAPTCHA v2, hCaptcha and Turnstile use their vendors' published test keys, so every verification passes. reCAPTCHA v3 and MTCaptcha have no public test keys. Their pages answer 503 until these secrets are set:

- `RECAPTCHA_V3_SITEKEY` and `RECAPTCHA_V3_SECRET`
- `MTCAPTCHA_SITEKEY` and `MTCAPTCHA_PRIVATEKEY`

Set them with `wrangler secret put`.

## Run it locally

```sh
node fixtures-worker/serve.mjs 8787
```

The site is served on `http://127.0.0.1:8787` and the frame host on `http://localhost:8787`, so the framed form stays cross-origin. Cookies drop `Secure` over plain HTTP. `test/fixtures-worker.test.mjs` covers both the Worker and this local copy.

## Deploy

Deploying adds two Custom Domains on the fetchx.ai zone, `fixtures.fetchx.ai` and `frame.fixtures.fetchx.ai`, and Cloudflare issues their certificates. It needs a token that can edit Workers scripts and routes for the account and zone. Deploy only with the owner's go-ahead.

```sh
WRANGLER_SEND_METRICS=false website/node_modules/.bin/wrangler deploy --dry-run --config fixtures-worker/wrangler.jsonc
WRANGLER_SEND_METRICS=false website/node_modules/.bin/wrangler deploy --config fixtures-worker/wrangler.jsonc
```
