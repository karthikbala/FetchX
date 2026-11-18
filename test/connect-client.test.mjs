import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { connectFetchX } from '../clients/connect.mjs';

const requestId = '10000000-0000-4000-8000-000000000001';
const keyId = '10000000-0000-4000-8000-000000000002';
const projectId = 'cp_10000000-0000-4000-8000-000000000003';
const deviceCode = 'A'.repeat(43);
const userCode = 'A234-BC56';
const proof = { request_id: requestId, device_code: deviceCode };
const expectedToken = 'fxk_' + createHash('sha256')
  .update('fetchx-connect-key-v1').update(Buffer.from([0])).update(deviceCode).digest('base64url');

function startResponse(origin, overrides) {
  return {
    ...proof,
    user_code: userCode,
    verification_uri: `${origin}/connect#${requestId}`,
    expires_in: 30,
    interval: 1,
    ...overrides,
  };
}

function connected(apiOrigin) {
  return { state: 'connected', key_id: keyId, project_id: projectId, api_base_url: apiOrigin };
}

function json(response, data, status = 200, headers) {
  response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  response.end(JSON.stringify(data));
}

async function fixture(t, respond) {
  let origin;
  const calls = [];
  const errors = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const call = {
        path: request.url,
        method: request.method,
        headers: request.headers,
        body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null,
        at: performance.now(),
      };
      calls.push(call);
      respond(response, call, origin, calls);
    } catch (error) {
      errors.push(error);
      response.destroy();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    assert.deepEqual(errors, []);
  });
  return { origin, calls };
}

const startPath = '/api/control/connect/start';
const claimPath = '/api/control/connect/claim';

test('Connect respects polling and Retry-After, and recovers a lost claim with its original proof', async t => {
  const { origin, calls } = await fixture(t, (response, call, site, history) => {
    if (call.path === startPath) return json(response, startResponse(site));
    assert.equal(call.path, claimPath);
    if (history.length === 2) return json(response, { state: 'pending' });
    if (history.length === 3) return json(response, { error: { code: 'connect_slow_down' } }, 429, { 'Retry-After': '7' });
    if (history.length === 4) return response.destroy();
    return json(response, connected(site));
  });
  const approvals = [];
  const credential = await connectFetchX({
    origin,
    clientName: 'Synthetic client',
    onApproval: details => approvals.push(details),
  });
  assert.deepEqual(approvals, [{ verificationUri: `${origin}/connect#${requestId}`, userCode }]);
  assert.deepEqual(credential, { token: expectedToken, apiBaseUrl: origin, projectId, keyId });
  assert.deepEqual(calls.map(call => call.path), [startPath, claimPath, claimPath, claimPath, claimPath]);
  assert.deepEqual(calls[0].body, { client_name: 'Synthetic client' });
  assert.deepEqual(calls.slice(1).map(call => call.body), [proof, proof, proof, proof]);
  for (const call of calls) {
    assert.equal(call.method, 'POST');
    assert.equal(call.headers.origin, undefined);
    assert.equal(call.headers['sec-fetch-site'], undefined);
    assert.equal(call.headers.cookie, undefined);
    assert.equal(call.headers.authorization, undefined);
  }
  assert.ok(calls[1].at - calls[0].at >= 950);
  assert.ok(calls[2].at - calls[1].at >= 950);
  assert.ok(calls[3].at - calls[2].at >= 6950);
  assert.ok(calls[4].at - calls[3].at >= 5950);
});

test('Connect rejects a verification link that differs from its exact site and request', async t => {
  const { origin, calls } = await fixture(t, (response, call, site) => {
    json(response, startResponse(site, { verification_uri: `https://unexpected.example/connect#${requestId}` }));
  });
  await assert.rejects(connectFetchX({ origin, onApproval: () => assert.fail('Displayed an unverified link') }), {
    code: 'connect_invalid_response',
  });
  assert.deepEqual(calls.map(call => call.path), [startPath]);
});

