"""Offline checks for the Python SDK in clients/python-sdk (sync client, models, fake).

Run from the repository root with a Python that has httpx:
    python -m unittest discover -s test -p '*_test.py'
"""
import os
import pickle
import sys
import threading
import unittest
from pathlib import Path
from unittest import mock

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "clients" / "python-sdk" / "src"))

from fetchx import (Content, FetchFailed, FetchResult, FetchX, FetchXError, SpendLimitReached,  # noqa: E402
                    new_key, site_of)
from fetchx.testing import FakeFetchX, FakePage  # noqa: E402

SHOP = "https://shop.example.com"


def shop(pages=None, **options):
    return FakeFetchX({f"{SHOP}/p/1": FakePage("<html><h1>Lamp</h1></html>", next_url=f"{SHOP}/p/2",
                                               markdown="# Lamp"),
                       f"{SHOP}/p/2": FakePage("<html><h1>Desk</h1></html>", next_url=f"{SHOP}/p/3"),
                       f"{SHOP}/p/3": "<html><h1>Chair</h1></html>", **(pages or {})}, **options)


def calls(fake, method=None, path=None):
    return [call for call in fake.requests if (method is None or call.method == method)
            and (path is None or call.path == path)]


class Sleeps:
    def __init__(self):
        self.seconds = []

    def __call__(self, seconds):
        self.seconds.append(seconds)


class ConfigTests(unittest.TestCase):
    def test_reads_the_key_and_url_from_the_environment_and_never_shows_the_key(self):
        with mock.patch.dict(os.environ, {"FETCHX_TOKEN": "fxk_env", "FETCHX_URL": "https://api.fetchx.test/"}):
            client = FetchX()
        self.assertEqual(client.base_url, "https://api.fetchx.test")
        self.assertNotIn("fxk_env", repr(client))
        with mock.patch.dict(os.environ, {"FETCHX_API_KEY": "fxk_console"}, clear=True):
            self.assertEqual(FetchX().base_url, "https://app.fetchx.ai")
        # No key in the environment and no file saved by Connect.
        missing = os.path.join(os.path.dirname(__file__), "no-such-credentials-file")
        with mock.patch.dict(os.environ, {"FETCHX_CREDENTIALS_FILE": missing}, clear=True), self.assertRaises(FetchXError) as caught:
            FetchX()
        self.assertEqual(caught.exception.code, "client_config_missing")
        with self.assertRaises(FetchXError):
            FetchX("ftp://fetchx.test", "fxk_x")
        with self.assertRaises(ValueError):
            FetchX("https://fetchx.test", "fxk_x", max_credits=0)

    def test_every_call_sends_the_key_as_a_bearer_token(self):
        seen = []

        def handler(request):
            seen.append(request.headers["authorization"])
            return httpx.Response(200, json={"credits": 5, "reserved": 0, "trial": 0, "purchased": 5,
                                             "payment_hold": False})

        client = FetchX("https://fetchx.test", "fxk_fixture", transport=httpx.MockTransport(handler))
        self.assertEqual(client.balance().credits, 5)
        self.assertEqual(seen, ["Bearer fxk_fixture"])

    def test_site_of_groups_hosts_with_and_without_www(self):
        self.assertEqual(site_of("https://www.Shop.example.com/a"), "shop.example.com")
        self.assertEqual(site_of("https://shop.example.com:8443/b"), "shop.example.com")
        self.assertIsNone(site_of("not a url"))
        self.assertTrue(new_key("crawl").startswith("crawl-"))


