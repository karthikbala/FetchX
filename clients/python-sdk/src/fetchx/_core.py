"""What FetchX (sync) and AsyncFetchX share: building requests, reading answers, FetchX's
resend rules, polling, credit caps and per-site slots.

Each operation is written once, as a generator that yields steps (``_Send`` an HTTP request,
``_Sleep``, ``_Yield`` an item to the caller) and returns its answer. The two clients only
carry out the steps with their own I/O, so both follow exactly the same rules.
"""
from __future__ import annotations

import keyword
import logging
import os
import threading
import time
import uuid
from collections import OrderedDict
from email.utils import parsedate_to_datetime
from typing import Any, Callable, Dict, Generator, List, Mapping, NamedTuple, Optional, Sequence, Tuple
from urllib.parse import quote, urlsplit

import httpx

from ._version import __version__
from .errors import FetchXError, SpendLimitReached
from .models import (Balance, Batch, BatchItem, CallEvent, Content, Estimate, Feedback, FetchResult, FetchSummary, ListPage, Me,
                     NetworkCall, NetworkPage, Prices, ServiceStatus, Usage)

log = logging.getLogger("fetchx")

DEFAULT_URL = "https://app.fetchx.ai"
# Waits before each resend of the same request after a lost answer, a 429 or a 5xx. FetchX's
# Retry-After, when it gives one, replaces the scheduled wait (up to MAX_SERVER_WAIT).
RESEND_WAITS: Tuple[float, ...] = (2.0, 5.0, 15.0, 30.0, 60.0, 120.0)
MAX_SERVER_WAIT = 600.0
BATCH_LIMIT = 1000
# Fields only the batch itself may set: FetchX keys each item batch.<id>.<index> and runs it
# at its site's pace, so an item cannot be asynchronous, have its own webhook or its own key.
ITEM_ONLY_BATCH_FIELDS = ("idempotency_key", "async", "webhook_url")
_REMEMBERED = 100_000

Flow = Generator[Any, Any, Any]


class _Send(NamedTuple):
    method: str
    path: str
    params: Optional[dict] = None
    json: Any = None


class _Sleep(NamedTuple):
    seconds: float


class _Yield(NamedTuple):
    value: Any


def new_key(prefix: str = "fx") -> str:
    """A fresh idempotency key. Keep it with your own record to find the request again later."""
    return f"{prefix}-{uuid.uuid4().hex}"


def site_of(url: Optional[str]) -> Optional[str]:
    """The site a URL belongs to for the one-request-at-a-time rule: its host, without www."""
    try:
        host = urlsplit(url or "").hostname
    except ValueError:
        return None
    if not host:
        return None
    host = host.rstrip(".")
    return host[4:] if host.startswith("www.") else host


def _path_id(value: Any) -> str:
    text = value.id if isinstance(value, (FetchResult, Batch, Feedback)) else str(value or "")
    if not text:
        raise FetchXError("invalid_request", "an id is required", details={"field": "id"})
    return quote(text, safe="")


def _merge(body: Optional[Mapping], fields: Mapping[str, Any]) -> dict:
    """A request body from a dict and keyword fields; ``async_=True`` stands for ``async``."""
    if body is not None and not isinstance(body, Mapping):
        raise FetchXError("invalid_request", "the request body must be a dict")
    merged = dict(body or {})
    for key, value in fields.items():
        if key.endswith("_") and keyword.iskeyword(key[:-1]):
            key = key[:-1]
        merged[key] = value
    return merged


def _asks_for_body(request: Mapping, defaults: Optional[Mapping] = None) -> bool:
    formats = request.get("formats", (defaults or {}).get("formats"))
    return formats is None or "body" in formats


def _query(**params: Any) -> Dict[str, Any]:
    clean: Dict[str, Any] = {}
    for key, value in params.items():
        if value is None:
            continue
        if isinstance(value, (list, tuple)):
            clean[key] = [str(item) for item in value]  # a repeated parameter: contains=a&contains=b
        else:
            clean[key] = ("true" if value else "false") if isinstance(value, bool) else str(value)
    return clean


