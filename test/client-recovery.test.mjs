import test from 'node:test';
import assert from 'node:assert/strict';
import {GatewayClient,GatewayError} from '../clients/javascript.mjs';

test('lost operation response exposes its generated recovery key and GET lookup never redispatches',async()=>{
 const calls=[];
 const client=new GatewayClient({url:'http://gateway.invalid/',token:'fixture-token',fetch:async(url,options)=>{
  calls.push({url,options});
  if(options.method==='POST')throw Error('private transport error with fixture-token');
  return Response.json({id:'saved-capture',provider:'scrapedo',credits:1});
 }});
 let failure;
 try{await client.request('workflow-id',{url:'https://source.example/item'});}catch(error){failure=error;}
 assert.ok(failure instanceof GatewayError);
 assert.equal(failure.code,'gateway_unavailable');assert.equal(failure.status,null);
 assert.equal(failure.workflow,'workflow-id');
 const dispatchedKey=JSON.parse(calls[0].options.body).idempotency_key;
 assert.equal(failure.idempotency_key,dispatchedKey);
 assert.equal(String(failure).includes('fixture-token'),false);
 assert.deepEqual(await client.lookup(failure.workflow,failure.idempotency_key),{id:'saved-capture',provider:'scrapedo',credits:1});
 assert.equal(calls.length,2);assert.equal(calls[1].options.method,'GET');
 assert.ok(calls[1].url.endsWith('/operations/'+dispatchedKey));
});

test('recorded keys and gateway error status/details remain available without a retry',async()=>{
 let calls=0;
 const client=new GatewayClient({url:'http://gateway.invalid',token:'fixture-token',fetch:async(_url,options)=>{
  calls++;assert.equal(JSON.parse(options.body).idempotency_key,'recorded-operation');
  return Response.json({error:'operation_in_progress',details:{retry_after_seconds:1}},{status:409});
 }});
 await assert.rejects(client.request('workflow-id',{idempotency_key:'recorded-operation',url:'https://source.example/item'}),error=>{
  assert.equal(error.code,'operation_in_progress');assert.equal(error.status,409);
  assert.equal(error.workflow,'workflow-id');assert.equal(error.idempotency_key,'recorded-operation');
  assert.deepEqual(error.details,{retry_after_seconds:1});return true;
 });
 assert.equal(calls,1);
});

test('invalid gateway responses retain safe recovery context instead of leaking response text',async()=>{
 for(const response of [new Response('private source or proxy HTML',{status:502}),Response.json(null),Response.json([])]){
  const client=new GatewayClient({url:'http://gateway.invalid',token:'fixture-token',fetch:async()=>response});
  await assert.rejects(client.request('workflow-id',{idempotency_key:'saved-key',url:'https://source.example/item'}),error=>{
   assert.equal(error.code,'gateway_invalid_response');assert.equal(error.idempotency_key,'saved-key');
   assert.equal(error.workflow,'workflow-id');assert.equal(String(error).includes('private source'),false);return true;
  });
 }
});

test('lost workflow creation exposes its key so creation can be recovered with the same limits',async()=>{
 const bodies=[];
 const client=new GatewayClient({url:'http://gateway.invalid',token:'fixture-token',fetch:async(_url,options)=>{
  bodies.push(JSON.parse(options.body));
  if(bodies.length===1)throw Error('lost response');
  return Response.json({id:'existing-workflow'});
 }});
 let failure;
 try{await client.workflow('reviewed.profile',undefined,{max_requests:2});}catch(error){failure=error;}
 assert.equal(failure.workflow,null);assert.equal(failure.idempotency_key,bodies[0].idempotency_key);
 assert.deepEqual(await client.workflow('reviewed.profile',failure.idempotency_key,{max_requests:2}),{id:'existing-workflow'});
 assert.deepEqual(bodies[0],bodies[1]);
});
