"""An in-memory FetchX for offline tests: no network, no credits, no key.

    from fetchx.testing import FakeFetchX

    fake = FakeFetchX({"https://shop.example.com/p/1": "<html><h1>Lamp</h1></html>"})
    fx = fake.client()                    # a FetchX that talks to the fake and never sleeps
    result = fx.fetch(url="https://shop.example.com/p/1")
    assert result.ok and result.body.startswith("<html>")
    assert [r["url"] for r in fake.site_requests] == ["https://shop.example.com/p/1"]

It answers in the shapes of the public contract (docs/openapi.json, which the SDK's tests hold
it to): 202 and polling, idempotency-key replay and conflicts, next pages, stored content and
screenshots, network captures (``capture``: the page's own calls, given with ``FakePage(network=...)``),
batches with paged items, estimates, balance, usage, status, the calling key (``me``) and credits
on every result. Tests can make it fail a fetch (``fail``), refuse calls (``refuse``, ``unavailable``)
or lose answers (``drop``) to exercise the rules around them. Pages are whatever you give it;
it knows nothing about any real site.
"""
from __future__ import annotations

import base64
import hashlib
import json
import re
import threading
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, List, NamedTuple, Optional, Tuple, Union
from urllib.parse import parse_qs, parse_qsl, unquote, urlsplit

import httpx

from ._core import site_of
from .aio import AsyncFetchX
from .client import FetchX

FETCH_FIELDS = frozenset({"url", "method", "headers", "body", "body_base64", "render", "wait_for", "scroll", "country",
                          "route", "formats", "block_resources", "expect", "extract", "max_attempts", "fix_headers",
                          "max_credits", "timeout_ms", "async", "webhook_url", "idempotency_key", "tags", "capture"})
NEXT_FIELDS = frozenset({"scroll", "expect", "capture", "max_credits", "timeout_ms", "async", "webhook_url", "idempotency_key",
                         "tags"})
FORMATS = frozenset({"body", "markdown", "text", "links", "metadata", "skeleton", "screenshot"})
FEEDBACK_FIELDS = frozenset({"fetch_id", "url", "method", "kind", "message", "evidence"})
FEEDBACK_KINDS = frozenset({"blocked_via_fetchx_ok_from_home", "wrong_content", "extract_wrong", "other"})
FEEDBACK_EVIDENCE = frozenset({"status_code", "final_url", "content_type", "body_excerpt", "client"})
FAILURE_CODES = frozenset({"blocked", "rate_limited", "content_missing", "login_required", "site_error", "unreachable",
                           "cooling_down", "timeout", "too_large", "uncertain", "route_unavailable", "url_not_allowed",
                           "next_page_missing", "extract_unavailable"})
NEXT_ACTIONS = frozenset({"retry_after", "retry_later", "check_expect", "use_auto", "provide_credentials", "check_url",
                          "raise_timeout", "render_never", "recover", "refetch_previous"})
_ATTEMPT_RESULTS = frozenset({"blocked", "rate_limited", "login_required", "site_error", "content_missing",
                              "unreachable", "too_large", "uncertain", "url_not_allowed"})
FAKE_JPEG = b"\xff\xd8\xff\xe0fake-jpeg\xff\xd9"
CAPTURE_TYPES = ("document", "xhr", "fetch", "script", "eventsource", "other")
CAPTURE_DEFAULTS: Dict[str, Any] = {"types": ["document", "xhr", "fetch"], "max_requests": 200,
                                    "max_body_bytes": 2_000_000, "bodies": "text", "first_party_only": False,
                                    "include_trackers": False, "unmask": False}
CAPTURE_NEEDS_BROWSER = "capture records what a browser loads: use render always or auto with GET"
_CAPTURE_TOTAL_BYTES = 25_000_000
_INLINE_BODY_BYTES = 1_000_000
_NETWORK_QUERY = frozenset({"type", "content_type", "host", "first_party", "status", "page", "phase", "contains",
                            "limit", "cursor"})
_TEXT_BODY = re.compile(r"^(?:text/|application/(?:json|[a-z0-9.+-]+\+json|x-ndjson|ndjson|xml|[a-z0-9.+-]+\+xml|"
                        r"javascript|x-javascript|ecmascript|graphql|x-www-form-urlencoded))", re.I)
_SECRET_HEADER = re.compile(r"token|secret|api[-_]?key|session|password|credential", re.I)


class FakePage:
    """What the fake 'site' answers for a URL."""

    def __init__(self, body: Union[str, bytes] = "", *, status_code: int = 200,
                 content_type: Optional[str] = "text/html; charset=utf-8", markdown: Optional[str] = None,
                 text: Optional[str] = None, links: Optional[List[dict]] = None, metadata: Optional[dict] = None,
                 extract: Any = None, next_url: Optional[str] = None, next_how: Optional[str] = None,
                 credits: Optional[int] = None, step: Optional[str] = None, rendered: bool = False,
                 headers: Optional[Dict[str, str]] = None, cookies: Optional[List[dict]] = None,
                 screenshot: Optional[bytes] = None, page_status: Optional[str] = None,
                 network: Optional[List[dict]] = None):
        self.content = body.encode("utf-8") if isinstance(body, str) else bytes(body)
        self.status_code = status_code
        self.content_type = content_type
        self.markdown, self.text, self.links, self.metadata = markdown, text, links, metadata
        self.extract = extract
        self.next_url = next_url
        self.next_how = next_how or ("link" if next_url else None)
        self.credits, self.step, self.rendered = credits, step, rendered
        self.headers, self.cookies = headers or {}, cookies or []
        self.screenshot = screenshot
        self.page_status = page_status
        # The calls the page makes after its own document, as a request made with capture records
        # them: dicts with "url" and optionally "method" (GET), "type" (fetch), "status" (200),
        # "content_type" (application/json), "body" (str, bytes, or a dict or list sent as JSON),
        # "request_headers" and "response_headers" (dicts or name/value pairs), "request_body",
        # "frame" (main), "tracker" (False) and "error" (None, or why no response came).
        self.network = network or []


PageLike = Union[FakePage, str, bytes, Tuple[int, str, Union[str, bytes]], Callable[[dict], Any], None]


class FakeCall(NamedTuple):
    """One HTTP request the client sent to the fake."""
    method: str
    path: str
    params: Dict[str, str]
    json: Any


class _Rule:
    def __init__(self, times: int, method: Optional[str], path: Optional[str], **spec: Any):
        self.left, self.method, self.path, self.spec = times, method, path, spec

    def matches(self, method: str, path: str) -> bool:
        return self.left > 0 and (self.method is None or self.method == method) and (
            self.path is None or re.fullmatch(self.path, path) is not None)


