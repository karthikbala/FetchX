"""FetchX API client. Requires httpx.

    fetchx = FetchXClient(os.environ['FETCHX_URL'], os.environ['FETCHX_TOKEN'])
    result = fetchx.fetch(url='https://example.com', formats=['markdown'])

Every POST carries an idempotency_key (generated when you leave it out), so the
client can safely resend the same request after a lost response, a 429 or a
503: FetchX returns the first result and never charges twice.
"""
import time
import uuid
from urllib.parse import quote, urlencode

import httpx

RETRYABLE = {'network_error', 'too_many_requests', 'unavailable'}


class FetchXError(RuntimeError):
    def __init__(self, code, *, status=None, details=None, retry_after_seconds=None, idempotency_key=None, response=None):
        super().__init__(code)
        self.code = code
        self.status = status
        self.details = details
        self.retry_after_seconds = retry_after_seconds
        self.idempotency_key = idempotency_key
        self.response = response


def _query(params):
    clean = {key: value for key, value in params.items() if value is not None}
    return '?' + urlencode(clean) if clean else ''


class FetchXClient:
    def __init__(self, url, token, *, client=None, timeout=130, retries=2):
        if not url or not token:
            raise FetchXError('client_config_missing')
        self.url = url.rstrip('/')
        self.token = token
        self.retries = retries
        self.http = client or httpx.Client(timeout=timeout, trust_env=False)

    def _send(self, method, path, *, body=None, raw=False, idempotency_key=None):
        try:
            response = self.http.request(method, self.url + path, json=body, auth=None, follow_redirects=False,
                                         headers={'Authorization': 'Bearer ' + self.token})
        except httpx.HTTPError:
            raise FetchXError('network_error', idempotency_key=idempotency_key) from None
        if response.status_code == 204:
            return None
        if raw and response.is_success:
            return {'body': response.content, 'content_type': response.headers.get('content-type')}
        try:
            data = response.json()
        except ValueError:
            data = None
        if not isinstance(data, dict):
            raise FetchXError('invalid_response', status=response.status_code, idempotency_key=idempotency_key)
        if not response.is_success:
            error = data.get('error') if isinstance(data.get('error'), dict) else {}
            retry_after = error.get('retry_after_seconds') or response.headers.get('retry-after')
            raise FetchXError(error.get('code') if isinstance(error.get('code'), str) else 'request_failed',
                              status=response.status_code, details=error.get('details'),
                              retry_after_seconds=int(retry_after) if retry_after else None,
                              idempotency_key=idempotency_key, response=data)
        return data

    def fetch(self, **request):
        """POST /v1/fetch. Returns the result: succeeded, failed, or pending (use wait)."""
        if not isinstance(request.get('url'), str):
            raise FetchXError('url_required')
        body = {**request, 'idempotency_key': request.get('idempotency_key') or str(uuid.uuid4())}
        attempt = 0
        while True:
            try:
                return self._send('POST', '/v1/fetch', body=body, idempotency_key=body['idempotency_key'])
            except FetchXError as error:
                if error.code not in RETRYABLE or attempt >= self.retries:
                    raise
                time.sleep(min(30, error.retry_after_seconds or 2 ** attempt))
                attempt += 1

    def get(self, id, *, include_body=True):
        return self._send('GET', '/v1/fetch/' + quote(id, safe='') + ('' if include_body else '?include_body=false'))

    def wait(self, id, *, interval=2.0, timeout=300.0, include_body=True):
        """Polls a request until it is no longer pending."""
        deadline = time.monotonic() + timeout
        while True:
            result = self.get(id, include_body=False)
            if result.get('status') != 'pending':
                return self.get(id) if include_body else result
            if time.monotonic() + interval > deadline:
                raise FetchXError('wait_timeout', response=result)
            time.sleep(interval)

    def list(self, *, status=None, tag=None, idempotency_key=None, since=None, limit=None, cursor=None):
        return self._send('GET', '/v1/fetch' + _query({'status': status, 'tag': tag, 'idempotency_key': idempotency_key,
                                                         'since': since, 'limit': limit, 'cursor': cursor}))

    def content(self, id):
        """The body as received: {'body': bytes, 'content_type': str}."""
        return self._send('GET', '/v1/fetch/' + quote(id, safe='') + '/content', raw=True)

    def screenshot(self, id):
        return self._send('GET', '/v1/fetch/' + quote(id, safe='') + '/screenshot', raw=True)

    def delete(self, id):
        self._send('DELETE', '/v1/fetch/' + quote(id, safe=''))

    def usage(self, *, period=None, since=None, until=None):
        return self._send('GET', '/v1/usage' + _query({'period': period, 'since': since, 'until': until}))