def _network_query(type: Optional[str], content_type: Optional[str], host: Optional[str], first_party: Optional[bool],
                   status: Any, page: Optional[int], phase: Optional[str], contains: Any, limit: Optional[int],
                   cursor: Optional[str]) -> Dict[str, Any]:
    """The query of GET /v1/fetch/{id}/network; contains may be one value or several."""
    values = [contains] if isinstance(contains, str) else list(contains) if contains is not None else None
    return _query(type=type, content_type=content_type, host=host, first_party=first_party, status=status, page=page,
                  phase=phase, contains=values, limit=limit, cursor=cursor)


def _retry_after(value: Optional[str]) -> Optional[float]:
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        pass
    try:
        moment = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    return max(0.0, moment.timestamp() - time.time())


def _read(response: httpx.Response, raw: bool, key: Optional[str]) -> Tuple[Optional[FetchXError], Any]:
    """(error, value) from a FetchX answer. Errors never carry the API key or a page body."""
    status = response.status_code
    if status == 204:
        return None, None
    if raw and 200 <= status < 300:
        return None, Content(response.content, response.headers.get("content-type"))
    try:
        data = response.json()
    except ValueError:
        data = None
    if not isinstance(data, dict):
        code = "unavailable" if status in (502, 503, 504) else "invalid_response"
        return FetchXError(code, f"FetchX answered HTTP {status} without a JSON body", status=status,
                           idempotency_key=key), None
    if status >= 400:
        error: Dict[str, Any] = data["error"] if isinstance(data.get("error"), dict) else {}
        code = error["code"] if isinstance(error.get("code"), str) else f"http_{status}"
        after = error.get("retry_after_seconds")
        if not isinstance(after, (int, float)) or isinstance(after, bool):
            after = _retry_after(response.headers.get("retry-after"))
        return FetchXError(code, str(error.get("message") or ""), status=status, details=error.get("details"),
                           retry_after_seconds=after, idempotency_key=key, response=data), None
    if not 200 <= status < 300:
        return FetchXError("invalid_response", f"FetchX answered HTTP {status}", status=status,
                           idempotency_key=key), None
    return None, data


class _Call:
    """What one public call did, for the on_call hook."""

    def __init__(self, op: str, url: Optional[str] = None):
        self.op = op
        self.url = url
        self.started = time.monotonic()
        self.requests = self.resends = self.polls = 0
        self.http_status: Optional[int] = None
        self.key: Optional[str] = None
        self.batch_id: Optional[str] = None
        self.result: Optional[FetchResult] = None

    def event(self, error: Optional[BaseException]) -> CallEvent:
        result = self.result
        return CallEvent(
            op=self.op, ok=error is None, elapsed=round(time.monotonic() - self.started, 3),
            requests=self.requests, resends=self.resends, polls=self.polls, http_status=self.http_status,
            raised=(error.code if isinstance(error, FetchXError) else type(error).__name__) if error else None,
            fetch_id=result.id if result else None, batch_id=self.batch_id,
            url=(result.url if result else None) or self.url,
            idempotency_key=self.key, status=result.status if result else None,
            page_status=result.page_status if result else None, credits=result.credits if result else 0,
            step=result.step if result else None, error_code=result.error_code if result else None,
            next_action=result.next_action if result else None)


Plan = Tuple[_Call, Flow, Optional[str]]


