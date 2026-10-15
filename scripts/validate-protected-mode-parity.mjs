import assert from 'node:assert/strict';
import { protectedProfileMetadata } from '../src/exams/protectedProfileMetadata.js';
import { getExamLifecycle, isLiveVisibleLifecycle } from '../src/exams/examLifecycle.js';
import { examRegistry } from '../src/exams/examRegistry.protected.js';
import { getProtectedProfileKey } from '../src/lib/protectedExamContract.js';

const reviewedExemptions = Object.freeze({
  pythonnextgeneration: 'Issue #86 publishes independently released No-Lab and Lab profiles.',
});

for (const exam of examRegistry) {
  if (!isLiveVisibleLifecycle(getExamLifecycle(exam))) continue;
  const exemption = reviewedExemptions[exam.id];
  if (exemption) {
    assert.equal(typeof exemption, 'string');
    assert.ok(exemption.trim().length > 0);
  }
  const metadata = protectedProfileMetadata[exam.id];
  assert.ok(metadata, `${exam.id} requires protected metadata`);
  const names = metadata.profiles.map(({ name }) => name.toLowerCase());
  if (!exemption) {
    assert.ok(names.some((name) => name.includes('full') || name.includes('standard')), `${exam.id} requires Full`);
    assert.ok(names.some((name) => name.includes('compact')), `${exam.id} requires Compact`);
  }
  for (const profile of metadata.profiles) {
    assert.ok(profile.totalScoredQuestions > 0);
    assert.ok(profile.timeLimitMinutes > 0);
    assert.ok(Number.isInteger(profile.totalScoredQuestions));
  }
  if (exam.pbqCount === 0) assert.ok(metadata.profiles.every(({ pbqCount }) => pbqCount === 0));
  if (exam.caseStudyCount === 0) assert.ok(metadata.profiles.every(({ caseStudyCount }) => caseStudyCount === 0));
  assert.equal(exam.supportedFeatures.studySandbox, true);
  assert.equal(exam.supportedFeatures.targetedPractice, true);
  assert.equal(exam.supportedFeatures.attemptHistory, true);
  for (const profile of exam.strictBetaProfiles) assert.equal(getProtectedProfileKey(exam.id, profile.id), profile.id);
}

assert.equal(reviewedExemptions.inf303, undefined);
const inf303 = examRegistry.find(({ id }) => id === 'inf303');
assert.deepEqual(inf303.strictBetaProfiles.map(({ id, routeAction }) => [id, routeAction]), [
  ['inf303-standard', 'full'],
  ['inf303-compact', 'compact'],
]);
assert.equal(inf303.pbqCount, 0);
assert.equal(inf303.caseStudyCount, 0);
console.log(JSON.stringify({ ok: true, liveExamCount: examRegistry.filter((exam) => isLiveVisibleLifecycle(getExamLifecycle(exam))).length }));
