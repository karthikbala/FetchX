"""Thin client. No source parsing, provider secrets or automatic source retry."""
import uuid
from urllib.parse import quote
import httpx

class GatewayError(RuntimeError):
    def __init__(self,code,*,status=None,details=None,workflow=None,idempotency_key=None,response=None):
        super().__init__(code)
        self.code=code
        self.status=status
        self.details=details
        self.workflow=workflow
        self.response=response
        envelope=response if isinstance(response,dict) else {}
        response_key=envelope.get('idempotency_key')
        if idempotency_key is None and isinstance(response_key,str):
            idempotency_key=response_key
        self.idempotency_key=idempotency_key
        operation_id,session_id=envelope.get('operation_id'),envelope.get('session_id')
        self.operation_id=operation_id if isinstance(operation_id,str) else None
        self.session_id=session_id if isinstance(session_id,str) else None
        retry,diagnostics=envelope.get('retry'),envelope.get('diagnostics')
        self.retry=retry if isinstance(retry,dict) else None
        self.diagnostics=diagnostics if isinstance(diagnostics,dict) else None

class GatewayClient:
    def __init__(self,url,token,client=None):
        if not url or not token:raise GatewayError('gateway_config_missing')
        self.url=url.rstrip('/')
        self.token=token
        self.http=client or httpx.Client(timeout=85,trust_env=False)
    def call(self,path,data=None,*,headers=None,**context):
        try:
            r=self.http.request('GET' if data is None else 'POST',self.url+path,json=data,headers={**(headers or {}),'Authorization':'Bearer '+self.token},auth=None,timeout=85,follow_redirects=False)
        except httpx.HTTPError:
            raise GatewayError('gateway_unavailable',**context) from None
        try:result=r.json()
        except ValueError:raise GatewayError('gateway_invalid_response',status=r.status_code,**context) from None
        if not isinstance(result,dict):raise GatewayError('gateway_invalid_response',status=r.status_code,**context)
        if not r.is_success:
            # Scrape failures carry {code, error: message}; other APIs carry the code in error.
            code=result.get('error')
            if isinstance(code,dict):
                code=code.get('code')
            elif isinstance(result.get('code'),str):
                code=result['code']
            raise GatewayError(code if isinstance(code,str) else 'gateway_failed',status=r.status_code,details=result.get('details'),response=result,**context)
        return result
    def workflow(self,profile,key=None,**limits):
        data={'profile':profile,'idempotency_key':key or str(uuid.uuid4()),**limits}
        return self.call('/v1/workflows',data,idempotency_key=data['idempotency_key'])
    def request(self,workflow,**request):
        data={'idempotency_key':str(uuid.uuid4()),**request}
        return self.call('/v1/workflows/'+workflow+'/operations',data,workflow=workflow,idempotency_key=data['idempotency_key'])
    def close(self,workflow):return self.call('/v1/workflows/'+workflow+'/close',{},workflow=workflow)
    def lookup(self,workflow,key):return self.call('/v1/workflows/'+workflow+'/operations/'+quote(key,safe=''),workflow=workflow,idempotency_key=key)
    def fetch_page(self,**request):
        if not request.get('idempotency_key'):raise GatewayError('idempotency_key_required')
        return self.call('/v1/fetch',request,idempotency_key=request['idempotency_key'])
    def lookup_fetch(self,key):return self.call('/v1/fetch/'+quote(key,safe=''),idempotency_key=key)
    def submit_job(self,**request):
        if not request.get('idempotency_key'):raise GatewayError('idempotency_key_required')
        return self.call('/v1/jobs',request,idempotency_key=request['idempotency_key'])
    def job(self,id):return self.call('/v1/jobs/'+id)
    def profiles(self):return self.call('/v1/profiles')
    def status(self):return self.call('/v1/status')
    def diagnostics(self,operation):return self.call('/v1/operations/'+operation+'/diagnostics')
    def outcome(self,operation,*,accepted_records,rejected_records,reason_code):
        return self.call('/v1/operations/'+operation+'/outcome',{'accepted_records':accepted_records,'rejected_records':rejected_records,'reason_code':reason_code})

    def _submit_v2(self,path,request):
        if not request.get('idempotency_key'):
            raise GatewayError('idempotency_key_required')
        return self.call(path,request,idempotency_key=request['idempotency_key'])

    def fetch_v2(self,**request):
        return self._submit_v2('/v2/fetch',request)

    def lookup_fetch_v2(self,key):
        return self.call('/v2/fetch/'+quote(key,safe=''),idempotency_key=key)

    def read_fetch_operation_v2(self,operation_id):
        return self.call('/v2/fetch/operations/'+quote(operation_id,safe=''))

    def render_v2(self,**request):
        return self._submit_v2('/v2/render',request)

    def prepare_render_v2(self,**request):
        return self.call('/v2/render/prepare',request)

    def scrape_v2(self,idempotency_key,**request):
        if not idempotency_key:
            raise GatewayError('idempotency_key_required')
        return self.call('/v2/scrape',request,headers={'X-Idempotency-Key':idempotency_key},idempotency_key=idempotency_key)

    def lookup_render_v2(self,key):
        return self.call('/v2/render/'+quote(key,safe=''),idempotency_key=key)

    def capabilities_v2(self):
        return self.call('/v2/capabilities')

    def access_profiles_v2(self):
        return self.call('/v2/access-profiles')

    def discovery_profile_v2(self,**request):
        return self._submit_v2('/v2/discovery-profiles',request)

    def recipes_v2(self):
        return self.call('/v2/recipes')

    def session_v2(self,**request):
        return self._submit_v2('/v2/sessions',request)

    def read_session_v2(self,session_id):
        return self.call('/v2/sessions/'+quote(session_id,safe=''))

    def operation_v2(self,**request):
        return self._submit_v2('/v2/operations',request)

    def browser_probe_v2(self,**request):
        return self._submit_v2('/v2/browser-probes',request)

    def read_operation_v2(self,operation_id):
        return self.call('/v2/operations/'+quote(operation_id,safe=''))

    def lookup_operation_v2(self,key):
        return self.call('/v2/operations/by-key/'+quote(key,safe=''),idempotency_key=key)

    def artifact_v2(self,artifact_id):
        return self.call('/v2/artifacts/'+quote(artifact_id,safe=''))

    def usage_v2(self):
        return self.call('/v2/usage')

    def recent_operations_v2(self,limit=25):
        return self.call('/v2/operations?limit='+quote(str(limit),safe=''))

FetchXClient = GatewayClient
