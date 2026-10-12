import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationName = '20260910133143_issue147_weak_area_options.sql';
const [migration, routes, errors, handler, responses, client, savedResults, edgeTests, browserTests, sqlTests] = await Promise.all([
  readFile(new URL(`../supabase/migrations/${migrationName}`, import.meta.url), 'utf8'),
  readFile(new URL('../supabase/functions/certsim-protected-exam/routes.ts', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/functions/certsim-protected-exam/errors.ts', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/functions/certsim-protected-exam/handler.ts', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/functions/certsim-protected-exam/responses.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/protectedExamClient.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/protected/ProtectedSavedResultsPage.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/functions/certsim-protected-exam/tests/function_test.ts', import.meta.url), 'utf8'),
  readFile(new URL('../tests/r3g/issue147-az204-weak-area-language.spec.js', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/tests/backend_exam_delivery_issue147.sql', import.meta.url), 'utf8'),
]);

assert.match(migration, /create function exam_delivery\.weak_area_options\(/);
assert.match(migration, /resolve_package_profile_default\([\s\S]*?'weak_area'/);
assert.match(migration, /learner_weak_domain_evidence\(/);
assert.match(migration, /package_questions question/);
assert.match(migration, /'domains', v_domains/);
assert.match(migration, /grant execute[\s\S]*certsim_protected_weak_area_options[\s\S]*to service_role/);
assert.doesNotMatch(migration, /grant execute[\s\S]*to (anon|authenticated)/);

const discoveryFunction = migration.match(/create function exam_delivery\.weak_area_options\([\s\S]*?\n\$\$;/)?.[0] ?? '';
assert.doesNotMatch(discoveryFunction, /\b(insert into|update|delete from|merge into)\b/i);

assert.match(routes, /weakAreaOptions:\s*"certsim_protected_weak_area_options"/);
assert.match(routes, /\["weakAreaOptions", "GET", \/\^\\\/practice\\\/weak-areas\$\//);
assert.match(errors, /\| "no_weak_areas"/);
assert.match(errors, /no_weak_areas:\s*409/);
assert.match(handler, /matched\.id === "weakAreaOptions"/);
assert.match(handler, /\["examKey", "profileId"\]/);
assert.match(handler, /p_actor_id: actorId/);
assert.match(handler, /mapWeakAreaOptions\(rpcData\)/);
assert.match(responses, /export function mapWeakAreaOptions/);
assert.match(responses, /return \{ domainKey, evidenceCount, lowestPercentage \}/);
assert.match(client, /getWeakAreaOptions:[\s\S]*?\/practice\/weak-areas/);

assert.match(savedResults, /client\.getWeakAreaOptions\(examId, profileId/);
assert.match(savedResults, /weakAreaOptions\.state !== 'ready'/);
assert.match(savedResults, /getProtectedReasonMessage\('no_weak_areas'\)/);
assert.doesNotMatch(savedResults, /aggregateWeakDomains/);
assert.match(savedResults, /currentExam\?\.id === 'az204'[\s\S]*?<span>Language<\/span>/);
assert.match(savedResults, /client\.getPracticeAvailability\(practiceConfiguration\.value/);

for (const contract of [
  'staff assessment history remains visible',
  'mapped predecessor evidence',
  'unmapped predecessor evidence',
  'unclassified historical activity remains visible',
]) assert.match(browserTests, new RegExp(contract));
assert.match(edgeTests, /fixed identity-derived read route/);
assert.match(edgeTests, /preserves stable no_weak_areas/);
assert.match(sqlTests, /staff history creates no learner weak-area evidence/);
assert.match(sqlTests, /eligible current-package learner/);
assert.match(sqlTests, /mapped predecessor evidence resolves/);
assert.match(sqlTests, /unclassified legacy activity/);

console.log(JSON.stringify({
  ok: true,
  issue: 147,
  phase: 'B',
  route: 'GET /practice/weak-areas',
  stableNoWeakAreasStatus: 409,
  productionWrites: 0,
}));
