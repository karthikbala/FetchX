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

if __name__=='__main__':unittest.main()
