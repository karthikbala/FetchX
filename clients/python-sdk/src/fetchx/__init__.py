"""FetchX Python SDK: get any public URL with one API call.

    from fetchx import FetchX

    fx = FetchX()  # reads FETCHX_TOKEN, and FETCHX_URL when set
    result = fx.fetch(url="https://example.com/", formats=["markdown"])
    print(result.markdown if result.ok else (result.error_code, result.next_action))

``AsyncFetchX`` has the same methods for asyncio. ``fetchx.testing.FakeFetchX`` is an
in-memory FetchX for offline tests.
"""
import logging as _logging

from ._core import DEFAULT_URL, new_key, site_of
from ._version import __version__
from .aio import AsyncFetchX
from .client import FetchX
from .errors import FetchFailed, FetchXError, SpendLimitReached
from .models import (Balance, Batch, BatchItem, CallEvent, Challenge, Content, CreditBreakdown, Estimate,
                     EstimateCredits, Feedback, FetchFailure, FetchResult, FetchSummary, ListPage, Me, NetworkCall, NetworkPage,
                     NextPage, NextStep, PageInfo, Prices, ServiceStatus, Usage)

_logging.getLogger("fetchx").addHandler(_logging.NullHandler())

__all__ = [
    "AsyncFetchX", "Balance", "Batch", "BatchItem", "CallEvent", "Challenge", "Content", "CreditBreakdown",
    "DEFAULT_URL", "Estimate", "EstimateCredits", "Feedback", "FetchFailed", "FetchFailure", "FetchResult", "FetchSummary",
    "FetchX", "FetchXError", "ListPage", "Me", "NetworkCall", "NetworkPage", "NextPage", "NextStep", "PageInfo",
    "Prices", "ServiceStatus", "SpendLimitReached",
    "Usage", "__version__", "new_key", "site_of",
]
