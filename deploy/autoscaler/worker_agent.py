#!/usr/bin/python3
"""Root-only disposable-VM helper. Receives reviewed assets, never cloud secrets."""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time

HOME = Path("/opt/fetchx-worker")
NET = Path("/sys/class/net")
BOOT_ID = Path("/proc/sys/kernel/random/boot_id")
CONTAINER = "fetchx-autoscaled-worker"
HEX = re.compile(r"[a-f0-9]{64}\Z")
DIGEST = re.compile(r"sha256:[a-f0-9]{64}\Z")


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def sha(path):
    digest = hashlib.sha256()
    with open(path, "rb") as file:
        for data in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(data)
    return digest.hexdigest()


def validate_manifest(value):
    if not isinstance(value, dict) or set(value) != {"version", "image", "browser", "runtime_pin", "seccomp"} or value["version"] != 1:
        raise ValueError("invalid manifest version/fields")
    for name, fields in (("image", {"archive", "sha256", "ref", "rootfs_layers"}),
                         ("browser", {"archive", "sha256", "executable"}), ("seccomp", {"path", "sha256"})):
        item = value[name]
        if not isinstance(item, dict) or set(item) != fields or not isinstance(item["sha256"], str) or not HEX.fullmatch(item["sha256"]):
            raise ValueError("invalid manifest asset")
        path = item["path" if name == "seccomp" else "archive"]
        if not isinstance(path, str) or "\x00" in path:
            raise ValueError("invalid asset path")
    image = value["image"]
    if not isinstance(image["ref"], str) or not re.fullmatch(r"fetchx-autoscaler-pinned:[a-f0-9]{12,64}", image["ref"]):
        raise ValueError("use a private deterministic archive tag")
    if not isinstance(image["rootfs_layers"], list) or not image["rootfs_layers"] or len(image["rootfs_layers"]) > 256 or any(not isinstance(v, str) or not DIGEST.fullmatch(v) for v in image["rootfs_layers"]):
        raise ValueError("invalid ordered image layer inventory")
    pin = value["runtime_pin"]
    if not isinstance(pin, dict) or set(pin) != {"engine", "executablePath", "version", "sha256"} or pin["engine"] != "chromium" or not isinstance(pin["sha256"], str) or not HEX.fullmatch(pin["sha256"]) or not isinstance(pin["version"], str) or not re.fullmatch(r"\d+\.\d+\.\d+\.\d+", pin["version"]):
        raise ValueError("invalid runtime pin")
    executable = value["browser"]["executable"]
    if not isinstance(executable, str) or not executable.startswith("/opt/gateway-browser/") or ".." in PurePosixPath(executable).parts or pin["executablePath"] != executable:
        raise ValueError("invalid pinned browser executable")
    return value


def run(argv, timeout=180, check=True, **kwargs):
    return subprocess.run(argv, check=check, timeout=timeout, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)


def write(path, data, mode=0o600):
    path = Path(path)
    fd, name = tempfile.mkstemp(prefix=".new-", dir=path.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "wb") as file:
            file.write(data.encode() if isinstance(data, str) else data)
            file.flush()
            os.fsync(file.fileno())
        os.replace(name, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        Path(name).unlink(missing_ok=True)


def settings():
    value = json.loads((HOME / "worker.json").read_text())
    if not isinstance(value, dict) or set(value) != {"id", "created_at", "hard_deadline", "lease_seconds", "max_vm_egress_bytes"} or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,31}", value["id"]):
        raise ValueError("invalid worker settings")
    if type(value["max_vm_egress_bytes"]) is not int or value["max_vm_egress_bytes"] <= 0:
        raise ValueError("invalid worker egress limit")
    for field in ("created_at", "hard_deadline", "lease_seconds"):
        if type(value[field]) not in (float, int) or not 0 < value[field] < 1e12:
            raise ValueError("invalid worker timing")
    if value["hard_deadline"] <= value["created_at"] or not 30 <= value["lease_seconds"] <= 3600:
        raise ValueError("invalid worker timing")
    return value


