import io
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import urllib.error

from ops.autoscaler.core import SafetyError
from ops.autoscaler.hetzner import CloudError, Hetzner, NoRedirects, UncertainCreate


class Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


class FakeOpener:
    def __init__(self, responses):
        self.responses, self.requests = list(responses), []

    def open(self, req, timeout):
        self.requests.append(req)
        item = self.responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return Response(json.dumps(item).encode())


class HetznerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.token = Path(self.temp.name) / "token"
        self.token.write_text("synthetic-token")
        self.token.chmod(0o600)

    def client(self, items):
        opener = FakeOpener(items)
        return Hetzner(str(self.token), opener=opener), opener

    def test_create_payload_exact_machine_no_paid_extras(self):
        client, opener = self.client([{"server": {"id": 1}}])
        client.create("fx-test-id", {"owned": "synthetic"}, "#cloud-config", {"server_type": "cpx22", "location": "hel1"}, 42)
        req = opener.requests[0]
        self.assertEqual(req.full_url, "https://api.hetzner.cloud/v1/servers")
        self.assertEqual(req.method, "POST")
        data = json.loads(req.data)
        self.assertEqual(data["server_type"], "cpx22")
        self.assertEqual(data["location"], "hel1")
        self.assertEqual(data["image"], "ubuntu-24.04")
        self.assertEqual(data["public_net"], {"enable_ipv4": True, "enable_ipv6": False})
        self.assertEqual(data["ssh_keys"], ["42"])
        for field in ("volumes", "backups", "networks", "root_password"):
            self.assertNotIn(field, data)

    def test_create_from_a_snapshot_takes_only_an_image_id(self):
        client, opener = self.client([{"server": {"id": 1}}])
        client.create("fx-test-id", {"owned": "synthetic"}, "#cloud-config", {"server_type": "cx23", "location": "hel1"}, 42, image=900)
        self.assertEqual(json.loads(opener.requests[0].data)["image"], 900)
        for image in ("ubuntu-22.04", "900", 0, True, None):
            with self.assertRaisesRegex(SafetyError, "cloud_image_invalid"):
                client.create("fx-test-id", {}, "#cloud-config", {"server_type": "cx23", "location": "hel1"}, 42, image=image)
        self.assertEqual(len(opener.requests), 1)

    def test_snapshot_requests_are_scoped_to_one_server_and_this_deployment(self):
        labels = {"fetchx-deployment": "test", "fetchx-role": "worker-snapshot"}
        client, opener = self.client([{"image": {"id": 900, "status": "creating"}, "action": {"id": 1}},
                                      {"images": [{"id": 900}], "meta": {"pagination": {"next_page": 2}}},
                                      {"images": [{"id": 901}], "meta": {"pagination": {"next_page": None}}},
                                      {}])
        self.assertEqual(client.create_snapshot(7, "fetchx worker", labels)["id"], 900)
        req = opener.requests[0]
        self.assertEqual((req.method, req.full_url), ("POST", "https://api.hetzner.cloud/v1/servers/7/actions/create_image"))
        self.assertEqual(json.loads(req.data), {"type": "snapshot", "description": "fetchx worker", "labels": labels})
        self.assertEqual([i["id"] for i in client.snapshots("test")], [900, 901])
        self.assertEqual(opener.requests[1].full_url,
                         "https://api.hetzner.cloud/v1/images?type=snapshot&label_selector=fetchx-deployment%3Dtest&per_page=50&page=1")
        client.delete_image(900)
        self.assertEqual((opener.requests[3].method, opener.requests[3].full_url), ("DELETE", "https://api.hetzner.cloud/v1/images/900"))
        with self.assertRaisesRegex(SafetyError, "cloud_server_id_invalid"):
            client.create_snapshot("7", "x", labels)
        with self.assertRaisesRegex(SafetyError, "cloud_snapshot_deployment_invalid"):
            client.snapshots("test&type=system")

    def test_snapshot_post_without_an_image_is_uncertain(self):
        client, _ = self.client([{"action": {"id": 1}}, urllib.error.URLError("synthetic")])
        for _ in range(2):
            with self.assertRaises(UncertainCreate):
                client.create_snapshot(7, "fetchx worker", {})

    def test_create_timeout_and_http_errors(self):
        errors = [TimeoutError()] + [urllib.error.HTTPError("https://example.invalid", code, "secret-body", {}, None) for code in (408, 409, 429, 500, 503)]
        for error in errors:
            client, opener = self.client([error])
            with self.assertRaises(UncertainCreate) as caught:
                client.create("fx-test-id", {}, "synthetic", {"server_type": "cx23", "location": "hel1"}, 42)
            self.assertEqual(len(opener.requests), 1)
            self.assertNotIn("secret", str(caught.exception))
        client, _ = self.client([urllib.error.HTTPError("https://example.invalid", 422, "secret", {}, None)])
        with self.assertRaises(CloudError) as caught:
            client.create("fx-test-id", {}, "synthetic", {"server_type": "cx23", "location": "hel1"}, 42)
        self.assertEqual(caught.exception.status, 422)
        self.assertNotIsInstance(caught.exception, UncertainCreate)

    def test_registered_ssh_key_is_required_before_server_post(self):
        for invalid in (None, 0, -1, True, "42", 9007199254740992):
            client, opener = self.client([])
            with self.subTest(invalid=invalid), self.assertRaisesRegex(SafetyError, "ssh_key_id_invalid"):
                client.create("fx-test-id", {}, "synthetic", {"server_type": "cx23", "location": "hel1"}, invalid)
            self.assertEqual(opener.requests, [])

    def key_name(self, public="ssh-ed25519 cHVibGlj", deployment="test"):
        return "fx-" + deployment + "-admin-" + hashlib.sha256(public.encode()).hexdigest()[:24]

    def test_ssh_key_reuses_exact_identity_from_paginated_inventory_without_mutation(self):
        unrelated = {"id": 2, "name": "unrelated", "public_key": "ssh-ed25519 b3RoZXI="}
        existing = {"id": 42, "name": "existing-admin", "public_key": "ssh-ed25519 cHVibGlj old-comment", "labels": {"preserve": "yes"}}
        client, opener = self.client([{"ssh_keys": [unrelated], "meta": {"pagination": {"next_page": 2}}},
                                      {"ssh_keys": [existing]}])
        self.assertEqual(client.ensure_ssh_key("test", "ssh-ed25519 cHVibGlj new-comment"), 42)
        self.assertEqual([req.method for req in opener.requests], ["GET", "GET"])
        self.assertIn("page=2", opener.requests[1].full_url)
        self.assertEqual(existing["labels"], {"preserve": "yes"})

    def test_ssh_key_creation_uses_canonical_public_and_deterministic_project_name(self):
        name = self.key_name()
        client, opener = self.client([{"ssh_keys": []}, {"ssh_key": {"id": 42, "name": name, "public_key": "ssh-ed25519 cHVibGlj"}}])
        self.assertEqual(client.ensure_ssh_key("test", "ssh-ed25519 cHVibGlj controller-comment\n"), 42)
        self.assertEqual([req.method for req in opener.requests], ["GET", "POST"])
        self.assertEqual(opener.requests[1].full_url, "https://api.hetzner.cloud/v1/ssh_keys")
        self.assertEqual(json.loads(opener.requests[1].data), {"name": name, "public_key": "ssh-ed25519 cHVibGlj",
                         "labels": {"fetchx-deployment": "test", "fetchx-role": "controller-admin"}})
        self.assertNotEqual(name, self.key_name(deployment="another"))

    def test_ssh_key_name_collision_never_overwrites_or_creates(self):
        client, opener = self.client([{"ssh_keys": [{"id": 42, "name": self.key_name(), "public_key": "ssh-ed25519 b3RoZXI="}]}])
        with self.assertRaisesRegex(CloudError, "ssh_key_name_collision"):
            client.ensure_ssh_key("test", "ssh-ed25519 cHVibGlj")
        self.assertEqual([req.method for req in opener.requests], ["GET"])

    def test_uncertain_ssh_key_post_reconciles_by_inventory_without_second_post(self):
        existing = {"id": 42, "name": self.key_name(), "public_key": "ssh-ed25519 cHVibGlj"}
        client, opener = self.client([{"ssh_keys": []}, TimeoutError(), {"ssh_keys": [existing]}])
        with self.assertRaises(UncertainCreate):
            client.ensure_ssh_key("test", existing["public_key"])
        self.assertEqual(client.ensure_ssh_key("test", existing["public_key"]), 42)
        self.assertEqual([req.method for req in opener.requests], ["GET", "POST", "GET"])

    def test_ssh_key_invalid_response_never_returns_an_identity(self):
        for key in ({"id": True, "name": self.key_name(), "public_key": "ssh-ed25519 cHVibGlj"},
                    {"id": 42, "name": self.key_name(), "public_key": "ssh-ed25519 b3RoZXI="}, {}):
            client, opener = self.client([{"ssh_keys": []}, {"ssh_key": key}])
            with self.subTest(key=key), self.assertRaisesRegex(CloudError, "ssh_key_invalid"):
                client.ensure_ssh_key("test", "ssh-ed25519 cHVibGlj")
            self.assertEqual(len(opener.requests), 2)

    def test_inventory_pagination_and_explicit_404_confirmation(self):
        client, opener = self.client([{"servers": [{"id": 1}], "meta": {"pagination": {"next_page": 2}}},
            {"servers": [{"id": 2}]}, {"primary_ips": []},
            urllib.error.HTTPError("https://example.invalid", 404, "absent", {}, None)])
        servers, ips = client.inventory()
        self.assertEqual(servers, [{"id": 1}, {"id": 2}])
        self.assertEqual(ips, [])
        self.assertIsNone(client.server(1))
        self.assertIn("page=2", opener.requests[1].full_url)

    def test_server_type_inventory_is_paginated_without_hardcoded_name(self):
        client, opener = self.client([{"server_types": [{"id": 114, "name": "cx23"}], "meta": {"pagination": {"next_page": 2}}},
                                     {"server_types": [{"id": 120, "name": "cpx22"}]}])
        result = client.server_types()
        self.assertEqual([m["id"] for m in result["server_types"]], [114, 120])
        self.assertNotIn("name=", opener.requests[0].full_url)
        self.assertIn("page=2", opener.requests[1].full_url)

    def test_only_official_definite_capacity_codes_allow_type_cooldown(self):
        for status, code, expected in ((422, "placement_error", "placement_error"),
                                       (412, "resource_unavailable", "resource_unavailable"),
                                       (422, "secret-value", None), (422, "resource_unavailable", None)):
            body = io.BytesIO(json.dumps({"error": {"code": code, "message": "never-log-this-secret"}}).encode())
            client, _ = self.client([urllib.error.HTTPError("https://example.invalid", status, "error", {}, body)])
            with self.assertRaises(CloudError) as caught:
                client.create("fx-test-id", {}, "synthetic", {"server_type": "cpx22", "location": "hel1"}, 42)
            self.assertEqual(caught.exception.provider_code, expected)
            self.assertNotIn("secret", str(caught.exception))

    def test_token_permissions_and_no_redirects(self):
        self.token.chmod(0o644)
        with self.assertRaisesRegex(SafetyError, "token_permissions"):
            self.client([])
        with self.assertRaisesRegex(CloudError, "redirect_refused"):
            NoRedirects().redirect_request(None, None, 302, "redirect", {}, "https://other.invalid")


if __name__ == "__main__":
    unittest.main()
