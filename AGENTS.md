# FetchX contributor guidance

Keep destination/profile restrictions, project isolation, conservative spending reservations, encrypted captures and durable idempotency intact. Never retry uncertain source work or change provider after a stateful browser action. Keep extraction/application acceptance distinct from HTTP success. Use synthetic fixtures and fake provider responses in tests; no credentials or paid calls in CI.

Run tests serially against an explicitly disposable `gateway_test_*` PostgreSQL database. Include the real browser recipe test when changing browser behavior. Never publish source captures, customer profiles, production diagnostics, secrets or browser binaries. Preserve compatibility of the workflow API and document any additive fetch/job API changes.
