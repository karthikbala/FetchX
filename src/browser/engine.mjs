// Camoufox, the one browser engine. A runtime is a pinned build (version and
// executable SHA-256) plus its pinned fingerprint model; nothing is downloaded
// at request time. The gateway and every worker must agree on the same pin.
import {createReadStream} from 'node:fs';
import {access, readFile, stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {isAbsolute, join} from 'node:path';
import {fail} from '../policy.mjs';

export const CAMOUFOX_PIN = Object.freeze({
  launcher: '0.5.9',
  playwright: '1.62.1',
  version: '158.0.1-beta.41',
  model: '6530b8322cdaa4ec042921c8d9a0369a0e6e0269ba636c01a7203e4a2f109936',
});
const MODEL_FILES = Object.freeze({
  'fingerprint-network.json.zst': 'e1b0a7e60837c347f4b7d5dad4a20c356d521e0593e1bf4a8be39ea1e6a41ac4',
  'values.dat.zst': '3da2cf0891a4a85ef6458f0fbdf9346acfcd04e5fd279a0ea22d7919e4eaf122',
  'values.json.zst': '294decde5b6a1a52ed53d50a894130fa5c58f7cc804b78198f5c33f55b3ba66f',
  'values.dat': '9ce7d16630e91654e73988f7d37e8c99987c09b9c779a7bb9dc7ad6355dcc2f0',
});

// The device persona. Camoufox ships this OS's fonts in its bundle and points
// fontconfig at them only, so the fonts a page can measure match the persona.
export const PERSONA_OS = 'windows';

export async function fileSha256(path) {
  const hash = createHash('sha256');
  for await (const part of createReadStream(path)) hash.update(part);
  return hash.digest('hex');
}

// The runtime the gateway expects, from config.browser.camoufox. Remote workers
// hold their own copy of the binary; the gateway only needs the pin.
export function browserRuntime(config) {
  const settings = config.browser?.camoufox;
  if (!settings) return {available: false, reason: 'browser_unavailable'};
  if (settings.version !== CAMOUFOX_PIN.version || !/^[a-f0-9]{64}$/.test(settings.sha256 ?? '')) {
    return {available: false, reason: 'browser_runtime_unqualified'};
  }
  return {available: true, runtime: {engine: 'camoufox', version: settings.version, sha256: settings.sha256,
    ...(settings.executablePath ? {executablePath: settings.executablePath, modelDir: settings.modelDir} : {})}};
}

// Checks a local install: pinned binary, version metadata and fingerprint model.
export async function verifyCamoufox(runtime) {
  if (!isAbsolute(runtime.executablePath ?? '') || !isAbsolute(runtime.modelDir ?? '')) fail('browser_runtime_unavailable', 503);
  try {
    await access(runtime.executablePath, constants.X_OK);
    if (!(await stat(runtime.executablePath)).isFile()) throw new Error('not a file');
  } catch {
    fail('browser_runtime_unavailable', 503);
  }
  if (await fileSha256(runtime.executablePath) !== runtime.sha256) fail('browser_build_mismatch', 503);
  try {
    if ((await readFile(join(runtime.modelDir, '.pinned-model'), 'utf8')).trim() !== CAMOUFOX_PIN.model) throw new Error('model');
    for (const [name, digest] of Object.entries(MODEL_FILES)) {
      if (await fileSha256(join(runtime.modelDir, name)) !== digest) throw new Error('model file');
    }
  } catch {
    fail('browser_model_unavailable', 503);
  }
  return runtime;
}

// Launch options for one capture. The relay is the only proxy; DNS, prefetch,
// HTTP/3, WebRTC and telemetry are off so nothing leaves around it. Timezone,
// position and locale are the exit IP's (see fetch/exit-geo.mjs), so the
// browser is where its IP says it is. `fingerprint` reuses a device identity
// (a kept session); without one Camoufox draws a fresh one.
export function camoufoxOptions(runtime, {relay, cacheDir, locale = 'en-US', timezone = 'America/New_York', geolocation = null,
  fingerprint = null}) {
  let proxy;
  try { proxy = new URL(relay); } catch { fail('browser_proxy_required', 503); }
  if (proxy.protocol !== 'http:' || proxy.hostname !== '127.0.0.1' || !proxy.port || proxy.username || proxy.pathname !== '/') {
    fail('browser_proxy_required', 503);
  }
  return {
    executable_path: runtime.executablePath,
    headless: true,
    geoip: false,
    block_webrtc: true,
    canvas_noise: true,
    humanize: true,
    os: PERSONA_OS,
    locale,
    config: {timezone, ...(geolocation ? {'geolocation:latitude': geolocation.latitude,
      'geolocation:longitude': geolocation.longitude, 'geolocation:accuracy': 100} : {})},
    ...(fingerprint ? {fingerprint, i_know_what_im_doing: true} : {}),
    proxy: {server: relay, bypass: ''},
    timeout: 20_000,
    exclude_addons: ['UBO'],
    env: {...process.env, HOME: cacheDir, CAMOUFOX_EXECUTABLE_PATH: runtime.executablePath,
      CAMOUFOX_FPGEN_DATA: runtime.modelDir, MOZ_CRASHREPORTER_DISABLE: '1', MOZ_DATA_REPORTING: '0'},
    firefox_user_prefs: {
      'network.proxy.failover_direct': false,
      'network.proxy.no_proxies_on': '',
      'network.proxy.allow_hijacking_localhost': true,
      'network.dns.disablePrefetch': true,
      'network.prefetch-next': false,
      'network.predictor.enabled': false,
      'network.http.speculative-parallel-limit': 0,
      'network.trr.mode': 5,
      'network.http.http3.enable': false,
      // Request interception needs the service-worker engine; private browsing
      // then removes the service-worker API from pages.
      'dom.serviceWorkers.enabled': true,
      'browser.privatebrowsing.autostart': true,
      'dom.serviceWorkers.privateBrowsing.enabled': false,
      'media.peerconnection.enabled': false,
      'app.update.auto': false,
      'app.update.enabled': false,
      'extensions.update.enabled': false,
      'toolkit.telemetry.enabled': false,
      'toolkit.telemetry.unified': false,
      'datareporting.healthreport.uploadEnabled': false,
      'datareporting.policy.dataSubmissionEnabled': false,
      'browser.safebrowsing.downloads.remote.enabled': false,
      'network.captive-portal-service.enabled': false,
      'network.connectivity-service.enabled': false,
    },
  };
}

// A fresh device identity for the persona, drawn from the pinned model the
// same way Camoufox draws one at launch, so it can be kept and reused.
export async function drawFingerprint() {
  const {ensureModel} = await import('fpgen-js');
  await ensureModel();
  const {generateFingerprint} = await import('camoufox/dist/fingerprints.js');
  return generateFingerprint({os: PERSONA_OS});
}

// Starts a Camoufox browser server (so the runner can kill its process group)
// and connects to it. Used only inside the worker process. Returns the device
// identity it used, so a session that passes can keep it.
export async function launchCamoufox(runtime, options) {
  await verifyCamoufox(runtime);
  process.env.CAMOUFOX_FPGEN_DATA = runtime.modelDir;
  const {setModelDir} = await import('fpgen-js');
  setModelDir(runtime.modelDir);
  let fingerprint = options.fingerprint ?? null;
  if (!fingerprint) {
    try { fingerprint = await drawFingerprint(); } catch { fingerprint = null; }
  }
  const {launchServer} = await import('camoufox');
  const server = await launchServer(camoufoxOptions(runtime, {...options, fingerprint}));
  const {firefox} = await import('playwright-core');
  const browser = await firefox.connect(server.wsEndpoint());
  return {server, browser, fingerprint};
}
