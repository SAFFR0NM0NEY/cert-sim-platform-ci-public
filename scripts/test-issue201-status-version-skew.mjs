import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const api = process.env.SUPABASE_URL, db = process.env.SUPABASE_DB_URL;
for (const value of [api, db]) if (!value || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(value).hostname)) throw Error('DISPOSABLE_LOOPBACK_REQUIRED');
const service = process.env.SUPABASE_SERVICE_ROLE_KEY, anon = process.env.SUPABASE_ANON_KEY;
const unsupported = process.argv.includes('--unsupported');
const eq = (v, expected, label) => { if (v !== expected) throw Error('VERSION_SKEW_ASSERTION_' + label); };
function sql(input) {
  const r = spawnSync(process.env.PSQL_PATH || 'psql', [db, '-XqAt', '-v', 'ON_ERROR_STOP=1'], { input, encoding: 'utf8', windowsHide: true });
  if (r.status) throw Error('VERSION_SKEW_SQL_FAILED');
  return r.stdout.trim();
}
const email = 'status-skew-' + randomUUID() + '@example.invalid', password = randomUUID();
const created = await fetch(api + '/auth/v1/admin/users', { method: 'POST', headers: { apikey: service, Authorization: 'Bearer ' + service, 'content-type': 'application/json' },
  body: JSON.stringify({ email, password, email_confirm: true }) });
eq(created.ok, true, 'synthetic_auth_create');
const actor = await created.json();
sql("update public.profiles set status='active' where id='" + actor.id + "'");
const login = await fetch(api + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { apikey: anon, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
eq(login.ok, true, 'synthetic_login'); const session = await login.json();
if (process.env.GITHUB_ACTIONS) for (const token of [session.access_token, session.refresh_token]) {
  if (token) process.stdout.write('::add-mask::' + token + '\n');
}
const snapshot = () => sql("select md5(jsonb_build_array((select count(*) from exam_delivery.attempts),(select count(*) from exam_delivery.expiry_authority),(select count(*) from exam_delivery.expiry_bindings),(select count(*) from exam_delivery.expiry_events),(select count(*) from exam_delivery.python_worker_jobs),(select count(*) from exam_delivery.python_worker_dispatches),(select count(*) from exam_delivery.attempt_results),(select active_run from exam_delivery.python_worker_control))::text)");
const before = snapshot();
const response = await fetch(api + '/functions/v1/certsim-protected-exam/completion-status/pending?pageSize=1', {
  headers: { apikey: anon, Authorization: 'Bearer ' + session.access_token, Origin: 'http://127.0.0.1:4179' }, cache: 'no-store' });
const body = await response.json();
eq(response.status, unsupported ? 501 : 200, 'actual_edge_status');
eq(response.headers.get('cache-control'), 'no-store', 'private_no_store');
if (unsupported) eq(body.error?.code, 'status_contract_unsupported', 'explicit_missing_rpc');
else {
  eq(body.items?.length, 0, 'supported_no_eligible_records');
  eq(body.watched?.length, 0, 'supported_empty_watch');
  const legacy = await fetch(api + '/functions/v1/certsim-protected-exam/attempts/current-bindings?examKey=pythonnextgeneration&purpose=self_directed_exam', {
    headers: { apikey: anon, Authorization: 'Bearer ' + session.access_token, Origin: 'http://127.0.0.1:4179' } });
  eq(legacy.ok, true, 'old_frontend_existing_discovery');
  eq((await legacy.json()).candidates?.length, 0, 'old_frontend_no_eligible_attempt');
}
eq(snapshot(), before, 'no_exam_lifecycle_writes');
for (const gate of ['expiry_activation', 'expiry_worker_control', 'python_expiry_control', 'python_worker_control', 'python_fence_control']) eq(sql('select enabled from exam_delivery.' + gate), 'f', 'gate_unchanged_disabled');
const summaryPath = resolve(process.env.RUNNER_TEMP, 'learner-status-acceptance.json');
const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
summary[unsupported ? 'actual95BackendMissingRpc' : 'actual96NoEligibleAndLegacyClient'] = true;
writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ suite: 'learner-status-actual-version-skew', backendMigrationCount: unsupported ? 95 : 96, explicitUnsupported: unsupported, lifecycleWrites: 0, gatesDisabled: true, passed: true }));
