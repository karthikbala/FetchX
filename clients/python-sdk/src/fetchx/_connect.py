"""FetchX Connect from Python: get a FetchX API key after the user approves it in the browser.

The tool never receives the key. FetchX gives it a private device code, the user approves
the request on fetchx.ai, and the key is worked out from the device code (the same protocol
as ``clients/connect.mjs``).

One call, which waits for the user::

    from fetchx import FetchX, connect

    creds = connect(client_name="My tool", limits={"credits_per_day": 500, "expires_in_days": 30}, save=True)
    fx = FetchX(creds.api_base_url, creds.token)

Or two steps, for an agent whose tool calls must end within a minute::

    request = connect_start(client_name="My tool", save=True)   # show request.verification_uri_complete
    ...
    creds = connect_finish(timeout=50, save=True)                # None while the user has not approved yet

``save=True`` keeps the key in an owner-only file (``credentials_path()``), which ``FetchX()``
reads when ``FETCHX_TOKEN`` is not set. ``python -m fetchx connect`` (or ``fetchx-connect``) does the same
from a shell.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, Mapping, Optional
from urllib.parse import urlsplit

import httpx

from ._version import __version__
from .errors import FetchXError

HOSTED_ORIGIN = "https://fetchx.ai"
HOSTED_API_ORIGIN = "https://app.fetchx.ai"
REQUEST_TIMEOUT = 10.0
SLOW_DOWN = 5.0
CLAIM_FAILURE_LIMIT = 3
# A request lasts 20 minutes today; accept up to an hour.
MAX_EXPIRES_IN = 3600
LIMIT_FIELDS = ("credits_per_day", "credits_per_month", "expires_at", "expires_in_days")
CREDENTIALS_ENV = "FETCHX_CREDENTIALS_FILE"

_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
_PROJECT = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_USER_CODE = re.compile(r"^[A-Z0-9]{4}-[A-Z0-9]{4}$")
_DEVICE_CODE = re.compile(r"^[A-Za-z0-9_-]{43}$")
_CLIENT_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,59}$")
_TOKEN = re.compile(r"^fxk_[A-Za-z0-9_-]{43}$")
_LOOPBACK = re.compile(r"^http://(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?/?$", re.I)

# Patched by tests.
_sleep = time.sleep
_now = time.time


class ConnectError(FetchXError):
    """Connect could not give a key. ``code`` says why: ``connect_denied``, ``connect_expired``,
    ``connect_unavailable``, ``connect_rate_limited``, ``connect_network_error``,
    ``connect_invalid_response``, ``connect_invalid_limits``, ``connect_not_started``..."""


@dataclass(frozen=True)
class ConnectRequest:
    """A started Connect request. Show the user ``verification_uri_complete`` (it carries the
    code, which the approval page shows for the user to check against ``user_code``).

    ``device_code`` works out the key once the user approves: keep it as private as the key.
    ``to_dict()`` includes it, so store that only in an owner-only place (``save()`` does).
    """
    request_id: str
    device_code: str = field(repr=False)
    user_code: str
    verification_uri: str
    verification_uri_complete: str
    expires_at: float
    interval: int
    origin: str
    api_origin: str
    client_name: str
    limits: Optional[Dict[str, Any]] = None

    @property
    def expires_in(self) -> float:
        """Seconds left to approve."""
        return max(0.0, self.expires_at - _now())

    def to_dict(self) -> Dict[str, Any]:
        return {"request_id": self.request_id, "device_code": self.device_code, "user_code": self.user_code,
                "verification_uri": self.verification_uri, "verification_uri_complete": self.verification_uri_complete,
                "expires_at": self.expires_at, "interval": self.interval, "origin": self.origin,
                "api_origin": self.api_origin, "client_name": self.client_name, "limits": self.limits}

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "ConnectRequest":
        try:
            request = cls(**{name: value[name] for name in (
                "request_id", "device_code", "user_code", "verification_uri", "verification_uri_complete", "expires_at",
                "interval", "origin", "api_origin", "client_name")}, limits=value.get("limits"))
        except (KeyError, TypeError) as error:
            raise ConnectError("connect_not_started", "the saved Connect request is incomplete") from error
        if not (isinstance(request.request_id, str) and _UUID.match(request.request_id) and isinstance(request.device_code, str)
                and _DEVICE_CODE.match(request.device_code) and isinstance(request.interval, int) and 1 <= request.interval <= 60
                and isinstance(request.expires_at, (int, float))):
            raise ConnectError("connect_not_started", "the saved Connect request is not valid")
        return request

    def save(self, path: Optional[os.PathLike] = None) -> Path:
        """Keep this request in an owner-only file, for ``connect_finish()`` in a later process."""
        return _write_private(Path(path) if path else pending_path(), self.to_dict())


@dataclass(frozen=True)
class Credentials:
    """A FetchX API key from Connect, with where to send it and the limits the user approved."""
    token: str = field(repr=False)
    api_base_url: str
    project_id: str
    key_id: str
    client_name: Optional[str] = None
    limits: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        return {"token": self.token, "api_base_url": self.api_base_url, "project_id": self.project_id,
                "key_id": self.key_id, "client_name": self.client_name, "limits": self.limits}


# ---- Where keys are kept ----

def config_dir() -> Path:
    """``$XDG_CONFIG_HOME/fetchx`` or ``~/.config/fetchx``; ``%APPDATA%\\fetchx`` on Windows."""
    if os.name == "nt" and os.environ.get("APPDATA"):
        return Path(os.environ["APPDATA"]) / "fetchx"
    base = os.environ.get("XDG_CONFIG_HOME")
    return (Path(base) if base else Path.home() / ".config") / "fetchx"


def credentials_path() -> Path:
    """The credentials file: ``$FETCHX_CREDENTIALS_FILE``, else ``config_dir() / "credentials"``."""
    custom = os.environ.get(CREDENTIALS_ENV)
    return Path(custom) if custom else config_dir() / "credentials"


def pending_path() -> Path:
    """Where ``connect_start(save=True)`` keeps a request that waits for the user."""
    return credentials_path().with_name("connect-request.json")


def _write_private(path: Path, value: Mapping[str, Any]) -> Path:
    """Write JSON readable only by this user (0600 in a 0700 folder), replacing the file at once."""
    folder = path.parent
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix=".fetchx-", dir=folder)
    try:
        if os.name != "nt":
            os.fchmod(handle, 0o600)
        with os.fdopen(handle, "w", encoding="utf-8") as file:
            json.dump(value, file, indent=2)
            file.write("\n")
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise
    return path


def _read_private(path: Path) -> Optional[dict]:
    try:
        stat = path.stat()
    except FileNotFoundError:
        return None
    if os.name != "nt" and stat.st_mode & 0o077:
        raise FetchXError("credentials_insecure", f"{path} can be read by other users; run: chmod 600 {path}")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise FetchXError("credentials_invalid", f"{path} is not a FetchX credentials file") from error
    if not isinstance(value, dict):
        raise FetchXError("credentials_invalid", f"{path} is not a FetchX credentials file")
    return value


def save_credentials(credentials: Credentials, path: Optional[os.PathLike] = None) -> Path:
    """Keep the key in the owner-only credentials file. Returns the file's path."""
    return _write_private(Path(path) if path else credentials_path(), credentials.to_dict())


