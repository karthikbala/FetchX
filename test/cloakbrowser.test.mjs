import test from 'node:test';
import assert from 'node:assert/strict';
import {access,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {checkBrowserTier} from '../src/browser.mjs';
import {fileSha256,launchPinnedBrowser} from '../src/browser-engines.mjs';

const relay='http://127.0.0.1:19999',key='cb_fixture_only';
async function fixture(t){
 const env=['HOME','CLOAKBROWSER_BINARY_PATH','CLOAKBROWSER_AUTO_UPDATE','CLOAKBROWSER_LICENSE_KEY','CLOAKBROWSER_CACHE_DIR','CLOAKBROWSER_LICENSE_STATUS_FILE'];
 const original=Object.fromEntries(env.map(name=>[name,process.env[name]]));
 const root=await mkdtemp(join(tmpdir(),'fetchx-cloak-fixture-')),executablePath=join(root,'chromium');
 t.after(async()=>{for(const name of env)if(original[name]===undefined)delete process.env[name];else process.env[name]=original[name];await rm(root,{recursive:true,force:true});});
 process.env.HOME=root;process.env.CLOAKBROWSER_LICENSE_KEY='cb_unrelated_fixture';
 // A non-networked process records what Playwright actually passes to the
 // executable and simulates a native license denial. It never starts Chromium.
 await writeFile(executablePath,'#!/bin/sh\nprintf "%s\\n" "$CLOAKBROWSER_LICENSE_KEY" "$@" > "$0.argv"\nexit 77\n',{mode:0o700});
 return {root,receipt:executablePath+'.argv',tier:{executablePath,version:'156.0.8078.47.1',sha256:await fileSha256(executablePath),entitlement:'licensed'}};
}

test('current free license is validated as a licensed v1 tier without making it eligible for paid routes',async t=>{
 const {tier}=await fixture(t),licensed={...tier,licenseKey:` ${key} `},config={browser:{free:licensed,paid:licensed}};
 const fetchImpl=async(url,options)=>{
  assert.equal(url,'https://cloakbrowser.dev/api/license/validate');assert.equal(options.redirect,'error');
  assert.deepEqual(JSON.parse(options.body),{license_key:key});
  return {ok:true,json:async()=>({valid:true,plan:'free'})};
 };
 assert.equal(await checkBrowserTier(config,'free',{fetchImpl}),licensed);
 await assert.rejects(checkBrowserTier(config,'paid',{fetchImpl}),{code:'browser_paid_subscription_required'});
});

test('missing explicit current key, wrong pin and non-local proxy fail before the SDK can launch or seek a key',async t=>{
 const {root,receipt,tier}=await fixture(t);
 const network=t.mock.method(globalThis,'fetch',async()=>{throw Error('unexpected vendor request');});
 await assert.rejects(checkBrowserTier({browser:{free:tier}},'free'),{code:'browser_entitlement_unavailable'});
 await assert.rejects(launchPinnedBrowser({...tier,licenseKey:'  '},{},relay,root),{code:'browser_entitlement_unavailable'});
 const licensed={...tier,licenseKey:key};
 await assert.rejects(launchPinnedBrowser({...licensed,sha256:'0'.repeat(64)},{},relay,root),{code:'browser_build_mismatch'});
 await assert.rejects(launchPinnedBrowser(licensed,{},'http://proxy.invalid:8888',root),{code:'browser_proxy_required'});
 await assert.rejects(access(receipt),{code:'ENOENT'});
 assert.equal(network.mock.callCount(),0);
});

test('pinned current and keyless v146 launch with a sandbox and the intended relay and license settings',async t=>{
 const {root,receipt,tier}=await fixture(t);
 const network=t.mock.method(globalThis,'fetch',async()=>{throw Error('unexpected vendor request');});
 const legacy={...tier,version:'146.0.7680.177.5',entitlement:'unlicensed',licenseKey:'cb_unrelated_fixture'};
 assert.equal(await checkBrowserTier({browser:{free:legacy}},'free'),legacy);
 for(const [candidate,expectedKey] of [[{...tier,licenseKey:key},key],[legacy,'']]){
  await assert.rejects(launchPinnedBrowser(candidate,{},relay,root),{name:'CloakBrowserLicenseError'});
  const [actualKey,...args]=(await readFile(receipt,'utf8')).trimEnd().split('\n');
  assert.equal(actualKey,expectedKey);
  assert.ok(args.includes(`--proxy-server=${relay}`));
  assert.ok(args.includes('--proxy-bypass-list=<-loopback>'));
  assert.ok(args.includes('--license-through-proxy'));
  assert.equal(args.includes('--license-route=proxy'),Boolean(expectedKey));
  assert.equal(args.includes('--start-maximized'),Boolean(expectedKey));
  const expectedPlatform=expectedKey&&process.platform==='darwin'?'macos':'linux';
  assert.equal(args.findLast(arg=>arg.startsWith('--fingerprint-platform=')),`--fingerprint-platform=${expectedPlatform}`);
  assert.ok(args.some(arg=>/^--fingerprint=\d+$/.test(arg)));
  assert.ok(!args.some(arg=>/^--no-sandbox(?:=|$)/.test(arg)));
  await rm(receipt);
 }
 assert.equal(network.mock.callCount(),0);
});
