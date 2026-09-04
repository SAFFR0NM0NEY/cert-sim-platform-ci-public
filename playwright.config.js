import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/r3g',
  testMatch: /.*\.spec\.js/,
  testIgnore: /app-assigned-network\.spec\.js/,
  timeout: 120_000,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:4177', browserName: 'chromium', headless: true, viewport: { width: 1440, height: 1000 } },
  webServer: { command: 'npx vite --host 127.0.0.1 --port 4177', url: 'http://127.0.0.1:4177/tests/r3g/protected-harness.html', reuseExistingServer: false, timeout: 120_000 },
});
