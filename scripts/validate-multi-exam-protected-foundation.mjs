import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  ACCESS_POLICY_MODES,
  createSanitizedMultiExamSummary,
  MULTI_EXAM_PACKAGE_SCHEMA_VERSION,
  MULTI_EXAM_QUESTION_CAPABILITIES,
  MULTI_EXAM_VALIDATION_CONTRACT_VERSION,
  normalizeExamKey,
  validateMultiExamPackageContract,
} from './backend-exam-publication/multi-exam-contract.mjs';

const migrationPath =
  'supabase/migrations/20260828142514_multi_exam_protected_delivery_foundation.sql';
const migration = await readFile(migrationPath, 'utf8');

assert.equal(normalizeExamKey(' AI-901 '), 'ai901');
assert.equal(normalizeExamKey('security-plus-sy0-701'), 'securityplussy0701');
assert.equal(normalizeExamKey('AZ_400'), 'az400');
assert.deepEqual(ACCESS_POLICY_MODES, [
  'open_authenticated', 'assignment_required', 'organisation_scoped',
  'controlled_beta', 'disabled',
]);

const fixture = {
  packageSchemaVersion: MULTI_EXAM_PACKAGE_SCHEMA_VERSION,
  validationContractVersion: MULTI_EXAM_VALIDATION_CONTRACT_VERSION,
  exam: {
    examKey: 'sample-100', packageVersion: '1.0.0',
    capabilities: ['single-choice', 'informational', 'pbq-workspace'],
    domains: [{ key: 'domain-a', name: 'Sanitized domain' }],
  },
  source: { sourceHash: 'a'.repeat(64), validationHash: 'b'.repeat(64) },
  runtime: { generatorVersion: 'generator-v2', scorerVersion: 'scorer-v2' },
  profiles: [{
    profileKey: 'practice', questionCount: 3, timeLimitMinutes: 10,
    selection: { strategy: 'domain-balanced' },
  }],
  releasePolicy: { review: 'after_submission', answers: 'scheduled' },
  questions: [
    {
      id: 'sample-standard', type: 'single-choice', domainKey: 'domain-a', scored: true,
      presentation: { prompt: 'Sanitized prompt', options: [{ id: 'a', label: 'Option A' }] },
      privateScoring: { model: 'exact', key: 'private' },
      privateReview: { guidance: 'private' },
    },
    {
      id: 'sample-info', type: 'informational', domainKey: 'domain-a', scored: false,
      presentation: { heading: 'Sanitized context' }, privateReview: {},
    },
    {
      id: 'sample-workspace', type: 'pbq-workspace', domainKey: 'domain-a', scored: true,
      presentation: { workspace: { tabs: [{ id: 'tab-a', label: 'Tab A' }] } },
      privateScoring: { model: 'weighted-partial-credit', key: 'private' },
      privateReview: { guidance: 'private' },
    },
  ],
};

const validated = validateMultiExamPackageContract(fixture);
assert.equal(validated.examKey, 'sample100');
assert.equal(validated.questionCount, 3);
assert.equal(createSanitizedMultiExamSummary(fixture).ok, true);
assert.ok(MULTI_EXAM_QUESTION_CAPABILITIES.includes('pbq-workspace'));
assert.throws(
  () => validateMultiExamPackageContract({
    ...fixture,
    questions: [{ ...fixture.questions[0], presentation: { correctAnswer: 'blocked' } }],
  }),
  /PROTECTED_FIELD_IN_PRESENTATION/,
);

for (const required of [
  'open_authenticated', 'assignment_required', 'organisation_scoped',
  'controlled_beta', 'disabled', 'security definer', "set search_path = ''",
  "set statement_timeout = '10s'", 'auth.uid()', 'enable row level security',
  'revoke all', 'security invoker',
]) {
  assert.ok(migration.toLowerCase().includes(required.toLowerCase()), `missing ${required}`);
}
assert.ok(!migration.match(/insert\s+into\s+exam_delivery\.exam_access_policies/i));
assert.ok(!migration.match(/grant\s+.*\s+to\s+(anon|service_role)/i));

console.log('PASS multi-exam protected-delivery foundation');
console.log('  Generic policy modes, package capabilities, and sanitized fixtures are pinned.');
