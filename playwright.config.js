import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/r3g',
  testMatch: /.*\.spec\.js/,
  testIgnore: [/app-(?:assigned-network|hidden-assignment-launch|python-next-generation-access|sc100-access|inf301-access)\.spec\.js/, /variable-python\.spec\.js/, /response-admissibility\.spec\.js/, /practice-matching\.spec\.js/, /mixed-variable\.spec\.js/, /compact-combined\.spec\.js/],
  timeout: 120_000,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:4177', browserName: 'chromium', headless: true, ...(process.platform === 'win32' ? { channel: 'chrome' } : {}), viewport: { width: 1440, height: 1000 } },
  webServer: { env: { NODE_ENV: 'production', VITE_ENABLE_DRAFT_EXAMS: 'false' }, command: 'npx vite --host 127.0.0.1 --port 4177', url: 'http://127.0.0.1:4177/tests/r3g/protected-harness.html', reuseExistingServer: false, timeout: 120_000 },
});
