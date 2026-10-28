# Operating FetchX

Run exactly one gateway against a database and artifact volume. Startup takes an exclusive PostgreSQL advisory lock before recovery. Another gateway must not concurrently recover or process these records. Browser execution is one capture at a time by default; configure capacity only alongside CPU/memory, entitlement and source limits.

Use `scripts/init-config.mjs` to generate secrets locally. Keep `gateway.json`, `client.token`, database credentials, browser license keys, captures, and backups out of Git. The service UID is 10001. The `browser` mount must allow that UID to traverse directories and execute the binary; on Linux, use `chmod 755 local/browser` and keep individual browser files readable/executable as appropriate. Do not weaken the secret-file permissions to make the browser readable. Provider rates in generated configuration are illustrative estimates: set `microUsdPerGB` to the actual contracted rate before use.

The service keeps source requests and captures encrypted at rest with the configured `artifactKey`. Back up the database, capture volume, configuration and encryption key as a consistent set. Stop/drain the gateway before a paired snapshot; preserve historical ledgers and unknown charges. Test restoration into an isolated environment. A code rollback must not restore an older spending ledger. Do not rotate the encryption key without migrating retained ciphertext.

HTTP source work, browser assets and fallback attempts all count against conservative bandwidth reservations. Local wire counters include relay overhead; they are not invoices. Reconcile only from authoritative provider evidence using the operator CLI. Unknown billing retains allowance. Reducing limits below existing usage stops future admission; never delete historical usage to obtain more allowance.

The queue has a single worker. Queued jobs survive restart, expire after 30 minutes and can be cancelled before claim. A crash after claim marks the job uncertain. Read-only recovery can retrieve a saved capture; it must never manufacture a successful source result or initiate a replacement request. An empty queue or successful HTTP fetch is not proof of application ingestion or source completeness.

Every source profile must enumerate public HTTPS hosts and allowed methods/headers. Optional path expressions narrow that boundary. Include legitimate browser dependencies deliberately. The browser disables downloads, service workers, WebSockets and optional media resources. Use reviewed recipes for interactions; source login credentials and form variables must be authorized for the configured origin/provider. Keep project tokens separate from source credentials.

`GET /healthz` checks process/database availability. Authenticated `/v1/status`, operation diagnostics, native status and retained captures establish progressively more specific evidence. Validate source identity/context/completeness in the owning crawler, then report its outcome separately. Do not infer universal unblocking from a connectivity test.

Paid CloakBrowser is an entitlement/build tier, not merely concurrency. Pin version, path and SHA-256 for each tier. The binary hash is checked on each launch and paid entitlement is validated live. A missing/expired/unverified entitlement blocks that tier; FetchX does not purchase a subscription. The browser sandbox remains enabled; the supplied seccomp profile permits Chromium user namespaces without host capabilities.

Optional legacy Oxylabs/Scrape.do adapters are retained in code. Enabling them requires explicit source policy and credentials. Public source profiles default to residential routing and cannot silently select Scrape.do.
