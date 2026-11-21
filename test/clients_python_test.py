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
            ('POST', base + '/v1/fetch/' + RESULT['id'] + '/next')])
        self.assertTrue(all(auth == 'Bearer fxk_fixture' for _, _, auth in calls))

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
