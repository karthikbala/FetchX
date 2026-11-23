"""The synchronous FetchX client."""
from __future__ import annotations

import threading
import time
from contextlib import contextmanager
from typing import Any, Callable, Dict, Iterator, List, Mapping, Optional, Sequence, Union

import httpx

from ._core import Flow, _Call, _Core, _Send, _Sleep, _Yield, _network_query, log
from .models import (Balance, Batch, BatchItem, Content, Estimate, FetchResult, FetchSummary, ListPage, Me,
                     NetworkCall, NetworkPage, ServiceStatus, Usage)

_SIX_HOURS = 6 * 3600.0


class FetchX(_Core):
    """FetchX API client.

        fx = FetchX()                     # FETCHX_TOKEN (and optionally FETCHX_URL) from the environment
        result = fx.fetch(url="https://example.com/", formats=["markdown"])
        if result.ok:
            print(result.markdown)
        else:
            print(result.error_code, result.next_action, result.retry_with_new_key)

    What it does for you:

    - Every request that starts work carries an ``idempotency_key`` (generated when you leave
      it out). After a lost answer, a 429 or a 502/503/504 the same body is sent again with the
      same key, after ``unavailable_waits`` (or FetchX's Retry-After). FetchX returns the first
      result for a key and never charges twice, so the resend is safe.
    - ``fetch()`` and ``next()`` wait through a 202 by polling ``GET /v1/fetch/{id}`` every
      ``poll_every`` seconds for up to ``max_wait`` (unless the request sets ``async``).
    - A refused call (4xx) raises ``FetchXError``: nothing was sent to the site or charged. A
      fetch that ran and failed is returned, and ``result.error.next`` says what to do. With
      ``retry_failed=N`` the client sends a failed request again with a new key (``<key>.retryN``)
      only when FetchX says that can help (``retry_with_new_key``), after its ``retry_after_seconds``.
    - Single fetches go one at a time per site (``per_site=1``; the host without ``www.``), also
      across threads. Batches are paced by FetchX itself.
    - ``max_credits`` caps every request that sets none. ``spend_limit`` caps what this client
      may spend in total: each request's ``max_credits`` is lowered to what is left, and a call
      that would pass it raises ``SpendLimitReached`` before anything is sent.
    - ``on_call`` is called with a ``CallEvent`` after every call (id, credits, step, outcome).
      Errors in the hook are logged, never raised.

    Options:
        base_url: API origin; default ``FETCHX_URL`` or https://app.fetchx.ai.
        token: API key; default ``FETCHX_TOKEN`` (or ``FETCHX_API_KEY``).
        timeout: seconds per HTTP request (FetchX answers a fetch within 60 s, then 202).
        transport / http_client: an ``httpx`` transport (``FakeFetchX().transport()`` in tests)
            or a whole ``httpx.Client`` of your own (for proxies and the like).
        sleep: how to wait (``time.sleep``); tests pass ``lambda seconds: None``.
        want_body: default for the methods' ``want_body`` (None: download the body when the
            request asked for it in ``formats``).
    """

    def __init__(self, base_url: Optional[str] = None, token: Optional[str] = None, *, timeout: float = 90.0,
                 transport: Optional[httpx.BaseTransport] = None, http_client: Optional[httpx.Client] = None,
                 sleep: Optional[Callable[[float], Any]] = None, **options: Any):
        super().__init__(base_url, token, **options)
        if http_client is not None and transport is not None:
            raise ValueError("pass transport or http_client, not both")
        self._sleep = sleep or time.sleep
        self._http = http_client or httpx.Client(timeout=timeout, transport=transport, trust_env=False,
                                                 follow_redirects=False)
        self._owns_http = http_client is None
        self._sites: Dict[str, threading.BoundedSemaphore] = {}
        self._sites_lock = threading.Lock()

    def close(self) -> None:
        if self._owns_http:
            self._http.close()

    def __enter__(self) -> FetchX:
        return self

    def __exit__(self, *exc_info: Any) -> None:
        self.close()

    # ----------------------------------------------------------------- running flows

    def _step(self, step: Any) -> Any:
        if isinstance(step, _Sleep):
            if step.seconds > 0:
                self._sleep(step.seconds)
            return None
        assert isinstance(step, _Send)
        return self._http.request(step.method, self.base_url + step.path, params=step.params, json=step.json,
                                  headers=self._headers)

    def _run(self, flow: Flow) -> Any:
        value: Any = None
        error: Optional[BaseException] = None
        while True:
            try:
                step = flow.send(value) if error is None else flow.throw(error)
            except StopIteration as stop:
                return stop.value
            value, error = None, None
            try:
                value = self._step(step)
            except Exception as exc:  # into the flow: it resends after transport errors and cleans up after others
                error = exc

    @contextmanager
    def _site_slot(self, site: Optional[str]) -> Iterator[None]:
        if not site or not self.per_site:
            yield
            return
        with self._sites_lock:
            slot = self._sites.get(site)
            if slot is None:
                slot = self._sites[site] = threading.BoundedSemaphore(self.per_site)
        with slot:
            yield

    def _emit(self, call: _Call, error: Optional[BaseException]) -> None:
        event = self._event(call, error)
        if event is None:
            return
        try:
            self.on_call(event)  # type: ignore[misc]
        except Exception:
            log.exception("FetchX on_call hook failed")

    def _call(self, call: _Call, flow: Flow, site: Optional[str]) -> Any:
        try:
            with self._site_slot(site):
                value = self._run(flow)
        except Exception as error:
            self._emit(call, error)
            raise
        self._emit(call, None)
        return value

    def _iterate(self, call: _Call, flow: Flow) -> Iterator[Any]:
        value: Any = None
        error: Optional[BaseException] = None
        raised: Optional[BaseException] = None
        try:
            while True:
                try:
                    step = flow.send(value) if error is None else flow.throw(error)
                except StopIteration:
                    return
                value, error = None, None
                if isinstance(step, _Yield):
                    yield step.value
                    continue
                try:
                    value = self._step(step)
                except Exception as exc:
                    error = exc
        except Exception as exc:
            raised = exc
            raise
        finally:
            flow.close()
            self._emit(call, raised)

    # ----------------------------------------------------------------- fetches

    def fetch(self, body: Optional[Mapping[str, Any]] = None, want_body: Optional[bool] = None,
              **fields: Any) -> FetchResult:
        """``POST /v1/fetch`` and wait for the result.

        Pass the request as a dict, as keyword fields, or both (``async_=True`` for ``async``):
        ``fx.fetch(url=..., formats=["markdown"], expect={"text": "Price"}, max_credits=60)``.
        Returns the result whether it succeeded or failed; raises ``FetchXError`` only when
        FetchX refused the call (nothing sent, nothing charged), when it stayed unavailable
        through every resend, or ``wait_timeout`` past ``max_wait`` (the request goes on
        running; read it later with ``wait()``). With ``async`` set it returns the pending result.

        ``want_body``: True downloads the body even when ``formats`` did not ask for it, False
        never downloads it; None (default) downloads it when ``formats`` asked for ``body``.
        """
        return self._call(*self._plan_fetch(body, want_body, fields))

    def next(self, previous: Any, idempotency_key: Optional[str] = None, want_body: Optional[bool] = None,
             **fields: Any) -> FetchResult:
        """``POST /v1/fetch/{id}/next``: the page after ``previous`` (a result or its id), as a new
        request with its own id, ``next_page`` and charge. ``fields`` may hold ``scroll``,
        ``expect``, ``max_credits``, ``timeout_ms``, ``async``, ``webhook_url`` and ``tags``.
        Waits like ``fetch()`` and shares the earlier request's site slot."""
        return self._call(*self._plan_next(previous, idempotency_key, want_body, fields))

    next_page = next

    def get(self, fetch_id: Any, want_body: Optional[bool] = None, include_body: bool = True) -> FetchResult:
        """``GET /v1/fetch/{id}``: the request as it is now (it may still be pending)."""
        return self._call(*self._plan_get(fetch_id, want_body, include_body))

    def get_raw(self, fetch_id: Any, include_body: bool = True) -> dict:
        """``GET /v1/fetch/{id}`` as the JSON FetchX sent."""
        return self._call(*self._plan_get_raw(fetch_id, include_body))

    def wait(self, fetch_id: Any, poll_every: Optional[float] = None, max_wait: Optional[float] = None,
             want_body: Optional[bool] = None) -> FetchResult:
        """Poll a request until it is no longer pending."""
        return self._call(*self._plan_wait(fetch_id, poll_every, max_wait, want_body))

    def content(self, fetch_id: Any) -> Content:
        """``GET /v1/fetch/{id}/content``: the body exactly as received, with its Content-Type."""
        return self._call(*self._plan_content(fetch_id, "content"))

    def screenshot(self, fetch_id: Any) -> Content:
        """``GET /v1/fetch/{id}/screenshot``: the JPEG."""
        return self._call(*self._plan_content(fetch_id, "screenshot"))

    def delete(self, fetch_id: Any) -> None:
        """``DELETE /v1/fetch/{id}``: delete everything the site sent, now."""
        self._call(*self._plan_delete(fetch_id))

    def network(self, fetch_id: Any, type: Optional[str] = None, content_type: Optional[str] = None,
                host: Optional[str] = None, first_party: Optional[bool] = None, status: Union[str, int, None] = None,
                page: Optional[int] = None, phase: Optional[str] = None, contains: Union[str, Sequence[str], None] = None,
                limit: Optional[int] = None, cursor: Optional[str] = None) -> NetworkPage:
        """``GET /v1/fetch/{id}/network``: the calls a request made with ``capture`` recorded, in order.

        ``contains`` (a value or up to 5) keeps calls whose response body holds one of them, compared without
        case: pass a name or price the page shows to find the call that carries the data."""
        return self._call(*self._plan_network(fetch_id, _network_query(type, content_type, host, first_party, status, page,
                                                                          phase, contains, limit, cursor)))

    def network_call(self, fetch_id: Any, index: int) -> NetworkCall:
        """``GET /v1/fetch/{id}/network/{index}``: one recorded call with its headers and bodies."""
        return self._call(*self._plan_network_call(fetch_id, index))

    def network_body(self, fetch_id: Any, index: int) -> Content:
        """``GET /v1/fetch/{id}/network/{index}/body``: one recorded call's response body, for one over 1 MB."""
        return self._call(*self._plan_network_body(fetch_id, index))

    def network_har(self, fetch_id: Any, page: Optional[int] = None) -> dict:
        """``GET /v1/fetch/{id}/network.har``: the capture as a HAR 1.2 document, for browser developer tools."""
        return self._call(*self._plan_network_har(fetch_id, page))

    def list(self, status: Optional[str] = None, tag: Optional[str] = None, idempotency_key: Optional[str] = None,
             since: Optional[str] = None, limit: Optional[int] = None,
             cursor: Optional[str] = None) -> ListPage[FetchSummary]:
        """``GET /v1/fetch``: request summaries, newest first. ``idempotency_key`` finds the one
        sent with it; ``get(summary.id)`` reads the whole result."""
        return self._call(*self._plan_list(status=status, tag=tag, idempotency_key=idempotency_key, since=since,
                                           limit=limit, cursor=cursor))

    # ----------------------------------------------------------------- batches

    def submit_batch(self, items: Sequence[Any], defaults: Optional[Mapping[str, Any]] = None,
                     idempotency_key: Optional[str] = None, tags: Optional[Sequence[str]] = None,
                     webhook_url: Optional[str] = None) -> Batch:
        """``POST /v1/batches``: up to 1000 URLs or fetch bodies in one job. Returns at once.

        Items must not set ``idempotency_key``, ``async`` or ``webhook_url`` (FetchX keys and
        paces each item itself); ``defaults`` holds fields every item gets, ``max_credits``
        there caps each item. Raises before sending when an item breaks these rules.
        """
        return self._call(*self._plan_submit_batch(items, defaults, idempotency_key, tags, webhook_url))

    def batch(self, batch_id: Any) -> Batch:
        """``GET /v1/batches/{id}``."""
        return self._call(*self._plan_batch(batch_id))

    get_batch = batch

    def batch_items(self, batch_id: Any, cursor: Optional[str] = None, order: str = "index", limit: int = 100,
                    status: Optional[str] = None, results: Optional[bool] = None) -> ListPage[BatchItem]:
        """``GET /v1/batches/{id}/items``: one page of items, with their results (without bodies)."""
        return self._call(*self._plan_batch_items(batch_id, status=status, order=order, results=results,
                                                  limit=limit, cursor=cursor))

    def batch_results(self, batch_id: Any, poll_every: float = 5.0, limit: int = 100, results: bool = True,
                      want_body: Optional[bool] = None, max_wait: Optional[float] = None) -> Iterator[BatchItem]:
        """Yield each item once it has finished, until the batch is over. Bodies are downloaded
        only with ``want_body=True`` (or the client's ``want_body``)."""
        call, flow, _ = self._plan_batch_results(batch_id, poll_every, limit, results, want_body, max_wait)
        return self._iterate(call, flow)

    def wait_batch(self, batch_id: Any, poll_every: float = 10.0, max_wait: Optional[float] = _SIX_HOURS) -> Batch:
        """Poll a batch until nothing in it can change any more."""
        return self._call(*self._plan_wait_batch(batch_id, poll_every, max_wait))

    def run_batch(self, items: Sequence[Any], defaults: Optional[Mapping[str, Any]] = None,
                  idempotency_key: Optional[str] = None, tags: Optional[Sequence[str]] = None,
                  poll_every: float = 10.0, max_wait: Optional[float] = _SIX_HOURS, want_body: Optional[bool] = None,
                  webhook_url: Optional[str] = None) -> List[Optional[FetchResult]]:
        """Submit a batch, wait for it and return one result per item, in order (None for an
        item that never ran). Bodies are downloaded as for ``fetch()``, per item."""
        return self._call(*self._plan_run_batch(items, defaults, idempotency_key, tags, webhook_url, poll_every,
                                                max_wait, want_body))

    def cancel_batch(self, batch_id: Any) -> Batch:
        """``POST /v1/batches/{id}/cancel``: stop the items that have not started."""
        return self._call(*self._plan_cancel_batch(batch_id))

    def list_batches(self, status: Optional[str] = None, limit: Optional[int] = None,
                     cursor: Optional[str] = None) -> ListPage[Batch]:
        """``GET /v1/batches``: batches, newest first."""
        return self._call(*self._plan_list_batches(status=status, limit=limit, cursor=cursor))

    # ----------------------------------------------------------------- cost and account

    def estimate(self, body: Optional[Mapping[str, Any]] = None, **fields: Any) -> Estimate:
        """``POST /v1/estimate``: what a fetch body, or a batch body (``items``, ``defaults``),
        would cost and take. Nothing is sent, reserved or charged."""
        return self._call(*self._plan_estimate(body, fields))

    def balance(self) -> Balance:
        """``GET /v1/balance``: credits available now, reserved, trial and purchased."""
        return self._call(*self._plan_balance())

    def me(self) -> Me:
        """``GET /v1/me``: the project (the same after a key is rotated) and this key's id, name, prefix and scopes."""
        return self._call(*self._plan_me())

    def usage(self, period: Optional[str] = None, since: Optional[str] = None, until: Optional[str] = None) -> Usage:
        """``GET /v1/usage``: balance and usage for a day, a month (default) or a range."""
        return self._call(*self._plan_usage(period, since, until))

    def status(self) -> ServiceStatus:
        """``GET /v1/status``: the API's state and notices."""
        return self._call(*self._plan_status())
