import assert from 'node:assert/strict';
import { aggregateWeakDomains } from '../src/lib/learnerAnalytics.js';
import { selectCurrentWeakAreaProfile } from '../src/lib/weakAreaProfileSelection.js';

const assessment = (examKey, profileKey, percentage) => ({
  examKey, profileKey, purpose: 'self_directed_exam', completionStatus: 'submitted',
  domainSummary: { 'domain-x': { label: 'Domain X', earnedPoints: percentage, maxPoints: 100, percentage } },
});
const legacyOnly = [assessment('az400', 'retired-profile', 55)];
assert.deepEqual(aggregateWeakDomains(legacyOnly).map(({ id, percentage }) => ({ id, percentage })), [{ id: 'domain-x', percentage: 55 }]);
assert.equal(aggregateWeakDomains(legacyOnly.filter((row) => row.examKey === 'ai901')).length, 0, 'cross-exam weakness must not leak');
assert.equal(aggregateWeakDomains([assessment('az204', 'full-profile', 55)]).length, 1, 'same-exam evidence remains cross-profile');
assert.equal(aggregateWeakDomains([assessment('az400', 'retired-profile', 75)]).length, 0, 'no weak domain remains unavailable');
const profiles = [{ id: 'az400-mvp-compact-profile' }, { id: 'az400-mvp-full-profile' }];
assert.equal(selectCurrentWeakAreaProfile(profiles, 'retired-profile'), 'az400-mvp-compact-profile');
assert.equal(selectCurrentWeakAreaProfile(profiles, 'az400-mvp-full-profile'), 'az400-mvp-full-profile');
console.log('Weak Area legacy-domain and current-profile fallback validation passed.');
