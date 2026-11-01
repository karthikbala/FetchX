import test from 'node:test';
import assert from 'node:assert/strict';
import {server} from '../src/main.mjs';
import {sha} from '../src/crypto.mjs';
import {Script} from 'node:vm';

test('console exposes only static key-free assets while usage/operations remain authenticated and read-only',async()=>{
 const calls=[];
 const app=server({store:{},config:{projects:{a:{tokenHash:sha('console-test-secret')}}},v2:{usage:async project=>{calls.push(['usage',project]);return {project};},recentOperations:async project=>{calls.push(['recent',project]);return {operations:[]};}}});
 try{
  for(const path of ['/console','/console/','/console/app.css','/console/app.js']){
   const response=await app.inject(path);assert.equal(response.statusCode,200);assert.equal(response.headers['cache-control'],'no-store');assert.match(response.headers['content-security-policy'],/frame-ancestors 'none'/);assert.equal(response.headers['referrer-policy'],'no-referrer');assert.ok(!response.body.includes('console-test-secret'));
  }
  const html=(await app.inject('/console')).body;assert.match(html,/type="password"/);assert.match(html,/Read-only access/);
  const js=(await app.inject('/console/app.js')).body;assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie|innerHTML/.test(js));assert.match(js,/redirect:'error'/);assert.ok(!/method:\s*['"]POST/.test(js));
  assert.doesNotThrow(()=>new Script(js,{filename:'console/app.js'}));
  for(const path of ['/v2/usage','/v2/operations','/console/not-a-static-asset','/console/../v2/usage'])assert.equal((await app.inject(path)).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:'/console'})).statusCode,401);assert.deepEqual(calls,[]);
  const headers={authorization:'Bearer console-test-secret'};
  assert.equal((await app.inject({url:'/v2/usage',headers})).statusCode,200);assert.equal((await app.inject({url:'/v2/operations',headers})).statusCode,200);assert.deepEqual(calls,[['usage','a'],['recent','a']]);
 }finally{await app.close();}
});
