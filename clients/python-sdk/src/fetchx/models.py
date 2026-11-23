"""Typed views of FetchX answers.

Each one keeps the JSON it was made from in ``.raw`` and also reads like that JSON
(``result["data"]``, ``result.get("error")``), so code written against the API guide keeps
working. Fields FetchX adds later are in ``.raw`` before they get a property here.
"""
from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass
from typing import Any, Dict, Generic, Iterator, List, Optional, TypeVar, Union

T = TypeVar("T")


class Model:
    """Base of every typed answer: attribute access for known fields, mapping access for all."""

    def __init__(self, raw: Optional[dict] = None):
        self.raw: dict = raw if isinstance(raw, dict) else {}

    def __getitem__(self, key: str) -> Any:
        return self.raw[key]

    def get(self, key: str, default: Any = None) -> Any:
        return self.raw.get(key, default)

    def __contains__(self, key: object) -> bool:
        return key in self.raw

    def to_dict(self) -> dict:
        return self.raw

    def __eq__(self, other: object) -> bool:
        return type(other) is type(self) and other.raw == self.raw  # type: ignore[attr-defined]

    __hash__ = None  # type: ignore[assignment]

    def __repr__(self) -> str:
        shown = ", ".join(f"{key}={value!r}" for key, value in self._repr_fields().items() if value is not None)
        return f"{type(self).__name__}({shown})"

    def _repr_fields(self) -> dict:
        return {}


def _model(cls, value):
    return cls(value) if isinstance(value, dict) else None


def _int(value) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


# --------------------------------------------------------------------------- fetch results

class NextStep(Model):
    """``error.next``: what to do about a failed fetch."""

    @property
    def action(self) -> Optional[str]:
        """retry_after, retry_later, check_expect, use_auto, provide_credentials, check_url,
        raise_timeout, render_never, recover or refetch_previous."""
        return self.raw.get("action")

    @property
    def retry_with_new_key(self) -> bool:
        """True when the same request may succeed if sent again with a new idempotency_key
        (after retry_after_seconds). False: change it as ``action`` says first."""
        return bool(self.raw.get("retry_with_new_key"))

    @property
    def retry_after_seconds(self) -> Optional[int]:
        return self.raw.get("retry_after_seconds")

    @property
    def detail(self) -> str:
        return self.raw.get("detail") or ""

    def _repr_fields(self):
        return {"action": self.action, "retry_with_new_key": self.retry_with_new_key,
                "retry_after_seconds": self.retry_after_seconds}


class FetchFailure(Model):
    """``error`` on a failed fetch: ``code``, ``message`` and ``next``."""

    @property
    def code(self) -> str:
        return self.raw.get("code") or ""

    @property
    def message(self) -> str:
        return self.raw.get("message") or ""

    @property
    def retry_after_seconds(self) -> Optional[int]:
        return self.raw.get("retry_after_seconds")

    @property
    def next(self) -> NextStep:
        return NextStep(self.raw.get("next"))

    def _repr_fields(self):
        return {"code": self.code, "next": self.next.action}


class Challenge(Model):
    """Walls (bot checks, blocks, rate limits) the request met, and how FetchX got past."""

    @property
    def vendor(self) -> Optional[str]:
        return self.raw.get("vendor")

    @property
    def walls(self) -> int:
        return _int(self.raw.get("walls"))

    @property
    def passed(self) -> bool:
        return bool(self.raw.get("passed"))

    @property
    def passed_by(self) -> Optional[str]:
        return self.raw.get("passed_by")

    def _repr_fields(self):
        return {"vendor": self.vendor, "walls": self.walls, "passed": self.passed}


class CreditBreakdown(Model):
    """How a success's price adds up: step + captcha + traffic + extract, capped at max."""

    @property
    def step(self) -> Optional[str]:
        """http, http_residential, browser or browser_residential."""
        return self.raw.get("step")

    @property
    def step_credits(self) -> int:
        return _int(self.raw.get("step_credits"))

    @property
    def captcha_credits(self) -> int:
        return _int(self.raw.get("captcha_credits"))

    @property
    def traffic_mb(self) -> float:
        return float(self.raw.get("traffic_mb") or 0)

    @property
    def traffic_credits(self) -> int:
        return _int(self.raw.get("traffic_credits"))

    @property
    def extract_credits(self) -> int:
        return _int(self.raw.get("extract_credits"))

    def _repr_fields(self):
        return {"step": self.step, "step_credits": self.step_credits}