class FetchTests(unittest.TestCase):
    def test_fetch_waits_through_202_and_downloads_the_body_it_asked_for(self):
        fake = shop(pending_polls=2)
        result = fake.client().fetch(url=f"{SHOP}/p/1")
        self.assertTrue(result.ok)
        self.assertEqual((result.body, result.content), ("<html><h1>Lamp</h1></html>", b"<html><h1>Lamp</h1></html>"))
        self.assertEqual((result.source_status, result.page_status, result.credits, result.step),
                         (200, "content", 1, "http"))
        self.assertEqual(result.next_page.url, f"{SHOP}/p/2")
        self.assertEqual([(c.method, c.path.rsplit("/", 1)[-1], c.params) for c in fake.requests], [
            ("POST", "fetch", {}), ("GET", result.id, {"include_body": "false"}),
            ("GET", result.id, {"include_body": "false"}), ("GET", "content", {})])
        self.assertTrue(fake.requests[0].json["idempotency_key"].startswith("fx-"))

    def test_a_finished_answer_uses_the_inline_body_and_keeps_binary_bytes_exact(self):
        pdf = b"%PDF-1.7\xff\xfe\x00binary"
        fake = shop({f"{SHOP}/manual.pdf": FakePage(pdf, content_type="application/pdf")})
        result = fake.client().fetch(url=f"{SHOP}/manual.pdf")
        self.assertEqual(result.content, pdf)
        self.assertEqual(len(fake.requests), 1)

    def test_formats_without_body_skip_the_download_unless_asked(self):
        fake = shop(pending_polls=1)
        client = fake.client()
        result = client.fetch(url=f"{SHOP}/p/1", formats=["markdown"])
        self.assertEqual((result.markdown, result.body), ("# Lamp", None))
        self.assertEqual(calls(fake, path=f"/v1/fetch/{result.id}/content"), [])
        result = client.fetch({"url": f"{SHOP}/p/1", "formats": ["markdown"]}, want_body=True)
        self.assertEqual(result.body, "<html><h1>Lamp</h1></html>")
        self.assertIsNone(client.fetch(url=f"{SHOP}/p/1", want_body=False).content)

    def test_an_async_request_comes_back_pending_and_wait_finishes_it(self):
        fake = shop(pending_polls=2)
        client = fake.client()
        pending = client.fetch(url=f"{SHOP}/p/1", async_=True)
        self.assertTrue(pending.pending)
        self.assertIs(fake.requests[0].json["async"], True)
        self.assertEqual(client.credits_spent, 0)
        done = client.wait(pending)
        self.assertTrue(done.ok)
        self.assertEqual(done.body, "<html><h1>Lamp</h1></html>")
        self.assertEqual(client.credits_spent, 1)

    def test_a_lost_answer_is_resent_with_the_same_key_and_charged_once(self):
        fake = shop().drop(1, method="POST", path="/v1/fetch")
        client = fake.client()
        result = client.fetch(url=f"{SHOP}/p/1")
        posts = calls(fake, "POST")
        self.assertEqual(len(posts), 2)
        self.assertEqual(posts[0].json, posts[1].json)
        self.assertEqual(len(fake.site_requests), 1, "the resend replays the first result")
        self.assertEqual((result.ok, client.credits_spent, client.calls), (True, 1, 1))

    def test_maintenance_and_429_are_waited_out_with_the_same_key(self):
        sleeps = Sleeps()
        fake = shop().unavailable(2, code="maintenance", retry_after_seconds=7, path="/v1/fetch")
        fake.refuse(429, "too_many_requests", retry_after_seconds=3, path="/v1/fetch")
        result = fake.client(sleep=sleeps).fetch(url=f"{SHOP}/p/1", idempotency_key="order-42")
        self.assertTrue(result.ok)
        self.assertEqual(sleeps.seconds, [7, 7, 3])
        self.assertEqual({call.json["idempotency_key"] for call in calls(fake, "POST")}, {"order-42"})

    def test_resends_follow_the_schedule_and_stop_when_it_runs_out(self):
        sleeps = Sleeps()
        fake = shop().unavailable(5, retry_after_seconds=None)
        with self.assertRaises(FetchXError) as caught:
            fake.client(sleep=sleeps, unavailable_waits=(1, 2)).fetch(url=f"{SHOP}/p/1")
        self.assertEqual((caught.exception.code, caught.exception.status), ("unavailable", 503))
        self.assertTrue(caught.exception.retryable)
        self.assertEqual(sleeps.seconds, [1, 2])
        self.assertEqual(len(calls(fake, "POST")), 3)

    def test_extract_unavailable_is_not_resent(self):
        fake = shop().refuse(503, "extract_unavailable", retry_after_seconds=60)
        with self.assertRaises(FetchXError) as caught:
            fake.client().fetch(url=f"{SHOP}/p/1", extract={"schema": {"type": "object"}})
        self.assertEqual(caught.exception.code, "extract_unavailable")
        self.assertFalse(caught.exception.retryable)
        self.assertEqual(len(fake.requests), 1)

    def test_refusals_raise_with_code_status_and_details_and_never_the_key(self):
        fake = shop()
        client = fake.client()
        with self.assertRaises(FetchXError) as caught:
            client.fetch(url="ftp://shop.example.com/", idempotency_key="k1")
        error = caught.exception
        self.assertEqual((error.code, error.status, error.http_status, error.details, error.idempotency_key),
                         ("invalid_request", 400, 400, {"field": "url"}, "k1"))
        self.assertTrue(error.refused)
        self.assertNotIn("fxk_", str(error))
        self.assertRegex(error.request_id, r"^req_[0-9a-f]{24}$")
        copy = pickle.loads(pickle.dumps(error))
        self.assertEqual((copy.code, copy.status, copy.details, copy.request_id),
                         (error.code, error.status, error.details, error.request_id))
        with self.assertRaises(FetchXError) as caught:
            client.fetch({"url": f"{SHOP}/p/1"}, max_credits="lots")
        self.assertEqual(caught.exception.details, {"field": "max_credits"})

    def test_a_proxy_page_instead_of_json_is_not_shown(self):
        def handler(_request):
            return httpx.Response(502, content=b"<html>private proxy page fxk_fixture</html>")

        client = FetchX("https://fetchx.test", "fxk_fixture", transport=httpx.MockTransport(handler),
                        sleep=lambda _s: None, unavailable_waits=(0,))
        with self.assertRaises(FetchXError) as caught:
            client.fetch(url=f"{SHOP}/p/1")
        self.assertEqual((caught.exception.code, caught.exception.status), ("unavailable", 502))
        self.assertNotIn("proxy page", str(caught.exception))
        self.assertNotIn("fxk_fixture", str(caught.exception))

    def test_a_failed_fetch_is_returned_with_what_to_do_next(self):
        fake = shop().fail(f"{SHOP}/p/1", "blocked", retry_after_seconds=900, vendor="examplewall")
        result = fake.client().fetch(url=f"{SHOP}/p/1")
        self.assertTrue(result.failed)
        self.assertEqual((result.error_code, result.next_action, result.retry_with_new_key, result.retry_after_seconds),
                         ("blocked", "retry_later", True, 900))
        self.assertEqual((result.page_status, result.challenge.vendor, result.credits), ("challenge", "examplewall", 0))
        self.assertEqual(result.summary()["next_action"], "retry_later")
        with self.assertRaises(FetchFailed) as caught:
            result.raise_for_status()
        self.assertEqual((caught.exception.code, caught.exception.result.id), ("blocked", result.id))

    def test_retry_failed_sends_a_new_key_only_when_error_next_allows_it(self):
        sleeps = Sleeps()
        fake = shop().fail(f"{SHOP}/p/1", "rate_limited", retry_after_seconds=30)
        client = fake.client(sleep=sleeps, retry_failed=2)
        result = client.fetch(url=f"{SHOP}/p/1", idempotency_key="page-1")
        self.assertTrue(result.ok)
        self.assertEqual([call.json["idempotency_key"] for call in calls(fake, "POST")], ["page-1", "page-1.retry1"])
        self.assertIn(30, sleeps.seconds)
        self.assertEqual(client.calls, 2)

        fake = shop().fail(f"{SHOP}/p/1", "content_missing", action="check_expect")
        self.assertTrue(fake.client(retry_failed=2).fetch(url=f"{SHOP}/p/1").failed)
        self.assertEqual(len(calls(fake, "POST")), 1, "retry_with_new_key false: change the request first")

        fake = shop().fail(f"{SHOP}/p/1", "blocked", retry_after_seconds=3600)
        self.assertTrue(fake.client(retry_failed=2, max_retry_wait=600).fetch(url=f"{SHOP}/p/1").failed)
        self.assertEqual(len(calls(fake, "POST")), 1, "a wait past max_retry_wait is left to the caller")

    def test_a_request_still_running_past_max_wait_raises_and_can_be_read_later(self):
        fake = shop(pending_polls=5)
        client = fake.client(max_wait=0, spend_limit=100)
        with self.assertRaises(FetchXError) as caught:
            client.fetch(url=f"{SHOP}/p/1", max_credits=10)
        self.assertEqual(caught.exception.code, "wait_timeout")
        fetch_id = caught.exception.details["id"]
        self.assertEqual(client.remaining_credits, 90, "a running request keeps its credits held")
        self.assertTrue(client.wait(fetch_id, max_wait=60).ok)
        self.assertEqual((client.remaining_credits, client.credits_spent), (99, 1))

    def test_next_pages_follow_on_with_new_keys_and_the_client_cap(self):
        fake = shop()
        client = fake.client(max_credits=40)
        first = client.fetch(url=f"{SHOP}/p/1")
        second = client.next(first)
        third = client.next_page(second.id, scroll=3)
        self.assertEqual([r.body for r in (second, third)],
                         ["<html><h1>Desk</h1></html>", "<html><h1>Chair</h1></html>"])
        self.assertEqual((third.page.number, third.page.previous_id), (3, second.id))
        nexts = calls(fake, "POST")[1:]
        self.assertEqual([call.path for call in nexts], [f"/v1/fetch/{first.id}/next", f"/v1/fetch/{second.id}/next"])
        self.assertTrue(all(call.json["max_credits"] == 40 for call in nexts))
        self.assertEqual(nexts[1].json["scroll"], 3)
        self.assertNotEqual(nexts[0].json["idempotency_key"], nexts[1].json["idempotency_key"])
        self.assertFalse(third.has_next_page)
        with self.assertRaises(FetchXError) as caught:
            client.next(third)
        self.assertEqual((caught.exception.code, caught.exception.details), ("no_next_page", {"reason": "none_found"}))

    def test_reads_lists_content_screenshots_and_deletes(self):
        fake = shop({f"{SHOP}/shot": FakePage("<html>shot</html>", screenshot=b"\xff\xd8jpeg", rendered=True,
                                              step="browser")})
        client = fake.client()
        result = client.fetch(url=f"{SHOP}/shot", formats=["markdown", "screenshot"], tags=["daily"])
        self.assertEqual((result.screenshot, result.rendered, result.step), (b"\xff\xd8jpeg", True, "browser"))
        self.assertEqual(client.screenshot(result.id), Content(b"\xff\xd8jpeg", "image/jpeg"))
        content = client.content(result)
        self.assertEqual((content.text, content["body"], content["content_type"]),
                         ("<html>shot</html>", b"<html>shot</html>", "text/html; charset=utf-8"))
        self.assertEqual(client.get(result.id).status, "succeeded")
        self.assertEqual(client.get_raw(result.id, include_body=False)["id"], result.id)
        found = client.list(tag="daily", limit=5)
        self.assertEqual([item.id for item in found], [result.id])
        self.assertEqual(client.list(idempotency_key=result.idempotency_key).items[0].id, result.id)
        self.assertIsNone(client.delete(result.id))
        self.assertTrue(client.get(result.id).content_expired)
        with self.assertRaises(FetchXError) as caught:
            client.content(result.id)
        self.assertEqual((caught.exception.code, caught.exception.status), ("content_expired", 410))
        self.assertEqual(calls(fake, "GET", "/v1/fetch")[0].params, {"tag": "daily", "limit": "5"})

    def test_capture_records_the_page_calls_and_next_pages_keep_it_until_turned_off(self):
        api = FakePage("<html><h1>Lamp</h1></html>", next_url=f"{SHOP}/p/2", network=[
            {"url": f"{SHOP}/api/items", "body": {"items": [{"name": "Café Lamp"}]},
             "response_headers": [["Set-Cookie", "sid=abc; Path=/"], ["X-Api-Key", "k123"]]},
            {"url": "https://other.example.net/feed", "body": "x" * 3000, "content_type": "text/plain"}])
        fake = shop({f"{SHOP}/p/1": api})
        client = fake.client()
        result = client.fetch(url=f"{SHOP}/p/1", capture={"first_party_only": True, "max_body_bytes": 1024})
        self.assertTrue(result.rendered)
        self.assertEqual((result.network["captured"], result.network["dropped"]["third_party"]), (2, 1))
        self.assertEqual(result.network["list_url"], f"/v1/fetch/{result.id}/network")
        found = client.network(result, contains="café", first_party=True)
        self.assertEqual([(row["url"], row["matched"]) for row in found], [(f"{SHOP}/api/items", ["café"])])
        headers = client.network_call(result.id, 2).response["headers"]
        self.assertTrue(headers[0][1].startswith("sid=<masked len=3 ") and headers[0][1].endswith("; Path=/"))
        self.assertTrue(headers[1][1].startswith("<masked len=4 "))
        self.assertEqual(calls(fake, "GET", f"/v1/fetch/{result.id}/network")[0].params,
                         {"contains": "café", "first_party": "true"})
        unmasked = client.fetch(url=f"{SHOP}/p/1", capture={"unmask": True, "bodies": "none"})
        call = client.network_call(unmasked, 2)
        self.assertEqual((call.response["headers"][1][1], call.body, call.response["body_omitted"]),
                         ("k123", None, "bodies_none"))
        with self.assertRaises(FetchXError) as caught:
            client.network_body(unmasked, 2)
        self.assertEqual((caught.exception.code, caught.exception.details["reason"]), ("not_found", "bodies_none"))
        second = client.next(result)
        self.assertEqual(second.network["captured"], 1)
        self.assertEqual(client.network(second).items[0]["page"], 2)
        third = client.next(second, capture=None)
        self.assertIsNone(third.network)
        with self.assertRaises(FetchXError) as caught:
            client.network(third)
        self.assertEqual((caught.exception.code, caught.exception.status), ("capture_not_found", 404))
        with self.assertRaises(FetchXError) as caught:
            client.fetch(url=f"{SHOP}/p/1", capture=True, method="POST")
        self.assertEqual(caught.exception.details["field"], "capture")
        self.assertEqual(client.me().project_id, fake.project_id)

    def test_actions_return_their_results_and_a_failed_one_fails_the_request_for_free(self):
        portal = "https://portal.example.com"
        actions = [{"type": "fill", "selector": "#q", "value": "V1"}, {"type": "click", "selector": "#go"},
                   {"type": "evaluate", "script": "document.title"}]
        fake = FakeFetchX({f"{portal}/": FakePage("<html>results for V1</html>", actions=[None, None, {"value": "Results"}],
                                                  blocked_requests=[{"origin": "https://tracker.example.net", "type": "xhr",
                                                                     "action_index": 1}]),
                           f"{portal}/form": FakePage("<html>the form</html>", actions=[
                               None, {"status": "failed", "error": {"code": "selector_not_found",
                                                                    "message": "Nothing matches #go."}}]),
                           f"{portal}/gone": FakePage("<html>gone</html>", status_code=404)}, credits=10)
        client = fake.client()
        result = client.fetch(url=f"{portal}/", actions=actions, allow_hosts=["portal.example.com"],
                              allow_passive_subresources=True)
        self.assertTrue(result.ok)
        self.assertEqual([entry["status"] for entry in result.actions], ["ok", "ok", "ok"])
        self.assertEqual((result.action_values, result.credits, result.attempts[0]["transport"]), (["Results"], 10, "browser"))
        self.assertEqual(result.blocked_requests[0]["origin"], "https://tracker.example.net")
        self.assertEqual(result.passive_offlist_hosts, [])
        failed = client.fetch(url=f"{portal}/form", actions=actions)
        self.assertEqual((failed.error_code, failed.next_action, failed.credits), ("action_failed", "fix_actions", 0))
        self.assertEqual([entry["status"] for entry in failed.actions], ["ok", "failed", "skipped"])
        self.assertEqual(failed.failed_action["error"]["code"], "selector_not_found")
        self.assertIn("the form", failed.body)
        gone = client.fetch(url=f"{portal}/gone", actions=actions)
        self.assertEqual([entry.get("error", {}).get("code", entry["status"]) for entry in gone.actions],
                         ["page_not_ok", "skipped", "skipped"])
        for request, field in (({"allow_hosts": ["other.example.com"]}, "url"), ({"allow_hosts": []}, "allow_hosts"),
                               ({"allow_passive_subresources": True}, "allow_passive_subresources"),
                               ({"actions": actions, "method": "POST"}, "actions"),
                               ({"actions": actions, "render": "never"}, "render"),
                               ({"actions": [{"type": "fly"}]}, "actions[0].type"),
                               ({"actions": [{"type": "fill_secret", "secret": "password"}]}, "actions[0].secret"),
                               ({"action_timeout_ms": 5000}, "action_timeout_ms")):
            with self.assertRaises(FetchXError) as caught:
                client.fetch(url=f"{portal}/", **request)
            self.assertEqual(caught.exception.details["field"], field, request)
        self.assertIn("actions", client.me().raw["features"])

    def test_solve_captcha_actions_report_what_they_solved(self):
        portal = "https://portal.example.com"
        actions = [{"type": "fill", "selector": "#user", "value": "me"}, {"type": "solve_captcha"},
                   {"type": "click", "selector": "#go"}]
        fake = FakeFetchX({f"{portal}/login": FakePage("<html>signed in</html>", actions=[
                               None, {"value": {"type": "recaptcha_v2", "outcome": "passed"}},
                               {"captcha": [{"type": "turnstile", "outcome": "passed"}]}]),
                           f"{portal}/plain": FakePage("<html>no captcha</html>"),
                           f"{portal}/hard": FakePage("<html>the form</html>", actions=[
                               None, {"status": "failed", "error": {"code": "captcha_not_solved",
                                                                    "message": "The recaptcha_v2 captcha was not solved (captcha_timeout)."}}])},
                          credits=10)
        client = fake.client()
        result = client.fetch(url=f"{portal}/login", actions=actions)
        self.assertEqual(result.actions[1]["value"], {"type": "recaptcha_v2", "outcome": "passed"})
        self.assertEqual(result.actions[2]["captcha"], [{"type": "turnstile", "outcome": "passed"}])
        plain = client.fetch(url=f"{portal}/plain", actions=actions)
        self.assertEqual(plain.actions[1]["value"], {"type": None, "outcome": "none"})
        failed = client.fetch(url=f"{portal}/hard", actions=actions)
        self.assertEqual((failed.error_code, failed.credits, failed.failed_action["error"]["code"]),
                         ("action_failed", 0, "captcha_not_solved"))
        self.assertIn("solve_captcha", client.me().raw["features"])

    def test_a_dict_body_and_a_given_key_replay_the_first_result(self):
        fake = shop()
        client = fake.client()
        first = client.fetch({"url": f"{SHOP}/p/1", "idempotency_key": "k1"})
        again = client.fetch({"url": f"{SHOP}/p/1", "idempotency_key": "k1"}, True)
        self.assertEqual(first.id, again.id)
        self.assertEqual((len(fake.site_requests), client.credits_spent), (1, 1))
        with self.assertRaises(FetchXError) as caught:
            client.fetch({"url": f"{SHOP}/p/2", "idempotency_key": "k1"})
        self.assertEqual(caught.exception.code, "idempotency_conflict")