def load_credentials(path: Optional[os.PathLike] = None) -> Optional[Credentials]:
    """The saved key, or None when there is none. Raises ``credentials_insecure`` when other
    users can read the file, as ssh does."""
    target = Path(path) if path else credentials_path()
    value = _read_private(target)
    if value is None:
        return None
    token, base = value.get("token"), value.get("api_base_url")
    if not isinstance(token, str) or not _TOKEN.match(token) or not isinstance(base, str) or not base.startswith(("https://", "http://")):
        raise FetchXError("credentials_invalid", f"{target} has no FetchX key")
    return Credentials(token=token, api_base_url=base, project_id=str(value.get("project_id") or ""),
                       key_id=str(value.get("key_id") or ""), client_name=value.get("client_name"), limits=value.get("limits"))


def forget_credentials(path: Optional[os.PathLike] = None) -> bool:
    """Delete the saved key from this computer (revoke it in the console too). True if one was there."""
    try:
        (Path(path) if path else credentials_path()).unlink()
        return True
    except FileNotFoundError:
        return False


# ---- The protocol ----

def _origin(value: str, what: str) -> str:
    if not isinstance(value, str) or re.search(r"[\x00-\x1f\x7f\s@\\?#]", value):
        raise ConnectError("connect_invalid_origin", f"{what} must be an https origin, or http on localhost")
    parts = urlsplit(value)
    if parts.path not in ("", "/") or not parts.hostname or not (parts.scheme == "https" or _LOOPBACK.match(value)):
        raise ConnectError("connect_invalid_origin", f"{what} must be an https origin, or http on localhost")
    return f"{parts.scheme}://{parts.netloc}".lower()


