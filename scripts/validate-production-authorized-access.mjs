import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [migration, correction, integration, errors, edgeTests, client] = await Promise.all([
  read('supabase/migrations/20260901185404_production_authorized_access_contract.sql'),
  read('supabase/migrations/20260917074357_platform_owner_protected_exam_bypass.sql'),
  read('scripts/test-protected-access-history-integration.mjs'),
  read('supabase/functions/certsim-protected-exam/errors.ts'),
  read('supabase/functions/certsim-protected-exam/tests/function_test.ts'),
  read('src/lib/protectedExamClient.js'),
]);

assert.match(migration, /'production_authorized'/);
assert.match(migration, /is_authoritative_staff/);
for (const role of ['developer', 'platform_owner', 'college_admin', 'campus_admin', 'trainer', 'reception']) {
  assert.match(migration, new RegExp(`'${role}'`));
  assert.match(integration, new RegExp(role.replace('_', '[-_]')));
}
for (const source of ['assignment', 'direct_exam_purchase', 'package_purchase']) {
  assert.match(migration, new RegExp(`'${source}'`));
}
assert.match(migration, /has_purchase_profile_entitlement/);
assert.match(migration, /default_role='individual_user'/);
assert.match(migration, /revoked_at is null/);
assert.match(migration, /valid_until is null or e\.valid_until>statement_timestamp\(\)/);
assert.match(migration, /certsim_grant_purchase_entitlement/);
assert.match(migration, /v_actor uuid:=auth\.uid\(\)/);
assert.doesNotMatch(migration, /raw_user_meta_data|user_metadata/);
assert.match(migration, /maximum_completed_attempts=null/);
assert.match(migration, /maximum_concurrent_sessions=1/);
assert.match(migration, /cooldown_seconds=0/);
assert.match(migration, /v_updated<>10/);
assert.match(migration, /v_policy_count<>12/);
assert.match(migration, /count\(\*\).*purpose='self_directed_exam'\)<>13/s);
assert.match(migration, /package_version='1\.0\.0'.*not enabled.*access_mode='disabled'/s);
assert.match(migration, /purpose<>'self_directed_exam' and enabled/);
assert.doesNotMatch(migration, /delete\s+from|truncate/i);

const bypassBody = correction.match(
  /create or replace function exam_delivery\.has_staff_profile_access[\s\S]+?\n\$\$;/,
)?.[0] ?? '';
assert.match(bypassBody, /profile\.status = 'active'/);
assert.match(bypassBody, /membership\.status = 'active'/);
assert.match(bypassBody, /membership\.role = 'platform_owner'/);
assert.match(bypassBody, /activation\.activation_kind = 'production'/);
assert.match(bypassBody, /activation\.enabled/);
assert.doesNotMatch(bypassBody, /is_authoritative_staff/);
for (const deniedRole of ['developer', 'college_admin', 'campus_admin', 'trainer', 'reception']) {
  assert.doesNotMatch(bypassBody, new RegExp(`'${deniedRole}'`));
}
assert.match(correction, /stable[\s\S]+security definer[\s\S]+set search_path = ''[\s\S]+set statement_timeout = '3s'/);
assert.match(correction, /alter function exam_delivery\.has_staff_profile_access\(uuid, uuid, uuid\)[\s\S]+owner to postgres/);
assert.match(correction, /revoke execute on function exam_delivery\.has_staff_profile_access\(uuid, uuid, uuid\)[\s\S]+from public, anon, authenticated, service_role/);
assert.doesNotMatch(correction, /create or replace function exam_delivery\.is_authoritative_staff/);

for (const marker of ['purchaser', 'expired-purchaser', 'student-other', 'campus-administrator', 'reception']) {
  assert.match(integration, new RegExp(marker));
}
assert.match(integration, /not exam_delivery\.can_use_profile\('\$\{actors\.purchaser\.id\}'.*aiV2FullProfileId/s);
assert.match(integration, /bool_and\(exam_delivery\.can_use_profile\('\$\{actors\.owner\.id\}/);
for (const deniedActorExpression of [
  '${actors.developer.id}',
  '${actors.administrator.id}',
  '${actors.trainer.id}',
  "${actors['campus-administrator'].id}",
  '${actors.reception.id}',
]) {
  assert.ok(
    integration.includes(`not bool_or(exam_delivery.can_use_profile('${deniedActorExpression}`),
    `Missing unassigned protected-access denial for ${deniedActorExpression}.`,
  );
}
assert.match(integration, /not exam_delivery\.staff_can_view_learner\('\$\{actors\.reception\.id\}/);
assert.match(errors, /practice_unavailable: 403/);
assert.match(edgeTests, /translateRpcFailure\(\{ code: "practice_unavailable" \}\)\.status/);
assert.match(client, /practice_unavailable: 'Personal practice is not currently available for this exam profile\.'/);

console.log(JSON.stringify({
  ok: true,
  permanentMode: 'production_authorized',
  staffRoles: 6,
  unassignedBypassRoles: ['platform_owner'],
  entitlementSources: 3,
  hostedMutation: false,
}));