class FakeFetchX:
    """An in-memory FetchX v1. ``pages`` maps URLs to what the site answers (see ``add``)."""

    base_url = "https://fetchx.test"
    project_id = "cp_00000000-0000-4000-8000-0000000000fa"   # what GET /v1/me names
    key_id = "00000000-0000-4000-8000-0000000000fb"

    def __init__(self, pages: Optional[Dict[str, PageLike]] = None, *, credits: int = 1, step: str = "http",
                 pending_polls: int = 0, balance: Optional[int] = 1_000_000, batch_step: int = 2,
                 token: Optional[str] = None, dearest_step: int = 150):
        self.pages: Dict[str, PageLike] = {}
        for url, page in (pages or {}).items():
            self.add(url, page)
        self.credits, self.step, self.pending_polls = credits, step, pending_polls
        self.balance = balance  # None: an unmetered project
        self.batch_step = batch_step
        self.token = token
        self.dearest_step = dearest_step
        self.requests: List[FakeCall] = []       # every call the client made
        self.site_requests: List[dict] = []      # every request that 'reached the site', in order
        self.peak_running: Dict[str, int] = {}   # most requests running at once per site, seen at each POST
        self._results: Dict[str, dict] = {}      # id -> state
        self._order: List[str] = []
        self._keys: Dict[str, Tuple[str, str]] = {}
        self._batches: Dict[str, dict] = {}
        self._batch_keys: Dict[str, Tuple[str, str]] = {}
        self.feedback: Dict[str, dict] = {}      # id -> report, as POST /v1/feedback stored it
        self._failures: Dict[str, List[dict]] = {}
        self._refusals: List[_Rule] = []
        self._drops: List[_Rule] = []
        self._lock = threading.RLock()
        self._clock = datetime(2026, 1, 1, tzinfo=timezone.utc)

    # ----------------------------------------------------------------- set-up

    def add(self, url: str, page: PageLike = None, **fields: Any) -> FakeFetchX:
        """What the site answers for ``url``: a FakePage, a body (str or bytes), a tuple
        ``(status_code, content_type, body)``, or a function of the request returning one of
        those (or None for a 404). Keyword fields build a FakePage: ``add(url, "<html>", next_url=...)``."""
        if fields:
            page = FakePage(page if isinstance(page, (str, bytes)) else "", **fields)
        self.pages[url] = page
        return self

    def fail(self, url: str, code: str = "blocked", *, action: Optional[str] = None,
             retry_with_new_key: Optional[bool] = None, retry_after_seconds: Optional[int] = None,
             page_status: Optional[str] = None, vendor: Optional[str] = None, times: int = 1) -> FakeFetchX:
        """The next ``times`` fetches of ``url`` run and fail with ``code`` (HTTP 200, status failed)."""
        if code not in FAILURE_CODES:
            raise ValueError(f"not a FetchX failure code: {code}")
        if action is not None and action not in NEXT_ACTIONS:
            raise ValueError(f"not a FetchX next action: {action}")
        spec = {"code": code, "action": action or ("retry_later" if code in ("blocked", "rate_limited", "site_error",
                                                                              "timeout", "unreachable", "cooling_down")
                                                     else "check_url"),
                "retry_with_new_key": retry_with_new_key, "retry_after_seconds": retry_after_seconds,
                "page_status": page_status or ("challenge" if code in ("blocked", "rate_limited") else "error"),
                "vendor": vendor, "times": times}
        if spec["retry_with_new_key"] is None:
            spec["retry_with_new_key"] = spec["action"] in ("retry_after", "retry_later")
        self._failures.setdefault(url, []).append(spec)
        return self

    def refuse(self, status: int, code: str, *, message: str = "", details: Optional[dict] = None,
               retry_after_seconds: Optional[int] = None, times: int = 1, method: Optional[str] = None,
               path: Optional[str] = None) -> FakeFetchX:
        """Answer the next ``times`` matching calls (``path`` is a regular expression) with an
        HTTP error: ``refuse(402, "insufficient_credits")``, ``refuse(429, "too_many_requests")``."""
        self._refusals.append(_Rule(times, method, path, status=status, code=code, message=message or code,
                                    details=details, retry_after_seconds=retry_after_seconds))
        return self

    def unavailable(self, times: int = 1, *, code: str = "unavailable", retry_after_seconds: Optional[int] = 0,
                    method: Optional[str] = None, path: Optional[str] = None) -> FakeFetchX:
        """Answer the next ``times`` matching calls with 503 (``code`` may be ``maintenance``)."""
        return self.refuse(503, code, retry_after_seconds=retry_after_seconds, times=times, method=method, path=path)

    def drop(self, times: int = 1, *, method: Optional[str] = None, path: Optional[str] = None) -> FakeFetchX:
        """Carry out the next ``times`` matching calls, then lose their answers (a read timeout)."""
        self._drops.append(_Rule(times, method, path))
        return self

    def transport(self) -> httpx.MockTransport:
        """An httpx transport for ``FetchX(transport=...)`` or ``AsyncFetchX(transport=...)``."""
        return httpx.MockTransport(self.handler)

    def client(self, **options: Any) -> FetchX:
        """A FetchX wired to this fake that never sleeps."""
        options.setdefault("sleep", lambda seconds: None)
        options.setdefault("poll_every", 0)
        return FetchX(self.base_url, self.token or "fxk_fake", transport=self.transport(), **options)

    def async_client(self, **options: Any) -> AsyncFetchX:
        """An AsyncFetchX wired to this fake that never sleeps."""
        options.setdefault("sleep", lambda seconds: None)
        options.setdefault("poll_every", 0)
        return AsyncFetchX(self.base_url, self.token or "fxk_fake", transport=self.transport(), **options)

    def result(self, fetch_id: str) -> dict:
        """The full stored result for an id, as GET /v1/fetch/{id} would show it once finished."""
        with self._lock:
            return self._view(self._results[fetch_id], body=True, force=True)

    # ----------------------------------------------------------------- the API

    def handler(self, request: httpx.Request) -> httpx.Response:
        method, path = request.method, request.url.raw_path.decode("ascii").split("?", 1)[0]
        query = parse_qs(request.url.query.decode())
        params = {key: values[-1] for key, values in query.items()}
        try:
            payload = json.loads(request.content) if request.content else None
        except ValueError:
            payload = None
        with self._lock:
            self.requests.append(FakeCall(method, path, params, payload))
            if path not in ("/v1/status", "/v1/prices"):
                auth = request.headers.get("authorization", "")
                if not auth.startswith("Bearer ") or (self.token and auth != "Bearer " + self.token):
                    return _error(401, "unauthorized", "A valid API key is required")
            for rule in self._refusals:
                if rule.matches(method, path):
                    rule.left -= 1
                    spec = rule.spec
                    after = spec["retry_after_seconds"]
                    headers = {} if after is None else {"retry-after": str(after)}
                    return _error(spec["status"], spec["code"], spec["message"], spec["details"],
                                  spec["retry_after_seconds"], headers)
            response = self._route(method, path, params, payload, query, request.headers.get("authorization", ""))
            for rule in self._drops:
                if rule.matches(method, path):
                    rule.left -= 1
                    raise httpx.ReadTimeout("fake FetchX: the answer was lost", request=request)
            return response

    def _route(self, method: str, path: str, params: dict, payload: Any, query: Optional[dict] = None,
               auth: str = "") -> httpx.Response:
        parts = [unquote(part) for part in path.strip("/").split("/")]
        if parts[:1] != ["v1"]:
            return _error(404, "route_not_found", "There is no such route")
        rest = parts[1:]
        if rest == ["fetch"] and method == "POST":
            return self._post_fetch(payload)
        if rest == ["fetch"] and method == "GET":
            return self._list(params)
        if len(rest) == 2 and rest[0] == "fetch" and method == "GET":
            return self._get(rest[1], params.get("include_body") != "false")
        if len(rest) == 2 and rest[0] == "fetch" and method == "DELETE":
            return self._delete(rest[1])
        if len(rest) == 3 and rest[0] == "fetch" and rest[2] == "next" and method == "POST":
            return self._post_next(rest[1], payload)
        if len(rest) == 3 and rest[0] == "fetch" and rest[2] in ("content", "screenshot") and method == "GET":
            return self._stored(rest[1], rest[2])
        if len(rest) == 3 and rest[0] == "fetch" and rest[2] == "network" and method == "GET":
            return self._network_list(rest[1], query or {})
        if len(rest) == 3 and rest[0] == "fetch" and rest[2] == "network.har" and method == "GET":
            return self._network_har(rest[1], query or {})
        if len(rest) == 4 and rest[0] == "fetch" and rest[2] == "network" and method == "GET":
            return self._network_call(rest[1], rest[3])
        if len(rest) == 5 and rest[0] == "fetch" and rest[2] == "network" and rest[4] == "body" and method == "GET":
            return self._network_body(rest[1], rest[3])
        if rest == ["batches"] and method == "POST":
            return self._post_batch(payload)
        if rest == ["batches"] and method == "GET":
            return self._list_batches(params)
        if len(rest) == 2 and rest[0] == "batches" and method == "GET":
            return self._with_batch(rest[1], lambda batch: _json(200, self._batch_view(batch)))
        if len(rest) == 3 and rest[0] == "batches" and rest[2] == "items" and method == "GET":
            return self._with_batch(rest[1], lambda batch: self._batch_items(batch, params))
        if len(rest) == 3 and rest[0] == "batches" and rest[2] == "cancel" and method == "POST":
            return self._with_batch(rest[1], self._cancel)
        if rest == ["estimate"] and method == "POST":
            return self._estimate(payload)
        if rest == ["balance"] and method == "GET":
            return _json(200, self._balance())
        if rest == ["usage"] and method == "GET":
            return _json(200, self._usage())
        if rest == ["status"] and method == "GET":
            return _json(200, self._status())
        if rest == ["prices"] and method == "GET":
            return _json(200, self._prices())
        if rest == ["me"] and method == "GET":
            return _json(200, self._me(auth))
        if rest == ["feedback"] and method == "POST":
            return self._post_feedback(payload)
        if len(rest) == 2 and rest[0] == "feedback" and method == "GET":
            report = self.feedback.get(rest[1])
            return _json(200, report) if report else _error(404, "not_found", "Nothing with that id in this project")
        return _error(404, "route_not_found", "There is no such route")

    # ----------------------------------------------------------------- fetches

    def _post_fetch(self, body: Any) -> httpx.Response:
        refused = self._check_fetch(body)
        if refused:
            return refused
        key = body.get("idempotency_key") or str(uuid.uuid4())
        replay = self._replay(key, body)
        if replay is not None:
            return replay
        outcome = self._run(dict(body), key)
        if isinstance(outcome, httpx.Response):
            return outcome
        self._keys[key] = (outcome["id"], _fingerprint(body))
        return self._answer(outcome)

    def _check_fetch(self, body: Any) -> Optional[httpx.Response]:
        if not isinstance(body, dict):
            return _invalid("body")
        for key in body:
            if key not in FETCH_FIELDS:
                return _invalid(key)
        url = body.get("url")
        if not isinstance(url, str) or not re.match(r"^https?://[^/\s]+", url):
            return _invalid("url")
        return self._check_common(body) or _check_capture(body)

    def _check_common(self, body: dict) -> Optional[httpx.Response]:
        formats = body.get("formats")
        if formats is not None and (not isinstance(formats, list) or not set(formats) <= FORMATS
                                    or len(set(formats)) != len(formats)):
            return _invalid("formats")
        cap = body.get("max_credits")
        if cap is not None and (not isinstance(cap, int) or isinstance(cap, bool) or not 1 <= cap <= 100_000):
            return _invalid("max_credits")
        tags = body.get("tags")
        if tags is not None and (not isinstance(tags, list) or len(tags) > 10):
            return _invalid("tags")
        key = body.get("idempotency_key")
        if key is not None and not isinstance(key, str):
            return _invalid("idempotency_key")
        return None

    def _replay(self, key: str, body: dict, scope: str = "") -> Optional[httpx.Response]:
        known = self._keys.get(scope + key)
        if known is None:
            return None
        fetch_id, fingerprint = known
        if fingerprint != _fingerprint(body):
            return _error(409, "idempotency_conflict", "This idempotency_key was used before with a different request")
        return self._answer(self._results[fetch_id], replay=True)

    def _answer(self, state: dict, replay: bool = False) -> httpx.Response:
        pending = state["polls_left"] > 0
        return _json(202 if pending else 200, self._view(state, body=True))

    def _page(self, url: str, request: dict) -> FakePage:
        page = self.pages.get(url)
        if callable(page):
            page = page(request)
        if page is None:
            return FakePage("<html><body>Not found</body></html>", status_code=404)
        if isinstance(page, FakePage):
            return page
        if isinstance(page, tuple):
            status_code, content_type, body = page
            return FakePage(body, status_code=status_code, content_type=content_type)
        return FakePage(page)

    def _run(self, request: dict, key: str, *, previous: Optional[dict] = None,
             batch: Optional[Tuple[str, int]] = None) -> Union[dict, httpx.Response]:
        """Admit a request (or refuse it), 'fetch' it and store the result."""
        url = request["url"]
        page = self._page(url, request)
        failures = self._failures.get(url) or []
        failure = failures[0] if failures else None
        price = page.credits if page.credits is not None else self.credits
        cap = request.get("max_credits")
        if failure is None and cap is not None and price > cap:
            return _error(402, "max_credits_too_low", "max_credits is below the cheapest step",
                          {"min_credits": price})
        if failure is None and self.balance is not None and self.balance < price:
            return _error(402, "insufficient_credits", "The balance is below the cheapest step")
        site = site_of(url) or url
        running = sum(1 for state in self._results.values()
                      if state["polls_left"] > 0 and state["site"] == site) + 1
        self.peak_running[site] = max(self.peak_running.get(site, 0), running)
        self.site_requests.append(dict(request))
        fetch_id = str(uuid.uuid4())
        created = self._tick()
        state = {"id": fetch_id, "key": key, "request": request, "page": page, "site": site, "created": created,
                 "finished": self._tick(), "polls_left": 0 if batch else
                 (max(self.pending_polls, 1) if request.get("async") else self.pending_polls),
                 "deleted": False, "batch": batch, "number": previous["number"] + 1 if previous else 1,
                 "previous_id": previous["id"] if previous else None}
        if failure is not None:
            failure["times"] -= 1
            if failure["times"] <= 0:
                failures.pop(0)
            state.update(failure=failure, charged=0)
        else:
            state.update(failure=None, charged=price)
            if self.balance is not None:
                self.balance -= price
        self._results[fetch_id] = state
        self._order.append(fetch_id)
        return state

    def _view(self, state: dict, *, body: bool, force: bool = False) -> dict:
        """The FetchResult JSON for a stored request."""
        request, page, failure = state["request"], state["page"], state["failure"]
        cap = request.get("max_credits")
        base = {"id": state["id"], "idempotency_key": state["key"], "url": request["url"],
                "created_at": _iso(state["created"]), "tags": list(request.get("tags") or []),
                "batch": {"id": state["batch"][0], "index": state["batch"][1]} if state["batch"] else None,
                "attempts": [], "skipped": [], "fixes": [], "challenge": None, "error": None, "data": None}
        credits = {"charged": 0, "max": None if self.balance is None else (cap or self.dearest_step),
                   "balance": self.balance, "breakdown": None}
        captured = _capture_settings(request.get("capture")) is not None
        if captured:
            base["network"] = None
        if state["polls_left"] > 0 and not force:
            return {**base, "status": "pending", "page_status": None, "finished_at": None, "credits": credits}
        base["finished_at"] = _iso(state["finished"])
        if captured:
            base["network"] = self._network_summary(state)
        formats = request.get("formats") or ["body"]
        if failure is not None:
            walled = failure["page_status"] == "challenge"
            status_code = 429 if failure["code"] == "rate_limited" else 403 if walled else None
            error = {"code": failure["code"], "message": f"fake failure: {failure['code']}",
                     "next": {"action": failure["action"], "retry_with_new_key": failure["retry_with_new_key"],
                              "detail": f"fake next step: {failure['action']}"}}
            if failure["retry_after_seconds"] is not None:
                error["next"]["retry_after_seconds"] = failure["retry_after_seconds"]
            last: Optional[Dict[str, Any]] = None  # what the site last answered
            if status_code is not None:
                wall = b"<html><body>fake wall</body></html>"
                last = {"status_code": status_code, "final_url": request["url"], "content_type": "text/html",
                        "rendered": captured, "body_bytes": len(wall)}
                if state["deleted"]:
                    last["content_expired"] = True
                elif body and "body" in formats:
                    last.update(body=wall.decode(), body_encoding="utf-8")
            attempt = {"transport": "browser" if captured else "http", "class": "datacenter", "country": "US",
                       "result": failure["code"] if failure["code"] in _ATTEMPT_RESULTS else "failed",
                       "status_code": status_code, "ms": 100}
            if walled and failure["vendor"]:
                attempt["challenge"] = failure["vendor"]
            return {**base, "status": "failed", "page_status": failure["page_status"], "data": last, "error": error,
                    "attempts": [attempt], "credits": credits,
                    "challenge": {"vendor": failure["vendor"], "walls": 1, "passed": False, "passed_by": None}
                    if walled else None}
        status_code = page.status_code
        page_status = page.page_status or ("content" if status_code < 400 else
                                           "not_found" if status_code in (404, 410) else "error")
        data: Dict[str, Any] = {"status_code": status_code, "final_url": request["url"],
                                "content_type": page.content_type, "rendered": page.rendered or captured,
                                "body_bytes": len(page.content)}
        if state["deleted"]:
            data["content_expired"] = True
        else:
            data.update(page={"number": state["number"], "previous_id": state["previous_id"], "screens": 0,
                              "end": None},
                        headers=dict(page.headers), cookies=list(page.cookies),
                        next_page={"how": page.next_how, **({"url": page.next_url} if page.next_url else {})}
                        if page.next_how else None)
            if body and "body" in formats:
                try:
                    data.update(body=page.content.decode("utf-8"), body_encoding="utf-8")
                except UnicodeDecodeError:
                    data.update(body=base64.b64encode(page.content).decode(), body_encoding="base64")
            text = page.content.decode("utf-8", "replace")
            if "markdown" in formats:
                data["markdown"] = page.markdown if page.markdown is not None else _plain(text)
            if "text" in formats:
                data["text"] = page.text if page.text is not None else _plain(text)
            if "links" in formats:
                data["links"] = list(page.links or [])
            if "metadata" in formats:
                data["metadata"] = dict(page.metadata or {})
            if "skeleton" in formats:
                data["skeleton"] = _skeleton(page.content)
            if "screenshot" in formats:
                data["screenshot"] = base64.b64encode(page.screenshot or FAKE_JPEG).decode()
            if "extract" in request:
                data["extract"] = page.extract
        step = page.step or self.step
        credits["charged"] = state["charged"]
        credits["breakdown"] = {"step": step, "step_credits": state["charged"], "captcha_credits": 0,
                                "traffic_mb": 0.1, "included_mb": None, "traffic_credits": 0,
                                "extract_tokens": None, "extract_credits": 0}
        attempt = {"transport": "browser" if step.startswith("browser") or captured else "http",
                   "class": "residential" if step.endswith("residential") else "datacenter", "country": "US",
                   "result": "success", "status_code": status_code, "ms": 100}
        return {**base, "status": "succeeded", "page_status": page_status, "data": data, "credits": credits,
                "attempts": [attempt]}

    def _find(self, fetch_id: str) -> Optional[dict]:
        return self._results.get(fetch_id)

    def _get(self, fetch_id: str, include_body: bool) -> httpx.Response:
        state = self._find(fetch_id)
        if state is None:
            return _error(404, "not_found", "Nothing with that id in this project")
        if state["polls_left"] > 0:
            state["polls_left"] -= 1
            if state["polls_left"] > 0:
                return _json(202, self._view(state, body=False))
            state["finished"] = self._tick()
        return _json(200, self._view(state, body=include_body))

    def _list(self, params: dict) -> httpx.Response:
        items = [self._results[fetch_id] for fetch_id in reversed(self._order)]
        if params.get("status"):
            items = [state for state in items if self._view(state, body=False)["status"] == params["status"]]
        if params.get("tag"):
            items = [state for state in items if params["tag"] in (state["request"].get("tags") or [])]
        if params.get("idempotency_key"):
            items = [state for state in items if state["key"] == params["idempotency_key"]]
        return _paged(items, params, self._summary)

    def _summary(self, state: dict) -> dict:
        view = self._view(state, body=False)
        return {"id": view["id"], "status": view["status"], "url": view["url"], "created_at": view["created_at"],
                "credits": {"charged": view["credits"]["charged"]}, "tags": view["tags"],
                "error_code": (view["error"] or {}).get("code"), "idempotency_key": view["idempotency_key"]}

    def _delete(self, fetch_id: str) -> httpx.Response:
        state = self._find(fetch_id)
        if state is None:
            return _error(404, "not_found", "Nothing with that id in this project")
        if state["polls_left"] > 0:
            return _error(409, "pending", "The request is still running")
        state["deleted"] = True
        return httpx.Response(204)

    def _stored(self, fetch_id: str, what: str) -> httpx.Response:
        state = self._find(fetch_id)
        if state is None:
            return _error(404, "not_found", "Nothing with that id in this project")
        if state["polls_left"] > 0:
            return _error(409, "pending", "The request is still running")
        if state["deleted"]:
            return _error(410, "content_expired", "The stored content has expired or was deleted")
        if what == "screenshot":
            if "screenshot" not in (state["request"].get("formats") or []):
                return _error(404, "not_found", "That request has no screenshot")
            return httpx.Response(200, content=state["page"].screenshot or FAKE_JPEG,
                                  headers={"content-type": "image/jpeg"})
        if state["failure"] is not None:
            return httpx.Response(200, content=b"<html><body>fake wall</body></html>",
                                  headers={"content-type": "text/html"})
        page = state["page"]
        return httpx.Response(200, content=page.content,
                              headers={"content-type": page.content_type or "application/octet-stream"})

    def _post_next(self, previous_id: str, body: Any) -> httpx.Response:
        body = body if isinstance(body, dict) else {}
        for key in body:
            if key not in NEXT_FIELDS:
                return _invalid(key)
        refused = self._check_common(body)
        if refused:
            return refused
        previous = self._find(previous_id)
        if previous is None:
            return _error(404, "not_found", "Nothing with that id in this project")
        if previous["polls_left"] > 0:
            return _error(409, "pending", "The request is still running")
        if previous["deleted"]:
            return _error(410, "content_expired", "The stored content has expired or was deleted")
        if previous["failure"] is not None or not previous["page"].next_how:
            return _error(409, "no_next_page", "That request has no next page to open",
                          {"reason": "failed" if previous["failure"] is not None else "none_found"})
        key = body.get("idempotency_key") or str(uuid.uuid4())
        scope = f"next:{previous_id}:"
        replay = self._replay(key, body, scope)
        if replay is not None:
            return replay
        request = {k: v for k, v in previous["request"].items() if k not in ("idempotency_key", "max_credits")}
        request.update({k: v for k, v in body.items() if k != "idempotency_key"})
        request["url"] = previous["page"].next_url or previous["request"]["url"]
        refused = _check_capture(request)
        if refused:
            return refused
        outcome = self._run(request, key, previous=previous)
        if isinstance(outcome, httpx.Response):
            return outcome
        self._keys[scope + key] = (outcome["id"], _fingerprint(body))
        return self._answer(outcome)

    # ----------------------------------------------------------------- network capture

    def _captured_calls(self, state: dict) -> Tuple[List[dict], dict]:
        """The calls a request made with capture recorded, as stored, and what it left out."""
        settings = _capture_settings(state["request"].get("capture")) or CAPTURE_DEFAULTS
        request, page, failure = state["request"], state["page"], state["failure"]
        url = request["url"]
        if failure is None:
            calls = [{"url": url, "type": "document", "status": page.status_code, "content_type": page.content_type,
                      "body": page.content, "response_headers": page.headers}] + list(page.network)
        elif failure["page_status"] == "challenge":
            calls = [{"url": url, "type": "document", "status": 429 if failure["code"] == "rate_limited" else 403,
                      "content_type": "text/html", "body": b"<html><body>fake wall</body></html>"}]
        else:
            calls = [{"url": url, "type": "document", "status": None, "error": failure["code"]}]
        dropped = {"trackers": 0, "excluded_types": 0, "third_party": 0, "over_limit": 0}
        site, stored, body_total = _registrable(url), [], 0
        for call in calls:
            kind = call.get("type", "fetch")
            first_party = _registrable(call["url"]) == site
            if kind not in settings["types"]:
                dropped["excluded_types"] += 1
            elif call.get("tracker") and not settings["include_trackers"]:
                dropped["trackers"] += 1
            elif settings["first_party_only"] and not first_party:
                dropped["third_party"] += 1
            elif len(stored) >= settings["max_requests"]:
                dropped["over_limit"] += 1
            else:
                entry = _stored_call(call, len(stored) + 1, state["number"], first_party, settings, body_total)
                body_total += entry["body_bytes"]
                stored.append(entry)
        return stored, dropped

    def _network_summary(self, state: dict) -> dict:
        stored, dropped = self._captured_calls(state)
        return {"captured": len(stored), "dropped": dropped, "truncated": dropped["over_limit"] > 0, "attempt": 1,
                "complete": True, "expires_at": _iso(state["created"] + timedelta(days=7)),
                "expired": bool(state["deleted"]), "list_url": f"/v1/fetch/{state['id']}/network",
                "har_url": f"/v1/fetch/{state['id']}/network.har"}

    def _capture_state(self, fetch_id: str) -> Union[dict, httpx.Response]:
        state = self._find(fetch_id)
        if state is None:
            return _error(404, "not_found", "Nothing with that id in this project")
        if _capture_settings(state["request"].get("capture")) is None:
            return _error(404, "capture_not_found", "That request was made without capture, so it has no network calls")
        if state["polls_left"] > 0:
            return _error(409, "pending", "The request is still running")
        if state["deleted"]:
            return _error(410, "content_expired", "The stored content has expired or was deleted")
        return state

    def _network_list(self, fetch_id: str, query: dict) -> httpx.Response:
        for key, values in query.items():
            if key not in _NETWORK_QUERY:
                return _invalid(key)
            if key != "contains" and len(values) > 1:
                return _invalid(key)
        one = {key: values[-1] for key, values in query.items() if key != "contains"}
        contains = query.get("contains", [])
        checks = {"type": lambda v: v in CAPTURE_TYPES, "first_party": lambda v: v in ("true", "false"),
                  "status": lambda v: re.fullmatch(r"[1-5](?:\d\d|xx)", v) is not None,
                  "page": lambda v: re.fullmatch(r"[1-9]\d{0,4}", v) is not None,
                  "phase": lambda v: v in ("warmup", "load", "scroll", "replay"),
                  "limit": lambda v: re.fullmatch(r"\d{1,3}", v) is not None and 1 <= int(v) <= 200,
                  "cursor": lambda v: re.fullmatch(r"[1-9]\d{0,6}", v) is not None,
                  "content_type": lambda v: 0 < len(v) <= 100,
                  "host": lambda v: re.fullmatch(r"(?:\*\.)?[a-z0-9.-]{1,253}", v.lower()) is not None}
        for key, value in one.items():
            if not checks[key](value):
                return _invalid(key)
        if len(contains) > 5 or any(not value.strip() or len(value) > 200 for value in contains):
            return _invalid("contains")
        state = self._capture_state(fetch_id)
        if isinstance(state, httpx.Response):
            return state
        stored, _ = self._captured_calls(state)
        after, limit = int(one.get("cursor") or 0), int(one.get("limit") or 50)
        items: List[dict] = []
        more = False
        for entry in stored:
            if entry["index"] <= after or not _network_match(entry, one):
                continue
            matched = _contains(entry["body"], contains) if contains else None
            if matched is not None and not matched:
                continue
            if len(items) == limit:
                more = True
                break
            items.append(_network_row(entry, matched))
        return _json(200, {"items": items, "next_cursor": str(items[-1]["index"]) if more else None,
                           "network": self._network_summary(state)})

    def _network_entry(self, fetch_id: str, index: str) -> Union[Tuple[dict, dict], httpx.Response]:
        if not re.fullmatch(r"[1-9]\d{0,6}", index):
            return _error(404, "not_found", "No call with that index")
        state = self._capture_state(fetch_id)
        if isinstance(state, httpx.Response):
            return state
        stored, _ = self._captured_calls(state)
        if int(index) > len(stored):
            return _error(404, "not_found", "No call with that index", {"field": "index"})
        return state, stored[int(index) - 1]

    def _network_call(self, fetch_id: str, index: str) -> httpx.Response:
        found = self._network_entry(fetch_id, index)
        if isinstance(found, httpx.Response):
            return found
        state, entry = found
        return _json(200, _network_detail(entry, state["id"]))

    def _network_body(self, fetch_id: str, index: str) -> httpx.Response:
        found = self._network_entry(fetch_id, index)
        if isinstance(found, httpx.Response):
            return found
        _, entry = found
        if entry["body"] is None:
            return _error(404, "not_found", "That call has no stored body",
                          {"field": "body", "reason": entry["body_omitted"] or "no_body"})
        encoding, data = entry["body"]
        content = base64.b64decode(data) if encoding == "base64" else data.encode("utf-8")
        return httpx.Response(200, content=content,
                              headers={"content-type": entry["content_type"] or "application/octet-stream"})

    def _network_har(self, fetch_id: str, query: dict) -> httpx.Response:
        for key, values in query.items():
            if key != "page" or len(values) > 1 or not re.fullmatch(r"[1-9]\d{0,4}", values[-1]):
                return _invalid(key)
        state = self._capture_state(fetch_id)
        if isinstance(state, httpx.Response):
            return state
        stored, _ = self._captured_calls(state)
        if "page" in query:
            stored = [entry for entry in stored if entry["page"] == int(query["page"][-1])]
        return _json(200, _har(stored, state["created"], state["request"]["url"]))

    # ----------------------------------------------------------------- batches

    def _post_batch(self, body: Any) -> httpx.Response:
        if not isinstance(body, dict):
            return _invalid("body")
        for key in body:
            if key not in ("items", "defaults", "webhook_url", "idempotency_key", "tags"):
                return _invalid(key)
        items = body.get("items")
        if not isinstance(items, list) or not 1 <= len(items) <= 1000:
            return _invalid("items")
        defaults = body.get("defaults") or {}
        if not isinstance(defaults, dict):
            return _invalid("defaults")
        for key in ("url", "async", "webhook_url", "idempotency_key"):
            if key in defaults:
                return _invalid(f"defaults.{key}")
        requests = []
        for index, item in enumerate(items):
            if isinstance(item, str):
                item = {"url": item}
            if not isinstance(item, dict):
                return _invalid(f"items[{index}]")
            for key in ("async", "webhook_url", "idempotency_key"):
                if key in item:
                    return _invalid(f"items[{index}].{key}")
            request = {**defaults, **item}
            refused = self._check_fetch(request)
            if refused:
                field = json.loads(refused.content)["error"]["details"]["field"]
                return _invalid(f"items[{index}].{field}")
            requests.append(request)
        key = body.get("idempotency_key") or str(uuid.uuid4())
        known = self._batch_keys.get(key)
        if known is not None:
            if known[1] != _fingerprint(body):
                return _error(409, "idempotency_conflict",
                              "This idempotency_key was used before with a different batch")
            return _json(200, self._batch_view(self._batches[known[0]]))
        batch_id = str(uuid.uuid4())
        batch = {"id": batch_id, "key": key, "tags": list(body.get("tags") or []), "created": self._tick(),
                 "webhook": bool(body.get("webhook_url")), "canceled": None, "finished": None, "finish_order": [],
                 "items": [{"index": index, "request": request, "status": "queued", "state": None, "error": None,
                            "started": None, "ended": None} for index, request in enumerate(requests)]}
        self._batches[batch_id] = batch
        self._batch_keys[key] = (batch_id, _fingerprint(body))
        return _json(202, self._batch_view(batch))

    def _with_batch(self, batch_id: str, then: Callable[[dict], httpx.Response]) -> httpx.Response:
        batch = self._batches.get(batch_id)
        if batch is None:
            return _error(404, "not_found", "No batch with that id in this project")
        self._advance(batch)
        return then(batch)

    def _advance(self, batch: dict) -> None:
        """Run up to batch_step queued items, as if time passed."""
        queued = [item for item in batch["items"] if item["status"] == "queued"]
        for item in queued[:self.batch_step]:
            item["started"] = self._tick()
            outcome = self._run(dict(item["request"]), f"batch.{batch['id']}.{item['index']}",
                                batch=(batch["id"], item["index"]))
            if isinstance(outcome, httpx.Response):
                error = json.loads(outcome.content)["error"]
                item.update(status="failed",
                            error={k: v for k, v in error.items() if k in ("code", "message", "details")})
            else:
                item["state"] = outcome
                item["status"] = "failed" if outcome["failure"] else "succeeded"
            item["ended"] = self._tick()
            batch["finish_order"].append(item["index"])
        if batch["finished"] is None and not any(item["status"] == "queued" for item in batch["items"]):
            batch["finished"] = self._tick()

    def _cancel(self, batch: dict) -> httpx.Response:
        if batch["finished"] is None:
            for item in batch["items"]:
                if item["status"] == "queued":
                    item["status"] = "canceled"
                    batch["finish_order"].append(item["index"])
            batch["canceled"] = batch["finished"] = self._tick()
        return _json(200, self._batch_view(batch))

    def _batch_view(self, batch: dict) -> dict:
        counts = {status: 0 for status in ("queued", "running", "succeeded", "failed", "canceled")}
        for item in batch["items"]:
            counts[item["status"]] += 1
        status = "canceled" if batch["canceled"] else "finished" if batch["finished"] else "running"
        return {"id": batch["id"], "status": status, "paused_reason": None, "idempotency_key": batch["key"],
                "tags": batch["tags"], "created_at": _iso(batch["created"]), "finished_at": _iso(batch["finished"]),
                "canceled_at": _iso(batch["canceled"]), "items": {"total": len(batch["items"]), **counts},
                "credits": {"charged": sum(item["state"]["charged"] for item in batch["items"] if item["state"])},
                "webhook": batch["webhook"]}

    def _item_view(self, batch: dict, item: dict, results: bool) -> dict:
        state = item["state"]
        return {"index": item["index"], "url": item["request"]["url"], "status": item["status"],
                "request_id": state["id"] if state else None,
                "credits": {"charged": state["charged"] if state else 0}, "error": item["error"],
                "started_at": _iso(item["started"]), "finished_at": _iso(item["ended"]),
                "result": self._view(state, body=False) if state and results else None}

    def _batch_items(self, batch: dict, params: dict) -> httpx.Response:
        results = params.get("results") != "false"
        limit = _limit(params)
        if params.get("order") == "finished":
            start = int(params.get("cursor") or 0)
            order = batch["finish_order"]
            chosen = [batch["items"][index] for index in order[start:start + limit]]
            if params.get("status"):
                chosen = [item for item in chosen if item["status"] == params["status"]]
            position = min(start + limit, len(order))
            over = batch["finished"] is not None and position >= len(order)
            return _json(200, {"items": [self._item_view(batch, item, results) for item in chosen],
                               "next_cursor": None if over else str(position)})
        items = batch["items"]
        if params.get("status"):
            items = [item for item in items if item["status"] == params["status"]]
        return _paged(items, params, lambda item: self._item_view(batch, item, results))

    def _list_batches(self, params: dict) -> httpx.Response:
        batches = list(reversed(list(self._batches.values())))
        views = [self._batch_view(batch) for batch in batches]
        if params.get("status"):
            views = [view for view in views if view["status"] == params["status"]]
        return _paged(views, params, lambda view: view)

    # ----------------------------------------------------------------- estimates and account

    def _estimate(self, body: Any) -> httpx.Response:
        if not isinstance(body, dict):
            return _invalid("body")
        if "items" in body:
            items, defaults, kind = body.get("items"), body.get("defaults") or {}, "batch"
            if not isinstance(items, list) or not 1 <= len(items) <= 1000:
                return _invalid("items")
            requests = [{**defaults, **({"url": item} if isinstance(item, str) else item)} for item in items]
        else:
            refused = self._check_fetch(body)
            if refused:
                return refused
            requests, kind = [body], "fetch"
        out_items: List[Dict[str, Any]] = []
        hosts: Dict[str, Dict[str, Any]] = {}
        total = 0
        for index, request in enumerate(requests):
            page = self._page(request.get("url", ""), request)
            price = page.credits if page.credits is not None else self.credits
            host = site_of(request.get("url")) or ""
            item: Dict[str, Any] = {"index": index, "url": request.get("url"), "host": host, "basis": "assumed",
                                    "samples": 0,
                    "step": page.step or self.step, "success_rate": None,
                    "credits": {"expected": price, "typical": price, "high": price * 2,
                                "hold": request.get("max_credits") or self.dearest_step},
                    "seconds": {"typical": 2.0, "high": 10.0}, "notes": []}
            cap = request.get("max_credits")
            if cap is not None and cap < price:
                item["error"] = {"code": "max_credits_too_low", "message": "max_credits is below the cheapest step",
                                 "details": {"min_credits": price}}
            else:
                total += price
                entry = hosts.setdefault(host, {"requests": 0, "pace": {"tier": "open", "max_running": 4,
                                                                        "start_gap_ms": 500},
                                                "credits": {"expected": 0, "high": 0}})
                entry["requests"] += 1
                entry["credits"]["expected"] += price
                entry["credits"]["high"] += price * 2
            out_items.append(item)
        estimated = sum(1 for item in out_items if "error" not in item)
        estimate = {"kind": kind, "requests": len(requests), "estimated": estimated,
                    "credits": {"expected": total, "typical": total, "high": total * 2},
                    "seconds": {"typical": 2.0 * max(estimated, 1), "high": 10.0 * max(estimated, 1)},
                    "balance": {"credits": self.balance,
                                "covers_expected": self.balance is None or self.balance >= total,
                                "covers_high": self.balance is None or self.balance >= total * 2},
                    "items": out_items, "notes": []}
        if kind == "batch":
            estimate["hosts"] = hosts
        return _json(200, estimate)

    def _balance(self) -> dict:
        return {"credits": self.balance, "reserved": 0, "trial": 0,
                "purchased": self.balance or 0, "payment_hold": False,
                "usd_per_credit": 0.0002 if self.balance is not None else None, "currency": "USD"}

    def _usage(self) -> dict:
        finished = [state for state in self._results.values() if state["polls_left"] <= 0]
        spent = sum(state["charged"] for state in finished)
        by_step: Dict[str, List[int]] = {}
        for state in finished:
            if state["failure"] is None:
                entry = by_step.setdefault(state["page"].step or self.step, [0, 0])
                entry[0] += 1
                entry[1] += state["charged"]
        return {"balance": None if self.balance is None else {
                    "credits": self.balance, "trial": 0, "purchased": self.balance, "reserved": 0,
                    "payment_hold": False},
                "period": {"from": _iso(self._clock.replace(day=1)), "to": _iso(self._clock)},
                "used": {"credits": spent, "succeeded": sum(1 for s in finished if s["failure"] is None),
                         "failed": sum(1 for s in finished if s["failure"] is not None), "captcha_solved": 0},
                "by_step": [{"step": step, "requests": n, "credits": c} for step, (n, c) in by_step.items()],
                "daily": [{"date": self._clock.date().isoformat(), "requests": len(finished), "credits": spent}]}

    def _me(self, auth: str) -> dict:
        key = auth[len("Bearer "):] if auth.startswith("Bearer ") else ""
        return {"project_id": self.project_id, "key_id": self.key_id, "key_name": "fake",
                "key_prefix": key[:12] if key.startswith("fxk_") else None,
                "scopes": ["fetch:write", "fetch:read", "usage:read"],
                "limits": {"credits_per_day": None, "credits_per_month": None, "expires_at": None},
                "concurrency": {"requests": {"limit": 10, "running": 0}},
                "features": ["batches", "capture", "estimate", "extract", "feedback", "key_limits", "limits",
                             "next_page", "usd"]}

    def _post_feedback(self, body: Any) -> httpx.Response:
        if not isinstance(body, dict):
            return _invalid("body")
        for key in body:
            if key not in FEEDBACK_FIELDS:
                return _invalid(key)
        if body.get("kind") not in FEEDBACK_KINDS:
            return _invalid("kind")
        evidence = body.get("evidence") or {}
        if not isinstance(evidence, dict) or set(evidence) - FEEDBACK_EVIDENCE:
            return _invalid("evidence")
        fetch_id, url, method = body.get("fetch_id"), body.get("url"), body.get("method")
        if fetch_id is not None:
            if url is not None or method is not None:
                return _invalid("url")
            state = self._find(fetch_id)
            if state is None:
                return _error(404, "not_found", "Nothing with that id in this project")
            url, method = state["request"]["url"], None
        else:
            if not isinstance(url, str) or not re.match(r"^https?://[^/\s]+", url):
                return _invalid("fetch_id" if url is None else "url")
            method = method or "GET"
        for report in self.feedback.values():
            if (report["status"] in ("received", "reviewing") and report["kind"] == body["kind"]
                    and (report["fetch_id"] == fetch_id if fetch_id else (report["url"], report["method"]) == (url, method))):
                return _json(200, report)
        now = _iso(self._tick())
        report = {"id": str(uuid.uuid4()), "kind": body["kind"], "fetch_id": fetch_id, "url": url, "method": method,
                  "message": body.get("message"), "evidence": dict(evidence), "status": "received", "reply": None,
                  "created_at": now, "updated_at": now}
        self.feedback[report["id"]] = report
        return _json(201, report)

    def answer_feedback(self, feedback_id: str, status: str = "resolved", reply: Optional[str] = None) -> dict:
        """What FetchX staff do in the admin portal: set a report's status and the reply the caller sees."""
        report = self.feedback[feedback_id]
        report.update(status=status, reply=reply, updated_at=_iso(self._tick()))
        return report

    def _status(self) -> dict:
        return {"status": "operational", "updated_at": _iso(self._clock),
                "components": [{"id": "api", "name": "API", "status": "operational"},
                               {"id": "fetching", "name": "Fetching", "status": "operational"}],
                "notices": [], "api": {"version": "fake"},
                "links": {"status_page": "https://fetchx.test/status", "changelog": "https://fetchx.test/changelog",
                          "docs": "https://fetchx.test/docs"}}

    def _prices(self) -> dict:
        """FetchX's default price table (the fake charges each page its own ``credits`` instead)."""
        def step(credits, residential, browser, classes, included):
            return {"credits": credits, "residential": residential, "browser": browser, "route_classes": classes,
                    "included_mb": included}
        return {"unit": "credits",
                "steps": {"http": step(1, False, False, ["direct", "datacenter"], None),
                          "http_residential": step(5, True, False, ["residential"], 1),
                          "browser": step(10, False, True, ["direct", "datacenter"], None),
                          "browser_residential": step(25, True, True, ["residential"], 5)},
                "captcha": {"credits": 10}, "traffic": {"credits_per_mb": 5},
                "extract": {"credits": 10, "unit_tokens": 25000, "max_tokens": 150000, "max_credits": 60},
                "packs": [{"credits": c, "usd": usd, "inr": inr, "usd_per_credit": usd / c}
                          for c, usd, inr in ((10_000, 2, 175), (50_000, 8, 750), (150_000, 20, 1800), (1_000_000, 100, 9000))],
                "trial_credits": 1000, "pricing_url": "https://fetchx.test/pricing"}

    def _tick(self) -> datetime:
        self._clock += timedelta(seconds=1)
        return self._clock


