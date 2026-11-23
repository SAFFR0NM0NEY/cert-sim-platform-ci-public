import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateProtectedProductionEnv } from './validate-protected-production-env.mjs';

const env = { ...process.env, VITE_CERTSIM_ENV: 'production', VITE_CERTSIM_APP_URL: 'https://certsimplatform.com' };
validateProtectedProductionEnv(env);
const builder = fileURLToPath(new URL('./build-certsim-delivery-mode.mjs', import.meta.url));
const result = spawnSync(process.execPath, [builder, 'protected'], { cwd: process.cwd(), env, stdio: 'inherit', shell: false });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
