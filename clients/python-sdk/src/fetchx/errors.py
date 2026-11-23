"""Errors raised by the FetchX clients.

A refused call (HTTP 4xx) sent nothing to the site and cost nothing. A fetch that ran and
failed is not an error: it comes back as a result whose ``error`` says what to do next.
"""
from __future__ import annotations

from typing import Any, Optional

# Codes worth resending with the same idempotency_key after a wait: FetchX stored nothing
# under the key, or replays the first result for it, so a resend never runs or charges twice.
_RESEND_STATUSES = frozenset({429, 502, 503, 504})
# 503s that a plain resend does not fix.
_NOT_RESENT = frozenset({"extract_unavailable", "credit_account_unavailable", "internal_error"})


class FetchXError(RuntimeError):
    """A call FetchX refused, an answer the client could not use, or a local check that failed.

    ``code`` is FetchX's error code (``invalid_request``, ``insufficient_credits``,
    ``max_credits_too_low``, ``too_many_requests``, ``maintenance``...) or one of the client's
    own (``network_error``, ``invalid_response``, ``wait_timeout``, ``spend_limit_reached``,
    ``client_config_missing``). The message never holds the API key or a page body.
    """

    def __init__(self, code: str, message: str = "", *, status: Optional[int] = None,
                 details: Optional[dict] = None, retry_after_seconds: Optional[float] = None,
                 idempotency_key: Optional[str] = None, response: Optional[dict] = None):
        super().__init__(f"{code}: {message}" if message else code)
        self.code = code
        self.message = message
        self.status = status
        self.details = details if isinstance(details, dict) else {}
        self.retry_after_seconds = retry_after_seconds
        self.idempotency_key = idempotency_key
        self.response = response

    @property
    def http_status(self) -> Optional[int]:
        """The HTTP status FetchX answered with (None for network and local errors)."""
        return self.status

    @property
    def retry_after(self) -> Optional[float]:
        return self.retry_after_seconds

    @property
    def refused(self) -> bool:
        """True for a 4xx: nothing was sent to the site and nothing was charged."""
        return self.status is not None and 400 <= self.status < 500

    @property
    def retryable(self) -> bool:
        """Whether resending the same body with the same idempotency_key after a wait can help."""
        if self.code == "network_error":
            return True
        return self.code not in _NOT_RESENT and self.status in _RESEND_STATUSES

    def __reduce__(self) -> Any:
        return (_rebuild, (type(self), self.code, self.message, self.__dict__))


def _rebuild(cls, code, message, state):
    error = cls.__new__(cls)
    FetchXError.__init__(error, code, message)
    error.__dict__.update(state)
    return error


class SpendLimitReached(FetchXError):
    """The client's spend_limit would be passed. Nothing was sent.

    ``details`` holds ``spend_limit``, ``spent`` and ``held`` (credits reserved by requests
    this client still has running).
    """


class FetchFailed(FetchXError):
    """Raised by ``FetchResult.raise_for_status()`` for a fetch that ran and failed.

    ``result`` is the failed result; ``code`` is its ``error.code``.
    """

    def __init__(self, result: Any):
        error = result.error
        super().__init__(error.code if error else "failed", error.message if error else "",
                         idempotency_key=result.idempotency_key, response=result.raw,
                         retry_after_seconds=result.retry_after_seconds)
        self.result = result
