"""Durable conservative infrastructure reservations; no cloud credentials here."""

import contextlib
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import uuid


class SafetyError(Exception):
    """A bounded operator-safe error code, never a provider response body."""


def positive_int(value, name, minimum=1):
    if type(value) is not int or value < minimum:
        raise SafetyError("invalid_" + name)
    return value


def validate_config(raw):
    c = dict(raw)
    defaults = dict(enabled=False, server_type="cx23", location="hel1", image="ubuntu-24.04",
                    server_hourly_ceiling_micro_eur=8800, ipv4_hourly_ceiling_micro_eur=800,
                    boot_timeout_seconds=300, scale_up_delay_seconds=30, cooldown_seconds=120,
                    idle_drain_seconds=300, unhealthy_drain_seconds=30, max_vm_lifetime_seconds=3600,
                    cleanup_reserve_seconds=3600, metrics_max_age_seconds=15,
                    poll_seconds=5, worker_lease_seconds=180, renew_seconds=60,
                    drain_before_expiry_seconds=90, hard_delete_grace_seconds=60,
                    max_vm_egress_bytes=1073741824, machine_cooldown_seconds=120,
                    snapshot_boot=False, bake_timeout_seconds=1800, bake_retry_seconds=3600, bake_check_seconds=900)
    for key, value in defaults.items():
        c.setdefault(key, value)
    if type(c["enabled"]) is not bool:
        raise SafetyError("invalid_enabled")
    if type(c["snapshot_boot"]) is not bool:
        raise SafetyError("invalid_snapshot_boot")
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,23}", c.get("deployment", "")):
        raise SafetyError("invalid_deployment")
    for key in ("state_dir", "registry_path", "callback_socket"):
        if not isinstance(c.get(key), str) or not Path(c[key]).is_absolute():
            raise SafetyError("invalid_" + key)
    for key in ("max_additional_workers", "monthly_budget_micro_eur"):
        positive_int(c.get(key), key, 0)
    for key in defaults:
        if type(defaults[key]) is int:
            positive_int(c[key], key, 0 if key in ("scale_up_delay_seconds", "cooldown_seconds", "idle_drain_seconds") else 1)
    if c["image"] != "ubuntu-24.04":
        raise SafetyError("unapproved_machine")
    if "machine_options" not in c:
        # Preserve the original explicitly bounded CX23 configuration. Broader
        # choices require the operator's new allowlist; never invent alternatives.
        if c["server_type"] != "cx23" or c["location"] != "hel1":
            raise SafetyError("unapproved_machine")
        c["machine_options"] = [{k: c[k] for k in ("server_type", "location", "server_hourly_ceiling_micro_eur", "ipv4_hourly_ceiling_micro_eur")}]
    choices = c["machine_options"]
    if not isinstance(choices, list) or not 1 <= len(choices) <= 4:
        raise SafetyError("invalid_machine_options")
    seen = set()
    for option in choices:
        if (not isinstance(option, dict) or set(option) != {"server_type", "location", "server_hourly_ceiling_micro_eur", "ipv4_hourly_ceiling_micro_eur"} or
                not isinstance(option["server_type"], str) or not re.fullmatch(r"[a-z][a-z0-9]{1,15}", option["server_type"]) or option["location"] != "hel1"):
            raise SafetyError("invalid_machine_option")
        identity = option["server_type"], option["location"]
        if identity in seen:
            raise SafetyError("duplicate_machine_option")
        seen.add(identity)
        for key in ("server_hourly_ceiling_micro_eur", "ipv4_hourly_ceiling_micro_eur"):
            positive_int(option[key], key)
    c["machine_options"] = [dict(option) for option in choices]
    if c["enabled"] and (not c["max_additional_workers"] or not c["monthly_budget_micro_eur"]):
        raise SafetyError("authorization_limits_required")
    if c["max_additional_workers"] > 64:
        raise SafetyError("invalid_max_additional_workers")
    if c["renew_seconds"] * 2 >= c["worker_lease_seconds"] or c["drain_before_expiry_seconds"] < 60 or c["hard_delete_grace_seconds"] < 60:
        raise SafetyError("unsafe_lease_timing")
    # A bake must finish (upload, seal, snapshot) well inside the VM's hard lifetime.
    if not 300 <= c["bake_timeout_seconds"] <= c["max_vm_lifetime_seconds"] - c["drain_before_expiry_seconds"]:
        raise SafetyError("unsafe_bake_timing")
    return c


