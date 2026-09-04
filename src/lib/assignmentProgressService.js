import {
  listAssignmentsForTrainerScope,
  listMyAssignments,
} from './examAssignmentService.js';
import { normalizeExamScopeKey } from './examReadinessRules.js';
import { getMySavedResults } from './savedResultsService.js';
import { getTrainerDashboardSnapshot } from './trainerDashboardService.js';
import { createProtectedExamClient } from './protectedExamClient.js';
import { supabase } from './supabaseClient.js';

const IS_PROTECTED_DELIVERY = typeof __CERTSIM_BUILD_DELIVERY_MODE__ !== 'undefined'
  && __CERTSIM_BUILD_DELIVERY_MODE__ === 'protected';

const DUE_SOON_DAYS = 7;
const MAX_PROTECTED_HISTORY_PAGES = 20;

export async function getMyAssignmentProgress({ identity, userId = '' } = {}) {
  if (!identity || !userId) {
    return createErrorResult('identity_failed', 'Could not load the current profile and memberships.');
  }
  const assignmentsResult = await listMyAssignments({ identity, userId });

  if (!assignmentsResult.ok) {
    return assignmentsResult;
  }

  const resultsResult = IS_PROTECTED_DELIVERY
    ? await getMyProtectedAssignmentHistory()
    : await getMySavedResults();

  const currentUserId = userId;
  const results = (resultsResult.ok ? resultsResult.data : []).map((result) => ({
    ...result,
    userId: result.userId ?? currentUserId,
  }));
  let assignments = matchResultsToAssignments(
    assignmentsResult.data,
    results,
    identity.memberships ?? [],
  );
  if (resultsResult.complete === false) {
    assignments = assignments.map((assignment) => assignment.progressStatus === 'not-started'
      ? { ...assignment, progressLabel: 'History still loading', progressReason: 'Older protected history was not fully inspected.', progressStatus: 'history-incomplete' }
      : assignment);
  }

  return createOkResult({
    assignments,
    historyEnrichmentComplete: resultsResult.complete !== false,
    results,
    summary: createProgressSummary(assignments),
  });
}

async function getMyProtectedAssignmentHistory() {
  const { data, error } = await supabase.auth.getSession();
  const accessToken = data?.session?.access_token;
  if (error || !accessToken) {
    return createErrorResult('not_signed_in', 'Sign in again to load assignment progress.');
  }
  try {
    const client = createProtectedExamClient({ accessToken });
    const collected = await collectProtectedHistoryPages(client);
    return { ...createOkResult(collected.items.map((item) => ({
      ...item,
      submittedAt: item.completedAt,
      examScopeKey: item.examKey,
    }))), complete: collected.complete };
  } catch (historyError) {
    return createErrorResult('history_unavailable', historyError?.message || 'Assignment history is temporarily unavailable.');
  }
}

export async function collectProtectedHistoryPages(client, maximumPages = MAX_PROTECTED_HISTORY_PAGES) {
    const items = [];
    let cursor;
    let complete = false;
    for (let pageNumber = 0; pageNumber < maximumPages; pageNumber += 1) {
      const page = await client.listHistory({ cursor, pageSize: 50 });
      items.push(...(page.items ?? []));
      if (!page.nextCursor) {
        complete = true;
        break;
      }
      cursor = page.nextCursor;
    }
    return { complete, items };
}

export async function getTrainerAssignmentProgress() {
  const [assignmentsResult, dashboardResult] = await Promise.all([
    listAssignmentsForTrainerScope(),
    getTrainerDashboardSnapshot(),
  ]);
  const failedResult = [assignmentsResult, dashboardResult].find(
    (result) => !result.ok,
  );

  if (failedResult) {
    return failedResult;
  }

  return createOkResult(
    getAssignmentProgressSnapshot({
      assignments: assignmentsResult.data,
      memberships: dashboardResult.data.students,
      results: dashboardResult.data.results,
    }),
  );
}

export function getAssignmentProgressSnapshot({
  assignments = [],
  memberships = [],
  results = [],
} = {}) {
  const trackedAssignments = matchResultsToAssignments(
    assignments,
    results,
    memberships,
  );

  return {
    assignments: trackedAssignments,
    results,
    summary: createProgressSummary(trackedAssignments),
  };
}

