# Hetzner browser capacity

FetchX keeps admission, request credits, source spending reservations, encrypted captures and original-key recovery in its gateway. The opt-in browser queue waits for a qualified browser slot before source or credit reservation. A separate host controller adds private single-slot Docker workers without restarting the gateway. `/v2/render` and `/v2/scrape` retain their existing response and idempotency contracts.

## Queue configuration

Add this alongside the existing `v2.browser_pool` configuration:

```json
{"browser_queue":{"enabled":true,"max_pending":64,"max_pending_per_project":8,"wait_timeout_ms":45000}}
```

Tickets are durable metadata, with FIFO ordering per project and round-robin admission between projects. One shared scheduler avoids polling the database separately for every caller. Pending limits exclude work that has already acquired a slot; normal gateway concurrency, profile, session, quota and spending checks still apply at execution admission.

The default queue wait is at most 45 seconds, separately from the approved browser execution timeout. A new VM can take several minutes to boot. Calls can therefore exhaust their queue wait during a cold burst. Queue-full, queue-timeout and pre-dispatch cancellation responses use HTTP 503; replay the exact request with its original key. Concurrent duplicates return HTTP 409 (`scrape_running` for Scrape). Persist `X-Idempotency-Key` before calling Scrape, or the body idempotency key for Render. Completed captures are recovered without another source request. An uncertain source operation retains its original reservation and is never queued or dispatched again automatically.

A gateway restart cancels waiting tickets. Tickets do not contain request bodies or destinations and are not autonomous source jobs. Callers recover by replaying their original requests. The existing workflow job API is unchanged.

## Controller and spending limits

The controller uses the gateway's private callback Unix socket for aggregate queue and worker metrics. Its Hetzner token, SSH keys and SQLite infrastructure ledger stay on the host; neither the gateway nor browser containers receive that token. Worker browser containers have no direct network interface. All browser source traffic continues through the gateway's existing admission and metered relay.

A controller configuration can list one to four machine options. Each option has a server type, HEL1 location, server hourly price ceiling and IPv4 hourly ceiling. The example includes CX23, CX33, CPX22 and CCX13. Before each creation, the controller verifies availability, non-deprecation, x86 architecture, at least two CPUs, 4 GB RAM and 40 GB disk, and current EUR prices. It selects the cheapest eligible available option. A definitive placement rejection temporarily excludes that option. A timeout or uncertain creation retains its reservation and blocks a second creation until the original identity is reconciled.

The deployment ceiling authorized for this work is eight **additional** VMs and EUR 40 per UTC calendar month before VAT. These are ceilings, not spending targets. Existing local workers are base capacity. The existing gateway global concurrency limit also constrains useful worker capacity; it is not increased by the controller. All VM options draw from one durable ledger, including staged live-test VM costs carried into production.

Before creating a VM, the ledger reserves its full maximum lifetime, cleanup allowance and rounding headroom using the selected option's approved server-plus-IPv4 rate. Deleted resources retain their conservatively rounded charges. Uncertain liabilities survive process restarts and UTC month boundaries. A missing or corrupt ledger prevents provisioning; do not initialize a replacement ledger to clear charges or a blocked operation.

Defaults are a 30-second sustained queue threshold, 120-second scale-up cooldown, five-minute idle drain, 15-minute boot deadline, one-hour maximum VM lifetime and a three-minute renewable workload lease. Scale-down first marks the worker draining, waits for in-flight work, then deletes the owned server and confirms IPv4 deletion. Thirty seconds of fresh unhealthy probes also drains a failed worker; replacement still counts the old VM against resource and spending limits until deletion is confirmed. Absolute-lifetime cleanup proceeds after its grace period even if gateway metrics are unavailable. A persisted per-VM egress counter also retires the workload at its configured byte limit (default 1 GiB), preserving usage across restarts. Sampling and stop latency can exceed that byte threshold slightly, so it is kept far below included provider traffic. A failed controller heartbeat stops the remote workload; stopping or powering off a VM does not end Hetzner billing. Actual deletion still depends on the controller host and Hetzner API being reachable. These are application-enforced cost controls, rather than a provider-side invoice lock.

Source/proxy spending remains governed by FetchX's existing reservations and project policies. The infrastructure cap covers these managed VMs and Primary IPv4 addresses; it does not change existing host costs or customer source allowances.

## Deployment and operation

Use the [deployment assets](../deploy/autoscaler/README.md) for the disabled example, pinned image/browser bundle, separate SSH identities, systemd service and workload watchdog. Keep populated configuration, credentials, browser binaries, images, captures and operational receipts private. Preserve the ledger during deployment and rollback. Run the controller as a single long-lived `run` process; `once` is only one reconciliation step and does not finish a slow background bootstrap by itself.

The queue adds only `v2_browser_queue`, `v2_browser_queue_cursor` and `v2_browser_queue_timeouts` to PostgreSQL. Migration must preserve every existing table, row, hold and encrypted capture. Rollback can disable the queue/controller while retaining those metadata tables and the infrastructure ledger. Drain/delete managed VMs before stopping the controller permanently; its workload lease alone cannot delete cloud resources.

Tests use synthetic sources and a fake Hetzner API. Run PostgreSQL tests serially against a disposable `gateway_test_*` database and include the real browser recipe and TLS fixture. Live acceptance must separately prove queue waiting, automatic creation and registration, source counts, in-flight drain, controller restart, reservation retention, and server/IPv4 cleanup before production activation.

The wire implementation follows [Hetzner's official OpenAPI reference](https://docs.hetzner.cloud/cloud.spec.json). Hetzner bills [Primary IPv4 separately](https://docs.hetzner.com/cloud/servers/primary-ips/overview/) and [charges existing cloud resources until deletion](https://docs.hetzner.com/cloud/billing/faq/).
