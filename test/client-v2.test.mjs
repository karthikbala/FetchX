import assert from 'node:assert/strict';
import test from 'node:test';
import {FetchXClient, GatewayError} from '../clients/javascript.mjs';
import contract from '../docs/openapi.json' with {type:'json'};

const gateway = 'https://gateway.invalid';
const token = 'fixture-token';
const pathValue = 'saved/key:01';
const encoded = 'saved%2Fkey%3A01';
const example = path => contract.paths[path].post.requestBody.content['application/json'].examples.example.value;
const fetchInput = example('/v2/fetch');
const renderInput = example('/v2/render');
const nativeInput = {idempotency_key:'native-001'};

test('v2 SDK helpers use the expected methods, paths, keys and request bodies', async () => {
 const calls = [];
 const client = new FetchXClient({url:gateway+'/',token,fetch:async (url,options) => {
  calls.push({url,options});
  return Response.json({fixture:'response'});
 }});
 const cases = [
  ['fetchV2',[fetchInput],'/v2/fetch',fetchInput],
  ['lookupFetchV2',[pathValue],'/v2/fetch/'+encoded],
  ['readFetchOperationV2',[pathValue],'/v2/fetch/operations/'+encoded],
  ['renderV2',[renderInput],'/v2/render',renderInput],
  ['lookupRenderV2',[pathValue],'/v2/render/'+encoded],
  ['prepareRenderV2',[example('/v2/render/prepare')],'/v2/render/prepare',example('/v2/render/prepare')],
  ['capabilitiesV2',[],'/v2/capabilities'],
  ['accessProfilesV2',[],'/v2/access-profiles'],
  ['discoveryProfileV2',[nativeInput],'/v2/discovery-profiles',nativeInput],
  ['recipesV2',[],'/v2/recipes'],
  ['sessionV2',[nativeInput],'/v2/sessions',nativeInput],
  ['readSessionV2',[pathValue],'/v2/sessions/'+encoded],
  ['operationV2',[nativeInput],'/v2/operations',nativeInput],
  ['browserProbeV2',[nativeInput],'/v2/browser-probes',nativeInput],
  ['readOperationV2',[pathValue],'/v2/operations/'+encoded],
  ['lookupOperationV2',[pathValue],'/v2/operations/by-key/'+encoded],
  ['artifactV2',[pathValue],'/v2/artifacts/'+encoded],
  ['usageV2',[],'/v2/usage'],
  ['recentOperationsV2',[],'/v2/operations?limit=25'],
  ['recentOperationsV2',[50],'/v2/operations?limit=50'],
 ];
 for (const [method,args,path,body] of cases) {
  assert.deepEqual(await client[method](...args),{fixture:'response'},method);
  assert.equal(calls.length,1,method);
  const [{url,options}] = calls.splice(0);
  assert.equal(url,gateway+path,method);
  assert.equal(options.method,body===undefined?'GET':'POST',method);
  assert.equal(options.headers.authorization,'Bearer '+token,method);
  assert.equal(options.redirect,'manual',method);
  assert.deepEqual(options.body===undefined?undefined:JSON.parse(options.body),body,method);
 }
});

test('v2 submissions require a caller-owned key before any request', async () => {
 let calls = 0;
 const client = new FetchXClient({url:gateway,token,fetch:async () => {calls++;}});
 for (const method of ['fetchV2','renderV2','discoveryProfileV2','sessionV2','operationV2','browserProbeV2']) {
  await assert.rejects(client[method]({}),{name:'GatewayError',code:'idempotency_key_required'});
 }
 assert.equal(calls,0);
});

test('scrapeV2 sends the caller key header and maps Scrape failures', async () => {
 const calls = [];
 const body = example('/v2/scrape');
 const client = new FetchXClient({url:gateway,token,fetch:async (url,options) => {
  calls.push({url,options});
  return calls.length===1?Response.json({success:true,data:{metadata:{}}}):
   Response.json({success:false,code:'scrape_disabled',error:'Scrape is not enabled.'},{status:403});
 }});
 await assert.rejects(client.scrapeV2(body),{code:'idempotency_key_required'});
 assert.equal(calls.length,0);
 assert.equal((await client.scrapeV2(body,'scrape-001')).success,true);
 assert.equal(calls[0].url,gateway+'/v2/scrape');
 assert.equal(calls[0].options.headers['x-idempotency-key'],'scrape-001');
 assert.equal(calls[0].options.headers.authorization,'Bearer '+token);
 assert.deepEqual(JSON.parse(calls[0].options.body),body);
 await assert.rejects(client.scrapeV2(body,'scrape-001'),{code:'scrape_disabled',status:403,idempotency_key:'scrape-001'});
});

