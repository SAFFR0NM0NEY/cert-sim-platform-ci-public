import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const migrationName = '20260910172710_issue160_platform_owner_weak_area.sql';
const [migration, learnerAuthority, handler, client, sqlTests] = await Promise.all([
  readFile(new URL(`../supabase/migrations/${migrationName}`, import.meta.url), 'utf8'),
  readFile(new URL('../supabase/migrations/20260905192938_cross_version_package_compatibility.sql', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/functions/certsim-protected-exam/handler.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/protectedExamClient.js', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/tests/backend_exam_delivery_issue160.sql', import.meta.url), 'utf8'),
]);

assert.equal(
  createHash('sha256').update(learnerAuthority.replaceAll('\r\n', '\n')).digest('hex'),
  '68bdd05096a3120025e739d2a8eff9f21795a68ea90cdaae6c67122668b4a909',
  'the migration containing learner_weak_domain_evidence must remain byte-for-byte unchanged',
);
assert.doesNotMatch(
  migration,
  /(?:create|alter|drop)\s+(?:or\s+replace\s+)?function\s+exam_delivery\.learner_weak_domain_evidence/i,
);

const helper = migration.match(/create function exam_delivery\.weak_domain_evidence_for_practice\([\s\S]*?\n\$\$;/)?.[0] ?? '';
assert.match(helper, /security definer[\s\S]*set search_path = ''[\s\S]*set statement_timeout = '8s'/);
assert.match(helper, /public\.profiles[\s\S]*profile\.status = 'active'/);
assert.match(helper, /public\.is_platform_owner\(p_actor_id\)/);
assert.match(helper, /attempt\.owner_id = owner\.owner_id/);
assert.match(helper, /attempt\.purpose in \('assigned_assessment', 'self_directed_exam'\)/);
assert.match(helper, /attempt\.actor_classification = 'staff'/);
assert.match(helper, /attempt\.analytics_eligible is not true/);
assert.doesNotMatch(helper, /'study_sandbox'|'targeted_domain'|'weak_area'|'pbq_practice'/);
assert.match(helper, /package_domain_compatibility[\s\S]*mapping\.enabled/);
assert.match(helper, /learner_weak_domain_evidence\(/);
assert.match(migration, /revoke execute on function exam_delivery\.weak_domain_evidence_for_practice\(uuid,uuid\)[\s\S]*from public, anon, authenticated, service_role/);

const discovery = migration.match(/create or replace function exam_delivery\.weak_area_options\([\s\S]*?\n\$\$;/)?.[0] ?? '';
assert.match(discovery, /weak_domain_evidence_for_practice\(/);
assert.doesNotMatch(discovery, /learner_weak_domain_evidence\(/);
assert.match(migration, /pg_get_functiondef\([\s\S]*practice_availability\(uuid,jsonb\)/);
assert.match(migration, /replace\([\s\S]*learner_weak_domain_evidence\([\s\S]*weak_domain_evidence_for_practice\(/);
assert.match(migration, /issue160_practice_availability_contract_drift/);
assert.match(migration, /pg_get_functiondef\([\s\S]*materialize_attempt_items_issue21_unrotated_base\(uuid,uuid,integer\)/);
assert.match(migration, /issue160_practice_materializer_contract_drift/);

assert.doesNotMatch(migration, /alter table exam_delivery\.attempts/i);
assert.doesNotMatch(migration, /(?:insert into|update|delete from)\s+exam_delivery\.(?:attempts|attempt_results)/i);
assert.doesNotMatch(migration, /package_question_protected_content|attempt_item_protected_content/i);
assert.doesNotMatch(migration, /set\s+(?:actor_classification|analytics_eligible)\s*=/i);

assert.match(handler, /userClient\.auth\.getUser\(\)[\s\S]*const actorId = data\?\.user\?\.id/);
assert.match(handler, /matched\.id === "weakAreaOptions"[\s\S]*!\["examKey", "profileId"\]\.includes\(key\)/);
assert.match(handler, /matched\.id === "practiceStart"[\s\S]*validateObject\([\s\S]*"clientRequestId"/);
assert.doesNotMatch(client.match(/getWeakAreaOptions:[^\n]+/)?.[0] ?? '', /actorId|ownerId|learnerId|userId/);

for (const contract of [
  'Platform Owner current-package evidence is returned',
  'AZ-204 C# Weak Area availability succeeds',
  'AZ-204 Python Weak Area availability succeeds',
  'AZ-204 Mixed Weak Area availability succeeds',
  'Weak Area materializer uses unified practice evidence',
  'Platform Owner Weak Area start succeeds',
  'student learner evidence remains unchanged',
  'developer staff evidence is excluded',
  'trainer staff evidence is excluded',
  'all practice purposes are excluded from owner evidence',
  'mapped predecessor owner evidence uses the target domain',
  'unmapped predecessor owner evidence is absent',
  'owner evidence is isolated across users',
  'learner domain history excludes owner-only evidence',
  'staff learner aggregates exclude owner-only evidence',
  'discovery is read-only',
]) assert.match(sqlTests, new RegExp(contract));

console.log(JSON.stringify({
  ok: true,
  issue: 160,
  migration: migrationName,
  databaseOnly: true,
  productionWrites: 0,
}));
