import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { serializeProtectedResponse, deserializeProtectedResponse, toPresentationQuestion } from '../src/lib/protectedExamContract.js';
import { getStructuredResponseState } from '../src/lib/structuredResponse.js';
import { resolveReleasedStructuredPairs, resolveReleasedTrueFalse } from '../src/lib/releasedAnswerDisplay.js';

const composite = { id: 'item-c', type: 'true-false-composite-v1', statements: [{ id: 's1' }, { id: 's2' }] };
const matching = { id: 'item-m', type: 'matching-v1', sources: [{ id: 's1' }, { id: 's2' }] };
const dropdown = { id: 'item-d', type: 'code-dropdown-completion-v1', blanks: [{ id: 'b1' }, { id: 'b2' }] };
for (const [question, answer] of [[composite, { s1: true, s2: false }], [matching, { s1: 't2', s2: 't1' }], [dropdown, { b1: 'o1', b2: 'o4' }]]) {
  const payload = serializeProtectedResponse(question, answer);
  assert.deepEqual(payload, { answer }); assert.deepEqual(deserializeProtectedResponse(question, payload), answer);
  assert.equal(getStructuredResponseState(question, answer), 'answered');
  assert.equal(getStructuredResponseState(question, { [Object.keys(answer)[0]]: Object.values(answer)[0] }), 'incomplete');
  assert.equal(getStructuredResponseState(question, {}), 'unanswered');
}
const singleBoolean = { id: 'item-b', type: 'true-false-single-v1' };
assert.deepEqual(serializeProtectedResponse(singleBoolean, false), { answer: false });
assert.equal(deserializeProtectedResponse(singleBoolean, { answer: false }), false);
const safe = toPresentationQuestion({ itemId: 'item-c', questionId: 'private-question-id', questionType: composite.type, questionNumber: 4, presentation: { prompt: 'Fixture', interactionVersion: composite.type, statements: [{ id: 's1', text: 'Fixture statement' }] }, revision: 2 });
assert.equal(safe.question, 'Fixture'); assert.equal(safe.type, composite.type); assert.equal(safe.revision, 2);
assert.throws(() => toPresentationQuestion({ itemId: 'x', questionType: composite.type, presentation: { prompt: 'Fixture', correctValuesByStatement: { s1: true } } }), /protected_field_detected/);
const migration = await readFile(new URL('../supabase/migrations/20260908120351_issue85_python_standard_interaction_scoring.sql', import.meta.url), 'utf8');
for (const token of ['true-false-single-v1', 'true-false-composite-v1', 'matching-v1', 'code-dropdown-completion-v1', 'correctValuesByStatement', 'correctTargetIdsBySource', 'correctOptionIdsByBlank', 'maximumRawPoints']) assert.match(migration, new RegExp(token));
assert.match(migration, /revoke execute on function exam_delivery\.package_v2_response_valid[^;]+from public,anon,authenticated,service_role/i);
assert.doesNotMatch(migration, /grant execute on function exam_delivery\.score_package_v2_response/i);
const publicationMigration = await readFile(new URL('../supabase/migrations/20260908134811_issue85_python_standard_publication_contract.sql', import.meta.url), 'utf8');
for (const capability of ['true-false-single-v1', 'true-false-composite-v1', 'matching-v1', 'code-dropdown-completion-v1']) {
  assert.match(publicationMigration, new RegExp(`'${capability}'`));
}
assert.match(publicationMigration, /p_generator\s*=\s*'certsim-python-standard-canonical-forms-v1'[\s\S]+p_scorer\s*=\s*'certsim-versioned-structured-partial-v1'[\s\S]+p_pbq_runtime is null/i);
assert.match(publicationMigration, /alter function exam_delivery\.package_v2_runtime_supported\(text,text,text\) owner to postgres/i);
assert.match(publicationMigration, /revoke execute on function exam_delivery\.package_v2_runtime_supported\(text,text,text\)[\s\S]+from public, anon, authenticated, service_role/i);
assert.match(publicationMigration, /create or replace function exam_delivery\.publish_package_v2\(p_request jsonb\)[\s\S]+security definer[\s\S]+set search_path = ''[\s\S]+set statement_timeout = '15s'/i);
assert.match(publicationMigration, /alter function exam_delivery\.publish_package_v2\(jsonb\) owner to postgres/i);
assert.match(publicationMigration, /revoke execute on function exam_delivery\.publish_package_v2\(jsonb\)[\s\S]+from public, anon, authenticated, service_role[\s\S]+grant execute on function exam_delivery\.publish_package_v2\(jsonb\)[\s\S]+to authenticated/i);
assert.doesNotMatch(publicationMigration, /grant execute on function exam_delivery\.package_v2_runtime_supported\(text,text,text\) to (anon|authenticated|service_role)/i);
const formMigration = (await readFile(new URL('../supabase/migrations/20260908151342_issue85_python_standard_form_materialization.sql', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
for (const token of ['certsim-python-standard-forms-v1', 'profile-specific-reserve', 'rawMaximum', 'package_forms', 'package_form_questions', 'package_reserve_questions', 'canonical_form_raw_maximum_invalid']) {
  assert.match(formMigration, new RegExp(token));
}
assert.match(formMigration, /new\.generator_version\s*<>\s*'certsim-python-standard-canonical-forms-v1'[\s\S]+new\.scorer_version\s*<>\s*'certsim-versioned-structured-partial-v1'/i);
assert.match(formMigration, /new\.declared_review_release_policy\s*:=\s*'after_submission'[\s\S]+new\.declared_answer_release_policy\s*:=\s*'after_submission'/i);
assert.match(formMigration, /alter function exam_delivery\.prepare_canonical_forms_on_publish\(\) owner to postgres/i);
assert.match(formMigration, /revoke execute on function exam_delivery\.prepare_canonical_forms_on_publish\(\)[\s\S]+from public, anon, authenticated, service_role[\s\S]+grant execute on function exam_delivery\.prepare_canonical_forms_on_publish\(\) to postgres/i);
const originalFormMigration = (await readFile(new URL('../supabase/migrations/20260905153716_ai901_canonical_form_rotation.sql', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const originalV2Start = originalFormMigration.indexOf('  for v_profile in', originalFormMigration.indexOf('canonical_form_profile_declaration_incomplete'));
const originalV2End = originalFormMigration.indexOf('\nend\n$$;', originalV2Start);
const retainedV2Marker = formMigration.indexOf('-- Existing certsim-canonical-forms-v2 implementation begins here unchanged.');
const retainedV2Start = formMigration.indexOf('  for v_profile in', retainedV2Marker);
const retainedV2End = formMigration.indexOf('\nend\n$$;', retainedV2Start);
assert.ok(originalV2Start > 0 && originalV2End > originalV2Start && retainedV2Start > retainedV2Marker && retainedV2End > retainedV2Start);
assert.equal(formMigration.slice(retainedV2Start, retainedV2End), originalFormMigration.slice(originalV2Start, originalV2End));
const databaseWorkflow = await readFile(new URL('../.github/workflows/backend-exam-delivery-db-validation.yml', import.meta.url), 'utf8');
assert.match(databaseWorkflow, /backend_exam_delivery_issue85_publication_contract\.sql/);
assert.match(databaseWorkflow, /backend_exam_delivery_issue85_python_forms\.sql/);
const releaseMigration = await readFile(new URL('../supabase/migrations/20260908155215_issue85_inf303_release_configuration.sql', import.meta.url), 'utf8');
for (const token of ["'inf303'", "'1.0.0'", "'inf303-standard'", "'INF-303 — Python Standard'", "'Certiport'", "question_type like 'pbq-%'"]) assert.match(releaseMigration, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
assert.match(releaseMigration, /exam_delivery\.configure_exam_release_stage\(uuid,jsonb\)[\s\S]+owner to postgres[\s\S]+revoke execute[\s\S]+from public, anon, authenticated, service_role/i);
const protectedRegistry = await readFile(new URL('../src/exams/examRegistry.protected.js', import.meta.url), 'utf8');
assert.match(protectedRegistry, /id:\s*'inf303',\s*lifecycle:\s*EXAM_LIFECYCLES\.productionReady/);
const displayMetadata = await readFile(new URL('../src/exams/examDisplayMetadata.js', import.meta.url), 'utf8');
assert.match(displayMetadata, /canonicalId:\s*'inf303'[\s\S]+fullTitle:\s*'INF-303 — Python Standard'[\s\S]+vendor:\s*'Certiport'/);
const edge = await readFile(new URL('../supabase/functions/certsim-protected-exam/responses.ts', import.meta.url), 'utf8');
assert.match(edge, /sanitizeQuestionPresentation/); assert.match(edge, /safeArray\(presentation\.blanks/); assert.doesNotMatch(edge, /privateScoring/);
const card = await readFile(new URL('../src/components/exam/QuestionCard.jsx', import.meta.url), 'utf8');
for (const component of ['TrueFalseQuestion', 'AccessibleMatchingQuestion', 'CodeDropdownCompletionQuestion']) assert.match(card, new RegExp(component));
const matchingUi = await readFile(new URL('../src/components/exam/AccessibleMatchingQuestion.jsx', import.meta.url), 'utf8');
assert.match(matchingUi, /<select/); assert.match(matchingUi, /aria-label/);
const tfPresentation = { type: 'true-false-composite-v1', statements: [{ id: 's1', text: 'First statement' }, { id: 's2', text: 'Second statement' }] };
assert.deepEqual(resolveReleasedTrueFalse(tfPresentation, { answer: { s1: true, s2: false } }).entries.map(({ text }) => text), ['True', 'False']);
assert.equal(resolveReleasedTrueFalse(tfPresentation, { answer: { unknown: true } }).status, 'invalid');
const matchPresentation = { type: 'matching-v1', sources: [{ id: 's2', text: 'Second source' }, { id: 's1', text: 'First source' }], targets: [{ id: 't1', text: 'First target' }, { id: 't2', text: 'Second target' }] };
assert.deepEqual(resolveReleasedStructuredPairs(matchPresentation, { answer: { s1: 't1', s2: 't2' } }).pairs.map(({ leftText, rightText }) => [leftText, rightText]), [['Second source', 'Second target'], ['First source', 'First target']]);
const codePresentation = { type: 'code-dropdown-completion-v1', blanks: [{ id: 'b1', label: 'First blank', options: [{ id: 'o1', text: 'print' }] }] };
assert.deepEqual(resolveReleasedStructuredPairs(codePresentation, { correctOptionIdsByBlank: { b1: 'o1' } }, { correct: true }).pairs[0], { leftText: 'First blank', rightText: 'print' });
assert.equal(resolveReleasedStructuredPairs(codePresentation, { answer: { b1: 'internal-id' } }).status, 'invalid');
console.log('Issue #85 Python Standard structured interactions validated.');
