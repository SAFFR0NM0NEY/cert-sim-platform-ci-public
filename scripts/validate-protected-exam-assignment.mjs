import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const authorityPath = 'supabase/migrations/20260827161104_protected_exam_assignment_authorization.sql';
const boundaryPath = 'supabase/migrations/20260827174825_protected_assignment_invoker_boundary.sql';
const recoveryPath = 'supabase/migrations/20260827190935_protected_attempt_interruption_recovery.sql';
const authoritySql = await readFile(authorityPath, 'utf8');
const boundarySql = await readFile(boundaryPath, 'utf8');
const recoverySql = await readFile(recoveryPath, 'utf8');
const config = await readFile('supabase/config.toml', 'utf8');
const sql = `${authoritySql}\n${boundarySql}\n${recoverySql}`;

for (const fragment of [
  'create table exam_delivery.protected_assignments',
  'protected_assignments_package_profile_fk',
  'protected_assignments_one_active_identity_idx',
  'maximum_attempts integer not null',
  "review_release_policy text not null default 'never'",
  "answer_release_policy text not null default 'never'",
  'add column protected_assignment_id uuid not null',
  'create function exam_delivery.create_protected_assignment',
  'create function public.certsim_protected_create_assignment',
  "v_actor uuid := auth.uid()",
  "set search_path = ''",
  "set statement_timeout = '10s'",
  "p_review_release_policy <> 'never'",
  "p_answer_release_policy <> 'never'",
  "for update of a",
  "attempt_limit_reached",
  "p_exam_key in ('ai-901','ai901')",
  "x.status='in_progress'",
  "greatest(0,v_assignment.maximum_attempts-v_attempt_count)",
]) assert.match(sql, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));

assert.match(sql, /alter table exam_delivery\.protected_assignments enable row level security/i);
assert.match(sql, /revoke all on exam_delivery\.protected_assignments from public, anon, authenticated, service_role/i);
assert.match(sql, /revoke execute[\s\S]+create_protected_assignment[\s\S]+from public,anon,service_role/i);
assert.match(sql, /grant execute[\s\S]+certsim_protected_create_assignment[\s\S]+to authenticated/i);
assert.match(boundarySql, /returns jsonb[\s\S]+language sql[\s\S]+security invoker[\s\S]+set search_path\s*=\s*''/i);
assert.match(boundarySql, /grant usage on schema exam_delivery to authenticated/i);
assert.match(boundarySql, /grant execute on function exam_delivery\.create_protected_assignment\([\s\S]+?\) to authenticated/i);
assert.match(boundarySql, /revoke execute on function exam_delivery\.create_protected_assignment\([\s\S]+?\) from public, anon, service_role/i);
assert.doesNotMatch(boundarySql, /security definer/i);
assert.doesNotMatch(config, /exam_delivery/i);
assert.doesNotMatch(sql, /grant\s+(?:insert|update|delete)[^;]+protected_assignments/i);
assert.doesNotMatch(sql, /user_metadata|actor_user_id/i);
assert.doesNotMatch(sql.match(/create function exam_delivery\.create_protected_assignment[\s\S]+?\$\$;/i)?.[0] ?? '', /p_actor/i);
assert.doesNotMatch(sql, /insert\s+into\s+public\.exam_assignments/i);
assert.match(sql, /ai901-controlled-beta-compact/i);
assert.match(sql, /join exam_delivery\.package_profiles pp on pp\.id=a\.package_profile_id and pp\.package_version_id=a\.package_version_id/i);
assert.match(sql, /where x\.protected_assignment_id=v_assignment\.id/i);
assert.match(sql, /pa\.review_release_policy<>'never' and pa\.answer_release_policy<>'never'/i);
assert.match(recoverySql, /create table exam_delivery\.attempt_technical_recoveries/i);
assert.match(recoverySql, /unique \(protected_assignment_id\)/i);
assert.match(recoverySql, /v_actor uuid := auth\.uid\(\)/i);
assert.match(recoverySql, /status='voided'/i);
assert.match(recoverySql, /not exists\([\s\S]+attempt_technical_recoveries[\s\S]+interrupted_attempt_id=x\.id/i);
assert.match(recoverySql, /create function public\.certsim_protected_authorize_technical_recovery[\s\S]+security invoker/i);
assert.match(recoverySql, /revoke all on exam_delivery\.attempt_technical_recoveries[\s\S]+public, anon, authenticated, service_role/i);
assert.doesNotMatch(recoverySql, /delete\s+from|truncate|drop\s+table/i);

console.log(`PASS Protected assignment static validation (${authorityPath}; ${boundaryPath})`);
console.log('  Invoker-only public boundary, private owner authority, package/profile binding, quota locking, and never-release policy are present.');
