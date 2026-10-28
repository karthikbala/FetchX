import test from 'node:test';
import assert from 'node:assert/strict';
import {checkedURL,checkedHeaders,publicIP,requestInput} from '../src/policy.mjs';
import {Sealer} from '../src/crypto.mjs';
import {profiles} from './fixtures/legacy-profiles.mjs';
import {sourceHeaders} from '../src/transport.mjs';
const publicDNS=async()=>[{address:'93.184.216.34'}];
test('only declared public HTTPS destinations survive host, port, credential and DNS checks',async()=>{
 const p=profiles['fixture.croma.api'];
 assert.equal((await checkedURL('https://source32.example/catalog/v1/product/detail?productCode=123',p,publicDNS)).hostname,'source32.example');
 for(const url of ['http://source32.example/','https://user:pass@source32.example/','https://source32.example:8443/','https://127.0.0.1/','https://source32.example/other','https://evil.example/'])await assert.rejects(checkedURL(url,p,publicDNS));
 await assert.rejects(checkedURL('https://source31.example/',p,async()=>[{address:'127.0.0.1'}]));
 for(const ip of ['127.0.0.1','10.1.2.3','169.254.169.254','::1','::ffff:127.0.0.1','fc00::1','100.64.0.1','2001:db8::1'])assert.equal(publicIP(ip),false);
});
test('gateway/proxy authentication cannot leak as source credentials; guest exceptions stay scoped',()=>{
 const u=new URL('https://source28.example/api/service/application/logistics/v1.0/pincode/560001'),p=profiles['fixture.jiomart'];
 assert.equal(checkedHeaders({authorization:'guest'},p,u,'GET').authorization,'guest');
 for(const headers of [{'proxy-authorization':'secret'},{'x-gateway-token':'secret'},{authorization:'secret\r\nx:evil'},{'sd-cookie':'x'},{host:'evil'}])assert.throws(()=>checkedHeaders(headers,p,u,'GET'));
 assert.throws(()=>checkedHeaders({authorization:'guest'},p,new URL('https://source28.example/other'),'GET'));
 assert.throws(()=>checkedHeaders({authorization:'guest'},p,u,'POST'));
});
test('JioMart delivery-promise guest authorization is exact-host, GET and query-free',()=>{
 const p=profiles['fixture.jiomart'],path='/api/service/application/logistics/v1.0/delivery-promise';
 const url=new URL('https://source28.example'+path);
 assert.equal(checkedHeaders({Authorization:'anonymous-source-guest'},p,url,'GET').authorization,'anonymous-source-guest');
 const rejected=[
  ['https://source16.example'+path,'GET'],
  ['https://source28.example'+path,'POST'],
  ['https://source28.example'+path,'HEAD'],
  ['https://source28.example'+path+'?pincode=560001','GET'],
  ['https://source28.example'+path+'?x=','GET'],
  ['https://source28.example'+path+'/','GET'],
  ['https://source28.example'+path+'/560001','GET'],
  ['https://source28.example'+path.replace('v1.0','v1x0'),'GET'],
  ['https://source28.example/api/service/application/logistics/v1.0/other','GET'],
 ];
 for(const [raw,method] of rejected)assert.throws(()=>checkedHeaders({authorization:'anonymous-source-guest'},p,new URL(raw),method),{code:'credential_scope_rejected'});
 for(const profile of ['fixture.croma.api','fixture.reliance','fixture.flipkart','fixture.vijay','fixture.amazon'])
  assert.throws(()=>checkedHeaders({authorization:'anonymous-source-guest'},profiles[profile],url,'GET'),{code:'credential_scope_rejected'});
 for(const header of ['proxy-authorization','x-gateway-token','sd-authorization'])
  assert.throws(()=>checkedHeaders({[header]:'private-credential'},p,url,'GET'),{code:'headers_rejected'});
});
test('JioMart observed anonymous bootstrap keeps each endpoint, version, method and query boundary',()=>{
 const p=profiles['fixture.jiomart'],origin='https://source28.example',prefix='/api/service/application';
 const paths=[
  '/configuration/v1.0/application','/content/v1.0/data-loader','/content/v1.0/tags','/content/v1.0/navigations',
  '/cart/v1.0/basic','/user/authentication/v1.0/session',
  '/catalog/v2.0/products/voltas-ac-7624203/sizes','/theme/v2.0/0123456789abcdef01234567/preview',
 ];
 const headers={authorization:'Bearer anonymous-source-guest'};
 for(const path of paths){
  const url=origin+prefix+path;
  assert.equal(checkedHeaders(headers,p,new URL(url),'GET').authorization,headers.authorization);
  for(const raw of [url+'?x=1',url+'?page_size=10',url+'/',url+'/other',url.replace('/v1.0/','/v1x0/').replace('/v2.0/','/v2x0/'),url.replace('source28.example','source16.example')])
   assert.throws(()=>checkedHeaders(headers,p,new URL(raw),'GET'),{code:'credential_scope_rejected'});
  for(const method of ['HEAD','POST','OPTIONS'])assert.throws(()=>checkedHeaders(headers,p,new URL(url),method),{code:'credential_scope_rejected'});
 }
 const rejected=[
  '/configuration/v1.0/other','/content/v1.0/pages','/cart/v1.0/coupon','/cart/v1.0/detail',
  '/user/authentication/v1.0/login','/catalog/v2.0/products/voltas_ac/sizes',
  '/catalog/v2.0/products/voltas--ac/sizes','/catalog/v2.0/products/voltas%2Fac/sizes',
  '/catalog/v2.0/products/voltas/ac/sizes','/catalog/v2.0/products/voltas-ac/sizes/',
  '/theme/v2.0/0123456789abcdef0123456/preview','/theme/v2.0/0123456789abcdef012345678/preview',
  '/theme/v2.0/0123456789abcdef0123456g/preview',
  '/promotions/v1.0/available-promotions?page_size=10&slug=voltas-ac-7624203',
  '/cart/v1.0/coupon?slug=voltas-ac','/cart/v1.0/detail?b=false&i=true',
  '/content/v2.0/pages?page_size=10&tags=home',
 ];
 for(const path of rejected)assert.throws(()=>checkedHeaders(headers,p,new URL(origin+prefix+path),'GET'),{code:'credential_scope_rejected'});
});
test('JioMart observed query reads retain exact ordered parameters and bounded product slugs',()=>{
 const p=profiles['fixture.jiomart'],origin='https://source28.example/api/service/application',headers={authorization:'Bearer anonymous-source-guest'};
 const paths=[
  '/promotion/v1.0/available-promotions?page_size=50&slug=voltas-ac-7624203',
  '/cart/v1.0/coupon?slug=voltas-ac-7624203','/cart/v1.0/detail?b=true&i=true',
  '/content/v2.0/pages?page_size=50&tags=bankoffers,bankoffer',
  '/content/v2.0/pages?page_size=50&tags=bankoffers%2Cbankoffer',
  '/content/v2.0/pages?page_size=50&tags=bankoffers%2cbankoffer',
  '/cart/v1.0/address?checkout_mode=self',
 ];
 for(const path of paths){
  const url=origin+path;
  assert.equal(checkedHeaders(headers,p,new URL(url),'GET').authorization,headers.authorization);
  for(const raw of [url.split('?')[0],url+'&extra=true',url+'&'+url.split('?')[1],url.replace('source28.example','source16.example')])
   assert.throws(()=>checkedHeaders(headers,p,new URL(raw),'GET'),{code:'credential_scope_rejected'});
  for(const method of ['POST','HEAD','OPTIONS'])assert.throws(()=>checkedHeaders(headers,p,new URL(url),method),{code:'credential_scope_rejected'});
 }
 const rejected=[
  '/promotion/v1.0/available-promotions?slug=voltas-ac-7624203&page_size=50',
  '/promotion/v1.0/available-promotions?page_size=10&slug=voltas-ac-7624203',
  '/promotion/v1.0/available-promotions?page_size=050&slug=voltas-ac-7624203',
  '/promotions/v1.0/available-promotions?page_size=50&slug=voltas-ac-7624203',
  '/cart/v1.0/detail?i=true&b=true','/cart/v1.0/detail?b=true&i=false',
  '/cart/v1.0/detail?b=1&i=1','/cart/v1.0/address?checkout_mode=other',
  '/content/v2.0/pages?tags=bankoffers,bankoffer&page_size=50',
  '/content/v2.0/pages?page_size=50&tags=bankoffer,bankoffers',
  '/content/v2.0/pages?page_size=50&tags=bankoffers%252Cbankoffer',
  '/content/v2.0/pages?page_size=50&tags=bankoffers+bankoffer',
  '/content/v2.0/pages?page_size=50&tags=bankoffers,other',
 ];
 for(const slug of ['voltas','voltas-0','voltas-07624203','Voltas-7624203','voltas%2D7624203','voltas%2Fac-7624203','a'.repeat(301)+'-7624203','voltas-'+'1'.repeat(21)]){
  rejected.push('/promotion/v1.0/available-promotions?page_size=50&slug='+slug,'/cart/v1.0/coupon?slug='+slug,
   '/catalog/v2.0/products/'+slug+'/sizes');
 }
 for(const path of rejected)assert.throws(()=>checkedHeaders(headers,p,new URL(origin+path),'GET'),{code:'credential_scope_rejected'});
});
test('encrypted artifact tampering fails; original cookies remain separate and decoded-body headers safe',()=>{
 const seal=new Sealer('21'.repeat(32)),secret={cookie:'private',body:'source'};
 const encrypted=seal.seal(secret);assert.ok(!encrypted.includes(Buffer.from('private')));assert.deepEqual(seal.open(encrypted),secret);
 encrypted[20]^=1;assert.throws(()=>seal.open(encrypted));
 const result=sourceHeaders([['set-cookie','a=1; Path=/'],['set-cookie','b=2; Path=/'],['content-encoding','gzip'],['content-length','12'],['content-type','text/html']]);
 assert.deepEqual(result.cookies,['a=1; Path=/','b=2; Path=/']);assert.deepEqual(result.headers,{'content-type':'text/html'});
});
test('native method and body ceilings reject unsafe input before a dispatch',()=>{
 const p=profiles['fixture.croma.api'];
 assert.throws(()=>requestInput({idempotency_key:'x',url:'https://source31.example/',method:'DELETE'},p));
 assert.throws(()=>requestInput({idempotency_key:'x',url:'https://source31.example/',body_base64:'YWJj'},p));
});
test('reflected provider credentials never enter client response bodies, cookies or headers',async()=>{
 const {redactProviderSecrets}=await import('../src/transport.mjs');
 const source={status:200,headers:{},cookies:[],body:Buffer.from('source'),credits:1};
 assert.equal(redactProviderSecrets(source,['private-provider-token']),source);
 for(const response of [{...source,body:Buffer.from('private-provider-token')},{...source,headers:{echo:'private-provider-token'}},{...source,cookies:['sid=private-provider-token']}]){
  const clean=redactProviderSecrets(response,['private-provider-token']);
  assert.equal(clean.error,'sensitive_provider_response');assert.equal(clean.credits,1);
  assert.equal(clean.body.length,0);assert.deepEqual(clean.headers,{});assert.deepEqual(clean.cookies,[]);
 }
});
