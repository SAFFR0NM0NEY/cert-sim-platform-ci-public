import {defineConfig} from '@playwright/test';
import base from './playwright.config.js';
export default defineConfig({
  ...base, testMatch: /serverplus-registration\.spec\.js/,
  projects: [
    {name:'hidden',use:{...base.use,baseURL:'http://127.0.0.1:4177'}},
    {name:'draft',use:{...base.use,baseURL:'http://127.0.0.1:4178'}},
  ],
  webServer:[false,true].map((draft,i)=>({
    command:`npx vite --host 127.0.0.1 --port ${4177+i}`,
    url:`http://127.0.0.1:${4177+i}/exams`,reuseExistingServer:false,
    env:{NODE_ENV:'production',VITE_ENABLE_DRAFT_EXAMS:String(draft)},timeout:120000,
  })),
});
