import {defineConfig} from 'vitest/config';
import {cloudflareTest, readD1Migrations} from '@cloudflare/vitest-plugin';

export default defineConfig({
 plugins: [cloudflareTest({
  remoteBindings: false,
  miniflare: {
   compatibilityDate: '2026-10-29',
   compatibilityFlags: ['nodejs_compat'],
   d1Databases: ['DB'],
   bindings: {TEST_MIGRATIONS: await readD1Migrations('./migrations')},
  },
 })],
 test: {include: ['tests/*.test.ts'], fileParallelism: false},
});
