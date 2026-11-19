// Creates a private local setup: gateway.json, one API token and database
// credentials. Nothing is sent anywhere. See docs/configuration.md.
import {mkdir, writeFile, access, chmod} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {randomBytes, createHash} from 'node:crypto';

const root = resolve(process.argv[2] ?? 'local');
if (!/^[a-zA-Z0-9_./ -]+$/.test(root)) throw new Error('Use a setup path made of letters, digits, spaces, slashes, dots, underscores or hyphens.');
try {
  await access(root);
  throw new Error('The setup directory already exists; refusing to overwrite it.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
for (const dir of [root, join(root, 'secrets'), join(root, 'browser')]) await mkdir(dir, {recursive: true, mode: 0o700});
// The browser directory must be readable by the unprivileged service user.
await chmod(join(root, 'browser'), 0o755);

const token = randomBytes(32).toString('hex');
const residential = name => {
  const prefix = name.toUpperCase();
  const username = process.env[`${prefix}_USERNAME`] ?? '';
  const password = process.env[`${prefix}_PASSWORD`] ?? '';
  return {enabled: !!username && !!password, username, password};
};
const config = {
  release: 'fetchx-local',
  artifactKey: randomBytes(32).toString('hex'),
  // Projects with a token here may call the API without credits (unmetered).
  projects: {local: {tokenHash: createHash('sha256').update(token).digest('hex')}},
  // Datacenter proxies: [{id, country, provider: 'oxylabs', url}].
  proxies: [],
  residential: {providers: {evomi: residential('evomi'), dataimpulse: residential('dataimpulse')}},
  captcha: {enabled: false, apiKey: '', maxTaskMicroUsd: 3000, maxDailyMicroUsd: 1_000_000, maxTotalMicroUsd: 10_000_000,
    maxTotalTasks: 10_000, datadome: false},
  browser: {maxConcurrent: 1, camoufox: {version: '158.0.1-beta.41', sha256: '', executablePath: '', modelDir: ''}},
};
await writeFile(join(root, 'secrets/gateway.json'), JSON.stringify(config, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
await writeFile(join(root, 'secrets/client.token'), token + '\n', {mode: 0o600, flag: 'wx'});
await writeFile(join(root, 'compose.env'), `FETCHX_HOME='${root}'\nFETCHX_DB_PASSWORD=${randomBytes(24).toString('hex')}\n`, {mode: 0o600, flag: 'wx'});
console.log(`FetchX configuration created in ${join(root, 'secrets/gateway.json')}. Add proxy, captcha and browser settings there.`);
