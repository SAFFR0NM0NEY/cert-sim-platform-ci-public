import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/r3g',
  testMatch: /app-(?:assigned-network|hidden-assignment-launch)\.spec\.js/,
  timeout: 120_000,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:4178', browserName: 'chromium', headless: true, viewport: { width: 1440, height: 1000 } },
  webServer: {
    command: 'npx vite --host 127.0.0.1 --port 4178',
    env: {
      VITE_SUPABASE_URL: 'http://127.0.0.1:4178/api',
      VITE_SUPABASE_ANON_KEY: 'fixture-public-anon-key',
      VITE_CERTSIM_ENV: 'test',
    },
    url: 'http://127.0.0.1:4178',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
