"""Offline client recovery checks. Run with a Python environment containing httpx."""
import importlib.util,json,unittest
from pathlib import Path
import httpx

spec=importlib.util.spec_from_file_location('gateway_client',Path(__file__).resolve().parents[1]/'clients/python.py')
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
GatewayClient,GatewayError=module.GatewayClient,module.GatewayError

class ClientRecoveryTests(unittest.TestCase):
    def test_lost_response_exposes_generated_key_and_lookup_is_get(self):
        calls=[]
        def handler(request):
            calls.append(request)
            if request.method=='POST':raise httpx.ReadTimeout('private fixture-token',request=request)
            return httpx.Response(200,json={'id':'stored-capture'})
        with httpx.Client(transport=httpx.MockTransport(handler),auth=('unrelated','auth')) as http:
            client=GatewayClient('http://gateway.invalid/','fixture-token',client=http)
            with self.assertRaises(GatewayError) as caught:client.request('workflow-id',url='https://source.example/item')
            error=caught.exception
            self.assertEqual(error.idempotency_key,json.loads(calls[0].content)['idempotency_key'])
            self.assertEqual(error.workflow,'workflow-id')
            self.assertEqual(error.code,'gateway_unavailable')
            self.assertIsNone(error.status)
            self.assertNotIn('fixture-token',str(error))
            self.assertEqual(client.lookup(error.workflow,error.idempotency_key),{'id':'stored-capture'})
        self.assertEqual(len(calls),2)
        self.assertEqual(calls[1].method,'GET')
        self.assertEqual(calls[0].headers['authorization'],'Bearer fixture-token')
        self.assertEqual(calls[0].url.host,'gateway.invalid')

    def test_http_error_keeps_recorded_key_and_details(self):
        calls=[]
        def handler(request):
            calls.append(request)
            return httpx.Response(409,json={'error':'operation_in_progress','details':{'retry_after_seconds':1}})
        with httpx.Client(transport=httpx.MockTransport(handler)) as http:
            client=GatewayClient('http://gateway.invalid','fixture-token',client=http)
            with self.assertRaises(RuntimeError) as caught:
                client.request('workflow-id',idempotency_key='recorded-key',url='https://source.example/item')
            error=caught.exception
            self.assertEqual(error.idempotency_key,'recorded-key')
            self.assertEqual(error.status,409)
            self.assertEqual(error.details,{'retry_after_seconds':1})
        self.assertEqual(len(calls),1)

    def test_invalid_json_keeps_recovery_context_without_body(self):
        for content in [b'private proxy HTML',b'null',b'[]']:
            with httpx.Client(transport=httpx.MockTransport(lambda _:httpx.Response(502,content=content))) as http:
                client=GatewayClient('http://gateway.invalid','fixture-token',client=http)
                with self.assertRaises(GatewayError) as caught:
                    client.request('workflow-id',idempotency_key='recorded-key',url='https://source.example/item')
                self.assertEqual(caught.exception.code,'gateway_invalid_response')
                self.assertEqual(caught.exception.idempotency_key,'recorded-key')
                self.assertNotIn('private proxy HTML',str(caught.exception))

    def test_workflow_creation_key_can_be_reused_after_a_lost_response(self):
        bodies=[]
        def handler(request):
            bodies.append(json.loads(request.content))
            if len(bodies)==1:raise httpx.ReadTimeout('lost response',request=request)
            return httpx.Response(200,json={'id':'existing-workflow'})
        with httpx.Client(transport=httpx.MockTransport(handler)) as http:
            client=GatewayClient('http://gateway.invalid','fixture-token',client=http)
            with self.assertRaises(GatewayError) as caught:client.workflow('reviewed.profile',max_requests=2)
            self.assertIsNone(caught.exception.workflow)
            self.assertEqual(client.workflow('reviewed.profile',caught.exception.idempotency_key,max_requests=2),{'id':'existing-workflow'})
        self.assertEqual(bodies[0],bodies[1])

