import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyProtection,protectionView,observeProtection} from '../src/protection.mjs';

const document={main_document:true,url:'https://source.example/record'};
const html=(body,status=200,headers={})=>({status,headers:{'content-type':'text/html',...headers},body:Buffer.from(body)});
const classify=(response,input=document)=>classifyProtection(response,input);

test('explicit source challenge headers work even without HTML, including API responses',()=>{
 for(const [headers,status,vendor] of [
  [{'CF-Mitigated':'challenge','CF-Ray':'secret-ray'},403,'cloudflare'],
  [{'x-amzn-waf-action':'challenge'},202,'aws_waf'],
  [{'x-amzn-waf-action':'captcha'},405,'aws_waf'],
 ]){
  const found=classify({status,headers});
  assert.equal(found.kind,'challenge');assert.equal(found.vendor,vendor);assert.equal(found.confidence,'explicit');
  assert.ok(!JSON.stringify(found).includes('secret-ray'));
 }
});

test('Cloudflare edge and cookies establish presence, not block ownership or cause',()=>{
 for(const status of [200,403,404,429,503]){
  const found=classify({status,headers:{server:'cloudflare','cf-ray':'private'},cookies:['__cf_bm=secret; Secure','cf_clearance=private; Secure']});
  assert.equal(found.vendor,'unknown');assert.equal(found.presence[0].vendor,'cloudflare');
  assert.equal(found.kind,({200:'no_block_observed',403:'access_denied',404:'source_unavailable',429:'rate_limited',503:'upstream_error'})[status]);
 }
});

test('CF challenge markup works on HTML returned by a JSON endpoint; title alone stays unknown',()=>{
 const body='<title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1"></script>';
 const found=classify(html(body,403),{resource_type:'fetch'});
 assert.equal(found.vendor,'cloudflare');assert.equal(found.kind,'challenge');assert.equal(found.confidence,'corroborated');
 assert.equal(classify(html(body,403,{'cf-mitigated':'challenge'})).confidence,'explicit','weaker corroboration must not downgrade explicit evidence');
 assert.equal(classify(html('<title>Just a moment...</title>',403)).vendor,'unknown');
 const inline="<script>window._cf_chl_opt={}; const a=document.createElement('script');a.src='/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1';</script>";
 assert.equal(classify(html('<title>Just a moment...</title>'+inline,403)).vendor,'cloudflare');
 assert.equal(classify(html('<title>Product</title>'+inline)).kind,'no_block_observed');
 assert.equal(classify(html('<title>Security check | Bayut</title>',503)).kind,'challenge');
 assert.equal(classify(html('<title>Security check | Bayut</title>',503)).vendor,'unknown');
 assert.equal(classify(html('<title>Product</title><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>')).kind,'no_block_observed');
});

test('DataDome iframe evidence must match an actual hostname and denial context',()=>{
 const body='<iframe src="https://geo.captcha-delivery.com/captcha/?secret=private"></iframe>';
 assert.equal(classify(html(body,403)).vendor,'datadome');
 assert.equal(classify(html(body,200)).kind,'no_block_observed');
 for(const fake of ['geo.captcha-delivery.com.evil.example','evil.example/path/captcha-delivery.com']){
  assert.equal(classify(html(`<iframe src="https://${fake}/captcha/"></iframe>`,403)).vendor,'unknown');
 }
 assert.equal(classify(html('<p>Visit https://geo.captcha-delivery.com</p>',403)).vendor,'unknown');
 const cookie=classify({...html('<title>Listing</title>'),cookies:['datadome=secret; Path=/']});
 assert.equal(cookie.kind,'no_block_observed');assert.equal(cookie.vendor,'unknown');assert.equal(cookie.presence[0].vendor,'datadome');
 assert.equal(classify({status:200,headers:{'Set-Cookie':['datadome=private; Secure']}}).presence[0].vendor,'datadome');
});

test('HUMAN challenge context is distinct from an ordinary session cookie',()=>{
 assert.equal(classify(html('<script src="https://captcha.px-cdn.net/app/captcha.js"></script>',403)).vendor,'human');
 const found=classify({...html('<title>Product</title>'),cookies:['_px3=private; Secure']});
 assert.equal(found.kind,'no_block_observed');assert.equal(found.vendor,'unknown');assert.equal(found.presence[0].vendor,'human');
});

test('CAPTCHA widgets on a login or product page are not inferred to block collection',()=>{
 const found=classify(html(`<title>Login</title>
 <script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>
 <script src="https://www.google.com/recaptcha/api.js"></script>
 <script src="https://js.hcaptcha.com/1/api.js"></script>`));
 assert.deepEqual(found.widgets,['turnstile','recaptcha','hcaptcha']);assert.equal(found.kind,'no_block_observed');assert.equal(found.vendor,'unknown');
});

