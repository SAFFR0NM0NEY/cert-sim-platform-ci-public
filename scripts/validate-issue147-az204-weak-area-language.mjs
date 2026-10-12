import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { buildWeakAreaPracticeRequest } from '../src/lib/protectedPracticeRequest.js';

const base = {
  examKey: 'az204',
  profileId: 'standard-profile',
  domain: 'synthetic-domain',
  count: 20,
  includePbqs: true,
  mixStrategy: 'balanced',
};

for (const language of ['csharp', 'python', 'mixed']) {
  const availability = buildWeakAreaPracticeRequest({ ...base, language });
  const start = buildWeakAreaPracticeRequest(availability);
  assert.deepEqual(start, availability);
  assert.equal(availability.language, language);
  assert.equal(availability.purpose, 'weak_area');
}

assert.equal(buildWeakAreaPracticeRequest({ ...base, count: undefined, questionCount: 30, language: 'csharp' }).count, 30);
for (const language of ['', 'CSharp', 'PYTHON', 'unknown', null, undefined]) {
  assert.throws(
    () => buildWeakAreaPracticeRequest({ ...base, language }),
    (error) => error?.code === 'invalid_language',
  );
}

for (const examKey of ['ai901', 'inf303']) {
  const request = buildWeakAreaPracticeRequest({ ...base, examKey, language: 'python' });
  assert.equal(request.examKey, examKey);
  assert.equal(Object.hasOwn(request, 'language'), false);
}

const [savedResults, app, runner, edge] = await Promise.all([
  readFile(new URL('../src/protected/ProtectedSavedResultsPage.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/App.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/exam/ProtectedExamRunner.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/functions/certsim-protected-exam/handler.ts', import.meta.url), 'utf8'),
]);

assert.match(savedResults, /currentExam\?\.id === 'az204'[\s\S]*?<span>Language<\/span>/);
assert.match(savedResults, /client\.getPracticeAvailability\(practiceConfiguration\.value/);
assert.match(savedResults, /onStart\?\.\(practiceConfiguration\.value\)/);
assert.match(savedResults, /onCodingLanguagePreferenceChange\?\.\(event\.target\.value\)/);
assert.match(app, /codingLanguagePreference=\{az204CodingLanguagePreference\}/);
assert.match(app, /onCodingLanguagePreferenceChange=\{handleAz204CodingLanguageChange\}/);
assert.match(app, /request = buildWeakAreaPracticeRequest\(\{/);
assert.match(app, /openProtectedPractice\(examConfig, 'weak_area', request\)/);
assert.match(app, /overrides\.language \?\? getCodingLanguagePreferenceForExam\(examConfig\)/);
assert.match(runner, /practiceRequest\?\.language \?\? codingLanguagePreference/);
assert.match(runner, /delete request\.language;[\s\S]*examKey === 'az204'\) request\.language = language/);
assert.match(edge, /isCanonicalLanguage\(value\.examKey, value\.language\)/);
assert.match(edge, /\["csharp", "python", "mixed"\]\.includes\(String\(language\)\)/);

console.log(JSON.stringify({
  ok: true,
  issue: 147,
  az204Languages: ['csharp', 'python', 'mixed'],
  nonLanguageExams: ['ai901', 'inf303'],
  invalidLanguagesRejected: 6,
  edgeValidationUnchanged: true,
}));