class ClientV2Tests(unittest.TestCase):
    gateway = 'https://gateway.invalid'
    token = 'fixture-token'
    contract = json.loads((Path(__file__).resolve().parents[1] / 'docs/openapi.json').read_text(encoding='utf-8'))

    def example(self, path):
        return self.contract['paths'][path]['post']['requestBody']['content']['application/json']['examples']['example']['value']

    def test_helpers_match_javascript_routes_and_pass_payloads_through(self):
        calls = []

        def handler(request):
            calls.append(request)
            return httpx.Response(200, json={'fixture': 'response'})

        segment, encoded = 'saved/key:01', 'saved%2Fkey%3A01'
        native_input = {'idempotency_key': 'native-001'}
        cases = [
            ('fetch_v2', (), '/v2/fetch', self.example('/v2/fetch')),
            ('lookup_fetch_v2', (segment,), '/v2/fetch/' + encoded, None),
            ('read_fetch_operation_v2', (segment,), '/v2/fetch/operations/' + encoded, None),
            ('render_v2', (), '/v2/render', self.example('/v2/render')),
            ('lookup_render_v2', (segment,), '/v2/render/' + encoded, None),
            ('prepare_render_v2', (), '/v2/render/prepare', self.example('/v2/render/prepare')),
            ('capabilities_v2', (), '/v2/capabilities', None),
            ('access_profiles_v2', (), '/v2/access-profiles', None),
            ('discovery_profile_v2', (), '/v2/discovery-profiles', native_input),
            ('recipes_v2', (), '/v2/recipes', None),
            ('session_v2', (), '/v2/sessions', native_input),
            ('read_session_v2', (segment,), '/v2/sessions/' + encoded, None),
            ('operation_v2', (), '/v2/operations', native_input),
            ('browser_probe_v2', (), '/v2/browser-probes', native_input),
            ('read_operation_v2', (segment,), '/v2/operations/' + encoded, None),
            ('lookup_operation_v2', (segment,), '/v2/operations/by-key/' + encoded, None),
            ('artifact_v2', (segment,), '/v2/artifacts/' + encoded, None),
            ('usage_v2', (), '/v2/usage', None),
            ('recent_operations_v2', (), '/v2/operations?limit=25', None),
            ('recent_operations_v2', (50,), '/v2/operations?limit=50', None),
        ]
        with httpx.Client(transport=httpx.MockTransport(handler)) as http:
            client = GatewayClient(self.gateway + '/', self.token, client=http)
            for method, args, path, body in cases:
                with self.subTest(method=method):
                    result = getattr(client, method)(*args, **(body or {}))
                    self.assertEqual(result, {'fixture': 'response'})
                    self.assertEqual(len(calls), 1)
                    request = calls.pop()
                    self.assertEqual(str(request.url), self.gateway + path)
                    self.assertEqual(request.method, 'GET' if body is None else 'POST')
                    self.assertEqual(request.headers['authorization'], 'Bearer ' + self.token)
                    self.assertEqual(json.loads(request.content) if request.content else None, body)

    def test_scrape_sends_the_caller_key_header_and_maps_scrape_failures(self):
        calls = []

        def handler(request):
            calls.append(request)
            if len(calls) == 1:
                return httpx.Response(200, json={'success': True, 'data': {'metadata': {}}})
            return httpx.Response(403, json={'success': False, 'code': 'scrape_disabled', 'error': 'Scrape is not enabled.'})

        body = self.example('/v2/scrape')
        with httpx.Client(transport=httpx.MockTransport(handler)) as http:
            client = GatewayClient(self.gateway, self.token, client=http)
            with self.assertRaises(GatewayError) as caught:
                client.scrape_v2(None, **body)
            self.assertEqual(caught.exception.code, 'idempotency_key_required')
            self.assertEqual(calls, [])
            self.assertTrue(client.scrape_v2('scrape-001', **body)['success'])
            self.assertEqual(calls[0].headers['x-idempotency-key'], 'scrape-001')
            self.assertEqual(str(calls[0].url), self.gateway + '/v2/scrape')
            self.assertEqual(json.loads(calls[0].content), body)
            with self.assertRaises(GatewayError) as caught:
                client.scrape_v2('scrape-001', **body)
            self.assertEqual(caught.exception.code, 'scrape_disabled')
            self.assertEqual(caught.exception.status, 403)
            self.assertEqual(caught.exception.idempotency_key, 'scrape-001')

    def test_submissions_require_a_caller_key_before_dispatch(self):
        def unexpected_request(_):
            self.fail('missing caller key dispatched a request')

        with httpx.Client(transport=httpx.MockTransport(unexpected_request)) as http:
            client = GatewayClient(self.gateway, self.token, client=http)
            for method in ('fetch_v2', 'render_v2', 'discovery_profile_v2', 'session_v2', 'operation_v2', 'browser_probe_v2'):
                with self.subTest(method=method), self.assertRaises(GatewayError) as caught:
                    getattr(client, method)()
                self.assertEqual(caught.exception.code, 'idempotency_key_required')

    def test_source_failure_returns_and_gateway_error_preserves_structured_response(self):
        retained = {'success': False, 'gateway_http_status': 200, 'data': {'status': 403}, 'error': {'code': 'source_forbidden'}}
        failure = {
            'success': False, 'gateway_http_status': 409, 'operation_id': 'fixture-operation',
            'session_id': 'fixture-session', 'idempotency_key': None,
            'error': {'code': 'idempotency_conflict', 'message': 'Use the original key to recover.', 'stage': 'request_admission'},
            'retry': {'next_action': 'recover_first', 'lookup_url': '/v2/fetch/quickstart-001'},
            'diagnostics': {'stage': 'request_admission'},
        }
        for method, path in (('fetch_v2', '/v2/fetch'), ('render_v2', '/v2/render')):
            with self.subTest(method=method):
                calls = []

                def handler(request):
                    calls.append(request)
                    if len(calls) == 1:
                        return httpx.Response(200, json=retained)
                    return httpx.Response(409, json=failure)

                with httpx.Client(transport=httpx.MockTransport(handler)) as http:
                    client = GatewayClient(self.gateway, self.token, client=http)
                    request = self.example(path)
                    self.assertEqual(getattr(client, method)(**request), retained)
                    with self.assertRaises(GatewayError) as caught:
                        getattr(client, method)(**request)
                    error = caught.exception
                    self.assertEqual(str(error), failure['error']['code'])
                    self.assertEqual(error.code, failure['error']['code'])
                    self.assertEqual(error.status, 409)
                    self.assertEqual(error.idempotency_key, request['idempotency_key'])
                    self.assertEqual(error.operation_id, failure['operation_id'])
                    self.assertEqual(error.session_id, failure['session_id'])
                    self.assertEqual(error.retry, failure['retry'])
                    self.assertEqual(error.diagnostics, failure['diagnostics'])
                    self.assertEqual(error.response, failure)
                self.assertEqual(len(calls), 2)

    def test_transport_loss_and_invalid_response_keep_exact_key_for_read_only_recovery(self):
        surfaces = [('fetch_v2', 'lookup_fetch_v2', '/v2/fetch'), ('render_v2', 'lookup_render_v2', '/v2/render')]
        for submit, lookup, path in surfaces:
            for invalid in (False, True):
                with self.subTest(method=submit, invalid_response=invalid):
                    calls = []

                    def handler(request):
                        calls.append(request)
                        if request.method == 'GET':
                            return httpx.Response(200, json={'success': True})
                        if invalid:
                            return httpx.Response(502, content=b'private response text')
                        raise httpx.ReadTimeout('private transport error with fixture-token', request=request)

                    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
                        client = GatewayClient(self.gateway, self.token, client=http)
                        request = self.example(path)
                        with self.assertRaises(GatewayError) as caught:
                            getattr(client, submit)(**request)
                        error = caught.exception
                        self.assertEqual(error.idempotency_key, request['idempotency_key'])
                        self.assertEqual(error.code, 'gateway_invalid_response' if invalid else 'gateway_unavailable')
                        self.assertEqual(error.status, 502 if invalid else None)
                        self.assertIsNone(error.response)
                        self.assertNotIn('private', str(error))
                        self.assertNotIn(self.token, str(error))
                        self.assertEqual(len(calls), 1)
                        self.assertEqual(getattr(client, lookup)(error.idempotency_key), {'success': True})
                    self.assertEqual([call.method for call in calls], ['POST', 'GET'])
                    self.assertEqual(str(calls[1].url), str(calls[0].url) + '/' + request['idempotency_key'])
                    self.assertEqual(calls[1].content, b'')

    def test_legacy_fetch_uses_v1_payload_and_recovery_route(self):
        calls = []

        def handler(request):
            calls.append(request)
            return httpx.Response(200, json={'status': 200})

        request = {'profile': 'source.http', 'url': 'https://source.example/', 'idempotency_key': 'v1-saved'}
        with httpx.Client(transport=httpx.MockTransport(handler)) as http:
            client = GatewayClient(self.gateway, self.token, client=http)
            self.assertEqual(client.fetch_page(**request), {'status': 200})
            self.assertEqual(client.lookup_fetch(request['idempotency_key']), {'status': 200})
        self.assertEqual([(r.method, r.url.path) for r in calls], [('POST', '/v1/fetch'), ('GET', '/v1/fetch/v1-saved')])
        self.assertEqual(json.loads(calls[0].content), request)
        self.assertEqual(calls[1].content, b'')

    def test_v2_submit_surfaces_a_gateway_redirect_without_another_call(self):
        calls = []

        def handler(request):
            calls.append(request)
            return httpx.Response(307, headers={'location': '/alternate'}, json={'error': 'fixture_redirect'})

        request = self.example('/v2/fetch')
        with httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True) as http:
            client = GatewayClient(self.gateway, self.token, client=http)
            with self.assertRaises(GatewayError) as caught:
                client.fetch_v2(**request)
            self.assertEqual(caught.exception.code, 'fixture_redirect')
            self.assertEqual(caught.exception.status, 307)
            self.assertEqual(caught.exception.idempotency_key, request['idempotency_key'])
        self.assertEqual([(r.method, r.url.path) for r in calls], [('POST', '/v2/fetch')])

if __name__=='__main__':unittest.main()