class CreditTests(unittest.TestCase):
    def test_max_credits_caps_fetches_next_pages_batches_and_estimates_that_set_none(self):
        fake = shop()
        client = fake.client(max_credits=25)
        result = client.fetch(url=f"{SHOP}/p/1")
        client.fetch(url=f"{SHOP}/p/1", max_credits=5)
        client.next(result)
        client.submit_batch([f"{SHOP}/p/1"])
        client.estimate(url=f"{SHOP}/p/1")
        client.estimate(items=[f"{SHOP}/p/1"], defaults={"formats": ["text"]})
        bodies = [call.json for call in fake.requests if call.json]
        self.assertEqual([body.get("max_credits") for body in bodies[:3]], [25, 5, 25])
        self.assertEqual(bodies[3]["defaults"], {"max_credits": 25})
        self.assertEqual(bodies[4]["max_credits"], 25)
        self.assertEqual(bodies[5]["defaults"], {"max_credits": 25, "formats": ["text"]})

    def test_spend_limit_lowers_max_credits_to_what_is_left_and_stops_before_sending(self):
        fake = shop(credits=1)
        client = fake.client(spend_limit=3)
        for _ in range(3):
            self.assertTrue(client.fetch(url=f"{SHOP}/p/1").ok)
        self.assertEqual([call.json["max_credits"] for call in calls(fake, "POST")], [3, 2, 1])
        with self.assertRaises(SpendLimitReached) as caught:
            client.fetch(url=f"{SHOP}/p/1")
        self.assertEqual(caught.exception.details, {"spend_limit": 3, "spent": 3, "held": 0})
        self.assertEqual(len(calls(fake, "POST")), 3, "nothing was sent")
        self.assertEqual(client.remaining_credits, 0)

    def test_a_cap_below_the_cheapest_step_is_refused_for_free(self):
        fake = shop({f"{SHOP}/dear": FakePage("<html>dear</html>", credits=60)})
        client = fake.client()
        with self.assertRaises(FetchXError) as caught:
            client.fetch(url=f"{SHOP}/dear", max_credits=10)
        self.assertEqual((caught.exception.code, caught.exception.details),
                         ("max_credits_too_low", {"min_credits": 60}))
        self.assertEqual((client.credits_spent, fake.site_requests), (0, []))

    def test_spend_limit_holds_what_running_requests_may_cost(self):
        fake = shop(pending_polls=3)
        client = fake.client(spend_limit=50, max_credits=30)
        client.fetch(url=f"{SHOP}/p/1", async_=True)
        self.assertEqual(client.remaining_credits, 20)
        second = client.fetch(url=f"{SHOP}/p/2", async_=True)
        self.assertEqual(calls(fake, "POST")[1].json["max_credits"], 20)
        with self.assertRaises(SpendLimitReached):
            client.fetch(url=f"{SHOP}/p/3")
        client.wait(second.id)
        self.assertEqual(client.remaining_credits, 50 - 30 - 1, "the first still holds 30; the second cost 1")

    def test_held_credits_come_back_when_a_call_raises(self):
        fake = shop({f"{SHOP}/dear": FakePage("<html>dear</html>", credits=60)})
        client = fake.client(spend_limit=100)
        with self.assertRaises(FetchXError):
            client.fetch(url=f"{SHOP}/dear", max_credits=10)
        self.assertEqual(client.remaining_credits, 100)

        def broken(_request):
            raise RuntimeError("transport bug")

        events = []
        client = FetchX("https://fetchx.test", "fxk_x", transport=httpx.MockTransport(broken), spend_limit=100,
                        on_call=events.append)
        with self.assertRaises(RuntimeError):
            client.fetch(url=f"{SHOP}/p/1")
        self.assertEqual((client.remaining_credits, events[0].raised), (100, "RuntimeError"))

    def test_batches_under_a_spend_limit_need_caps_and_hold_their_worst_case(self):
        fake = shop(credits=2)
        client = fake.client(spend_limit=10)
        urls = [f"{SHOP}/p/1", f"{SHOP}/p/2", f"{SHOP}/p/3"]
        with self.assertRaises(FetchXError) as caught:
            client.run_batch(urls)
        self.assertEqual((caught.exception.code, caught.exception.details), ("max_credits_required",
                                                                             {"field": "items[0].max_credits"}))
        with self.assertRaises(SpendLimitReached) as caught:
            client.run_batch(urls, defaults={"max_credits": 4})
        self.assertEqual(caught.exception.details["batch_max"], 12)
        self.assertEqual(fake.requests, [], "nothing was sent")
        results = client.run_batch(urls, defaults={"max_credits": 3})
        self.assertTrue(all(result.ok for result in results))
        self.assertEqual((client.credits_spent, client.remaining_credits, client.calls), (6, 4, 3))


