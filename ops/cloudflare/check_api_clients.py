#!/usr/bin/env python3
"""Check that ordinary HTTP clients reach the FetchX API through Cloudflare.

    python3 -I ops/cloudflare/check_api_clients.py [https://app.fetchx.ai]

Each client calls GET /healthz and a keyless POST /v1/fetch. No API key is needed and
nothing is charged: FetchX answers the first with 200 and the second with 401, both JSON.
A reply that is not FetchX's JSON (Cloudflare's "error code: 1010", a challenge page) means
Cloudflare refused the client before it reached FetchX. Exits 1 if any client was refused.
"""
import importlib
import importlib.util
import json
import shutil
import subprocess
import sys
import urllib.error
import urllib.request

# User agents that libraries and tools send when the caller sets none.
USER_AGENTS = [
    ('python requests', 'python-requests/2.32.3'),
    ('python httpx', 'python-httpx/0.28.1'),
    ('python aiohttp', 'Python/3.12 aiohttp/3.11.11'),
    ('python urllib3', 'python-urllib3/2.3.0'),
    ('curl', 'curl/8.5.0'),
    ('wget', 'Wget/1.21.4'),
    ('node fetch', 'node'),
    ('axios', 'axios/1.7.9'),
    ('go net/http', 'Go-http-client/2.0'),
    ('java HttpClient', 'Java-http-client/21.0.5'),
    ('okhttp', 'okhttp/4.12.0'),
    ('ruby net/http', 'Ruby'),
    ('perl LWP', 'libwww-perl/6.77'),
    ('no User-Agent at all (PHP curl, raw sockets)', ''),
    ('postman', 'PostmanRuntime/7.43.0'),
]


def call(base, method, path, user_agent):
    """(status, body) for one request. user_agent None: urllib's own default; '' sends no User-Agent at all."""
    opener = urllib.request.build_opener()
    if user_agent is not None:
        opener.addheaders = [('User-Agent', user_agent)] if user_agent else []
    data = b'{}' if method == 'POST' else None
    request = urllib.request.Request(base + path, data=data, method=method, headers={'Content-Type': 'application/json'} if data else {})
    try:
        with opener.open(request, timeout=30) as response:
            return response.status, response.read(4096)
    except urllib.error.HTTPError as error:
        return error.code, error.read(4096)
    except OSError as error:
        return None, str(error).encode()


def real_curl(base, method, path):
    command = ['curl', '-sS', '-m', '30', '-X', method, '-w', '\n%{http_code}', base + path]
    if method == 'POST':
        command[1:1] = ['-H', 'Content-Type: application/json', '--data', '{}']
    output = subprocess.run(command, capture_output=True, timeout=40).stdout
    body, _, status = output.rpartition(b'\n')
    return (int(status) or None) if status.strip().isdigit() else None, body


def real_library(module_name):
    module = importlib.import_module(module_name)

    def run(base, method, path):
        response = module.request(method, base + path, json={} if method == 'POST' else None, timeout=30)
        return response.status_code, response.content
    return run


def from_fetchx(status, body):
    """FetchX answered (any JSON object) rather than Cloudflare refusing the request."""
    if status is None:
        return False
    try:
        return isinstance(json.loads(body), dict)
    except ValueError:
        return False


def main(argv):
    base = (argv[1] if len(argv) > 1 else 'https://app.fetchx.ai').rstrip('/')
    clients = [('python urllib (its own default)', lambda b, m, p: call(b, m, p, None)),
               ('python urllib (explicit UA)', lambda b, m, p: call(b, m, p, f'Python-urllib/{sys.version_info[0]}.{sys.version_info[1]}'))]
    clients += [(name if not ua else f'{name} UA', lambda b, m, p, ua=ua: call(b, m, p, ua)) for name, ua in USER_AGENTS]
    if shutil.which('curl'):
        clients.append(('curl (real)', real_curl))
    for module_name in ('requests', 'httpx'):
        if importlib.util.find_spec(module_name):
            clients.append((f'{module_name} (real)', real_library(module_name)))
    refused = []
    for name, client in clients:
        results = []
        for method, path in (('GET', '/healthz'), ('POST', '/v1/fetch')):
            try:
                status, body = client(base, method, path)
            except Exception as error:  # a client library failing counts as not getting through
                status, body = None, str(error).encode()
            ok = from_fetchx(status, body)
            results.append(f'{method} {path} {status or "-"}' + ('' if ok else f' REFUSED {body[:40]!r}'))
            if not ok:
                refused.append(name)
        print(f'{name:46} ' + ' | '.join(results))
    print(f'\n{len(clients) - len(set(refused))}/{len(clients)} clients reached FetchX at {base}')
    return 1 if refused else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