export function matchResultsToAssignments(
  assignments = [],
  results = [],
  memberships = [],
) {
  const normalizedMemberships = memberships.map(normalizeMembership);
  const inferredAssignmentByResult = new Map();
  results.filter((result) => !result.assignmentId).forEach((result) => {
    const candidates = assignments.filter((assignment) =>
      isLegacyResultCandidate(assignment, result, normalizedMemberships));
    if (candidates.length === 1) {
      inferredAssignmentByResult.set(result, candidates[0].assignmentId || candidates[0].id);
    }
  });

  return assignments.map((assignment) => {
    const targetStudents = getTargetStudents(assignment, normalizedMemberships);
    const targetUserIds = new Set(
      targetStudents.map((student) => student.userId).filter(Boolean),
    );
    const matchedResults = results
      .filter((result) =>
        isResultMatchForAssignment({
          assignment,
          result,
          targetUserIds,
          targetStudents,
          inferredAssignmentId: inferredAssignmentByResult.get(result),
        }),
      )
      .sort((left, right) => getResultTime(right) - getResultTime(left));
    const resultByStudent = groupLatestResultByUser(matchedResults);
    const studentResults = targetStudents
      .map((student) => ({
        ...student,
        result: resultByStudent.get(student.userId) ?? null,
      }))
      .filter((student) => student.result);
    const latestResult = matchedResults[0] ?? null;
    const completedCount = getCompletedCount({
      assignment,
      matchedResults,
      resultByStudent,
      targetStudents,
    });
    const totalStudents = getTotalStudentCount(assignment, targetStudents);
    const status = getAssignmentStatus(assignment, latestResult, {
      completedCount,
      totalStudents,
    });

    return {
      ...assignment,
      completedCount,
      latestResult,
      progressLabel: status.label,
      progressReason: status.reason,
      progressStatus: status.status,
      resultMatches: matchedResults,
      savedResultRoute: latestResult?.attemptId
        ? `/account/results/${latestResult.attemptId}`
        : '',
      studentResults,
      targetStudents,
      totalStudents,
    };
  });
}

export function getAssignmentStatus(
  assignment,
  matchedResult,
  { completedCount = matchedResult ? 1 : 0, totalStudents = 1 } = {},
) {
  const recordStatus = normalizeText(assignment?.status || 'active');

  if (totalStudents > 0 && completedCount >= totalStudents) {
    return createStatus('completed', 'Attempted');
  }

  if (completedCount > 0) {
    return createStatus('in-progress', 'Some attempted');
  }

  if (recordStatus === 'archived') {
    return createStatus('archived', 'Archived');
  }

  if (recordStatus === 'closed') {
    return createStatus('closed', 'Closed');
  }

  const dueTime = parseTime(assignment?.dueAt);
  const now = Date.now();

  if (dueTime && dueTime < now) {
    return createStatus('overdue', 'Overdue');
  }

  if (dueTime && dueTime - now <= DUE_SOON_DAYS * 24 * 60 * 60 * 1000) {
    return createStatus('due-soon', 'Due soon');
  }

  return createStatus('not-started', 'Not started');
}

function getTargetStudents(assignment, memberships) {
  if (assignment.studentUserId) {
    const matchedStudent = memberships.find(
      (membership) => membership.userId === assignment.studentUserId,
    );

    return [
      matchedStudent ?? {
        displayName: assignment.studentName || 'Assigned student',
        email: assignment.studentEmail || '',
        groupId: assignment.groupId || '',
        groupName: assignment.groupName || '',
        userId: assignment.studentUserId,
      },
    ];
  }

  if (assignment.groupId) {
    return memberships.filter(
      (membership) => membership.groupId === assignment.groupId,
    );
  }

  return [];
}

function isResultMatchForAssignment({
  assignment,
  inferredAssignmentId,
  result,
  targetStudents,
  targetUserIds,
}) {
  if ((result.assignmentId || inferredAssignmentId) !== (assignment.assignmentId || assignment.id)) {
    return false;
  }

  if (!isSameExam(assignment, result)) {
    return false;
  }

  if (!isResultAfterAssignment(assignment, result)) {
    return false;
  }

  const resultUserId = normalizeText(result.userId);

  if (assignment.studentUserId) {
    return resultUserId
      ? resultUserId === assignment.studentUserId
      : targetStudents.length <= 1;
  }

  if (assignment.groupId) {
    return resultUserId
      ? targetUserIds.has(resultUserId)
      : targetStudents.some((student) => student.groupId === assignment.groupId);
  }

  return false;
}