test('source 429 and 401 take priority over a challenge; a response is not an IP ban',()=>{
 const headers={'cf-mitigated':'challenge'};
 const limited=classify({status:429,headers});
 assert.equal(limited.kind,'rate_limited');assert.equal(limited.vendor,'unknown');assert.deepEqual(limited.playbooks,['honor_source_cooldown']);
 assert.equal(classify({status:401,headers}).kind,'authentication_required');
 assert.equal(classify({status:403,headers:{}}).vendor,'unknown');
});

test('provider failures cannot be misattributed to the source, even with vendor-looking content',()=>{
 for(const error of ['provider_unattested','provider_account_rejected','provider_body_incomplete','sensitive_provider_response','cost_overrun']){
  const found=classify({...html('<title>Just a moment...</title>',403,{'cf-mitigated':'challenge'}),error});
  assert.equal(found.layer,'provider');assert.equal(found.vendor,'unknown');assert.deepEqual(found.presence,[]);assert.equal(found.body_bytes,0);
 }
 const unknownReceipt=classify({...html('data',200),error:'metered_outcome_unknown'});
 assert.equal(unknownReceipt.kind,'no_block_observed','source access and unknown billing remain independent');
 assert.equal(classify({error:'request_timeout',status:null}).layer,'transport');
});

test('conflicting vendor challenge evidence is retained without guessing an owner',()=>{
 const found=classify(html('<iframe src="https://geo.captcha-delivery.com/captcha/"></iframe>',403,{'cf-mitigated':'challenge'}));
 assert.equal(found.kind,'challenge');assert.equal(found.vendor,'unknown');
 assert.deepEqual(found.presence.map(p=>p.vendor),['cloudflare','datadome']);
});

test('Amazon CAPTCHA form classification is restricted to the Amazon source',()=>{
 const body=html('<form action="/errors/validateCaptcha"></form>');
 assert.equal(classify(body,{...document,url:'https://www.amazon.in/dp/test'}).vendor,'amazon');
 assert.equal(classify(body).vendor,'unknown');
});

test('bounded inspection ignores binary assets, non-HTML bodies, escaped samples and comments',()=>{
 const body='<title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/h/g"></script>';
 for(const input of [{resource_type:'image'},{}])assert.equal(classify(html(body),input).kind,'no_block_observed');
 assert.equal(classify(html(body,200,{'content-type':'application/json'})).kind,'no_block_observed');
 for(const sample of [`<!--${body}-->`,`<pre>${body}</pre>`,`<code>${body}</code>`])assert.equal(classify(html(sample)).kind,'no_block_observed');
 const found=classify(html(' '.repeat(65536)+body));
 assert.equal(found.body_bytes,65536);assert.equal(found.truncated,true);assert.equal(found.kind,'no_block_observed');
});

test('classification and persisted projection never emit source values, cookies, URLs or arbitrary fields',()=>{
 const found=classify({...html('<title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/h/g?token=PRIVATE"></script>',403,{'cf-mitigated':'challenge','authorization':'PRIVATE'}),cookies:['cf_clearance=PRIVATE']});
 assert.equal(JSON.stringify(found).includes('PRIVATE'),false);
 assert.deepEqual(protectionView(found),found);
 const dirty=protectionView({...found,vendor:'PRIVATE',kind:'PRIVATE',layer:'PRIVATE',confidence:'PRIVATE',presence:[{vendor:'cloudflare',confidence:'indicative',secret:'PRIVATE'},{vendor:'PRIVATE'}],signals:['PRIVATE',...found.signals],widgets:['PRIVATE'],playbooks:['PRIVATE'],body:'PRIVATE'});
 assert.equal(JSON.stringify(dirty).includes('PRIVATE'),false);
 assert.equal(protectionView(null),null);assert.equal(protectionView({version:'future'}),null);
});

test('observation storage failure is nonblocking, emits a safe event, and does not mutate the source response',async()=>{
 const response=html('safe');const before=structuredClone(response);const events=[];
 const write=process.stderr.write;process.stderr.write=value=>{events.push(value);return true;};
 try{
  assert.equal(await observeProtection({tx:async()=>{throw Error('private database details');}},{attemptId:'test-attempt',response,input:document}),null);
 }finally{process.stderr.write=write;}
 assert.equal(response.body.toString(),Buffer.from(before.body).toString());assert.equal(response.status,200);
 assert.deepEqual(JSON.parse(events[0]),{event:'protection_observation_failed',attempt:'test-attempt'});
});
