import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const migrationPath = new URL('../supabase/migrations/20260907101759_issue83_sc200_successor_cutover.sql', import.meta.url);
const migration = await readFile(migrationPath, 'utf8');
const canonicalHash = createHash('sha256').update(migration.replaceAll('\r\n', '\n')).digest('hex');

for (const token of [
  'sc200_successor_cutover_requests',
  'cutover_sc200_successor_release',
  'certsim_cutover_sc200_successor_release',
  "'sc200'", "'1.0.0'", "'1.1.0'", "'sc200-full'", "'sc200-compact'",
  '305085dea2431a978941c3d13b3dfddc9cd3a1706d16ee2869157094fb20782d',
  '2a2cd94e7d2dc491bea3e414263e61819f92ae5de77e634e3bbd9c2288d9abdb',
  'package_v2_runtime_supported', 'package_form_questions',
  'sc200_successor_cutover_active_attempt', 'sc200_successor_cutover_state_conflict',
  "enabled=false,disabled_at=v_now", "enabled=false,access_mode='disabled'",
]) assert.match(migration, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

assert.match(migration, /json_has_exact_keys\(p_request,array\[[\s\S]*'requestId'[\s\S]*\]\)/);
assert.match(migration, /v_actor uuid:=auth\.uid\(\)/);
assert.match(migration, /p\.status='active'[\s\S]*m\.status='active'[\s\S]*m\.role='platform_owner'/);
assert.match(migration, /security definer set search_path='' set statement_timeout='10s'/);
assert.match(migration, /security invoker set search_path='' set statement_timeout='10s'/);
assert.match(migration, /alter table exam_delivery\.sc200_successor_cutover_requests enable row level security/);
assert.match(migration, /revoke all on table exam_delivery\.sc200_successor_cutover_requests[\s\S]*public,anon,authenticated,service_role/);
assert.match(migration, /revoke execute on function exam_delivery\.cutover_sc200_successor_release\(uuid,jsonb\),[\s\S]*public\.certsim_cutover_sc200_successor_release\(jsonb\) from public,anon,authenticated,service_role/);
assert.match(migration, /grant execute on function public\.certsim_cutover_sc200_successor_release\(jsonb\) to authenticated/);
assert.doesNotMatch(migration, /grant execute on function exam_delivery\.cutover_sc200_successor_release/);
assert.doesNotMatch(migration, /insert into exam_delivery\.(?:attempts|exam_entitlements|protected_assignments)/i);
assert.doesNotMatch(migration, /delete\s+from|truncate\s+/i);
assert.equal((migration.match(/insert into exam_delivery\.sc200_successor_cutover_requests/g) ?? []).length, 1);
assert.match(migration, /v_existing\.actor_id[\s\S]*sc200_successor_cutover_request_conflict/);
assert.match(migration, /sc200_successor_cutover_replay_conflict/);
assert.match(migration, /package_version_id=v_predecessor\.package_version_id[\s\S]*status='published'/);
assert.match(migration, /package_version_id=v_successor\.package_version_id[\s\S]*status='published'/);
assert.match(migration, /count\(\*\)[\s\S]*package_questions[\s\S]*<>300/);
assert.match(migration, /package_profile_id=v_full\.package_profile_id[\s\S]*question_count=50[\s\S]*<>6/);
assert.match(migration, /package_profile_id=v_compact\.package_profile_id[\s\S]*question_count=25[\s\S]*<>6/);
assert.match(migration, /cross join unnest\(v_purposes\[2:6\]\)/);
assert.match(migration, /cross join unnest\(v_purposes\)/);
assert.match(migration, /current_version='1\.1\.0'[\s\S]*lifecycle='production_ready'/);

console.log(JSON.stringify({ ok: true, issue: 83, migration: migrationPath.pathname.split('/').at(-1), canonicalSha256: canonicalHash }));
