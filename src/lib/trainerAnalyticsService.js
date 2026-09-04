import {
  ALMOST_READY_SCORE_THRESHOLD,
  AT_RISK_AVERAGE_SCORE,
  AT_RISK_FAILED_ATTEMPTS,
  EXAM_READINESS_DISCLAIMER,
  EXAM_READINESS_STATUSES,
  MIN_FULL_READINESS_ATTEMPTS,
  READY_BEST_SCORE_THRESHOLD,
  READY_PASS_RATE_THRESHOLD,
  READY_SCORE_THRESHOLD,
  REAL_PASS_SCORE,
  REVIEW_DOMAIN_THRESHOLD,
  WEAK_DOMAIN_THRESHOLD,
  normalizeExamScopeKey,
} from './examReadinessRules.js';
import { getNormalizedDomainItems } from './resultStorageMappers.js';
import { isAssessmentResult } from './attemptPurpose.js';

export const READINESS_DISCLAIMER = EXAM_READINESS_DISCLAIMER;

export const READINESS_THRESHOLDS = {
  almostReadyScore: ALMOST_READY_SCORE_THRESHOLD,
  atRiskAverageScore: AT_RISK_AVERAGE_SCORE,
  atRiskFailedAttempts: AT_RISK_FAILED_ATTEMPTS,
  minimumReadyAttempts: MIN_FULL_READINESS_ATTEMPTS,
  readyAverageScore: READY_SCORE_THRESHOLD,
  readyBestScore: READY_BEST_SCORE_THRESHOLD,
  readyLatestScore: READY_SCORE_THRESHOLD,
  readyPassRate: READY_PASS_RATE_THRESHOLD,
  realPassScore: REAL_PASS_SCORE,
  reviewDomainThreshold: REVIEW_DOMAIN_THRESHOLD,
  weakDomainThreshold: WEAK_DOMAIN_THRESHOLD,
};

export const READINESS_STATUSES = EXAM_READINESS_STATUSES;

export function getTrainerAnalyticsSnapshot({
  assignments = [],
  groups = [],
  results = [],
  students = [],
} = {}) {
  const normalizedStudents = students.map(normalizeStudent);
  const normalizedResults = results
    .filter(isAssessmentResult)
    .map(normalizeResult)
    .sort((left, right) => right.submittedTime - left.submittedTime);
  const normalizedAssignments = assignments.map(normalizeAssignment);
  const normalizedGroups = groups.map(normalizeGroup);
  const resultsByStudent = groupBy(normalizedResults, (result) => result.userId);
  const studentReadiness = buildStudentExamReadiness({
    assignments: normalizedAssignments,
    results: normalizedResults,
    resultsByStudent,
    students: normalizedStudents,
  });
  const assignmentReadiness = buildAssignmentReadiness({
    assignments: normalizedAssignments,
    results: normalizedResults,
    students: normalizedStudents,
  });

  return {
    activityAnalytics: buildActivityAnalytics(normalizedStudents, resultsByStudent),
    analyticsMode: 'exam-scoped-readiness',
    assignmentReadiness,
    examAnalytics: buildExamAnalytics(normalizedResults),
    groupAnalytics: buildGroupAnalytics({
      assignments: normalizedAssignments,
      groups: normalizedGroups,
      results: normalizedResults,
      students: normalizedStudents,
    }),
    readinessSummary: buildReadinessSummary(studentReadiness),
    studentReadiness,
    totals: {
      assignments: normalizedAssignments.length,
      groups: normalizedGroups.length,
      results: normalizedResults.length,
      students: normalizedStudents.length,
    },
    weakAreaAnalytics: buildWeakAreaAnalytics(normalizedResults),
  };
}