# --------------------------------------------------------------------------- helpers

def _iso(moment: Optional[datetime]) -> Optional[str]:
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ") if moment else None


def _fingerprint(body: dict) -> str:
    return json.dumps({k: v for k, v in body.items() if k != "idempotency_key"}, sort_keys=True, default=str)


def _plain(html: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html)).strip()


def _limit(params: dict) -> int:
    try:
        return max(1, min(100, int(params.get("limit") or 25)))
    except ValueError:
        return 25


def _paged(items: list, params: dict, view: Callable[[Any], dict]) -> httpx.Response:
    start = int(params.get("cursor") or 0)
    limit = _limit(params)
    chunk = items[start:start + limit]
    more = start + limit < len(items)
    return _json(200, {"items": [view(item) for item in chunk], "next_cursor": str(start + limit) if more else None})


def _skeleton(content: bytes) -> Optional[dict]:
    """formats: skeleton, as the engine builds it (without its size trimming or the <pre> case): fields read from
    the first 100 elements of each array, at most 150, and a sample with one element per array."""
    try:
        value = json.loads(content.decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError):
        return None

    def kind(item: Any) -> str:
        return ("null" if item is None else "array" if isinstance(item, list) else "boolean" if isinstance(item, bool)
                else "number" if isinstance(item, (int, float)) else "string" if isinstance(item, str) else "object")

    fields: Dict[str, dict] = {}
    truncated = False

    def visit(item: Any, path: str) -> None:
        nonlocal truncated
        row = fields.get(path)
        if row is None:
            if len(fields) >= 150:
                truncated = True
                return
            row = fields[path] = {"path": path, "types": set(), "seen": 0, "items": 0}
        row["types"].add(kind(item))
        row["seen"] += 1
        if isinstance(item, list):
            row["items"] += len(item)
            for element in item[:100]:
                visit(element, path + "[*]")
        elif isinstance(item, dict):
            for key, child in item.items():
                plain = re.fullmatch(r"[A-Za-z_$][\w$]*", key)
                visit(child, f"{path}.{key}" if plain else path + "['" + key.replace("\\", "\\\\").replace("'", "\\'") + "']")

    def sample(item: Any, depth: int = 0) -> Any:
        if isinstance(item, str):
            return item[:80] + "…" if len(item) > 80 else item
        if isinstance(item, list):
            return [sample(item[0], depth + 1)] if item and depth < 10 else []
        if isinstance(item, dict):
            return {} if depth >= 10 else {key: sample(child, depth + 1) for key, child in list(item.items())[:40]}
        return item

    visit(value, "$")
    rows = [{"path": row["path"], "type": "|".join(sorted(row["types"])), "seen": row["seen"],
             **({"items": row["items"]} if "array" in row["types"] else {})} for row in fields.values()]
    return {"bytes": len(content), "root": kind(value), "fields": rows, "sample": sample(value), "truncated": truncated}


