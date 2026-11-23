import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  examDisplayMetadata,
  getExamDisplayMetadata,
  getExamDisplaySearchTerms,
} from '../src/exams/examDisplayMetadata.js';
import {
  examRegistry,
  liveVisibleExamConfigs,
} from '../src/exams/examRegistry.protected.js';
import { protectedProfileMetadata } from '../src/exams/protectedProfileMetadata.js';
import {
  getProtectedExamKey,
  getProtectedProfileKey,
} from '../src/lib/protectedExamContract.js';
import { filterAndSortExamLibrary } from '../src/components/exam/examLibraryHelpers.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [accessContract, app, browseSpec, accessSpec] = await Promise.all([
  read('supabase/migrations/20260901185404_production_authorized_access_contract.sql'),
  read('src/App.jsx'),
  read('tests/r3g/issue86-browse-registration.spec.js'),
  read('tests/r3g/app-python-next-generation-access.spec.js'),
]);

const examId = 'pythonnextgeneration';
const display = getExamDisplayMetadata(examId);
assert.deepEqual(display, examDisplayMetadata.find(({ canonicalId }) => canonicalId === examId));
assert.deepEqual({
  routeSlug: display.routeSlug,
  code: display.code,
  shortTitle: display.shortTitle,
  fullTitle: display.fullTitle,
  vendor: display.vendor,
}, {
  routeSlug: 'python-next-generation',
  code: 'Python',
  shortTitle: 'Python Next Generation',
  fullTitle: 'Python Next Generation',
  vendor: 'Certiport',
});
assert.equal(getExamDisplayMetadata('Python')?.canonicalId, examId);
assert.equal(getExamDisplayMetadata('Python Next Generation')?.canonicalId, examId);
assert.equal(getExamDisplayMetadata('Python Standard')?.canonicalId, 'inf303');
assert.ok(getExamDisplaySearchTerms(examId).includes('Certiport Python'));

const metadata = protectedProfileMetadata[examId];
assert.equal(metadata.packageVersion, '1.0.0');
assert.equal(metadata.inventoryCount, 283);
assert.deepEqual(metadata.profiles.map((profile) => ({
  id: profile.id,
  name: profile.name,
  count: profile.totalScoredQuestions,
  minutes: profile.timeLimitMinutes,
  forms: profile.canonicalFormCount,
  executable: profile.executableCount,
})), [
  { id: 'pythonnextgeneration-no-lab', name: 'No-Lab', count: 35, minutes: 50, forms: 6, executable: 0 },
  { id: 'pythonnextgeneration-lab', name: 'Lab', count: 31, minutes: 50, forms: 6, executable: 7 },
]);

assert.equal(examRegistry.filter(({ id }) => id === examId).length, 1);
assert.equal(liveVisibleExamConfigs.filter(({ id }) => id === examId).length, 1);
const exam = examRegistry.find(({ id }) => id === examId);
assert.deepEqual(exam.domainNames, ['Domain 1', 'Domain 2', 'Domain 3', 'Domain 4', 'Domain 5', 'Domain 6']);
assert.deepEqual(exam.strictBetaProfiles.map(({ id, routeAction }) => [id, routeAction]), [
  ['pythonnextgeneration-no-lab', 'no-lab'],
  ['pythonnextgeneration-lab', 'lab'],
]);
assert.equal(getProtectedExamKey(examId), examId);
for (const profile of metadata.profiles) {
  assert.equal(getProtectedProfileKey(examId, profile.id), profile.id);
}

const ids = (query) => filterAndSortExamLibrary(liveVisibleExamConfigs, {
  query,
  vendor: 'all',
  lifecycle: 'all',
  sort: 'recommended',
}).map(({ id }) => id);
for (const query of ['Python', 'Python Next Generation', 'Certiport', 'Certiport Python']) {
  assert.ok(ids(query).includes(examId), `${query} must find Python Next Generation.`);
}
assert.match(app, /getExamConfigByRouteSlug\(parts\[1\]\)/);
assert.match(app, /getStrictProfileForRouteAction|strictBetaProfiles/);
assert.match(browseSpec, /\/exams\/python-next-generation/);
assert.match(browseSpec, /Start No-Lab/);
assert.match(browseSpec, /Start Lab/);

const staffRoles = accessContract.match(/m\.role in \(([^)]+)\)/)?.[1]
  .match(/'[^']+'/g)?.map((role) => role.slice(1, -1)) ?? [];
assert.deepEqual(staffRoles, [
  'developer',
  'platform_owner',
  'college_admin',
  'campus_admin',
  'trainer',
  'reception',
]);
assert.match(accessContract, /has_staff_profile_access[\s\S]*activation_kind='production' and a\.enabled/);
assert.match(accessContract, /has_student_profile_entitlement[\s\S]*m\.status='active' and m\.role='student'[\s\S]*exam_entitlements/);
assert.match(accessContract, /can_use_profile[\s\S]*has_staff_profile_access[\s\S]*has_student_profile_entitlement/);
assert.match(accessSpec, /role: 'platform_owner'/);
assert.match(accessSpec, /role: 'student'/);
assert.match(accessSpec, /access_not_granted/);
assert.match(accessSpec, /attemptPosts/);

for (const field of ['questionBank', 'caseStudyBlocks', 'shortCaseStudyBlocks', 'demoLabs']) {
  assert.deepEqual(exam[field], [], `${field} must remain empty in the browser registry.`);
}
const browserSafeProjection = JSON.stringify({ display, metadata, exam });
for (const forbidden of [
  'correctAnswer',
  'correctOptionIds',
  'gradingMaterial',
  'gradingRules',
  'hiddenTests',
  'materialDigest',
  'modelSolution',
  'privateScoring',
]) {
  assert.doesNotMatch(browserSafeProjection, new RegExp(forbidden, 'i'));
}

console.log(JSON.stringify({
  ok: true,
  issue: 86,
  examId,
  liveVisible: true,
  profiles: metadata.profiles.length,
  inventory: metadata.inventoryCount,
  staffRoles,
  studentEntitlementServerAuthoritative: true,
  protectedBrowserContent: 0,
}));
