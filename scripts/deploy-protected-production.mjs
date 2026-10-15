import { spawnSync } from 'node:child_process';
import { validateProtectedProductionEnv } from './validate-protected-production-env.mjs';

const args = new Map(process.argv.slice(2).map((arg) => { const [key, ...value] = arg.split('='); return [key, value.join('=')]; }));
const expectedSha = args.get('--expected-sha');
if (args.get('--confirm') !== 'DEPLOY_PROTECTED_PRODUCTION') throw new Error('Protected production confirmation is missing or invalid.');
if (!/^[0-9a-f]{40}$/.test(expectedSha ?? '')) throw new Error('An exact expected source SHA is required.');
validateProtectedProductionEnv({ ...process.env, VITE_CERTSIM_ENV: 'production', VITE_CERTSIM_APP_URL: 'https://certsimplatform.com' });
const run = (command, commandArgs, options = {}) => {
  const result = spawnSync(command, commandArgs, { cwd: process.cwd(), encoding: 'utf8', shell: false, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(options.failure ?? `${command} failed.`);
  return result.stdout?.trim() ?? '';
};
if (run('git', ['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') throw new Error('Local protected deployment requires branch main.');
if (!/^https:\/\/github\.com\/SAFFR0NM0NEY\/cert-sim-platform(?:\.git)?$/.test(run('git', ['remote', 'get-url', 'origin']))) {
  throw new Error('Local protected deployment requires the private CertSim repository.');
}
if (run('git', ['rev-parse', 'HEAD']) !== expectedSha) throw new Error('HEAD does not match the expected source SHA.');
run('git', ['fetch', '--no-tags', 'origin', 'main']);
if (run('git', ['rev-parse', 'origin/main']) !== expectedSha) throw new Error('origin/main does not match the expected source SHA.');
if (run('git', ['status', '--porcelain'])) throw new Error('Working tree is not clean.');
if (args.has('--check-only')) {
  console.log(JSON.stringify({ ok: true, checkOnly: true, project: 'certsimplatform', branch: 'main', sourceSha: expectedSha }));
  process.exit(0);
}
run(process.execPath, ['scripts/build-protected-production.mjs'], { stdio: 'inherit', failure: 'Protected production build failed.' });
run(process.execPath, ['scripts/validate-protected-build-custody.mjs', 'protected'], { stdio: 'inherit', failure: 'Custody validation failed.' });
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const shell = process.platform === 'win32';
run(npx, ['wrangler@4', 'whoami'], { shell, failure: 'Wrangler authentication check failed.' });
const projects = run(npx, ['wrangler@4', 'pages', 'project', 'list'], { shell, failure: 'Wrangler project lookup failed.' });
if (!projects.includes('certsimplatform')) throw new Error('Existing certsimplatform Pages project was not found.');
run(npx, ['wrangler@4', 'pages', 'deploy', 'dist/protected', '--project-name=certsimplatform', '--branch=main', `--commit-hash=${expectedSha}`], { shell, stdio: 'inherit', failure: 'Wrangler deployment failed.' });