def _json(status: int, body: dict) -> httpx.Response:
    return httpx.Response(status, json=body)


def _error(status: int, code: str, message: str, details: Optional[dict] = None,
           retry_after_seconds: Optional[int] = None, headers: Optional[dict] = None) -> httpx.Response:
    error: Dict[str, Any] = {"code": code, "message": message}
    if details:
        error["details"] = details
    if retry_after_seconds is not None:
        error["retry_after_seconds"] = retry_after_seconds
    return httpx.Response(status, json={"error": error}, headers=headers or {})


def _invalid(field: str) -> httpx.Response:
    return _error(400, "invalid_request", "A field is missing or wrong; error.details.field names it.",
                  {"field": field})


# --------------------------------------------------------------------------- network capture helpers

def _capture_settings(value: Any) -> Optional[dict]:
    """A request's capture as complete settings, or None when it records nothing."""
    if value is None or value is False:
        return None
    return {**CAPTURE_DEFAULTS, **(value if isinstance(value, dict) else {})}


def _check_capture(request: dict) -> Optional[httpx.Response]:
    value = request.get("capture")
    if value is None or value is False:
        return None
    if value is not True:
        if not isinstance(value, dict):
            return _invalid("capture")
        for key in value:
            if key not in CAPTURE_DEFAULTS:
                return _invalid(f"capture.{key}")
        settings = _capture_settings(value) or {}
        types = settings["types"]
        if not isinstance(types, list) or not types or not set(types) <= set(CAPTURE_TYPES) \
                or len(set(types)) != len(types):
            return _invalid("capture.types")
        for key, low, high in (("max_requests", 1, 1000), ("max_body_bytes", 1024, 10_000_000)):
            number = settings[key]
            if not isinstance(number, int) or isinstance(number, bool) or not low <= number <= high:
                return _invalid(f"capture.{key}")
        if settings["bodies"] not in ("text", "none", "all"):
            return _invalid("capture.bodies")
        for key in ("first_party_only", "include_trackers", "unmask"):
            if not isinstance(settings[key], bool):
                return _invalid(f"capture.{key}")
    route = request.get("route")
    if request.get("render") == "never" or str(request.get("method") or "GET").upper() != "GET" \
            or (isinstance(route, dict) and route.get("render") is False):
        return _error(400, "invalid_request", "A field is missing or wrong; error.details.field names it.",
                      {"field": "capture", "reason": CAPTURE_NEEDS_BROWSER})
    return None


