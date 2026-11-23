"""Offline checks for clients/python.py. Run with a Python environment that has httpx."""
import importlib.util
import json
import unittest
from pathlib import Path

import httpx

spec = importlib.util.spec_from_file_location('fetchx_client', Path(__file__).resolve().parents[1] / 'clients/python.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
FetchXClient, FetchXError = module.FetchXClient, module.FetchXError

RESULT = {'id': '3f7c1d2e-8a4b-4c6d-9e0f-1a2b3c4d5e6f', 'status': 'succeeded', 'credits': {'charged': 1, 'max': 60}}


def client_for(handler, **options):
    return FetchXClient('https://api.fetchx.test/', 'fxk_fixture', client=httpx.Client(transport=httpx.MockTransport(handler)), **options)


class ClientTests(unittest.TestCase):
    def test_endpoints_use_the_documented_methods_and_paths(self):
        calls = []

        def handler(request):
            calls.append((request.method, str(request.url), request.headers['authorization']))
            if request.url.path.endswith('/content'):
                return httpx.Response(200, content=b'%PDF', headers={'content-type': 'application/pdf'})
            if request.url.path.endswith('/body'):
                return httpx.Response(200, content=b'{"name":"Lamp"}', headers={'content-type': 'application/json'})
            if request.method == 'DELETE':
                return httpx.Response(204)
            return httpx.Response(200, json=RESULT)

        client = client_for(handler)
        self.assertEqual(client.fetch(url='https://shop.example.com/', formats=['markdown'])['status'], 'succeeded')
        client.get(RESULT['id'], include_body=False)
        client.list(status='failed', limit=5)
        self.assertEqual(client.content(RESULT['id']), {'body': b'%PDF', 'content_type': 'application/pdf'})
        self.assertIsNone(client.delete(RESULT['id']))
        client.balance()
        client.usage(period='day')
        client.estimate(items=['https://shop.example.com/a'], defaults={'render': 'never'})
        client.status()
        client.prices()
        client.me()
        client.send_feedback(fetch_id=RESULT['id'], kind='blocked_via_fetchx_ok_from_home', evidence={'status_code': 200})
        client.get_feedback(RESULT['id'])
        client.network(RESULT['id'], contains=['Lamp', '19.99'], first_party=True, limit=5)
        client.network_call(RESULT['id'], 2)
        self.assertEqual(client.network_body(RESULT['id'], 2)['body'], b'{"name":"Lamp"}')
        client.network_har(RESULT['id'], page=1)
        bodies = []
        next_client = client_for(lambda request: bodies.append(json.loads(request.content)) or httpx.Response(200, json=RESULT))
        next_client.next_page(RESULT['id'], scroll=3)
        self.assertEqual(bodies[0]['scroll'], 3)
        self.assertTrue(bodies[0]['idempotency_key'])
        client.next_page(RESULT['id'])
        base = 'https://api.fetchx.test'
        self.assertEqual([(m, u) for m, u, _ in calls], [
            ('POST', base + '/v1/fetch'), ('GET', base + '/v1/fetch/' + RESULT['id'] + '?include_body=false'),
            ('GET', base + '/v1/fetch?status=failed&limit=5'), ('GET', base + '/v1/fetch/' + RESULT['id'] + '/content'),
            ('DELETE', base + '/v1/fetch/' + RESULT['id']), ('GET', base + '/v1/balance'),
            ('GET', base + '/v1/usage?period=day'), ('POST', base + '/v1/estimate'), ('GET', base + '/v1/status'),
            ('GET', base + '/v1/prices'), ('GET', base + '/v1/me'), ('POST', base + '/v1/feedback'), ('GET', base + '/v1/feedback/' + RESULT['id']),
            ('GET', base + '/v1/fetch/' + RESULT['id'] + '/network?first_party=true&contains=Lamp&contains=19.99&limit=5'),
            ('GET', base + '/v1/fetch/' + RESULT['id'] + '/network/2'), ('GET', base + '/v1/fetch/' + RESULT['id'] + '/network/2/body'),
            ('GET', base + '/v1/fetch/' + RESULT['id'] + '/network.har?page=1'),
            ('POST', base + '/v1/fetch/' + RESULT['id'] + '/next')])
        self.assertTrue(all(auth == 'Bearer fxk_fixture' for _, _, auth in calls))

    def test_batches_use_the_documented_methods_and_paths_and_follow_results_to_the_end(self):
        calls = []
        batch_id = '9b2f6a1c-3d4e-4f50-8a6b-7c8d9e0f1a2b'
        pages = [{'items': [{'index': 1, 'status': 'succeeded'}], 'next_cursor': 'c1'},
                 {'items': [], 'next_cursor': 'c1'},
                 {'items': [{'index': 0, 'status': 'failed'}], 'next_cursor': None}]

        def handler(request):
            calls.append((request.method, str(request.url)))
            if request.method == 'POST' and request.url.path == '/v1/batches':
                body = json.loads(request.content)
                self.assertEqual(body['items'], ['https://shop.example.com/a', {'url': 'https://shop.example.com/b', 'formats': ['text']}])
                self.assertEqual(body['defaults'], {'formats': ['markdown']})
                self.assertTrue(body['idempotency_key'], 'the client sets a key so retries are safe')
                return httpx.Response(202, json={'id': batch_id, 'status': 'running'})
            if request.url.path.endswith('/items') and request.url.params.get('order') == 'finished':
                return httpx.Response(200, json=pages.pop(0))
            return httpx.Response(200, json={'id': batch_id, 'status': 'running', 'items': [], 'next_cursor': None})

        module.time.sleep = lambda _seconds: None
        client = client_for(handler)
        batch = client.submit_batch(['https://shop.example.com/a', {'url': 'https://shop.example.com/b', 'formats': ['text']}],
                                    defaults={'formats': ['markdown']})
        self.assertEqual(batch['id'], batch_id)
        client.get_batch(batch_id)
        client.list_batches(status='paused', limit=5)
        client.batch_items(batch_id, status='failed', results=False)
        client.cancel_batch(batch_id)
        self.assertEqual([item['index'] for item in client.batch_results(batch_id, interval=0)], [1, 0])
        base = 'https://api.fetchx.test/v1/batches'
        self.assertEqual(calls, [
            ('POST', base), ('GET', base + '/' + batch_id), ('GET', base + '?status=paused&limit=5'),
            ('GET', base + '/' + batch_id + '/items?status=failed&results=false'), ('POST', base + '/' + batch_id + '/cancel'),
            ('GET', base + '/' + batch_id + '/items?order=finished&results=true&limit=100'),
            ('GET', base + '/' + batch_id + '/items?order=finished&results=true&limit=100&cursor=c1'),
            ('GET', base + '/' + batch_id + '/items?order=finished&results=true&limit=100&cursor=c1')])

    def test_a_lost_reply_is_resent_with_the_same_key(self):
        keys = []

        def handler(request):
            keys.append(json.loads(request.content)['idempotency_key'])
            if len(keys) == 1:
                raise httpx.ReadTimeout('lost fxk_fixture', request=request)
            return httpx.Response(200, json=RESULT)

        module.time.sleep = lambda _seconds: None
        self.assertEqual(client_for(handler).fetch(url='https://shop.example.com/')['id'], RESULT['id'])
        self.assertEqual(len(keys), 2)
        self.assertEqual(keys[0], keys[1])

    def test_maintenance_and_a_restarting_gateway_are_waited_out(self):
        replies = [httpx.Response(503, json={'error': {'code': 'maintenance', 'message': 'paused', 'retry_after_seconds': 0}}),
                   httpx.Response(503, json={'error': {'code': 'unavailable', 'message': 'restarting', 'retry_after_seconds': 0}}),
                   httpx.Response(200, json=RESULT)]
        module.time.sleep = lambda _seconds: None
        self.assertEqual(client_for(lambda _request: replies.pop(0)).fetch(url='https://shop.example.com/')['id'], RESULT['id'])
        self.assertEqual(replies, [])

    def test_errors_carry_code_status_details_and_never_the_body_or_token(self):
        def refused(_request):
            return httpx.Response(400, json={'error': {'code': 'invalid_request', 'message': 'bad', 'details': {'field': 'url'}}})

        with self.assertRaises(FetchXError) as caught:
            client_for(refused).fetch(url='https://shop.example.com/', idempotency_key='k1')
        error = caught.exception
        self.assertEqual((error.code, error.status, error.details, error.idempotency_key), ('invalid_request', 400, {'field': 'url'}, 'k1'))

        def broken(_request):
            return httpx.Response(502, content=b'<html>private proxy page</html>')

        with self.assertRaises(FetchXError) as caught:
            client_for(broken, retries=0).fetch(url='https://shop.example.com/')
        self.assertEqual(caught.exception.code, 'invalid_response')
        self.assertNotIn('private proxy page', str(caught.exception))
        self.assertNotIn('fxk_fixture', str(caught.exception))

    def test_wait_polls_until_finished(self):
        states = ['pending', 'pending', 'succeeded', 'succeeded']

        def handler(_request):
            return httpx.Response(200, json={**RESULT, 'status': states.pop(0)})

        module.time.sleep = lambda _seconds: None
        self.assertEqual(client_for(handler).wait(RESULT['id'], interval=0.01)['status'], 'succeeded')


if __name__ == '__main__':
    unittest.main()
