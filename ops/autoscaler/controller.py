"""Root-only FetchX autoscaler. Run with ``python3 -m ops.autoscaler.controller``.

Initialization is explicit: an absent ledger is never treated as a fresh budget.
All expensive work is injectable for synthetic tests; the CLI never provisions
unless an operator explicitly enables a valid, budgeted configuration.
"""

import argparse
from concurrent.futures import Future
import datetime as dt
import http.client
import json
import os
from pathlib import Path
import signal
import socket
import threading
import time
import uuid

from .core import (InstanceLock, Ledger, Registry, SafetyError, month_key,
                   private_directory, validate_config)
from .hetzner import CloudError, Hetzner, UncertainCreate, select_machine


class UnixMetrics:
    def __init__(self, path):
        self.path = path

    def __call__(self):
        connection = http.client.HTTPConnection("localhost", timeout=3)
        connection.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.sock.settimeout(3)
        try:
            connection.sock.connect(self.path)
            connection.request("GET", "/v1/pool-metrics")
            response = connection.getresponse()
            body = response.read(65537)
            if response.status != 200 or len(body) > 65536:
                raise SafetyError("metrics_unavailable")
            return json.loads(body)
        except (OSError, ValueError, http.client.HTTPException):
            raise SafetyError("metrics_unavailable") from None
        finally:
            connection.close()


def metrics_snapshot(value, now, max_age):
    try:
        generated = dt.datetime.fromisoformat(value["generated_at"].replace("Z", "+00:00"))
        if generated.utcoffset() is None:
            raise ValueError()
        timestamp = generated.timestamp()
        if timestamp > now + 2 or now - timestamp > max_age or value["version"] != 1:
            raise SafetyError("metrics_stale")
        if type(value["max_concurrent_requests"]) is not int or value["max_concurrent_requests"] < 1:
            raise ValueError()
        for key in ("pending", "active", "oldest_wait_ms", "recent_timeouts"):
            if type(value["queue"][key]) is not int or value["queue"][key] < 0:
                raise ValueError()
        ids = set()
        if not isinstance(value["workers"], list) or len(value["workers"]) > 64:
            raise ValueError()
        for w in value["workers"]:
            if (not isinstance(w["id"], str) or w["id"] in ids or w["state"] not in ("active", "draining") or
                    type(w["ready"]) is not bool or type(w["busy"]) is not bool):
                raise ValueError()
            ids.add(w["id"])
        return dict(value, timestamp=timestamp)
    except (ValueError, KeyError, TypeError, AttributeError):
        raise SafetyError("metrics_invalid") from None


def background(fn, *args):
    """A bounded driver call cannot block the reconciliation loop or CLI exit."""
    future = Future()
    def run():
        if not future.set_running_or_notify_cancel():
            return
        try:
            future.set_result(fn(*args))
        except BaseException as error:
            future.set_exception(error)
    threading.Thread(target=run, name="fetchx-worker-driver", daemon=True).start()
    return future