def _limits(value: Optional[Mapping[str, Any]]) -> Optional[Dict[str, Any]]:
    if value is None:
        return None
    if not isinstance(value, Mapping) or any(name not in LIMIT_FIELDS for name in value):
        raise ConnectError("connect_invalid_limits", "limits take only " + ", ".join(LIMIT_FIELDS))
    return dict(value)


def _limits_view(value: Any) -> Optional[Dict[str, Any]]:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ConnectError("connect_invalid_response", "FetchX Connect returned invalid limits")
    return {name: value.get(name) for name in ("credits_per_day", "credits_per_month", "expires_at")}


def derive_token(device_code: str) -> str:
    """The key a device code gives once its request is approved."""
    digest = hashlib.sha256(b"fetchx-connect-key-v1\0" + device_code.encode("utf-8")).digest()
    return "fxk_" + base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


class _Http:
    def __init__(self, client: Optional[httpx.Client]):
        self.own = client is None
        self.client = client or httpx.Client(follow_redirects=False, trust_env=False, headers={
            "User-Agent": f"fetchx-python/{__version__} httpx/{httpx.__version__}"})

    def __enter__(self) -> "_Http":
        return self

    def __exit__(self, *_: Any) -> None:
        if self.own:
            self.client.close()

    def post(self, origin: str, route: str, body: dict, timeout: float) -> httpx.Response:
        try:
            response = self.client.post(f"{origin}/api/control/connect/{route}", json=body, timeout=timeout,
                                        headers={"Accept": "application/json"}, follow_redirects=False)
        except httpx.HTTPError as error:
            raise ConnectError("connect_network_error", "the FetchX Connect service could not be reached") from error
        if 300 <= response.status_code < 400:
            raise ConnectError("connect_redirect", "FetchX Connect redirected the request; check the site origin")
        return response


def _json(response: httpx.Response) -> dict:
    try:
        value = response.json()
    except ValueError as error:
        raise ConnectError("connect_invalid_response", "FetchX Connect returned an invalid response") from error
    if not isinstance(value, dict):
        raise ConnectError("connect_invalid_response", "FetchX Connect returned an invalid response")
    return value


