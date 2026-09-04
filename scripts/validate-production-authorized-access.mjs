import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [migration, integration, errors, edgeTests, client] = await Promise.all([
  read('supabase/migrations/20260901185404_production_authorized_access_contract.sql'),
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

for (const marker of ['purchaser', 'expired-purchaser', 'student-other', 'campus-administrator', 'reception']) {
  assert.match(integration, new RegExp(marker));
}
assert.match(integration, /not exam_delivery\.can_use_profile\('\$\{actors\.purchaser\.id\}'.*aiV2FullProfileId/s);
assert.match(integration, /not exam_delivery\.staff_can_view_learner\('\$\{actors\.reception\.id\}/);
assert.match(errors, /practice_unavailable: 403/);
assert.match(edgeTests, /translateRpcFailure\(\{ code: "practice_unavailable" \}\)\.status/);
assert.match(client, /practice_unavailable: 'Personal practice is not currently available for this exam profile\.'/);

console.log(JSON.stringify({
  ok: true,
  permanentMode: 'production_authorized',
  staffRoles: 6,
  entitlementSources: 3,
  hostedMutation: false,
}));