def _registrable(url: str) -> str:
    """The page's own domain, roughly (the last two labels of the host): the fake has no suffix list."""
    host = site_of(url) or ""
    if re.fullmatch(r"[\d.]+", host) or ":" in host:
        return host
    return ".".join(host.split(".")[-2:])


def _masked(value: str) -> str:
    return f"<masked len={len(value.encode('utf-8'))} sha={hashlib.sha256(value.encode('utf-8')).hexdigest()[:6]}>"


def _masked_pair(part: str) -> str:
    name, equals, value = part.partition("=")
    return f"{name.strip()}={_masked(value.strip())}" if equals else _masked(part)


def _headers(value: Any, unmask: bool) -> List[List[str]]:
    """Name and value pairs, secrets masked as the real API masks them (a cookie keeps its name)."""
    pairs = [[str(k), str(v)] for k, v in (value.items() if isinstance(value, dict) else value or [])]
    if unmask:
        return pairs
    out = []
    for name, text in pairs:
        lower = name.lower()
        if lower == "cookie":
            out.append([name, "; ".join(_masked_pair(part.strip()) for part in text.split(";") if part.strip())])
        elif lower == "set-cookie":
            pair, *attributes = text.split(";")
            out.append([name, "; ".join([_masked_pair(pair.strip())] + [part.strip() for part in attributes])])
        elif lower in ("authorization", "proxy-authorization") or _SECRET_HEADER.search(name):
            out.append([name, _masked(text)])
        else:
            out.append([name, text])
    return out


