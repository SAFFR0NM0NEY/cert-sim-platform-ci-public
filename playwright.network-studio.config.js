import { defineConfig } from "@playwright/test";
export default defineConfig({
  outputDir: "./test-results/network-studio",
  testDir: "./tests/network-studio",
  timeout: 60000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4189",
    browserName: "chromium",
    headless: true,
    ...(process.platform === "win32" ? { channel: "chrome" } : {}),
    viewport: { width: 1440, height: 1100 },
  },
  webServer: [
    {
      command: "npx vite --host 127.0.0.1 --port 4189 --strictPort",
      url: "http://127.0.0.1:4189/network-studio.html",
      reuseExistingServer: false,
      timeout: 120000,
    },
    ...(process.env.CERTSIM_NATIVE_TESTS
      ? [
          {
            command:
              "python -B scripts/network-studio-native/serve.py --app network-studio.html",
            url: "http://127.0.0.1:42397/native/status",
            reuseExistingServer: !process.env.CI,
            timeout: 30000,
          },
        ]
      : []),
  ],
});
