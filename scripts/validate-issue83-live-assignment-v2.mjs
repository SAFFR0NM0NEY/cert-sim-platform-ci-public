import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sql = await readFile(new URL('../supabase/migrations/20260906134050_live_assignment_v2.sql', import.meta.url), 'utf8');
const service = await readFile(new URL('../src/lib/examAssignmentService.js', import.meta.url), 'utf8');

for (const token of [
  'contract_version', 'package_version_id', 'package_profile_id', 'maximum_attempts',
  'review_release_policy', 'answer_release_policy', 'creation_request_id',
  'exam_assignments_v2_shape_check', 'exam_assignments_v2_package_profile_fk',
  'exam_assignments_v2_active_target_idx',
  'guard_live_assignment_v2_immutability', 'create_live_assignment_v2',
  'live_assignment_request_conflict', 'live_assignment_exceeds_package_policy',
  'assignment_attempt_limit_reached', "'assigned_assessment'",
  'assignment_review_release_policy', 'assignment_answer_release_policy',
]) assert.match(sql, new RegExp(token));

assert.match(sql, /contract_version is null[\s\S]+contract_version='live-v2'/);
assert.match(sql, /for update[\s\S]+count\(\*\)[\s\S]+maximum_attempts/i);
assert.match(sql, /when unique_violation[\s\S]+live_assignment_active_conflict/);
assert.match(sql, /pv\.id=v_assignment\.package_version_id/);
assert.match(sql, /pp\.id=v_assignment\.package_profile_id/);
assert.match(sql, /review_release_policy in \('never','after_submission'\)/);
assert.match(sql, /answer_release_policy in \('never','after_submission'\)/);
assert.match(sql, /exam_assignments_insert_scoped[\s\S]+contract_version is null/);
assert.match(sql, /exam_assignments_platform_owner_manage[\s\S]+contract_version is null/);
assert.match(sql, /a\.source_assignment_id is null and i\.id=p_item_id/);
assert.match(sql, /assignment_review_release_policy='after_submission'/);
assert.match(sql, /assignment_answer_release_policy='never'[\s\S]+item\.value-'correctAnswer'/);
assert.doesNotMatch(sql, /insert into exam_delivery\.protected_assignments/i);
assert.doesNotMatch(sql, /update public\.exam_assignments set contract_version/i);
assert.doesNotMatch(sql, /grant execute[\s\S]{0,200}create_live_assignment_v2\(jsonb\) to (?:public|anon|service_role)/i);
for (const token of ['contract_version','maximum_attempts','review_release_policy','answer_release_policy']) {
  assert.match(service, new RegExp(token));
}
console.log('Issue #83 live-assignment-v2 structural validation passed.');