def _bytes_of(body: Any) -> Optional[bytes]:
    if body is None:
        return None
    if isinstance(body, (dict, list)):
        return json.dumps(body).encode("utf-8")
    return body.encode("utf-8") if isinstance(body, str) else bytes(body)


def _encoded(data: bytes, content_type: Optional[str]) -> Tuple[str, str]:
    """Text when it is UTF-8 of a text type (a body cut at its cap may end inside a character,
    which is dropped), else base64."""
    if _TEXT_BODY.match((content_type or "").strip()):
        for cut in range(min(4, len(data) + 1)):
            try:
                return "utf-8", data[:len(data) - cut].decode("utf-8")
            except UnicodeDecodeError:
                continue
    return "base64", base64.b64encode(data).decode()


def _stored_call(call: dict, index: int, page: int, first_party: bool, settings: dict, body_total: int) -> dict:
    status = call.get("status", 200)
    content_type = call.get("content_type", "application/json") if status is not None else None
    raw = _bytes_of(call.get("body")) if status is not None else None
    request_raw = _bytes_of(call.get("request_body"))
    request_headers = _headers(call.get("request_headers"), settings["unmask"])
    body, omitted, truncated, kept = None, None, False, b""
    if raw:
        if settings["bodies"] == "none":
            omitted = "bodies_none"
        elif settings["bodies"] == "text" and not _TEXT_BODY.match((content_type or "").strip()):
            omitted = "not_text"
        elif body_total >= _CAPTURE_TOTAL_BYTES:
            omitted = "capture_full"
        else:
            kept = raw[:settings["max_body_bytes"]]
            truncated = len(kept) < len(raw)
            body = _encoded(kept, content_type)
    request_type = next((v for k, v in request_headers if k.lower() == "content-type"), None)
    return {"index": index, "page": page, "phase": "load", "type": call.get("type", "fetch"),
            "frame": call.get("frame", "main"), "first_party": first_party, "started_ms": index * 10,
            "duration_ms": 5, "flags": ["tracker"] if call.get("tracker") else [], "error": call.get("error"),
            "method": call.get("method", "GET"), "url": call["url"], "request_headers": request_headers,
            "request_body": _encoded(request_raw, request_type or "text/plain") if request_raw else None,
            "request_bytes": len(request_raw or b""), "status": status,
            "status_text": None if status is None else ("OK" if status == 200 else ""),
            "response_headers": _headers(call.get("response_headers"), settings["unmask"]),
            "content_type": content_type, "body": body, "body_bytes": len(kept),
            "response_bytes": len(raw or b""), "body_truncated": truncated, "body_omitted": omitted,
            "redirected_from": None}