test('Connect does not follow a claim redirect or send its proof to the redirect destination', async t => {
  const { origin, calls } = await fixture(t, (response, call, site) => {
    if (call.path === startPath) return json(response, startResponse(site));
    response.writeHead(307, { Location: `${site}/untrusted-redirect` });
    response.end();
  });
  await assert.rejects(connectFetchX({ origin, onApproval: () => {} }), { code: 'connect_redirect' });
  assert.deepEqual(calls.map(call => call.path), [startPath, claimPath]);
});

test('Connect rejects an unsafe or unexpected gateway origin', async t => {
  for (const [apiOrigin, code] of [
    ['http://gateway.example', 'connect_invalid_origin'],
    ['https://unexpected.example', 'connect_api_origin_mismatch'],
  ]) {
    await t.test(apiOrigin, async subtest => {
      const { origin } = await fixture(subtest, (response, call, site) => {
        json(response, call.path === startPath ? startResponse(site) : connected(apiOrigin));
      });
      await assert.rejects(connectFetchX({ origin, onApproval: () => {} }), { code });
    });
  }
});

test('Connect stops on denial or expiry and never restarts an uncertain start', async t => {
  for (const state of ['denied', 'expired']) {
    await t.test(state, async subtest => {
      const { origin, calls } = await fixture(subtest, (response, call, site) => {
        json(response, call.path === startPath ? startResponse(site) : { state });
      });
      await assert.rejects(connectFetchX({ origin, onApproval: () => {} }), { code: `connect_${state}` });
      assert.deepEqual(calls.map(call => call.path), [startPath, claimPath]);
    });
  }
  const { origin, calls } = await fixture(t, response => response.destroy());
  await assert.rejects(connectFetchX({ origin, onApproval: () => assert.fail('Displayed an unconfirmed start') }), {
    code: 'connect_network_error',
  });
  assert.deepEqual(calls.map(call => call.path), [startPath]);
});

test('Connect bounds a hanging claim by the approval deadline', async t => {
  const { origin, calls } = await fixture(t, (response, call, site) => {
    if (call.path === startPath) json(response, startResponse(site, { expires_in: 2 }));
  });
  await assert.rejects(connectFetchX({ origin, onApproval: () => {} }), { code: 'connect_expired' });
  assert.deepEqual(calls.map(call => call.path), [startPath, claimPath]);
});

test('Connect CLI exposes only approval details and gives the selected child its environment', async t => {
  const apiOrigin = 'http://127.0.0.1:65432';
  const { origin, calls } = await fixture(t, (response, call, site) => {
    json(response, call.path === startPath ? startResponse(site) : connected(apiOrigin));
  });
  const argument = 'text with shell syntax ; &&';
  const childSource = `
    import { createHash } from 'node:crypto';
    const token = process.env.FETCHX_TOKEN;
    if (!token || process.argv.includes(token) || process.argv[2] !== process.env.FETCHX_URL) process.exit(64);
    process.stdout.write(createHash('sha256').update(token).digest('hex') + '\\n' + process.argv[1]);
    process.exitCode = 17;
  `;
  const child = spawn(process.execPath, [
    fileURLToPath(new URL('../clients/connect.mjs', import.meta.url)),
    '--origin', origin, '--api-origin', apiOrigin, '--client-name', 'Synthetic child', '--',
    process.execPath, '--input-type=module', '-e', childSource, argument, apiOrigin,
  ]);
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    child.once('close', resolve);
    child.once('error', reject);
  });
  assert.equal(exitCode, 17);
  assert.equal(stdout, createHash('sha256').update(expectedToken).digest('hex') + '\n' + argument);
  assert.equal(stderr, `Open ${origin}/connect#${requestId}\nFetchX code: ${userCode}\n`);
  assert.deepEqual(calls[0].body, { client_name: 'Synthetic child' });
  assert.equal((stdout + stderr).includes(expectedToken), false);
  assert.equal((stdout + stderr).includes(deviceCode), false);
});
