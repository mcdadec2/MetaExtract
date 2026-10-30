import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  // Each test launches its own browser with the extension; keep it simple.
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
});
