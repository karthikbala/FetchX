# Private autoscaler deployment assets

The example is deliberately disabled, with zero additional workers and zero
budget. Preparing these files does not authorize cloud provisioning or source
requests. Keep the two local production workers. No default image or browser
download is supplied.

The `machine_options` allowlist contains four HEL1 options. The following values
are approved hourly price ceilings in EUR micro-units, not live price quotes:

| Server type | Location | Server hourly ceiling | IPv4 hourly ceiling |
| --- | --- | ---: | ---: |
| `cx23` | `hel1` | 8800 | 800 |
| `cx33` | `hel1` | 13600 | 800 |
| `cpx22` | `hel1` | 26400 | 800 |
| `ccx13` | `hel1` | 58500 | 800 |

For each creation decision the controller checks current API availability,
specifications and prices, then selects the available approved option with the
lowest actual combined server and IPv4 hourly price. Each option must have at
least 2 CPUs, 4 GB RAM, a 40 GB disk and x86 architecture. The global VM image
remains `ubuntu-24.04`. An option with missing/uncertain availability or prices,
or prices above its ceilings, is ineligible. No qualifying available option
means no creation. A timed
out or otherwise uncertain create never triggers another option's create;
reconciliation retains the original identity and reservation.

All options share one infrastructure ledger, monthly budget and additional-worker
ceiling. The approved rollout's EUR 40 monthly budget (`40000000` micro-EUR) and
8-worker ceiling belong in the private deployment configuration; they are not
separate allowances for each machine type. This generic example retains
`enabled: false`, `monthly_budget_micro_eur: 0` and `max_additional_workers: 0`.
No top-level `server_type`, `location` or hourly price ceiling selects an implicit
single machine; those values belong to each `machine_options` entry.

Install the reviewed checkout under `/opt/fetchx-autoscaler/release`, retaining
`ops/autoscaler` and `deploy/autoscaler`. The systemd unit uses that layout.
The controller host needs Python 3.10 or later, OpenSSH, systemd and the already installed
Docker CLI/daemon for **asset preparation only**. Worker VMs require Python 3.12 for safe archive extraction and use Ubuntu 24.04
and install `docker.io`, `nftables`, Python and CA certificates via cloud-init.

Create `/var/lib/fetchx-autoscaler` and `/etc/fetchx-autoscaler` as root-owned
`0700` directories. Copy the example to the latter's `config.json` with mode
`0600`. The token at `cloud_token_path` is also root-owned `0600`. Never put
tokens, private keys, captures, runtime bundles or populated manifests in Git.
Use the actual controller public IPv4; the documented address is a placeholder.
An optional user-authorized PortTrack **public** key can be supplied as text.
The driver generates a separate `state_dir/admin_ed25519` controller key, plus
separate host and restricted forwarding keys per VM. It refuses an administrator
private key outside this dedicated state directory.

Prepare assets on the production host from the complete reviewed immutable image
ID/digest and the existing qualified browser bundle and four-field runtime pin:

```sh
sudo /usr/bin/python3 /opt/fetchx-autoscaler/release/deploy/autoscaler/prepare_assets.py \
  --image sha256:REPLACE_WITH_COMPLETE_REVIEWED_IMAGE_ID \
  --seccomp /opt/fetchx-autoscaler/release/deploy/chromium-seccomp.json \
  --output /var/lib/fetchx-autoscaler/assets
```

The output directory must be new. Preparation does not pull images, download
browsers, run a browser, or contact a provider. It creates a deterministic private
Docker tag and archives the browser-directory **contents**, without an outer
`browser/` prefix. The private manifest has version 1 and these fields:

```json
{
  "version": 1,
  "image": {"archive": "/private/assets/image.tar", "sha256": "64 hex", "ref": "fetchx-autoscaler-pinned:64hex", "rootfs_layers": ["sha256:64hex"]},
  "browser": {"archive": "/private/assets/browser.tar", "sha256": "64 hex", "executable": "/opt/gateway-browser/PINNED/PATH/chrome"},
  "runtime_pin": {"engine": "chromium", "executablePath": "/opt/gateway-browser/PINNED/PATH/chrome", "version": "151.x.x.x", "sha256": "64 hex"},
  "seccomp": {"path": "/private/assets/seccomp.json", "sha256": "64 hex"}
}
```

These example values are intentionally not valid production pins. All asset
files must be root-owned `0600`, with a root-owned `0700` containing directory,
and must be siblings of the manifest. Before provisioning the driver checks
their hashes. After loading on the VM, it validates the archive hash, Linux
AMD64 and **ordered RootFS layer digests**; Docker config IDs can differ across
classic/containerd stores. Browser executable health must match the exact
manifest version/SHA and Linux/x64. Gateway qualification expiry remains enforced
by the gateway. Bootstrap also runs a synthetic Chromium sandbox smoke test.

Initialize the durable ledger explicitly with the disabled configuration:

```sh
cd /opt/fetchx-autoscaler/release
sudo /usr/bin/python3 -m ops.autoscaler.controller --config /etc/fetchx-autoscaler/config.json init
sudo /usr/bin/python3 -m ops.autoscaler.controller --config /etc/fetchx-autoscaler/config.json status
```

Do not start/enable the service or set `enabled: true` until the approved monthly
EUR budget, additional-worker ceiling, current machine availability and rollout
acceptance have been recorded. The service file is supplied for that later step;
it is not installed or enabled by this change.

The root SSH supervisor binds only its owned `<worker-id>.sock` directly under
the existing root-owned `0755` registry directory, then restores `10001:10001`
and `0600` after every reconnect. The existing gateway directory bind exposes it
as `/run/fx/registry/<worker-id>.sock` without restart. Registry publication,
draining and cloud/IP deletion belong to the controller. The driver never edits
`workers.json`. Forwarding uses a separate restricted key, strict pinned host
checking and the final `sshd-match.conf` block. Both TCP negative probes and the
effective daemon policy must pass before readiness.

Controller renewal runs before one third of `worker_lease_seconds` elapses.
The VM watchdog refuses renewal after an already-started lease expires, stops
the workload on expired/missing/corrupt lease or absolute hard lifetime, and
uses `--restart=no`. Retired/stopped workers require replacement. It never
receives a cloud token. If Docker cannot stop/kill the workload, it requests
local poweroff of the dedicated VM. A controller outage can delay deletion and billing;
stopping a workload is not provider resource deletion. This is an application
budget guard, not an account spending lock. Keep host clocks synchronized;
renewal clock skew beyond two seconds fails closed.

Offline checks use synthetic subprocess responses and archives:

```sh
python3.12 -B -m unittest discover -s test/autoscaler -p test_worker_driver.py -v
```

This does not establish live Ubuntu cloud-init, provider availability, SSH/systemd,
AppArmor/Chromium sandbox, reconnect permissions through the running gateway,
synthetic scrape acceptance, or deletion/IPv4 cleanup. Those remain bounded
rollout checks for the explicitly enabled deployment. A failed sandbox test
retires the worker; it never disables the browser sandbox or host restrictions.
