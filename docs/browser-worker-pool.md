# FetchX browser worker pool

The staging gateway runs on porttrack-staging at http://127.0.0.1:19788. It
owns authentication, destination policy, relay egress, the disposable PostgreSQL
database and encrypted artifacts. It dispatches to one worker on the same host
and one disposable Hetzner worker over two SSH Unix socket forwards. Both
workers run the same Linux AMD64 image and stock Chromium bundle. The worker
containers have loopback and Unix socket access through Docker's
`network_mode: none`. The worker host needs SSH access for the tunnel.

## Prepare both hosts

Use the FetchX checkout for the same release on both hosts, or copy the worker
Compose file and `deploy/chromium-seccomp.json` at the same relative paths to
Hetzner. The disposable server is an Ubuntu 24.04 AMD64 CX23 in HEL1. Use the
existing PortTrack public key for administrator access. Limit SSH ingress to the
operator and staging source addresses. Record the server ID and creation time
on the operator machine so the server can be deleted within 24 hours. Keep cloud
credentials and the PortTrack private key on the operator machine.

Run from the checkout on each host. Check first that `/srv/fxpool` and the
Compose projects are available for this test.

```sh
sudo sh deploy/browser-pool/prepare-layout.sh staging   # porttrack-staging
sudo sh deploy/browser-pool/prepare-layout.sh remote    # Hetzner
```

The script reserves the dedicated `fetchx-tunnel` host identity and checks
for conflicts at UID and GID 10001. The Docker image and worker use the same
numeric identity. Use Docker without UID remapping for these binds. Each socket
directory is mode `0700` and each socket is mode `0600`.

| Host | Path under `/srv/fxpool` | Listener |
| --- | --- | --- |
| Both | `run/worker/worker.sock` | Worker service |
| Staging | `run/cb/gw.sock` | Gateway callbacks and relay |
| Staging | `run/remote/worker.sock` | SSH client forwarding to the remote worker |
| Hetzner | `run/cb/gw.sock` | SSH server forwarding back to the staging gateway |

The gateway mounts the local and forwarded worker directories and the
root-managed registry read-only. Each worker mounts the callback directory
read-only and writes only its socket directory and temporary files. The
gateway's private configuration lives under the root-only `secrets/`
directory. Set `secrets/gateway.json` to `10001:10001` and `0400` so
Docker can bind it directly for the gateway.

## Build once and pin Chromium

The existing Dockerfile installs the Playwright Chromium libraries, fonts and
CA roots. Build a versioned image from the reviewed release on staging.

```bash
export FETCHX_POOL_IMAGE=fetchx-browser-pool:0.3.0-staging.1
sudo docker build --platform linux/amd64 -t "$FETCHX_POOL_IMAGE" .
archive="$HOME/fetchx-pool-worker-${FETCHX_POOL_IMAGE##*:}.tar"
(umask 077; sudo docker image save "$FETCHX_POOL_IMAGE" > "$archive")
```

Use the tag for the release under test. Transfer the archive over authenticated
SSH. On each host, set `archive` to the local path and run this check before
loading on Hetzner. Compare the archive SHA-256, embedded image config SHA-256
and ordered RootFS layer digests against the staging output.

```bash
(
  set -euo pipefail
  config_member=$(tar -xOf "$archive" manifest.json |
    jq -er 'if length == 1 then .[0].Config else error("expected one image in the archive") end')
  sha256sum "$archive"
  tar -xOf "$archive" -- "$config_member" | sha256sum
  tar -xOf "$archive" -- "$config_member" |
    jq -ce 'select(.os == "linux" and .architecture == "amd64") | .rootfs.diff_ids'
)
```

Load the verified archive on Hetzner with `sudo docker image load -i "$archive"`.
On each host, check that the installed image is Linux AMD64 and reports the same
ordered layer digests as the archive.

```bash
sudo docker image inspect "$FETCHX_POOL_IMAGE" |
  jq -ce '.[0] | select(.Os == "linux" and .Architecture == "amd64") | .RootFS.Layers'
```

