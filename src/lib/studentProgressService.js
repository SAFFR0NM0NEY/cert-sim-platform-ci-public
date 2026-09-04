import { getMyAssignmentProgress } from './assignmentProgressService.js';
import {
  buildExamProgressRows,
  evaluateExamReadiness,
  EXAM_READINESS_DISCLAIMER,
  MIN_FULL_READINESS_ATTEMPTS,
  normalizeProgressAssignment,
  normalizeProgressResult,
  percentageToComparableReadinessScore,
} from './examReadinessRules.js';
import { getMySavedResults } from './savedResultsService.js';
import { isAssessmentResult } from './attemptPurpose.js';
import { createProtectedExamClient } from './protectedExamClient.js';
import { loadProtectedHistoryPage, normalizeProtectedHistoryResult, partitionProtectedHistory } from './protectedHistory.js';
import { getNormalizedDomainItems } from './resultStorageMappers.js';

const IS_PROTECTED_DELIVERY = typeof __CERTSIM_BUILD_DELIVERY_MODE__ !== 'undefined'
  && __CERTSIM_BUILD_DELIVERY_MODE__ === 'protected';

const ASSIGNMENT_PROGRESS_TIMEOUT_MS = 8000;
const PROTECTED_EXAM_KEYS = ['az204', 'security-plus-sy0-701', 'az400', 'ai901'];

export const STUDENT_HISTORY_NOTE =
  'Cloud history saves only when you are signed in. It includes eligible scored exam results saved before and after protected delivery. Practice stays visible but does not affect formal readiness; only records whose original purpose cannot be proven remain historical activity.';

export const STUDENT_DOMAIN_HISTORY_NOTE =
  'Older saved results may not include domain breakdowns. Newer saved results include domain and weak-area analytics when the completed result provides them.';

export async function getStudentProgressSnapshot({ authUser = null, identity = null } = {}) {
  const savedSnapshotResult = await getStudentSavedProgressSnapshot({ authUser });

  if (!savedSnapshotResult.ok) {
    return savedSnapshotResult;
  }

  const assignmentSnapshotResult = await getStudentProgressAssignmentSnapshot({
    baseSnapshot: savedSnapshotResult.data,
    identity,
    userId: authUser?.id ?? '',
  });

  if (!assignmentSnapshotResult.ok) {
    return {
      ok: true,
      data: {
        ...savedSnapshotResult.data,
        assignmentLoadWarning: assignmentSnapshotResult.message,
      },
    };
  }

  return assignmentSnapshotResult;
}

export async function getStudentSavedProgressSnapshot({ authUser = null, session = null } = {}) {
  const resultsResult = IS_PROTECTED_DELIVERY
    ? await getProtectedSavedResults({ authUser, session })
    : await getLegacySavedResults();

  if (!resultsResult.ok) {
    warnProgressQueryFailure('saved-results', resultsResult);
    return {
      ok: false,
      reason: resultsResult.reason || 'saved_results_failed',
      message: 'Could not load saved attempts.',
      errorCode: resultsResult.errorCode,
    };
  }

  return {
    ok: true,
    data: buildStudentProgressSnapshot({
      authUser,
      rawResults: resultsResult.data ?? [],
      historySummaries: resultsResult.summaries ?? {},
    }),
  };
}

export async function getStudentProgressAssignmentSnapshot({
  baseSnapshot,
  identity,
  loadAssignmentProgress = getMyAssignmentProgress,
  userId = '',
} = {}) {
  const assignmentsResult = await withProgressTimeout(
    loadAssignmentProgress({ identity, userId }),
    ASSIGNMENT_PROGRESS_TIMEOUT_MS,
    'Assignments could not be loaded, but saved progress is still shown.',
  );

  if (!assignmentsResult.ok) {
    warnProgressQueryFailure('assignments', assignmentsResult);
    return {
      ok: false,
      reason: assignmentsResult.reason || 'assignment_progress_failed',
      message: 'Assignments could not be loaded, but saved progress is still shown.',
      errorCode: assignmentsResult.errorCode,
    };
  }

  return {
    ok: true,
    data: buildStudentProgressSnapshot({
      assignmentSnapshot: assignmentsResult.data,
      baseSnapshot,
      rawResults: baseSnapshot?.results ?? [],
    }),
  };
}

