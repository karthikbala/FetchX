"""Offline checks for Connect in the Python SDK (clients/python-sdk/src/fetchx/_connect.py).

Run from the repository root with a Python that has httpx:
    python -m unittest discover -s test -p '*_test.py'
"""
import contextlib
import io
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "clients" / "python-sdk" / "src"))

import fetchx._connect as connect_module  # noqa: E402
from fetchx import (ConnectError, ConnectRequest, Credentials, FetchX, FetchXError, connect, connect_finish,  # noqa: E402
                    connect_start, credentials_path, forget_credentials, load_credentials, save_credentials)

ORIGIN = "https://fetchx.ai"
API = "https://app.fetchx.ai"
REQUEST_ID = "10000000-0000-4000-8000-000000000001"
KEY_ID = "10000000-0000-4000-8000-000000000002"
PROJECT_ID = "cp_10000000-0000-4000-8000-000000000003"
DEVICE_CODE = "A" * 43
USER_CODE = "A234-BC56"
# The same key clients/connect.mjs works out for this device code (test/connect-client.test.mjs).
TOKEN = "fxk_V7zaj8zxFWAxM9dUl8Y2sZPqty10NwBlzg06Ep9kD4g"
ASKED = {"credits_per_day": 100, "credits_per_month": None, "expires_at": "2030-01-01T00:00:00.000Z"}


def started(**overrides):
    body = {"request_id": REQUEST_ID, "device_code": DEVICE_CODE, "user_code": USER_CODE,
            "verification_uri": f"{ORIGIN}/connect#{REQUEST_ID}",
            "verification_uri_complete": f"{ORIGIN}/connect#{REQUEST_ID}&code={USER_CODE}",
            "expires_in": 1200, "interval": 5, "limits": ASKED}
    body.update(overrides)
    return {key: value for key, value in body.items() if value is not ...}


def connected(**overrides):
    return {"state": "connected", "project_id": PROJECT_ID, "key_id": KEY_ID, "api_base_url": API,
            "limits": {"credits_per_day": 50, "credits_per_month": None, "expires_at": None}, **overrides}


class Server:
    """A fake Connect service: `start` answers the start, `claims` the claims in order."""

    def __init__(self, start=None, claims=()):
        self.start = start if start is not None else (200, started())
        self.claims = list(claims)
        self.requests = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        self.requests.append((request.url.path, body, request.headers))
        if request.url.path == "/api/control/connect/start":
            status, payload = self.start
            return httpx.Response(status, json=payload)
        assert request.url.path == "/api/control/connect/claim", request.url.path
        answer = self.claims.pop(0)
        if isinstance(answer, Exception):
            raise answer
        status, payload, headers = (answer + ({},))[:3]
        return httpx.Response(status, json=payload, headers=headers)

    def client(self):
        return httpx.Client(transport=httpx.MockTransport(self), follow_redirects=False)

    def paths(self):
        return [path.rsplit("/", 1)[-1] for path, _, _ in self.requests]


