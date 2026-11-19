// The browser worker process: one capture, one fresh Camoufox, then exit.
// Spawned by runner.mjs with the capture input on stdin; talks to the gateway
// only through IPC (admit, artifact, captcha) and prints a small JSON summary.
import {launchCamoufox} from './engine.mjs';
import {capturePage} from './capture.mjs';
import {OUTPUT_LIMIT} from './wire.mjs';

let input;
let next = 0;
const pending = new Map();
const abort = () => process.exit(1);
process.once('SIGUSR2', abort);
process.once('disconnect', abort);
process.on('message', message => {
  const task = pending.get(message?.id);
  if (!task) return;
  pending.delete(message.id);
  clearTimeout(task.timer);
  if (message.error) task.reject(Object.assign(new Error(message.error), {code: message.error}));
  else task.resolve(message.result);
});

function rpc(kind, data) {
  return new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Object.assign(new Error('ipc'), {code: 'browser_ipc_timeout'}));
    }, Math.max(1, input.deadline - Date.now()));
    pending.set(id, {resolve, reject, timer});
    process.send({id, kind, data}, error => {
      if (!error) return;
      clearTimeout(timer);
      pending.delete(id);
      reject(Object.assign(new Error('ipc'), {code: 'browser_ipc_failed'}));
    });
  });
}

let server;
let browser;
let output;
try {
  input = await new Promise((resolve, reject) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', part => {
      raw += part;
      if (raw.length > OUTPUT_LIMIT) reject(new Error('input too large'));
    });
    process.stdin.on('end', () => {
      try { resolve(JSON.parse(raw)); } catch (error) { reject(error); }
    });
  });
  for (const method of ['log', 'warn', 'info', 'debug', 'error']) console[method] = () => {};
  // The pinned model is installed already; never download at request time.
  globalThis.fetch = async () => { throw Object.assign(new Error('offline'), {code: 'browser_download_disabled'}); };
  ({server, browser} = await launchCamoufox(input.runtime, {relay: input.relay, cacheDir: input.cache_dir,
    locale: input.locale, timezone: input.timezone}));
  await rpc('browser_started', {pid: server.process().pid});
  output = await capturePage(browser, input, {
    admit: data => rpc('admit', data),
    artifact: data => rpc('artifact', data),
    captcha: data => rpc('captcha', data),
  });
} catch (error) {
  output = {error: ['browser_build_mismatch', 'browser_model_unavailable', 'browser_runtime_unavailable'].includes(error.code)
    ? error.code : 'browser_interrupted', status: null, requests: 0, blocked: 0, captcha: [], cookies: []};
} finally {
  await browser?.close().catch(() => {});
  const pid = server?.process().pid;
  if (server) {
    try {
      await server.close();
      await rpc('browser_stopped', {pid});
    } catch { /* already gone */ }
  }
  for (const task of pending.values()) clearTimeout(task.timer);
}
process.stdout.write(JSON.stringify(output), () => {
  process.off('disconnect', abort);
  if (process.connected) process.disconnect();
});