export function buildStudentProgressSnapshot({
  assignmentSnapshot = {
    assignments: [],
    summary: createEmptyAssignmentSummary(),
  },
  authUser = null,
  baseSnapshot = null,
  rawResults = [],
  historySummaries = baseSnapshot?.historySummaries ?? {},
} = {}) {
  const studentFromBase = baseSnapshot?.student ?? {};
  const accountEmail = authUser?.email || studentFromBase.email || '';
  const userId =
    authUser?.id ||
    studentFromBase.userId ||
    rawResults[0]?.userId ||
    'current-user';
  const allResults = rawResults
    .map((result) => ({
      ...normalizeProgressResult(result),
      userId: result.userId || userId,
    }))
    .sort((left, right) => right.submittedTime - left.submittedTime);
  const results = allResults.filter(isAssessmentResult);
  const scoredResults = results.filter((result) => result.score !== null);
  const passFailResults = results.filter((result) => typeof result.passed === 'boolean');
  const history = partitionProtectedHistory(allResults);
  const currentStudent = {
    displayName:
      studentFromBase.displayName ||
      getNameFromEmail(accountEmail) ||
      'Current student',
    email: accountEmail,
    groupId: studentFromBase.groupId || '',
    groupName: studentFromBase.groupName || '',
    userId: userId || results[0]?.userId || '',
  };
  const assignments = (assignmentSnapshot.assignments ?? [])
    .map((assignment) => ({
      ...normalizeProgressAssignment(assignment),
      groupId: assignment.groupId || currentStudent.groupId || '',
      studentUserId: currentStudent.userId || assignment.studentUserId || '',
    }));
  const summarizedExamResults = Object.entries(historySummaries)
    .filter(([, summary]) => Number(summary?.completedCount ?? 0) > 0)
    .filter(([examKey]) => !results.some((result) => result.examScopeKey === normalizeProgressResult({ examKey }).examScopeKey))
    .map(([examKey, summary]) => normalizeProgressResult({
      attemptId: summary.latest?.attemptId,
      examKey,
      passed: null,
      purpose: 'self_directed_exam',
      score: summary.latest?.percentage,
      submittedAt: summary.latest?.completedAt,
      userId,
    }));
  const examProgress = applyHistorySummaries(buildExamProgressRows({
    assignments,
    results: [...results, ...summarizedExamResults],
    students: [currentStudent],
  }), historySummaries);
  const assignmentsNeedingAttention = getAssignmentsNeedingAttention({
    assignments,
    examProgress,
  });

  return {
    assignmentProgress: assignmentSnapshot.summary ?? createEmptyAssignmentSummary(),
    assignmentLoadWarning: '',
    assignments,
    assignmentsNeedingAttention,
    domainHistoryNote: STUDENT_DOMAIN_HISTORY_NOTE,
    examProgress,
    historyNote: STUDENT_HISTORY_NOTE,
    progress: {
      assignedExamCount: assignments.length,
      assignedNotStartedCount: assignmentsNeedingAttention.filter(
        (assignment) => assignment.status === 'not-started',
      ).length,
      examsAttemptedCount: Object.values(historySummaries).filter((summary) => Number(summary?.completedCount ?? 0) > 0).length || new Set(results.map((result) => result.examScopeKey).filter(Boolean)).size,
      averageScore: getSummaryWeightedAverage(historySummaries) ?? (scoredResults.length ? scoredResults.reduce((total, result) => total + result.score, 0) / scoredResults.length : null),
      bestScore: getSummaryBestScore(historySummaries) ?? (scoredResults.length ? Math.max(...scoredResults.map((result) => result.score)) : null),
      domainSampleCount: examProgress.reduce((total, row) => total + row.domainSampleCount, 0),
      latestActivity: allResults[0]?.submittedAt ?? '',
      latestScore: getLatestSummary(historySummaries)?.latest?.percentage ?? results[0]?.score ?? null,
      passRate: getSummaryPassRate(historySummaries) ?? (passFailResults.length
        ? (passFailResults.filter((result) => result.passed).length / passFailResults.length) * 100
        : null),
      overdueAssignmentCount: assignmentsNeedingAttention.filter(
        (assignment) => assignment.status === 'overdue',
      ).length,
      readinessDisclaimer: EXAM_READINESS_DISCLAIMER,
      requiredAttempts: MIN_FULL_READINESS_ATTEMPTS,
      totalSavedAttempts: getSummaryCompletedCount(historySummaries) ?? results.length,
      historicalActivityCount: history.historical.length,
      practiceActivityCount: history.practice.length,
      visibleActivityCount: allResults.length,
    },
    recentAttempts: allResults.slice(0, 8),
    assessmentHistory: results,
    results,
    visibleHistory: allResults,
    student: currentStudent,
    historySummaries,
  };
}

