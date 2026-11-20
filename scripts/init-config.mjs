// Creates a private local platform setup: platform.json, one API token and
// database credentials. Nothing is sent anywhere. See docs/configuration.md.
//   node scripts/init-config.mjs [dir] [engine platform-link.json]
// The engine's scripts/init-config.mjs writes platform-link.json with the
// service token and event key; pass it here, or fill engine.* in by hand.
import {mkdir, writeFile, access, readFile} from 'node:fs/promises';
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
const link = process.argv[3] ? JSON.parse(await readFile(process.argv[3], 'utf8')).engine ?? {} : {};
for (const dir of [root, join(root, 'secrets')]) await mkdir(dir, {recursive: true, mode: 0o700});

const token = randomBytes(32).toString('hex');
const config = {
  release: 'fetchx-local',
  // Seals webhook secrets and queued webhook URLs (AES-256-GCM).
  sealingKey: randomBytes(32).toString('hex'),
  // The engine, on the private network fetchx-internal.
  engine: {url: 'http://engine:8790', serviceToken: link.serviceToken ?? '', eventKey: link.eventKey ?? ''},
  // Projects with a token here may call the API without credits (unmetered).
  projects: {local: {tokenHash: createHash('sha256').update(token).digest('hex')}},
};
await writeFile(join(root, 'secrets/platform.json'), JSON.stringify(config, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
await writeFile(join(root, 'secrets/client.token'), token + '\n', {mode: 0o600, flag: 'wx'});
await writeFile(join(root, 'compose.env'), `FETCHX_HOME='${root}'\nFETCHX_DB_PASSWORD=${randomBytes(24).toString('hex')}\n`, {mode: 0o600, flag: 'wx'});
console.log(`FetchX platform configuration created in ${join(root, 'secrets/platform.json')}.`);
if (!link.serviceToken) console.log('Set engine.serviceToken and engine.eventKey from the engine\'s platform-link.json.');
