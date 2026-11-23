import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateProtectedProductionEnv } from './validate-protected-production-env.mjs';

const mode = process.argv[2];
if (!['maintenance', 'protected'].includes(mode)) {
  console.error('Usage: node scripts/build-certsim-delivery-mode.mjs <maintenance|protected>');
  process.exit(2);
}

if (mode === 'protected' && process.env.VITE_CERTSIM_ENV === 'production') {
  validateProtectedProductionEnv(process.env);
}

const viteBin = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const result = spawnSync(process.execPath, [viteBin, 'build', '--outDir', `dist/${mode}`, '--emptyOutDir'], {
  cwd: process.cwd(),
  env: { ...process.env, VITE_CERTSIM_EXAM_DELIVERY_MODE: mode },
  encoding: 'utf8',
  stdio: 'inherit',
  shell: false,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
