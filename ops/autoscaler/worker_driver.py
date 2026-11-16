"""Private, fail-closed worker provisioning. No cloud API or registry mutations.

All commands use argv; the only remote commands are fixed, root-installed helpers.
Run as root on the gateway host. Assets and state must stay outside the checkout.
"""
from __future__ import annotations

import base64
import binascii
import gzip
import hashlib
import http.client
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import socket
import stat
import subprocess
import tarfile
import tempfile
import time


class WorkerDriverError(RuntimeError):
    pass


ID = re.compile(r"[a-z0-9][a-z0-9-]{0,31}\Z")
SHA = re.compile(r"[a-f0-9]{64}\Z")
LAYER = re.compile(r"sha256:[a-f0-9]{64}\Z")
ASSET_HOME = Path(__file__).resolve().parents[2] / "deploy" / "autoscaler"
REMOTE_HOME = "/opt/fetchx-worker"
REMOTE_AGENT = "/usr/local/lib/fetchx-autoscaler/worker_agent.py"
MAX_USER_DATA_BYTES = 32 * 1024


def _json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def _ed25519_public(raw):
    # OpenSSH -y may retain the private key's comment. Persist only the identity,
    # rejecting options, extra lines and non-key material rather than stripping it.
    match = re.fullmatch(r"(ssh-ed25519 [A-Za-z0-9+/]+={0,2})(?: [^\r\n]*)?(?:\r?\n)?", raw)
    if match is None:
        raise WorkerDriverError("invalid Ed25519 key")
    public = match[1]
    try:
        base64.b64decode(public.split()[1], validate=True)
    except (ValueError, binascii.Error):
        raise WorkerDriverError("invalid Ed25519 key") from None
    return public


