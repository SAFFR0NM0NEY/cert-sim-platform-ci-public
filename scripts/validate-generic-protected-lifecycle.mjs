import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const migrationName = '20260828192747_generic_multi_exam_publication_lifecycle.sql';
const migration = await readFile(`supabase/migrations/${migrationName}`, 'utf8');
const releaseMigrationName = '20260828224638_package_v2_release_policy_declarations.sql';
const releaseMigration = await readFile(`supabase/migrations/${releaseMigrationName}`, 'utf8');
const operator = await readFile('scripts/publish-protected-package.mjs', 'utf8');
const handler = await readFile('supabase/functions/certsim-protected-exam/handler.ts', 'utf8');
const hash = createHash('sha256').update(Buffer.from(migration.replaceAll('\r\n','\n'),'utf8')).digest('hex');

assert.equal(hash, 'a3d9b150c8bc3ddbe1c72a27254014195aba3ccdc108efc0a5367260276721c4');
for (const fragment of [
  'certsim-protected-package-v2','certsim-protected-multi-exam-validation-v1',
  'publish_package_v2','create_protected_assignment_v2','check_eligibility_v2',
  'start_attempt_v2','submit_attempt_v2','score_package_v2_response',
  'package_v2_response_valid','save_response_ai901_v1',
  "set search_path = ''","set statement_timeout = '15s'",'auth.uid()',
  'open_authenticated','assignment_required','organisation_scoped','controlled_beta',
  'idempotent_replay','publication_request_conflict','publication_atomicity_failure',
  'per-component-map','per-component-positive','exact-ordered-sequence',
  'weighted-rule-evaluation','exact-whole-state','review_snapshots',"'withheld'",
]) assert.match(migration,new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i'));
assert.doesNotMatch(migration,/insert\s+into\s+exam_delivery\.(?:exam_access_policies|exam_access_learners|exam_access_organisations|pilot_gates|pilot_access)\b/i);
assert.doesNotMatch(migration,/execute\s+format|\bformat\s*\(|raw_user_meta_data|auth\.role\s*\(/i);
assert.match(migration,/revoke execute on function public\.certsim_protected_publish_package\(jsonb\)[\s\S]+from public,anon,service_role/i);
assert.match(migration,/grant execute on function public\.certsim_protected_publish_package\(jsonb\) to authenticated/i);
assert.match(migration,/revoke all on all tables in schema exam_delivery from service_role/i);

assert.match(releaseMigration,/create or replace function exam_delivery\.publish_package_v2\(p_request jsonb\)/i);
assert.match(releaseMigration,/json_has_exact_keys\(v_payload->'releasePolicy',array\['review','answers'\]\)/i);
assert.match(releaseMigration,/\('never','never'\)[\s\S]+\('after_submission','after_submission'\)/i);
assert.doesNotMatch(releaseMigration,/\('never','after_submission'\)|\('after_submission','never'\)/i);
assert.match(migration,/p_review_release_policy<>'never' or p_answer_release_policy<>'never'/i);
assert.match(releaseMigration,/revoke execute on function exam_delivery\.publish_package_v2\(jsonb\)[\s\S]+from public, anon, service_role/i);
assert.doesNotMatch(releaseMigration,/insert\s+into\s+exam_delivery\.(?:exam_access_policies|exam_access_learners|exam_access_organisations|pilot_gates|pilot_access|protected_assignments|attempts|attempt_responses|attempt_results|review_snapshots)\b/i);

assert.match(operator,/mode: 'validation-only'/);
assert.match(operator,/networkRequests: 0/);
assert.match(operator,/process\.argv\.slice\(2\)/);
assert.match(operator,/--exam-key=/);
assert.match(operator,/--content-root=/);
assert.match(operator,/persistSession: false/);
assert.match(operator,/autoRefreshToken: false/);
assert.match(operator,/auth\.getUser\(\)/);
assert.match(operator,/crypto\.randomUUID\(\)/);
assert.match(operator,/signOut\(\{ scope: 'global' \}\)/);
assert.match(operator,/stderr\.write\('\*'\)/);
assert.doesNotMatch(operator,/service[_-]?role|sb_secret_/i);
assert.doesNotMatch(operator,/writeFile|appendFile|createWriteStream|actor(?:Id|UserId)/);

assert.doesNotMatch(handler,/DEFAULT_PROFILE|examKey\) !== "ai-901"/);
assert.match(handler,/profileId/);
assert.match(handler,/isExamKey/);
assert.match(handler,/p_actor_id: actorId/);

console.log(`PASS generic protected publication and lifecycle static validation (${migrationName})`);
console.log(`  Release-policy declarations are constrained by ${releaseMigrationName}; effective assignments remain never/never.`);
