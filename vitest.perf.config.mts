import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Database timings, run on demand with `npm run perf:db`.
export default defineConfig({
  resolve: { alias: { '@shared': resolve(import.meta.dirname, 'src/shared') } },
  test: { include: ['tests/perf/**/*.perf.test.ts'], environment: 'node', testTimeout: 300_000 },
});
