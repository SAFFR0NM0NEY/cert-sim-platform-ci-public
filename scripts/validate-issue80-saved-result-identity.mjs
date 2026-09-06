import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  getSavedResultExamFilterOptions,
  getSavedResultExamLabel,
  UNKNOWN_EXAM_LABEL,
} from '../src/lib/savedResultExamIdentity.js';
import { liveVisibleExamConfigs } from '../src/exams/examRegistry.protected.js';

const page = await readFile(
  new URL('../src/protected/ProtectedSavedResultsPage.jsx', import.meta.url),
  'utf8',
);

const fixtures = [
  ['current protected AI-901', 'ai901', 'AI-901 — Azure AI Fundamentals'],
  ['current protected AZ-204', 'az204', 'AZ-204 — Developing Solutions for Microsoft Azure'],
  ['historical alias', 'Microsoft Azure AI Fundamentals', 'AI-901 — Azure AI Fundamentals'],
  ['practice Security+ internal key', 'securityplussy0701', 'SY0-701 — Security+'],
];

for (const [description, identity, expected] of fixtures) {
  assert.equal(getSavedResultExamLabel(identity), expected, description);
}
assert.equal(getSavedResultExamLabel('unidentified-historical-exam'), UNKNOWN_EXAM_LABEL);

const filterOptions = getSavedResultExamFilterOptions(liveVisibleExamConfigs);
assert.equal(filterOptions.length, 4);
assert.deepEqual(
  filterOptions.map(({ label }) => label),
  [
    'AZ-204 — Developing Solutions for Microsoft Azure',
    'SY0-701 — Security+',
    'AZ-400 — Designing and Implementing Microsoft DevOps Solutions',
    'AI-901 — Azure AI Fundamentals',
  ],
);
assert.equal(filterOptions.find(({ value }) => value === 'security-plus-sy0-701')?.label, 'SY0-701 — Security+');
assert.ok(filterOptions.every(({ label }) => !label.includes('securityplussy0701')));

assert.match(page, /getSavedResultExamLabel\(item\.examKey\)/);
assert.match(page, /getSavedResultExamLabel\(record\.registryExamId\)/);
assert.match(page, /onOpenDetail\?\.\(item\.attemptId\)/);
assert.match(page, /Historical account result/);
assert.match(page, /Historical browser result/);
assert.doesNotMatch(page, /Certification exam|getExamDisplayName/);

console.log(JSON.stringify({
  ok: true,
  issue: 80,
  currentProtectedFixtures: 2,
  legacyAliases: 1,
  practiceFixtures: 1,
  unknownFallback: UNKNOWN_EXAM_LABEL,
  filterOptions: filterOptions.length,
  internalKeysDisplayed: 0,
}));
