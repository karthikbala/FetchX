"""FetchX API client. Requires httpx.

    fetchx = FetchXClient(os.environ['FETCHX_URL'], os.environ['FETCHX_TOKEN'])
    result = fetchx.fetch(url='https://example.com', formats=['markdown'])
    page2 = fetchx.next_page(result['id']) if (result.get('data') or {}).get('next_page') else None
    batch = fetchx.submit_batch(['https://example.com/a', 'https://example.com/b'], defaults={'formats': ['markdown']})
    for item in fetchx.batch_results(batch['id']):
        print(item['index'], (item['result'] or {}).get('status'))

Every POST carries an idempotency_key (generated when you leave it out), so the
client can safely resend the same request after a lost response, a 429 or a
503: FetchX returns the first result and never charges twice.
"""
import time
import uuid
from urllib.parse import quote, urlencode

import httpx

RETRYABLE = {'network_error', 'too_many_requests', 'unavailable', 'maintenance'}


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
    # A list repeats the parameter (contains=a&contains=b); a bool is true or false.
    clean = {key: ('true' if value else 'false') if isinstance(value, bool) else value for key, value in clean.items()}
    return '?' + urlencode(clean, doseq=True) if clean else ''


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

    def _start(self, path, request):
        body = {**request, 'idempotency_key': request.get('idempotency_key') or str(uuid.uuid4())}
        attempt = 0
        while True:
            try:
                return self._send('POST', path, body=body, idempotency_key=body['idempotency_key'])
            except FetchXError as error:
                if error.code not in RETRYABLE or attempt >= self.retries:
                    raise
                time.sleep(min(30, error.retry_after_seconds or 2 ** attempt))
                attempt += 1

    def fetch(self, **request):
        """POST /v1/fetch. Returns the result: succeeded, failed, or pending (use wait)."""
        if not isinstance(request.get('url'), str):
            raise FetchXError('url_required')
        return self._start('/v1/fetch', request)

    def next_page(self, id, **request):
        """POST /v1/fetch/{id}/next: the page after a result whose data.next_page is set, as a new request.

        request may hold scroll, max_credits, timeout_ms, async, webhook_url, idempotency_key and tags.
        """
        return self._start('/v1/fetch/' + quote(id, safe='') + '/next', request)

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

    def network(self, id, *, type=None, content_type=None, host=None, first_party=None, status=None, page=None, phase=None,
                contains=None, limit=None, cursor=None):
        """GET /v1/fetch/{id}/network: the calls a request made with capture recorded.

        contains is a value or a list of up to 5 the response body holds (without case): the way to find the call
        that carries the data you saw on the page.
        """
        return self._send('GET', '/v1/fetch/' + quote(id, safe='') + '/network' + _query({
            'type': type, 'content_type': content_type, 'host': host, 'first_party': first_party, 'status': status, 'page': page,
            'phase': phase, 'contains': contains, 'limit': limit, 'cursor': cursor}))

    def network_call(self, id, index):
        """GET /v1/fetch/{id}/network/{index}: one recorded call with its headers and bodies."""
        return self._send('GET', '/v1/fetch/' + quote(id, safe='') + '/network/' + quote(str(index), safe=''))

    def network_body(self, id, index):
        """One recorded call's response body: {'body': bytes, 'content_type': str}."""
        return self._send('GET', '/v1/fetch/' + quote(id, safe='') + '/network/' + quote(str(index), safe='') + '/body', raw=True)

    def network_har(self, id, *, page=None):
        """The capture as a HAR 1.2 document (a dict), for browser developer tools."""
        return self._send('GET', '/v1/fetch/' + quote(id, safe='') + '/network.har' + _query({'page': page}))

    def submit_batch(self, items, **batch):
        """POST /v1/batches: many URLs in one job, run at each site's pace. Returns the batch at once.

        items are URLs or POST /v1/fetch bodies; batch may hold defaults, webhook_url, idempotency_key and tags.
        """
        if not isinstance(items, list):
            raise FetchXError('items_required')
        return self._start('/v1/batches', {**batch, 'items': items})

    def get_batch(self, id):
        return self._send('GET', '/v1/batches/' + quote(id, safe=''))

    def list_batches(self, *, status=None, limit=None, cursor=None):
        return self._send('GET', '/v1/batches' + _query({'status': status, 'limit': limit, 'cursor': cursor}))

    def batch_items(self, id, *, status=None, order=None, results=None, limit=None, cursor=None):
        flag = None if results is None else ('true' if results else 'false')
        return self._send('GET', '/v1/batches/' + quote(id, safe='') + '/items' + _query(
            {'status': status, 'order': order, 'results': flag, 'limit': limit, 'cursor': cursor}))

    def cancel_batch(self, id):
        return self._send('POST', '/v1/batches/' + quote(id, safe='') + '/cancel')

    def batch_results(self, id, *, interval=5.0, limit=100, results=True):
        """Yields each item once it has finished, with its result, until the batch is over."""
        cursor = None
        while True:
            page = self.batch_items(id, order='finished', limit=limit, results=results, cursor=cursor)
            yield from page['items']
            if page['next_cursor'] is None:
                return
            cursor = page['next_cursor']
            if len(page['items']) < limit:
                time.sleep(interval)

    def estimate(self, **body):
        """What one POST /v1/fetch body, or a batch body (items=, defaults=), would cost and take. Nothing is sent or reserved."""
        return self._send('POST', '/v1/estimate', body=body)

    def status(self):
        """Service status and notices."""
        return self._send('GET', '/v1/status')

    def prices(self):
        """What each step, a captcha, residential traffic and extraction cost in credits, and the trial credits a new account gets."""
        return self._send('GET', '/v1/prices')

    def balance(self):
        """Credits available now: {'credits', 'reserved', 'trial', 'purchased', 'payment_hold'}."""
        return self._send('GET', '/v1/balance')

    def me(self):
        """The project and key making the call: {'project_id', 'key_id', 'key_name', 'key_prefix', 'scopes', 'limits'}. Any valid key."""
        return self._send('GET', '/v1/me')

    def send_feedback(self, **body):
        """Report how FetchX handled a page: fetch_id= (or url= and method=), kind=, message=, evidence=. Free."""
        return self._send('POST', '/v1/feedback', body=body)

    def get_feedback(self, id):
        """Where a report stands ('status') and FetchX staff's 'reply'."""
        return self._send('GET', '/v1/feedback/' + quote(id, safe=''))

    def save_login(self, **body):
        """Save a site login: site=, username=, password=, name=. FetchX signs in with it when a page on that site asks.
        The password is stored encrypted and never returned."""
        return self._send('POST', '/v1/logins', body=body)

    def list_logins(self):
        """The project's saved logins: {'items': [...]}, usernames masked."""
        return self._send('GET', '/v1/logins')

    def get_login(self, id):
        return self._send('GET', '/v1/logins/' + quote(id, safe=''))

    def update_login(self, id, **changes):
        """Change site=, username=, password= or name=. A new site, username or password starts over."""
        return self._send('PATCH', '/v1/logins/' + quote(id, safe=''), body=changes)

    def delete_login(self, id):
        """Delete a saved login and its signed-in session."""
        self._send('DELETE', '/v1/logins/' + quote(id, safe=''))

    def create_browser_session(self, **body):
        """POST /v1/browser-sessions: a browser you drive with Playwright, held to allow_hosts=[...].
        Connect with playwright.firefox.connect(session['ws_url'], headers={'Authorization': 'Bearer fxk_...'})
        and use browser.contexts[0]. Sent with an idempotency_key, so a retry gets the same session."""
        if not isinstance(body.get('allow_hosts'), list):
            raise FetchXError('allow_hosts_required')
        return self._start('/v1/browser-sessions', body)

    def get_browser_session(self, id):
        """The session, or its receipt once it has ended."""
        return self._send('GET', '/v1/browser-sessions/' + quote(id, safe=''))

    def list_browser_sessions(self, *, status=None):
        return self._send('GET', '/v1/browser-sessions' + _query({'status': status}))

    def close_browser_session(self, id):
        """Close the session; returns its receipt."""
        return self._send('DELETE', '/v1/browser-sessions/' + quote(id, safe=''))

    def fill_browser_session(self, id, **body):
        """Type a session secret (secret='name') or the saved login's username or password
        (secret='login.password') into the field selector= matches, in the frame at frame_url=.
        The value never reaches you."""
        return self._send('POST', '/v1/browser-sessions/' + quote(id, safe='') + '/fill', body=body)

    def usage(self, *, period=None, since=None, until=None):
        return self._send('GET', '/v1/usage' + _query({'period': period, 'since': since, 'until': until}))