def check_egress(initialize=False):
    """Account only device-backed interfaces, excluding loopback/bridge/veth.

    Include bytes sent before configuration; counter/boot resets add new bytes
    without restoring allowance. A separate lock serializes watchdog and SSH.
    """
    with os.fdopen(os.open(HOME / "egress.lock", os.O_CREAT | os.O_RDWR, 0o600), "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        counters = {p.name: int((p / "statistics/tx_bytes").read_text())
                    for p in NET.iterdir() if p.name != "lo" and (p / "device").exists()}
        boot = BOOT_ID.read_text().strip()
        if not counters or any(v < 0 for v in counters.values()) or not boot:
            raise ValueError("worker egress counters unavailable")
        path = HOME / "egress.json"
        if initialize and not path.exists() and not (HOME / "configured").exists():
            old = {"boot": boot, "total": 0, "counters": {k: 0 for k in counters}}
        else:
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600:
                raise ValueError("invalid worker egress state")
            old = json.loads(path.read_text())
        if (set(old) != {"boot", "total", "counters"} or not isinstance(old["boot"], str) or not old["boot"]
                or type(old["total"]) is not int or old["total"] < 0
                or not isinstance(old["counters"], dict) or set(old["counters"]) != set(counters)
                or any(type(v) is not int or v < 0 for v in old["counters"].values())):
            raise ValueError("invalid worker egress state")
        total = old["total"] + sum(v - old["counters"][k] if boot == old["boot"] and v >= old["counters"][k] else v
                                   for k, v in counters.items())
        write(path, canonical({"boot": boot, "total": total, "counters": counters}))
        if total >= settings()["max_vm_egress_bytes"]:
            raise ValueError("worker egress limit reached")


def require_egress():
    try:
        check_egress()
    except Exception:
        retire()
        raise ValueError("worker egress unavailable or exhausted") from None


def configure():
    settings()
    check_egress(initialize=True)
    run(["groupadd", "-f", "-g", "10001", "fetchx-worker"])
    run(["usermod", "-u", "10001", "-g", "10001", "-p", "*", "fetchx-tunnel"])
    for name in ("run/worker", "run/cb"):
        path = HOME / name
        path.mkdir(parents=True, exist_ok=True)
        os.chown(path, 10001, 10001)
        os.chmod(path, 0o700)
    for name in ("", "run", "browser", "pin"):
        path = HOME / name
        path.mkdir(parents=True, exist_ok=True)
        os.chown(path, 0, 0)
        os.chmod(path, 0o755)
    config = Path("/etc/ssh/sshd_config")
    marker = "Include /etc/ssh/fetchx-tunnel.match"
    text = config.read_text()
    if marker not in text.splitlines():
        write(config, text.rstrip() + "\n\n# FetchX disposable worker account: final Match block.\n" + marker + "\n", 0o600)
    # Kernel forwarding must not allow a future accidental bridge network to route traffic.
    write("/etc/sysctl.d/90-fetchx-worker.conf", "net.ipv4.ip_forward=0\nnet.ipv6.conf.all.forwarding=0\n")
    run(["sysctl", "--system"])
    # Cloud-init first creates the host identity; only report ready once all policy is installed.
    write(HOME / "configured", "1\n")


def verify_sshd():
    output = run(["sshd", "-T", "-C", "user=fetchx-tunnel,host=localhost,addr=127.0.0.1"]).stdout.decode()
    actual = dict(line.split(" ", 1) for line in output.splitlines() if " " in line)
    expected = {"allowtcpforwarding": "yes", "allowstreamlocalforwarding": "yes", "permitlisten": "none",
                "permitopen": "[/opt/fetchx-worker/run/worker/worker.sock]:*", "maxsessions": "0",
                "streamlocalbindmask": "0177", "streamlocalbindunlink": "yes", "permittty": "no",
                "passwordauthentication": "no", "kbdinteractiveauthentication": "no", "allowagentforwarding": "no"}
    if any(actual.get(key) != val for key, val in expected.items()):
        raise ValueError("effective sshd policy mismatch")
    # The path-shaped PermitOpen name must never resolve as a TCP hostname.
    if run(["getent", "ahosts", "/opt/fetchx-worker/run/worker/worker.sock"], check=False).returncode == 0:
        raise ValueError("worker socket path resolved as a network hostname")