Compare the displayed image `.Id` only when both hosts use the same Docker
Engine and image store format. Docker's classic and containerd stores can
display different IDs for the same loaded archive.

Install the browser build paired with the image's Playwright dependency into the
private staging asset directory. The installer runs once with network access.
The Compose worker services run with the pinned bundle mounted read-only.

```bash
sudo docker run --rm --platform linux/amd64 --user 0:0 \
  -e PLAYWRIGHT_BROWSERS_PATH=/opt/gateway-browser \
  --mount type=bind,src=/srv/fxpool/browser,dst=/opt/gateway-browser \
  "$FETCHX_POOL_IMAGE" node node_modules/playwright-core/cli.js install chromium --no-shell

set -o pipefail
sudo docker run --rm -i --platform linux/amd64 --network none --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=128m,mode=1777 \
  -e HOME=/tmp -e PLAYWRIGHT_BROWSERS_PATH=/opt/gateway-browser \
  --mount type=bind,src=/srv/fxpool/browser,dst=/opt/gateway-browser,readonly \
  "$FETCHX_POOL_IMAGE" node --input-type=module - <<'JS' | sudo tee /srv/fxpool/pin/runtime.json >/dev/null
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright-core';
import {binarySha} from './src/v2-browser-policy.mjs';

const executablePath = chromium.executablePath();
const version = execFileSync(executablePath, ['--version'], {encoding: 'utf8'})
  .match(/\b\d+\.\d+\.\d+\.\d+\b/)?.[0];
if (!version) throw Error('unexpected Chromium version');
const sha256 = await binarySha(executablePath);
console.log(JSON.stringify({engine: 'chromium', executablePath, version, sha256}, null, 2));
JS
sudo chown root:root /srv/fxpool/pin/runtime.json
sudo chmod 0444 /srv/fxpool/pin/runtime.json
```

Copy `browser/` and `pin/runtime.json` from staging to the same paths on
Hetzner. Preserve the browser bundle's file layout and executable modes. Keep the
directories root-owned and readable by UID 10001. Compare the bundle archive
digest before extracting it and compare the actual worker health pins on both
hosts after start. Keep the image archive, browser binaries, and runtime files
outside Git.

## Configure the isolated gateway

Set `FETCHX_HOME=/srv/fxpool` and the same `FETCHX_POOL_IMAGE` on both hosts in
root-owned mode `0600` `/srv/fxpool/stack.env`. Add a fresh random hex
`FETCHX_DB_PASSWORD` on staging. Compose uses independent project volumes
`fetchx-staging_fetchx-db` and `fetchx-staging_fetchx-artifacts` and the
database `gateway_test_browserpool`.

Create a fresh gateway config with a fresh artifact encryption key, empty
`proxies`, and no provider credentials. Keep the control plane and paid providers
disabled. Each active, ready worker supplies one browser slot. The gateway also
applies its shared `maxConcurrentRequests` cap (default `4`) across active v2
operations and reserved or sent v1 attempts. Add this pool configuration under
`v2`.

```json
{
  "browser_pool": {
    "registry_path": "/run/fx/registry/workers.json",
    "callback_socket": "/run/fx/cb/gw.sock"
  }
}
```

Initialize `/srv/fxpool/registry/workers.json` as a root-owned file with
mode `0644` and contents `[]`. Give the staging test project one reviewed
static access profile with the fixture HTTPS origin and paths, `GET` and
`HEAD`, the `direct` proxy class, and a bounded `browser_probe` envelope.
See [profile and runtime bounds](api-v2-browser-probe.md). Use
`scripts/provision-v2-project.mjs` to create the test key for
`http://127.0.0.1:19788`. Store its output in the root-only secrets directory,
then set the final gateway file ownership and mode. For the scrape API, configure
`v2.scrape.projects[project]` with the profile reference in
`access_profile: {id, version}`, `proxy: {class: "direct", country: null}`
and `max_estimated_micro_usd: 0`.