class NextPage(Model):
    """``data.next_page``: how a page leads on. Open it with ``client.next(result)``."""

    @property
    def how(self) -> Optional[str]:
        """link, click or scroll."""
        return self.raw.get("how")

    @property
    def url(self) -> Optional[str]:
        return self.raw.get("url")

    def _repr_fields(self):
        return {"how": self.how, "url": self.url}


class PageInfo(Model):
    """``data.page``: where this page sits in a list read page by page."""

    @property
    def number(self) -> int:
        return _int(self.raw.get("number")) or 1

    @property
    def previous_id(self) -> Optional[str]:
        return self.raw.get("previous_id")

    @property
    def screens(self) -> int:
        return _int(self.raw.get("screens"))

    @property
    def end(self) -> Optional[bool]:
        return self.raw.get("end")

    def _repr_fields(self):
        return {"number": self.number, "screens": self.screens, "end": self.end}


class FetchResult(Model):
    """A FetchX request: ``succeeded``, ``failed`` or ``pending``.

    ``body`` and ``content`` hold the site's response body when the request asked for it
    (``formats`` with ``body``, the default) or the call passed ``want_body=True``.

    ``FetchResult(raw, content)`` builds one by hand, for example from a cache or a test.
    ``content`` may be bytes or text; text is kept as ``body`` and encoded as UTF-8 for ``content``.
    """

    def __init__(self, raw: Optional[dict] = None, content: Union[bytes, str, None] = None,
                 content_type: Optional[str] = None):
        super().__init__(raw)
        self._content_type = content_type
        self._text: Optional[str] = None
        if isinstance(content, str):
            self._text, content = content, content.encode("utf-8")
        self._content = content if content is not None else _inline_body(self.data)

    def with_content(self, content: Optional[bytes], content_type: Optional[str] = None) -> FetchResult:
        return FetchResult(self.raw, content, content_type)

    # -- the request
    @property
    def id(self) -> str:
        return self.raw.get("id") or ""

    @property
    def status(self) -> str:
        """pending, succeeded or failed."""
        return self.raw.get("status") or ""

    @property
    def ok(self) -> bool:
        return self.status == "succeeded"

    succeeded = ok

    @property
    def failed(self) -> bool:
        return self.status == "failed"

    @property
    def pending(self) -> bool:
        return self.status == "pending"

    @property
    def url(self) -> str:
        return self.raw.get("url") or ""

    @property
    def idempotency_key(self) -> Optional[str]:
        return self.raw.get("idempotency_key")

    @property
    def tags(self) -> List[str]:
        return list(self.raw.get("tags") or [])

    @property
    def created_at(self) -> Optional[str]:
        return self.raw.get("created_at")

    @property
    def finished_at(self) -> Optional[str]:
        return self.raw.get("finished_at")

    @property
    def page_status(self) -> Optional[str]:
        """content, not_found, empty, challenge or error (None while pending)."""
        return self.raw.get("page_status")

    @property
    def batch(self) -> Optional[dict]:
        """``{"id", "index"}`` when this request is a batch item."""
        return self.raw.get("batch")

    # -- what the site answered
    @property
    def data(self) -> dict:
        return self.raw.get("data") or {}

    @property
    def source_status(self) -> Optional[int]:
        """The site's HTTP status."""
        return self.data.get("status_code")

    @property
    def final_url(self) -> str:
        return self.data.get("final_url") or self.url

    @property
    def content_type(self) -> str:
        return (self.data.get("content_type") or self._content_type or "").lower()

    @property
    def body_bytes(self) -> int:
        """Size of the site's body in bytes (the body itself is ``content``)."""
        return _int(self.data.get("body_bytes"))

    @property
    def headers(self) -> Dict[str, str]:
        return self.data.get("headers") or {}

    @property
    def cookies(self) -> List[dict]:
        return self.data.get("cookies") or []

    @property
    def rendered(self) -> bool:
        return bool(self.data.get("rendered"))

    @property
    def content_expired(self) -> bool:
        return bool(self.data.get("content_expired"))

    @property
    def content(self) -> Optional[bytes]:
        """The body exactly as received, when it was asked for."""
        return self._content

    @property
    def body(self) -> Optional[str]:
        """The body as text (binary bodies decoded with replacement characters)."""
        if self._text is not None:
            return self._text
        if self._content is None:
            return None
        return self._content.decode(_charset(self.content_type), "replace")

    @property
    def markdown(self) -> Optional[str]:
        return self.data.get("markdown")

    @property
    def text(self) -> Optional[str]:
        """``formats: text``: the page's readable text (not the raw body; see ``body``)."""
        return self.data.get("text")

    @property
    def links(self) -> List[dict]:
        return self.data.get("links") or []

    @property
    def metadata(self) -> dict:
        return self.data.get("metadata") or {}

    @property
    def extract(self) -> Any:
        return self.data.get("extract")

    @property
    def extract_report(self) -> Optional[dict]:
        return self.data.get("extract_report")

    @property
    def network(self) -> Optional[dict]:
        """For a request made with ``capture``: calls captured and dropped, and where to read them."""
        return self.raw.get("network")

    @property
    def screenshot(self) -> Optional[bytes]:
        """``formats: screenshot``: the JPEG, decoded."""
        value = self.data.get("screenshot")
        return _b64(value) if isinstance(value, str) else None

    @property
    def page(self) -> Optional[PageInfo]:
        return _model(PageInfo, self.data.get("page"))

    @property
    def next_page(self) -> Optional[NextPage]:
        return _model(NextPage, self.data.get("next_page"))

    @property
    def has_next_page(self) -> bool:
        return self.ok and self.next_page is not None

    # -- failures
    @property
    def error(self) -> Optional[FetchFailure]:
        return _model(FetchFailure, self.raw.get("error"))

    @property
    def error_code(self) -> Optional[str]:
        error = self.error
        return error.code if error else None

    @property
    def next_action(self) -> Optional[str]:
        error = self.error
        return error.next.action if error else None

    @property
    def retry_with_new_key(self) -> bool:
        error = self.error
        return bool(error and error.next.retry_with_new_key)

    @property
    def retry_after_seconds(self) -> Optional[int]:
        error = self.error
        if not error:
            return None
        after = error.next.retry_after_seconds
        return after if after is not None else error.retry_after_seconds

    @property
    def challenge(self) -> Optional[Challenge]:
        return _model(Challenge, self.raw.get("challenge"))

    def raise_for_status(self) -> FetchResult:
        """Raise ``FetchFailed`` unless the request succeeded; returns the result otherwise."""
        if not self.ok:
            from .errors import FetchFailed
            raise FetchFailed(self)
        return self

    # -- cost and route
    @property
    def credits(self) -> int:
        """Credits charged (0 unless it succeeded)."""
        return _int((self.raw.get("credits") or {}).get("charged"))

    @property
    def credits_max(self) -> Optional[int]:
        """The most this request could have cost."""
        return (self.raw.get("credits") or {}).get("max")

    @property
    def balance(self) -> Optional[int]:
        """The project's balance as this answer was made (None when unmetered)."""
        return (self.raw.get("credits") or {}).get("balance")

    @property
    def breakdown(self) -> Optional[CreditBreakdown]:
        return _model(CreditBreakdown, (self.raw.get("credits") or {}).get("breakdown"))

    @property
    def step(self) -> Optional[str]:
        """The step that got the data: http, http_residential, browser or browser_residential."""
        breakdown = self.breakdown
        return breakdown.step if breakdown else None

    @property
    def attempts(self) -> List[dict]:
        return list(self.raw.get("attempts") or [])

    @property
    def last_attempt(self) -> dict:
        attempts = self.attempts
        return attempts[-1] if attempts else {}

    @property
    def skipped(self) -> List[dict]:
        return list(self.raw.get("skipped") or [])

    @property
    def fixes(self) -> List[str]:
        return list(self.raw.get("fixes") or [])

    def summary(self) -> dict:
        """A compact, log-friendly view: ids, outcome, cost, route and what to do next."""
        error = self.error
        attempt = self.last_attempt
        return {key: value for key, value in {
            "fetchx_id": self.id, "status": self.status, "page_status": self.page_status,
            "source_status": self.source_status, "content_type": self.content_type or None,
            "bytes": self.body_bytes, "credits": self.credits, "step": self.step,
            "rendered": self.rendered, "final_url": self.final_url,
            "challenge_vendor": self.challenge.vendor if self.challenge else None,
            "error_code": error.code if error else None, "next_action": error.next.action if error else None,
            "retry_with_new_key": error.next.retry_with_new_key if error else None,
            "route": {key: attempt.get(key) for key in ("transport", "class", "country")} if attempt else None,
        }.items() if value not in (None, "", [])}

    def _repr_fields(self):
        return {"id": self.id, "status": self.status, "page_status": self.page_status,
                "url": self.url, "credits": self.credits, "error": self.error_code}