async function getLegacySavedResults() {
  const resultsResult = await getMySavedResults();
  return resultsResult;
}

async function getProtectedSavedResults({ authUser, session }) {
  const accessToken = session?.access_token;
  if (!accessToken) return { ok: false, reason: 'not_signed_in', message: 'Sign in again to load account history.' };
  try {
    const client = createProtectedExamClient({ accessToken });
    const [history, summaries] = await Promise.all([
      loadProtectedHistoryPage(client, { pageSize: 20 }),
      Promise.all(PROTECTED_EXAM_KEYS.map(async (examKey) => [examKey, await client.getHistorySummary(examKey)])),
    ]);
    return {
      ok: true,
      data: history.items.map((item) => normalizeProtectedHistoryResult(item, authUser?.id ?? '')),
      summaries: Object.fromEntries(summaries),
    };
  } catch (error) {
    return { ok: false, reason: 'request_failed', message: error?.message || 'Could not load protected account history.' };
  }
}

export function applyHistorySummaries(rows, summaries) {
  return rows.map((row) => {
    const summary = summaries[row.examScopeKey];
    if (!summary || Number(summary.completedCount ?? 0) === 0) return row;
    const totalAttempts = Number(summary.completedCount);
    const passedCount = Number(summary.passedCount ?? 0);
    const needsReviewCount = Number(summary.needsReviewCount ?? 0);
    const passFailCount = passedCount + needsReviewCount;
    const domainAverages = getNormalizedDomainItems(summary.weakDomains);
    const weakDomainCount = domainAverages.filter((domain) => domain.percentage != null && domain.percentage < 70).length;
    // Display values remain percentages; readiness comparisons use the shared
    // 0-1000 comparable score boundary.
    const latestScore = toNullableNumber(summary.latest?.percentage);
    const bestScore = toNullableNumber(summary.best?.percentage);
    const averageScore = toNullableNumber(summary.averagePercentage);
    const passRate = passFailCount ? 100 * passedCount / passFailCount : null;
    const readiness = evaluateExamReadiness({
      averageScore: percentageToComparableReadinessScore(averageScore),
      bestScore: percentageToComparableReadinessScore(bestScore),
      latestScore: percentageToComparableReadinessScore(latestScore),
      needsReviewCount,
      passRate,
      totalAttempts,
      weakDomainCount,
    });
    return {
      ...row,
      averageScore,
      bestScore,
      domainAverages,
      domainSampleCount: domainAverages.length ? totalAttempts : 0,
      fullReadinessAvailable: totalAttempts >= MIN_FULL_READINESS_ATTEMPTS,
      fullReadinessMessage: totalAttempts >= MIN_FULL_READINESS_ATTEMPTS ? 'Full readiness available.' : `Need ${MIN_FULL_READINESS_ATTEMPTS - totalAttempts} more saved attempts for full readiness.`,
      latestAttemptDate: summary.latest?.completedAt ?? '',
      latestAttemptId: summary.latest?.attemptId ?? '',
      latestScore,
      needsReviewCount,
      passCount: passedCount,
      passRate,
      readinessLabel: readiness.label,
      readinessReason: readiness.reason,
      readinessStatus: readiness.status,
      scopedAttemptCount: totalAttempts,
      weakDomainCount,
      weakestDomain: [...domainAverages].sort((a, b) => (a.percentage ?? 101) - (b.percentage ?? 101))[0] ?? null,
    };
  });
}

function getSummaryCompletedCount(summaries) {
  const values = Object.values(summaries);
  return values.length ? values.reduce((total, summary) => total + Number(summary.completedCount ?? 0), 0) : null;
}

function getSummaryBestScore(summaries) {
  const values = Object.values(summaries).map((summary) => toNullableNumber(summary.best?.percentage)).filter((value) => value !== null);
  return values.length ? Math.max(...values) : null;
}

function getLatestSummary(summaries) {
  return Object.values(summaries).filter((summary) => summary?.latest?.completedAt).sort((a, b) => Date.parse(b.latest.completedAt) - Date.parse(a.latest.completedAt))[0] ?? null;
}

