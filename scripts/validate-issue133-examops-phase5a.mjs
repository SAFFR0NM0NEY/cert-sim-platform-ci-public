import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const migrationName = '20260921044626_issue133_phase5a_operator_readonly.sql';
const migration = await readFile(`supabase/migrations/${migrationName}`, 'utf8');
const service = await readFile('src/lib/examOperationsService.js', 'utf8');
const page = await readFile('src/components/admin/ExamOperationsPage.jsx', 'utf8');
const app = await readFile('src/App.jsx', 'utf8');
const account = await readFile('src/components/account/AccountPage.jsx', 'utf8');
const docs = await readFile('docs/CERTSIM_EXAM_OPERATIONS_PHASE5A.md', 'utf8');
const pgTap = await readFile('supabase/tests/backend_exam_delivery_issue133_phase5a.sql', 'utf8');
const workflow = await readFile('.github/workflows/backend-exam-delivery-db-validation.yml', 'utf8');
const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const migrations = (await readdir('supabase/migrations')).filter((name) => name.endsWith('.sql')).sort();

assert.equal(migrations.length, 91);
assert.equal(migrations.at(-2), migrationName);
assert.equal(migrations.at(-3), '20260920124528_issue133_examops_phase4b.sql');

assert.match(migration, /create function exam_delivery\.get_exam_operations_health\(\s*p_actor_id uuid,\s*p_exam_key text/i);
assert.match(migration, /create function public\.certsim_examops_get_health\(p_exam_key text\)/i);
assert.match(migration, /v_actor uuid:=auth\.uid\(\)/i);
assert.match(migration, /examops_actor_is_platform_owner\(v_actor\)/i);
assert.match(migration, /raise exception 'examops_forbidden' using errcode='42501'/i);
assert.match(migration, /validate_current_exam_release_configuration\(v_exam\)/i);
assert.match(migration, /attempt_continuation_contracts/i);
assert.match(migration, /exam_release_operations/i);
assert.match(migration, /operation\.result_state='succeeded'/i);
assert.match(migration, /operation\.operation_type in \('ACTIVATE','ROLLBACK'\)/i);
assert.match(migration, /'NOT_AVAILABLE'/i);
assert.match(migration, /security definer/i);
assert.match(migration, /set search_path=''/i);
assert.match(migration, /set statement_timeout='10s'/i);
assert.match(migration, /revoke execute on function exam_delivery\.get_exam_operations_health\(uuid,text\)[\s\S]*from public,anon,authenticated,service_role/i);
assert.match(migration, /revoke execute on function public\.certsim_examops_get_health\(text\)[\s\S]*from public,anon,authenticated,service_role/i);
assert.match(migration, /grant execute on function public\.certsim_examops_get_health\(text\)\s*to authenticated/i);
assert.doesNotMatch(migration, /\b(?:insert|update|delete|truncate|alter table)\b/i);
assert.doesNotMatch(migration, /package_question|question_id|response_payload|scoring_payload|review_payload|authoring_metadata/i);
assert.doesNotMatch(migration, /email|membership_id|assignment_id|attempt\.id[^\s]/i);

assert.match(service, /certsim_examops_get_health/);
assert.match(service, /certsim_examops_list_release_operations/);
assert.match(service, /Math\.min\(Math\.max[\s\S]*50/);
assert.match(service, /postconditions\.restoredPackageVersion/);
assert.doesNotMatch(service, /certsim_examops_(?:stage|activate|rollback)/i);
assert.doesNotMatch(service, /\b(?:stage|activate|rollback)\s*:/i);
assert.match(page, /currentMissingContinuationContracts/);
assert.match(page, /Critical:/);
assert.match(page, /No Exam Operations releases have been recorded yet/);
assert.match(page, /Not available means CertSim does not currently measure this signal/);
assert.match(page, /Legacy release evidence is shown separately and is not Exam Operations history/);
assert.match(page, /createHistoryRequestController/);
assert.match(page, /historyRequestControllerRef\.current\.invalidate\(\)/);
for (const label of ['Stage', 'Activate', 'Rollback', 'Publish', 'Retire', 'Promote']) {
  assert.doesNotMatch(page, new RegExp(`<button[^>]*>[^<]*${label}`, 'i'));
}

assert.match(app, /routePath === '\/admin\/exam-operations'/);
assert.match(app, /screen: 'admin-exam-operations'/);
assert.match(app, /<ExamOperationsPage[\s\S]*identity=\{currentIdentity\}/);
assert.match(account, /isPlatformOwner\s*\?\s*\([\s\S]*title="Exam Operations"/);
assert.match(pgTap, /private health function is denied to authenticated/);
assert.match(pgTap, /service role cannot bypass private health/);
assert.match(workflow, /backend_exam_delivery_issue133_phase5a\.sql/);
assert.match(workflow, /test-issue133-phase5a-integration\.mjs/);

assert.equal(packageJson.scripts['validate:issue133:phase5a'], 'node scripts/validate-issue133-examops-phase5a.mjs');
assert.equal(packageJson.scripts['test:issue133-phase5a-frontend'], 'node scripts/test-issue133-phase5a-frontend.mjs');
assert.equal(packageJson.scripts['test:issue133-phase5a-db'], 'node scripts/test-issue133-phase5a-integration.mjs');
assert.match(packageJson.scripts.validate, /validate:issue133:phase5a/);

for (const statement of [
  '/admin/exam-operations', 'Platform Owner only', 'NOT_AVAILABLE',
  'legacy release evidence', 'Phase 5B', 'Phase 5C', 'source-only',
  'Supabase CLI 2.114.0',
]) assert.match(docs, new RegExp(statement, 'i'));

console.log('PASS Issue #133 Phase 5A static contract validation');
console.log('  one source-only read contract, owner-gated route, safe UI service, docs, and CI hooks are present');