def _network_match(entry: dict, query: dict) -> bool:
    if query.get("type") and entry["type"] != query["type"]:
        return False
    if query.get("content_type") and query["content_type"].lower() not in (entry["content_type"] or "").lower():
        return False
    if query.get("host"):
        host, pattern = (site_of(entry["url"]) or "").lower(), query["host"].lower()
        full = (urlsplit(entry["url"]).hostname or "").lower()
        if pattern.startswith("*."):
            if not (full == pattern[2:] or full.endswith(pattern[1:])):
                return False
        elif full != pattern and host != pattern:
            return False
    if query.get("first_party") and entry["first_party"] != (query["first_party"] == "true"):
        return False
    if query.get("status"):
        status = "" if entry["status"] is None else str(entry["status"])
        wanted = query["status"]
        if (status[:1] != wanted[0] or len(status) != 3) if wanted.endswith("xx") else status != wanted:
            return False
    if query.get("page") and entry["page"] != int(query["page"]):
        return False
    return not (query.get("phase") and entry["phase"] != query["phase"])


def _contains(body: Optional[Tuple[str, str]], values: List[str]) -> List[str]:
    if not body or body[0] != "utf-8":
        return []
    texts = [body[1].lower()]
    if re.match(r"^\s*[\[{]", body[1]):
        try:
            texts.append(json.dumps(json.loads(body[1]), ensure_ascii=False).lower())
        except ValueError:
            pass
    return [value for value in values if any(value.strip().lower() in text for text in texts)]