function getSummaryPassRate(summaries) {
  const values = Object.values(summaries);
  if (!values.length) return null;
  const passed = values.reduce((total, summary) => total + Number(summary.passedCount ?? 0), 0);
  const decided = passed + values.reduce((total, summary) => total + Number(summary.needsReviewCount ?? 0), 0);
  return decided ? 100 * passed / decided : null;
}

function getSummaryWeightedAverage(summaries) {
  const values = Object.values(summaries).filter((summary) => toNullableNumber(summary.averagePercentage) !== null && Number(summary.scoredCount ?? 0) > 0);
  const count = values.reduce((total, summary) => total + Number(summary.scoredCount), 0);
  return count ? values.reduce((total, summary) => total + Number(summary.averagePercentage) * Number(summary.scoredCount), 0) / count : null;
}

function toNullableNumber(value) {
  return value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
}

function createEmptyAssignmentSummary() {
  return {
    archived: 0,
    closed: 0,
    completed: 0,
    'due-soon': 0,
    'in-progress': 0,
    'not-started': 0,
    overdue: 0,
    total: 0,
  };
}

function getAssignmentsNeedingAttention({ assignments, examProgress }) {
  return assignments
    .map((assignment) => {
      const progress = examProgress.find(
        (row) => row.examScopeKey === assignment.examScopeKey,
      );
      const assignmentSummary = progress?.assignmentSummaries?.find(
        (summary) => summary.id === assignment.id,
      );
      const status = getStudentAssignmentStatus({
        assignment,
        progress,
        summary: assignmentSummary,
      });

      return {
        ...assignment,
        averageScore: progress?.averageScore ?? null,
        bestScore: progress?.bestScore ?? null,
        latestAttemptDate: progress?.latestAttemptDate ?? '',
        latestAttemptId: progress?.latestAttemptId ?? '',
        latestScore: progress?.latestScore ?? null,
        readinessLabel: progress?.readinessLabel ?? 'Not started',
        readinessStatus: progress?.readinessStatus ?? 'not-started',
        scopedAttemptCount: progress?.scopedAttemptCount ?? 0,
        status: status.status,
        statusLabel: status.label,
      };
    })
    .filter((assignment) =>
      ['not-started', 'overdue', 'due-soon', 'insufficient-data', 'almost-ready', 'needs-review', 'at-risk']
        .includes(assignment.status),
    )
    .sort((left, right) => getAttentionPriority(left.status) - getAttentionPriority(right.status));
}

function getStudentAssignmentStatus({ assignment, progress, summary }) {
  if (!progress || progress.scopedAttemptCount === 0) {
    if (summary?.label?.startsWith('Overdue') || assignment.progressStatus === 'overdue') {
      return { label: 'Overdue - no attempt submitted', status: 'overdue' };
    }

    if (summary?.label === 'Due soon' || assignment.progressStatus === 'due-soon') {
      return { label: 'Due soon', status: 'due-soon' };
    }

    return { label: 'Not started', status: 'not-started' };
  }

  if (progress.readinessStatus === 'ready') {
    return { label: 'Ready', status: 'ready' };
  }

  return {
    label: progress.readinessLabel,
    status: progress.readinessStatus,
  };
}

function getAttentionPriority(status) {
  return {
    overdue: 1,
    'at-risk': 2,
    'needs-review': 3,
    'due-soon': 4,
    'insufficient-data': 5,
    'almost-ready': 6,
    'not-started': 7,
  }[status] ?? 99;
}

function getNameFromEmail(email) {
  const text = String(email ?? '').trim();

  return text.includes('@') ? text.split('@')[0] : '';
}

async function withProgressTimeout(promise, timeoutMs, timeoutMessage) {
  let timeoutId;
  const guardedPromise = Promise.resolve(promise).catch((error) => ({
    ok: false,
    reason: 'request_failed',
    message: error?.message || timeoutMessage,
    errorCode: error?.code,
  }));
  const timeoutPromise = new Promise((resolve) => {
    timeoutId = setTimeout(
      () =>
        resolve({
          ok: false,
          reason: 'request_timeout',
          message: timeoutMessage,
        }),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([guardedPromise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function warnProgressQueryFailure(label, result) {
  if (!import.meta.env?.DEV) {
    return;
  }

  console.warn('CertSim student progress query failed', {
    errorCode: result?.errorCode,
    label,
    message: result?.message,
    reason: result?.reason,
  });
}