class FetchSummary(Model):
    """A request as ``GET /v1/fetch`` lists it. Read the whole result with ``client.get(summary.id)``."""

    @property
    def id(self) -> str:
        return self.raw.get("id") or ""

    @property
    def status(self) -> str:
        return self.raw.get("status") or ""

    @property
    def ok(self) -> bool:
        return self.status == "succeeded"

    @property
    def failed(self) -> bool:
        return self.status == "failed"

    @property
    def pending(self) -> bool:
        return self.status == "pending"

    @property
    def url(self) -> str:
        return self.raw.get("url") or ""

    @property
    def created_at(self) -> Optional[str]:
        return self.raw.get("created_at")

    @property
    def credits(self) -> int:
        return _int((self.raw.get("credits") or {}).get("charged"))

    @property
    def error_code(self) -> Optional[str]:
        return self.raw.get("error_code")

    @property
    def tags(self) -> List[str]:
        return list(self.raw.get("tags") or [])

    @property
    def idempotency_key(self) -> Optional[str]:
        return self.raw.get("idempotency_key")

    def _repr_fields(self):
        return {"id": self.id, "status": self.status, "url": self.url, "credits": self.credits,
                "error": self.error_code}


def _inline_body(data: dict) -> Optional[bytes]:
    body = data.get("body")
    if not isinstance(body, str):
        return None
    if data.get("body_encoding") == "base64":
        return _b64(body)
    return body.encode("utf-8")