class SiteSlotTests(unittest.TestCase):
    def test_single_fetches_go_one_at_a_time_per_site_across_threads(self):
        fake = shop({f"https://www.shop.example.com/p/{i}": f"<html>{i}</html>" for i in range(4)},
                    pending_polls=3)
        client = fake.client(sleep=lambda _s: threading.Event().wait(0.002))
        start = threading.Barrier(4)

        def work(i):
            start.wait()
            client.fetch(url=f"https://www.shop.example.com/p/{i}" if i % 2 else f"{SHOP}/p/{i + 1}")

        threads = [threading.Thread(target=work, args=(i,)) for i in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(10)
        self.assertEqual(fake.peak_running, {"shop.example.com": 1})
        self.assertEqual(client.calls, 4)


class HookTests(unittest.TestCase):
    def test_on_call_gets_one_event_per_call_with_id_credits_and_step(self):
        events = []
        fake = shop(pending_polls=1).unavailable(1, path="/v1/balance")
        client = fake.client(on_call=events.append)
        result = client.fetch(url=f"{SHOP}/p/1", idempotency_key="k-hook")
        client.balance()
        with self.assertRaises(FetchXError):
            client.get("missing-id")
        fetched, balance, missing = events
        self.assertEqual((fetched.op, fetched.ok, fetched.fetch_id, fetched.credits, fetched.step, fetched.polls,
                          fetched.idempotency_key, fetched.url, fetched.status),
                         ("fetch", True, result.id, 1, "http", 1, "k-hook", f"{SHOP}/p/1", "succeeded"))
        self.assertEqual((balance.op, balance.requests, balance.resends), ("balance", 2, 1))
        self.assertEqual((missing.ok, missing.raised, missing.http_status), (False, "not_found", 404))

    def test_a_failing_hook_is_logged_and_the_call_still_returns(self):
        def broken(_event):
            raise RuntimeError("hook bug")

        with self.assertLogs("fetchx", "ERROR"):
            self.assertTrue(shop().client(on_call=broken).fetch(url=f"{SHOP}/p/1").ok)


class BatchTests(unittest.TestCase):
    def test_items_and_defaults_cannot_set_what_only_the_batch_sets(self):
        fake = shop()
        client = fake.client()
        for item, field in (({"url": f"{SHOP}/p/1", "idempotency_key": "k"}, "items[1].idempotency_key"),
                            ({"url": f"{SHOP}/p/1", "async": True}, "items[1].async"),
                            ({"url": f"{SHOP}/p/1", "webhook_url": "https://hooks.example.com/"},
                             "items[1].webhook_url"),
                            ({"formats": ["text"]}, "items[1]")):
            with self.assertRaises(FetchXError) as caught:
                client.submit_batch([f"{SHOP}/p/2", item])
            self.assertEqual(caught.exception.details, {"field": field})
        with self.assertRaises(FetchXError) as caught:
            client.submit_batch([f"{SHOP}/p/2"], defaults={"url": f"{SHOP}/p/1"})
        self.assertEqual(caught.exception.details, {"field": "defaults.url"})
        with self.assertRaises(FetchXError):
            client.submit_batch([])
        with self.assertRaises(FetchXError):
            client.submit_batch([f"{SHOP}/p/1"] * 1001)
        self.assertEqual(fake.requests, [])

    def test_run_batch_returns_one_result_per_item_in_order(self):
        fake = shop({f"{SHOP}/dear": FakePage("<html>dear</html>", credits=90)}, batch_step=1)
        fake.fail(f"{SHOP}/p/2", "blocked")
        client = fake.client()
        results = client.run_batch([f"{SHOP}/p/1", f"{SHOP}/p/2", {"url": f"{SHOP}/dear", "max_credits": 10},
                                    {"url": f"{SHOP}/p/3", "formats": ["markdown"]}], tags=["nightly"],
                                   idempotency_key="nightly-1")
        first, second, never, third = results
        self.assertEqual((first.ok, first.body, first.batch["index"]), (True, "<html><h1>Lamp</h1></html>", 0))
        self.assertEqual((second.failed, second.error_code), (True, "blocked"))
        self.assertIsNone(never, "refused before it started, nothing ran")
        self.assertEqual((third.markdown, third.body), ("Chair", None))
        submit = calls(fake, "POST", "/v1/batches")[0].json
        self.assertEqual((submit["idempotency_key"], submit["tags"]), ("nightly-1", ["nightly"]))
        self.assertEqual((client.credits_spent, client.calls), (2, 4))

    def test_results_feed_wait_cancel_and_list(self):
        fake = shop(batch_step=1)
        client = fake.client()
        urls = [f"{SHOP}/p/1", f"{SHOP}/p/2", f"{SHOP}/p/3"]
        batch = client.submit_batch(urls, defaults={"formats": ["markdown"]})
        self.assertEqual((batch.status, batch.total), ("running", 3))
        seen = [item.index for item in client.batch_results(batch.id, limit=1)]
        self.assertEqual(sorted(seen), [0, 1, 2])
        self.assertTrue(client.wait_batch(batch.id).done)
        page = client.batch_items(batch, limit=2, results=False)
        self.assertEqual(([item.index for item in page], page.next_cursor, page.items[0].result), ([0, 1], "2", None))
        self.assertEqual(client.batch_items(batch.id, cursor=page.next_cursor).items[0].index, 2)
        again = client.submit_batch(urls, defaults={"formats": ["markdown"]}, idempotency_key=batch.idempotency_key)
        self.assertEqual(again.id, batch.id)
        self.assertEqual(client.calls, 3, "a replayed key queues nothing new")

        other = client.submit_batch(urls)
        canceled = client.cancel_batch(other.id)
        self.assertEqual((canceled.status, canceled.done), ("canceled", True))
        self.assertEqual(client.get_batch(other.id).items["canceled"] + client.batch(other.id).items["succeeded"], 3)
        self.assertEqual([b.id for b in client.list_batches(limit=5)], [other.id, batch.id])
        self.assertEqual(client.wait_batch(other.id).status, "canceled")


class ModelTests(unittest.TestCase):
    def test_results_read_like_the_json_they_came_from(self):
        fake = shop()
        result = fake.client().fetch(url=f"{SHOP}/p/1", formats=["markdown", "links", "metadata"])
        self.assertEqual(result["data"]["markdown"], "# Lamp")
        self.assertIsNone(result.get("error"))
        self.assertIn("credits", result)
        self.assertEqual(result.to_dict(), result.raw)
        self.assertEqual(FetchResult(result.raw), FetchResult(result.raw))
        self.assertIn("status='succeeded'", repr(result))
        self.assertEqual((result.links, result.metadata, result.tags), ([], {}, []))

    def test_results_and_errors_built_by_hand(self):
        raw = {"id": "local-1", "url": f"{SHOP}/p/1", "status": "succeeded", "page_status": "content",
               "credits": {"charged": 0, "breakdown": {"step": "local"}},
               "data": {"status_code": 200, "content_type": "Text/HTML", "body_bytes": 7, "rendered": False}}
        text = FetchResult(raw, "<p>Café")
        self.assertEqual((text.body, text.content), ("<p>Café", "<p>Café".encode()))
        self.assertEqual((text.ok, text.source_status, text.final_url, text.content_type, text.body_bytes,
                          text.credits, text.step, text.challenge, text.rendered),
                         (True, 200, f"{SHOP}/p/1", "text/html", 7, 0, "local", None, False))
        self.assertEqual(FetchResult(raw, b"<p>Lamp").body, "<p>Lamp")
        self.assertIsNone(FetchResult(raw).body)
        error = FetchXError("local_no_browser", "plain HTTP only", 400, {"field": "render"}, 30)
        self.assertEqual((error.code, error.message, error.http_status, error.details, error.retry_after),
                         ("local_no_browser", "plain HTTP only", 400, {"field": "render"}, 30))
        self.assertTrue(error.refused)

    def test_bodies_decode_with_the_page_charset(self):
        page = FakePage("Café".encode("latin-1"), content_type="text/html; charset=ISO-8859-1")
        result = shop({f"{SHOP}/latin": page}).client().fetch(url=f"{SHOP}/latin", want_body=True)
        self.assertEqual(result.body, "Café")
        self.assertEqual(Content(b"\xff", "text/plain; charset=nonsense").text, "�")

    def test_estimates_balance_usage_and_status(self):
        fake = shop({f"{SHOP}/dear": FakePage("x", credits=50)})
        client = fake.client()
        estimate = client.estimate(items=[f"{SHOP}/p/1", {"url": f"{SHOP}/dear", "max_credits": 5}])
        self.assertEqual((estimate.kind, estimate.requests, estimate.estimated, estimate.credits.typical),
                         ("batch", 2, 1, 1))
        self.assertEqual(estimate.items[1]["error"]["code"], "max_credits_too_low")
        self.assertTrue(estimate.covers_expected)
        client.fetch(url=f"{SHOP}/p/1")
        self.assertEqual(client.balance().credits, 1_000_000 - 1)
        self.assertEqual(client.usage(period="day").credits_used, 1)
        self.assertEqual(calls(fake, "GET", "/v1/usage")[0].params, {"period": "day"})
        own = client.usage(key_id=fake.key_id)
        self.assertEqual((own.key_id, own.key_ids, client.usage().key_id), (fake.key_id, [fake.key_id], None))
        with self.assertRaises(FetchXError) as caught:
            client.usage(key_id="00000000-0000-4000-8000-000000000000")
        self.assertEqual(caught.exception.details, {"field": "key_id"})
        self.assertTrue(client.status().operational)


if __name__ == "__main__":
    unittest.main()
