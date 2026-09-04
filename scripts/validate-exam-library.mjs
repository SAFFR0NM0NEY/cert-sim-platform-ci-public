import assert from 'node:assert/strict';

import {
  deriveExamLibraryOptions,
  EXAM_LIBRARY_DEFAULTS,
  filterAndSortExamLibrary,
  isDefaultExamLibraryState,
  normalizeExamLibrarySearch,
} from '../src/components/exam/examLibraryHelpers.js';
import { liveVisibleExamConfigs } from '../src/exams/examRegistry.protected.js';

const exams = liveVisibleExamConfigs;
const ids = (items) => items.map((exam) => exam.id);
const select = (state = {}) => filterAndSortExamLibrary(exams, {
  ...EXAM_LIBRARY_DEFAULTS,
  ...state,
});

assert.equal(exams.length, 4, 'The visible protected registry should contain four exams.');
assert.equal(normalizeExamLibrarySearch('  AI–901  '), 'ai 901');

for (const query of ['AI-901', 'ai-901', '  AI-901  ', 'AI 901', 'Azure AI']) {
  assert.deepEqual(ids(select({ query })), ['ai901'], `${query} should find AI-901.`);
}
for (const query of ['Security+', 'SY0-701', 'CompTIA']) {
  assert.deepEqual(ids(select({ query })), ['security-plus-sy0-701'], `${query} should find Security+.`);
}
assert.deepEqual(ids(select({ query: 'AZ-204' })), ['az204']);
assert.deepEqual(ids(select({ query: 'AZ-400' })), ['az400']);
assert.deepEqual(ids(select({ query: 'Microsoft', vendor: 'Microsoft', lifecycle: 'controlledBeta' })), ['az400', 'ai901']);
assert.deepEqual(ids(select({ vendor: 'CompTIA', lifecycle: 'productionReady' })), ['security-plus-sy0-701']);
assert.deepEqual(ids(select({ query: 'Security+', vendor: 'Microsoft' })), []);

const canonicalIds = ids(exams);
const sourceBeforeSort = ids(exams);
assert.deepEqual(ids(select()), canonicalIds, 'Recommended must preserve registry order.');
assert.deepEqual(ids(select({ sort: 'name' })), ['az204', 'az400', 'ai901', 'security-plus-sy0-701']);
assert.deepEqual(ids(select({ sort: 'vendor' })), ['security-plus-sy0-701', 'az204', 'az400', 'ai901']);
assert.deepEqual(ids(exams), sourceBeforeSort, 'Sorting must not mutate the registry.');

const options = deriveExamLibraryOptions(exams);
assert.deepEqual(options.vendors, ['CompTIA', 'Microsoft']);
assert.equal(options.lifecycles.some(({ value }) => value === 'draft'), false);
assert.equal(select({ query: 'not a registered exam' }).length, 0);

const changedState = { query: 'AI-901', vendor: 'Microsoft', lifecycle: 'controlledBeta', sort: 'name' };
assert.equal(isDefaultExamLibraryState(changedState), false);
assert.equal(isDefaultExamLibraryState(EXAM_LIBRARY_DEFAULTS), true);
assert.deepEqual(ids(select(EXAM_LIBRARY_DEFAULTS)), canonicalIds);
assert.deepEqual(ids(select({ ...EXAM_LIBRARY_DEFAULTS })), canonicalIds, 'Repeated reset must remain idempotent.');

console.log(JSON.stringify({
  ok: true,
  visibleCertificationExams: exams.length,
  vendors: options.vendors.length,
  searchCases: 11,
  itDirectionCounted: false,
}));
