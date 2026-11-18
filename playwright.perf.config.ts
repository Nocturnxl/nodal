import { defineConfig } from '@playwright/test';

// Performance measurements, run on demand with `npm run perf:ui`.
export default defineConfig({
  testDir: 'tests/perf',
  testMatch: '**/*.spec.ts',
  timeout: 300_000,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results',
});
