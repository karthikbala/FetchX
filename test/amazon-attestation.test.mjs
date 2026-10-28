import test from 'node:test';
import assert from 'node:assert/strict';
import {MockAgent,getGlobalDispatcher,setGlobalDispatcher} from 'undici';
import {attestedSourceURL,scrapeDoRequest} from '../src/transport.mjs';

const input={url:'https://www.amazon.in/dp/B0BBFYBWX9',method:'GET',headers:{},main_document:true,zipcode:'500022'};
const profile={amazonZipPlugin:true,maxResponseBytes:4096,fallbackSuper:false,fallbackCountry:'in'};

test('Amazon ZIP attestation permits only the observed th=1 addition',()=>{
 assert.equal(attestedSourceURL(input.url,input,profile),true);
 assert.equal(attestedSourceURL(input.url+'?th=1',input,profile),true);
 const queried={...input,url:input.url+'?ref=a%2fb+space&x=2'};
 assert.equal(attestedSourceURL(queried.url+'&th=1',queried,profile),true);
 for(const reported of [null,'https://evil.example/dp/B0BBFYBWX9?th=1',input.url.replace('https:','http:')+'?th=1',
  input.url.replace('B0BBFYBWX9','B0BBFX4VBR')+'?th=1',input.url+'?th=2',input.url+'?th=1&th=1',
  input.url+'?th=1&other=1',input.url+'?%74h=1',input.url+'?th=1#offer',input.url+'/other?th=1']){
  assert.equal(attestedSourceURL(reported,input,profile),false,reported);
 }
 assert.equal(attestedSourceURL(input.url+'?th=1',{...input,main_document:false},profile),false);
 assert.equal(attestedSourceURL(input.url+'?th=1',{...input,method:'POST'},profile),false);
 assert.equal(attestedSourceURL(input.url+'?th=1',input,{...profile,amazonZipPlugin:false}),false);
 assert.equal(attestedSourceURL(input.url+'?th=1',{...input,url:input.url+'?th=2'},profile),false);
});

test('real provider response contract preserves 200/404, billing, and failed attestation',async()=>{
 const original=getGlobalDispatcher(),mock=new MockAgent();mock.disableNetConnect();setGlobalDispatcher(mock);
 try{
  for(const [status,resolved,error] of [[200,input.url+'?th=1',null],[404,input.url+'?th=1',null],
   [200,input.url.replace('B0BBFYBWX9','B0BBFX4VBR')+'?th=1','provider_unattested'],[200,null,'provider_unattested']]){
   const headers={'content-type':'text/html','scrape.do-target-url':input.url+'?th=1','scrape.do-initial-status-code':String(status),'scrape.do-request-cost':'1'};
   if(resolved)headers['scrape.do-resolved-url']=resolved;
   mock.get('https://api.scrape.do').intercept({path:/^\/plugin\/amazon\//,method:'GET'}).reply(status,'<html><body>source</body></html>',{headers});
   const result=await scrapeDoRequest(input,1,profile,'offline-token');
   assert.equal(result.error,error);assert.equal(result.status,error?null:status);
   assert.equal(result.credits,1);assert.equal(result.providerStatus,status);
   assert.match(result.body.toString(),/source/);
  }
  mock.assertNoPendingInterceptors();
 }finally{setGlobalDispatcher(original);await mock.close();}
});