def _private(path, directory=False):
    info = Path(path).lstat()
    kind = stat.S_ISDIR if directory else stat.S_ISREG
    if not kind(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise WorkerDriverError("private path must be root-owned and inaccessible to group/other")
    return Path(path)


def _sha(path, deadline=None):
    digest = hashlib.sha256()
    with open(path, "rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            if deadline is not None and time.monotonic() >= deadline:
                raise WorkerDriverError("worker bootstrap deadline exceeded")
            digest.update(chunk)
    return digest.hexdigest()


def _atomic(path, data, mode=0o600):
    path = Path(path)
    fd, name = tempfile.mkstemp(prefix=".new-", dir=path.parent)
    temporary = Path(name)
    os.fchmod(fd, mode)
    try:
        with os.fdopen(fd, "wb") as file:
            file.write(data if isinstance(data, bytes) else data.encode())
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


class UnixHTTP(http.client.HTTPConnection):
    def __init__(self, path, timeout):
        super().__init__("localhost", timeout=timeout)
        self.path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)


class DeadlineReader:
    def __init__(self, file, deadline):
        self.file, self.deadline = file, deadline

    def read(self, size):
        if time.monotonic() >= self.deadline:
            raise WorkerDriverError("worker bootstrap deadline exceeded")
        return self.file.read(size)


class WorkerDriver:
    def __init__(self, config):
        self.config = dict(config)
        self.state = self._absolute("state_dir")
        self.admin_key = self._absolute("ssh_admin_key")
        if self.admin_key.parent != self.state or self.admin_key.name != "admin_ed25519":
            raise WorkerDriverError("use a separate state_dir/admin_ed25519 controller key")
        self.registry = self._absolute("registry_path").parent
        self.gateway_dir = str(self._absolute("gateway_registry_dir"))
        self.callback = str(self._absolute("callback_socket"))
        self.asset_path = self._absolute("asset_manifest")
        self.controller_ip = str(ipaddress.IPv4Address(config["controller_public_ipv4"]))
        self.boot_timeout = self._seconds("boot_timeout_seconds", 30, 3600)
        self.lease_seconds = self._seconds("worker_lease_seconds", 30, 3600)

    def _absolute(self, key):
        raw = self.config[key]
        if not isinstance(raw, str) or not os.path.isabs(raw) or os.path.normpath(raw) != raw or "\x00" in raw:
            raise WorkerDriverError("invalid absolute path: " + key)
        return Path(raw)

    def _seconds(self, key, low, high):
        value = self.config[key]
        if type(value) is not int or not low <= value <= high:
            raise WorkerDriverError("invalid timing: " + key)
        return value

    @staticmethod
    def _root():
        if os.geteuid() != 0:
            raise WorkerDriverError("worker provisioning requires root")

    @staticmethod
    def _record(record):
        if not isinstance(record, dict) or not isinstance(record.get("id"), str) or not ID.fullmatch(record["id"]):
            raise WorkerDriverError("invalid worker identity")
        for field in ("created_at", "lease_expires_at"):
            if isinstance(record.get(field), bool) or not isinstance(record.get(field), (int, float)) or not math.isfinite(record[field]):
                raise WorkerDriverError("invalid worker lifetime")
        if record["lease_expires_at"] <= record["created_at"]:
            raise WorkerDriverError("invalid worker lifetime")
        return record["id"]

    def _run(self, argv, *, deadline, stdin=None, input=None, check=True):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise WorkerDriverError("worker bootstrap deadline exceeded")
        try:
            result = subprocess.run(argv, stdin=stdin, input=input, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, timeout=remaining, check=False)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise WorkerDriverError("worker command failed or timed out") from error
        if check and result.returncode:
            # Never return subprocess output: SSH/cloud-init errors may contain private data.
            raise WorkerDriverError("worker command failed")
        return result

    def _key(self, path, deadline):
        if not path.exists():
            self._run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "fetchx-autoscaler", "-f", str(path)], deadline=deadline)
            os.chmod(path, 0o600)
        _private(path)
        public = _ed25519_public(self._run(["ssh-keygen", "-y", "-f", str(path)], deadline=deadline).stdout.decode())
        public_path = path.with_suffix(".pub")
        if public_path.exists():
            try:
                existing = _ed25519_public(public_path.read_text())
            except WorkerDriverError:
                raise WorkerDriverError("private/public key mismatch") from None
            if existing != public:
                raise WorkerDriverError("private/public key mismatch")
        _atomic(public_path, public + "\n")
        return public

    def _paths(self, record):
        ident = self._record(record)
        folder = self.state / "workers" / ident
        sock = self.registry / (ident + ".sock")
        if len(os.fsencode(sock)) > 103 or len(os.fsencode(self.gateway_dir + "/" + ident + ".sock")) > 103:
            raise WorkerDriverError("worker socket path too long")
        return ident, folder, sock

    def prepare(self, record):
        self._root()
        ident, folder, _ = self._paths(record)
        deadline = time.monotonic() + min(self.boot_timeout, 60)
        self._remaining(record)
        # Reject missing/unreviewed assets before the controller can create a billable VM.
        self._manifest(deadline)
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        _private(self.state, True)
        (self.state / "workers").mkdir(exist_ok=True, mode=0o700)
        _private(self.state / "workers", True)
        folder.mkdir(exist_ok=True, mode=0o700)
        _private(folder, True)
        meta = {"id": ident, "created_at": record["created_at"], "hard_deadline": record["lease_expires_at"]}
        if (folder / "identity.json").exists():
            _private(folder / "identity.json")
            if json.loads((folder / "identity.json").read_text()) != meta:
                raise WorkerDriverError("worker identity/lifetime changed")
        else:
            # Persist lifetime before returning user_data or initiating any paid create.
            _atomic(folder / "identity.json", _json(meta))
        admin = self._key(self.admin_key, deadline)
        host = self._key(folder / "host_ed25519", deadline)
        tunnel = self._key(folder / "tunnel_ed25519", deadline)
        _atomic(folder / "known_hosts", "fx-" + ident + " " + host + "\n")
        extra = self.config.get("porttrack_public_key", "")
        public_keys = [admin]
        if extra:
            if not isinstance(extra, str) or "\n" in extra or not re.fullmatch(r"ssh-(ed25519|rsa) [A-Za-z0-9+/=]+(?: [^\r\n]+)?", extra):
                raise WorkerDriverError("invalid optional administrator public key")
            public_keys.append(extra)
        agent = (ASSET_HOME / "worker_agent.py").read_bytes()
        settings = {**meta, "lease_seconds": self.lease_seconds,
                    "max_vm_egress_bytes": self.config["max_vm_egress_bytes"]}
        authorized = 'restrict,port-forwarding,from="' + self.controller_ip + '/32" ' + tunnel + "\n"
        ssh_match = (ASSET_HOME / "sshd-match.conf").read_text()
        files = [
            {"path": REMOTE_AGENT, "permissions": "0700", "encoding": "gz+b64", "content": base64.b64encode(gzip.compress(agent, mtime=0)).decode()},
            {"path": REMOTE_HOME + "/worker.json", "permissions": "0600", "content": _json(settings)},
            {"path": "/etc/ssh/fetchx-pool.authorized_keys", "permissions": "0644", "content": authorized},
            {"path": "/etc/ssh/sshd_config.d/01-fetchx-admin.conf", "permissions": "0600", "content": "PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\n"},
            {"path": "/etc/nftables.conf", "permissions": "0600", "content": self._firewall()},
            {"path": "/etc/systemd/system/fetchx-worker-watchdog.service", "permissions": "0644", "content": (ASSET_HOME / "fetchx-worker-watchdog.service").read_text()},
            {"path": "/etc/ssh/fetchx-tunnel.match", "permissions": "0600", "content": ssh_match},
        ]
        cloud = {
            "package_update": True, "packages": ["docker.io", "nftables", "python3", "ca-certificates"],
            "ssh_pwauth": False, "disable_root": False,
            "ssh_deletekeys": True,
            "ssh_keys": {"ed25519_private": (folder / "host_ed25519").read_text(), "ed25519_public": host},
            "users": [{"name": "root", "ssh_authorized_keys": public_keys},
                      {"name": "fetchx-tunnel", "uid": 10001, "no_create_home": True, "shell": "/bin/false", "lock_passwd": False}],
            "write_files": files,
            "runcmd": [
                ["/usr/bin/python3", REMOTE_AGENT, "configure"],
                ["/usr/sbin/sshd", "-t"], ["/usr/bin/systemctl", "reload", "ssh"],
                ["/usr/bin/systemctl", "daemon-reload"],
                ["/usr/bin/systemctl", "enable", "--now", "docker", "nftables", "fetchx-worker-watchdog"],
            ],
        }
        # JSON is a YAML 1.2 subset; no string interpolation into cloud-init commands.
        user_data = "#cloud-config\n" + json.dumps(cloud)
        # Hetzner caps POST /servers user_data at 32 KiB. Check the exact
        # serialized value here, before prepare can authorize a paid create.
        if len(user_data.encode("utf-8")) > MAX_USER_DATA_BYTES:
            raise WorkerDriverError("worker user_data exceeds Hetzner 32 KiB limit")
        return {"user_data": user_data}

    def _firewall(self):
        return ("#!/usr/sbin/nft -f\nflush ruleset\ntable inet fetchx {\n"
                " chain input { type filter hook input priority -10; policy drop;\n"
                " ct state established,related accept\n iifname lo accept\n"
                f" ip saddr {self.controller_ip}/32 tcp dport 22 accept\n"
                " ip protocol icmp accept\n ip6 nexthdr ipv6-icmp accept\n udp sport 67 udp dport 68 accept\n }\n"
                " chain forward { type filter hook forward priority -10; policy drop; }\n}\n")

    def _manifest(self, deadline=None):
        _private(self.asset_path)
        _private(self.asset_path.parent, True)
        manifest = json.loads(self.asset_path.read_text())
        from importlib.util import module_from_spec, spec_from_file_location
        spec = spec_from_file_location("fetchx_worker_assets", ASSET_HOME / "worker_agent.py")
        module = module_from_spec(spec)
        spec.loader.exec_module(module)
        module.validate_manifest(manifest)
        paths = {}
        for key, field in (("image", "archive"), ("browser", "archive"), ("seccomp", "path")):
            path = Path(manifest[key][field])
            if not path.is_absolute() or path.parent != self.asset_path.parent:
                raise WorkerDriverError("assets must be siblings of private asset manifest")
            _private(path)
            if _sha(path, deadline) != manifest[key]["sha256"]:
                raise WorkerDriverError("private asset digest mismatch")
            paths[key] = path
        remote = json.loads(_json(manifest))
        remote["image"]["archive"] = "image.tar"
        remote["browser"]["archive"] = "browser.tar"
        remote["seccomp"]["path"] = "seccomp.json"
        return remote, paths

    def _ssh(self, record, server, admin=True):
        ident, folder, _ = self._paths(record)
        address = str(ipaddress.IPv4Address(server["public_net"]["ipv4"]["ip"]))
        _private(folder / "identity.json")
        expected = {"id": ident, "created_at": record["created_at"], "hard_deadline": record["lease_expires_at"]}
        if json.loads((folder / "identity.json").read_text()) != expected:
            raise WorkerDriverError("worker identity/lifetime changed")
        for path in (folder / "known_hosts", self.admin_key if admin else folder / "tunnel_ed25519"):
            _private(path)
        return ["ssh", "-F", "/dev/null", "-i", str(self.admin_key if admin else folder / "tunnel_ed25519"),
                "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes",
                "-o", "UserKnownHostsFile=" + str(folder / "known_hosts"), "-o", "GlobalKnownHostsFile=/dev/null",
                "-o", "UpdateHostKeys=no", "-o", "HostKeyAlias=fx-" + ident, "-o", "ConnectTimeout=5",
                "-o", "ConnectionAttempts=1", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=3",
                ("root" if admin else "fetchx-tunnel") + "@" + address]

    def _agent(self, record, server, mode, deadline, **kwargs):
        return self._run(self._ssh(record, server) + ["/usr/bin/python3", REMOTE_AGENT, mode], deadline=deadline, **kwargs)

    def _remaining(self, record):
        seconds = record["lease_expires_at"] - time.time()
        if seconds <= 0:
            raise WorkerDriverError("worker hard lifetime expired")
        return seconds

    def _renew(self, record, server, deadline):
        self._remaining(record)
        self._agent(record, server, "renew", deadline, input=_json({"expires_at": min(time.time() + self.lease_seconds, record["lease_expires_at"])}).encode())

    def renew(self, record, server):
        """Refresh only the workload lease, never the VM's absolute hard deadline."""
        self._root()
        self._record(record)
        self._renew(record, server, time.monotonic() + min(15, self.lease_seconds / 3))

    def bootstrap(self, record, server):
        self._root()
        ident, folder, sock = self._paths(record)
        deadline = time.monotonic() + min(self.boot_timeout, self._remaining(record))
        manifest, paths = self._manifest(deadline)
        # A failed SSH connection is retried for readiness only; cloud creation is never retried here.
        while True:
            try:
                result = self._agent(record, server, "status", min(deadline, time.monotonic() + 8), check=False)
            except WorkerDriverError:
                if time.monotonic() + 2 >= deadline:
                    raise
                time.sleep(2)
                continue
            if result.returncode == 0:
                status = json.loads(result.stdout)
                break
            if time.monotonic() + 2 >= deadline:
                raise WorkerDriverError("worker cloud-init did not become ready before deadline")
            time.sleep(2)
        fingerprint = hashlib.sha256(_json(manifest).encode()).hexdigest()
        if status.get("manifest_sha256") not in (None, fingerprint):
            raise WorkerDriverError("installed worker assets differ; replacement requires a new VM")
        if not status.get("manifest_sha256"):
            self._renew(record, server, deadline)
            # Materialize a private tar stream on disk: never buffer image/browser archives in RAM.
            with tempfile.TemporaryFile(dir=folder) as payload:
                with tarfile.open(fileobj=payload, mode="w") as archive:
                    for name, path in (("image.tar", paths["image"]), ("browser.tar", paths["browser"]), ("seccomp.json", paths["seccomp"])):
                        info = archive.gettarinfo(str(path), arcname=name)
                        with open(path, "rb") as source:
                            archive.addfile(info, DeadlineReader(source, deadline))
                    raw = _json(manifest).encode()
                    info = tarfile.TarInfo("manifest.json")
                    info.size, info.mode = len(raw), 0o600
                    import io
                    archive.addfile(info, io.BytesIO(raw))
                payload.seek(0)
                self._agent(record, server, "install", deadline, stdin=payload)
        self._renew(record, server, deadline)
        self._agent(record, server, "start", deadline)
        self._negative_probes(record, server, deadline)
        self._start_tunnel(record, server, deadline)
        expected = {key: manifest["runtime_pin"][key] for key in ("engine", "version", "sha256")}
        expected.update(platform="linux", arch="x64")
        while time.monotonic() < deadline:
            try:
                info = sock.lstat()
                if stat.S_ISSOCK(info.st_mode) and info.st_uid == 10001 and info.st_gid == 10001 and stat.S_IMODE(info.st_mode) == 0o600:
                    with UnixHTTP(str(sock), min(2, max(.1, deadline - time.monotonic()))) as connection:
                        connection.request("GET", "/healthz")
                        response = connection.getresponse()
                        raw = response.read(8193)
                        body = json.loads(raw) if len(raw) <= 8192 else {}
                        if response.status == 200 and body.get("ready") is True and body.get("busy") is False and body.get("runtime") == expected:
                            return {"socket_path": self.gateway_dir + "/" + ident + ".sock"}
            except (OSError, ValueError, http.client.HTTPException):
                pass
            time.sleep(min(.25, max(0, deadline - time.monotonic())))
        raise WorkerDriverError("worker pin/callback readiness deadline exceeded")

    def _negative_probes(self, record, server, deadline):
        base = self._ssh(record, server, admin=False)
        for options, marker in ((["-NT", "-o", "ExitOnForwardFailure=yes", "-R", "127.0.0.1:0:127.0.0.1:1"], b"remote port forwarding failed"),
                                (["-W", "127.0.0.1:22"], b"administratively prohibited")):
            # Insert options before the SSH destination. Authentication failures do not count as successful negative probes.
            result = self._run(base[:-1] + options + base[-1:], deadline=min(deadline, time.monotonic() + 8), check=False)
            if result.returncode == 0 or marker not in result.stderr.lower():
                raise WorkerDriverError("restricted tunnel TCP negative probe did not demonstrate denial")
        self._agent(record, server, "verify-sshd", deadline)

    def _start_tunnel(self, record, server, deadline):
        ident, folder, sock = self._paths(record)
        # The registry directory remains root-owned; the root supervisor fixes each new socket's numeric owner.
        info = self.registry.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o755:
            raise WorkerDriverError("registry directory must remain root:root 0755")
        unit = "fetchx-tunnel-" + ident + ".service"
        settings = {"argv": self._ssh(record, server, admin=False), "socket": str(sock), "callback": self.callback,
                    "hard_deadline": record["lease_expires_at"]}
        _atomic(folder / "tunnel.json", _json(settings))
        result = self._run(["systemctl", "is-active", "--quiet", unit], deadline=deadline, check=False)
        if result.returncode == 0:
            return
        self._run(["systemctl", "reset-failed", unit], deadline=deadline, check=False)
        self._run(["systemd-run", "--quiet", "--collect", "--unit=" + unit,
                   "--property=Type=exec", "--property=UMask=0077", "--property=NoNewPrivileges=yes",
                   "--property=KillMode=control-group", "--property=RuntimeMaxSec=" + str(max(1, math.ceil(self._remaining(record)))),
                   "/usr/bin/python3", str(ASSET_HOME / "tunnel_runner.py"), str(folder / "tunnel.json")], deadline=deadline)

    def disconnect(self, record):
        self._root()
        ident, _, sock = self._paths(record)
        deadline = time.monotonic() + 20
        result = self._run(["systemctl", "stop", "fetchx-tunnel-" + ident + ".service"], deadline=deadline, check=False)
        if result.returncode and not any(marker in result.stderr.lower() for marker in (b"not loaded", b"not found", b"does not exist")):
            raise WorkerDriverError("could not confirm owned tunnel stop")
        # A nonexistent unit is already stopped. Never unlink while a live unit may still own the listener.
        active = self._run(["systemctl", "is-active", "--quiet", "fetchx-tunnel-" + ident + ".service"], deadline=deadline, check=False)
        if active.returncode not in (3, 4):
            raise WorkerDriverError("owned tunnel did not stop")
        if sock.exists() or sock.is_symlink():
            if not stat.S_ISSOCK(sock.lstat().st_mode):
                raise WorkerDriverError("owned socket path is not a socket")
            sock.unlink()
