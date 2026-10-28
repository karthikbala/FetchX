"""Thin client. No source parsing, provider secrets or automatic source retry."""
import uuid
from urllib.parse import quote
import httpx

class GatewayError(RuntimeError):
    def __init__(self,code,*,status=None,details=None,workflow=None,idempotency_key=None):
        super().__init__(code)
        self.code=code
        self.status=status
        self.details=details
        self.workflow=workflow
        self.idempotency_key=idempotency_key

class GatewayClient:
    def __init__(self,url,token,client=None):
        if not url or not token:raise GatewayError('gateway_config_missing')
        self.url=url.rstrip('/')
        self.token=token
        self.http=client or httpx.Client(timeout=85,trust_env=False)
    def call(self,path,data=None,**context):
        try:
            r=self.http.request('GET' if data is None else 'POST',self.url+path,json=data,headers={'Authorization':'Bearer '+self.token},auth=None,timeout=85,follow_redirects=False)
        except httpx.HTTPError:
            raise GatewayError('gateway_unavailable',**context) from None
        try:result=r.json()
        except ValueError:raise GatewayError('gateway_invalid_response',status=r.status_code,**context) from None
        if not isinstance(result,dict):raise GatewayError('gateway_invalid_response',status=r.status_code,**context)
        if not r.is_success:
            code=result.get('error')
            raise GatewayError(code if isinstance(code,str) else 'gateway_failed',status=r.status_code,details=result.get('details'),**context)
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

FetchXClient = GatewayClient
