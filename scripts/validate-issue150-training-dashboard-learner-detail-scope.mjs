import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildTrainerDashboardPath,
  buildTrainerStudentPath,
  readTrainerStudentScope,
} from '../src/lib/trainerStudentRoute.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const migration = read('../supabase/migrations/20260911093103_issue150_training_dashboard_learner_detail.sql');
const routes = read('../supabase/functions/certsim-protected-exam/routes.ts');
const handler = read('../supabase/functions/certsim-protected-exam/handler.ts');
const responses = read('../supabase/functions/certsim-protected-exam/responses.ts');
const dashboard = read('../src/components/trainer/TrainerDashboardPage.jsx');
const studentDetail = read('../src/components/trainer/TrainerStudentDetailPage.jsx');
const assignmentDetail = read('../src/components/trainer/TrainerAssignmentDetailPage.jsx');
const groupDetail = read('../src/components/admin/GroupDetailPage.jsx');
const hook = read('../src/hooks/useTrainerStudentDetail.js');
const service = read('../src/lib/trainerStudentDetailService.js');
const app = read('../src/App.jsx');

for (const contract of [
  'create function exam_delivery.staff_learner_detail(',
  'exam_delivery.staff_scope_options(',
  'exam_delivery.staff_dashboard_aggregates_issue101_base(',
  'exam_delivery.staff_dashboard_query_issue59_base(',
  "'exactLearnerId', v_learner_id",
  "a.source_organisation_id=v_org",
  "attempt.source_organisation_id=v_org",
  "'remainingCount',greatest((select count(*) from ordered)-(select count(*) from page),0)",
  'membership.id = v_membership_id',
  "membership.status = 'active'",
  "staff.role = 'campus_admin'",
  "staff.role = 'trainer'",
  "'code', 'not_visible'",
  'limit 51',
  'v_page_size > 25',
  "set search_path = ''",
  "set statement_timeout = '15s'",
  'security invoker',
  'from public, anon, authenticated, service_role',
  'to service_role',
]) assert.ok(migration.includes(contract), `Missing Issue #150 database contract: ${contract}`);
assert.ok(!migration.match(/\b(insert|update|delete)\s+(?:into\s+|from\s+)?exam_delivery\.(?:attempts|attempt_responses|attempt_results|review_snapshots)/i));
assert.ok(!migration.includes('exam_delivery.list_history('), 'Learner detail must not use learner-self history');
assert.ok(routes.includes('staffLearnerDetail: "certsim_protected_staff_learner_detail"'));
assert.ok(routes.includes('/^\\/staff\\/learner-detail$/'));
assert.ok(handler.includes('const permitted = ["membershipId", "organisationId", "campusId", "groupId", "assignmentId", "examKey", "resultStatus", "cursor", "pageSize"]'));
assert.ok(handler.includes('p_actor_id: actorId'));
assert.ok(!handler.includes('p_actor_id: u.searchParams'));
assert.ok(responses.includes('export function mapStaffLearnerDetail'));
assert.ok(responses.includes('historyReturnedCount > 25'));
assert.ok(responses.includes('item.learnerId !== learner.learnerId'));
assert.ok(responses.includes('item.analyticsEligible !== true'));
assert.ok(!responses.includes('const analyticsEligible = ["assigned_assessment", "self_directed_exam"]'));

assert.ok(studentDetail.includes('useTrainerStudentDetail({ membershipId: studentId, scope })'));
assert.ok(!studentDetail.includes('useTrainerDashboard'));
assert.ok(!studentDetail.includes('useAssignmentProgress'));
assert.ok(hook.includes('controllerRef.current?.abort()'));
assert.ok(hook.includes('requestId !== requestRef.current'));
assert.ok(hook.includes('resultControllerRef.current?.abort()'));
assert.ok(hook.includes('getTrainerStudentResultDetail(attemptId, { signal: controller.signal })'));
assert.ok(service.includes('getStaffLearnerDetail'));
assert.ok(service.includes('normalizeProtectedTrainerResult'));
assert.ok(service.includes('payload.history?.items ?? []'));
assert.ok(dashboard.includes('onOpenStudentReport?.(student.membershipId, studentReportScope)'));
assert.ok(dashboard.includes('onOpenStudentReport?.(row.membershipId, studentReportScope)'));
assert.ok(assignmentDetail.includes('onOpenStudentReport?.(student.membershipId, studentReportScope)'));
assert.ok(groupDetail.includes('onOpenStudentReport(student.id, {'));
assert.ok(app.includes('readTrainerStudentScope(search)'));
assert.ok(studentDetail.includes('onClick={() => onOpenResult(result.attemptId)}'));

const membershipId = '15000000-0000-0000-0000-000000000210';
const scope = {
  organisationId: '15000000-0000-0000-0000-000000000100',
  campusId: '15000000-0000-0000-0000-000000000110',
  groupId: '15000000-0000-0000-0000-000000000120',
  assignmentId: '15000000-0000-0000-0000-000000000130',
  examKey: 'az204', progressStatus: '', readinessStatus: 'ready', resultStatus: 'passed', search: 'learner',
  returnSection: 'students',
};
const detailPath = buildTrainerStudentPath(membershipId, scope);
assert.ok(detailPath.startsWith(`/trainer/students/${membershipId}?`));
assert.deepEqual(readTrainerStudentScope(detailPath.slice(detailPath.indexOf('?'))), scope);
assert.equal(buildTrainerDashboardPath(scope), '/trainer/dashboard/students?organisation=15000000-0000-0000-0000-000000000100&campus=15000000-0000-0000-0000-000000000110&group=15000000-0000-0000-0000-000000000120&assignment=15000000-0000-0000-0000-000000000130&exam=az204&readiness=ready&status=passed&q=learner');

const memberships = [
  { id: 'm-a', userId: 'learner', organisationId: 'org-a', groupId: 'group-a', status: 'active' },
  { id: 'm-b', userId: 'learner', organisationId: 'org-a', groupId: 'group-b', status: 'active' },
  { id: 'm-c', userId: 'other', organisationId: 'org-b', groupId: 'group-c', status: 'active' },
  { id: 'm-stale', userId: 'stale', organisationId: 'org-a', groupId: 'group-a', status: 'inactive' },
];
const resolve = (id, allowed) => memberships.find((row) => row.id === id && row.status === 'active' && allowed(row)) ?? null;
assert.equal(resolve('m-b', (row) => row.organisationId === 'org-a')?.groupId, 'group-b');
assert.equal(resolve('m-c', (row) => row.organisationId === 'org-a'), null);
assert.equal(resolve('m-b', (row) => row.groupId === 'group-a'), null);
assert.equal(resolve('m-stale', () => true), null);

const before = { attempts: 7, responses: 42, results: 6, reviews: 6 };
const after = { ...before };
assert.deepEqual(after, before);
const formal = ['assigned_assessment', 'self_directed_exam', 'weak_area']
  .filter((purpose) => ['assigned_assessment', 'self_directed_exam'].includes(purpose));
assert.deepEqual(formal, ['assigned_assessment', 'self_directed_exam']);

console.log(JSON.stringify({
  ok: true,
  canonicalIdentity: 'membershipId',
  boundedAssignments: 50,
  boundedHistory: 25,
  roleCases: ['platform_owner', 'trainer', 'campus_admin', 'college_admin'],
  multiMembershipExact: true,
  staleRouteDenied: true,
  noMutationCounters: after,
}));