def _b64(value: str) -> Optional[bytes]:
    try:
        return base64.b64decode(value)
    except (binascii.Error, ValueError):
        return None


def _charset(content_type: Optional[str]) -> str:
    for part in (content_type or "").split(";")[1:]:
        name, _, value = part.strip().partition("=")
        if name.lower() == "charset" and value:
            charset = value.strip().strip('"')
            try:
                "".encode(charset)
                return charset
            except LookupError:
                break
    return "utf-8"


# --------------------------------------------------------------------------- other answers

class Content:
    """A stored body or screenshot: ``data`` (bytes), ``content_type`` and ``text``.

    Also reads like the older client's dict: ``content["body"]``, ``content["content_type"]``.
    """

    def __init__(self, data: bytes, content_type: Optional[str] = None):
        self.data = data
        self.content_type = content_type

    @property
    def text(self) -> str:
        return self.data.decode(_charset(self.content_type), "replace")

    def __getitem__(self, key: str) -> Any:
        if key == "body":
            return self.data
        if key == "content_type":
            return self.content_type
        raise KeyError(key)

    def __eq__(self, other: object) -> bool:
        return isinstance(other, Content) and (other.data, other.content_type) == (self.data, self.content_type)

    __hash__ = None  # type: ignore[assignment]

    def __len__(self) -> int:
        return len(self.data)

    def __repr__(self) -> str:
        return f"Content({len(self.data)} bytes, content_type={self.content_type!r})"


class ListPage(Model, Generic[T]):
    """One page of a list: ``items`` and ``next_cursor`` (None on the last page)."""

    def __init__(self, raw: Optional[dict], items: List[T]):
        super().__init__(raw)
        self.items = items

    @property
    def next_cursor(self) -> Optional[str]:
        return self.raw.get("next_cursor")

    def __iter__(self) -> Iterator[T]:
        return iter(self.items)

    def __len__(self) -> int:
        return len(self.items)

    def _repr_fields(self):
        return {"items": len(self.items), "next_cursor": self.next_cursor}