class Clock:
    def __init__(self):
        self.now = 1_000_000.0
        self.sleeps = []

    def time(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


class ConnectTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        for patch in (mock.patch.object(connect_module, "_now", self.clock.time), mock.patch.object(connect_module, "_sleep", self.clock.sleep),
                      mock.patch.dict(os.environ, {"XDG_CONFIG_HOME": self.folder.name}, clear=True)):
            patch.start()
            self.addCleanup(patch.stop)

    def test_start_asks_for_limits_and_returns_the_link_that_carries_the_code(self):
        server = Server()
        request = connect_start("My tool", limits={"credits_per_day": 100, "expires_in_days": 30}, http_client=server.client())
        path, body, headers = server.requests[0]
        self.assertEqual(path, "/api/control/connect/start")
        self.assertEqual(body, {"client_name": "My tool", "limits": {"credits_per_day": 100, "expires_in_days": 30}})
        for name in ("authorization", "cookie", "origin"):
            self.assertNotIn(name, headers)
        self.assertEqual(request.verification_uri_complete, f"{ORIGIN}/connect#{REQUEST_ID}&code={USER_CODE}")
        self.assertEqual((request.user_code, request.interval, request.api_origin), (USER_CODE, 5, API))
        self.assertEqual(request.expires_in, 1200)
        self.assertEqual(request.limits, ASKED)
        self.assertNotIn(DEVICE_CODE, repr(request))
        self.assertEqual(ConnectRequest.from_dict(json.loads(json.dumps(request.to_dict()))), request)

    def test_finish_polls_at_the_interval_slows_down_and_works_out_the_key(self):
        server = Server(claims=[(200, {"state": "pending"}), (429, {"error": {"code": "connect_slow_down"}}, {"Retry-After": "7"}),
                                httpx.ConnectError("lost"), (200, connected())])
        request = connect_start("My tool", http_client=server.client())
        credentials = connect_finish(request, http_client=server.client())
        self.assertEqual(server.paths(), ["start", "claim", "claim", "claim", "claim"])
        self.assertEqual(server.requests[1][1], {"request_id": REQUEST_ID, "device_code": DEVICE_CODE})
        self.assertEqual(self.clock.sleeps, [5.0, 10.0, 10.0])
        self.assertEqual(credentials, Credentials(token=TOKEN, api_base_url=API, project_id=PROJECT_ID, key_id=KEY_ID,
                                                  client_name="My tool", limits={"credits_per_day": 50, "credits_per_month": None, "expires_at": None}))
        self.assertNotIn(TOKEN, repr(credentials))

    def test_finish_with_a_timeout_returns_none_while_the_user_has_not_approved(self):
        server = Server(claims=[(200, {"state": "pending"})] * 3)
        request = connect_start("My tool", http_client=server.client())
        self.assertIsNone(connect_finish(request, timeout=12, http_client=server.client()))
        self.assertEqual(server.paths().count("claim"), 3)
        self.assertLessEqual(sum(self.clock.sleeps), 12)

    def test_denied_and_expired_requests_raise(self):
        for state in ("denied", "expired"):
            server = Server(claims=[(200, {"state": state})])
            request = connect_start("My tool", http_client=server.client())
            with self.assertRaises(ConnectError) as caught:
                connect_finish(request, http_client=server.client())
            self.assertEqual(caught.exception.code, f"connect_{state}")
        server = Server(claims=[(200, {"state": "pending"})] * 400)
        request = connect_start("My tool", http_client=server.client())
        with self.assertRaises(ConnectError) as caught:
            connect_finish(request, http_client=server.client())
        self.assertEqual(caught.exception.code, "connect_expired")
        self.assertLessEqual(self.clock.now, request.expires_at + 1)

    def test_a_saved_request_is_finished_in_a_later_call_and_the_key_is_saved_owner_only(self):
        server = Server(claims=[(200, {"state": "pending"}), (200, connected())])
        connect_start("My tool", save=True, http_client=server.client())
        pending = Path(self.folder.name) / "fetchx" / "connect-request.json"
        self.assertEqual(stat.S_IMODE(pending.stat().st_mode), 0o600)
        self.assertIsNone(connect_finish(timeout=1, http_client=server.client()))
        self.assertTrue(pending.exists(), "kept while the user has not approved")
        credentials = connect_finish(save=True, http_client=server.client())
        self.assertFalse(pending.exists(), "removed once connected")
        path = credentials_path()
        self.assertEqual(path, Path(self.folder.name) / "fetchx" / "credentials")
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(load_credentials(), credentials)
        # FetchX() reads the saved key and its API origin; FETCHX_TOKEN still comes first.
        client = FetchX()
        self.assertEqual(client.base_url, API)
        self.assertEqual(client._headers["Authorization"], "Bearer " + TOKEN)
        with mock.patch.dict(os.environ, {"FETCHX_TOKEN": "fxk_env"}):
            self.assertEqual(FetchX()._headers["Authorization"], "Bearer fxk_env")
            self.assertEqual(FetchX().base_url, "https://app.fetchx.ai")
        with self.assertRaises(ConnectError) as caught:
            connect_finish(http_client=server.client())
        self.assertEqual(caught.exception.code, "connect_not_started")
        self.assertTrue(forget_credentials())
        with self.assertRaises(FetchXError) as caught:
            FetchX()
        self.assertEqual(caught.exception.code, "client_config_missing")

    def test_a_key_file_other_users_can_read_is_refused(self):
        path = save_credentials(Credentials(token=TOKEN, api_base_url=API, project_id=PROJECT_ID, key_id=KEY_ID))
        os.chmod(path, 0o644)
        with self.assertRaises(FetchXError) as caught:
            FetchX()
        self.assertEqual(caught.exception.code, "credentials_insecure")
        os.chmod(path, 0o600)
        path.write_text("{}")
        with self.assertRaises(FetchXError) as caught:
            load_credentials()
        self.assertEqual(caught.exception.code, "credentials_invalid")
        custom = Path(self.folder.name) / "elsewhere.json"
        with mock.patch.dict(os.environ, {"FETCHX_CREDENTIALS_FILE": str(custom)}):
            save_credentials(Credentials(token=TOKEN, api_base_url="http://127.0.0.1:8789", project_id=PROJECT_ID, key_id=KEY_ID))
            self.assertEqual(FetchX().base_url, "http://127.0.0.1:8789")

    def test_answers_that_do_not_match_the_request_are_refused(self):
        cases = [
            (Server(start=(200, started(verification_uri_complete=f"{ORIGIN}/connect#{REQUEST_ID}&code=ZZZZ-ZZZZ"))), "connect_invalid_response"),
            (Server(start=(200, started(verification_uri="https://unexpected.example/connect"))), "connect_invalid_response"),
            (Server(start=(200, started(expires_in=3601))), "connect_invalid_response"),
            (Server(start=(200, started(device_code="short"))), "connect_invalid_response"),
            (Server(start=(503, {"error": {"code": "connect_disabled"}})), "connect_unavailable"),
            (Server(start=(429, {"error": {"code": "too_many_requests"}})), "connect_rate_limited"),
        ]
        for server, code in cases:
            with self.subTest(code=code), self.assertRaises(ConnectError) as caught:
                connect_start("My tool", http_client=server.client())
            self.assertEqual(caught.exception.code, code)
        refused = Server(start=(400, {"error": {"code": "key_limits_invalid"}}))
        with self.assertRaises(ConnectError) as caught:
            connect_start("My tool", limits={"credits_per_day": 0}, http_client=refused.client())
        self.assertEqual(caught.exception.code, "connect_invalid_limits")
        local = Server()
        for limits in ({"credits_per_hour": 5}, ["credits_per_day"]):
            with self.assertRaises(ConnectError) as caught:
                connect_start("My tool", limits=limits, http_client=local.client())
            self.assertEqual(caught.exception.code, "connect_invalid_limits")
        self.assertEqual(local.requests, [], "bad limits are refused before any request")
        mismatch = Server(claims=[(200, connected(api_base_url="https://unexpected.example"))])
        request = connect_start("My tool", http_client=mismatch.client())
        with self.assertRaises(ConnectError) as caught:
            connect_finish(request, http_client=mismatch.client())
        self.assertEqual(caught.exception.code, "connect_api_origin_mismatch")

    def test_origins_names_and_redirects(self):
        for origin, code in (("http://fetchx.example", "connect_invalid_origin"), ("https://user@fetchx.example", "connect_invalid_origin")):
            with self.assertRaises(ConnectError) as caught:
                connect_start("My tool", origin=origin, http_client=Server().client())
            self.assertEqual(caught.exception.code, code)
        with self.assertRaises(ConnectError) as caught:
            connect_start("My tool", api_origin="https://other.example", http_client=Server().client())
        self.assertEqual(caught.exception.code, "connect_invalid_origin")
        with self.assertRaises(ConnectError) as caught:
            connect_start("bad name!", http_client=Server().client())
        self.assertEqual(caught.exception.code, "connect_invalid_client_name")
        local = "http://127.0.0.1:4434"
        server = Server(start=(200, started(verification_uri=f"{local}/connect#{REQUEST_ID}",
                                            verification_uri_complete=f"{local}/connect#{REQUEST_ID}&code={USER_CODE}")))
        request = connect_start("My tool", origin=local, api_origin="http://127.0.0.1:8789", http_client=server.client())
        self.assertEqual((request.origin, request.api_origin), (local, "http://127.0.0.1:8789"))
        moved = httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(307, headers={"Location": "https://other.example"})))
        with self.assertRaises(ConnectError) as caught:
            connect_start("My tool", http_client=moved)
        self.assertEqual(caught.exception.code, "connect_redirect")
        older = Server(start=(200, started(verification_uri_complete=..., limits=...)))
        request = connect_start("My tool", http_client=older.client())
        self.assertEqual(request.verification_uri_complete, request.verification_uri, "an older service sends no code link")

    def test_connect_tells_the_user_and_waits(self):
        server = Server(claims=[(200, {"state": "pending"}), (200, connected())])
        shown = []
        credentials = connect("My tool", on_approval=shown.append, http_client=server.client())
        self.assertEqual([request.user_code for request in shown], [USER_CODE])
        self.assertEqual(credentials.token, TOKEN)
        server = Server(claims=[(200, {"state": "pending"}), (200, connected())])
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            connect("My tool", http_client=server.client())
        self.assertEqual(stderr.getvalue(), f"Open {ORIGIN}/connect#{REQUEST_ID}&code={USER_CODE}\nFetchX code: {USER_CODE}\n")
        self.assertNotIn(TOKEN, stderr.getvalue())
        server = Server(claims=[(200, {"state": "pending"})] * 5)
        with self.assertRaises(ConnectError) as caught:
            connect("My tool", on_approval=shown.append, timeout=8, http_client=server.client())
        self.assertEqual(caught.exception.code, "connect_timeout")

    def test_the_command_line_saves_the_key(self):
        credentials = Credentials(token=TOKEN, api_base_url=API, project_id=PROJECT_ID, key_id=KEY_ID)
        with mock.patch.object(connect_module, "connect", return_value=credentials) as called, contextlib.redirect_stderr(io.StringIO()) as out:
            self.assertEqual(connect_module.main(["--client-name", "My tool", "--credits-per-day", "500", "--expires-in-days", "30"]), 0)
        self.assertEqual(called.call_args.kwargs["limits"], {"credits_per_day": 500, "expires_in_days": 30})
        self.assertTrue(called.call_args.kwargs["save"])
        self.assertIn(str(credentials_path()), out.getvalue())
        self.assertNotIn(TOKEN, out.getvalue())


if __name__ == "__main__":
    unittest.main()
