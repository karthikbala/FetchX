"""The asyncio FetchX client: the same methods as ``FetchX``, to be awaited."""
from __future__ import annotations

import asyncio
import inspect
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Callable, Dict, List, Mapping, Optional, Sequence, Union

import httpx

from ._core import Flow, _Call, _Core, _Send, _Sleep, _Yield, _network_query, log
from .models import (Balance, Batch, BatchItem, Content, Estimate, Feedback, FetchResult, FetchSummary, ListPage, Me,
                     NetworkCall, NetworkPage, ServiceStatus, Usage)

_SIX_HOURS = 6 * 3600.0


class AsyncFetchX(_Core):
    """FetchX API client for asyncio. Same options and rules as ``FetchX``.

        async with AsyncFetchX() as fx:
            results = await asyncio.gather(*(fx.fetch(url=url, formats=["markdown"]) for url in urls))

    Requests to the same site still go one at a time (``per_site``); different sites run side
    by side. ``sleep`` and ``on_call`` may be plain functions or coroutine functions.
    """

    def __init__(self, base_url: Optional[str] = None, token: Optional[str] = None, *, timeout: float = 90.0,
                 transport: Optional[httpx.AsyncBaseTransport] = None,
                 http_client: Optional[httpx.AsyncClient] = None, sleep: Optional[Callable[[float], Any]] = None,
                 **options: Any):
        super().__init__(base_url, token, **options)
        if http_client is not None and transport is not None:
            raise ValueError("pass transport or http_client, not both")
        self._sleep = sleep or asyncio.sleep
        self._http = http_client or httpx.AsyncClient(timeout=timeout, transport=transport, trust_env=False,
                                                      follow_redirects=False)
        self._owns_http = http_client is None
        self._sites: Dict[str, asyncio.Semaphore] = {}

    async def aclose(self) -> None:
        if self._owns_http:
            await self._http.aclose()

    async def __aenter__(self) -> AsyncFetchX:
        return self

    async def __aexit__(self, *exc_info: Any) -> None:
        await self.aclose()

    # ----------------------------------------------------------------- running flows

    async def _step(self, step: Any) -> Any:
        if isinstance(step, _Sleep):
            if step.seconds > 0:
                waited = self._sleep(step.seconds)
                if inspect.isawaitable(waited):
                    await waited
            return None
        assert isinstance(step, _Send)
        return await self._http.request(step.method, self.base_url + step.path, params=step.params, json=step.json,
                                        headers=self._headers)

    async def _run(self, flow: Flow) -> Any:
        value: Any = None
        error: Optional[BaseException] = None
        while True:
            try:
                step = flow.send(value) if error is None else flow.throw(error)
            except StopIteration as stop:
                return stop.value
            value, error = None, None
            try:
                value = await self._step(step)
            except Exception as exc:  # into the flow: it resends after transport errors and cleans up after others
                error = exc

    @asynccontextmanager
    async def _site_slot(self, site: Optional[str]) -> AsyncIterator[None]:
        if not site or not self.per_site:
            yield
            return
        slot = self._sites.get(site)
        if slot is None:
            slot = self._sites[site] = asyncio.Semaphore(self.per_site)
        async with slot:
            yield

    async def _emit(self, call: _Call, error: Optional[BaseException]) -> None:
        event = self._event(call, error)
        if event is None:
            return
        try:
            outcome = self.on_call(event)  # type: ignore[misc]
            if inspect.isawaitable(outcome):
                await outcome
        except Exception:
            log.exception("FetchX on_call hook failed")

    async def _call(self, call: _Call, flow: Flow, site: Optional[str]) -> Any:
        try:
            async with self._site_slot(site):
                value = await self._run(flow)
        except Exception as error:
            await self._emit(call, error)
            raise
        await self._emit(call, None)
        return value

    async def _iterate(self, call: _Call, flow: Flow) -> AsyncIterator[Any]:
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
                    value = await self._step(step)
                except Exception as exc:
                    error = exc
        except Exception as exc:
            raised = exc
            raise
        finally:
            flow.close()
            await self._emit(call, raised)

    # ----------------------------------------------------------------- fetches (see FetchX for the details)

    async def fetch(self, body: Optional[Mapping[str, Any]] = None, want_body: Optional[bool] = None,
                    **fields: Any) -> FetchResult:
        """``POST /v1/fetch`` and wait for the result. See ``FetchX.fetch``."""
        return await self._call(*self._plan_fetch(body, want_body, fields))

    async def next(self, previous: Any, idempotency_key: Optional[str] = None, want_body: Optional[bool] = None,
                   **fields: Any) -> FetchResult:
        """``POST /v1/fetch/{id}/next``. See ``FetchX.next``."""
        return await self._call(*self._plan_next(previous, idempotency_key, want_body, fields))

    next_page = next

    async def get(self, fetch_id: Any, want_body: Optional[bool] = None, include_body: bool = True) -> FetchResult:
        return await self._call(*self._plan_get(fetch_id, want_body, include_body))

    async def get_raw(self, fetch_id: Any, include_body: bool = True) -> dict:
        return await self._call(*self._plan_get_raw(fetch_id, include_body))

    async def wait(self, fetch_id: Any, poll_every: Optional[float] = None, max_wait: Optional[float] = None,
                   want_body: Optional[bool] = None) -> FetchResult:
        return await self._call(*self._plan_wait(fetch_id, poll_every, max_wait, want_body))

    async def content(self, fetch_id: Any) -> Content:
        return await self._call(*self._plan_content(fetch_id, "content"))

    async def screenshot(self, fetch_id: Any) -> Content:
        return await self._call(*self._plan_content(fetch_id, "screenshot"))

    async def delete(self, fetch_id: Any) -> None:
        await self._call(*self._plan_delete(fetch_id))

    async def network(self, fetch_id: Any, type: Optional[str] = None, content_type: Optional[str] = None,
                      host: Optional[str] = None, first_party: Optional[bool] = None, status: Union[str, int, None] = None,
                      page: Optional[int] = None, phase: Optional[str] = None,
                      contains: Union[str, Sequence[str], None] = None, limit: Optional[int] = None,
                      cursor: Optional[str] = None) -> NetworkPage:
        return await self._call(*self._plan_network(fetch_id, _network_query(type, content_type, host, first_party, status,
                                                                                page, phase, contains, limit, cursor)))

    async def network_call(self, fetch_id: Any, index: int) -> NetworkCall:
        return await self._call(*self._plan_network_call(fetch_id, index))

    async def network_body(self, fetch_id: Any, index: int) -> Content:
        return await self._call(*self._plan_network_body(fetch_id, index))

    async def network_har(self, fetch_id: Any, page: Optional[int] = None) -> dict:
        return await self._call(*self._plan_network_har(fetch_id, page))

    async def list(self, status: Optional[str] = None, tag: Optional[str] = None,
                   idempotency_key: Optional[str] = None, since: Optional[str] = None, limit: Optional[int] = None,
                   cursor: Optional[str] = None) -> ListPage[FetchSummary]:
        return await self._call(*self._plan_list(status=status, tag=tag, idempotency_key=idempotency_key,
                                                 since=since, limit=limit, cursor=cursor))

    # ----------------------------------------------------------------- batches

    async def submit_batch(self, items: Sequence[Any], defaults: Optional[Mapping[str, Any]] = None,
                           idempotency_key: Optional[str] = None, tags: Optional[Sequence[str]] = None,
                           webhook_url: Optional[str] = None) -> Batch:
        """``POST /v1/batches``. See ``FetchX.submit_batch``."""
        return await self._call(*self._plan_submit_batch(items, defaults, idempotency_key, tags, webhook_url))

    async def batch(self, batch_id: Any) -> Batch:
        return await self._call(*self._plan_batch(batch_id))

    get_batch = batch

    async def batch_items(self, batch_id: Any, cursor: Optional[str] = None, order: str = "index",
                          limit: int = 100, status: Optional[str] = None,
                          results: Optional[bool] = None) -> ListPage[BatchItem]:
        return await self._call(*self._plan_batch_items(batch_id, status=status, order=order, results=results,
                                                        limit=limit, cursor=cursor))

    def batch_results(self, batch_id: Any, poll_every: float = 5.0, limit: int = 100, results: bool = True,
                      want_body: Optional[bool] = None, max_wait: Optional[float] = None) -> AsyncIterator[BatchItem]:
        """``async for item in fx.batch_results(batch.id)``: each item once it has finished."""
        call, flow, _ = self._plan_batch_results(batch_id, poll_every, limit, results, want_body, max_wait)
        return self._iterate(call, flow)

    async def wait_batch(self, batch_id: Any, poll_every: float = 10.0,
                         max_wait: Optional[float] = _SIX_HOURS) -> Batch:
        return await self._call(*self._plan_wait_batch(batch_id, poll_every, max_wait))

    async def run_batch(self, items: Sequence[Any], defaults: Optional[Mapping[str, Any]] = None,
                        idempotency_key: Optional[str] = None, tags: Optional[Sequence[str]] = None,
                        poll_every: float = 10.0, max_wait: Optional[float] = _SIX_HOURS,
                        want_body: Optional[bool] = None,
                        webhook_url: Optional[str] = None) -> List[Optional[FetchResult]]:
        """Submit, wait and return one result per item. See ``FetchX.run_batch``."""
        return await self._call(*self._plan_run_batch(items, defaults, idempotency_key, tags, webhook_url,
                                                      poll_every, max_wait, want_body))

    async def cancel_batch(self, batch_id: Any) -> Batch:
        return await self._call(*self._plan_cancel_batch(batch_id))

    async def list_batches(self, status: Optional[str] = None, limit: Optional[int] = None,
                           cursor: Optional[str] = None) -> ListPage[Batch]:
        return await self._call(*self._plan_list_batches(status=status, limit=limit, cursor=cursor))

    # ----------------------------------------------------------------- cost and account

    async def estimate(self, body: Optional[Mapping[str, Any]] = None, **fields: Any) -> Estimate:
        return await self._call(*self._plan_estimate(body, fields))

    async def balance(self) -> Balance:
        return await self._call(*self._plan_balance())

    async def me(self) -> Me:
        return await self._call(*self._plan_me())

    async def send_feedback(self, body: Optional[Mapping[str, Any]] = None, **fields: Any) -> Feedback:
        """``POST /v1/feedback``: see ``FetchX.send_feedback``."""
        return await self._call(*self._plan_send_feedback(body, fields))

    async def get_feedback(self, feedback_id: Any) -> Feedback:
        """``GET /v1/feedback/{id}``: see ``FetchX.get_feedback``."""
        return await self._call(*self._plan_get_feedback(feedback_id))

    async def usage(self, period: Optional[str] = None, since: Optional[str] = None,
                    until: Optional[str] = None) -> Usage:
        return await self._call(*self._plan_usage(period, since, until))

    async def status(self) -> ServiceStatus:
        return await self._call(*self._plan_status())
