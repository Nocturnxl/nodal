import { defineConfig } from '@playwright/test';

// End-to-end tests drive the built app (run `npm run bundle` first, or use
// `npm run e2e`) against the local mock provider. No real key is needed.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  outputDir: 'test-results',
});