Keep `v2.browser_probe.enabled` false while preparing the runtime. After
qualification, set `engine` to `chromium` and set the version and SHA-256
in `runtime` to the values from `pin/runtime.json`. With the pool
configured, the gateway matches the pin against worker health. Use the accepted
`pinned-relay-egress-v2` qualification for the exact pin and platform
(`linux`, `x64`), with an evidence digest and expiry covering the test.

## Start the stack and SSH tunnel

In Bash on staging, define `gateway`. Define `worker` on both hosts. Run the
configuration checks from the Compose directory before starting the services.

```bash
gateway() {
  sudo docker compose --env-file /srv/fxpool/stack.env -p fetchx-staging \
    -f compose.yaml -f compose.browser-pool.yaml "$@"
}
worker() {
  sudo docker compose --env-file /srv/fxpool/stack.env -p fetchx-pool-worker \
    -f compose.browser-worker.yaml "$@"
}

gateway config --quiet    # staging only, requires support for !reset and !override
worker config --quiet     # both hosts
gateway up -d --no-build  # staging only
worker up -d --no-build   # both hosts
```

Generate a separate temporary Ed25519 identity on staging for the tunnel. Store
its private key as `/srv/fxpool/tunnel/id_ed25519`, owner `10001:10001`,
mode `0600`. Verify the Hetzner server's host key through the console or an
already authenticated administrator connection. Install the pinned host entry as
`/srv/fxpool/tunnel/known_hosts`.

On the disposable VM, write only the dedicated public key to
`/etc/ssh/fetchx-pool.authorized_keys`, root-owned mode `0644`. Prefix the key
with `restrict,port-forwarding,from="<staging-public-ip>/32"` for the verified
staging IPv4 address. Append `deploy/browser-pool/sshd-match.conf` as the final
block in `/etc/ssh/sshd_config`. Validate with `sudo sshd -t` and reload
`sudo systemctl reload ssh`, keeping the administrator session open for
verification. This account allows Unix socket forwarding in both directions and
zero SSH sessions. OpenSSH 9.6 shares the channel permissions between TCP and
Unix sockets. `AllowTcpForwarding yes` enables the shared permission in both
directions. `PermitListen none` denies remote TCP listeners while allowing remote
Unix sockets. `PermitOpen [/srv/fxpool/run/worker/worker.sock]:*` restricts direct
connections to the exact worker socket path. OpenSSH requires the brackets to
parse the path and `*` to match its Unix socket port marker. The forwarding
sockets and tunnel key share the pool's numeric identity on the host. The SSH
key directory stays outside the worker mounts.

On staging, start the tunnel as the dedicated UID with both forwards. Replace
`$REMOTE_IP` with the verified server address. Set the runtime limit to the
remaining test window if it is shorter than 24 hours.

```bash
sudo systemd-run --unit=fetchx-pool-tunnel --uid=10001 --gid=10001 \
  --property=RuntimeMaxSec=24h --property=NoNewPrivileges=yes --property=UMask=0077 \
  /usr/bin/ssh -F /dev/null -NT \
  -i /srv/fxpool/tunnel/id_ed25519 \
  -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile=/srv/fxpool/tunnel/known_hosts \
  -o GlobalKnownHostsFile=/dev/null -o UpdateHostKeys=no \
  -o ConnectTimeout=10 -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=10 -o ServerAliveCountMax=3 \
  -o StreamLocalBindMask=0177 -o StreamLocalBindUnlink=yes \
  -L /srv/fxpool/run/remote/worker.sock:/srv/fxpool/run/worker/worker.sock \
  -R /srv/fxpool/run/cb/gw.sock:/srv/fxpool/run/cb/gw.sock \
  "fetchx-tunnel@$REMOTE_IP"
```

Check `systemctl status fetchx-pool-tunnel` on staging and use `stat` on both
hosts to check the socket owners and modes. Verify that SSH rejects TCP forwarding
using separate, time-bounded connections from staging. Use the same UID, identity,
host key options and destination as the tunnel above. Omit its two socket forwards.

