"""Offline transport/asset/lease tests. No VM, Docker daemon or SSH connection."""
import base64
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

from ops.autoscaler import worker_driver as driver


def load(name):
    spec = importlib.util.spec_from_file_location("test_" + name, driver.ASSET_HOME / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


agent = load("worker_agent")
tunnel = load("tunnel_runner")
with patch.dict(sys.modules, {"worker_agent": agent}):
    preparer = load("prepare_assets")


def result(code=0, stdout=b"", stderr=b""):
    return subprocess.CompletedProcess([], code, stdout, stderr)


class WorkerDriverTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name)
        self.state = self.home / "state"
        self.assets = self.home / "assets"
        self.assets.mkdir(mode=0o700)
        self.registry = self.home / "registry"
        self.registry.mkdir(mode=0o755)
        self.config = {
            "state_dir": str(self.state), "ssh_admin_key": str(self.state / "admin_ed25519"),
            "registry_path": str(self.registry / "workers.json"), "gateway_registry_dir": "/run/fx/registry",
            "callback_socket": "/opt/crawling-platform/browser-pool/run/cb/gw.sock",
            "controller_public_ipv4": "192.0.2.10", "asset_manifest": str(self.assets / "manifest.json"),
            "boot_timeout_seconds": 30, "worker_lease_seconds": 180, "max_vm_egress_bytes": 1073741824,
        }
        self.record = {"id": "worker-abc", "created_at": time.time(), "lease_expires_at": time.time() + 3600}
        self.server = {"public_net": {"ipv4": {"ip": "192.0.2.20"}}}
        self.pin = {"engine": "chromium", "executablePath": "/opt/gateway-browser/chromium/chrome", "version": "151.0.1.2", "sha256": "a" * 64}
        self.manifest = {"version": 1, "runtime_pin": self.pin,
                         "image": {"archive": str(self.assets / "image.tar"), "sha256": "", "ref": "fetchx-autoscaler-pinned:" + "b" * 64, "rootfs_layers": ["sha256:" + "c" * 64]},
                         "browser": {"archive": str(self.assets / "browser.tar"), "sha256": "", "executable": self.pin["executablePath"]},
                         "seccomp": {"path": str(self.assets / "seccomp.json"), "sha256": ""}}
        for name, field in (("image", "archive"), ("browser", "archive"), ("seccomp", "path")):
            path = Path(self.manifest[name][field])
            path.write_bytes(("synthetic-" + name).encode())
            path.chmod(0o600)
            self.manifest[name]["sha256"] = driver._sha(path)
        self.save_manifest()
        self.worker = driver.WorkerDriver(self.config)
        self.root_patch = patch.object(driver.WorkerDriver, "_root")
        self.root_patch.start()
        self.addCleanup(self.root_patch.stop)
        self.commands = []

    def save_manifest(self):
        path = self.assets / "manifest.json"
        path.write_text(json.dumps(self.manifest))
        path.chmod(0o600)

    def fake_run(self, argv, **kwargs):
        self.commands.append((argv, kwargs))
        if argv[0] == "ssh-keygen":
            path = Path(argv[-1])
            if "-y" in argv:
                public = "ssh-ed25519 " + base64.b64encode(str(path).encode()).decode()
                return result(stdout=public.encode())
            path.write_text("synthetic-private-" + path.name)
            path.chmod(0o600)
        return result()

    def prepare(self):
        with patch.object(self.worker, "_run", side_effect=self.fake_run):
            return self.worker.prepare(self.record)

    def test_prepare_is_restart_idempotent_and_pins_host_identity(self):
        first = self.prepare()
        self.commands.clear()
        second = self.prepare()
        self.assertEqual(first, second)
        self.assertFalse(any("-q" in argv for argv, _ in self.commands))
        cloud = json.loads(first["user_data"].split("\n", 1)[1])
        folder = self.state / "workers" / self.record["id"]
        self.assertEqual(cloud["ssh_keys"]["ed25519_private"], (folder / "host_ed25519").read_text())
        self.assertIn("fx-worker-abc ssh-ed25519", (folder / "known_hosts").read_text())
        self.assertEqual(stat.S_IMODE(folder.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((folder / "tunnel_ed25519").stat().st_mode), 0o600)
        text = first["user_data"]
        self.assertNotIn("synthetic-private-tunnel", text)
        self.assertNotIn("synthetic-private-admin", text)
        self.assertNotIn("cloud_token", text)
        self.assertIn('from=\\"192.0.2.10/32\\"', text)

    def test_prepare_rejects_lifetime_mutation_and_non_private_state(self):
        self.prepare()
        changed = {**self.record, "lease_expires_at": self.record["lease_expires_at"] + 1}
        with self.assertRaisesRegex(driver.WorkerDriverError, "lifetime changed"):
            self.worker.prepare(changed)
        self.state.chmod(0o755)
        with self.assertRaisesRegex(driver.WorkerDriverError, "private path"):
            self.worker.prepare(self.record)

    def test_key_mismatch_fails_without_replacing_private_key(self):
        self.prepare()
        key = self.state / "admin_ed25519"
        before = key.read_bytes()
        key.with_suffix(".pub").write_text("ssh-ed25519 wrong")
        with patch.object(self.worker, "_run", side_effect=self.fake_run), self.assertRaisesRegex(driver.WorkerDriverError, "mismatch"):
            self.worker.prepare(self.record)
        self.assertEqual(key.read_bytes(), before)

    def test_rejects_borrowed_admin_key_and_unsafe_identity(self):
        with self.assertRaisesRegex(driver.WorkerDriverError, "separate"):
            driver.WorkerDriver({**self.config, "ssh_admin_key": "/root/.ssh/porttrack"})
        for ident in ("../other", "worker;touch x", "A", "x" * 33):
            with self.subTest(ident=ident), self.assertRaises(driver.WorkerDriverError):
                self.worker.prepare({**self.record, "id": ident})

    def test_optional_public_key_authorizes_no_private_material(self):
        self.worker.config["porttrack_public_key"] = "ssh-ed25519 cHVibGlj user-key"
        cloud = json.loads(self.prepare()["user_data"].split("\n", 1)[1])
        self.assertEqual(len(cloud["users"][0]["ssh_authorized_keys"]), 2)
        self.worker.config["porttrack_public_key"] = "ssh-ed25519 cHVibGlj\ncommand=bad"
        with self.assertRaisesRegex(driver.WorkerDriverError, "public key"):
            self.prepare()

    def test_prepare_cloud_config_with_realistic_ed25519_sizes(self):
        # Synthetic OpenSSH wire/PEM shapes, with normal Ed25519 key lengths.
        public = "ssh-ed25519 " + base64.b64encode(b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20" + b"x" * 32).decode()
        encoded = "A" * 336
        private = "-----BEGIN OPENSSH PRIVATE KEY-----\n" + "\n".join(encoded[i:i + 70] for i in range(0, len(encoded), 70)) + "\n-----END OPENSSH PRIVATE KEY-----\n"
        self.assertEqual((len(public), len(private)), (80, 411))
        def key(path, deadline):
            driver._atomic(path, private)
            return public
        with patch.object(self.worker, "_key", side_effect=key):
            first = self.worker.prepare(self.record)
            self.assertEqual(first, self.worker.prepare(self.record))
        self.assertLessEqual(len(first["user_data"].encode("utf-8")), 32 * 1024)
        cloud = json.loads(first["user_data"].split("\n", 1)[1])
        self.assertEqual(cloud["users"][0], {"name": "root", "ssh_authorized_keys": [public]})
        self.assertFalse(cloud["disable_root"])
        self.assertFalse(cloud["ssh_pwauth"])
        self.assertTrue(cloud["ssh_deletekeys"])
        self.assertEqual(cloud["ssh_keys"], {"ed25519_private": private, "ed25519_public": public})
        files = {item["path"]: item for item in cloud["write_files"]}
        self.assertEqual(json.loads(files[driver.REMOTE_HOME + "/worker.json"]["content"])["max_vm_egress_bytes"], self.config["max_vm_egress_bytes"])
        self.assertEqual(files[driver.REMOTE_AGENT]["encoding"], "gz+b64")
        self.assertEqual(gzip.decompress(base64.b64decode(files[driver.REMOTE_AGENT]["content"])), (driver.ASSET_HOME / "worker_agent.py").read_bytes())
        self.worker.config["porttrack_public_key"] = "ssh-rsa " + base64.b64encode(b"r" * 279).decode() + " porttrack-admin-key"
        self.assertEqual(len(self.worker.config["porttrack_public_key"]), 400)
        with patch.object(self.worker, "_key", side_effect=key):
            optional = self.worker.prepare(self.record)
            self.assertEqual(optional, self.worker.prepare(self.record))
        self.assertLessEqual(len(optional["user_data"].encode("utf-8")), 32 * 1024)

    def test_prepare_rejects_oversized_serialized_user_data(self):
        self.worker.config["porttrack_public_key"] = "ssh-ed25519 cHVibGlj x"
        baseline = self.prepare()["user_data"]
        padding = 32 * 1024 - len(baseline.encode("utf-8"))
        self.assertGreater(padding, 0)
        self.worker.config["porttrack_public_key"] += "x" * padding
        at_limit = self.prepare()
        self.assertEqual(len(at_limit["user_data"].encode("utf-8")), 32 * 1024)
        self.assertEqual(at_limit, self.prepare())
        self.worker.config["porttrack_public_key"] += "x"
        with self.assertRaisesRegex(driver.WorkerDriverError, "user_data exceeds.*32 KiB"):
            self.prepare()

    def test_controller_cancels_oversized_prepare_before_cloud_create(self):
        from ops.autoscaler import controller
        self.worker.config["porttrack_public_key"] = "ssh-ed25519 cHVibGlj " + "x" * (32 * 1024)
        control = controller.Controller.__new__(controller.Controller)
        control.config = {"enabled": True, "scale_up_delay_seconds": 0, "cooldown_seconds": 0,
                          "drain_before_expiry_seconds": 60}
        control.registry = Mock()
        control.registry.read.return_value = [{"id": "base", "state": "active"}]
        control.ledger = Mock()
        control.ledger.records.return_value = []
        control.ledger.meta.side_effect = lambda key, default=None: {} if key == "machine_cooldowns" else 0
        machine = {"server_type": "cx23", "location": "hel1", "type_id": 114,
                   "server_hourly_ceiling_micro_eur": 8800, "ipv4_hourly_ceiling_micro_eur": 800,
                   "server_hourly_micro_eur": 8800, "ipv4_hourly_micro_eur": 800}
        control.ledger.reserve.return_value = {**self.record, "machine": machine}
        control.driver = self.worker
        control.cloud = Mock()
        control.clock = time.time
        control._decision = Mock()
        metrics = {"workers": [{"id": "base", "state": "active", "ready": True, "busy": True}],
                   "max_concurrent_requests": 2, "queue": {"pending": 1, "active": 1, "oldest_wait_ms": 1000}}
        with patch.object(controller, "select_machine", return_value=machine), patch.object(self.worker, "_run", side_effect=self.fake_run):
            control._grow(metrics, time.time())
        self.assertEqual(control.ledger.reserve.call_args.args[2], machine)
        control.cloud.create.assert_not_called()
        self.assertEqual(control.ledger.save.call_args.args[0]["state"], "cancelled")
        self.assertEqual(control._decision.call_args.args[1], "driver_prepare_failed")

    def test_manifest_hash_permissions_and_ordered_layer_validation(self):
        remote, paths = self.worker._manifest()
        self.assertEqual(remote["image"]["archive"], "image.tar")
        self.assertEqual(paths["browser"], self.assets / "browser.tar")
        (self.assets / "browser.tar").write_bytes(b"changed")
        with self.assertRaisesRegex(driver.WorkerDriverError, "digest mismatch"):
            self.worker._manifest()
        (self.assets / "manifest.json").chmod(0o644)
        with self.assertRaisesRegex(driver.WorkerDriverError, "private path"):
            self.worker._manifest()

    def test_ssh_strict_host_checking_and_separate_identities(self):
        self.prepare()
        admin = self.worker._ssh(self.record, self.server)
        restricted = self.worker._ssh(self.record, self.server, False)
        self.assertIn("StrictHostKeyChecking=yes", admin)
        self.assertIn("HostKeyAlias=fx-worker-abc", restricted)
        self.assertIn("GlobalKnownHostsFile=/dev/null", restricted)
        self.assertNotEqual(admin[admin.index("-i") + 1], restricted[restricted.index("-i") + 1])
        self.assertEqual(restricted[-1], "fetchx-tunnel@192.0.2.20")
        with self.assertRaises(ValueError):
            self.worker._ssh(self.record, {"public_net": {"ipv4": {"ip": "bad; command"}}})

    def test_negative_probes_require_authenticated_policy_denials(self):
        self.prepare()
        denied = [result(255, stderr=b"remote port forwarding failed for listen port 0"), result(255, stderr=b"channel 0: open failed: administratively prohibited")]
        with patch.object(self.worker, "_run", side_effect=denied) as run, patch.object(self.worker, "_agent") as remote:
            self.worker._negative_probes(self.record, self.server, time.monotonic() + 30)
            self.assertEqual(run.call_count, 2)
            remote.assert_called_once()
        with patch.object(self.worker, "_run", return_value=result(255, stderr=b"Permission denied (publickey)")), self.assertRaisesRegex(driver.WorkerDriverError, "negative probe"):
            self.worker._negative_probes(self.record, self.server, time.monotonic() + 30)

    def test_subprocess_uses_argv_and_deadline_and_redacts_errors(self):
        with patch.object(driver.subprocess, "run", return_value=result(2, stderr=b"sensitive diagnostics")) as run:
            with self.assertRaisesRegex(driver.WorkerDriverError, "^worker command failed$"):
                self.worker._run(["ssh", "literal $(no-shell)"], deadline=time.monotonic() + 2)
            self.assertNotIn("shell", run.call_args.kwargs)
            self.assertLessEqual(run.call_args.kwargs["timeout"], 2)
        with self.assertRaisesRegex(driver.WorkerDriverError, "deadline"):
            self.worker._run(["never"], deadline=time.monotonic() - 1)

    def test_renew_caps_lease_at_absolute_hard_lifetime(self):
        self.prepare()
        self.record["lease_expires_at"] = time.time() + 20
        with patch.object(self.worker, "_agent") as remote:
            self.worker.renew(self.record, self.server)
        value = json.loads(remote.call_args.kwargs["input"])
        self.assertEqual(value["expires_at"], self.record["lease_expires_at"])
        self.record["lease_expires_at"] = time.time() - 1
        self.record["created_at"] = time.time() - 100
        with self.assertRaisesRegex(driver.WorkerDriverError, "lifetime expired"):
            self.worker.renew(self.record, self.server)

    def bootstrap_fixture(self, installed=False, runtime=None):
        self.prepare()
        remote_manifest, _ = self.worker._manifest()
        fingerprint = hashlib.sha256(driver._json(remote_manifest).encode()).hexdigest()
        calls = []
        def remote(record, server, mode, deadline, **kwargs):
            calls.append(mode)
            if mode == "status":
                return result(stdout=json.dumps({"manifest_sha256": fingerprint if installed else None}).encode())
            if mode == "install":
                with tarfile.open(fileobj=kwargs["stdin"], mode="r") as archive:
                    self.assertEqual(set(archive.getnames()), {"image.tar", "browser.tar", "seccomp.json", "manifest.json"})
                    self.assertEqual(json.load(archive.extractfile("manifest.json")), remote_manifest)
            return result()
        body = {"ready": True, "busy": False, "runtime": runtime or {"engine": "chromium", "version": self.pin["version"], "sha256": self.pin["sha256"], "platform": "linux", "arch": "x64"}}
        http = Mock()
        connection = http.return_value.__enter__ = Mock(return_value=http)
        http.return_value.__exit__ = Mock(return_value=False)
        http.getresponse.return_value.status = 200
        http.getresponse.return_value.read.return_value = json.dumps(body).encode()
        return remote, calls, http

    def test_bootstrap_transfers_assets_and_returns_only_gateway_socket(self):
        remote, calls, http = self.bootstrap_fixture()
        real_lstat = Path.lstat
        sock = self.registry / (self.record["id"] + ".sock")
        def lstat(path):
            return Mock(st_mode=stat.S_IFSOCK | 0o600, st_uid=10001, st_gid=10001) if path == sock else real_lstat(path)
        with patch.object(self.worker, "_agent", side_effect=remote), patch.object(self.worker, "_negative_probes"), patch.object(self.worker, "_start_tunnel"), patch.object(Path, "lstat", lstat), patch.object(driver, "UnixHTTP", http):
            self.assertEqual(self.worker.bootstrap(self.record, self.server), {"socket_path": "/run/fx/registry/worker-abc.sock"})
        self.assertEqual(calls, ["status", "renew", "install", "renew", "start"])
        self.assertFalse((self.registry / "workers.json").exists())

    def test_restart_bootstrap_does_not_reinstall_pinned_assets(self):
        remote, calls, _ = self.bootstrap_fixture(installed=True)
        # Stop at tunnel setup; installed identity and renewal/start sequence is independent of health I/O.
        with patch.object(self.worker, "_agent", side_effect=remote), patch.object(self.worker, "_negative_probes"), patch.object(self.worker, "_start_tunnel", side_effect=RuntimeError("sentinel")):
            with self.assertRaisesRegex(RuntimeError, "sentinel"):
                self.worker.bootstrap(self.record, self.server)
        self.assertEqual(calls, ["status", "renew", "start"])

    def test_bootstrap_refuses_different_installed_manifest(self):
        self.prepare()
        with patch.object(self.worker, "_agent", return_value=result(stdout=b'{"manifest_sha256":"different"}')), self.assertRaisesRegex(driver.WorkerDriverError, "assets differ"):
            self.worker.bootstrap(self.record, self.server)

    def test_bootstrap_never_accepts_unqualified_browser_health(self):
        remote, _, http = self.bootstrap_fixture(runtime={"engine": "chromium", "version": self.pin["version"], "sha256": "f" * 64, "platform": "linux", "arch": "x64"})
        self.record["lease_expires_at"] = time.time() + .04
        sock = self.registry / (self.record["id"] + ".sock")
        real_lstat = Path.lstat
        def lstat(path):
            return Mock(st_mode=stat.S_IFSOCK | 0o600, st_uid=10001, st_gid=10001) if path == sock else real_lstat(path)
        with patch.object(self.worker, "_agent", side_effect=remote), patch.object(self.worker, "_negative_probes"), patch.object(self.worker, "_start_tunnel"), patch.object(Path, "lstat", lstat), patch.object(driver, "UnixHTTP", http), self.assertRaisesRegex(driver.WorkerDriverError, "readiness deadline"):
            self.worker.bootstrap(self.record, self.server)

    def test_disconnect_is_owned_only_and_safe_to_repeat(self):
        sock = self.registry / (self.record["id"] + ".sock")
        other = self.registry / "other.sock"
        sock.write_text("synthetic socket")
        other.write_text("preserve")
        real_lstat = Path.lstat
        def socket_stat(path):
            info = real_lstat(path)
            return Mock(st_mode=stat.S_IFSOCK | 0o600) if path == sock else info
        def systemctl(argv, **kwargs):
            return result(0 if argv[1] == "stop" else 3)
        with patch.object(self.worker, "_run", side_effect=systemctl) as run, patch.object(Path, "lstat", socket_stat):
            self.worker.disconnect(self.record)
            self.worker.disconnect(self.record)
        self.assertFalse(sock.exists())
        self.assertEqual(other.read_text(), "preserve")
        self.assertTrue(all("worker-abc.service" in " ".join(call.args[0]) for call in run.call_args_list))
        sock.write_text("not a socket")
        with patch.object(self.worker, "_run", side_effect=systemctl), self.assertRaisesRegex(driver.WorkerDriverError, "not a socket"):
            self.worker.disconnect(self.record)

    def test_disconnect_does_not_unlink_when_service_stop_is_uncertain(self):
        sock = self.registry / (self.record["id"] + ".sock")
        sock.write_text("preserve until stop confirmed")
        with patch.object(self.worker, "_run", return_value=result(1, stderr=b"Failed to connect to bus")), self.assertRaisesRegex(driver.WorkerDriverError, "confirm"):
            self.worker.disconnect(self.record)
        self.assertTrue(sock.exists())


class AgentTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name)
        self.home_patch = patch.object(agent, "HOME", self.home)
        self.home_patch.start()
        self.addCleanup(self.home_patch.stop)
        self.settings = {"id": "worker-abc", "created_at": time.time() - 5, "hard_deadline": time.time() + 3600, "lease_seconds": 180, "max_vm_egress_bytes": 1000}
        (self.home / "worker.json").write_text(json.dumps(self.settings))
        self.net = self.home / "net"
        self.net.mkdir()
        self.tx = self.net / "ens3/statistics/tx_bytes"
        self.tx.parent.mkdir(parents=True)
        self.tx.write_text("0")
        (self.net / "ens3/device").mkdir()
        self.boot = self.home / "boot_id"
        self.boot.write_text("synthetic-boot-1")
        for name, value in (("NET", self.net), ("BOOT_ID", self.boot)):
            patcher = patch.object(agent, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        agent.check_egress(initialize=True)

    def test_egress_counts_device_interface_and_ignores_loopback_and_virtual(self):
        for name in ("lo", "docker0", "veth0"):
            path = self.net / name / "statistics/tx_bytes"
            path.parent.mkdir(parents=True)
            path.write_text("999999")
        (self.net / "lo/device").mkdir()
        self.tx.write_text("999")
        agent.check_egress()
        state = self.home / "egress.json"
        self.assertEqual(json.loads(state.read_text())["total"], 999)
        self.assertEqual(stat.S_IMODE(state.stat().st_mode), 0o600)
        self.tx.write_text("1000")
        with patch.object(agent, "run", return_value=result()) as run:
            with self.assertRaisesRegex(ValueError, "egress"):
                agent.require_egress()
        self.assertTrue((self.home / "retired").exists())
        self.assertEqual(run.call_args.args[0][:3], ["docker", "stop", "--time"])

    def test_egress_persists_across_restart_counter_and_boot_resets(self):
        self.tx.write_text("400")
        agent.check_egress()
        agent.check_egress()  # Same persisted counters after process restart.
        self.assertEqual(json.loads((self.home / "egress.json").read_text())["total"], 400)
        self.tx.write_text("100")
        agent.check_egress()
        self.assertEqual(json.loads((self.home / "egress.json").read_text())["total"], 500)
        self.boot.write_text("synthetic-boot-2")
        self.tx.write_text("200")  # Reboot counter already above the last sample.
        agent.check_egress()
        self.assertEqual(json.loads((self.home / "egress.json").read_text())["total"], 700)

    def test_egress_missing_corrupt_and_unavailable_fail_closed(self):
        state = self.home / "egress.json"
        saved = state.read_bytes()
        for corruption in (b"invalid", b'{"boot":"x","total":true,"counters":{}}', None):
            with self.subTest(corruption=corruption):
                state.unlink(missing_ok=True)
                if corruption is not None:
                    agent.write(state, corruption)
                with patch.object(agent, "run", return_value=result()), self.assertRaisesRegex(ValueError, "egress"):
                    agent.require_egress()
                self.assertTrue((self.home / "retired").exists())
        agent.write(state, saved)
        self.tx.unlink()
        with patch.object(agent, "run", return_value=result()), self.assertRaisesRegex(ValueError, "egress"):
            agent.require_egress()

    def test_egress_exhaustion_blocks_renewal_start_and_watchdog(self):
        self.tx.write_text("1000")
        for action in (agent.renew, agent.start):
            with patch.object(agent, "run", return_value=result()), self.assertRaisesRegex(ValueError, "egress"):
                action()
        self.tx.write_text("0")
        with patch.object(agent, "run", return_value=result()), self.assertRaisesRegex(ValueError, "egress"):
            agent.start()  # Reset counters cannot revive an exhausted worker.
        with patch.object(agent, "retire") as retire, patch.object(agent.time, "sleep", side_effect=RuntimeError("stop loop")):
            with self.assertRaisesRegex(RuntimeError, "stop loop"):
                agent.watchdog()
            retire.assert_called()

    def test_watchdog_under_egress_limit_preserves_unstarted_worker(self):
        with patch.object(agent, "retire") as retire, patch.object(agent.time, "sleep", side_effect=RuntimeError("stop loop")):
            with self.assertRaisesRegex(RuntimeError, "stop loop"):
                agent.watchdog()
            retire.assert_not_called()

    def test_lease_expiry_corruption_and_hard_lifetime_fail_closed(self):
        self.assertFalse(agent.lease_valid())
        (self.home / "lease.json").write_text(json.dumps({"expires_at": time.time() + 60}))
        self.assertTrue(agent.lease_valid())
        (self.home / "lease.json").write_text('{"expires_at":true}')
        self.assertFalse(agent.lease_valid())
        (self.home / "lease.json").write_text(json.dumps({"expires_at": time.time() - 1}))
        self.assertFalse(agent.lease_valid())
        (self.home / "lease.json").write_text(json.dumps({"expires_at": time.time() + 600}))
        self.assertFalse(agent.lease_valid())

    def test_expired_started_worker_cannot_be_resurrected_by_renewal(self):
        (self.home / "started").write_text("1")
        (self.home / "lease.json").write_text(json.dumps({"expires_at": time.time() - 1}))
        payload = io.BytesIO(json.dumps({"expires_at": time.time() + 60}).encode())
        with patch.object(agent.sys, "stdin", Mock(buffer=payload)), patch.object(agent, "run") as run, self.assertRaisesRegex(ValueError, "lease expired"):
            agent.renew()
        self.assertTrue((self.home / "retired").exists())
        self.assertEqual(run.call_args_list[0].args[0][:3], ["docker", "stop", "--time"])

    def test_retirement_powers_off_dedicated_vm_when_docker_cannot_stop_work(self):
        with patch.object(agent, "run", side_effect=[subprocess.TimeoutExpired("docker", 10), result(1), result()]) as run:
            agent.retire()
        self.assertEqual(run.call_args_list[-1].args[0], ["systemctl", "--no-block", "poweroff"])
        self.assertTrue((self.home / "retired").is_file())

    def test_container_has_single_slot_hardening_and_no_credentials(self):
        argv = agent.container_argv({"image": {"ref": "fetchx-autoscaler-pinned:" + "a" * 64}})
        for flag in ("--network=none", "--read-only", "--user=10001:10001", "--cap-drop=ALL", "--security-opt=no-new-privileges:true", "--memory=2g", "--memory-swap=2g", "--pids-limit=256", "--init", "--restart=no"):
            self.assertIn(flag, argv)
        self.assertEqual(len([arg for arg in argv if arg.startswith("--mount=")]), 4)
        self.assertFalse(any("token" in arg or "secret" in arg or "provider" in arg for arg in argv))
        self.assertEqual(argv[-2:], ["node", "src/v2-browser-worker-service.mjs"])

    def test_layer_inventory_accepts_different_config_ids_and_rejects_order_changes(self):
        layers = ["sha256:" + "a" * 64, "sha256:" + "b" * 64]
        manifest = {"image": {"ref": "tag", "rootfs_layers": layers}}
        inspected = [{"Id": "sha256:alternate-config-id", "Os": "linux", "Architecture": "amd64", "RootFS": {"Layers": layers}}]
        with patch.object(agent, "run", return_value=result(stdout=json.dumps(inspected).encode())):
            self.assertTrue(agent.image_matches(manifest))
            manifest["image"]["rootfs_layers"] = list(reversed(layers))
            self.assertFalse(agent.image_matches(manifest))

    def browser_archive(self, name, kind=tarfile.REGTYPE, linkname=""):
        path = self.home / "browser.tar"
        with tarfile.open(path, "w") as archive:
            info = tarfile.TarInfo(name)
            info.type, info.linkname, info.mode = kind, linkname, 0o7777
            info.size = 3 if kind == tarfile.REGTYPE else 0
            archive.addfile(info, io.BytesIO(b"bin") if info.size else None)
        return path

    def test_browser_extract_preserves_executable_without_suid_or_write_bits(self):
        bundle = self.browser_archive("chromium/chrome")
        destination = self.home / "browser"
        destination.mkdir()
        agent.extract_browser(bundle, destination)
        self.assertEqual((destination / "chromium/chrome").read_bytes(), b"bin")
        self.assertEqual(stat.S_IMODE((destination / "chromium/chrome").stat().st_mode), 0o555)

    def test_browser_archive_rejects_paths_links_and_special_files(self):
        for name, kind, target in (("../escape", tarfile.REGTYPE, ""), ("/escape", tarfile.REGTYPE, ""), ("link", tarfile.SYMTYPE, "../../escape"), ("hard", tarfile.LNKTYPE, "other"), ("fifo", tarfile.FIFOTYPE, "")):
            with self.subTest(name=name):
                with self.assertRaisesRegex(ValueError, "unsafe"):
                    agent.extract_browser(self.browser_archive(name, kind, target), self.home / "browser")

    def test_existing_stopped_container_is_not_automatically_resurrected(self):
        (self.home / "manifest.json").write_text("{}")
        with patch.object(agent, "lease_valid", return_value=True), patch.object(agent, "validate_manifest", return_value={"seccomp": {"sha256": "ok"}}), patch.object(agent, "image_matches", return_value=True), patch.object(agent, "sha", return_value="ok"), patch.object(agent, "run", return_value=result(stdout=b'[{"State":{"Running":false}}]')) as run:
            with self.assertRaisesRegex(ValueError, "resurrection"):
                agent.start()
        self.assertEqual(run.call_count, 1)

    def test_complete_synthetic_asset_install_validates_archive_layers_and_pin(self):
        (self.home / "pin").mkdir()
        browser = self.browser_archive("chromium/chrome")
        image = self.home / "image.tar"
        tag = "fetchx-autoscaler-pinned:" + "a" * 64
        layers = ["sha256:" + "b" * 64, "sha256:" + "c" * 64]
        with tarfile.open(image, "w") as archive:
            for name, value in (("manifest.json", [{"Config": "config.json", "RepoTags": [tag], "Layers": ["synthetic"]}]),
                                ("config.json", {"os": "linux", "architecture": "amd64", "rootfs": {"diff_ids": layers}})):
                raw = json.dumps(value).encode()
                info = tarfile.TarInfo(name)
                info.size = len(raw)
                archive.addfile(info, io.BytesIO(raw))
        seccomp = self.home / "input-seccomp.json"
        seccomp.write_text('{"defaultAction":"SCMP_ACT_ERRNO"}')
        pin = {"engine": "chromium", "executablePath": "/opt/gateway-browser/chromium/chrome", "version": "151.0.1.2", "sha256": hashlib.sha256(b"bin").hexdigest()}
        manifest = {"version": 1, "image": {"archive": "image.tar", "sha256": agent.sha(image), "ref": tag, "rootfs_layers": layers},
                    "browser": {"archive": "browser.tar", "sha256": agent.sha(browser), "executable": pin["executablePath"]},
                    "runtime_pin": pin, "seccomp": {"path": "seccomp.json", "sha256": agent.sha(seccomp)}}
        payload = io.BytesIO()
        with tarfile.open(fileobj=payload, mode="w") as archive:
            for path, name in ((image, "image.tar"), (browser, "browser.tar"), (seccomp, "seccomp.json")):
                archive.add(path, arcname=name, recursive=False)
            raw = agent.canonical(manifest).encode()
            info = tarfile.TarInfo("manifest.json")
            info.size = len(raw)
            archive.addfile(info, io.BytesIO(raw))
        payload.seek(0)
        inspected = [{"Id": "alternate-config-id", "Os": "linux", "Architecture": "amd64", "RootFS": {"Layers": layers}}]
        def docker(argv, **kwargs):
            return result(stdout=json.dumps(inspected).encode()) if "inspect" in argv else result()
        with patch.object(agent.sys, "stdin", Mock(buffer=payload)), patch.object(agent, "run", side_effect=docker) as run:
            agent.install()
        self.assertEqual(json.loads((self.home / "pin/runtime.json").read_text()), pin)
        self.assertEqual(agent.sha(self.home / "browser/chromium/chrome"), pin["sha256"])
        self.assertEqual((self.home / "manifest.json").read_text(), agent.canonical(manifest))
        self.assertEqual(run.call_count, 2)
        with self.assertRaisesRegex(ValueError, "already installed"):
            agent.install()

    def test_preparer_uses_existing_reviewed_assets_and_creates_private_deterministic_bundles(self):
        browser = self.home / "browser"
        browser.mkdir()
        binary = browser / "chrome"
        binary.write_bytes(b"synthetic chromium")
        binary.chmod(0o555)
        runtime = self.home / "runtime.json"
        runtime.write_text(json.dumps({"engine": "chromium", "executablePath": "/opt/gateway-browser/chrome", "version": "151.0.1.2", "sha256": agent.sha(binary)}))
        seccomp = self.home / "seccomp.json"
        seccomp.write_text("{}")
        source = "sha256:" + "a" * 64
        details = [{"Id": source, "Os": "linux", "Architecture": "amd64", "RootFS": {"Layers": ["sha256:" + "b" * 64]}}]
        def docker(argv):
            if "inspect" in argv:
                return result(stdout=json.dumps(details).encode())
            if "save" in argv:
                Path(argv[argv.index("-o") + 1]).write_bytes(b"synthetic image archive")
            return result()
        with patch.object(preparer.os, "geteuid", return_value=0), patch.object(preparer, "run", side_effect=docker) as run:
            first = preparer.prepare(source, browser, runtime, seccomp, self.home / "bundle1")
            os.utime(binary, (123456, 123456))
            second = preparer.prepare(source, browser, runtime, seccomp, self.home / "bundle2")
            with self.assertRaisesRegex(ValueError, "fresh"):
                preparer.prepare(source, browser, runtime, seccomp, self.home / "bundle2")
        one, two = json.loads(first.read_text()), json.loads(second.read_text())
        self.assertEqual(one["browser"]["sha256"], two["browser"]["sha256"])
        self.assertEqual(one["image"]["ref"], "fetchx-autoscaler-pinned:" + "a" * 64)
        self.assertEqual(stat.S_IMODE(first.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(first.parent.stat().st_mode), 0o700)
        self.assertEqual(run.call_count, 6)

    def test_tunnel_repairs_socket_ownership_on_each_reconnect(self):
        path = self.home / "worker.sock"
        path.write_text("synthetic socket")
        real_lstat = Path.lstat
        def socket_stat(candidate):
            info = real_lstat(candidate)
            return Mock(st_mode=stat.S_IFSOCK | 0o600) if candidate == path else info
        with patch.object(tunnel.os, "chown") as chown, patch.object(tunnel.os, "chmod") as chmod, patch.object(Path, "lstat", socket_stat):
            tunnel.fix_socket(path)
            tunnel.fix_socket(path)
            tunnel.remove_socket(path)
            tunnel.remove_socket(path)
        self.assertEqual(chown.call_count, 2)
        chown.assert_called_with(path, 10001, 10001, follow_symlinks=False)
        chmod.assert_called_with(path, 0o600, follow_symlinks=False)
        path.write_text("unrelated")
        with self.assertRaisesRegex(ValueError, "socket"):
            tunnel.fix_socket(path)


if __name__ == "__main__":
    unittest.main()
