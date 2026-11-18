import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Live provider smoke tests. Not part of `npm test`: they need a real key in
// the environment and spend a small number of tokens.
export default defineConfig({
  resolve: { alias: { '@shared': resolve(import.meta.dirname, 'src/shared') } },
  test: {
    include: ['tests/live/**/*.live.test.ts'],
    environment: 'node',
    testTimeout: 180_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
