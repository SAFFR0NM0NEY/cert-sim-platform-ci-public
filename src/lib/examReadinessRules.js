import { getNormalizedDomainItems } from './resultStorageMappers.js';
import { isAssessmentResult } from './attemptPurpose.js';

export const REAL_PASS_SCORE = 700;
export const READY_SCORE_THRESHOLD = 800;
export const ALMOST_READY_SCORE_THRESHOLD = 750;
export const MIN_FULL_READINESS_ATTEMPTS = 5;
export const AT_RISK_AVERAGE_SCORE = 650;
export const AT_RISK_FAILED_ATTEMPTS = 2;
export const READY_BEST_SCORE_THRESHOLD = 850;
export const READY_PASS_RATE_THRESHOLD = 80;
export const WEAK_DOMAIN_THRESHOLD = 70;
export const REVIEW_DOMAIN_THRESHOLD = 80;
const EXAM_TITLES = Object.freeze({
  ai901: 'Microsoft Azure AI Fundamentals',
  az204: 'AZ-204: Developing Solutions for Microsoft Azure',
  az400: 'AZ-400: Designing and Implementing Microsoft DevOps Solutions',
  'security-plus-sy0-701': 'Security+ SY0-701 Practice Exam',
});

export const EXAM_READINESS_DISCLAIMER =
  'Readiness is a CertSim practice indicator based on saved attempts for this exam. It is not an official exam prediction.';

export const EXAM_READINESS_STATUSES = [
  { id: 'ready', label: 'Ready' },
  { id: 'almost-ready', label: 'Almost ready' },
  { id: 'needs-review', label: 'Needs review' },
  { id: 'at-risk', label: 'At risk' },
  { id: 'insufficient-data', label: 'Insufficient data' },
  { id: 'not-started', label: 'Not started' },
];

export function buildExamProgressRows({
  assignments = [],
  results = [],
  students = [],
} = {}) {
  const assessmentResults = results.filter(isAssessmentResult);
  const studentRows =
    students.length > 0
      ? students
      : [
          {
            displayName: 'Current student',
            email: '',
            groupName: '',
            userId: assessmentResults[0]?.userId || assignments[0]?.studentUserId || 'current-user',
          },
        ];

  return studentRows.flatMap((student) => {
    const studentResults = assessmentResults
      .filter((result) => !student.userId || result.userId === student.userId)
      .sort((left, right) => getTime(right.submittedAt) - getTime(left.submittedAt));
    const studentAssignments = assignments.filter((assignment) =>
      assignmentTargetsStudent(assignment, student),
    );
    const examScopes = getStudentExamScopes(studentResults, studentAssignments);

    if (examScopes.length === 0) {
      return [
        buildExamProgressRow({
          activityResults: studentResults,
          assignments: [],
          examScope: {
            examKey: '',
            examScopeKey: '',
            examTitle: 'No exam data yet',
          },
          results: [],
          student,
        }),
      ];
    }

    return examScopes.map((examScope) =>
      buildExamProgressRow({
        activityResults: studentResults,
        assignments: studentAssignments.filter(
          (assignment) => assignment.examScopeKey === examScope.examScopeKey,
        ),
        examScope,
        results: studentResults.filter(
          (result) => result.examScopeKey === examScope.examScopeKey,
        ),
        student,
      }),
    );
  });
}

