import {defineConfig} from '@playwright/test';
export default defineConfig({
 testDir:'./tests/issue146',testMatch:'*.spec.js',workers:1,timeout:30000,
 use:{baseURL:'http://127.0.0.1:4196',browserName:'chromium',headless:true,...(process.platform==='win32'?{channel:'chrome'}:{})},
 webServer:{command:'npx vite --config tests/issue146/vite.config.js --host 127.0.0.1 --port 4196',url:'http://127.0.0.1:4196/tests/issue146/index.html',reuseExistingServer:false},
});