- Run SSH with `-NT -o ExitOnForwardFailure=yes -R 127.0.0.1:0:127.0.0.1:1`.
  After authentication, SSH should exit with a remote port forwarding failure.
- Run SSH with `-W 127.0.0.1:22`. After authentication, SSH should reject the
  direct TCP channel as administratively prohibited.
- On the VM, run `getent ahosts /srv/fxpool/run/worker/worker.sock`. The socket
  path must produce no addresses and exit nonzero.

Run the HTTP and socket health checks from staging.

```bash
curl -fsS http://127.0.0.1:19788/healthz
sudo -u fetchx-tunnel curl -fsS --unix-socket /srv/fxpool/run/worker/worker.sock http://localhost/healthz
sudo -u fetchx-tunnel curl -fsS --unix-socket /srv/fxpool/run/remote/worker.sock http://localhost/healthz
```

The two worker responses should be `ready: true`, with identical Chromium
version, SHA-256, platform and architecture. Publish the registry by writing
this JSON to a new file in the registry directory and renaming it over
`workers.json`.

```json
[
  {"id":"local","socket_path":"/run/fx/local/worker.sock","state":"active"},
  {"id":"hetzner","socket_path":"/run/fx/remote/worker.sock","state":"active"}
]
```

## Qualify and verify

- Use `worker ps`, `docker inspect` and `worker exec -T worker ls /sys/class/net`
  on each host. Check the worker has only loopback, a read-only root, numeric
  UID 10001, `ALL` capabilities dropped, no new privileges, the Chromium seccomp
  profile, 2 GiB memory, 256 PIDs and an init process.
- Run the sandbox smoke check below on both workers before accepting requests.
  An `unshare --user --map-root-user true` check inside the worker can help
  diagnose kernel or AppArmor denials. Inspect host audit logs and Docker
  security configuration if launch fails. Keep the Chromium sandbox, seccomp
  and capability restrictions enabled.
- Run the repository's real-browser recipe and TLS/admission fixtures serially
  with the exact `BROWSER_TEST_EXECUTABLE` and a disposable
  `gateway_test_*` PostgreSQL database separate from the staging benchmark
  data. Use synthetic fixtures for redirect, secondary target, request caps,
  private-network and failure-path checks. Record the runtime, image archive
  and config hashes, layer digests, security settings and fixture results in
  private qualification evidence.
- Use the reviewed staging qualification record to enable Browser and recreate
  just the gateway with
  `gateway up -d --no-build --no-deps --force-recreate gateway`. In the registry,
  temporarily mark one worker `draining` at a time so a fresh test request
  must use the other. Verify each worker can complete a controlled, approved
  HTTPS scrape with the direct route and the expected DOM. The remote success
  also exercises the reverse callback path and gateway-owned egress. With both
  active, test concurrent requests using distinct idempotency keys. Record
  source acceptance, HTTP status, browser capture, latency and worker activity.
- Test tunnel interruption during a synthetic request. Recover using the
  original idempotency key or operation ID. Confirm that an uncertain operation
  cannot be replayed on the other worker. Check that `busy` returns to false
  and `worker top worker` shows the service and no leftover Chromium process.
  Use the same checks after an ordinary render.

Run this smoke check with the worker idle and drained. It uses the worker
container's security settings and Chromium launch options with an in-memory
document.