def private_directory(path):
    p = Path(path)
    if p.is_symlink() or not p.is_dir():
        raise SafetyError("state_directory_missing")
    if p.stat().st_mode & 0o077 or p.stat().st_uid != os.geteuid():
        raise SafetyError("state_directory_permissions")
    return p


class InstanceLock:
    def __init__(self, directory):
        path = private_directory(directory) / "controller.lock"
        fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        self.file = os.fdopen(fd, "a+")
        try:
            fcntl.flock(self.file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.file.close()
            raise SafetyError("controller_already_running") from None

    def close(self):
        if not self.file.closed:
            fcntl.flock(self.file, fcntl.LOCK_UN)
            self.file.close()


def month_key(epoch):
    return dt.datetime.fromtimestamp(epoch, dt.timezone.utc).strftime("%Y-%m")


def monthly_costs(start, end, rate):
    """Round every touched UTC month up to full hours, including partial hours."""
    result = {}
    while start < end:
        current = dt.datetime.fromtimestamp(start, dt.timezone.utc)
        year, month = current.year, current.month
        next_month = dt.datetime(year + (month == 12), month % 12 + 1, 1, tzinfo=dt.timezone.utc).timestamp()
        stop = min(end, int(next_month))
        result[f"{year:04d}-{month:02d}"] = ((stop - start + 3599) // 3600) * rate
        start = stop
    return result


class Ledger:
    def __init__(self, config, initialize=False, read_only=False):
        self.config = config
        p = private_directory(config["state_dir"]) / "infrastructure.sqlite3"
        if p.is_symlink() or (not initialize and not p.is_file()):
            raise SafetyError("ledger_missing")
        if initialize and p.exists():
            raise SafetyError("ledger_already_exists")
        if initialize:
            fd = os.open(p, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            os.close(fd)
        if p.stat().st_mode & 0o077 or p.stat().st_uid != os.geteuid():
            raise SafetyError("ledger_permissions")
        try:
            self.db = sqlite3.connect(p.as_uri() + "?mode=ro", uri=True, timeout=1, isolation_level=None) if read_only else sqlite3.connect(str(p), timeout=1, isolation_level=None)
            self.db.row_factory = sqlite3.Row
            self.db.execute("PRAGMA synchronous=FULL")
            if initialize:
                self.db.executescript("""
                    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                    CREATE TABLE workers (id TEXT PRIMARY KEY, record TEXT NOT NULL);
                    CREATE TABLE charges (worker TEXT, month TEXT, amount INTEGER NOT NULL,
                                          PRIMARY KEY(worker,month));
                    CREATE TABLE decisions (seq INTEGER PRIMARY KEY, at INTEGER NOT NULL,
                                            code TEXT NOT NULL, worker TEXT);
                """)
                self.set_meta("version", 1)
                self.set_meta("deployment", config["deployment"])
            if self.db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise SafetyError("ledger_corrupt")
            if self.meta("version") != 1 or self.meta("deployment") != config["deployment"]:
                raise SafetyError("ledger_identity_mismatch")
            self.records()  # Validate all durable records before any mutations.
        except (sqlite3.Error, ValueError, TypeError, KeyError):
            raise SafetyError("ledger_corrupt") from None

    def close(self):
        self.db.close()

    @contextlib.contextmanager
    def transaction(self):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield
            self.db.execute("COMMIT")
        except BaseException:
            self.db.execute("ROLLBACK")
            raise

    def meta(self, key, default=None):
        row = self.db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def set_meta(self, key, value):
        self.db.execute("INSERT OR REPLACE INTO meta VALUES (?,?)", (key, json.dumps(value)))

    def records(self):
        rows = list(self.db.execute("SELECT id,record FROM workers ORDER BY id"))
        records = [json.loads(row[1]) for row in rows]
        for row, r in zip(rows, records):
            if not re.fullmatch(r"[a-z0-9-]{1,32}", r["id"]) or r["state"] not in (
                    "reserved", "creating", "uncertain", "booting", "ready", "draining", "deleting", "deleted", "cancelled"):
                raise SafetyError("ledger_record_invalid")
            if row[0] != r["id"] or type(r.get("registered", False)) is not bool:
                raise SafetyError("ledger_record_invalid")
            for k in ("created_at", "lease_expires_at", "rate", "reservation"):
                positive_int(r[k], "record_" + k)
            if r["lease_expires_at"] <= r["created_at"]:
                raise SafetyError("ledger_record_invalid")
            for k in ("server_id", "ipv4_id", "ssh_key_id"):
                if r.get(k) is not None:
                    positive_int(r[k], "record_" + k)
            if "machine" in r:
                m = r["machine"]
                if (not isinstance(m, dict) or not isinstance(m.get("server_type"), str) or
                        not re.fullmatch(r"[a-z][a-z0-9]{1,15}", m["server_type"]) or m.get("location") != "hel1"):
                    raise SafetyError("ledger_machine_invalid")
                positive_int(m.get("type_id"), "record_type_id")
                for key in ("server_hourly_ceiling_micro_eur", "ipv4_hourly_ceiling_micro_eur"):
                    positive_int(m.get(key), "record_" + key)
                for key in ("server_hourly_micro_eur", "ipv4_hourly_micro_eur"):
                    positive_int(m.get(key), "record_" + key, 0)
                if (r["rate"] != m["server_hourly_ceiling_micro_eur"] + m["ipv4_hourly_ceiling_micro_eur"] or
                        m["server_hourly_micro_eur"] > m["server_hourly_ceiling_micro_eur"] or
                        m["ipv4_hourly_micro_eur"] > m["ipv4_hourly_ceiling_micro_eur"]):
                    raise SafetyError("ledger_machine_invalid")
            if r.get("purpose", "worker") not in ("worker", "bake"):
                raise SafetyError("ledger_record_invalid")
            if r.get("purpose") == "bake":
                if (not isinstance(r.get("manifest_sha256"), str) or not re.fullmatch(r"[a-f0-9]{64}", r["manifest_sha256"]) or
                        r.get("bake_phase", "install") not in ("install", "sealed", "imaging", "done")):
                    raise SafetyError("ledger_record_invalid")
                if r.get("image_id") is not None:
                    positive_int(r["image_id"], "record_image_id")
            if r.get("image", "ubuntu-24.04") != "ubuntu-24.04":
                positive_int(r["image"], "record_image")
            if r["state"] == "deleted":
                positive_int(r["deleted_at"], "record_deleted_at")
                if r["deleted_at"] < r["created_at"] or not r.get("server_id") or not r.get("ipv4_id"):
                    raise SafetyError("ledger_record_invalid")
        return records

    def save(self, record):
        self.db.execute("INSERT OR REPLACE INTO workers VALUES (?,?)", (record["id"], json.dumps(record, sort_keys=True)))

    def decision(self, now, code, worker=None):
        if not re.fullmatch(r"[a-z0-9_]{1,80}", code):
            raise SafetyError("invalid_decision_code")
        self.db.execute("INSERT INTO decisions(at,code,worker) VALUES (?,?,?)", (now, code, worker))

    def accrue(self, now):
        with self.transaction():
            for r in self.records():
                if r["state"] == "cancelled":
                    continue
                for month, amount in monthly_costs(r["created_at"], r.get("deleted_at", now), r["rate"]).items():
                    self.db.execute("INSERT INTO charges VALUES (?,?,?) ON CONFLICT(worker,month) DO UPDATE SET amount=max(amount,excluded.amount)",
                                    (r["id"], month, amount))

    def committed(self, now):
        month = month_key(now)
        amount = 0
        for r in self.records():
            if r["state"] == "cancelled":
                continue
            charge = self.db.execute("SELECT amount FROM charges WHERE worker=? AND month=?", (r["id"], month)).fetchone()
            charge = charge[0] if charge else 0
            charge = max(charge, monthly_costs(r["created_at"], r.get("deleted_at", now), r["rate"]).get(month, 0))
            amount += charge if r["state"] == "deleted" else max(charge, r["reservation"])
        return amount

    def reserve(self, now, worker_id, machine, **extra):
        with self.transaction():
            records = self.records()
            if any(r["id"] == worker_id for r in records):
                raise SafetyError("duplicate_reservation")
            if sum(r["state"] not in ("deleted", "cancelled") for r in records) >= self.config["max_additional_workers"]:
                raise SafetyError("resource_cap")
            option = next((o for o in self.config["machine_options"] if all(o[k] == machine.get(k) for k in o)), None)
            if option is None or type(machine.get("type_id")) is not int or machine["type_id"] < 1:
                raise SafetyError("unapproved_reservation_machine")
            for key, ceiling in (("server_hourly_micro_eur", "server_hourly_ceiling_micro_eur"), ("ipv4_hourly_micro_eur", "ipv4_hourly_ceiling_micro_eur")):
                positive_int(machine.get(key), key, 0)
                if machine[key] > option[ceiling]:
                    raise SafetyError("price_ceiling")
            rate = option["server_hourly_ceiling_micro_eur"] + option["ipv4_hourly_ceiling_micro_eur"]
            # Separate rounding covers a partial lifetime hour and partial cleanup hour.
            hours = ((self.config["max_vm_lifetime_seconds"] + 3599) // 3600 +
                     (self.config["cleanup_reserve_seconds"] + 3599) // 3600 + 1)
            # Extra hour covers rounding across a UTC month boundary.
            reservation = hours * rate
            if self.committed(now) + reservation > self.config["monthly_budget_micro_eur"]:
                raise SafetyError("budget_cap")
            r = dict(id=worker_id, created_at=now, lease_expires_at=now + self.config["max_vm_lifetime_seconds"],
                     state="reserved", rate=rate, reservation=reservation, server_id=None, ipv4_id=None, machine=dict(machine),
                     **{k: v for k, v in extra.items() if k in ("purpose", "manifest_sha256", "image")})
            self.save(r)
            self.decision(now, "reserved", worker_id)
            return r


class Registry:
    def __init__(self, path):
        self.path = Path(path)

    def read(self):
        try:
            if self.path.is_symlink() or self.path.stat().st_size > 65536:
                raise SafetyError("registry_invalid")
            rows = json.loads(self.path.read_text())
            ids, paths = set(), set()
            if not isinstance(rows, list) or len(rows) > 64:
                raise ValueError()
            for r in rows:
                if (set(r) != {"id", "state", "socket_path"} or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", r["id"]) or
                        r["state"] not in ("active", "draining") or not os.path.isabs(r["socket_path"]) or
                        r["id"] in ids or r["socket_path"] in paths):
                    raise ValueError()
                ids.add(r["id"])
                paths.add(r["socket_path"])
            return rows
        except (OSError, ValueError, TypeError, KeyError):
            raise SafetyError("registry_invalid") from None

    def edit(self, worker_id, row=None, drain=False, remove=False):
        rows = self.read()
        existing = next((r for r in rows if r["id"] == worker_id), None)
        if drain and existing:
            existing["state"] = "draining"
        elif remove:
            rows = [r for r in rows if r["id"] != worker_id]
        elif row:
            if existing and existing != row:
                raise SafetyError("registry_collision")
            if not existing:
                rows.append(row)
        old = self.path.stat()
        temporary = self.path.with_name(self.path.name + ".autoscaler-" + uuid.uuid4().hex)
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, stat.S_IMODE(old.st_mode))
        try:
            with os.fdopen(fd, "w") as f:
                if os.geteuid() == 0:
                    os.fchown(f.fileno(), old.st_uid, old.st_gid)
                # os.open's mode is filtered by the controller's private umask.
                # Restore the existing reader contract after ownership changes.
                os.fchmod(f.fileno(), stat.S_IMODE(old.st_mode))
                json.dump(rows, f, separators=(",", ":"))
                f.flush()
                os.fsync(f.fileno())
            os.replace(temporary, self.path)
            directory = os.open(self.path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            temporary.unlink(missing_ok=True)
