import assert from 'node:assert/strict';

import {
  examDisplayMetadata,
  getExamDisplayLabel,
  getExamDisplayMetadata,
} from '../src/exams/examDisplayMetadata.js';
import { examRegistry } from '../src/exams/examRegistry.protected.js';
import { validateExamRegistry } from '../src/utils/validateExamRegistry.js';
import { normalizeProtectedHistoryResult } from '../src/lib/protectedHistory.js';

const expected = {
  az204: ['az204', 'AZ-204', 'Developing Solutions for Microsoft Azure', 'AZ-204: Developing Solutions for Microsoft Azure', 'Microsoft'],
  'security-plus-sy0-701': ['security-plus', 'SY0-701', 'Security+', 'CompTIA Security+ (SY0-701)', 'CompTIA'],
  az400: ['az400', 'AZ-400', 'Designing and Implementing Microsoft DevOps Solutions', 'AZ-400: Designing and Implementing Microsoft DevOps Solutions', 'Microsoft'],
  ai901: ['ai901', 'AI-901', 'Azure AI Fundamentals', 'Microsoft Azure AI Fundamentals', 'Microsoft'],
};

assert.equal(examDisplayMetadata.length, 4);
for (const [id, values] of Object.entries(expected)) {
  const metadata = getExamDisplayMetadata(id);
  assert.deepEqual(
    [metadata.routeSlug, metadata.code, metadata.shortTitle, metadata.fullTitle, metadata.vendor],
    values,
    `${id} must expose the canonical display contract.`,
  );
  const registryExam = examRegistry.find((exam) => exam.id === id);
  assert.ok(registryExam, `${id} must remain registered.`);
  assert.equal(registryExam.slug, metadata.routeSlug, `${id} route must remain stable.`);
  assert.equal(registryExam.title, metadata.fullTitle);
}

for (const alias of ['AZ204', 'AZ 204', 'az-204']) assert.equal(getExamDisplayMetadata(alias)?.canonicalId, 'az204');
for (const alias of ['Security+', 'Security Plus', 'SY0701', 'securityplussy0701']) assert.equal(getExamDisplayMetadata(alias)?.canonicalId, 'security-plus-sy0-701');
assert.equal(getExamDisplayLabel('opaque-private-key'), 'Exam', 'Unknown internal identities must not leak into UI fallbacks.');
assert.equal(
  normalizeProtectedHistoryResult({
    attemptId: 'fixture-attempt', completedAt: '2026-01-01T00:00:00Z', examKey: 'securityplussy0701',
    source: 'protected', serverAuthoritative: true, purpose: 'self_directed_exam',
  }).examTitle,
  'CompTIA Security+ (SY0-701)',
  'Historical protected aliases must render the canonical result title.',
);
assert.deepEqual(
  validateExamRegistry(examRegistry).filter(({ message }) => /display metadata|code duplicates/.test(message)),
  [],
  'Registry metadata must satisfy the canonical contract.',
);

console.log(JSON.stringify({ ok: true, exams: examDisplayMetadata.length, aliasesValidated: 7 }));