```bash
worker exec -T worker node --input-type=module - <<'JS'
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright-core';
import {binarySha, browserProbeLaunchOptions} from './src/v2-browser-policy.mjs';

const runtime = JSON.parse(await readFile(process.env.FETCHX_WORKER_RUNTIME, 'utf8'));
if (await binarySha(runtime.executablePath) !== runtime.sha256) throw Error('Chromium pin mismatch');
const cacheDir = await mkdtemp(join(tmpdir(), 'pool-sandbox-'));
let browser, server;
try {
  const options = await browserProbeLaunchOptions(runtime, {
    relay: 'http://127.0.0.1:1', denyRelay: 'http://127.0.0.1:2',
    cacheDir, deadline: Date.now() + 15000
  });
  server = await chromium.launchServer(options);
  browser = await chromium.connect(server.wsEndpoint());
  const page = await browser.newPage({serviceWorkers: 'block'});
  await page.setContent('<title>FetchX sandbox smoke</title><p>Worker ready</p>');
  if (await page.title() !== 'FetchX sandbox smoke') throw Error('unexpected smoke DOM');
  console.log('Chromium sandbox smoke passed');
} finally {
  await browser?.close().catch(() => {});
  await server?.close().catch(() => {});
  await rm(cacheDir, {recursive: true, force: true});
}
JS
```

## Drain and remove

Atomically mark both workers `draining` and wait until both are idle and the
test receipts have been recorded. Run `worker down` on both hosts, stop the
staging `fetchx-pool-tunnel` unit, and check for residual listener sockets in
`/srv/fxpool/run` before removing the dedicated test layout. Run
`gateway down --volumes` only for the disposable `fetchx-staging` project
once evidence is preserved. Remove the temporary tunnel private key and the
staging-only bearer material.

Delete the Hetzner server from the operator account by the recorded server ID
within 24 hours. Confirm deletion and release any IP or firewall created
specifically for the test if it is unused. Stopping the container or VM still
leaves the cloud server allocated.

## Production on the existing host

Production uses two local, one-slot containers on the existing Linux AMD64
host. Keep the single gateway and database in Compose project
`crawling-platform`. Run only `browser-worker-1` and `browser-worker-2` in the
independent project `fetchx-browser-workers`. The gateway retains source egress,
destination/profile policy, reservations, billing, encrypted artifacts and
durable idempotency. This adds execution slots, not another gateway or database.

Use `deploy/browser-pool/compose.production.gateway.yaml` as the final overlay
after the preserved production `deploy/compose.yaml` and
`deploy/github-override.yaml`. It appends four mounts by container target and
does not set ports, environment, images, database services or existing mounts.
Retain the configuration mount from
`/opt/crawling-platform/secrets/gateway.json`, the artifacts bind from
`/opt/crawling-platform/data/artifacts`, and the existing read-only browser bind
from `/opt/crawling-platform/browser`. The staging overlays above change the
database and port and must not be used for this deployment.

### Production runtime contract

`FETCHX_POOL_HOME` defaults to `/opt/crawling-platform/browser-pool` and
`FETCHX_BROWSER_HOME` defaults to `/opt/crawling-platform/browser`. Create and
check these directories before starting Compose; all binds reject missing host
paths. Do not run the staging `prepare-layout.sh` for production.

| Path under `FETCHX_POOL_HOME` | Owner and mode | Container access |
| --- | --- | --- |
| `run/worker-1`, `run/worker-2` | `10001:10001`, `0700` | Corresponding worker writes; gateway reads |
| `run/cb` | `10001:10001`, `0700` | Gateway writes; both workers read |
| `registry` | `root:root`, `0755` | Gateway reads |
| `registry/workers.json` | `root:root`, `0644` | Gateway reads |
| `pin` | `root:root`, `0755` | Both workers read |
| `pin/runtime.json` | `root:root`, `0444` | Both workers read |
| `worker.env` | `root:root`, `0600` | Compose interpolation only; never mounted |

Keep parent directories traversable by UID 10001 and use Docker without UID
remapping. Listener sockets are created as `10001:10001`, mode `0600`.
The gateway sees `/run/fx/worker-1/worker.sock`,
`/run/fx/worker-2/worker.sock`, `/run/fx/cb/gw.sock`, and
`/run/fx/registry/workers.json`. Each worker sees only its own socket at
`/run/fx/local/worker.sock`, the shared callback at `/run/fx/cb/gw.sock`, the
read-only pin at `/run/fx/pin/runtime.json`, and the existing browser bundle at
`/opt/gateway-browser`.

