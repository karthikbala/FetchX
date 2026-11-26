"""Holds the Python SDK's requests and its FakeFetchX's answers to the public contract.

Every request the SDK sends during a scenario that touches every route is checked against the
operation's request schema in docs/openapi.json, and every answer the fake gives against the
schema for its status code, so the fake (which the SDK's other tests and its users' tests rely
on) cannot drift from the real API unnoticed.
"""
import json
import re
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "clients" / "python-sdk" / "src"))

from fetchx import FetchXError  # noqa: E402
from fetchx.testing import FakeFetchX, FakePage  # noqa: E402

CONTRACT = json.loads((ROOT / "docs" / "openapi.json").read_text())
SHOP = "https://shop.example.com"


class SchemaError(AssertionError):
    pass


def validate(value, schema, where="$"):
    """The subset of JSON Schema 2020-12 that docs/openapi.json uses."""
    if "$ref" in schema:
        node = CONTRACT
        for part in schema["$ref"].lstrip("#/").split("/"):
            node = node[part]
        validate(value, node, where)
        schema = {k: v for k, v in schema.items() if k != "$ref"}
    kinds = schema.get("type")
    if kinds is not None:
        kinds = kinds if isinstance(kinds, list) else [kinds]
        if not any(_is(value, kind) for kind in kinds):
            raise SchemaError(f"{where}: {value!r:.80} is not {kinds}")
    if "enum" in schema and value not in schema["enum"]:
        raise SchemaError(f"{where}: {value!r:.80} is not one of {schema['enum']}")
    if "const" in schema and value != schema["const"]:
        raise SchemaError(f"{where}: {value!r:.80} is not {schema['const']!r}")
    for key in ("oneOf", "anyOf"):
        if key in schema:
            passed = sum(1 for option in schema[key] if _passes(value, option, where))
            if passed == 0 or (key == "oneOf" and passed > 1):
                raise SchemaError(f"{where}: {value!r:.120} matches {passed} of {key}")
    for option in schema.get("allOf", []):
        validate(value, option, where)
    if isinstance(value, dict):
        for key in schema.get("required", []):
            if key not in value:
                raise SchemaError(f"{where}: missing {key}")
        properties = schema.get("properties", {})
        extra = schema.get("additionalProperties", True)
        for key, item in value.items():
            if key in properties:
                validate(item, properties[key], f"{where}.{key}")
            elif extra is False:
                raise SchemaError(f"{where}: unexpected field {key}")
            elif isinstance(extra, dict):
                validate(item, extra, f"{where}.{key}")
        if len(value) < schema.get("minProperties", 0):
            raise SchemaError(f"{where}: fewer than {schema['minProperties']} fields")
    if isinstance(value, list):
        if len(value) < schema.get("minItems", 0) or len(value) > schema.get("maxItems", len(value)):
            raise SchemaError(f"{where}: {len(value)} items")
        if schema.get("uniqueItems") and len({json.dumps(item, sort_keys=True) for item in value}) != len(value):
            raise SchemaError(f"{where}: items repeat")
        for index, item in enumerate(value):
            if "items" in schema:
                validate(item, schema["items"], f"{where}[{index}]")
    if isinstance(value, str):
        if len(value) < schema.get("minLength", 0) or len(value) > schema.get("maxLength", len(value)):
            raise SchemaError(f"{where}: length {len(value)}")
        if "pattern" in schema and not re.search(schema["pattern"], value):
            raise SchemaError(f"{where}: {value!r} does not match {schema['pattern']}")
    if _is(value, "number"):
        if "minimum" in schema and value < schema["minimum"]:
            raise SchemaError(f"{where}: {value} < {schema['minimum']}")
        if "maximum" in schema and value > schema["maximum"]:
            raise SchemaError(f"{where}: {value} > {schema['maximum']}")


def _passes(value, schema, where):
    try:
        validate(value, schema, where)
        return True
    except SchemaError:
        return False