def lease_valid():
    try:
        config = settings()
        lease = json.loads((HOME / "lease.json").read_text())["expires_at"]
        return (not (HOME / "retired").exists() and type(lease) in (int, float)
                and time.time() < lease <= min(config["hard_deadline"], time.time() + config["lease_seconds"] + 2))
    except (OSError, ValueError, KeyError, TypeError):
        return False


def renew():
    config = settings()
    require_egress()
    value = json.loads(sys.stdin.buffer.read(1025))
    now = time.time()
    if set(value) != {"expires_at"} or type(value["expires_at"]) not in (int, float) or not now < value["expires_at"] <= min(config["hard_deadline"], now + config["lease_seconds"] + 2):
        raise ValueError("invalid worker renewal")
    if (HOME / "retired").exists() or now >= config["hard_deadline"]:
        raise ValueError("worker is retired")
    # An expired started worker may never be resurrected by a delayed renewal.
    if (HOME / "started").exists() and not lease_valid():
        retire()
        raise ValueError("started worker lease expired")
    write(HOME / "lease.json", canonical(value))


def retire():
    write(HOME / "retired", "expired\n")
    stopped = False
    try:
        stopped = run(["docker", "stop", "--time", "0", CONTAINER], timeout=10, check=False).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        pass
    if not stopped:
        try:
            stopped = run(["docker", "kill", CONTAINER], timeout=5, check=False).returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            pass
    if not stopped:
        # This VM has no other workload. A broken Docker daemon must not extend
        # the browser lease. Poweroff stops work, but provider billing continues.
        run(["systemctl", "--no-block", "poweroff"], timeout=5, check=False)


def watchdog():
    while True:
        try:
            require_egress()
            expired = time.time() >= settings()["hard_deadline"]
            if expired or ((HOME / "started").exists() and not lease_valid()):
                retire()
        except Exception:
            # Corrupt/missing settings or Docker problems never authorize continued work.
            try:
                retire()
            except Exception:
                pass
        time.sleep(1)


def status():
    settings()
    if not (HOME / "configured").is_file():
        raise ValueError("cloud-init configuration incomplete")
    run(["systemctl", "is-active", "--quiet", "docker", "nftables", "fetchx-worker-watchdog"])
    path = HOME / "manifest.json"
    print(canonical({"manifest_sha256": sha(path) if path.exists() else None}))


def image_matches(manifest):
    result = run(["docker", "image", "inspect", manifest["image"]["ref"]], check=False)
    if result.returncode:
        return False
    values = json.loads(result.stdout)
    return (len(values) == 1 and values[0].get("Os") == "linux" and values[0].get("Architecture") == "amd64"
            and values[0].get("RootFS", {}).get("Layers") == manifest["image"]["rootfs_layers"])


def extract_browser(archive, destination):
    """Archive contains browser-directory contents, with no outer browser/ prefix."""
    with tarfile.open(archive, "r:*") as bundle:
        members = bundle.getmembers()
        if not members or len(members) > 100000:
            raise ValueError("invalid browser archive size")
        for member in members:
            parts = PurePosixPath(member.name).parts
            if not parts or PurePosixPath(member.name).is_absolute() or ".." in parts or not (member.isfile() or member.isdir() or member.issym()):
                raise ValueError("unsafe browser archive member")
            if member.issym():
                target = PurePosixPath(member.linkname)
                if target.is_absolute() or ".." in target.parts:
                    raise ValueError("unsafe browser symlink")
            member.uid = member.gid = 0
            member.uname = member.gname = "root"
            member.mode = (member.mode & 0o555) | (0o755 if member.isdir() else 0o444)
        # Ubuntu 24.04 Python 3.12 data filter also prevents writing through symlinks.
        bundle.extractall(destination, members=members, filter="data")
        # data_filter deliberately grants owner-write while extracting. Remove it
        # from files after extraction so browser assets keep their read-only modes.
        for member in members:
            if member.isfile():
                os.chmod(Path(destination) / member.name, member.mode, follow_symlinks=False)


