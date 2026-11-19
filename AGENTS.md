# FetchX contributor guidance

Keep these intact: public-address checks after DNS and on every redirect (HTTP and browser), project isolation, success-only billing (reserve at admission, charge only the winning step, release otherwise), sealed storage of requests and results, idempotency (the same key and body never runs or charges twice), and never resending uncertain work or a method other than GET and HEAD. Keep site-specific behaviour out of code: provider rules and site knowledge carry it.

`docs/openapi.json` is the API contract. Change it first, run `npm run api:generate`, then change the code; `test/api-contract.test.mjs` checks routes, scopes and real responses against it.

Run tests serially against an explicitly disposable `gateway_test_*` PostgreSQL database, with fake providers and synthetic sites: no credentials, paid calls or real sites in tests. Run the real-browser tests (`BROWSER_TEST_EXECUTABLE`) when changing browser code, and the website's checks when changing the console API. Never publish captures, customer data, production diagnostics, secrets or browser binaries.