export function buildExamProgressRow({
  activityResults = [],
  assignments = [],
  examScope,
  results = [],
  student = {},
}) {
  const scoredResults = results.filter((result) => result.score !== null);
  const latestResult = results[0] ?? null;
  const latestScore = latestResult?.score ?? null;
  const bestScore = getMax(scoredResults.map((result) => result.score));
  const averageScore = getAverage(scoredResults.map((result) => result.score));
  const passCount = results.filter((result) => result.passed === true).length;
  const needsReviewCount = results.filter((result) => result.passed === false).length;
  const passFailCount = passCount + needsReviewCount;
  const passRate = passFailCount > 0 ? (passCount / passFailCount) * 100 : null;
  const activeAssignments = assignments.filter(
    (assignment) => !['archived', 'closed'].includes(assignment.status),
  );
  const hasOverdueNotStarted =
    results.length === 0 && activeAssignments.some((assignment) => isPastDue(assignment.dueAt));
  const hasDueSoonNotStarted =
    results.length === 0 && activeAssignments.some((assignment) => isDueSoon(assignment.dueAt));
  const domainAverages = buildDomainAverages(results);
  const domainSampleCount = results.filter(hasDomainEvidence).length;
  const weakDomainCount = domainAverages.filter(
    (domain) => domain.averagePercentage < WEAK_DOMAIN_THRESHOLD,
  ).length;
  const weakestDomain = domainAverages[0] ?? null;
  const strongestDomain =
    [...domainAverages].sort(
      (left, right) => right.averagePercentage - left.averagePercentage,
    )[0] ?? null;
  const readiness = evaluateExamReadiness({
    averageScore,
    bestScore,
    hasDueSoonNotStarted,
    hasOverdueNotStarted,
    latestScore,
    needsReviewCount,
    passRate,
    totalAttempts: results.length,
    weakDomainCount,
  });

  return {
    activityAttemptCount: activityResults.length,
    assignmentSummaries: activeAssignments.map((assignment) =>
      buildAssignmentSummary({
        assignment,
        hasMatchingResult: results.length > 0,
        readiness,
      }),
    ),
    attemptsByExam: buildAttemptsByExam(activityResults),
    averageScore,
    bestScore,
    displayName: student.displayName || student.studentName || 'Student',
    domainAverages,
    domainSampleCount,
    email: student.email || '',
    examKey: examScope.examKey,
    examScopeKey: examScope.examScopeKey,
    examTitle: examScope.examTitle,
    fullReadinessAvailable: results.length >= MIN_FULL_READINESS_ATTEMPTS,
    fullReadinessMessage:
      results.length >= MIN_FULL_READINESS_ATTEMPTS
        ? 'Full readiness available.'
        : `Need ${MIN_FULL_READINESS_ATTEMPTS - results.length} more saved attempts for full readiness.`,
    groupName: student.groupName || 'No group recorded',
    latestAttemptDate: latestResult?.submittedAt ?? '',
    latestAttemptId: latestResult?.attemptId ?? '',
    latestResult,
    latestScore,
    needsReviewCount,
    passCount,
    passRate,
    readinessLabel: readiness.label,
    readinessReason: readiness.reason,
    readinessStatus: readiness.status,
    scopedAttemptCount: results.length,
    strongestDomain,
    userId: student.userId || '',
    weakDomainCount,
    weakestDomain,
  };
}

export function evaluateExamReadiness({
  averageScore,
  bestScore,
  hasDueSoonNotStarted = false,
  hasOverdueNotStarted = false,
  latestScore,
  needsReviewCount = 0,
  passRate,
  totalAttempts = 0,
  weakDomainCount = 0,
} = {}) {
  if (totalAttempts === 0) {
    if (hasOverdueNotStarted) {
      return createReadiness('at-risk', 'Overdue - no attempt submitted.');
    }

    if (hasDueSoonNotStarted) {
      return createReadiness('not-started', 'Due soon; no matching attempt submitted yet.');
    }

    return createReadiness('not-started', 'No saved attempts for this exam yet.');
  }

  if (totalAttempts < MIN_FULL_READINESS_ATTEMPTS) {
    return createReadiness(
      'insufficient-data',
      'Full readiness requires at least 5 saved attempts for this exam.',
    );
  }

  if (
    needsReviewCount >= AT_RISK_FAILED_ATTEMPTS ||
    (averageScore !== null && averageScore < AT_RISK_AVERAGE_SCORE)
  ) {
    return createReadiness('at-risk', 'Repeated needs-review results or low exam-scoped average.');
  }

  if (
    averageScore !== null &&
    averageScore >= READY_SCORE_THRESHOLD &&
    Math.max(latestScore ?? 0, bestScore ?? 0) >= READY_BEST_SCORE_THRESHOLD &&
    (passRate ?? 0) >= READY_PASS_RATE_THRESHOLD &&
    weakDomainCount <= 1
  ) {
    return createReadiness(
      'ready',
      'At least 5 exam-scoped attempts are consistently above readiness thresholds.',
    );
  }

  if (
    Math.max(latestScore ?? 0, bestScore ?? 0) >= REAL_PASS_SCORE &&
    ((averageScore ?? 0) >= ALMOST_READY_SCORE_THRESHOLD ||
      (latestScore ?? 0) >= READY_SCORE_THRESHOLD)
  ) {
    return createReadiness('almost-ready', 'Exam-scoped scores are close, but more consistency is needed.');
  }

  if (weakDomainCount > 1) {
    return createReadiness('needs-review', 'Multiple weak domains need review for this exam.');
  }

  return createReadiness('needs-review', 'Exam-scoped saved attempts are below readiness thresholds.');
}