class _Core:
    """Settings, credit accounting and every operation's flow. Not used directly."""

    def __init__(self, base_url: Optional[str] = None, token: Optional[str] = None, *,
                 max_credits: Optional[int] = None, spend_limit: Optional[int] = None,
                 per_site: Optional[int] = 1, poll_every: float = 3.0, max_wait: float = 600.0,
                 unavailable_waits: Sequence[float] = RESEND_WAITS, retry_failed: int = 0,
                 max_retry_wait: float = 900.0, want_body: Optional[bool] = None,
                 on_call: Optional[Callable[[CallEvent], Any]] = None, user_agent: Optional[str] = None):
        token = token or os.environ.get("FETCHX_TOKEN") or os.environ.get("FETCHX_API_KEY")
        saved = None
        if not token:
            # The key Connect saved (python -m fetchx connect, or connect(save=True)).
            from ._connect import load_credentials
            saved = load_credentials()
            token = saved.token if saved else None
        if not token:
            raise FetchXError("client_config_missing", "set FETCHX_TOKEN to a FetchX API key (fxk_...), pass token=, "
                                                       "or run python -m fetchx connect")
        base = (base_url or os.environ.get("FETCHX_URL") or (saved.api_base_url if saved else None) or DEFAULT_URL).rstrip("/")
        parts = urlsplit(base)
        if parts.scheme not in ("https", "http") or not parts.hostname:
            raise FetchXError("client_config_missing", "base_url (or FETCHX_URL) must be an http(s) URL")
        if max_credits is not None and (not isinstance(max_credits, int) or not 1 <= max_credits <= 100_000):
            raise ValueError("max_credits must be an integer from 1 to 100000")
        if spend_limit is not None and (not isinstance(spend_limit, int) or spend_limit < 0):
            raise ValueError("spend_limit must be a whole number of credits")
        if per_site is not None and (not isinstance(per_site, int) or per_site < 1):
            raise ValueError("per_site must be at least 1, or None for no limit")
        self.base_url = base
        self._headers = {"Authorization": "Bearer " + token, "Accept": "application/json",
                         "User-Agent": user_agent or f"fetchx-python/{__version__} httpx/{httpx.__version__}"}
        self.max_credits = max_credits
        self.spend_limit = spend_limit
        self.per_site = per_site
        self.poll_every = float(poll_every)
        self.max_wait = float(max_wait)
        self.unavailable_waits = tuple(float(wait) for wait in unavailable_waits)
        self.retry_failed = int(retry_failed)
        self.max_retry_wait = float(max_retry_wait)
        self.want_body = want_body
        self.on_call = on_call
        self.credits_spent = 0  # charged to requests and batches this client started
        self.calls = 0          # requests this client started: fetches, next pages and batch items
        self._held = 0
        self._own: Dict[str, int] = {}                      # running requests started here -> credits held
        self._own_batches: Dict[str, int] = {}              # unfinished batches submitted here -> credits held
        self._settled: OrderedDict[str, None] = OrderedDict()  # finished requests and batches already counted
        self._known: OrderedDict[str, Tuple[Optional[str], bool]] = OrderedDict()  # id -> (site, asks for body)
        self._lock = threading.Lock()

    def __repr__(self) -> str:
        return f"{type(self).__name__}(base_url={self.base_url!r})"

    @property
    def remaining_credits(self) -> Optional[int]:
        """Credits left under spend_limit, less what running requests hold (None without a limit)."""
        if self.spend_limit is None:
            return None
        with self._lock:
            return max(0, self.spend_limit - self.credits_spent - self._held)

    # ----------------------------------------------------------------- credits

    def _cap(self, request: dict) -> int:
        """Apply max_credits and spend_limit to a fetch or next-page body. Returns the credits held."""
        if self.max_credits is not None and request.get("max_credits") is None:
            request["max_credits"] = self.max_credits
        if self.spend_limit is None:
            return 0
        with self._lock:
            left = self.spend_limit - self.credits_spent - self._held
            if left < 1:
                raise self._limit_reached()
            cap = request.get("max_credits")
            if not isinstance(cap, int) or cap > left:
                request["max_credits"] = cap = left
            self._held += cap
            return cap

    def _cap_batch(self, body: dict) -> int:
        if self.spend_limit is None:
            return 0
        default = (body.get("defaults") or {}).get("max_credits")
        most = 0
        for index, item in enumerate(body["items"]):
            cap = item.get("max_credits", default) if isinstance(item, dict) else default
            if not isinstance(cap, int):
                raise FetchXError("max_credits_required", "with spend_limit set, every batch item needs max_credits "
                                  "(in the item, in defaults or on the client), so the batch's most cost is known",
                                  details={"field": f"items[{index}].max_credits"})
            most += cap
        with self._lock:
            left = self.spend_limit - self.credits_spent - self._held
            if most > left:
                raise self._limit_reached(f"the batch could cost up to {most} credits and {max(left, 0)} are left",
                                          batch_max=most)
            self._held += most
        return most

    def _limit_reached(self, why: str = "", **extra: Any) -> SpendLimitReached:
        details = {"spend_limit": self.spend_limit, "spent": self.credits_spent, "held": self._held, **extra}
        return SpendLimitReached("spend_limit_reached", why or (
            f"this client may spend {self.spend_limit} credits: {self.credits_spent} spent, "
            f"{self._held} held by requests still running"), details=details)

    def _release(self, held: int) -> None:
        if held:
            with self._lock:
                self._held -= held

    def _remember(self, store: OrderedDict, key: str, value: Any) -> None:
        store[key] = value
        store.move_to_end(key)
        while len(store) > _REMEMBERED:
            store.popitem(last=False)

    def _started(self, result: FetchResult, held: int, site: Optional[str], asks: bool) -> None:
        """A request this client sent: hold its credits until it finishes, then count them."""
        with self._lock:
            if result.id:
                self._remember(self._known, result.id, (site, asks))
            if result.pending and result.id:
                self._own[result.id] = self._own.get(result.id, 0) + held
                return
            self._held -= held
            self._count(result)

    def _seen(self, result: FetchResult) -> None:
        """Any result read later settles a request this client started, once it has finished."""
        if result.pending or not result.id:
            return
        with self._lock:
            held = self._own.pop(result.id, None)
            if held is not None:
                self._held -= held
                self._count(result)

    def _count(self, result: FetchResult) -> None:  # under self._lock
        if result.id and result.id not in self._settled and not result.pending:
            self._remember(self._settled, result.id, None)
            self.credits_spent += result.credits
            self.calls += 1

    def _batch_started(self, batch: Batch, held: int, items: int) -> None:
        with self._lock:
            if batch.id and batch.id not in self._own_batches and batch.id not in self._settled:
                self._own_batches[batch.id] = held
                self.calls += items
            else:  # the same key again: the first submit holds the credits
                self._held -= held
        self._batch_seen(batch)

    def _batch_seen(self, batch: Batch) -> None:
        if not batch.done:
            return
        with self._lock:
            held = self._own_batches.pop(batch.id, None)
            if held is not None:
                self._held -= held
                self.credits_spent += batch.credits
                self._remember(self._settled, batch.id, None)

    # ----------------------------------------------------------------- the hook

    def _event(self, call: _Call, error: Optional[BaseException]) -> Optional[CallEvent]:
        return call.event(error) if self.on_call is not None else None

    # ----------------------------------------------------------------- one HTTP request, resent as FetchX allows

    def _send(self, call: _Call, method: str, path: str, *, params: Optional[dict] = None, json: Any = None,
              raw: bool = False, key: Optional[str] = None) -> Flow:
        waits = list(self.unavailable_waits)
        while True:
            call.requests += 1
            try:
                response = yield _Send(method, path, params, json)
            except httpx.TransportError as exc:
                error = FetchXError("network_error", f"{type(exc).__name__} while calling FetchX", idempotency_key=key)
            else:
                call.http_status = response.status_code
                problem, value = _read(response, raw, key)
                if problem is None:
                    return value
                error = problem
            if not error.retryable or not waits:
                raise error
            wait = waits.pop(0)
            if error.retry_after_seconds is not None:
                wait = min(float(error.retry_after_seconds), MAX_SERVER_WAIT)
            call.resends += 1
            log.warning("FetchX %s on %s %s; sending the same request again in %.0f s",
                        error.code, method, path, wait)
            yield _Sleep(wait)

    # ----------------------------------------------------------------- fetches

    def _fetch_flow(self, call: _Call, path: str, request: dict, want_body: Optional[bool],
                    site: Optional[str], asks: bool) -> Flow:
        base_key = request.get("idempotency_key") or new_key()
        retry = 0
        while True:
            body = dict(request, idempotency_key=base_key if retry == 0 else f"{base_key}.retry{retry}")
            held = self._cap(body)
            call.key = body["idempotency_key"]
            try:
                data = yield from self._send(call, "POST", path, json=body, key=body["idempotency_key"])
            except BaseException:
                self._release(held)
                raise
            result = FetchResult(data)
            call.result = result
            self._started(result, held, site, asks)
            if result.pending and not body.get("async"):
                result = yield from self._poll(call, result.id, wait_first=True)
            if not result.pending:
                result = yield from self._body(call, result, want_body, asks)
            call.result = result
            if not self._should_retry(result, retry):
                return result
            retry += 1
            log.info("FetchX request %s failed with %s; error.next allows a new key, sending it again as %s.retry%d",
                     result.id, result.error_code, base_key, retry)
            yield _Sleep(float(result.retry_after_seconds or 0))

    def _should_retry(self, result: FetchResult, done: int) -> bool:
        return (result.failed and result.retry_with_new_key and done < self.retry_failed
                and (result.retry_after_seconds or 0) <= self.max_retry_wait)

    def _poll(self, call: _Call, fetch_id: str, *, wait_first: bool, poll_every: Optional[float] = None,
              max_wait: Optional[float] = None) -> Flow:
        every = self.poll_every if poll_every is None else float(poll_every)
        limit = self.max_wait if max_wait is None else float(max_wait)
        deadline = time.monotonic() + limit
        path = "/v1/fetch/" + _path_id(fetch_id)
        while True:
            if wait_first:
                yield _Sleep(every)
            wait_first = True
            call.polls += 1
            data = yield from self._send(call, "GET", path, params={"include_body": "false"})
            result = FetchResult(data)
            if not result.pending:
                self._seen(result)
                return result
            if time.monotonic() >= deadline:
                raise FetchXError(
                    "wait_timeout", f"request {fetch_id} is still running after {limit:.0f} s; it goes on running, "
                    "so read it later with wait() or get(), or send it again with the same idempotency_key",
                    details={"id": fetch_id}, idempotency_key=result.idempotency_key, response=data)

    def _body(self, call: _Call, result: FetchResult, want_body: Optional[bool], asks: bool) -> Flow:
        want = self.want_body if want_body is None else want_body
        if want is None:
            want = asks
        data = result.data
        if not want or result.content is not None or not result.id or not data or data.get("content_expired"):
            return result
        if not data.get("body_bytes"):
            return result.with_content(b"", data.get("content_type"))
        try:
            content = yield from self._send(call, "GET", f"/v1/fetch/{_path_id(result.id)}/content", raw=True)
        except FetchXError as error:
            if error.code == "content_expired":
                return result
            raise
        return result.with_content(content.data, content.content_type)

    def _plan_fetch(self, body: Optional[Mapping], want_body: Optional[bool], fields: Mapping) -> Plan:
        request = _merge(body, fields)
        url = request.get("url")
        if not isinstance(url, str) or not url:
            raise FetchXError("invalid_request", "url is required", details={"field": "url"})
        site = site_of(url)
        call = _Call("fetch", url)
        return call, self._fetch_flow(call, "/v1/fetch", request, want_body, site, _asks_for_body(request)), site

    def _plan_next(self, previous: Any, idempotency_key: Optional[str], want_body: Optional[bool],
                   fields: Mapping) -> Plan:
        previous_id = previous.id if isinstance(previous, FetchResult) else str(previous or "")
        if not previous_id:
            raise FetchXError("invalid_request", "next() needs the earlier request or its id", details={"field": "id"})
        request = _merge(None, fields)
        if idempotency_key:
            request["idempotency_key"] = idempotency_key
        site, asks = self._known.get(previous_id, (None, False))
        if site is None and isinstance(previous, FetchResult):
            site, asks = site_of(previous.url), False
        call = _Call("next", previous.url if isinstance(previous, FetchResult) else None)
        path = f"/v1/fetch/{_path_id(previous_id)}/next"
        return call, self._fetch_flow(call, path, request, want_body, site, asks), site

    def _get_flow(self, call: _Call, fetch_id: str, include_body: bool, want_body: Optional[bool]) -> Flow:
        data = yield from self._send(call, "GET", "/v1/fetch/" + _path_id(fetch_id),
                                     params=None if include_body else {"include_body": "false"})
        result = FetchResult(data)
        call.result = result
        self._seen(result)
        if not result.pending:
            result = yield from self._body(call, result, want_body, False)
            call.result = result
        return result

    def _plan_get(self, fetch_id: Any, want_body: Optional[bool], include_body: bool) -> Plan:
        call = _Call("get")
        return call, self._get_flow(call, fetch_id, include_body, want_body), None

    def _plan_get_raw(self, fetch_id: Any, include_body: bool) -> Plan:
        call = _Call("get")
        flow = self._send(call, "GET", "/v1/fetch/" + _path_id(fetch_id),
                          params=None if include_body else {"include_body": "false"})
        return call, flow, None

    def _wait_flow(self, call: _Call, fetch_id: str, poll_every: Optional[float], max_wait: Optional[float],
                   want_body: Optional[bool]) -> Flow:
        result = yield from self._poll(call, fetch_id, wait_first=False, poll_every=poll_every, max_wait=max_wait)
        call.result = result
        asks = self._known.get(result.id, (None, False))[1]
        result = yield from self._body(call, result, want_body, asks)
        call.result = result
        return result

    def _plan_wait(self, fetch_id: Any, poll_every: Optional[float], max_wait: Optional[float],
                   want_body: Optional[bool]) -> Plan:
        call = _Call("wait")
        fetch_id = fetch_id.id if isinstance(fetch_id, FetchResult) else fetch_id
        return call, self._wait_flow(call, fetch_id, poll_every, max_wait, want_body), None

    def _plan_content(self, fetch_id: Any, what: str) -> Plan:
        call = _Call(what)
        return call, self._send(call, "GET", f"/v1/fetch/{_path_id(fetch_id)}/{what}", raw=True), None

    def _plan_delete(self, fetch_id: Any) -> Plan:
        call = _Call("delete")
        return call, self._send(call, "DELETE", "/v1/fetch/" + _path_id(fetch_id)), None

    def _list_flow(self, call: _Call, params: dict) -> Flow:
        data = yield from self._send(call, "GET", "/v1/fetch", params=params or None)
        items = [FetchSummary(item) for item in data.get("items") or []]
        for item in items:
            self._seen(item)  # type: ignore[arg-type]  # a summary carries what settling needs
        return ListPage(data, items)

    def _plan_list(self, **params: Any) -> Plan:
        call = _Call("list")
        return call, self._list_flow(call, _query(**params)), None

    # ----------------------------------------------------------------- batches

    def _batch_body(self, items: Sequence, defaults: Optional[Mapping], idempotency_key: Optional[str],
                    tags: Optional[Sequence[str]], webhook_url: Optional[str]) -> dict:
        if isinstance(items, (str, bytes)) or not isinstance(items, Sequence) or not items:
            raise FetchXError("invalid_request", "items must be a list of URLs or POST /v1/fetch bodies",
                              details={"field": "items"})
        if len(items) > BATCH_LIMIT:
            raise FetchXError("invalid_request", f"a batch holds up to {BATCH_LIMIT} items; split the list",
                              details={"field": "items"})
        clean: List[Any] = []
        for index, item in enumerate(items):
            if isinstance(item, str):
                clean.append(item)
                continue
            if not isinstance(item, Mapping) or not isinstance(item.get("url"), str):
                raise FetchXError("invalid_request", f"items[{index}] must be a URL or a POST /v1/fetch body with url",
                                  details={"field": f"items[{index}]"})
            for key in ITEM_ONLY_BATCH_FIELDS:
                if key in item:
                    raise FetchXError("invalid_request", f"items[{index}] sets {key}, which only the batch itself can "
                                      "set: FetchX keys each item for you and runs it at its site's pace",
                                      details={"field": f"items[{index}].{key}"})
            clean.append(dict(item))
        defaults = dict(defaults or {})
        for key in ("url",) + ITEM_ONLY_BATCH_FIELDS:
            if key in defaults:
                raise FetchXError("invalid_request", f"defaults cannot set {key}", details={"field": f"defaults.{key}"})
        if self.max_credits is not None and "max_credits" not in defaults:
            defaults["max_credits"] = self.max_credits
        body: Dict[str, Any] = {"items": clean, "idempotency_key": idempotency_key or new_key("batch")}
        if defaults:
            body["defaults"] = defaults
        if tags:
            body["tags"] = list(tags)
        if webhook_url:
            body["webhook_url"] = webhook_url
        return body

    def _submit_flow(self, call: _Call, body: dict) -> Flow:
        held = self._cap_batch(body)
        call.key = body["idempotency_key"]
        try:
            data = yield from self._send(call, "POST", "/v1/batches", json=body, key=body["idempotency_key"])
        except BaseException:
            self._release(held)
            raise
        batch = Batch(data)
        call.batch_id = batch.id
        self._batch_started(batch, held, len(body["items"]))
        return batch

    def _plan_submit_batch(self, items: Sequence, defaults: Optional[Mapping], idempotency_key: Optional[str],
                           tags: Optional[Sequence[str]], webhook_url: Optional[str]) -> Plan:
        body = self._batch_body(items, defaults, idempotency_key, tags, webhook_url)
        call = _Call("submit_batch")
        return call, self._submit_flow(call, body), None

    def _get_batch_flow(self, call: _Call, batch_id: Any, method: str = "GET", suffix: str = "") -> Flow:
        data = yield from self._send(call, method, f"/v1/batches/{_path_id(batch_id)}{suffix}")
        batch = Batch(data)
        call.batch_id = batch.id
        self._batch_seen(batch)
        return batch

    def _plan_batch(self, batch_id: Any) -> Plan:
        call = _Call("batch")
        return call, self._get_batch_flow(call, batch_id), None

    def _plan_cancel_batch(self, batch_id: Any) -> Plan:
        call = _Call("cancel_batch")
        return call, self._get_batch_flow(call, batch_id, "POST", "/cancel"), None

    def _items_flow(self, call: _Call, batch_id: Any, params: dict) -> Flow:
        call.batch_id = str(batch_id.id if isinstance(batch_id, Batch) else batch_id)
        data = yield from self._send(call, "GET", f"/v1/batches/{_path_id(batch_id)}/items", params=params)
        return ListPage(data, [BatchItem(item) for item in data.get("items") or []])

    def _plan_batch_items(self, batch_id: Any, **params: Any) -> Plan:
        call = _Call("batch_items")
        return call, self._items_flow(call, batch_id, _query(**params)), None

    def _plan_list_batches(self, **params: Any) -> Plan:
        call = _Call("list_batches")

        def flow() -> Flow:
            data = yield from self._send(call, "GET", "/v1/batches", params=_query(**params) or None)
            return ListPage(data, [Batch(item) for item in data.get("items") or []])
        return call, flow(), None

    def _wait_batch_flow(self, call: _Call, batch_id: Any, poll_every: float, max_wait: Optional[float]) -> Flow:
        deadline = None if max_wait is None else time.monotonic() + max_wait
        while True:
            batch = yield from self._get_batch_flow(call, batch_id)
            if batch.done:
                return batch
            if deadline is not None and time.monotonic() >= deadline:
                raise FetchXError("wait_timeout", f"batch {batch.id} is still {batch.status} after {max_wait:.0f} s; "
                                  "it goes on running", details={"batch_id": batch.id, "status": batch.status})
            call.polls += 1
            yield _Sleep(poll_every)

    def _plan_wait_batch(self, batch_id: Any, poll_every: float, max_wait: Optional[float]) -> Plan:
        call = _Call("wait_batch")
        return call, self._wait_batch_flow(call, batch_id, poll_every, max_wait), None

    def _feed(self, call: _Call, batch_id: str, *, poll_every: float, limit: int, results: bool,
              want_body: Optional[bool], max_wait: Optional[float], asks: Optional[Callable[[int], bool]] = None,
              sink: Optional[Callable[[BatchItem], None]] = None) -> Flow:
        """Each item once it has finished, until the batch is over (GET .../items?order=finished)."""
        call.batch_id = batch_id
        deadline = None if max_wait is None else time.monotonic() + max_wait
        cursor = None
        path = f"/v1/batches/{_path_id(batch_id)}/items"
        while True:
            page = yield from self._send(call, "GET", path, params=_query(
                order="finished", results=results, limit=limit, cursor=cursor))
            items = page.get("items") or []
            for raw in items:
                item = BatchItem(raw)
                if item.result is not None:
                    item.result = yield from self._body(call, item.result, want_body,
                                                        asks(item.index) if asks else False)
                if sink is None:
                    yield _Yield(item)
                else:
                    sink(item)
            cursor = page.get("next_cursor")
            if cursor is None:
                if batch_id in self._own_batches:
                    yield from self._get_batch_flow(call, batch_id)
                return
            if len(items) < limit:
                if deadline is not None and time.monotonic() >= deadline:
                    raise FetchXError("wait_timeout", f"batch {batch_id} still has items running after "
                                      f"{max_wait:.0f} s; it goes on running", details={"batch_id": batch_id})
                call.polls += 1
                yield _Sleep(poll_every)

    def _plan_batch_results(self, batch_id: Any, poll_every: float, limit: int, results: bool,
                            want_body: Optional[bool], max_wait: Optional[float]) -> Plan:
        call = _Call("batch_results")
        batch_id = str(batch_id.id if isinstance(batch_id, Batch) else batch_id)
        flow = self._feed(call, batch_id, poll_every=poll_every, limit=limit, results=results,
                          want_body=want_body, max_wait=max_wait)
        return call, flow, None

    def _run_batch_flow(self, call: _Call, body: dict, poll_every: float, max_wait: Optional[float],
                        want_body: Optional[bool]) -> Flow:
        batch = yield from self._submit_flow(call, body)
        items, defaults = body["items"], body.get("defaults")
        results: List[Optional[FetchResult]] = [None] * len(items)

        def asks(index: int) -> bool:
            item = items[index] if 0 <= index < len(items) else {}
            return _asks_for_body(item if isinstance(item, dict) else {}, defaults)

        def keep(item: BatchItem) -> None:
            if 0 <= item.index < len(results) and item.result is not None:
                results[item.index] = item.result

        yield from self._feed(call, batch.id, poll_every=poll_every, limit=100, results=True,
                              want_body=want_body, max_wait=max_wait, asks=asks, sink=keep)
        return results

    def _plan_run_batch(self, items: Sequence, defaults: Optional[Mapping], idempotency_key: Optional[str],
                        tags: Optional[Sequence[str]], webhook_url: Optional[str], poll_every: float,
                        max_wait: Optional[float], want_body: Optional[bool]) -> Plan:
        body = self._batch_body(items, defaults, idempotency_key, tags, webhook_url)
        call = _Call("run_batch")
        return call, self._run_batch_flow(call, body, poll_every, max_wait, want_body), None

    # ----------------------------------------------------------------- cost and account

    def _plan_estimate(self, body: Optional[Mapping], fields: Mapping) -> Plan:
        request = _merge(body, fields)
        if self.max_credits is not None:
            if "items" in request:
                request["defaults"] = {"max_credits": self.max_credits, **(request.get("defaults") or {})}
            else:
                request.setdefault("max_credits", self.max_credits)
        call = _Call("estimate", request.get("url"))

        def flow() -> Flow:
            return Estimate((yield from self._send(call, "POST", "/v1/estimate", json=request)))
        return call, flow(), None

    def _plan_get_model(self, op: str, path: str, model: type, params: Optional[dict] = None) -> Plan:
        call = _Call(op)

        def flow() -> Flow:
            return model((yield from self._send(call, "GET", path, params=params or None)))
        return call, flow(), None

    def _plan_network(self, fetch_id: Any, params: dict) -> Plan:
        return self._plan_get_model("network", f"/v1/fetch/{_path_id(fetch_id)}/network", NetworkPage, params)

    def _plan_network_call(self, fetch_id: Any, index: Any) -> Plan:
        return self._plan_get_model("network_call", f"/v1/fetch/{_path_id(fetch_id)}/network/{_path_id(str(index))}", NetworkCall)

    def _plan_network_body(self, fetch_id: Any, index: Any) -> Plan:
        call = _Call("network_body")
        return call, self._send(call, "GET", f"/v1/fetch/{_path_id(fetch_id)}/network/{_path_id(str(index))}/body", raw=True), None

    def _plan_network_har(self, fetch_id: Any, page: Optional[int]) -> Plan:
        call = _Call("network_har")
        return call, self._send(call, "GET", f"/v1/fetch/{_path_id(fetch_id)}/network.har", params=_query(page=page) or None), None

    def _plan_me(self) -> Plan:
        return self._plan_get_model("me", "/v1/me", Me)

    def _plan_send_feedback(self, body: Optional[Mapping], fields: Mapping) -> Plan:
        request = _merge(body, fields)
        call = _Call("send_feedback", request.get("url"))

        def flow() -> Flow:
            return Feedback((yield from self._send(call, "POST", "/v1/feedback", json=request)))
        return call, flow(), None

    def _plan_get_feedback(self, feedback_id: Any) -> Plan:
        return self._plan_get_model("get_feedback", f"/v1/feedback/{_path_id(feedback_id)}", Feedback)

    def _plan_balance(self) -> Plan:
        return self._plan_get_model("balance", "/v1/balance", Balance)

    def _plan_usage(self, period: Optional[str], since: Optional[str], until: Optional[str]) -> Plan:
        return self._plan_get_model("usage", "/v1/usage", Usage, _query(period=period, since=since, until=until))

    def _plan_status(self) -> Plan:
        return self._plan_get_model("status", "/v1/status", ServiceStatus)

    def _plan_prices(self) -> Plan:
        return self._plan_get_model("prices", "/v1/prices", Prices)
