import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  getAssignedExamAction,
  getAssignedExamLaunchRoute,
} from '../src/lib/assignedExamLaunch.js';

const assignmentId = '15000000-0000-4000-8000-000000000001';
const base = {
  id: assignmentId,
  contractVersion: 'live-v2',
  examKey: 'sc200',
  profileId: 'sc200-full',
  status: 'active',
  attemptsRemaining: 1,
};
const launchRoute = getAssignedExamLaunchRoute(base);
assert.equal(launchRoute, `/exams/sc200/full?assignment=${assignmentId}`);
assert.equal(getAssignedExamLaunchRoute({ ...base, profileId: 'unknown' }), '');
assert.equal(getAssignedExamLaunchRoute({ ...base, id: 'not-a-uuid' }), '');

const action = (overrides = {}, now = Date.parse('2026-09-06T12:00:00Z')) =>
  getAssignedExamAction({ ...base, assignmentLaunchRoute: launchRoute, ...overrides }, now);
assert.deepEqual(action(), {
  enabled: true, href: launchRoute, kind: 'start', label: 'Start assigned exam', reason: '',
});
assert.equal(action({ activeAttempt: { attemptId: 'opaque' }, attemptsRemaining: 0 }).kind, 'resume');
assert.equal(action({ latestResult: { attemptId: 'opaque' }, savedResultRoute: '/account/results/opaque' }).kind, 'result');
assert.match(action({ attemptsRemaining: 0 }).reason, /attempt limit/i);
assert.match(action({ availableFrom: '2026-09-07T12:00:00Z' }).reason, /Available/);
assert.match(action({ dueAt: '2026-09-05T12:00:00Z' }).reason, /expired/i);
assert.match(action({ status: 'revoked' }).reason, /revoked/i);
assert.match(action({ status: 'closed' }).reason, /closed/i);
assert.match(action({ status: 'archived' }).reason, /archived/i);

const assignmentService = await readFile(new URL('../src/lib/assignmentProgressService.js', import.meta.url), 'utf8');
const panel = await readFile(new URL('../src/components/account/MyAssignmentsPanel.jsx', import.meta.url), 'utf8');
const registry = await readFile(new URL('../src/exams/examRegistry.protected.js', import.meta.url), 'utf8');
const contract = await readFile(new URL('../src/lib/protectedExamContract.js', import.meta.url), 'utf8');
assert.match(assignmentService, /listCurrentAttemptBindings\(examKey, 'self_directed_exam'\)/);
assert.match(assignmentService, /candidate\.assignmentId === assignmentId/);
assert.match(assignmentService, /candidate\.profileKey === assignment\.profileId/);
assert.match(panel, /assignment\.learnerAction\.label/);
assert.match(panel, /assignment-action-unavailable/);
assert.match(registry, /id:'sc200', lifecycle:EXAM_LIFECYCLES\.productionReady/);
assert.match(contract, /sc200:\s*'sc200'/);
assert.match(contract, /sc200:\s*Object\.freeze\(\[\s*'sc200-full'/);
assert.doesNotMatch(panel, /correctAnswer|explanation|protectedPayload/);

console.log('Issue #83 assigned launch validation passed.');