def connect_start(client_name: str = "FetchX Python", *, limits: Optional[Mapping[str, Any]] = None,
                  origin: str = HOSTED_ORIGIN, api_origin: Optional[str] = None, save: bool = False,
                  http_client: Optional[httpx.Client] = None) -> ConnectRequest:
    """Start a Connect request and return at once. Show the user ``verification_uri_complete``
    (or ``verification_uri`` and ``user_code``), then call ``connect_finish()``.

    ``limits`` asks for a capped key: ``credits_per_day``, ``credits_per_month``, and
    ``expires_at`` (ISO time) or ``expires_in_days``. The user sees them and may change them.
    ``save=True`` keeps the request in an owner-only file so ``connect_finish()`` with no
    request can pick it up in a later process.
    """
    site = _origin(origin, "origin")
    if site == HOSTED_ORIGIN:
        if api_origin is not None and _origin(api_origin, "api_origin") != HOSTED_API_ORIGIN:
            raise ConnectError("connect_invalid_origin", "hosted FetchX Connect uses https://app.fetchx.ai")
        api = HOSTED_API_ORIGIN
    else:
        api = _origin(api_origin or site, "api_origin")
    if not isinstance(client_name, str) or not _CLIENT_NAME.match(client_name.strip()):
        raise ConnectError("connect_invalid_client_name", "use a short client name of letters, numbers, spaces or . _ ( ) -")
    requested = _limits(limits)
    body: Dict[str, Any] = {"client_name": client_name.strip()}
    if requested:
        body["limits"] = requested
    started = _now()
    with _Http(http_client) as http:
        response = http.post(site, "start", body, REQUEST_TIMEOUT)
    status = response.status_code
    if status in (404, 503):
        raise ConnectError("connect_unavailable", "FetchX Connect is unavailable on this deployment", status)
    if status == 429:
        raise ConnectError("connect_rate_limited", "FetchX Connect is rate limited; try again later", status)
    if status == 400:
        code = (_json(response).get("error") or {}).get("code") if response.content else None
        if code in ("key_limits_invalid", "key_expiry_invalid") or requested:
            raise ConnectError("connect_invalid_limits", "FetchX Connect refused the requested key limits", status,
                               details={"error": code})
        raise ConnectError("connect_invalid_response", "FetchX Connect refused the request", status, details={"error": code})
    if status >= 400:
        raise ConnectError("connect_network_error" if status >= 500 else "connect_invalid_response",
                           f"FetchX Connect answered HTTP {status}", status)
    data = _json(response)
    request_id, device_code, user_code = data.get("request_id"), data.get("device_code"), data.get("user_code")
    expires_in, interval = data.get("expires_in"), data.get("interval")
    if not isinstance(request_id, str) or not _UUID.match(request_id):
        raise ConnectError("connect_invalid_response", "FetchX Connect returned an invalid request")
    link = f"{site}/connect#{request_id}"
    complete = data.get("verification_uri_complete")
    if (data.get("verification_uri") != link or not isinstance(device_code, str) or not _DEVICE_CODE.match(device_code)
            or not isinstance(user_code, str) or not _USER_CODE.match(user_code)
            or complete is not None and complete != f"{link}&code={user_code}"
            or not isinstance(expires_in, int) or isinstance(expires_in, bool) or not 1 <= expires_in <= MAX_EXPIRES_IN
            or not isinstance(interval, int) or isinstance(interval, bool) or not 1 <= interval <= 60):
        raise ConnectError("connect_invalid_response", "FetchX Connect returned an invalid request")
    request = ConnectRequest(request_id=request_id, device_code=device_code, user_code=user_code, verification_uri=link,
                             verification_uri_complete=complete or link, expires_at=started + expires_in, interval=interval,
                             origin=site, api_origin=api, client_name=client_name.strip(),
                             limits=_limits_view(data.get("limits")) or requested)
    if save:
        request.save()
    return request


def connect_finish(request: Optional[ConnectRequest] = None, *, timeout: Optional[float] = None, save: bool = False,
                   http_client: Optional[httpx.Client] = None) -> Optional[Credentials]:
    """Wait for the user to approve a started request and return the key, or None if they have
    not yet when ``timeout`` seconds pass (call it again later; the request lasts 20 minutes).

    With no ``request``, it picks up the one ``connect_start(save=True)`` kept, and removes it
    once the request is approved, denied or expired. Raises ``ConnectError`` with
    ``connect_denied`` or ``connect_expired``. ``save=True`` keeps the key in the credentials file.
    """
    saved = request is None
    if saved:
        value = _read_private(pending_path())
        if value is None:
            raise ConnectError("connect_not_started", "no Connect request is waiting; call connect_start() first")
        request = ConnectRequest.from_dict(value)
    try:
        credentials = _poll(request, timeout, http_client)
    except ConnectError as error:
        if saved and error.code in ("connect_denied", "connect_expired"):
            _forget_pending()
        raise
    if credentials is not None:
        if save:
            save_credentials(credentials)
        if saved:
            _forget_pending()
    return credentials


def _forget_pending() -> None:
    try:
        pending_path().unlink()
    except FileNotFoundError:
        pass


