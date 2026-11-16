"""Serial, synthetic-only infrastructure admission and lifecycle tests."""

from concurrent.futures import Future
import copy
import datetime as dt
import json
import os
from pathlib import Path
import tempfile
import unittest

from ops.autoscaler.controller import Controller, metrics_snapshot
from ops.autoscaler.core import InstanceLock, Ledger, SafetyError, monthly_costs, validate_config
from ops.autoscaler.hetzner import CloudError, UncertainCreate, approved_prices, micro_eur, select_machine


def epoch(value):
    return int(dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp())


def prices(server="0.0088", ipv4="0.0008", currency="EUR"):
    return {"pricing": {"currency": currency,
        "server_types": [{"id": 114, "prices": [{"location": "hel1", "included_traffic": 20 * 1024 ** 4,
                                                        "price_hourly": {"net": server}}]}],
        "primary_ips": [{"type": "ipv4", "prices": [{"location": "hel1", "price_hourly": {"net": ipv4}}]}]}}


def option(name, ceiling):
    return dict(server_type=name, location="hel1", server_hourly_ceiling_micro_eur=ceiling, ipv4_hourly_ceiling_micro_eur=800)


def machine(identity, name, available=True, **kwargs):
    return dict(id=identity, name=name, architecture="x86", cores=2, memory=4, disk=40,
                locations=[dict(name="hel1", available=available, deprecation=None)], **kwargs)


class FakeCloud:
    def __init__(self):
        self.servers, self.ips = [], []
        self.calls = []
        self.price = prices()
        self.create_error = None
        self.leak = False
        self.unavailable = False
        self.capacity = True
        self.types = None
        self.created_machines = []

    def server_types(self):
        if self.types is not None:
            return {"server_types": copy.deepcopy(self.types)}
        return {"server_types": [{"id": 114, "name": "cx23", "architecture": "x86",
            "cores": 2, "memory": 4, "disk": 40,
            "locations": [{"name": "hel1", "available": self.capacity, "deprecation": None}]}]}

    def inventory(self):
        if self.unavailable:
            raise CloudError()
        return copy.deepcopy(self.servers), copy.deepcopy(self.ips)

    def pricing(self):
        self.calls.append("pricing")
        return self.price

    def create(self, name, labels, user_data, machine):
        self.calls.append("create")
        self.created_machines.append(copy.deepcopy(machine))
        if self.create_error and not isinstance(self.create_error, UncertainCreate):
            raise self.create_error
        server = dict(id=len(self.servers) + 1, name=name, labels=labels, status="running",
                      server_type={"name": machine["server_type"], "id": machine["type_id"]}, public_net={"ipv4": {"id": 100 + len(self.servers)}})
        self.servers.append(server)
        self.ips.append(dict(id=server["public_net"]["ipv4"]["id"], labels={}, assignee_id=server["id"], auto_delete=False))
        if self.create_error:
            raise self.create_error
        return copy.deepcopy(server)

    def own_ipv4(self, identity, labels):
        self.calls.append("own_ipv4")
        ip = next(i for i in self.ips if i["id"] == identity)
        ip.update(labels=labels, auto_delete=True)

    def server(self, identity):
        self.calls.append("server_get")
        return copy.deepcopy(next((s for s in self.servers if s["id"] == identity), None))

    def ipv4(self, identity):
        self.calls.append("ipv4_get")
        return copy.deepcopy(next((s for s in self.ips if s["id"] == identity), None))

    def delete_server(self, identity):
        self.calls.append("delete_server")
        self.servers = [s for s in self.servers if s["id"] != identity]
        for ip in self.ips:
            if ip["assignee_id"] == identity:
                ip["assignee_id"] = None

    def delete_ipv4(self, identity):
        self.calls.append("delete_ipv4")
        if not self.leak:
            self.ips = [s for s in self.ips if s["id"] != identity]


class FakeDriver:
    def __init__(self):
        self.bootstraps = []
        self.disconnects = []
        self.renewals = []

    def prepare(self, record):
        return {"user_data": "#cloud-config\nsynthetic: true"}

    def bootstrap(self, record, server):
        self.bootstraps.append(record["id"])
        return {"socket_path": "/run/fx/registry/" + record["id"] + ".sock"}

    def renew(self, record, server):
        self.renewals.append(record["id"])

    def disconnect(self, record):
        self.disconnects.append(record["id"])