const submitters = [['fetchV2','lookupFetchV2',fetchInput],['renderV2','lookupRenderV2',renderInput]];

test('v2 source failure in HTTP 200 is returned, gateway failure keeps the structured envelope', async () => {
 for (const [submit,,input] of submitters) {
  const retained = {success:false,gateway_http_status:200,data:{status:403},error:{code:'source_forbidden'}};
  const failure = {
   success:false,
   gateway_http_status:409,
   operation_id:'fixture-operation',
   session_id:'fixture-session',
   idempotency_key:null,
   error:{code:'idempotency_conflict',message:'Use the original key to recover.',stage:'request_admission'},
   retry:{next_action:'recover_first',lookup_url:'/v2/fetch/quickstart-001'},
   diagnostics:{stage:'request_admission'},
  };
  let calls = 0;
  const client = new FetchXClient({url:gateway,token,fetch:async () => {
   calls++;
   return calls===1?Response.json(retained):Response.json(failure,{status:409});
  }});
  assert.deepEqual(await client[submit](input),retained);
  await assert.rejects(client[submit](input),error => {
   assert.ok(error instanceof GatewayError);
   assert.equal(error.message,failure.error.code);
   assert.equal(error.code,failure.error.code);
   assert.equal(error.status,409);
   assert.equal(error.idempotency_key,input.idempotency_key);
   assert.equal(error.operation_id,failure.operation_id);
   assert.equal(error.session_id,failure.session_id);
   assert.deepEqual(error.retry,failure.retry);
   assert.deepEqual(error.diagnostics,failure.diagnostics);
   assert.deepEqual(error.response,failure);
   return true;
  });
  assert.equal(calls,2);
 }
});

test('v2 transport loss and invalid responses preserve the exact key for GET recovery', async () => {
 for (const [submit,lookup,input] of submitters) {
  for (const invalidResponse of [false,true]) {
   const calls = [];
   const client = new FetchXClient({url:gateway,token,fetch:async (url,options) => {
    calls.push({url,options});
    if (options.method==='GET') return Response.json({success:true});
    if (invalidResponse) return new Response('private response text',{status:502});
    throw new Error('private transport error with '+token);
   }});
   let key;
   await assert.rejects(client[submit](input),error => {
    key = error.idempotency_key;
    assert.equal(key,input.idempotency_key);
    assert.equal(error.code,invalidResponse?'gateway_invalid_response':'gateway_unavailable');
    assert.equal(error.status,invalidResponse?502:null);
    assert.equal(error.response,null);
    assert.doesNotMatch(String(error),/private|fixture-token/);
    return true;
   });
   assert.equal(calls.length,1);
   assert.deepEqual(await client[lookup](key),{success:true});
   assert.deepEqual(calls.map(({options})=>options.method),['POST','GET']);
   assert.equal(calls[1].url,calls[0].url+'/'+encodeURIComponent(key));
   assert.equal(calls[1].options.body,undefined);
  }
 }
});

test('legacy Fetch helper still sends the v1 body and recovers through the v1 route', async () => {
 const input = {idempotency_key:'v1-saved',profile:'source.http',url:'https://source.example/'};
 const calls = [];
 const client = new FetchXClient({url:gateway,token,fetch:async (url,options) => {
  calls.push([url,options.method,options.body]);
  return Response.json({status:200});
 }});
 assert.deepEqual(await client.fetchPage(input),{status:200});
 assert.deepEqual(await client.lookupFetch(input.idempotency_key),{status:200});
 assert.deepEqual(calls,[[gateway+'/v1/fetch','POST',JSON.stringify(input)],[gateway+'/v1/fetch/v1-saved','GET',undefined]]);
});

test('v2 submit surfaces a gateway redirect without another call', async () => {
 const calls = [];
 const client = new FetchXClient({url:gateway,token,fetch:async (url,options) => {
  calls.push([url,options.redirect]);
  return Response.json({error:'fixture_redirect'},{status:307,headers:{location:'/alternate'}});
 }});
 await assert.rejects(client.fetchV2(fetchInput),{
  code:'fixture_redirect',status:307,idempotency_key:fetchInput.idempotency_key,
 });
 assert.deepEqual(calls,[[gateway+'/v2/fetch','manual']]);
});