def _poll(request: ConnectRequest, timeout: Optional[float], http_client: Optional[httpx.Client]) -> Optional[Credentials]:
    stop = request.expires_at if timeout is None else min(request.expires_at, _now() + max(0.0, timeout))
    proof = {"request_id": request.request_id, "device_code": request.device_code}
    wait, failures, first = float(request.interval), 0, True
    with _Http(http_client) as http:
        while True:
            now = _now()
            if now >= request.expires_at:
                raise ConnectError("connect_expired", "the FetchX Connect request expired")
            if not first:
                if now + wait > stop:
                    if stop >= request.expires_at:
                        _sleep(max(0.0, request.expires_at - now))
                        raise ConnectError("connect_expired", "the FetchX Connect request expired")
                    return None
                _sleep(wait)
            first = False
            try:
                response = http.post(request.origin, "claim", proof, min(REQUEST_TIMEOUT, max(1.0, request.expires_at - _now())))
                if response.status_code >= 500:
                    raise ConnectError("connect_network_error", f"FetchX Connect answered HTTP {response.status_code}")
            except ConnectError as error:
                if error.code != "connect_network_error":
                    raise
                failures += 1
                if failures >= CLAIM_FAILURE_LIMIT:
                    raise
                continue
            failures = 0
            if response.status_code == 429:
                retry = response.headers.get("retry-after", "")
                wait = max(wait + SLOW_DOWN, float(retry) if retry.isdigit() else 0.0)
                continue
            if response.status_code == 404:
                raise ConnectError("connect_expired", "FetchX Connect no longer knows this request", 404)
            if response.status_code >= 400:
                raise ConnectError("connect_invalid_response", f"FetchX Connect answered HTTP {response.status_code}", response.status_code)
            data = _json(response)
            state = data.get("state")
            if state == "pending":
                continue
            if state == "denied":
                raise ConnectError("connect_denied", "the FetchX Connect request was denied (or its key was revoked)")
            if state == "expired":
                raise ConnectError("connect_expired", "the FetchX Connect request expired")
            if state != "connected":
                raise ConnectError("connect_invalid_response", "FetchX Connect returned an unknown state")
            project_id, key_id = data.get("project_id"), data.get("key_id")
            if not isinstance(project_id, str) or not _PROJECT.match(project_id) or not isinstance(key_id, str) or not _UUID.match(key_id):
                raise ConnectError("connect_invalid_response", "FetchX Connect returned an invalid key")
            api = _origin(data.get("api_base_url") or "", "api_base_url")
            if api != request.api_origin:
                raise ConnectError("connect_api_origin_mismatch", "the FetchX API origin did not match the expected one")
            return Credentials(token=derive_token(request.device_code), api_base_url=api, project_id=project_id, key_id=key_id,
                               client_name=request.client_name, limits=_limits_view(data.get("limits")))


def connect(client_name: str = "FetchX Python", *, limits: Optional[Mapping[str, Any]] = None,
            on_approval: Optional[Callable[[ConnectRequest], Any]] = None, origin: str = HOSTED_ORIGIN,
            api_origin: Optional[str] = None, save: bool = False, timeout: Optional[float] = None,
            http_client: Optional[httpx.Client] = None) -> Credentials:
    """Start a Connect request, tell the user (``on_approval``, by default a line on stderr),
    and wait until they approve. Raises ``connect_denied``, ``connect_expired``, or
    ``connect_timeout`` when ``timeout`` seconds pass first."""
    request = connect_start(client_name, limits=limits, origin=origin, api_origin=api_origin, http_client=http_client)
    if on_approval is None:
        sys.stderr.write(f"Open {request.verification_uri_complete}\nFetchX code: {request.user_code}\n")
    else:
        on_approval(request)
    credentials = connect_finish(request, timeout=timeout, save=save, http_client=http_client)
    if credentials is None:
        raise ConnectError("connect_timeout", "the user did not approve in time; the request may still be approved")
    return credentials


def main(argv: Optional[list] = None) -> int:
    """``fetchx-connect`` (``python -m fetchx connect``): connect, and save the key in the credentials file."""
    import argparse
    parser = argparse.ArgumentParser(prog="fetchx-connect", description="Get a FetchX API key with Connect and save it.")
    parser.add_argument("--client-name", default="FetchX Python")
    parser.add_argument("--credits-per-day", type=int)
    parser.add_argument("--credits-per-month", type=int)
    parser.add_argument("--expires-in-days", type=int)
    parser.add_argument("--origin", default=HOSTED_ORIGIN)
    parser.add_argument("--api-origin")
    args = parser.parse_args(argv)
    limits = {name: value for name, value in (("credits_per_day", args.credits_per_day), ("credits_per_month", args.credits_per_month),
                                              ("expires_in_days", args.expires_in_days)) if value is not None}
    try:
        credentials = connect(args.client_name, limits=limits or None, origin=args.origin, api_origin=args.api_origin, save=True)
    except FetchXError as error:
        sys.stderr.write(f"{error.message or error.code}\n")
        return 1
    sys.stderr.write(f"Connected project {credentials.project_id}. The key is saved in {credentials_path()}.\n")
    return 0