function buildStudentExamReadiness({
  assignments,
  results,
  resultsByStudent,
  students,
}) {
  return students.flatMap((student) => {
    const studentResults = resultsByStudent.get(student.userId) ?? [];
    const studentAssignments = assignments.filter((assignment) =>
      assignmentTargetsStudent(assignment, student),
    );
    const examScopes = getStudentExamScopes(studentResults, studentAssignments);

    if (examScopes.length === 0) {
      return [
        buildStudentReadiness({
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
      buildStudentReadiness({
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

function buildStudentReadiness({
  activityResults = [],
  assignments = [],
  examScope,
  results,
  student,
}) {
  const scoredResults = results.filter((result) => result.score !== null);
  const latestResult = results[0] ?? null;
  const latestScore = latestResult?.score ?? null;
  const bestScore = getMax(scoredResults.map((result) => result.score));
  const averageScore = getAverage(scoredResults.map((result) => result.score));
  const passCount = results.filter((result) => result.passed === true).length;
  const needsReviewCount = results.filter((result) => result.passed === false).length;
  const passRate =
    passCount + needsReviewCount > 0
      ? (passCount / (passCount + needsReviewCount)) * 100
      : null;
  const activeAssignments = assignments.filter(
    (assignment) => !['archived', 'closed'].includes(assignment.status),
  );
  const notStartedAssignments = activeAssignments.filter(
    (assignment) => results.length === 0 && assignmentTargetsStudent(assignment, student),
  );
  const hasOverdueNotStarted = notStartedAssignments.some((assignment) =>
    isPastDue(assignment.dueAt),
  );
  const hasDueSoonNotStarted = notStartedAssignments.some((assignment) =>
    isDueSoon(assignment.dueAt),
  );
  const domainAverages = buildStudentDomainAverages(results);
  const weakDomainCount = domainAverages.filter(
    (domain) => domain.averagePercentage < READINESS_THRESHOLDS.weakDomainThreshold,
  ).length;
  const weakestDomain = domainAverages[0] ?? null;
  const strongestDomain = [...domainAverages]
    .sort((left, right) => right.averagePercentage - left.averagePercentage)[0] ?? null;
  const attemptsByExam = buildAttemptsByExam(activityResults);
  const assignmentSummaries = activeAssignments.map((assignment) =>
    buildAssignmentSummary({
      assignment,
      hasMatchingResult: results.some((result) => result.assignmentId === assignment.id),
    }),
  );
  const readiness = getReadinessStatus({
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
    assignmentSummaries,
    attemptsByExam,
    averageScore,
    bestScore,
    displayName: student.displayName,
    domainAverages,
    email: student.email,
    examKey: examScope.examKey,
    examScopeKey: examScope.examScopeKey,
    examTitle: examScope.examTitle,
    groupName: student.groupName || 'No group recorded',
    latestAttemptDate: latestResult?.submittedAt ?? '',
    latestAttemptId: latestResult?.attemptId ?? '',
    latestScore,
    needsReviewCount,
    passCount,
    passRate,
    readinessLabel: readiness.label,
    readinessReason: readiness.reason,
    readinessStatus: readiness.status,
    scopedAttemptCount: results.length,
    strongestDomain,
    totalAttempts: results.length,
    userId: student.userId,
    weakDomainCount,
    weakestDomain,
  };
}

function buildAssignmentReadiness({ assignments, results, students }) {
  return assignments.map((assignment) => {
    const targetStudents = getAssignmentTargetStudents(assignment, students);
    const studentRows = targetStudents.map((student) => {
      const scopedResults = results.filter(
        (result) =>
          result.userId === student.userId &&
          result.examScopeKey === assignment.examScopeKey,
      );
      const assignmentResults = scopedResults.filter(
        (result) => result.assignmentId === assignment.id,
      );
      const readiness = buildStudentReadiness({
        activityResults: results.filter((result) => result.userId === student.userId),
        assignments: [assignment],
        examScope: {
          examKey: assignment.examKey,
          examScopeKey: assignment.examScopeKey,
          examTitle: assignment.examTitle,
        },
        results: scopedResults,
        student,
      });
      const assignmentStatus = getAssignmentStudentStatus({
        assignment,
        assignmentAttemptCount: assignmentResults.length,
        readiness,
      });

      return {
        ...readiness,
        assignmentAttemptCount: assignmentResults.length,
        assignmentStatus,
      };
    });
    const studentsWithAttempts = studentRows.filter((row) => row.assignmentAttemptCount > 0);
    const readyStudents = studentRows.filter((row) => row.readinessStatus === 'ready');
    const overdueStudents = studentRows.filter((row) => row.assignmentStatus.status === 'overdue');
    const dueSoonStudents = studentRows.filter((row) => row.assignmentStatus.status === 'due-soon');
    const notStartedStudents = studentRows.filter((row) => row.assignmentAttemptCount === 0);
    const needsReviewStudents = studentRows.filter((row) =>
      ['needs-review', 'at-risk'].includes(row.readinessStatus) &&
      row.assignmentAttemptCount > 0,
    );
    const completedButNotReadyStudents = studentRows.filter(
      (row) => row.assignmentAttemptCount > 0 && row.readinessStatus !== 'ready',
    );
    const commonWeakDomains = summarizeWeakDomains(studentRows);

    return {
      assignmentId: assignment.id,
      averageScore: getAverage(studentsWithAttempts.map((row) => row.averageScore)),
      commonWeakDomains,
      completedButNotReadyCount: completedButNotReadyStudents.length,
      dueSoonCount: dueSoonStudents.length,
      examKey: assignment.examKey,
      examScopeKey: assignment.examScopeKey,
      examTitle: assignment.examTitle,
      needsReviewCount: needsReviewStudents.length,
      notStartedCount: notStartedStudents.length,
      overdueCount: overdueStudents.length,
      readyCount: readyStudents.length,
      studentRows,
      submittedCount: studentsWithAttempts.length,
      totalStudents: targetStudents.length || assignment.totalStudents,
    };
  });
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

function buildAssignmentSummary({ assignment, hasMatchingResult }) {
  let status = createAssignmentStatus('not-started', 'Not started');

  if (hasMatchingResult) {
    status = createAssignmentStatus('submitted', 'Submitted for this exam');
  } else if (isPastDue(assignment.dueAt)) {
    status = createAssignmentStatus('overdue', 'Overdue - no attempt submitted');
  } else if (isDueSoon(assignment.dueAt)) {
    status = createAssignmentStatus('due-soon', 'Due soon');
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

function getAssignmentStudentStatus({ assignment, assignmentAttemptCount, readiness }) {
  if (assignmentAttemptCount > 0) {
    if (readiness.readinessStatus === 'ready') {
      return createAssignmentStatus('ready', 'Ready');
    }

    if (readiness.readinessStatus === 'almost-ready') {
      return createAssignmentStatus('completed-not-ready', 'Completed but not ready');
    }

    return createAssignmentStatus('needs-review', 'Needs review');
  }

  if (isPastDue(assignment.dueAt)) {
    return createAssignmentStatus('overdue', 'Overdue - no attempt submitted');
  }

  if (isDueSoon(assignment.dueAt)) {
    return createAssignmentStatus('due-soon', 'Due soon');
  }

  return createAssignmentStatus('not-started', 'Not started');
}

function createAssignmentStatus(status, label) {
  return {
    label,
    status,
  };
}

function buildExamAnalytics(results) {
  return Array.from(groupBy(results, (result) => result.examScopeKey))
    .map(([, examResults]) => {
      const scoredResults = examResults.filter((result) => result.score !== null);
      const passCount = examResults.filter((result) => result.passed === true).length;
      const needsReviewCount = examResults.filter(
        (result) =>
          result.passed === false ||
          (result.score !== null &&
            result.score < READINESS_THRESHOLDS.almostReadyScore),
      ).length;
      const passFailCount = examResults.filter(
        (result) => result.passed === true || result.passed === false,
      ).length;

      return {
        averageScore: getAverage(scoredResults.map((result) => result.score)),
        bestScore: getMax(scoredResults.map((result) => result.score)),
        examKey: examResults[0]?.examKey ?? '',
        examTitle: examResults[0]?.examTitle ?? 'Unknown exam',
        lowestScore: getMin(scoredResults.map((result) => result.score)),
        needsReviewCount,
        passRate: passFailCount > 0 ? (passCount / passFailCount) * 100 : null,
        studentsAttempted: new Set(examResults.map((result) => result.userId).filter(Boolean))
          .size,
        totalAttempts: examResults.length,
      };
    })
    .sort((left, right) => right.totalAttempts - left.totalAttempts);
}

function buildGroupAnalytics({ assignments, groups, results, students }) {
  const groupsById = new Map(groups.map((group) => [group.id, group]));
  students.forEach((student) => {
    if (student.groupId && !groupsById.has(student.groupId)) {
      groupsById.set(student.groupId, {
        id: student.groupId,
        name: student.groupName || 'Unnamed group',
      });
    }
  });

  return Array.from(groupsById.values())
    .map((group) => {
      const groupStudents = students.filter((student) => student.groupId === group.id);
      const groupUserIds = new Set(groupStudents.map((student) => student.userId));
      const groupResults = results.filter((result) => groupUserIds.has(result.userId));
      const scoredResults = groupResults.filter((result) => result.score !== null);
      const passFailCount = groupResults.filter(
        (result) => result.passed === true || result.passed === false,
      ).length;
      const passCount = groupResults.filter((result) => result.passed === true).length;
      const groupAssignments = assignments.filter((assignment) => assignment.groupId === group.id);
      const assignmentReadiness = buildAssignmentReadiness({
        assignments: groupAssignments,
        results,
        students: groupStudents,
      });
      const assignedTotal = assignmentReadiness.reduce(
        (total, assignment) => total + Math.max(assignment.totalStudents, 0),
        0,
      );
      const readyTotal = assignmentReadiness.reduce(
        (total, assignment) => total + Math.max(assignment.readyCount, 0),
        0,
      );

      return {
        activeStudents: groupStudents.filter((student) => student.status === 'active').length,
        averageScore: getAverage(scoredResults.map((result) => result.score)),
        commonWeakDomains: summarizeWeakDomainsFromResults(groupResults).slice(0, 3),
        completionRate:
          assignedTotal > 0 ? (readyTotal / assignedTotal) * 100 : null,
        groupId: group.id,
        groupName: group.name || 'Unnamed group',
        passRate: passFailCount > 0 ? (passCount / passFailCount) * 100 : null,
        readyStudents: readyTotal,
        studentCount: groupStudents.length,
        studentsWithAttempts: new Set(groupResults.map((result) => result.userId).filter(Boolean))
          .size,
        studentsWithoutAttempts: groupStudents.filter(
          (student) => !groupResults.some((result) => result.userId === student.userId),
        ).length,
        totalAttempts: groupResults.length,
      };
    })
    .filter((group) => group.studentCount > 0 || group.totalAttempts > 0)
    .sort((left, right) => right.studentCount - left.studentCount || left.groupName.localeCompare(right.groupName));
}

function buildWeakAreaAnalytics(results) {
  return {
    commonWeakAreas: summarizeWeakDomainsFromResults(results).slice(0, 8),
    domainPerformance: summarizeDomainPerformance(results).slice(0, 8),
  };
}

function buildActivityAnalytics(students, resultsByStudent) {
  const rows = students.map((student) => {
    const results = resultsByStudent.get(student.userId) ?? [];
    const latestResult = results[0] ?? null;

    return {
      displayName: student.displayName,
      groupName: student.groupName || 'No group recorded',
      latestAttemptDate: latestResult?.submittedAt ?? '',
      totalAttempts: results.length,
      userId: student.userId,
    };
  });
  const studentsWithAttempts = rows.filter((student) => student.totalAttempts > 0);

  return {
    leastActiveStudents: [...studentsWithAttempts]
      .sort(
        (left, right) =>
          left.totalAttempts - right.totalAttempts ||
          getTime(left.latestAttemptDate) - getTime(right.latestAttemptDate),
      )
      .slice(0, 5),
    mostActiveStudents: [...studentsWithAttempts]
      .sort(
        (left, right) =>
          right.totalAttempts - left.totalAttempts ||
          getTime(right.latestAttemptDate) - getTime(left.latestAttemptDate),
      )
      .slice(0, 5),
    studentsWithNoAttempts: rows
      .filter((student) => student.totalAttempts === 0)
      .sort((left, right) => left.displayName.localeCompare(right.displayName))
      .slice(0, 8),
  };
}

function buildReadinessSummary(studentReadiness) {
  return READINESS_STATUSES.map((status) => ({
    ...status,
    count: studentReadiness.filter((student) => student.readinessStatus === status.id)
      .length,
  }));
}

function getReadinessStatus({
  averageScore,
  bestScore,
  hasDueSoonNotStarted,
  hasOverdueNotStarted,
  latestScore,
  needsReviewCount,
  passRate,
  totalAttempts,
  weakDomainCount,
}) {
  if (totalAttempts === 0) {
    if (hasOverdueNotStarted) {
      return createReadiness('at-risk', 'Overdue - no attempt submitted.');
    }

    if (hasDueSoonNotStarted) {
      return createReadiness('not-started', 'Due soon; no matching attempt submitted yet.');
    }

    return createReadiness('not-started', 'No saved attempts for this exam yet.');
  }

  if (totalAttempts < READINESS_THRESHOLDS.minimumReadyAttempts) {
    return createReadiness(
      'insufficient-data',
      'Full readiness requires at least 5 saved attempts for this exam.',
    );
  }

  if (
    needsReviewCount >= READINESS_THRESHOLDS.atRiskFailedAttempts ||
    (averageScore !== null && averageScore < READINESS_THRESHOLDS.atRiskAverageScore)
  ) {
    return createReadiness('at-risk', 'Repeated needs-review results or low exam-scoped average.');
  }

  if (
    totalAttempts >= READINESS_THRESHOLDS.minimumReadyAttempts &&
    averageScore !== null &&
    averageScore >= READINESS_THRESHOLDS.readyAverageScore &&
    (latestScore ?? 0) >= READINESS_THRESHOLDS.readyLatestScore &&
    (bestScore ?? 0) >= READINESS_THRESHOLDS.readyBestScore &&
    (passRate ?? 0) >= READINESS_THRESHOLDS.readyPassRate &&
    weakDomainCount <= 1
  ) {
    return createReadiness('ready', 'At least 5 exam-scoped attempts are consistently above readiness thresholds.');
  }

  if (
    Math.max(latestScore ?? 0, bestScore ?? 0) >= READINESS_THRESHOLDS.realPassScore &&
    ((averageScore ?? 0) >= READINESS_THRESHOLDS.almostReadyScore ||
      (latestScore ?? 0) >= READINESS_THRESHOLDS.readyLatestScore)
  ) {
    return createReadiness('almost-ready', 'Exam-scoped scores are close, but more consistency is needed.');
  }

  if (weakDomainCount > 1) {
    return createReadiness('needs-review', 'Multiple weak domains need review for this exam.');
  }

  return createReadiness('needs-review', 'Exam-scoped saved attempts are below readiness thresholds.');
}

function createReadiness(status, reason) {
  return {
    label:
      READINESS_STATUSES.find((entry) => entry.id === status)?.label ??
      'Needs review',
    reason,
    status,
  };
}

function buildStudentDomainAverages(results) {
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
        percentages: [],
      };

      row.percentages.push(Number(domain.percentage));
      domainMap.set(key, row);
    });
  });

  return Array.from(domainMap.values())
    .map((domain) => ({
      averagePercentage: getAverage(domain.percentages),
      domainId: domain.domainId,
      domainLabel: domain.domainLabel,
      samples: domain.percentages.length,
    }))
    .sort((left, right) => left.averagePercentage - right.averagePercentage);
}

function summarizeWeakDomains(studentRows) {
  const map = new Map();

  studentRows.forEach((student) => {
    student.domainAverages
      .filter((domain) => domain.averagePercentage < READINESS_THRESHOLDS.reviewDomainThreshold)
      .forEach((domain) => {
        const row = map.get(domain.domainId) ?? {
          averagePercentageValues: [],
          domainId: domain.domainId,
          domainLabel: domain.domainLabel,
          studentCount: 0,
        };

        row.averagePercentageValues.push(domain.averagePercentage);
        row.studentCount += 1;
        map.set(domain.domainId, row);
      });
  });

  return Array.from(map.values())
    .map((domain) => ({
      averagePercentage: getAverage(domain.averagePercentageValues),
      domainId: domain.domainId,
      domainLabel: domain.domainLabel,
      studentCount: domain.studentCount,
    }))
    .sort((left, right) => right.studentCount - left.studentCount || left.averagePercentage - right.averagePercentage)
    .slice(0, 5);
}

function summarizeWeakDomainsFromResults(results) {
  const studentDomainMap = new Map();

  results.forEach((result) => {
    getNormalizedDomainItems(result.domainBreakdown)
      .filter((domain) =>
        domain.percentage !== null &&
        domain.percentage < READINESS_THRESHOLDS.reviewDomainThreshold,
      )
      .forEach((domain) => {
        const key = `${result.examScopeKey}:${domain.domainId}`;
        const row = studentDomainMap.get(key) ?? {
          domainId: domain.domainId,
          domainLabel: domain.domainLabel,
          examTitle: result.examTitle,
          occurrences: 0,
          percentages: [],
          students: new Set(),
        };

        row.occurrences += 1;
        row.percentages.push(Number(domain.percentage));
        if (result.userId) {
          row.students.add(result.userId);
        }
        studentDomainMap.set(key, row);
      });
  });

  return Array.from(studentDomainMap.values())
    .map((domain) => ({
      averagePercentage: getAverage(domain.percentages),
      examTitle: domain.examTitle,
      label: `${domain.examTitle}: ${domain.domainLabel}`,
      occurrences: domain.occurrences,
      studentCount: domain.students.size,
    }))
    .sort((left, right) => right.studentCount - left.studentCount || right.occurrences - left.occurrences);
}

function summarizeDomainPerformance(results) {
  const domainMap = new Map();

  results.forEach((result) => {
    getNormalizedDomainItems(result.domainBreakdown).forEach((domain) => {
      if (domain.percentage === null || domain.percentage === undefined) {
        return;
      }

      const key = `${result.examScopeKey}:${domain.domainId}`;
      const row = domainMap.get(key) ?? {
        domain: domain.domainLabel,
        examTitle: result.examTitle,
        percentages: [],
        results: 0,
        weakCount: 0,
      };

      row.results += 1;
      row.percentages.push(Number(domain.percentage));
      if (domain.percentage < READINESS_THRESHOLDS.weakDomainThreshold) {
        row.weakCount += 1;
      }
      domainMap.set(key, row);
    });
  });

  return Array.from(domainMap.values())
    .map((row) => ({
      averagePercentage: getAverage(row.percentages),
      domain: row.domain,
      examTitle: row.examTitle,
      resultCount: row.results,
      weakCount: row.weakCount,
    }))
    .sort((left, right) => right.weakCount - left.weakCount || left.domain.localeCompare(right.domain));
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

function getAssignmentTargetStudents(assignment, students) {
  if (assignment.studentUserId) {
    return students.filter((student) => student.userId === assignment.studentUserId);
  }

  if (assignment.targetStudents.length > 0) {
    const targetIds = new Set(
      assignment.targetStudents.map((student) => student.userId).filter(Boolean),
    );

    return students.filter((student) => targetIds.has(student.userId));
  }

  if (assignment.groupId) {
    return students.filter((student) => student.groupId === assignment.groupId);
  }

  return [];
}

function assignmentTargetsStudent(assignment, student) {
  if (!student.userId) {
    return false;
  }

  if (assignment.studentUserId) {
    return assignment.studentUserId === student.userId;
  }

  if (assignment.groupId && assignment.groupId === student.groupId) {
    return true;
  }

  return assignment.targetStudents.some(
    (targetStudent) => targetStudent.userId === student.userId,
  );
}

function normalizeStudent(student = {}) {
  return {
    campusName: cleanText(student.campusName),
    displayName:
      cleanText(student.displayName) ||
      getNameFromEmail(student.email) ||
      'Student',
    email: cleanText(student.email),
    groupId: cleanText(student.groupId),
    groupName: cleanText(student.groupName),
    status: cleanText(student.status || 'active'),
    userId: cleanText(student.userId),
  };
}

function normalizeResult(result = {}) {
  const examKey = cleanText(result.examKey);
  const examTitle = cleanText(result.examTitle || result.examKey || 'Unknown exam');

  return {
    attemptId: cleanText(result.attemptId),
    assignmentId: cleanText(result.assignmentId),
    domainBreakdown: result.domainBreakdown ?? {},
    examKey,
    examScopeKey: normalizeExamScopeKey(examKey || examTitle),
    examTitle,
    passed: typeof result.passed === 'boolean' ? result.passed : null,
    rawPercentage: toNumberOrNull(result.rawPercentage),
    score: getComparableScore(result),
    scaledScore: toNumberOrNull(result.scaledScore),
    submittedAt: cleanText(result.submittedAt || result.savedAt),
    submittedTime: getTime(result.submittedAt || result.savedAt),
    userId: cleanText(result.userId),
    weakAreas: toArray(result.weakAreas),
  };
}

function normalizeAssignment(assignment = {}) {
  const examKey = cleanText(assignment.examKey || assignment.examSlug);
  const examTitle = cleanText(assignment.examTitle || assignment.examKey || 'Unknown exam');

  return {
    completedCount: Number(assignment.completedCount ?? 0),
    dueAt: cleanText(assignment.dueAt),
    examKey,
    examScopeKey: normalizeExamScopeKey(examKey || examTitle),
    examTitle,
    groupId: cleanText(assignment.groupId),
    id: cleanText(assignment.id),
    latestResult: assignment.latestResult ?? null,
    progressStatus: cleanText(assignment.progressStatus),
    resultMatches: toArray(assignment.resultMatches),
    status: cleanText(assignment.status || assignment.progressStatus || 'active'),
    studentResults: toArray(assignment.studentResults),
    studentUserId: cleanText(assignment.studentUserId),
    targetStudents: toArray(assignment.targetStudents).map((student) => ({
      groupId: cleanText(student.groupId),
      userId: cleanText(student.userId),
    })),
    totalStudents: Number(assignment.totalStudents ?? 0),
  };
}

function normalizeGroup(group = {}) {
  return {
    id: cleanText(group.id),
    name: cleanText(group.scopeLabel || group.name || 'Unnamed group'),
  };
}

function getComparableScore(result = {}) {
  const scaledScore = toNumberOrNull(result.scaledScore);

  if (scaledScore !== null) {
    return scaledScore;
  }

  const rawPercentage = toNumberOrNull(result.rawPercentage);

  return rawPercentage === null ? null : rawPercentage * 10;
}

function getAverage(values) {
  const numericValues = values.filter((value) => value || value === 0);

  if (numericValues.length === 0) {
    return null;
  }

  return numericValues.reduce((sum, value) => sum + Number(value), 0) / numericValues.length;
}

function getMax(values) {
  const numericValues = values.filter((value) => value || value === 0);

  return numericValues.length > 0 ? Math.max(...numericValues) : null;
}

function getMin(values) {
  const numericValues = values.filter((value) => value || value === 0);

  return numericValues.length > 0 ? Math.min(...numericValues) : null;
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

function isPastDue(value) {
  const time = getTime(value);

  return time > 0 && time < Date.now();
}

function isDueSoon(value) {
  const time = getTime(value);
  const daysAhead = 7 * 24 * 60 * 60 * 1000;

  return time > 0 && time >= Date.now() && time - Date.now() <= daysAhead;
}

function getTime(value) {
  if (!value) {
    return 0;
  }

  const time = new Date(value).getTime();

  return Number.isNaN(time) ? 0 : time;
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

function getNameFromEmail(email) {
  const text = cleanText(email);

  return text.includes('@') ? text.split('@')[0] : '';
}