function isLegacyResultCandidate(assignment, result, memberships) {
  if (!isSameExam(assignment, result) || !isResultAfterAssignment(assignment, result)) return false;
  const completedAt = getResultTime(result);
  const dueAt = parseTime(assignment.dueAt);
  if (completedAt && dueAt && completedAt > dueAt) return false;
  const targets = getTargetStudents(assignment, memberships);
  const userId = normalizeText(result.userId);
  if (assignment.studentUserId) {
    return userId ? userId === assignment.studentUserId : targets.length === 1;
  }
  return Boolean(assignment.groupId && (userId
    ? targets.some((student) => student.userId === userId)
    : targets.length === 1));
}

function isSameExam(assignment, result) {
  const assignmentKeys = [
    assignment.examKey,
    assignment.examSlug,
    assignment.examCatalog?.examKey,
    assignment.examCatalog?.slug,
  ]
    .map(normalizeExamScopeKey)
    .filter(Boolean);
  const resultKey = normalizeExamScopeKey(
    result.examKey || result.examSlug || result.examScopeKey,
  );

  return Boolean(resultKey && assignmentKeys.includes(resultKey));
}

function isResultAfterAssignment(assignment, result) {
  const assignmentTime = parseTime(assignment.createdAt);
  const resultTime = getResultTime(result);

  return !assignmentTime || !resultTime || resultTime >= assignmentTime;
}

function groupLatestResultByUser(results) {
  const map = new Map();

  results.forEach((result) => {
    const userId = normalizeText(result.userId);

    if (!userId || map.has(userId)) {
      return;
    }

    map.set(userId, result);
  });

  return map;
}

function getCompletedCount({
  assignment,
  matchedResults,
  resultByStudent,
  targetStudents,
}) {
  if (assignment.studentUserId) {
    return matchedResults.length > 0 ? 1 : 0;
  }

  if (targetStudents.length === 0) {
    return matchedResults.length > 0 ? 1 : 0;
  }

  return targetStudents.filter((student) => resultByStudent.has(student.userId))
    .length;
}

function getTotalStudentCount(assignment, targetStudents) {
  if (assignment.studentUserId) {
    return 1;
  }

  return targetStudents.length;
}

function createProgressSummary(assignments) {
  return assignments.reduce(
    (summary, assignment) => ({
      ...summary,
      [assignment.progressStatus]:
        (summary[assignment.progressStatus] ?? 0) + 1,
      total: summary.total + 1,
    }),
    {
      archived: 0,
      closed: 0,
      completed: 0,
      'due-soon': 0,
      'in-progress': 0,
      'history-incomplete': 0,
      'not-started': 0,
      overdue: 0,
      total: 0,
    },
  );
}

function normalizeMembership(membership = {}) {
  const profile = membership.profile ?? {};

  return {
    displayName:
      membership.displayName ||
      membership.studentName ||
      profile.display_name ||
      profile.full_name ||
      getNameFromEmail(membership.email || profile.email) ||
      'Student',
    email: membership.email || profile.email || '',
    groupId: membership.groupId || membership.group_id || '',
    groupName: membership.groupName || membership.group?.name || '',
    role: membership.role || '',
    status: membership.status || '',
    userId:
      membership.userId ||
      membership.user_id ||
      membership.studentUserId ||
      profile.id ||
      '',
  };
}

function createStatus(status, label, reason = '') {
  return {
    label,
    reason,
    status,
  };
}

function getResultTime(result) {
  return (
    parseTime(result?.submittedAt) ||
    parseTime(result?.savedAt) ||
    parseTime(result?.createdAt)
  );
}

function parseTime(value) {
  if (!value) {
    return 0;
  }

  const time = new Date(value).getTime();

  return Number.isNaN(time) ? 0 : time;
}

function getNameFromEmail(email) {
  const text = normalizeText(email);

  return text.includes('@') ? text.split('@')[0] : '';
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function createOkResult(data) {
  return {
    ok: true,
    data,
  };
}

function createErrorResult(reason, message) {
  return {
    ok: false,
    reason,
    message,
  };
}