def _is(value, kind):
    if kind == "null":
        return value is None
    if kind == "boolean":
        return isinstance(value, bool)
    if kind == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if kind == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if kind == "string":
        return isinstance(value, str)
    if kind == "array":
        return isinstance(value, list)
    if kind == "object":
        return isinstance(value, dict)
    raise SchemaError(f"unknown type {kind}")


def operation_for(method, path):
    for template, operations in CONTRACT["paths"].items():
        pattern = "^" + re.sub(r"\{[^}]+\}", "[^/]+", template) + "$"
        if re.match(pattern, path) and method.lower() in operations:
            return template, operations[method.lower()]
    raise AssertionError(f"{method} {path} is not in the contract")


class CheckedFake(FakeFetchX):
    """FakeFetchX that checks every request and answer against the contract."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.covered = set()
        self.problems = []

    def handler(self, request):
        template, operation = operation_for(request.method, request.url.raw_path.decode().split("?", 1)[0])
        body = json.loads(request.content) if request.content else None
        content = (operation.get("requestBody") or {}).get("content") or {}
        schema = (content.get("application/json") or {}).get("schema")
        if body is not None and schema:
            try:
                validate(body, schema, f"{request.method} {template} request")
            except SchemaError as error:
                self.problems.append(str(error))
        response = super().handler(request)
        status = str(response.status_code)
        self.covered.add((request.method, template, status))
        documented = operation["responses"].get(status)
        if documented is None:
            self.problems.append(f"{request.method} {template} answered {status}, which the contract does not list")
            return response
        content = documented.get("content") or {}
        if "application/json" in content:
            try:
                validate(response.json(), content["application/json"]["schema"],
                         f"{request.method} {template} {status}")
            except SchemaError as error:
                self.problems.append(str(error))
        return response


def scenario(fake):
    """Touch every route, and the states and errors a client meets on them."""
    client = fake.client(max_credits=200)
    first = client.fetch(url=f"{SHOP}/p/1", formats=["body", "markdown", "text", "links", "metadata", "screenshot"],
                         expect={"text": "Lamp"}, extract={"schema": {"type": "object"}}, tags=["contract"])
    client.fetch(url=f"{SHOP}/p/1", async_=True)
    pending_fake_result = client.fetch(url=f"{SHOP}/slow", async_=True)
    client.get(pending_fake_result.id, include_body=False)
    client.wait(pending_fake_result.id)
    client.fetch(url=f"{SHOP}/manual.pdf")
    shaped = client.fetch(url=f"{SHOP}/api/items", render="never", formats=["skeleton"])
    assert shaped.skeleton["root"] == "object" and shaped.body is None, shaped.raw
    assert {"path": "$.items[*].price", "type": "null|number", "seen": 2} in shaped.skeleton["fields"], shaped.skeleton
    assert shaped.skeleton["sample"] == {"items": [{"name": "Lamp", "price": 19.5}], "total": 2}, shaped.skeleton
    assert client.fetch(url=f"{SHOP}/p/3", formats=["skeleton"]).skeleton is None
    client.fetch(url=f"{SHOP}/missing")
    client.fetch(url=f"{SHOP}/walled")
    client.fetch(url=f"{SHOP}/broken")
    second = client.next(first, scroll=2, expect=None)
    client.list(status="succeeded", limit=2)
    client.list(tag="contract")
    client.content(first)
    client.screenshot(first)
    captured = client.fetch(url=f"{SHOP}/p/1", capture={"types": ["document", "xhr", "fetch"], "max_requests": 10})
    assert captured.network["captured"] == 3 and captured.network["dropped"]["trackers"] == 1, captured.network
    found = client.network(captured, contains=["lamp", "Desk"], content_type="json")
    assert [(row["index"], row["matched"]) for row in found] == [(2, ["lamp"])], found.items
    assert len(client.network(captured, limit=1)) == 1
    call = client.network_call(captured, found.items[0]["index"])
    assert call.body == '{"items": [{"name": "Lamp"}]}' and call.request["headers"][0][1].startswith("sid=<masked len=3 "), call.raw
    assert client.network_body(captured, 2).data == b'{"items": [{"name": "Lamp"}]}'
    assert [entry["request"]["url"] for entry in client.network_har(captured, page=1)["log"]["entries"]][1:] == [
        f"{SHOP}/api/items?page=1", "https://cdn.example.net/api/stock"]
    acted = client.fetch(url=f"{SHOP}/p/1", allow_hosts=["shop.example.com"], allow_passive_subresources=True,
                         actions=[{"type": "click", "selector": "#more"}, {"type": "evaluate", "script": "1 + 1"},
                                  {"type": "wait_for_response", "url_contains": "/api/items", "status_in": [200]}],
                         action_timeout_ms=5000, timeout_ms=300_000)
    assert [entry["status"] for entry in acted.actions] == ["ok", "ok", "ok"], acted.raw
    client.fetch(url=f"{SHOP}/missing", actions=[{"type": "click", "selector": "#more"}])
    me = client.me()
    assert me.key_prefix == "fxk_fake" and "fetch:read" in me.scopes and me.limits["credits_per_day"] is None, me.raw
    report = client.send_feedback(fetch_id=first.id, kind="blocked_via_fetchx_ok_from_home", message="Loads at home.",
                                  evidence={"status_code": 200, "client": "curl from a home connection"})
    assert report.status == "received" and report.open and report.url == f"{SHOP}/p/1" and report.fetch_id == first.id, report.raw
    assert client.send_feedback(fetch_id=first.id, kind="blocked_via_fetchx_ok_from_home").id == report.id
    assert client.send_feedback({"url": f"{SHOP}/p/9", "kind": "other"}).raw["method"] == "GET"
    fake.answer_feedback(report.id, "resolved", "Fixed.")
    answered = client.get_feedback(report)
    assert (answered.status, answered.reply, answered.open) == ("resolved", "Fixed.", False), answered.raw
    login = client.save_login(site="https://login.shop.example.com/auth", username="buyer@shop.example.com",
                              password="synthetic-pass-1", name="Shop")
    assert (login.site, login.status, login.signed_in, login.usable, login.last_sign_in) == (
        "login.shop.example.com", "new", False, True, None), login.raw
    assert "synthetic-pass-1" not in json.dumps(login.raw) and "buyer" not in login.username
    assert [item.id for item in client.list_logins()] == [login.id]
    assert client.get_login(login).name == "Shop"
    assert client.update_login(login, name="Shop (ops)").name == "Shop (ops)"
    assert client.fetch(url=f"{SHOP}/p/1", login=login.id, idempotency_key="with-login").status == "succeeded"
    session = client.create_browser_session(allow_hosts=["shop.example.com", "login.shop.example.com"], ttl_s=120,
                                            secrets={"pin": {"value": "synthetic-pin-1", "origins": ["https://login.shop.example.com"]}},
                                            login=login.id)
    assert session.open and session.ws_url.endswith(f"/v1/browser-sessions/{session.id}/ws") and session.playwright_version, session.raw
    assert "synthetic-pin-1" not in json.dumps(session.raw)
    assert client.create_browser_session(allow_hosts=["shop.example.com", "login.shop.example.com"], ttl_s=120, login=login.id,
                                         secrets={"pin": {"value": "synthetic-pin-1", "origins": ["https://login.shop.example.com"]}},
                                         idempotency_key=session.idempotency_key).id == session.id
    assert client.fill_browser_session(session, secret="pin", selector="#pin", frame_url="https://login.shop.example.com/sign-in?x=1") == {
        "secret": "pin", "frame_url": "https://login.shop.example.com/sign-in"}
    client.fill_browser_session(session, secret="login.password", selector="#password", frame_url="https://login.shop.example.com/")
    assert [item.id for item in client.list_browser_sessions(status="open")] == [session.id]
    assert client.get_browser_session(session).open
    receipt = client.close_browser_session(session)
    assert receipt.closed and receipt.close_reason == "client" and receipt.credits_charged == 10 and receipt.secrets_used == ["pin", "login.password"]
    assert client.list_browser_sessions(status="open") == []
    client.delete_login(login)
    for bad in (lambda: client.create_browser_session(allow_hosts=[""]),
                lambda: client.create_browser_session(allow_hosts=["shop.example.com"], ttl_s=120, idempotency_key=session.idempotency_key),
                lambda: client.create_browser_session(allow_hosts=["shop.example.com"], max_credits=5),
                lambda: client.get_browser_session("00000000-0000-4000-8000-000000000004"),
                lambda: client.close_browser_session("00000000-0000-4000-8000-000000000004"),
                lambda: client.fill_browser_session(session, secret="pin", selector="#pin"),
                lambda: client.fill_browser_session("00000000-0000-4000-8000-000000000004", secret="pin", selector="#pin"),
                lambda: client.list_browser_sessions(status="gone")):
        try:
            bad()
        except FetchXError:
            pass
    for bad in (lambda: client.fetch(url="ftp://shop.example.com/"),
                lambda: client.fetch(url=f"{SHOP}/dear", max_credits=5),
                lambda: client.fetch(url=f"{SHOP}/p/2", idempotency_key=first.idempotency_key),
                lambda: client.get("00000000-0000-4000-8000-000000000000"),
                lambda: client.next("00000000-0000-4000-8000-000000000001"),
                lambda: client.next(client.fetch(url=f"{SHOP}/p/3")),
                lambda: client.fetch(url=f"{SHOP}/p/1", capture=True, render="never"),
                lambda: client.network(first),
                lambda: client.network_call(first, 1),
                lambda: client.network_har(first),
                lambda: client.network_body(first, 1),
                lambda: client.network(captured, status="ok"),
                lambda: client.network_call(captured, 9),
                lambda: client.network_body(captured, 4),
                lambda: client.send_feedback(url="ftp://shop.example.com/", kind="other"),
                lambda: client.send_feedback(fetch_id=first.id, url=f"{SHOP}/p/1", kind="other"),
                lambda: client.send_feedback(fetch_id="00000000-0000-4000-8000-000000000002", kind="other"),
                lambda: client.get_feedback("00000000-0000-4000-8000-000000000003"),
                lambda: client.save_login(site="http://login.shop.example.com", username="buyer@shop.example.com", password="p-1"),
                lambda: client.get_login(login.id),
                lambda: client.update_login(login.id, name="Gone"),
                lambda: client.delete_login(login.id)):
        try:
            bad()
        except FetchXError:
            pass
    client.delete(second.id)
    client.get(second.id)
    client.delete(captured.id)
    for bad in (lambda: client.content(second.id), lambda: client.next(second.id), lambda: client.network(captured),
                lambda: client.network_har(captured), lambda: client.network_call(captured, 1),
                lambda: client.network_body(captured, 1)):
        try:
            bad()
        except FetchXError:
            pass
    results = client.run_batch([f"{SHOP}/p/1", {"url": f"{SHOP}/p/2", "formats": ["markdown"]},
                                {"url": f"{SHOP}/dear", "max_credits": 5}, f"{SHOP}/walled"],
                               defaults={"formats": ["body"]}, tags=["contract"])
    assert results[0].ok and results[2] is None
    batch = client.submit_batch([f"{SHOP}/p/1", f"{SHOP}/p/2", f"{SHOP}/p/3"])
    client.batch_items(batch.id, limit=1, results=False)
    client.cancel_batch(batch.id)
    client.batch(batch.id)
    client.list_batches(status="canceled")
    try:
        client.submit_batch([f"{SHOP}/p/1"], idempotency_key=batch.idempotency_key)
    except FetchXError:
        pass
    fake.refuse(429, "too_many_requests", retry_after_seconds=0, path="/v1/batches")
    client.submit_batch([f"{SHOP}/p/1"])
    client.estimate(url=f"{SHOP}/p/1")
    client.estimate(items=[f"{SHOP}/p/1", {"url": f"{SHOP}/dear", "max_credits": 5}], defaults={"formats": ["text"]})
    client.balance()
    client.usage(period="day")
    client.status()
    prices = client.prices()
    assert prices.step("browser_residential") == 25 and prices.trial_credits == 1000 and prices.captcha == 10, prices.raw
    fake.unavailable(1, code="maintenance", path="/v1/balance")
    client.balance()


class ContractTests(unittest.TestCase):
    def test_sdk_requests_and_fake_answers_match_the_public_contract(self):
        fake = CheckedFake({f"{SHOP}/p/1": FakePage("<html><h1>Lamp</h1></html>", next_url=f"{SHOP}/p/2",
                                                    links=[{"url": f"{SHOP}/p/2", "text": "Next"}],
                                                    metadata={"title": "Lamp"}, extract={"name": "Lamp"},
                                                    screenshot=b"\xff\xd8jpeg", network=[
                                                        {"url": f"{SHOP}/api/items?page=1", "type": "xhr",
                                                         "request_headers": {"Cookie": "sid=abc"},
                                                         "body": {"items": [{"name": "Lamp"}]}},
                                                        {"url": "https://cdn.example.net/api/stock",
                                                         "content_type": "image/png", "body": b"\x89PNG"},
                                                        {"url": "https://stats.example.org/collect",
                                                         "tracker": True},
                                                        {"url": f"{SHOP}/app.js", "type": "script"}]),
                            f"{SHOP}/p/2": FakePage("<html>Desk</html>", next_url=f"{SHOP}/p/3"),
                            f"{SHOP}/p/3": "<html>Chair</html>",
                            f"{SHOP}/slow": "<html>slow</html>",
                            f"{SHOP}/manual.pdf": FakePage(b"%PDF\xff\xfe", content_type="application/pdf"),
                            f"{SHOP}/api/items": FakePage('{"items": [{"name": "Lamp", "price": 19.5}, {"name": "Desk", "price": null}], "total": 2}',
                                                          content_type="application/json"),
                            f"{SHOP}/dear": FakePage("<html>dear</html>", credits=90),
                            f"{SHOP}/broken": (500, "text/html", "<html>oops</html>")},
                           pending_polls=1, batch_step=1)
        fake.fail(f"{SHOP}/walled", "blocked", retry_after_seconds=900, vendor="examplewall", times=2)
        scenario(fake)
        self.assertEqual(fake.problems, [])
        hit = {(method, template) for method, template, _ in fake.covered}
        routes = {(method.upper(), template) for template, operations in CONTRACT["paths"].items()
                  for method in operations if method in ("get", "post", "delete")}
        self.assertEqual(routes - hit, set(), "the scenario misses a route")
        statuses = {status for _, _, status in fake.covered}
        self.assertTrue({"200", "202", "204", "400", "402", "404", "409", "410", "429", "503"} <= statuses, statuses)

    def test_the_validator_catches_what_it_should(self):
        result_schema = {"$ref": "#/components/schemas/FetchResult"}
        with self.assertRaises(SchemaError):
            validate({"id": "x"}, result_schema)
        with self.assertRaises(SchemaError):
            validate({"url": "https://example.com/", "unknown": 1}, {"$ref": "#/components/schemas/FetchRequest"})
        with self.assertRaises(SchemaError):
            validate({"items": []}, {"$ref": "#/components/schemas/BatchRequest"})
        validate({"url": "https://example.com/", "formats": ["markdown"]},
                 {"$ref": "#/components/schemas/FetchRequest"})


if __name__ == "__main__":
    unittest.main()
