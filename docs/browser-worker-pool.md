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