Put the reviewed gateway image's immutable image ID or repository digest in
`worker.env` as `FETCHX_POOL_IMAGE`; the worker definition has no default image
and never pulls or builds one. The only other allowed entries in that file are
the two absolute root paths, `FETCHX_POOL_HOME` and `FETCHX_BROWSER_HOME`.
Do not source, copy or pass the private production `production.env` to the
worker command. There is no worker `env_file` directive: its container
environment declares only the three `FETCHX_WORKER_*` runtime paths, in addition
to the reviewed image's built-in environment. Workers never receive database,
OAuth, provider or customer credentials and never mount the secrets, artifacts
or registry directories.

Use the exact existing, qualified browser bundle. `pin/runtime.json` contains
only `engine: "chromium"`, the absolute container `executablePath`, its
four-part `version`, and its SHA-256 `sha256`. Match these values to the
gateway's approved `v2.browser_probe` runtime and unexpired qualification for
`linux`/`x64`. Verify the executable and bundle before start; do not download,
replace or repin the production browser as part of enabling workers.

Add only this opt-in configuration under the existing `v2` object:

```json
{
  "browser_pool": {
    "registry_path": "/run/fx/registry/workers.json",
    "callback_socket": "/run/fx/cb/gw.sock"
  }
}
```

Retain `browser.maxConcurrent: 2`, `maxConcurrentRequests: 8`, the existing
per-source caps, profiles, credentials, budgets and all other production policy.
Initialize the registry as `[]` until both workers pass runtime, sandbox and
callback checks. Then publish the following registry atomically by writing a
new file in the same directory and renaming it over `workers.json`:

```json
[
  {"id":"worker-1","socket_path":"/run/fx/worker-1/worker.sock","state":"active"},
  {"id":"worker-2","socket_path":"/run/fx/worker-2/worker.sock","state":"active"}
]
```

### Production configuration checks and cutover

Use the candidate release directory in `release` below. Keep its relative
`deploy/browser-pool/` and `deploy/chromium-seccomp.json` layout intact. Do not
override Compose's project directory: the worker's seccomp path resolves from
its Compose file directory. The worker command uses only its image/path file;
the gateway command alone uses the existing private production environment.

```bash
gateway() {
  sudo docker compose --env-file /opt/crawling-platform/secrets/production.env \
    -p crawling-platform \
    -f "$release/deploy/compose.yaml" \
    -f "$release/deploy/github-override.yaml" \
    -f "$release/deploy/browser-pool/compose.production.gateway.yaml" "$@"
}
worker() {
  sudo docker compose --env-file /opt/crawling-platform/browser-pool/worker.env \
    -p fetchx-browser-workers \
    -f "$release/deploy/browser-pool/compose.production.workers.yaml" "$@"
}

gateway config --quiet
worker config --quiet
```

Before cutover, compare the resolved gateway configuration with the preserved
production configuration: services, database, ports, environment, volumes and
source caps must be unchanged except for the four added pool mounts and the
reviewed gateway image/config changes. Confirm the resolved worker project has
exactly the two worker services and no networks, ports, secrets, database or
artifact mounts. Check the same reviewed Linux AMD64 image is selected for all
three containers, and that the host has capacity for two workers at 2 GiB and
256 PIDs each alongside the existing gateway and database.

Use the production drain, backup and rollback procedure before replacing the
single gateway. Start the worker project with `worker up -d --no-build`; its
workers remain unready while the gateway callback is absent. Recreate only the
gateway using `gateway up -d --no-build --no-deps --force-recreate gateway`,
with the reviewed production configuration. Never run `gateway down`, use a
second gateway, or replace the database during this cutover.

Inspect each worker's health over its host Unix socket and confirm
`ready: true`, `busy: false`, and the exact approved runtime. Inspect its running
security settings: UID/GID 10001, network `none` with only loopback, read-only
root, read-only browser/pin/callback binds, only its own writable socket bind,
`ALL` capabilities dropped, no new privileges, the supplied seccomp profile,
init, and the configured resource limits. Run the sandbox smoke check above
with `worker exec -T browser-worker-1` and `browser-worker-2` respectively.

