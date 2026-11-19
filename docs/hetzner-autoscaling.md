# Hetzner browser capacity

Browser captures wait for a free worker in the gateway's in-memory queue (`BrowserSlots`, first come first served, until the request's deadline; a wait that runs out fails the step with `browser_capacity`, which costs nothing and lets auto mode continue). A separate host controller (`ops/autoscaler`) adds private single-slot Docker workers on Hetzner when captures keep waiting, and removes them when idle, without restarting the gateway.

The gateway reports the queue on its callback socket at `GET /v1/pool-metrics`: waiting and running captures, the oldest wait, recent timeouts, each worker's health, and `browser.maxConcurrentRequests`. A gateway restart loses waiting captures; their requests fail and are not charged.

## Controller and spending limits

The controller uses the gateway's private callback Unix socket for aggregate queue and worker metrics. Before VM creation it registers or reuses its dedicated public administration key in the same Hetzner project, and passes that key to the server API so bootstrap never requires an interactive root-password change. Its Hetzner token, private SSH keys and SQLite infrastructure ledger stay on the host; neither the gateway nor browser containers receive that token. Worker browser containers have no direct network interface. All browser source traffic continues through the gateway's existing admission and metered relay.

A controller configuration can list one to four machine options. Each option has a server type, HEL1 location, server hourly price ceiling and IPv4 hourly ceiling. The example includes CX23, CX33, CPX22 and CCX13. Before each creation, the controller verifies availability, non-deprecation, x86 architecture, at least two CPUs, 4 GB RAM and 40 GB disk, and current EUR prices. It selects the cheapest eligible available option. A definitive placement rejection temporarily excludes that option. A timeout or uncertain creation retains its reservation and blocks a second creation until the original identity is reconciled.

The deployment ceiling authorized for this work is eight **additional** VMs and EUR 40 per UTC calendar month before VAT. These are ceilings, not spending targets. Existing local workers are base capacity. `browser.maxConcurrentRequests` also bounds useful worker capacity; the controller does not raise it. All VM options draw from one durable ledger, including staged live-test VM costs carried into production.

Before creating a VM, the ledger reserves its full maximum lifetime, cleanup allowance and rounding headroom using the selected option's approved server-plus-IPv4 rate. Deleted resources retain their conservatively rounded charges. Uncertain liabilities survive process restarts and UTC month boundaries. A missing or corrupt ledger prevents provisioning; do not initialize a replacement ledger to clear charges or a blocked operation.

Defaults are a 30-second sustained queue threshold, 120-second scale-up cooldown, five-minute idle drain, 15-minute boot deadline, one-hour maximum VM lifetime and a three-minute renewable workload lease. Scale-down first marks the worker draining, waits for in-flight work, then deletes the owned server and confirms IPv4 deletion. Thirty seconds of fresh unhealthy probes also drains a failed worker; replacement still counts the old VM against resource and spending limits until deletion is confirmed. Absolute-lifetime cleanup proceeds after its grace period even if gateway metrics are unavailable. A persisted per-VM egress counter also retires the workload at its configured byte limit (default 1 GiB), preserving usage across restarts. Sampling and stop latency can exceed that byte threshold slightly, so it is kept far below included provider traffic. A failed controller heartbeat stops the remote workload; stopping or powering off a VM does not end Hetzner billing. Actual deletion still depends on the controller host and Hetzner API being reachable. These are application-enforced cost controls, rather than a provider-side invoice lock.

Customer credits and proxy spending are unaffected by the controller. The infrastructure cap covers these managed VMs and Primary IPv4 addresses; it does not change existing host costs or customer source allowances.

## Deployment and operation

Use the [deployment assets](../deploy/autoscaler/README.md) for the disabled example, pinned image/browser bundle, separate SSH identities, systemd service and workload watchdog. Keep populated configuration, credentials, browser binaries, images, captures and operational receipts private. Preserve the ledger during deployment and rollback. Run the controller as a single long-lived `run` process; `once` is only one reconciliation step and does not finish a slow background bootstrap by itself.

The queue keeps nothing in PostgreSQL. Rollback can stop the controller while keeping its infrastructure ledger. Drain and delete managed VMs before stopping the controller permanently.

Tests use synthetic sources and a fake Hetzner API. The controller, Hetzner client and worker agent have their own tests (`python -m unittest discover -s test/autoscaler`). Live acceptance must separately prove queue waiting, automatic creation and registration, source counts, in-flight drain, controller restart, reservation retention, and server/IPv4 cleanup before production activation.

The wire implementation follows [Hetzner's official OpenAPI reference](https://docs.hetzner.cloud/cloud.spec.json). Hetzner bills [Primary IPv4 separately](https://docs.hetzner.com/cloud/servers/primary-ips/overview/) and [charges existing cloud resources until deletion](https://docs.hetzner.com/cloud/billing/faq/).