def install():
    settings()
    if (HOME / "manifest.json").exists() or (HOME / "started").exists():
        raise ValueError("assets already installed; use status after uncertain transfer")
    with tempfile.TemporaryDirectory(prefix="incoming-", dir=HOME) as temporary:
        incoming = Path(temporary)
        names = set()
        with tarfile.open(fileobj=sys.stdin.buffer, mode="r|") as transfer:
            for member in transfer:
                if member.name not in {"image.tar", "browser.tar", "manifest.json", "seccomp.json"} or member.name in names or not member.isfile() or member.size > 16 * 1024**3:
                    raise ValueError("invalid asset transfer")
                names.add(member.name)
                with transfer.extractfile(member) as source, open(incoming / member.name, "xb") as target:
                    shutil.copyfileobj(source, target, 1024 * 1024)
        if names != {"image.tar", "browser.tar", "manifest.json", "seccomp.json"}:
            raise ValueError("incomplete asset transfer")
        manifest = validate_manifest(json.loads((incoming / "manifest.json").read_text()))
        for kind, name in (("image", "image.tar"), ("browser", "browser.tar"), ("seccomp", "seccomp.json")):
            if sha(incoming / name) != manifest[kind]["sha256"]:
                raise ValueError("asset digest mismatch")
        # Validate saved RootFS inventory before loading and again through Docker afterward.
        with tarfile.open(incoming / "image.tar") as archive:
            entries = json.load(archive.extractfile("manifest.json"))
            chosen = [entry for entry in entries if manifest["image"]["ref"] in (entry.get("RepoTags") or [])]
            if len(chosen) != 1:
                raise ValueError("pinned archive tag missing/duplicated")
            image_config = json.load(archive.extractfile(chosen[0]["Config"]))
            if image_config.get("os") != "linux" or image_config.get("architecture") != "amd64" or image_config.get("rootfs", {}).get("diff_ids") != manifest["image"]["rootfs_layers"]:
                raise ValueError("archive RootFS inventory mismatch")
        run(["docker", "image", "load", "-i", str(incoming / "image.tar")], timeout=900)
        # Config IDs can vary across classic/containerd image stores; archive hash + ordered layers are authoritative.
        if not image_matches(manifest):
            raise ValueError("loaded image RootFS inventory mismatch")
        browser = incoming / "browser"
        browser.mkdir()
        extract_browser(incoming / "browser.tar", browser)
        executable = browser / manifest["browser"]["executable"].removeprefix("/opt/gateway-browser/")
        if not executable.is_file() or not os.access(executable, os.X_OK) or sha(executable) != manifest["runtime_pin"]["sha256"]:
            raise ValueError("extracted browser pin mismatch")
        # Remove only our initial empty directory. Existing assets imply an interrupted install and are verified below.
        existing = HOME / "browser"
        if existing.exists():
            shutil.rmtree(existing)
        os.replace(browser, existing)
        write(HOME / "pin/runtime.json", canonical(manifest["runtime_pin"]), 0o444)
        write(HOME / "seccomp.json", (incoming / "seccomp.json").read_bytes(), 0o444)
        write(HOME / "manifest.json", canonical(manifest))


