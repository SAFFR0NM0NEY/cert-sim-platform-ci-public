import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { liveVisibleExamConfigs } from '../src/exams/examRegistry.protected.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [app, runner, details, client, contract] = await Promise.all([
  read('src/App.jsx'),
  read('src/components/exam/ProtectedExamRunner.jsx'),
  read('src/components/exam/StudentDetails.jsx'),
  read('src/lib/protectedExamClient.js'),
  read('src/lib/protectedExamContract.js'),
]);

const profiles = liveVisibleExamConfigs.flatMap((exam) => exam.strictBetaProfiles.map((profile) => ({ exam, profile })));
assert.equal(profiles.length, 11);
for (const { exam, profile } of profiles) {
  assert.ok(exam.title && profile.name);
  assert.ok(Number.isInteger(profile.totalScoredQuestions) && profile.totalScoredQuestions > 0);
  assert.ok(Number.isInteger(profile.standardQuestionCount) && profile.standardQuestionCount >= 0);
  assert.ok(Number.isInteger(profile.timeLimitMinutes) && profile.timeLimitMinutes > 0);
  assert.ok(Number.isInteger(profile.caseStudyCount ?? 0));
  assert.ok(Number.isInteger(profile.pbqCount ?? 0));
}

assert.match(app, /codingLanguagePreference=\{getCodingLanguagePreferenceForExam/);
assert.match(app, /onCodingLanguagePreferenceChange=\{handleAz204CodingLanguageChange\}/);
assert.match(app, /<ProtectedExamRunner[\s\S]*onExit=\{handleBackToExamDashboard\}/);
assert.match(app, /if \(requestedScreen === 'exam'\)[\s\S]*student && activeExam[\s\S]*return 'exam'/);
assert.match(app, /screen === 'student' \|\|[\s\S]*screen === 'exam'[\s\S]*getTimedRoutePath/);
assert.match(runner, /listCurrentAttemptBindings/);
assert.match(runner, /candidates\.length === 1/);
assert.match(runner, /Recovering your protected attempt/);
assert.match(runner, /await readResumeCandidate\(candidates\[0\], controller\.signal\)/);
assert.match(runner, /readResumeCandidate/);
assert.match(runner, /\['attempt_not_found', 'attempt_expired'\]\.includes\(error\.code\)[\s\S]*setState\('ready'\)/);
assert.match(runner, /The prior attempt is complete\. You can start a new attempt\./);
assert.match(runner, /const refreshedAvailability = await client\.getPracticeAvailability/);
assert.match(runner, /languageLocked=\{false\}/);
assert.match(runner, /setConfiguredLanguage\(nextLanguage\)/);
assert.match(runner, /onStartExam=\{state === 'ready-active' \? startNewAttempt : startAttempt\}/);
assert.match(runner, /async function abandonAndExit\(\)[\s\S]*await saveItem\(currentItemId\)[\s\S]*client\.abandonAttempt/);
assert.match(runner, /It cannot be resumed[\s\S]*no completed result will be created/);
assert.match(runner, /if \(starting\.current\) return;[\s\S]*starting\.current = true/);
assert.doesNotMatch(runner.match(/async function initialize\(\)[\s\S]*?\n  }\n    initialize/)?.[0] ?? '', /startPractice|startAttempt\(/);
assert.match(details, /accountStudent \? \(isProtectedPractice \? 'Practice details' : 'Exam details'\) : 'Student details'/);
assert.match(details, /Learner:[\s\S]*accountStudent\.name/);
assert.match(details, /actionDisabled/);
assert.match(details, /supplementalContent/);
assert.match(details, /!accountStudent && <>/);
assert.match(details, /disabled=\{languageLocked\}/);
assert.match(client, /attempt_not_found: 'No resumable protected attempt was found\.'/);
assert.match(contract, /'csharp', 'python', 'mixed'/);
assert.doesNotMatch(contract, /PROTECTED_LANGUAGE_PREFERENCES[^\n]*not_applicable/);

const initialization = runner.match(/async function initialize\(\)[\s\S]*?\n    initialize\(\);/)?.[0] ?? '';
const selfDirectedInitialization = initialization.match(/if \(practiceRequest\) \{[\s\S]*?\n          return;/)?.[0] ?? '';
assert.doesNotMatch(selfDirectedInitialization, /getCurrentAttempt\(/, 'self-directed pre-exam discovery must not deliver protected attempt content');
assert.doesNotMatch(initialization, /startPractice\(|startAttempt\(/, 'initialization must never start an attempt');

console.log(JSON.stringify({
  ok: true,
  profileCount: profiles.length,
  explicitStartOnly: true,
  preExamContentFree: true,
  issues: [24, 29],
}));