class Controller:
    def __init__(self, config, cloud, driver, metrics=None, clock=time.time, submit=background):
        self.config = validate_config(config)
        self.lock = InstanceLock(self.config["state_dir"])
        try:
            self.ledger = Ledger(self.config)
        except BaseException:
            self.lock.close()
            raise
        self.cloud, self.driver = cloud, driver
        self.metrics = metrics or UnixMetrics(config["callback_socket"])
        self.clock, self.submit = clock, submit
        self.registry = Registry(config["registry_path"])
        self.futures = {}

    def close(self):
        self.ledger.close()
        self.lock.close()

    def labels(self, record):
        return {"fetchx-deployment": self.config["deployment"], "fetchx-worker": record["id"]}

    def name(self, record):
        return "fx-" + self.config["deployment"] + "-" + record["id"]

    def status(self, now=None):
        now = int(self.clock()) if now is None else now
        self.ledger.accrue(now)
        rows = self.ledger.records()
        decision = self.ledger.db.execute("SELECT at,code,worker FROM decisions ORDER BY seq DESC LIMIT 1").fetchone()
        return dict(enabled=self.config["enabled"], deployment=self.config["deployment"], month_utc=month_key(now),
                    monthly_budget_micro_eur=self.config["monthly_budget_micro_eur"],
                    committed_micro_eur=self.ledger.committed(now),
                    max_additional_workers=self.config["max_additional_workers"],
                    workers=[{k: r.get(k) for k in ("id", "state", "server_id", "ipv4_id", "lease_expires_at", "reservation", "machine")} for r in rows],
                    last_decision=dict(decision) if decision else None)

    def _decision(self, now, code, record=None):
        self.ledger.decision(now, code, record["id"] if record else None)

    def _owned(self, resource, record):
        labels = resource.get("labels", {})
        return all(labels.get(k) == v for k, v in self.labels(record).items())

    def _validate_inventory(self, servers, ips):
        records = {r["id"]: r for r in self.ledger.records()}
        seen = set()
        for s in servers:
            owner = s.get("labels", {}).get("fetchx-deployment")
            known = next((r for r in records.values() if r.get("server_id") == s["id"] or self.name(r) == s.get("name")), None)
            if owner == self.config["deployment"]:
                identity = s.get("labels", {}).get("fetchx-worker")
                if identity not in records or identity in seen or not self._owned(s, records[identity]) or s.get("name") != self.name(records[identity]):
                    raise SafetyError("unknown_or_duplicate_owned_server")
                if records[identity]["state"] in ("cancelled", "deleted"):
                    raise SafetyError("closed_reservation_has_server")
                seen.add(identity)
            elif known:
                raise SafetyError("server_ownership_changed")
        for ip in ips:
            if ip.get("labels", {}).get("fetchx-deployment") == self.config["deployment"]:
                identity = ip.get("labels", {}).get("fetchx-worker")
                if identity not in records or (records[identity].get("ipv4_id") not in (None, ip["id"])):
                    raise SafetyError("unknown_owned_ip")

    def _drain(self, r, now, reason):
        if r["state"] in ("draining", "deleting"):
            return
        # Persist intent before registry mutation: after a crash this is repeated.
        r.update(state="draining", drain_at=now)
        self.ledger.save(r)
        self.registry.edit(r["id"], drain=True)
        self._decision(now, reason, r)

    def _finish_futures(self, now):
        records = {r["id"]: r for r in self.ledger.records()}
        for key, future in list(self.futures.items()):
            if not future.done():
                continue
            del self.futures[key]
            identity, kind = key
            r = records[identity]
            try:
                result = future.result()
                if kind == "bootstrap" and r["state"] == "booting":
                    if (not self.config["enabled"] or now >= r["lease_expires_at"] - self.config["drain_before_expiry_seconds"] or
                            now - r["created_at"] >= self.config["boot_timeout_seconds"]):
                        self._drain(r, now, "late_bootstrap_drain")
                        continue
                    path = result["socket_path"]
                    prefix = self.config.get("gateway_registry_dir", "/run/fx/registry").rstrip("/") + "/"
                    if not isinstance(path, str) or not path.startswith(prefix) or "/../" in path:
                        raise SafetyError("driver_socket_invalid")
                    row = dict(id=r["id"], state="active", socket_path=path)
                    # Durable registration intent precedes atomic publication.
                    r.update(socket_path=path, registered=True)
                    self.ledger.save(r)
                    self.registry.edit(r["id"], row=row)
                    r.update(state="ready", ready_at=now, last_renewed_at=now)
                    self.ledger.save(r)
                    self._decision(now, "worker_ready", r)
                elif kind == "renew" and r["state"] == "ready":
                    r["last_renewed_at"] = now
                    self.ledger.save(r)
                elif kind == "bootstrap":
                    self.driver.disconnect(r)
            except Exception:
                if r["state"] not in ("deleted", "cancelled", "deleting"):
                    self._drain(r, now, "driver_" + kind + "_failed")

    def _delete(self, r, server, now):
        # Registry was drained, and this caller has proved no admitted work remains.
        self.registry.edit(r["id"], remove=True)
        r["state"] = "deleting"
        self.ledger.save(r)
        self.driver.disconnect(r)
        if server is not None:
            current = self.cloud.server(server["id"])
            if current is None:
                return
            if not self._owned(current, r) or current["id"] != r.get("server_id") or current.get("name") != self.name(r):
                raise SafetyError("delete_ownership_invalid")
            self.cloud.delete_server(current["id"])
            self._decision(now, "server_delete_requested", r)

    def _cleanup_absent(self, r, now):
        # Lists are discovery only. Explicit 404 for each known resource is required.
        if r.get("server_id") is None or self.cloud.server(r["server_id"]) is not None:
            return
        self.registry.edit(r["id"], remove=True)
        self.driver.disconnect(r)
        r["state"] = "deleting"
        self.ledger.save(r)
        if r.get("ipv4_id") is None:
            self._decision(now, "ipv4_identity_unresolved", r)
            return
        ip = self.cloud.ipv4(r["ipv4_id"])
        if ip is not None:
            if ip.get("assignee_id") not in (None, 0) or ip.get("labels", {}).get("fetchx-deployment") not in (None, self.config["deployment"]):
                raise SafetyError("ipv4_cleanup_ownership_invalid")
            if not self._owned(ip, r):
                # The ID was durably bound from our server create response before
                # ownership publication; finish that interrupted step first.
                self.cloud.own_ipv4(ip["id"], self.labels(r))
                self._decision(now, "ipv4_ownership_requested", r)
                return
            self.cloud.delete_ipv4(ip["id"])
            self._decision(now, "ipv4_delete_requested", r)
            return
        now = int(self.clock())
        r.update(state="deleted", deleted_at=now)
        self.ledger.save(r)
        self._decision(now, "deletion_confirmed", r)

    def _reconcile(self, servers, ips, metrics, now):
        problem = None
        for r in self.ledger.records():
            try:
                self._reconcile_one(r, servers, ips, metrics, now)
            except (CloudError, SafetyError) as error:
                problem = str(error)
                self._decision(now, problem, r)
            except Exception:
                problem = "worker_reconcile_error"
                self._decision(now, problem, r)
        return problem

    def _reconcile_one(self, r, servers, ips, metrics, now):
        worker_metrics = {w["id"]: w for w in metrics["workers"]} if metrics else {}
        if r["state"] in ("deleted", "cancelled"):
            return
        matches = [s for s in servers if self._owned(s, r)]
        if len(matches) > 1:
            raise SafetyError("duplicate_owned_server")
        if not matches:
            if r.get("server_id"):
                self._cleanup_absent(r, now)
            elif r["state"] == "reserved":
                # prepare may have run, but durable creating intent has not.
                r["state"] = "cancelled"
                self.ledger.save(r)
            else:
                r["state"] = "uncertain"
                self.ledger.save(r)
                self._decision(now, "create_unresolved", r)
            return
        server = matches[0]
        if r.get("server_id") not in (None, server["id"]) or server.get("name") != self.name(r):
            raise SafetyError("server_identity_changed")
        if now >= r["lease_expires_at"] + self.config["hard_delete_grace_seconds"]:
            r["server_id"] = server["id"]
            ip_id = server.get("public_net", {}).get("ipv4", {}).get("id")
            if r.get("ipv4_id") is None and type(ip_id) is int and ip_id > 0:
                r["ipv4_id"] = ip_id
            self.ledger.save(r)
            self._drain(r, now, "hard_lifetime_drain")
            self._delete(r, server, now)
            self._decision(now, "hard_lifetime_delete", r)
            return
        ip_id = server.get("public_net", {}).get("ipv4", {}).get("id")
        if type(ip_id) is not int or ip_id < 1 or r.get("ipv4_id") not in (None, ip_id):
            raise SafetyError("ipv4_identity_invalid")
        r.update(server_id=server["id"], ipv4_id=ip_id)
        if r["state"] in ("creating", "uncertain", "reserved"):
            r["state"] = "booting"
        self.ledger.save(r)
        ip = next((i for i in ips if i["id"] == ip_id), None)
        if ip is None or ip.get("assignee_id") != server["id"]:
            raise SafetyError("ipv4_assignment_invalid")
        if ip.get("labels", {}).get("fetchx-deployment") not in (None, self.config["deployment"]):
            raise SafetyError("ipv4_ownership_changed")
        if not self._owned(ip, r) or not ip.get("auto_delete"):
            self.cloud.own_ipv4(ip_id, self.labels(r))
            # Do not admit a worker until the ownership update is observed.
            self._decision(now, "ipv4_ownership_requested", r)
            return
        if r.get("machine") and server.get("server_type", {}).get("id") != r["machine"]["type_id"]:
            self._drain(r, now, "machine_identity_mismatch")
        if r["state"] not in ("draining", "deleting"):
            if (not self.config["enabled"] or now >= r["lease_expires_at"] - self.config["drain_before_expiry_seconds"] or
                    (r["state"] == "booting" and now - r["created_at"] >= self.config["boot_timeout_seconds"])):
                self._drain(r, now, "worker_lifetime_drain" if self.config["enabled"] else "disabled_drain")
            elif r["state"] == "booting":
                key = r["id"], "bootstrap"
                if key not in self.futures:
                    self.futures[key] = self.submit(self.driver.bootstrap, dict(r), server)
            elif r["state"] == "ready":
                if r.get("registered"):
                    rows = self.registry.read()
                    entry = next((row for row in rows if row["id"] == r["id"]), None)
                    if not entry or entry["state"] != "active" or entry["socket_path"] != r.get("socket_path"):
                        self._drain(r, now, "registry_worker_changed")
                w = worker_metrics.get(r["id"])
                if metrics and w and not w["ready"]:
                    r.setdefault("unhealthy_since", now)
                    if now - r["unhealthy_since"] >= self.config["unhealthy_drain_seconds"]:
                        self._drain(r, now, "unhealthy_drain")
                else:
                    # Missing/stale metrics are not evidence of sustained failure.
                    r.pop("unhealthy_since", None)
                key = r["id"], "renew"
                if r["state"] == "ready" and now - r.get("last_renewed_at", 0) >= self.config["renew_seconds"] and key not in self.futures:
                    self.futures[key] = self.submit(self.driver.renew, dict(r), server)
                if metrics and w and w["ready"] and not w["busy"]:
                    r.setdefault("idle_since", now)
                    if now - r["idle_since"] >= self.config["idle_drain_seconds"]:
                        self._drain(r, now, "idle_drain")
                else:
                    r.pop("idle_since", None)
                self.ledger.save(r)
        if r["state"] == "draining":
            self.registry.edit(r["id"], drain=True)
            w = worker_metrics.get(r["id"])
            lease_elapsed = now >= r["drain_at"] + self.config["worker_lease_seconds"] + self.config["hard_delete_grace_seconds"]
            unavailable = not metrics or not w or not w["ready"]
            if (not r.get("registered") or (lease_elapsed and unavailable) or
                    (metrics and metrics["timestamp"] > r["drain_at"] and w and w["state"] == "draining" and w["ready"] and not w["busy"])):
                self._delete(r, server, now)
            else:
                self._decision(now, "waiting_for_drain", r)
        elif r["state"] == "deleting":
            self._delete(r, server, now)

    def _grow(self, metrics, now):
        if not self.config["enabled"]:
            self._decision(now, "disabled")
            return
        rows = self.registry.read()
        if len(rows) >= 64:
            raise SafetyError("registry_resource_cap")
        active = [w for w in metrics["workers"] if w["state"] == "active"]
        if set((w["id"], w["state"]) for w in metrics["workers"]) != set((r["id"], r["state"]) for r in rows):
            raise SafetyError("metrics_registry_mismatch")
        registry_ids = {row["id"] for row in rows}
        capacity = sum(row["state"] == "active" for row in rows)
        capacity += sum(r["state"] == "booting" and r["id"] not in registry_ids for r in self.ledger.records())
        if capacity >= metrics["max_concurrent_requests"]:
            self.ledger.set_meta("pressure_since", None)
            self._decision(now, "gateway_capacity_cap")
            return
        pressure = (metrics["queue"]["pending"] > 0 and bool(active) and all(w["ready"] and w["busy"] for w in active) and
                    metrics["queue"]["active"] >= min(len(active), metrics["max_concurrent_requests"]))
        if not pressure:
            self.ledger.set_meta("pressure_since", None)
            self._decision(now, "no_sustained_pressure")
            return
        since = self.ledger.meta("pressure_since")
        if since is None:
            since = now
            self.ledger.set_meta("pressure_since", since)
        if now - since < self.config["scale_up_delay_seconds"] or metrics["queue"]["oldest_wait_ms"] < self.config["scale_up_delay_seconds"] * 1000:
            self._decision(now, "scale_up_delay")
            return
        if any(r["state"] not in ("ready", "deleted", "cancelled", "draining", "deleting") or
               (r["state"] in ("draining", "deleting") and (not r.get("server_id") or not r.get("ipv4_id")))
               for r in self.ledger.records()):
            self._decision(now, "growth_in_flight")
            return
        if now - self.ledger.meta("last_create_at", 0) < self.config["cooldown_seconds"]:
            self._decision(now, "growth_cooldown")
            return
        server_types, pricing = self.cloud.server_types(), self.cloud.pricing()
        now = int(self.clock())
        metrics_snapshot(metrics, now, self.config["metrics_max_age_seconds"])
        machine = select_machine(server_types, pricing, self.config,
                                 self.ledger.meta("machine_cooldowns", {}), now)
        record = self.ledger.reserve(now, uuid.uuid4().hex[:24], machine)
        try:
            prepared = self.driver.prepare(dict(record))
            if not isinstance(prepared["user_data"], str) or not prepared["user_data"]:
                raise SafetyError("driver_prepare_invalid")
            now = int(self.clock())
            if now >= record["lease_expires_at"] - self.config["drain_before_expiry_seconds"]:
                raise SafetyError("driver_prepare_expired")
            key_id = self.cloud.ensure_ssh_key(self.config["deployment"], prepared["ssh_public_key"])
            if type(key_id) is not int or not 1 <= key_id <= 9007199254740991:
                raise SafetyError("driver_ssh_key_invalid")
            now = int(self.clock())
            if now >= record["lease_expires_at"] - self.config["drain_before_expiry_seconds"]:
                raise SafetyError("driver_prepare_expired")
            record["ssh_key_id"] = key_id
            self.ledger.save(record)
        except Exception:
            record["state"] = "cancelled"
            self.ledger.save(record)
            self._decision(now, "driver_prepare_failed", record)
            return
        # Crash from here through receiving the response is an uncertain POST.
        record["state"] = "creating"
        previous_create_at = self.ledger.meta("last_create_at", 0)
        with self.ledger.transaction():
            self.ledger.save(record)
            self.ledger.set_meta("last_create_at", now)
            self.ledger.set_meta("pressure_since", None)
        try:
            server = self.cloud.create(self.name(record), self.labels(record), prepared["user_data"], dict(record["machine"]), record["ssh_key_id"])
            if not self._owned(server, record) or server.get("name") != self.name(record) or type(server.get("id")) is not int:
                raise UncertainCreate("create_uncertain")
            record.update(server_id=server["id"], state="booting")
            ip = server.get("public_net", {}).get("ipv4", {}).get("id")
            if type(ip) is int and ip > 0:
                record["ipv4_id"] = ip
            self.ledger.save(record)
            self._decision(now, "server_created", record)
        except UncertainCreate:
            record["state"] = "uncertain"
            self.ledger.save(record)
            self._decision(now, "create_uncertain", record)
        except CloudError as error:
            record["state"] = "cancelled" if error.status is not None and 400 <= error.status < 500 else "uncertain"
            with self.ledger.transaction():
                self.ledger.save(record)
                if record["state"] == "cancelled" and error.provider_code:
                    cooldowns = self.ledger.meta("machine_cooldowns", {})
                    cooldowns[machine["server_type"] + "@" + machine["location"]] = now + self.config["machine_cooldown_seconds"]
                    self.ledger.set_meta("machine_cooldowns", cooldowns)
                    self.ledger.set_meta("last_create_at", previous_create_at)
                    self.ledger.set_meta("pressure_since", since)
            self._decision(now, "create_rejected" if record["state"] == "cancelled" else "create_uncertain", record)

    def once(self):
        now = int(self.clock())
        self.ledger.accrue(now)
        try:
            self.registry.read()
            servers, ips = self.cloud.inventory()
            inventory_problem = None
            try:
                self._validate_inventory(servers, ips)
            except SafetyError as error:
                inventory_problem = str(error)
            try:
                try:
                    value = self.metrics()
                finally:
                    # Inventory and gateway health reads can take several seconds.
                    # Compare generated_at and lifecycle deadlines at receipt time.
                    now = int(self.clock())
                metrics = metrics_snapshot(value, now, self.config["metrics_max_age_seconds"])
            except SafetyError as error:
                metrics = None
                self.ledger.set_meta("pressure_since", None)
                self._decision(now, str(error))
            except Exception:
                metrics = None
                self.ledger.set_meta("pressure_since", None)
                self._decision(now, "metrics_unavailable")
            if not inventory_problem:
                self._finish_futures(now)
            reconcile_problem = self._reconcile(servers, ips, metrics, now)
            if inventory_problem or reconcile_problem:
                self.ledger.set_meta("pressure_since", None)
                self._decision(now, inventory_problem or reconcile_problem)
            elif metrics:
                now = int(self.clock())
                metrics_snapshot(metrics, now, self.config["metrics_max_age_seconds"])
                self._grow(metrics, now)
        except (CloudError, SafetyError) as error:
            self.ledger.set_meta("pressure_since", None)
            self._decision(now, str(error))
        except Exception:
            # Never print provider/driver exception messages: they may contain secrets.
            self.ledger.set_meta("pressure_since", None)
            self._decision(now, "reconcile_error")
        return self.status()


