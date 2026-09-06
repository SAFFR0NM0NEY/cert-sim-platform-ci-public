import assert from 'node:assert/strict';
import { liveVisibleExamConfigs } from '../src/exams/examRegistry.protected.js';
import { protectedProfileMetadata } from '../src/exams/protectedProfileMetadata.js';

const expected = {
  az204: {
    'standard-profile': [50, 120, 43, 1, 7, 0, null],
    'compact-profile': [40, 100, 37, 1, 3, 0, null],
    'full-profile': [60, 150, 50, 2, 10, 0, null],
    'case-heavy-profile': [50, 130, 40, 2, 10, 0, null],
  },
  'security-plus-sy0-701': {
    'strict-beta-compact': [45, 60, 42, 0, 0, 3, 'front-loaded'],
    'strict-beta-full': [90, 90, 86, 0, 0, 4, 'front-loaded'],
  },
  az400: {
    'az400-mvp-compact-profile': [60, 90, 60, 0, 0, 0, 'standard'],
    'az400-mvp-full-profile': [80, 120, 80, 0, 0, 0, 'standard'],
    'az400-sectioned-full-exam-profile': [80, 120, 66, 2, 12, 2, 'case-standard-pbq'],
  },
  ai901: {
    'ai901-controlled-beta-compact': [25, 25, 25, 0, 0, 0, null],
    'ai901-controlled-beta-full': [50, 45, 50, 0, 0, 0, null],
  },
};

let count = 0;
for (const exam of liveVisibleExamConfigs) {
  const published = protectedProfileMetadata[exam.id];
  assert.ok(published, `missing safe published metadata for ${exam.id}`);
  for (const profile of exam.strictBetaProfiles) {
    const safe = published.profiles.find((item) => item.id === profile.id);
    assert.ok(safe, `missing safe published profile ${exam.id}/${profile.id}`);
    const order = safe.sectionOrder ?? safe.pbqPlacement ?? null;
    assert.deepEqual([
      profile.totalScoredQuestions,
      profile.timeLimitMinutes,
      profile.standardQuestionCount,
      profile.caseStudyCount,
      profile.caseStudyQuestionCount,
      profile.pbqCount,
      profile.sectionOrder ?? profile.pbqPlacement ?? null,
    ], expected[exam.id][profile.id]);
    assert.deepEqual(profile, { ...profile, ...safe });
    assert.equal(order, expected[exam.id][profile.id][6]);
    count += 1;
  }
}
assert.equal(count, 11, 'all production-enabled protected profiles must be checked');
console.log(`Protected profile metadata parity validation passed (${count} profiles).`);
