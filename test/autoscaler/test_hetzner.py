import io
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
        client.create("fx-test-id", {"owned": "synthetic"}, "#cloud-config", {"server_type": "cpx22", "location": "hel1"})
        req = opener.requests[0]
        self.assertEqual(req.full_url, "https://api.hetzner.cloud/v1/servers")
        self.assertEqual(req.method, "POST")
        data = json.loads(req.data)
        self.assertEqual(data["server_type"], "cpx22")
        self.assertEqual(data["location"], "hel1")
        self.assertEqual(data["image"], "ubuntu-24.04")
        self.assertEqual(data["public_net"], {"enable_ipv4": True, "enable_ipv6": False})
        for field in ("volumes", "backups", "networks", "ssh_keys"):
            self.assertNotIn(field, data)

    def test_create_timeout_and_http_errors(self):
        errors = [TimeoutError()] + [urllib.error.HTTPError("https://example.invalid", code, "secret-body", {}, None) for code in (408, 409, 429, 500, 503)]
        for error in errors:
            client, opener = self.client([error])
            with self.assertRaises(UncertainCreate) as caught:
                client.create("fx-test-id", {}, "synthetic", {"server_type": "cx23", "location": "hel1"})
            self.assertEqual(len(opener.requests), 1)
            self.assertNotIn("secret", str(caught.exception))
        client, _ = self.client([urllib.error.HTTPError("https://example.invalid", 422, "secret", {}, None)])
        with self.assertRaises(CloudError) as caught:
            client.create("fx-test-id", {}, "synthetic", {"server_type": "cx23", "location": "hel1"})
        self.assertEqual(caught.exception.status, 422)
        self.assertNotIsInstance(caught.exception, UncertainCreate)

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
                client.create("fx-test-id", {}, "synthetic", {"server_type": "cpx22", "location": "hel1"})
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
