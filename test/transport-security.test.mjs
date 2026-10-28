import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MockAgent,getGlobalDispatcher,setGlobalDispatcher} from 'undici';
import {checkedURL,checkedHeaders,requestInput,FALLBACK_FAILURES} from '../src/policy.mjs';
import {profiles} from './fixtures/legacy-profiles.mjs';
import {oxylabsRequest,scrapeDoRequest} from '../src/transport.mjs';

test('reject parser-confusion URLs before DNS while preserving valid source encoding',async()=>{
 let resolved=0;const resolve=async()=>{resolved++;return [{address:'93.184.216.34'}];};
 const p=profiles['fixture.amazon'];
 for(const raw of ['https://source33.example\\@evil.example/x','https://source33.example\t.evil.example/x',' https://source33.example/','https://source33.example/a\nb','https://source33.example/a b','https://source33.example/\u0000','https:////source33.example/','https://source33.example/a/%2e%2e/private']){
  await assert.rejects(checkedURL(raw,p,resolve),{code:'destination_rejected'});
 }
 assert.equal(resolved,0);
 const raw='https://source33.example/data?q=a%2fb+space&x=%5C&x=2';
 assert.equal((await checkedURL(raw,p,resolve)).href,raw);
});

test('reject coercible JSON scalars, invalid Base64, control headers and oversized UTF-8 headers',()=>{
 const p=profiles['fixture.croma.api'],valid={idempotency_key:'one',url:'https://source32.example/catalog/v1/product/detail',method:'POST'};
 for(const patch of [{idempotency_key:['one']},{idempotency_key:1},{method:null},{headers:null},{main_document:'false'},{zipcode:560001},{resource_type:{}},{body_base64:42},{body_base64:'YWJj!!'},{body_base64:'YQ'},{body_base64:'YR=='}]){
  assert.throws(()=>requestInput({...valid,...patch},p));
 }
 assert.equal(requestInput({...valid,body_base64:'YQ=='},p).body.toString(),'a');
 // Existing MOP browser calls represent an absent body explicitly as null.
 assert.equal(requestInput({...valid,method:'GET',body_base64:null},p).body,null);
 assert.throws(()=>requestInput({...valid,main_document:true},profiles['fixture.amazon']),{code:'zipcode_required'});
 for(const value of ['abc\u0000def','abc\u000bdef','漢','é'.repeat(17000)]){
  assert.throws(()=>checkedHeaders({accept:value},p,new URL(valid.url),'POST'),{code:'headers_rejected'});
 }
});

test('local Python dependency/protocol failures cannot trigger a paid fallback; discarded bytes survive',async()=>{
 const root=await mkdtemp(join(tmpdir(),'gateway-python-fixture-'));
 const oldPython=process.env.GATEWAY_PYTHON,oldPath=process.env.PYTHONPATH;
 const input={url:'https://source.example/',method:'GET',headers:{}},proxy={url:'http://offline.invalid'},p={maxResponseBytes:4};
 try{
  process.env.GATEWAY_PYTHON=join(root,'missing-python');
  await assert.rejects(oxylabsRequest(input,proxy,p),e=>e.code==='transport_unavailable'&&!FALLBACK_FAILURES.has(e.code));
  const requests=join(root,'curl_cffi','requests');await mkdir(requests,{recursive:true});
  await writeFile(join(root,'curl_cffi','__init__.py'),'');
  await writeFile(join(requests,'exceptions.py'),`
class ConnectionError(Exception): pass
class ProxyError(Exception): pass
class Timeout(Exception): pass
class SSLError(ConnectionError): pass
class InvalidURL(Exception): pass
class InvalidSchema(Exception): pass
class InvalidHeader(Exception): pass
class ImpersonateError(Exception): pass
`);
  await writeFile(join(requests,'__init__.py'),`
from .exceptions import *
class Headers:
 def multi_items(self):return [('content-type','text/plain')]
class Response:
 status_code=200
 headers=Headers()
 def __init__(self,url):self.url=url
 def __enter__(self):return self
 def __exit__(self,*args):pass
 def iter_content(self,chunk_size):
  if self.url.endswith('/oversize'):yield b'abcdefghi'
  else:
   yield b'abc'
   raise Timeout('private credentials must not be printed')
class Session:
 def __init__(self,**kw):pass
 def __enter__(self):return self
 def __exit__(self,*args):pass
 def stream(self,method,url,**kw):
  if url.endswith('/config'):raise ImpersonateError('private')
  if url.endswith('/tls'):raise SSLError('private')
  if url.endswith('/timeout'):raise Timeout('private')
  return Response(url)
`);
  process.env.GATEWAY_PYTHON='python3';process.env.PYTHONPATH=root;
  for(const [path,error,bytes]of [['config','transport_request_invalid',0],['tls','tls_verification_failed',0],['timeout','proxy_connect_failed',0],['oversize','response_too_large',9],['partial','source_body_incomplete',3]]){
   const result=await oxylabsRequest({...input,url:'https://source.example/'+path},proxy,p);
   assert.equal(result.error,error);assert.equal(result.receivedBytes,bytes);assert.equal(result.body.length,0);
   assert.equal(FALLBACK_FAILURES.has(error),path==='timeout');
  }
 }finally{
  oldPython===undefined?delete process.env.GATEWAY_PYTHON:process.env.GATEWAY_PYTHON=oldPython;
  oldPath===undefined?delete process.env.PYTHONPATH:process.env.PYTHONPATH=oldPath;
  await rm(root,{recursive:true,force:true});
 }
});

test('paid transport accounts discarded bytes and rejects an unrepresentable credit receipt',async()=>{
 const original=getGlobalDispatcher(),mock=new MockAgent();mock.disableNetConnect();setGlobalDispatcher(mock);
 const input={url:'https://source.example/data',method:'GET',headers:{}},profile={maxResponseBytes:4,fallbackSuper:false,fallbackCountry:'in'};
 const headers={'scrape.do-target-url':input.url,'scrape.do-resolved-url':input.url,'scrape.do-initial-status-code':'200','scrape.do-request-cost':'1'};
 try{
  mock.get('https://api.scrape.do').intercept({path:/.*/,method:'GET'}).reply(200,'abcdefghi',{headers});
  const large=await scrapeDoRequest(input,1,profile,'offline-token');
  assert.equal(large.error,'response_too_large');assert.equal(large.credits,1);assert.equal(large.receivedBytes,9);assert.equal(large.body.length,0);
  mock.get('https://api.scrape.do').intercept({path:/.*/,method:'GET'}).reply(200,'abc',{headers:{...headers,'scrape.do-request-cost':'99999999999999999999999999'}});
  const invalid=await scrapeDoRequest(input,1,profile,'offline-token');
  assert.equal(invalid.credits,null);assert.equal(invalid.error,'metered_outcome_unknown');assert.equal(invalid.receivedBytes,3);
  mock.assertNoPendingInterceptors();
 }finally{setGlobalDispatcher(original);await mock.close();}
});
