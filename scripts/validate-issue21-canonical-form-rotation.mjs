import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationPath = 'supabase/migrations/20260905153716_ai901_canonical_form_rotation.sql';
const sql = await readFile(migrationPath, 'utf8');

for (const table of ['package_forms', 'package_form_questions', 'package_reserve_questions']) {
  assert.match(sql, new RegExp(`create table exam_delivery\\.${table}`));
  assert.match(sql, new RegExp(`alter table exam_delivery\\.${table} enable row level security`));
  assert.match(sql, new RegExp(`revoke all on table exam_delivery\\.${table} from public, anon, authenticated, service_role`));
}
for (const fn of ['prepare_canonical_forms_on_publish', 'allocate_canonical_form', 'materialize_attempt_items']) {
  assert.match(sql, new RegExp(`function exam_delivery\\.${fn}`));
}
assert.match(sql, /security definer[\s\S]*?set search_path = ''/);
assert.match(sql, /set statement_timeout = '5s'/);
assert.match(sql, /set statement_timeout = '15s'/);
assert.match(sql, /pg_advisory_xact_lock/);
assert.match(sql, /attempts_one_canonical_form_per_cycle_idx/);
assert.match(sql, /foreign key \(package_profile_id, package_version_id\)/);
assert.match(sql, /foreign key \(form_id, package_profile_id, package_version_id\)/);
assert.match(sql, /foreign key \(package_question_id, package_version_id\)/);
assert.match(sql, /unique \(package_profile_id, package_question_id\)/);
assert.match(sql, /canonical_form_id is not null/);
assert.match(sql, /purpose not in \('assigned_assessment','self_directed_exam'\)/);
assert.match(sql, /return exam_delivery\.materialize_attempt_items_issue21_unrotated_base/);
assert.match(sql, /practice-only-until-versioned-rebalance/);
assert.match(sql, /canonical_form_runtime_validation_failed/);
for (const token of ['certsim-canonical-forms-v2', 'skillGroupTargets', 'requiredObjectiveKeys', 'minimumCoverageTagCounts', 'officialObjectiveKey', 'coverageTags']) assert.match(sql, new RegExp(token));
for (const token of ['canonical_form_generic_metadata_invalid', 'json_has_exact_keys', 'jsonb_typeof']) assert.match(sql, new RegExp(token));
assert.match(sql, /count\(distinct/);
assert.match(sql, /not in \('easy','medium','hard','advanced'\)/);
for (const forbidden of ['ai901Subskill', 'identify-ai-concepts-and-capabilities', 'implement-ai-solutions-with-foundry', 'blueprintTargets', 'requiredSubskills', 'minimumImplementationQuestions']) assert.doesNotMatch(sql, new RegExp(forbidden));
assert.match(sql, /self_directed_release_policy_conflicts_with_package/);
assert.match(sql, /\('after_submission','after_submission'\)/);
assert.doesNotMatch(sql, /grant (?:select|insert|update|delete|all).*package_(?:forms|form_questions|reserve_questions)/i);
assert.doesNotMatch(sql, /auth\.uid\(\)/, 'private helpers must not pretend browser identity is their execution boundary');

console.log(JSON.stringify({
  ok: true,
  issue: 21,
  migration: migrationPath,
  contractVersion: 'certsim-canonical-forms-v2',
  realLifecycleFixture: 'scripts/test-issue21-canonical-form-lifecycle.mjs',
  browserTableGrants: 0,
  legacyFallbackPreserved: true,
}));