class Batch(Model):
    """A batch: ``status`` running, paused, finished or canceled; ``items`` counts by status."""

    @property
    def id(self) -> str:
        return self.raw.get("id") or ""

    @property
    def status(self) -> str:
        return self.raw.get("status") or ""

    @property
    def paused_reason(self) -> Optional[str]:
        return self.raw.get("paused_reason")

    @property
    def idempotency_key(self) -> Optional[str]:
        return self.raw.get("idempotency_key")

    @property
    def tags(self) -> List[str]:
        return list(self.raw.get("tags") or [])

    @property
    def items(self) -> Dict[str, int]:
        """Item counts: total, queued, running, succeeded, failed, canceled."""
        return dict(self.raw.get("items") or {})

    @property
    def total(self) -> int:
        return _int(self.items.get("total"))

    @property
    def credits(self) -> int:
        """Credits charged so far (only successful items are charged)."""
        return _int((self.raw.get("credits") or {}).get("charged"))

    @property
    def created_at(self) -> Optional[str]:
        return self.raw.get("created_at")

    @property
    def finished_at(self) -> Optional[str]:
        return self.raw.get("finished_at")

    @property
    def canceled_at(self) -> Optional[str]:
        return self.raw.get("canceled_at")

    @property
    def webhook(self) -> bool:
        return bool(self.raw.get("webhook"))

    @property
    def done(self) -> bool:
        """True once nothing in the batch can change: every item finished, or it was canceled
        with nothing running."""
        return self.finished_at is not None or self.status == "finished"

    def _repr_fields(self):
        return {"id": self.id, "status": self.status, "items": self.items or None, "credits": self.credits}


class BatchItem(Model):
    """One item of a batch, with its result once it has finished."""

    def __init__(self, raw: Optional[dict] = None, result: Optional[FetchResult] = None):
        super().__init__(raw)
        if result is None:
            result = _model(FetchResult, self.raw.get("result"))
        self.result: Optional[FetchResult] = result

    @property
    def index(self) -> int:
        return _int(self.raw.get("index"))

    @property
    def url(self) -> str:
        return self.raw.get("url") or ""

    @property
    def status(self) -> str:
        """queued, running, succeeded, failed or canceled."""
        return self.raw.get("status") or ""

    @property
    def ok(self) -> bool:
        return self.status == "succeeded"

    @property
    def request_id(self) -> Optional[str]:
        return self.raw.get("request_id")

    @property
    def credits(self) -> int:
        return _int((self.raw.get("credits") or {}).get("charged"))

    @property
    def error(self) -> Optional[Model]:
        """Why the item failed without starting (refused before anything was sent; not charged).
        A fetch that ran and failed has its error in ``result.error``."""
        return _model(Model, self.raw.get("error"))

    @property
    def error_code(self) -> Optional[str]:
        if self.error is not None:
            return self.error.get("code")
        return self.result.error_code if self.result else None

    @property
    def started_at(self) -> Optional[str]:
        return self.raw.get("started_at")

    @property
    def finished_at(self) -> Optional[str]:
        return self.raw.get("finished_at")

    def _repr_fields(self):
        return {"index": self.index, "status": self.status, "url": self.url, "credits": self.credits}


class EstimateCredits(Model):
    @property
    def expected(self) -> int:
        """typical times the share of requests that usually succeed (failures are free)."""
        return _int(self.raw.get("expected"))

    @property
    def typical(self) -> int:
        return _int(self.raw.get("typical"))

    @property
    def high(self) -> int:
        return _int(self.raw.get("high"))

    @property
    def hold(self) -> Optional[int]:
        return self.raw.get("hold")

    def _repr_fields(self):
        return {"expected": self.expected, "typical": self.typical, "high": self.high}


class Estimate(Model):
    """What a request or a batch would cost and take. Nothing was sent or reserved."""

    @property
    def kind(self) -> str:
        return self.raw.get("kind") or ""

    @property
    def requests(self) -> int:
        return _int(self.raw.get("requests"))

    @property
    def estimated(self) -> int:
        return _int(self.raw.get("estimated"))

    @property
    def credits(self) -> EstimateCredits:
        return EstimateCredits(self.raw.get("credits"))

    @property
    def seconds(self) -> dict:
        return self.raw.get("seconds") or {}

    @property
    def covers_expected(self) -> bool:
        return bool((self.raw.get("balance") or {}).get("covers_expected"))

    @property
    def covers_high(self) -> bool:
        return bool((self.raw.get("balance") or {}).get("covers_high"))

    @property
    def items(self) -> List[dict]:
        return list(self.raw.get("items") or [])

    @property
    def notes(self) -> List[dict]:
        return list(self.raw.get("notes") or [])

    def _repr_fields(self):
        return {"kind": self.kind, "requests": self.requests, "credits": self.credits}