def container_argv(manifest):
    return ["docker", "run", "-d", "--name", CONTAINER, "--pull=never", "--platform=linux/amd64",
            "--user=10001:10001", "--network=none", "--read-only", "--init", "--cap-drop=ALL",
            "--security-opt=no-new-privileges:true", "--security-opt=seccomp=" + str(HOME / "seccomp.json"),
            "--memory=2g", "--memory-swap=2g", "--pids-limit=256", "--shm-size=256m", "--restart=no",
            "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=512m,mode=1777", "--stop-timeout=45",
            "--log-driver=json-file", "--log-opt=max-size=10m", "--log-opt=max-file=3",
            "--mount=type=bind,src=" + str(HOME / "browser") + ",dst=/opt/gateway-browser,readonly",
            "--mount=type=bind,src=" + str(HOME / "pin") + ",dst=/run/fx/pin,readonly",
            "--mount=type=bind,src=" + str(HOME / "run/cb") + ",dst=/run/fx/cb,readonly",
            "--mount=type=bind,src=" + str(HOME / "run/worker") + ",dst=/run/fx/local",
            "--env=FETCHX_WORKER_RUNTIME=/run/fx/pin/runtime.json", "--env=FETCHX_WORKER_SOCKET=/run/fx/local/worker.sock",
            "--env=FETCHX_WORKER_CALLBACK_SOCKET=/run/fx/cb/gw.sock", manifest["image"]["ref"], "node", "src/v2-browser-worker-service.mjs"]


SMOKE = r"""
const {mkdtemp,readFile,rm}=await import('node:fs/promises');
const {tmpdir}=await import('node:os');const {join}=await import('node:path');
const {chromium}=await import('playwright-core');
const {binarySha,browserProbeLaunchOptions}=await import('./src/v2-browser-policy.mjs');
const runtime=JSON.parse(await readFile(process.env.FETCHX_WORKER_RUNTIME,'utf8'));
if(await binarySha(runtime.executablePath)!==runtime.sha256)throw Error('pin mismatch');
const cacheDir=await mkdtemp(join(tmpdir(),'pool-sandbox-'));let browser,server;
try{const options=await browserProbeLaunchOptions(runtime,{relay:'http://127.0.0.1:1',denyRelay:'http://127.0.0.1:2',cacheDir,deadline:Date.now()+15000});
server=await chromium.launchServer(options);browser=await chromium.connect(server.wsEndpoint());
const page=await browser.newPage({serviceWorkers:'block'});await page.setContent('<title>FetchX sandbox smoke</title>');
if(await page.title()!=='FetchX sandbox smoke')throw Error('DOM mismatch');}
finally{await browser?.close();await server?.close();await rm(cacheDir,{recursive:true,force:true});}
"""


def start():
    require_egress()
    if not lease_valid():
        raise ValueError("worker lease missing/expired")
    manifest = validate_manifest(json.loads((HOME / "manifest.json").read_text()))
    if not image_matches(manifest) or sha(HOME / "seccomp.json") != manifest["seccomp"]["sha256"]:
        raise ValueError("installed assets changed")
    result = run(["docker", "container", "inspect", CONTAINER], check=False)
    if result.returncode == 0:
        existing = json.loads(result.stdout)[0]
        if not existing.get("State", {}).get("Running"):
            raise ValueError("existing worker stopped; refuse automatic resurrection")
        if not (HOME / "smoke-passed").is_file():
            retire()
            raise ValueError("interrupted worker sandbox acceptance; use a new VM")
        return
    # Mark before docker run, so interruption cannot evade the watchdog.
    write(HOME / "started", "1\n")
    run(container_argv(manifest))
    try:
        run(["docker", "exec", CONTAINER, "node", "--input-type=module", "-e", SMOKE], timeout=30)
        write(HOME / "smoke-passed", "1\n")
    except Exception:
        retire()
        raise


def main():
    if os.geteuid() != 0 or len(sys.argv) != 2:
        raise ValueError("root helper requires exactly one action")
    mode = sys.argv[1]
    if mode == "watchdog":
        watchdog()
        return
    # Serialize installs/renewals/starts. Watchdog is deliberately independent of this lock.
    with open(HOME / "agent.lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        {"configure": configure, "verify-sshd": verify_sshd, "status": status, "renew": renew,
         "install": install, "start": start}[mode]()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Keep all local paths, asset metadata and SSH diagnostics out of journal output.
        print("FetchX worker helper failed closed", file=sys.stderr)
        sys.exit(1)