def _network_row(entry: dict, matched: Optional[List[str]]) -> dict:
    row = {key: entry[key] for key in ("index", "page", "phase", "type", "method", "url", "status", "content_type",
                                       "request_bytes", "response_bytes", "first_party", "frame", "started_ms",
                                       "duration_ms")}
    row.update(has_body=entry["body"] is not None, body_truncated=entry["body_truncated"],
               body_omitted=entry["body_omitted"], flags=list(entry["flags"]), error=entry["error"])
    if matched is not None:
        row["matched"] = matched
    return row


def _network_detail(entry: dict, fetch_id: str) -> dict:
    body = entry["body"]
    inline = body is not None and entry["body_bytes"] <= _INLINE_BODY_BYTES
    request_body = entry["request_body"]
    return {key: entry[key] for key in ("index", "page", "phase", "type", "frame", "first_party", "started_ms",
                                        "duration_ms", "error")} | {
        "flags": list(entry["flags"]),
        "request": {"method": entry["method"], "url": entry["url"], "headers": entry["request_headers"],
                    "body": request_body[1] if request_body else None,
                    "body_encoding": request_body[0] if request_body else None, "body_bytes": entry["request_bytes"]},
        "response": None if entry["status"] is None else {
            "status": entry["status"], "status_text": entry["status_text"], "headers": entry["response_headers"],
            "content_type": entry["content_type"], "body": body[1] if inline else None,
            "body_encoding": body[0] if inline else None, "body_bytes": entry["body_bytes"],
            "transfer_bytes": entry["response_bytes"], "body_truncated": entry["body_truncated"],
            "body_omitted": entry["body_omitted"],
            "body_url": f"/v1/fetch/{fetch_id}/network/{entry['index']}/body" if body and not inline else None},
        "redirected_from": entry["redirected_from"]}


def _har(entries: List[dict], started: datetime, page_url: str) -> dict:
    """The calls as a HAR 1.2 document, FetchX's own fields under _fetchx."""
    pages = sorted({entry["page"] for entry in entries})

    def stamp(ms: int) -> str:
        return (started + timedelta(milliseconds=ms)).strftime("%Y-%m-%dT%H:%M:%S.") + f"{ms % 1000:03d}Z"

    def pairs(headers: List[List[str]]) -> List[dict]:
        return [{"name": name, "value": value} for name, value in headers]

    out = []
    for entry in entries:
        body, answered = entry["body"], entry["status"] is not None
        content: Dict[str, Any] = {"size": entry["body_bytes"], "mimeType": entry["content_type"] or ""}
        if body:
            content["text"] = body[1]
            if body[0] == "base64":
                content["encoding"] = "base64"
        if entry["body_omitted"]:
            content["comment"] = f"body not stored: {entry['body_omitted']}"
        request: Dict[str, Any] = {"method": entry["method"], "url": entry["url"], "httpVersion": "", "cookies": [],
                                   "headers": pairs(entry["request_headers"]),
                                   "queryString": [{"name": k, "value": v} for k, v in
                                                   parse_qsl(urlsplit(entry["url"]).query, keep_blank_values=True)],
                                   "headersSize": -1, "bodySize": entry["request_bytes"]}
        if entry["request_body"]:
            request["postData"] = {"mimeType": "", "text": entry["request_body"][1]}
        response: Dict[str, Any] = {"status": entry["status"] if answered else 0, "statusText": entry["status_text"] or "",
                                    "httpVersion": "", "cookies": [], "headers": pairs(entry["response_headers"]),
                                    "content": content, "redirectURL": "", "headersSize": -1,
                                    "bodySize": entry["response_bytes"] if answered else -1}
        if entry["error"]:
            response["_error"] = entry["error"]
        out.append({"pageref": f"page_{entry['page']}", "startedDateTime": stamp(entry["started_ms"]),
                    "time": entry["duration_ms"], "request": request, "response": response, "cache": {},
                    "timings": {"blocked": -1, "dns": -1, "connect": -1, "ssl": -1, "send": 0,
                                "wait": entry["duration_ms"], "receive": 0},
                    "_fetchx": {key: entry[key] for key in ("index", "page", "phase", "type", "frame", "first_party",
                                                            "flags")}})
    return {"log": {"version": "1.2", "creator": {"name": "FetchX", "version": "fake"},
                    "pages": [{"startedDateTime": stamp(0), "id": f"page_{page}", "title": page_url,
                               "pageTimings": {"onContentLoad": -1, "onLoad": -1}} for page in pages],
                    "entries": out}}