class NetworkPage(Model):
    """A page of ``GET /v1/fetch/{id}/network``: ``items`` (one dict per call), ``next_cursor`` and ``network``."""

    @property
    def items(self) -> List[dict]:
        return list(self.raw.get("items") or [])

    @property
    def next_cursor(self) -> Optional[str]:
        return self.raw.get("next_cursor")

    @property
    def network(self) -> dict:
        return self.raw.get("network") or {}

    def __iter__(self) -> Iterator[dict]:
        return iter(self.items)

    def __len__(self) -> int:
        return len(self.items)

    def _repr_fields(self):
        return {"items": len(self.items), "next_cursor": self.next_cursor}


class NetworkCall(Model):
    """One recorded call in full: ``request`` and ``response`` (None when no response came)."""

    @property
    def index(self) -> int:
        return _int(self.raw.get("index"))

    @property
    def request(self) -> dict:
        return self.raw.get("request") or {}

    @property
    def response(self) -> Optional[dict]:
        return self.raw.get("response")

    @property
    def url(self) -> str:
        return self.request.get("url") or ""

    @property
    def body(self) -> Optional[str]:
        """The response body when it is inline: text, or base64 for a binary body (see ``response["body_encoding"]``)."""
        return (self.response or {}).get("body")

    def _repr_fields(self):
        return {"index": self.index, "url": self.url, "status": (self.response or {}).get("status")}


class Me(Model):
    """``GET /v1/me``: the project and API key making the call."""

    @property
    def project_id(self) -> str:
        return self.raw.get("project_id") or ""

    @property
    def key_id(self) -> Optional[str]:
        return self.raw.get("key_id")

    @property
    def key_name(self) -> Optional[str]:
        return self.raw.get("key_name")

    @property
    def key_prefix(self) -> Optional[str]:
        return self.raw.get("key_prefix")

    @property
    def scopes(self) -> List[str]:
        return list(self.raw.get("scopes") or [])

    def _repr_fields(self):
        return {"project_id": self.project_id, "key_prefix": self.key_prefix, "scopes": self.scopes}


class Balance(Model):
    @property
    def credits(self) -> Optional[int]:
        """Available now (None for an unmetered project)."""
        return self.raw.get("credits")

    @property
    def reserved(self) -> int:
        return _int(self.raw.get("reserved"))

    @property
    def trial(self) -> int:
        return _int(self.raw.get("trial"))

    @property
    def purchased(self) -> int:
        return _int(self.raw.get("purchased"))

    @property
    def payment_hold(self) -> bool:
        return bool(self.raw.get("payment_hold"))

    def _repr_fields(self):
        return {"credits": self.credits, "reserved": self.reserved}


class Usage(Model):
    @property
    def balance(self) -> Optional[dict]:
        return self.raw.get("balance")

    @property
    def period(self) -> dict:
        return self.raw.get("period") or {}

    @property
    def used(self) -> dict:
        return self.raw.get("used") or {}

    @property
    def credits_used(self) -> int:
        return _int(self.used.get("credits"))

    @property
    def by_step(self) -> List[dict]:
        return list(self.raw.get("by_step") or [])

    @property
    def daily(self) -> List[dict]:
        return list(self.raw.get("daily") or [])

    def _repr_fields(self):
        return {"credits_used": self.credits_used}


class ServiceStatus(Model):
    @property
    def status(self) -> str:
        """operational, degraded, partial_outage, major_outage or maintenance."""
        return self.raw.get("status") or ""

    @property
    def operational(self) -> bool:
        return self.status == "operational"

    @property
    def notices(self) -> List[dict]:
        return list(self.raw.get("notices") or [])

    @property
    def api_version(self) -> Optional[str]:
        return (self.raw.get("api") or {}).get("version")

    def _repr_fields(self):
        return {"status": self.status, "api_version": self.api_version}


@dataclass(frozen=True)
class CallEvent:
    """What one client call did, passed to the ``on_call`` hook after the call ends.

    ``requests`` counts the HTTP requests the call made (resends and polls included).
    ``raised`` is the code of the error the call raised, if it raised. ``status``, ``credits``,
    ``step``, ``error_code`` and ``next_action`` describe the fetch result, for calls that have one.
    """

    op: str
    ok: bool
    elapsed: float
    requests: int
    resends: int = 0
    polls: int = 0
    http_status: Optional[int] = None
    raised: Optional[str] = None
    fetch_id: Optional[str] = None
    batch_id: Optional[str] = None
    url: Optional[str] = None
    idempotency_key: Optional[str] = None
    status: Optional[str] = None
    page_status: Optional[str] = None
    credits: int = 0
    step: Optional[str] = None
    error_code: Optional[str] = None
    next_action: Optional[str] = None
