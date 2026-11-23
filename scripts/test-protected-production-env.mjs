import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { validateProtectedProductionEnv } from './validate-protected-production-env.mjs';
import { readFileSync } from 'node:fs';

const base = { VITE_SUPABASE_URL: 'https://qngnoctsdhzcpagesvxz.supabase.co', VITE_SUPABASE_ANON_KEY: `sb_publishable_${'a'.repeat(24)}`, VITE_CERTSIM_ENV: 'production', VITE_CERTSIM_APP_URL: 'https://certsimplatform.com' };
const rejects = (patch) => assert.throws(() => validateProtectedProductionEnv({ ...base, ...patch }));
rejects({ VITE_SUPABASE_URL: '' });
rejects({ VITE_SUPABASE_ANON_KEY: '' });
rejects({ VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' });
rejects({ VITE_SUPABASE_URL: '   ', VITE_SUPABASE_ANON_KEY: '   ' });
rejects({ VITE_SUPABASE_URL: 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co' });
rejects({ VITE_SUPABASE_ANON_KEY: `sb_secret_${'x'.repeat(24)}` });
const payload = Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url');
rejects({ VITE_SUPABASE_ANON_KEY: `eyJ.${payload}.signature` });
assert.equal(validateProtectedProductionEnv(base).ok, true);
const marker = `sb_secret_${'DO_NOT_LOG_THIS_VALUE'.repeat(2)}`;
const failed = spawnSync(process.execPath, ['scripts/validate-protected-production-env.mjs'], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, ...base, VITE_SUPABASE_ANON_KEY: marker } });
assert.notEqual(failed.status, 0);
assert.doesNotMatch(`${failed.stdout}${failed.stderr}`, new RegExp(marker));
const generic = spawnSync(process.execPath, ['scripts/build-certsim-delivery-mode.mjs', 'protected'], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, VITE_CERTSIM_ENV: 'test', VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' } });
assert.equal(generic.status, 0, generic.stderr);
const deployWrapper = readFileSync('scripts/deploy-protected-production.mjs', 'utf8');
for (const contract of ['DEPLOY_PROTECTED_PRODUCTION', 'SAFFR0NM0NEY\\/cert-sim-platform', "rev-parse', '--abbrev-ref", "rev-parse', 'origin/main", "status', '--porcelain", '--check-only', 'validateProtectedProductionEnv', 'validate-protected-build-custody.mjs', 'pages', 'project', 'list', '--project-name=certsimplatform', '--commit-hash=']) {
  assert.ok(deployWrapper.includes(contract), `Missing local deployment control: ${contract}`);
}
console.log(JSON.stringify({ ok: true, negativeCases: 7, redaction: true, genericBuildPreserved: true }));
