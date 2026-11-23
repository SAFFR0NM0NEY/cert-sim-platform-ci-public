import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sql = await readFile(new URL('../supabase/migrations/20260906134050_live_assignment_v2.sql', import.meta.url), 'utf8');
const staged = await readFile(new URL('../supabase/migrations/20260906143802_issue83_staged_exam_release.sql', import.meta.url), 'utf8');
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
assert.match(sql, /returns jsonb language sql security invoker[\s\S]+exam_delivery\.create_live_assignment_v2\(p_request\)/);
assert.match(sql, /revoke execute[\s\S]+exam_delivery\.create_live_assignment_v2\(jsonb\)[\s\S]+authenticated/);

// The applied migration's invoker wrapper could not execute its revoked
// private callee. The forward correction elevates only the checked wrapper.
assert.match(staged, /create or replace function public\.certsim_create_live_assignment_v2\(p_request jsonb\)[\s\S]+security definer/);
assert.match(staged, /v_actor uuid:=auth\.uid\(\)/);
assert.match(staged, /role='platform_owner' and m\.status='active'/);
assert.match(staged, /return exam_delivery\.create_live_assignment_v2\(p_request\)/);
assert.doesNotMatch(staged, /grant execute on function exam_delivery\.create_live_assignment_v2\(jsonb\)/i);

for (const token of [
  'exam_release_candidates', 'exam_release_configuration_requests',
  'configure_exam_release_stage', 'certsim_configure_exam_release_stage',
  "'acceptance'", "'standard_active_exam_v1'", "'sc200'", "'1.0.0'", "'sc200-full'",
]) assert.match(staged, new RegExp(token));
assert.match(staged, /json_has_exact_keys\(p_request,[\s\S]+examKey[\s\S]+releaseStage[\s\S]+requestId/);
assert.match(staged, /insert into exam_delivery\.exam_profile_activations[\s\S]+activation_kind/);
assert.match(staged, /values\(v_exam,v_profile_key,'assigned_assessment'/);
assert.match(staged, /unnest\(array\['self_directed_exam','study_sandbox','targeted_domain','weak_area','pbq_practice'\]\)/);
assert.match(staged, /'production_authorized',true,null,0,1/);
assert.match(staged, /purpose\.value='study_sandbox'[\s\S]+immediate_study_feedback[\s\S]+after_submission/);
assert.match(staged, /insert into public\.exam_catalog[\s\S]+production_ready/);
assert.match(staged, /on conflict\(canonical_exam_key,profile_key,purpose\) do update/);
assert.match(staged, /where request_id=v_request_id[\s\S]+exam_release_request_conflict/);
assert.match(staged, /resolve_package_profile_default\(v_key,p_profile_key,'assigned_assessment'\)/);
assert.match(staged, /can_use_profile\(p_actor_id,v_package\.package_version_id,[\s\S]+assigned_assessment/);
assert.match(staged, /legacy assessment policies and[\s\S]+historical assignments/i);
assert.match(staged, /revoke all on table exam_delivery\.exam_release_candidates,[\s\S]+public,anon,authenticated,service_role/);
assert.match(staged, /revoke execute[\s\S]+configure_exam_release_stage\(uuid,jsonb\)[\s\S]+public,anon,authenticated,service_role/);
assert.match(staged, /grant execute on function public\.certsim_create_live_assignment_v2\(jsonb\),[\s\S]+public\.certsim_configure_exam_release_stage\(jsonb\) to authenticated/);
assert.doesNotMatch(staged, /insert into exam_delivery\.protected_assignments/i);
assert.doesNotMatch(staged, /service_role[^;]*grant execute/i);
assert.doesNotMatch(staged, /user_metadata/i);
for (const token of ['contract_version','maximum_attempts','review_release_policy','answer_release_policy']) {
  assert.match(service, new RegExp(token));
}
console.log('Issue #83 live-assignment-v2 structural validation passed.');