export function normalizeProgressResult(result = {}) {
  const examScopeKey = normalizeExamScopeKey(result.examKey || result.examTitle);
  const examKey = examScopeKey || cleanText(result.examKey);
  const examTitle = cleanText(EXAM_TITLES[examScopeKey] || result.examTitle || result.examKey || 'Unknown exam');

  return {
    ...result,
    examKey,
    examScopeKey,
    examTitle,
    passed: typeof result.passed === 'boolean' ? result.passed : null,
    score: getComparableScore(result),
    submittedAt: cleanText(result.submittedAt || result.savedAt),
    submittedTime: getTime(result.submittedAt || result.savedAt),
    userId: cleanText(result.userId),
  };
}

export function normalizeProgressAssignment(assignment = {}) {
  const examScopeKey = normalizeExamScopeKey(assignment.examKey || assignment.examSlug || assignment.examTitle);
  const examKey = examScopeKey || cleanText(assignment.examKey || assignment.examSlug);
  const examTitle = cleanText(EXAM_TITLES[examScopeKey] || assignment.examTitle || assignment.examKey || 'Unknown exam');

  return {
    ...assignment,
    dueAt: cleanText(assignment.dueAt),
    examKey,
    examScopeKey,
    examTitle,
    id: cleanText(assignment.id),
    status: cleanText(assignment.status || assignment.progressStatus || 'active'),
    studentUserId: cleanText(assignment.studentUserId),
    targetStudents: toArray(assignment.targetStudents).map((student) => ({
      groupId: cleanText(student.groupId),
      userId: cleanText(student.userId),
    })),
  };
}

export function normalizeExamScopeKey(value) {
  const normalized = cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return ['security-plus', 'security-plus-sy0-701', 'securityplussy0701'].includes(normalized)
    ? 'security-plus-sy0-701'
    : normalized;
}

export function percentageToComparableReadinessScore(value) {
  const percentage = toNumberOrNull(value);
  return percentage === null ? null : percentage * 10;
}

export function getAverage(values) {
  const numericValues = values.filter((value) => value || value === 0);

  if (numericValues.length === 0) {
    return null;
  }

  return numericValues.reduce((sum, value) => sum + Number(value), 0) / numericValues.length;
}

export function getMax(values) {
  const numericValues = values.filter((value) => value || value === 0);

  return numericValues.length > 0 ? Math.max(...numericValues) : null;
}

export function getTime(value) {
  if (!value) {
    return 0;
  }

  const time = new Date(value).getTime();

  return Number.isNaN(time) ? 0 : time;
}

export function isPastDue(value) {
  const time = getTime(value);

  return time > 0 && time < Date.now();
}

export function isDueSoon(value) {
  const time = getTime(value);
  const daysAhead = 7 * 24 * 60 * 60 * 1000;

  return time > 0 && time >= Date.now() && time - Date.now() <= daysAhead;
}

function buildDomainAverages(results) {
  const domainMap = new Map();

  results.forEach((result) => {
    getNormalizedDomainItems(result.domainBreakdown).forEach((domain) => {
      if (domain.percentage === null || domain.percentage === undefined) {
        return;
      }

      const key = domain.domainId || normalizeExamScopeKey(domain.domainLabel);
      const row = domainMap.get(key) ?? {
        domainId: key,
        domainLabel: domain.domainLabel,
        earnedPoints: 0,
        maxPoints: 0,
        percentages: [],
      };

      row.percentages.push(Number(domain.percentage));
      if (domain.earnedPoints != null && domain.maxPoints != null && Number(domain.maxPoints) > 0) {
        row.earnedPoints += Number(domain.earnedPoints);
        row.maxPoints += Number(domain.maxPoints);
      }
      domainMap.set(key, row);
    });
  });

  return Array.from(domainMap.values())
    .map((domain) => ({
      averagePercentage: domain.maxPoints > 0
        ? (domain.earnedPoints / domain.maxPoints) * 100
        : getAverage(domain.percentages),
      domainId: domain.domainId,
      domainLabel: domain.domainLabel,
      samples: domain.percentages.length,
    }))
    .sort((left, right) => left.averagePercentage - right.averagePercentage);
}