After registry publication, drain one worker at a time to verify each through
an approved synthetic end-to-end `/v2/scrape` request; check expected content,
worker activity, encrypted captures and the durable operation/ledger result.
Then test both workers with distinct concurrent idempotency keys and confirm
both return idle without leftover Chromium children. A health response alone
does not establish scrape or source acceptance. Do not replay uncertain source
work on the other worker; recover with the original idempotency key.

For removal or rollback, atomically mark both entries `draining`, wait until
both are idle and in-flight gateway work is settled, and stop only the worker
project. Remove `v2.browser_pool` and the production gateway overlay only via
the reviewed gateway rollback. Preserve the live database, artifacts, original
ledger and uncertain reservations; do not restore an old spending ledger or
delete the production layout as part of a code rollback.

### Add a remote host without restarting the gateway

The gateway reloads `workers.json` on admission. Its existing read-only
`registry` directory mount also exposes new host-created socket entries, so a
third worker does not need a new mount or gateway restart. Forward the remote
worker into `/opt/crawling-platform/browser-pool/registry/remote-worker-3.sock`;
the gateway sees `/run/fx/registry/remote-worker-3.sock`. Keep the two existing
local workers and all existing registry rows.

On the new Linux AMD64 host, run only the isolated worker using the same
reviewed image, exact browser bundle and runtime pin, with its own private
layout (for example `/opt/fetchx-worker`). Give the remote worker and tunnel
account UID/GID 10001; its `run/worker` and `run/cb` directories must be owned by
that identity with mode `0700`. Use the authenticated Unix-socket-only SSH
transport and restrictive account/key/firewall checks described above, adapting
the remote `PermitOpen` path to
`[/opt/fetchx-worker/run/worker/worker.sock]:*`. Verify both negative TCP-forward
probes against the effective SSH configuration before registration.

| SSH forwarding from the production host | Mapping |
| --- | --- |
| Local `-L` | `/opt/crawling-platform/browser-pool/registry/remote-worker-3.sock:/opt/fetchx-worker/run/worker/worker.sock` |
| Reverse `-R` | `/opt/fetchx-worker/run/cb/gw.sock:/opt/crawling-platform/browser-pool/run/cb/gw.sock` |

The production `registry` directory stays `root:root`, mode `0755`. A
root-managed SSH client must bind the local listener there, then set that socket
to `10001:10001`, mode `0600`, after every listener creation or reconnect.
Do not grant the tunnel UID directory write access. Set `StreamLocalBindMask
0177` on the client and remote SSH server; the remote tunnel account must be
able to bind its private callback directory. Keep keys and pinned host keys
outside worker mounts. Linux allows the gateway to connect through the
read-only mount using the socket's write permission without granting registry
file writes; see [Linux pathname-socket permissions](https://man7.org/linux/man-pages/man7/unix.7.html).

Check the new forwarded socket from inside the running gateway: health must
report `ready: true`, `busy: false` and the exact qualified runtime. Run the
remote sandbox smoke check, then atomically append this row to the existing
registry:

```json
{"id":"remote-worker-3","socket_path":"/run/fx/registry/remote-worker-3.sock","state":"active"}
```

Each additional ready worker adds one v2 browser slot; pool-backed v2 execution
uses registry capacity rather than `browser.maxConcurrent`. Keep the global
`maxConcurrentRequests: 8`, source/profile limits and budgets unchanged. The
remote container remains `network_mode: none` without provider credentials;
all source traffic and metering still pass through the authenticated gateway
callback. Provisioning a worker does not authorize paid requests or bypass
source admission. Verify new capacity with an approved synthetic request and
distinct idempotency key. To remove it, mark its row `draining`, wait for idle,
then stop its tunnel/worker and remove only its row and owned listener. Never
reroute uncertain work to another worker.