def immediate(fn, *args):
    future = Future()
    try:
        future.set_result(fn(*args))
    except Exception as error:
        future.set_exception(error)
    return future


class ControllerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)
        (self.path / "registry.json").write_text(json.dumps([dict(id="base", state="active", socket_path="/base.sock")]))
        self.config = validate_config(dict(state_dir=str(self.path), registry_path=str(self.path / "registry.json"),
            callback_socket=str(self.path / "callback.sock"), deployment="test", enabled=True,
            max_additional_workers=2, monthly_budget_micro_eur=1000000,
            scale_up_delay_seconds=0, cooldown_seconds=0, idle_drain_seconds=20))
        Ledger(self.config, initialize=True).close()
        self.now = epoch("2026-11-16T00:00:00Z")
        self.cloud, self.driver = FakeCloud(), FakeDriver()
        self.pressure, self.stale = True, False
        self.global_limit = 10
        self.busy = {}
        self.worker_ready = {}
        self.controller = self.make_controller()
        self.addCleanup(lambda: self.controller.close())

    def make_controller(self, submit=immediate):
        return Controller(self.config, self.cloud, self.driver, self.metrics, lambda: self.now, submit)

    def metrics(self):
        rows = json.loads((self.path / "registry.json").read_text())
        return dict(version=1, generated_at=dt.datetime.fromtimestamp(self.now - (100 if self.stale else 0), dt.timezone.utc).isoformat(),
                    queue=dict(pending=1 if self.pressure else 0, active=len(rows) if self.pressure else 0,
                               oldest_wait_ms=100000, recent_timeouts=0), max_concurrent_requests=self.global_limit,
                    workers=[dict(id=r["id"], state=r["state"], ready=self.worker_ready.get(r["id"], True),
                                  busy=self.busy.get(r["id"], self.pressure)) for r in rows])

    def tick(self, seconds=1):
        self.now += seconds
        return self.controller.once()

    def only_record(self):
        return self.controller.ledger.records()[0]

    def options_fixture(self):
        options = [option("cx23", 8800), option("cx33", 13600), option("cpx22", 26400), option("ccx13", 58500)]
        self.controller.config["machine_options"] = options
        self.cloud.types = [machine(114, "cx23", False), machine(115, "cx33", False), machine(120, "cpx22"), machine(121, "ccx13")]
        self.cloud.price["pricing"]["server_types"] = [dict(id=m["id"], prices=[dict(location="hel1", included_traffic=20 * 1024 ** 4,
            price_hourly={"net": f'{o["server_hourly_ceiling_micro_eur"] / 1000000:.6f}'})]) for m, o in zip(self.cloud.types, options)]

    def ready(self):
        for _ in range(4):
            self.tick()
        self.assertEqual(self.only_record()["state"], "ready")

    def test_disabled_default_and_invalid_limits(self):
        self.assertFalse(validate_config(dict(self.config, enabled=False))["enabled"])
        with self.assertRaisesRegex(SafetyError, "authorization_limits_required"):
            validate_config(dict(self.config, monthly_budget_micro_eur=0))
        with self.assertRaisesRegex(SafetyError, "unapproved_machine"):
            validate_config(dict(self.config, image="ubuntu-22.04"))

    def test_options_are_explicit_unique_bounded_and_one_location(self):
        for choices in ([], [option("cx23", 8800)] * 2, [option(f"cx{i}", 8800) for i in range(5)],
                        [dict(option("cx23", 8800), location="fsn1")], [dict(option("cx23", 8800), extra=True)]):
            with self.assertRaises(SafetyError):
                validate_config(dict(self.config, machine_options=choices))

    def test_selects_cheapest_available_actual_price_and_persists_before_create(self):
        self.options_fixture()
        original_create = self.cloud.create
        def inspect_create(name, labels, user_data, selected):
            durable = next(r for r in self.controller.ledger.records() if r["id"] == labels["fetchx-worker"])
            self.assertEqual(durable["machine"], selected)
            self.assertEqual(durable["state"], "creating")
            return original_create(name, labels, user_data, selected)
        self.cloud.create = inspect_create
        self.tick()
        selected = self.only_record()["machine"]
        self.assertEqual(selected["server_type"], "cpx22")
        self.assertEqual(selected["type_id"], 120)
        self.assertEqual(self.only_record()["rate"], 27200)
        self.assertEqual(self.only_record()["reservation"], 81600)
        # Selection ranks live cost, rather than configured order or ceilings.
        self.cloud.price["pricing"]["server_types"][3]["prices"][0]["price_hourly"]["net"] = "0.020000"
        cheaper = select_machine(self.cloud.server_types(), self.cloud.price, self.controller.config, {}, self.now)
        self.assertEqual(cheaper["server_type"], "ccx13")
        self.assertEqual(cheaper["server_hourly_ceiling_micro_eur"], 58500)

    def test_selected_options_share_budget_and_instance_cap(self):
        self.options_fixture()
        self.controller.config["monthly_budget_micro_eur"] = 200000
        self.ready()
        self.cloud.types[2]["locations"][0]["available"] = False
        result = self.tick()
        self.assertEqual(result["last_decision"]["code"], "budget_cap")
        self.assertEqual(self.cloud.calls.count("create"), 1)
        self.assertEqual(result["committed_micro_eur"], 81600)
        self.controller.config["monthly_budget_micro_eur"] = 1000000
        self.controller.config["max_additional_workers"] = 1
        result = self.tick()
        self.assertEqual(result["last_decision"]["code"], "resource_cap")

    def test_over_ceiling_or_insufficient_resources_skip_only_that_option(self):
        self.options_fixture()
        self.cloud.price["pricing"]["server_types"][2]["prices"][0]["price_hourly"]["net"] = "0.026401"
        self.tick()
        self.assertEqual(self.only_record()["machine"]["server_type"], "ccx13")

    def test_minimum_resources_and_architecture_are_required(self):
        for field, invalid in (("cores", 1), ("memory", 2), ("disk", 20), ("architecture", "arm")):
            with self.subTest(field=field):
                self.options_fixture()
                self.cloud.types[2][field] = invalid
                selected = select_machine(
                    self.cloud.server_types(), self.cloud.price, self.controller.config, {}, self.now)
                self.assertEqual(selected["server_type"], "ccx13")

    def test_definitive_placement_failure_cools_only_selected_type_across_restart(self):
        self.options_fixture()
        self.controller.config["cooldown_seconds"] = 120
        self.controller.config["scale_up_delay_seconds"] = 10
        self.cloud.create_error = CloudError("cloud_http_error", 422, "placement_error")
        self.tick()
        self.tick(10)
        self.assertEqual(self.only_record()["state"], "cancelled")
        self.assertGreater(self.controller.ledger.meta("machine_cooldowns")["cpx22@hel1"], self.now)
        self.assertEqual(self.controller.ledger.meta("last_create_at"), 0)
        self.config = dict(self.controller.config)
        self.controller.close()
        self.controller = self.make_controller()
        self.cloud.create_error = None
        self.tick()
        self.assertEqual([m["server_type"] for m in self.cloud.created_machines], ["cpx22", "ccx13"])
        self.assertEqual(self.cloud.calls.count("create"), 2)

    def test_uncertain_selected_create_never_falls_back(self):
        self.options_fixture()
        self.cloud.create_error = UncertainCreate("create_uncertain")
        self.tick()
        identity = self.only_record()["id"]
        self.cloud.servers.clear()
        self.cloud.ips.clear()
        self.cloud.create_error = None
        for _ in range(3):
            self.tick(200)
        self.assertEqual(self.cloud.calls.count("create"), 1)
        self.assertEqual(self.only_record()["state"], "uncertain")
        self.assertEqual(self.only_record()["id"], identity)
        self.assertEqual(self.only_record()["machine"]["server_type"], "cpx22")
        self.assertEqual(self.controller.status()["committed_micro_eur"], 81600)

    def test_full_lifetime_reservation_and_resource_cap_include_booting(self):
        self.tick()
        record = self.only_record()
        self.assertEqual(record["reservation"], 28800)
        self.assertEqual(record["state"], "booting")
        self.tick()
        self.assertEqual(self.cloud.calls.count("create"), 1)
        self.controller.config["max_additional_workers"] = 1
        self.ready()
        self.assertEqual(self.cloud.calls.count("create"), 1)
        self.assertEqual(self.controller.status()["last_decision"]["code"], "resource_cap")

    def test_budget_cap_before_post(self):
        self.controller.config["monthly_budget_micro_eur"] = 28799
        result = self.tick()
        self.assertNotIn("create", self.cloud.calls)
        self.assertEqual(result["last_decision"]["code"], "budget_cap")

    def test_gateway_global_concurrency_cap_prevents_unusable_paid_capacity(self):
        self.global_limit = 1
        result = self.tick()
        self.assertNotIn("create", self.cloud.calls)
        self.assertEqual(result["last_decision"]["code"], "gateway_capacity_cap")
        self.global_limit = 2
        self.tick()
        self.assertEqual(self.only_record()["state"], "booting")
        self.tick()
        self.assertEqual(self.cloud.calls.count("create"), 1)

    def test_growth_requires_sustained_pressure_and_obeys_cooldown(self):
        self.controller.config["scale_up_delay_seconds"] = 10
        self.controller.config["cooldown_seconds"] = 60
        self.tick()
        self.tick(9)
        self.assertNotIn("create", self.cloud.calls)
        self.tick(1)
        self.assertEqual(self.cloud.calls.count("create"), 1)
        self.ready()
        self.tick(10)
        self.assertEqual(self.cloud.calls.count("create"), 1)
        self.tick(50)
        self.assertEqual(self.cloud.calls.count("create"), 2)

    def test_status_is_read_only_while_instance_lock_is_held(self):
        self.tick()
        ledger = Ledger(self.config, read_only=True)
        try:
            self.assertEqual(ledger.committed(self.now), self.only_record()["reservation"])
            with self.assertRaises(Exception):
                ledger.set_meta("must_not_write", True)
        finally:
            ledger.close()

    def test_live_price_caps_currency_and_integer_rounding(self):
        self.assertEqual(micro_eur("0.00880001"), 8801)
        for price in (prices(server="0.0089"), prices(ipv4="0.000801"), prices(currency="USD")):
            self.cloud.price = price
            self.tick()
            self.assertNotIn("create", self.cloud.calls)
        with self.assertRaisesRegex(SafetyError, "included_traffic"):
            c = dict(self.config, max_vm_egress_bytes=30 * 1024 ** 4)
            approved_prices(prices(), c, 114)

    def test_no_capacity_or_wrong_machine_mapping_fails_closed(self):
        self.cloud.capacity = False
        result = self.tick()
        self.assertNotIn("create", self.cloud.calls)
        self.assertEqual(result["last_decision"]["code"], "no_eligible_machine")
        self.cloud.capacity = True
        self.cloud.price["pricing"]["server_types"][0]["id"] = 999
        result = self.tick()
        self.assertNotIn("create", self.cloud.calls)
        self.assertEqual(result["last_decision"]["code"], "no_eligible_machine")

    def test_month_boundary_retains_uncertain_liability(self):
        self.now = epoch("2026-11-30T23:59:59Z")
        self.cloud.create_error = UncertainCreate("create_uncertain")
        self.tick(0)
        self.cloud.servers.clear()
        self.cloud.ips.clear()
        reserved = self.only_record()["reservation"]
        self.now = epoch("2026-12-01T00:00:01Z")
        result = self.tick(0)
        self.assertEqual(result["committed_micro_eur"], reserved)
        self.assertEqual(result["month_utc"], "2026-12")
        self.assertEqual(self.cloud.calls.count("create"), 1)
        self.now += 86400
        result = self.tick(0)
        self.assertGreater(result["committed_micro_eur"], reserved)
        charges = dict(self.controller.ledger.db.execute("SELECT month,amount FROM charges"))
        self.assertEqual(charges["2026-11"], 9600)
        self.assertGreater(charges["2026-12"], 9600)

    def test_uncertain_post_reconciles_by_owned_labels_never_reposts(self):
        self.controller.config["max_additional_workers"] = 1
        self.cloud.create_error = UncertainCreate("create_uncertain")
        self.tick()
        self.assertEqual(self.only_record()["state"], "uncertain")
        self.ready()
        self.assertEqual(self.cloud.calls.count("create"), 1)
        self.assertEqual(self.only_record()["server_id"], 1)

    def test_definitive_capacity_rejection_releases_reservation(self):
        self.cloud.create_error = CloudError("cloud_http_error", 422)
        result = self.tick()
        self.assertEqual(self.only_record()["state"], "cancelled")
        self.assertEqual(result["committed_micro_eur"], 0)

    def test_stale_metrics_and_api_error_prevent_growth(self):
        self.stale = True
        self.tick()
        self.assertNotIn("create", self.cloud.calls)
        self.stale = False
        self.cloud.unavailable = True
        self.tick()
        self.assertNotIn("create", self.cloud.calls)

    def test_inventory_delay_accepts_current_metrics_and_starts_current_lease(self):
        inventory = self.cloud.inventory
        def delayed_inventory():
            self.now += 3
            return inventory()
        self.cloud.inventory = delayed_inventory
        result = self.tick()
        self.assertEqual(result["last_decision"]["code"], "server_created")
        self.assertEqual(self.cloud.calls.count("create"), 1)
        self.assertEqual(self.only_record()["created_at"], self.now)

    def test_metrics_read_delay_accepts_current_metrics(self):
        def delayed_metrics():
            self.now += 3
            return self.metrics()
        self.controller.metrics = delayed_metrics
        result = self.tick()
        self.assertEqual(result["last_decision"]["code"], "server_created")

    def test_delayed_reads_still_reject_stale_and_future_metrics(self):
        for offset in (-100, 3):
            with self.subTest(offset=offset):
                def invalid_metrics():
                    self.now += 3
                    value = self.metrics()
                    value["generated_at"] = dt.datetime.fromtimestamp(self.now + offset, dt.timezone.utc).isoformat()
                    return value
                self.controller.metrics = invalid_metrics
                result = self.tick()
                self.assertEqual(result["last_decision"]["code"], "metrics_stale")
                self.assertEqual(result["last_decision"]["at"], self.now)
                self.assertNotIn("create", self.cloud.calls)

    def test_inventory_delay_reconciles_current_hard_lifetime(self):
        self.ready()
        record = self.only_record()
        self.now = record["lease_expires_at"] + self.config["hard_delete_grace_seconds"] - 1
        inventory = self.cloud.inventory
        def delayed_inventory():
            self.now += 3
            return inventory()
        self.cloud.inventory = delayed_inventory
        self.tick(0)
        self.assertIn("delete_server", self.cloud.calls)
        self.assertEqual(self.only_record()["state"], "deleting")

    def test_pricing_delay_starts_lease_after_read_and_accrues_through_create(self):
        pricing, create = self.cloud.pricing, self.cloud.create
        def delayed_pricing():
            self.now += 3
            return pricing()
        def delayed_create(*args):
            self.now += 3601
            return create(*args)
        self.cloud.pricing = delayed_pricing
        self.cloud.create = delayed_create
        started = self.now
        result = self.tick()
        self.assertEqual(self.only_record()["created_at"], started + 4)
        # Full lifetime reservation plus the second billed hour has accrued.
        charges = dict(self.controller.ledger.db.execute("SELECT month,amount FROM charges"))
        self.assertEqual(charges["2026-11"], 19200)
        self.assertGreaterEqual(result["committed_micro_eur"], self.only_record()["reservation"])

    def test_pricing_delay_that_expires_metrics_prevents_reservation(self):
        pricing = self.cloud.pricing
        def delayed_pricing():
            self.now += self.config["metrics_max_age_seconds"] + 1
            return pricing()
        self.cloud.pricing = delayed_pricing
        result = self.tick()
        self.assertEqual(result["last_decision"]["code"], "metrics_stale")
        self.assertEqual(self.controller.ledger.records(), [])
        self.assertNotIn("create", self.cloud.calls)

    def test_busy_drain_then_confirm_server_and_ipv4_deletion(self):
        self.ready()
        self.controller.config["max_additional_workers"] = 1
        record = self.only_record()
        self.now = record["lease_expires_at"] - 90
        self.tick(0)
        self.assertEqual(self.only_record()["state"], "draining")
        self.assertNotIn("delete_server", self.cloud.calls)
        self.stale = True
        self.busy[record["id"]] = False
        self.tick()
        self.assertNotIn("delete_server", self.cloud.calls)
        self.stale = False
        self.tick()
        self.assertIn("delete_server", self.cloud.calls)
        self.assertEqual(self.only_record()["state"], "deleting")
        self.pressure = False
        self.cloud.leak = True
        result = self.tick()
        self.assertIn("delete_ipv4", self.cloud.calls)
        self.assertGreater(result["committed_micro_eur"], 0)
        self.assertEqual(self.only_record()["state"], "deleting")
        self.cloud.leak = False
        self.tick()
        self.tick()
        self.assertEqual(self.only_record()["state"], "deleted")
        self.assertGreaterEqual(self.cloud.calls.count("server_get"), 3)
        self.assertGreaterEqual(self.cloud.calls.count("ipv4_get"), 3)
        rows = json.loads((self.path / "registry.json").read_text())
        self.assertEqual(rows, [dict(id="base", state="active", socket_path="/base.sock")])

    def test_idle_scale_down_needs_drain_observation(self):
        self.ready()
        self.pressure = False
        self.tick()
        self.tick(20)
        self.assertEqual(self.only_record()["state"], "draining")
        self.assertNotIn("delete_server", self.cloud.calls)
        self.tick()
        self.assertIn("delete_server", self.cloud.calls)

    def test_hard_lifetime_deletes_owned_vm_despite_missing_busy_metrics(self):
        self.controller.config["max_additional_workers"] = 1
        self.ready()
        record = self.only_record()
        def unavailable():
            raise OSError("synthetic metrics unavailable")
        self.controller.metrics = unavailable
        self.now = record["lease_expires_at"] - 90
        self.tick(0)
        self.assertEqual(self.only_record()["state"], "draining")
        self.assertNotIn("delete_server", self.cloud.calls)
        self.now = record["lease_expires_at"] + 59
        self.tick(0)
        self.assertNotIn("delete_server", self.cloud.calls)
        self.tick(1)
        self.assertIn("delete_server", self.cloud.calls)
        self.tick()
        self.tick()
        self.assertEqual(self.only_record()["state"], "deleted")

    def test_stray_owned_resource_blocks_growth_but_known_worker_cleanup_continues(self):
        self.ready()
        record = self.only_record()
        self.cloud.servers.append(dict(id=999, name="stray", labels={"fetchx-deployment": "test", "fetchx-worker": "missing"}))
        self.now = record["lease_expires_at"] + 60
        result = self.tick(0)
        self.assertEqual(result["last_decision"]["code"], "unknown_or_duplicate_owned_server")
        self.assertEqual(self.cloud.calls.count("create"), 1)
        self.assertEqual([s["id"] for s in self.cloud.servers], [999])
        self.tick()
        self.tick()
        self.assertEqual(self.only_record()["state"], "deleted")

    def test_foreign_ip_owner_is_preserved_even_after_server_expires(self):
        self.ready()
        record = self.only_record()
        self.cloud.ips[0]["labels"] = {"fetchx-deployment": "foreign", "fetchx-worker": "other"}
        self.now = record["lease_expires_at"] + 60
        self.tick(0)
        self.tick()
        self.assertEqual(len(self.cloud.ips), 1)
        self.assertNotIn("delete_ipv4", self.cloud.calls)
        self.assertEqual(self.only_record()["state"], "deleting")

    def test_unknown_owned_resources_fail_closed_and_unowned_are_preserved(self):
        self.cloud.servers.append(dict(id=999, name="unowned", labels={}))
        self.tick()
        self.assertEqual(self.cloud.calls.count("create"), 1)
        self.cloud.servers.append(dict(id=1000, name="orphan", labels={"fetchx-deployment": "test", "fetchx-worker": "missing"}))
        result = self.tick()
        self.assertEqual(result["last_decision"]["code"], "unknown_or_duplicate_owned_server")
        self.assertNotIn("delete_server", self.cloud.calls)
        self.assertEqual(self.cloud.servers[0]["id"], 999)

    def test_duplicate_controller_and_restart_bootstrap(self):
        self.config["max_additional_workers"] = 1
        self.controller.config["max_additional_workers"] = 1
        with self.assertRaisesRegex(SafetyError, "already_running"):
            self.make_controller()
        self.tick()
        self.controller.close()
        self.controller = self.make_controller()
        self.ready()
        self.assertEqual(self.cloud.calls.count("create"), 1)
        self.assertEqual(len(self.driver.bootstraps), 1)

    def test_pending_bootstrap_does_not_block_cost_or_lifetime_cleanup(self):
        self.controller.close()
        waiting = Future()
        self.controller = self.make_controller(submit=lambda *_: waiting)
        self.tick()
        self.tick()
        self.tick()
        self.assertEqual(self.only_record()["state"], "booting")
        identity = self.only_record()["id"]
        self.tick(301)
        self.assertIn("delete_server", self.cloud.calls)
        self.assertEqual(next(r for r in self.controller.ledger.records() if r["id"] == identity)["state"], "deleting")
        waiting.set_result({"socket_path": "/run/fx/registry/late.sock"})
        self.tick()
        self.assertEqual(json.loads((self.path / "registry.json").read_text())[0]["id"], "base")

    def test_late_bootstrap_result_never_publishes_expired_worker(self):
        self.controller.close()
        waiting = Future()
        self.controller = self.make_controller(submit=lambda *_: waiting)
        self.tick()
        self.tick()
        self.tick()
        record = self.only_record()
        self.now = record["lease_expires_at"]
        waiting.set_result({"socket_path": "/run/fx/registry/late.sock"})
        self.tick(0)
        self.assertNotEqual(self.only_record()["state"], "ready")
        rows = json.loads((self.path / "registry.json").read_text())
        self.assertEqual([r["id"] for r in rows], ["base"])

    def test_lease_renewal_runs_in_background_and_cannot_extend_hard_lifetime(self):
        self.controller.config["max_additional_workers"] = 1
        self.ready()
        original_deadline = self.only_record()["lease_expires_at"]
        self.tick(60)
        self.assertEqual(self.driver.renewals, [self.only_record()["id"]])
        self.assertIn((self.only_record()["id"], "renew"), self.controller.futures)
        self.tick()
        self.assertEqual(self.only_record()["lease_expires_at"], original_deadline)

    def test_unhealthy_drain_threshold_is_positive_and_defaults_to_30(self):
        self.assertEqual(self.config['unhealthy_drain_seconds'], 30)
        for invalid in (0, -1, True, '30'):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(SafetyError, 'invalid_unhealthy_drain_seconds'):
                validate_config(dict(self.config, unhealthy_drain_seconds=invalid))

    def unhealthy_ready(self):
        self.controller.config['max_additional_workers'] = 1
        self.ready()
        identity = self.only_record()['id']
        self.worker_ready[identity] = False
        self.tick()
        return identity

    def test_brief_unhealthy_probe_recovers_without_drain(self):
        identity = self.unhealthy_ready()
        self.tick(29)
        self.assertEqual(self.only_record()['state'], 'ready')
        self.worker_ready[identity] = True
        self.tick()
        self.assertEqual(self.only_record()['state'], 'ready')
        self.assertNotIn('unhealthy_since', self.only_record())
        self.assertNotIn('delete_server', self.cloud.calls)

    def test_stale_metrics_do_not_extend_unhealthy_evidence(self):
        self.unhealthy_ready()
        self.stale = True
        self.tick(100)
        self.assertEqual(self.only_record()['state'], 'ready')
        self.stale = False
        self.tick()
        self.assertEqual(self.only_record()['state'], 'ready')
        self.tick(29)
        self.assertEqual(self.only_record()['state'], 'ready')
        self.tick(1)
        self.assertEqual(self.only_record()['state'], 'draining')

    def test_sustained_unhealthy_drains_before_renew_and_replaces_with_shared_liabilities(self):
        identity = self.unhealthy_ready()
        self.controller.config['max_additional_workers'] = 2
        record = self.only_record()
        record['last_renewed_at'] = self.now - 60
        self.controller.ledger.save(record)
        renewals = len(self.driver.renewals)
        self.tick(30)
        self.assertEqual(self.only_record()['state'], 'draining')
        self.assertEqual(len(self.driver.renewals), renewals)
        self.assertNotIn('delete_server', self.cloud.calls)
        result = self.tick()
        records = self.controller.ledger.records()
        self.assertEqual(self.cloud.calls.count('create'), 2)
        self.assertEqual(next(r for r in records if r['id'] == identity)['state'], 'draining')
        self.assertEqual(result['committed_micro_eur'], sum(r['reservation'] for r in records))
        self.tick()
        self.assertEqual(self.cloud.calls.count('create'), 2)

    def test_draining_liabilities_keep_resource_and_budget_caps(self):
        self.unhealthy_ready()
        self.tick(30)
        result = self.tick()
        self.assertEqual(result['last_decision']['code'], 'resource_cap')
        self.assertEqual(self.cloud.calls.count('create'), 1)
        self.controller.config['max_additional_workers'] = 2
        self.controller.config['monthly_budget_micro_eur'] = self.only_record()['reservation'] * 2 - 1
        result = self.tick()
        self.assertEqual(result['last_decision']['code'], 'budget_cap')
        self.assertEqual(self.cloud.calls.count('create'), 1)

    def test_unhealthy_drain_cleanup_waits_for_lease_and_grace_without_metrics(self):
        self.unhealthy_ready()
        self.tick(30)
        drained = self.only_record()
        self.stale = True
        self.now = drained['drain_at'] + self.config['worker_lease_seconds'] + self.config['hard_delete_grace_seconds'] - 1
        self.tick(0)
        self.assertNotIn('delete_server', self.cloud.calls)
        self.tick(1)
        self.assertIn('delete_server', self.cloud.calls)
        self.assertIn('server_get', self.cloud.calls)
        self.assertEqual(self.only_record()['state'], 'deleting')
        self.tick()
        self.tick()
        self.assertEqual(self.only_record()['state'], 'deleted')
        self.assertIn('ipv4_get', self.cloud.calls)
        self.assertEqual(self.cloud.calls.count('create'), 1)

    def test_unhealthy_drain_prefers_fresh_healthy_idle_observation(self):
        identity = self.unhealthy_ready()
        self.tick(30)
        self.worker_ready[identity] = True
        self.busy[identity] = False
        self.tick()
        self.assertIn('delete_server', self.cloud.calls)
        self.assertLess(self.now, self.only_record()['drain_at'] + self.config['worker_lease_seconds'])

    def test_unhealthy_idle_metrics_require_lease_before_forced_cleanup(self):
        identity = self.unhealthy_ready()
        self.tick(30)
        self.busy[identity] = False
        self.tick()
        self.assertNotIn('delete_server', self.cloud.calls)
        self.now = self.only_record()['drain_at'] + self.config['worker_lease_seconds'] + self.config['hard_delete_grace_seconds']
        self.tick(0)
        self.assertIn('delete_server', self.cloud.calls)
        self.assertEqual(self.cloud.calls.count('create'), 1)

    def test_fresh_healthy_busy_drain_keeps_inflight_work(self):
        identity = self.unhealthy_ready()
        self.tick(30)
        self.worker_ready[identity] = True
        self.now = self.only_record()['drain_at'] + self.config['worker_lease_seconds'] + self.config['hard_delete_grace_seconds']
        self.tick(0)
        self.assertEqual(self.only_record()['state'], 'draining')
        self.assertNotIn('delete_server', self.cloud.calls)

    def test_missing_and_corrupt_state_fail_closed(self):
        self.controller.close()
        ledger = self.path / "infrastructure.sqlite3"
        ledger.unlink()
        with self.assertRaisesRegex(SafetyError, "ledger_missing"):
            self.make_controller()
        ledger.write_bytes(b"not sqlite")
        ledger.chmod(0o600)
        with self.assertRaisesRegex(SafetyError, "ledger_corrupt"):
            self.make_controller()

    def test_monthly_cost_rounds_each_utc_month_without_float_money(self):
        costs = monthly_costs(epoch("2026-12-31T23:59:59Z"), epoch("2027-01-01T00:00:01Z"), 9600)
        self.assertEqual(costs, {"2026-12": 9600, "2027-01": 9600})


if __name__ == "__main__":
    unittest.main()
