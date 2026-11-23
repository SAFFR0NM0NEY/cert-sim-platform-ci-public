import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split(/\r?\n/)
  .filter((file) => file && existsSync(file));
const applicationFiles = tracked.filter((file) => file.startsWith('src/'));
const forbiddenApplicationPaths = [
  /\/questions\//i,
  /questionbank\.[cm]?[jt]sx?$/i,
  /(?:^|\/)examRegistry\.js$/,
  /(?:^|\/)(?:scoring|pbqScoring|sharedExamAttemptGenerator|generateExamAttempt|generateAz400SectionedAttempt|generateSecurityPlusStrictBetaAttempt|validateQuestionBank|weakAreaPractice)\.js$/,
  /(?:^|\/)(?:ExamRunner|ExamResults|ExamReview|StudyReport|StudySandbox|TargetedPractice|CaseStudyPractice|PBQRenderer)\.jsx$/,
];

for (const file of applicationFiles) {
  assert.equal(
    forbiddenApplicationPaths.some((pattern) => pattern.test(file)),
    false,
    `Retired browser-delivery source returned: ${file}`,
  );
}

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
assert.equal(packageJson.scripts['build:legacy'], undefined);
assert.doesNotMatch(JSON.stringify(packageJson.scripts), /build:legacy|publish:ai901/);

const vite = await readFile(new URL('../vite.config.js', import.meta.url), 'utf8');
const mode = await readFile(new URL('../src/lib/protectedDeliveryMode.js', import.meta.url), 'utf8');
const cloudflare = await readFile(new URL('../.github/workflows/cloudflare-pages-main.yml', import.meta.url), 'utf8');
const firebase = await readFile(new URL('../.github/workflows/firebase-hosting-main.yml', import.meta.url), 'utf8');
assert.doesNotMatch(vite, /['"]legacy['"]/);
assert.match(vite, /VITE_CERTSIM_EXAM_DELIVERY_MODE \?\? 'protected'/);
assert.doesNotMatch(mode, /legacy:\s*'legacy'/);
assert.match(mode, /DELIVERY_MODES\.protected/);
assert.doesNotMatch(cloudflare, /- legacy/);
assert.doesNotMatch(firebase, /- legacy|default: legacy/);

const protectedRegistry = await readFile(new URL('../src/exams/examRegistry.protected.js', import.meta.url), 'utf8');
assert.match(protectedRegistry, /questionBank: Object\.freeze\(\[\]\)/);
assert.doesNotMatch(protectedRegistry, /correctAnswers?\s*:|explanation\s*:|remediation\s*:/);

const appSource = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
assert.doesNotMatch(appSource, /DELIVERY_MODES\.legacy/);

console.log(JSON.stringify({
  ok: true,
  trackedApplicationFiles: applicationFiles.length,
  retiredBuildModes: ['legacy'],
  productionMode: 'protected',
  commercialBankFiles: 0,
  clientScoringAuthorities: 0,
}));