function hasDomainEvidence(result = {}) {
  return getNormalizedDomainItems(result.domainBreakdown).some(
    (domain) => domain.percentage !== null && domain.percentage !== undefined,
  );
}

function buildAttemptsByExam(results = []) {
  return Array.from(groupBy(results, (result) => result.examScopeKey))
    .map(([, examResults]) => ({
      count: examResults.length,
      examKey: examResults[0]?.examKey ?? '',
      examTitle: examResults[0]?.examTitle ?? 'Unknown exam',
      latestAttemptDate: examResults[0]?.submittedAt ?? '',
    }))
    .sort((left, right) => right.count - left.count || left.examTitle.localeCompare(right.examTitle));
}

function buildAssignmentSummary({ assignment, hasMatchingResult, readiness }) {
  let status = createReadiness('not-started', 'Not started');

  if (hasMatchingResult) {
    status = createReadiness(
      readiness.status === 'ready' ? 'ready' : readiness.status,
      readiness.label,
    );
  } else if (isPastDue(assignment.dueAt)) {
    status = createReadiness('at-risk', 'Overdue - no attempt submitted');
  } else if (isDueSoon(assignment.dueAt)) {
    status = createReadiness('not-started', 'Due soon');
  }

  return {
    dueAt: assignment.dueAt,
    examKey: assignment.examKey,
    examTitle: assignment.examTitle,
    id: assignment.id,
    label: status.label,
    status: status.status,
  };
}

function getStudentExamScopes(results, assignments) {
  const map = new Map();

  results.forEach((result) => {
    if (result.examScopeKey) {
      map.set(result.examScopeKey, {
        examKey: result.examKey,
        examScopeKey: result.examScopeKey,
        examTitle: result.examTitle,
      });
    }
  });

  assignments.forEach((assignment) => {
    if (assignment.examScopeKey) {
      map.set(assignment.examScopeKey, {
        examKey: assignment.examKey,
        examScopeKey: assignment.examScopeKey,
        examTitle: assignment.examTitle,
      });
    }
  });

  return Array.from(map.values()).sort((left, right) =>
    left.examTitle.localeCompare(right.examTitle),
  );
}

function assignmentTargetsStudent(assignment, student) {
  if (!student.userId) {
    return true;
  }

  if (assignment.studentUserId) {
    return assignment.studentUserId === student.userId;
  }

  if (assignment.groupId && assignment.groupId === student.groupId) {
    return true;
  }

  if (!Array.isArray(assignment.targetStudents) || assignment.targetStudents.length === 0) {
    return true;
  }

  return assignment.targetStudents.some(
    (targetStudent) => targetStudent.userId === student.userId,
  );
}

function getComparableScore(result = {}) {
  const scaledScore = toNumberOrNull(result.scaledScore);

  if (scaledScore !== null) {
    return scaledScore;
  }

  const rawPercentage = toNumberOrNull(result.rawPercentage);

  return rawPercentage === null ? null : rawPercentage * 10;
}

function createReadiness(status, reason) {
  return {
    label:
      EXAM_READINESS_STATUSES.find((entry) => entry.id === status)?.label ??
      'Needs review',
    reason,
    status,
  };
}

function groupBy(items, getKey) {
  return items.reduce((map, item) => {
    const key = cleanText(getKey(item));

    if (!key) {
      return map;
    }

    if (!map.has(key)) {
      map.set(key, []);
    }

    map.get(key).push(item);
    return map;
  }, new Map());
}

function toNumberOrNull(value) {
  if (value || value === 0) {
    const numberValue = Number(value);

    return Number.isFinite(numberValue) ? numberValue : null;
  }

  return null;
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value) {
  return String(value ?? '').trim();
}