def load_config(path):
    p = Path(path)
    if p.is_symlink() or not p.is_file() or p.stat().st_uid != 0 or p.stat().st_mode & 0o077:
        raise SafetyError("config_must_be_root_private")
    try:
        return validate_config(json.loads(p.read_text()))
    except (ValueError, OSError, TypeError):
        raise SafetyError("config_invalid") from None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("command", choices=("init", "status", "once", "run"))
    args = parser.parse_args(argv)
    controller = None
    try:
        if os.geteuid() != 0:
            raise SafetyError("root_required")
        config = load_config(args.config)
        private_directory(config["state_dir"])
        if args.command == "status":
            ledger = Ledger(config, read_only=True)
            try:
                now = int(time.time())
                decision = ledger.db.execute("SELECT at,code,worker FROM decisions ORDER BY seq DESC LIMIT 1").fetchone()
                print(json.dumps(dict(initialized=True, enabled=config["enabled"], month_utc=month_key(now),
                                      monthly_budget_micro_eur=config["monthly_budget_micro_eur"],
                                      committed_micro_eur=ledger.committed(now), workers=ledger.records(),
                                      last_decision=dict(decision) if decision else None), sort_keys=True))
            finally:
                ledger.close()
            return 0
        if args.command == "init":
            lock = InstanceLock(config["state_dir"])
            try:
                ledger = Ledger(config, initialize=True)
                try:
                    now = int(time.time())
                    ledger.accrue(now)
                    print(json.dumps(dict(initialized=True, enabled=config["enabled"], month_utc=month_key(now),
                                          committed_micro_eur=ledger.committed(now),
                                          workers=ledger.records()), sort_keys=True))
                finally:
                    ledger.close()
            finally:
                lock.close()
            return 0
        from .worker_driver import WorkerDriver
        cloud = Hetzner(config["cloud_token_path"])
        controller = Controller(config, cloud, WorkerDriver(config))
        if args.command == "once":
            print(json.dumps(controller.once(), sort_keys=True))
        else:
            stopped = threading.Event()
            signal.signal(signal.SIGTERM, lambda *_: stopped.set())
            signal.signal(signal.SIGINT, lambda *_: stopped.set())
            while not stopped.is_set():
                result = controller.once()
                print(json.dumps({"month_utc": result["month_utc"], "committed_micro_eur": result["committed_micro_eur"],
                                  "last_decision": result["last_decision"]}), flush=True)
                stopped.wait(config["poll_seconds"])
        return 0
    except (SafetyError, KeyError):
        print(json.dumps({"error": "controller_configuration_or_state_invalid"}))
        return 2
    finally:
        if controller:
            controller.close()


if __name__ == "__main__":
    raise SystemExit(main())
