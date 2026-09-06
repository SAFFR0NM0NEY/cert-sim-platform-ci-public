import { useCallback, useMemo, useState } from 'react';

import { getTrainerAnalyticsSnapshot } from '../lib/trainerAnalyticsService.js';
import { evaluateExamReadiness, normalizeExamScopeKey } from '../lib/examReadinessRules.js';
import { getExamDisplayLabel } from '../exams/examDisplayMetadata.js';

export default function useTrainerAnalytics({
  assignments = [],
  completeScopeAnalytics = null,
  error = '',
  groups = [],
  loading = false,
  results = [],
  students = [],
} = {}) {
  const [refreshVersion, setRefreshVersion] = useState(0);
  const analytics = useMemo(
    () => {
      const pageDerived = getTrainerAnalyticsSnapshot({
        assignments,
        groups,
        results,
        students,
      });
      return completeScopeAnalytics?.scopeComplete === true
        ? applyAuthoritativeAnalytics(pageDerived, completeScopeAnalytics, students, groups, assignments)
        : pageDerived;
    },
    [assignments, completeScopeAnalytics, groups, refreshVersion, results, students],
  );
  const refreshAnalytics = useCallback(() => {
    setRefreshVersion((current) => current + 1);
    return { ok: true };
  }, []);

  return {
    activityAnalytics: analytics.activityAnalytics,
    analytics,
    analyticsMode: analytics.analyticsMode,
    assignmentReadiness: analytics.assignmentReadiness,
    error,
    examAnalytics: analytics.examAnalytics,
    groupAnalytics: analytics.groupAnalytics,
    loading,
    readinessSummary: analytics.readinessSummary,
    refreshAnalytics,
    studentReadiness: analytics.studentReadiness,
    weakAreaAnalytics: analytics.weakAreaAnalytics,
  };
}

export function applyAuthoritativeAnalytics(pageDerived, authoritative, students, groups, assignments) {
  const studentById = new Map(students.map((student) => [student.userId, student]));
  const clientAssignmentById = new Map(assignments.map((assignment) => [assignment.id, assignment]));
  const effectiveAssignments = (authoritative.assignments ?? []).map((row) => ({
    ...row,
    ...(clientAssignmentById.get(row.assignmentId) ?? {}),
    id: row.assignmentId,
    examKey: clientAssignmentById.get(row.assignmentId)?.examKey ?? row.examKey,
    groupId: clientAssignmentById.get(row.assignmentId)?.groupId ?? row.groupId,
    dueAt: clientAssignmentById.get(row.assignmentId)?.dueAt ?? row.dueAt,
    totalStudents: clientAssignmentById.get(row.assignmentId)?.totalStudents ?? row.totalStudents,
  }));
  const authoritativeByLearner = groupRows(authoritative.learners ?? [], (row) => row.learnerId);
  const assignmentLearnerByKey = new Map((authoritative.assignmentLearners ?? [])
    .map((row) => [`${row.assignmentId}:${row.learnerId}`, row]));
  const studentReadiness = (authoritative.learners ?? []).map((row) => {
    const student = studentById.get(row.learnerId) ?? {};
    const learnerRows = authoritativeByLearner.get(row.learnerId) ?? [];
    const learnerAssignments = effectiveAssignments.filter((assignment) => assignmentTargetsLearner(
      assignment,
      student,
      assignmentLearnerByKey,
    ));
    const average = row.averagePercentage == null ? null : row.averagePercentage * 10;
    const domainAverages = [...(row.domains ?? [])].map((domain) => ({
      ...domain,
      domainId: domain.domainId ?? domain.domainKey,
      domainLabel: domain.domainLabel ?? domain.domainKey,
    })).sort((left, right) => left.averagePercentage - right.averagePercentage);
    const weakDomains = domainAverages.filter((domain) => domain.averagePercentage < 70);
    const pendingAssignments = learnerAssignments.filter((assignment) =>
      normalizeExamScopeKey(assignment.examKey) === normalizeExamScopeKey(row.examKey) &&
      !['archived', 'closed'].includes(assignment.status) &&
      (assignmentLearnerByKey.get(`${assignment.id}:${row.learnerId}`)?.assignmentAttemptCount ?? 0) === 0);
    const readiness = evaluateExamReadiness({
      averageScore: average,
      bestScore: row.bestPercentage == null ? null : row.bestPercentage * 10,
      latestScore: row.latestPercentage == null ? null : row.latestPercentage * 10,
      needsReviewCount: row.needsReviewCount,
      passRate: row.passRate,
      totalAttempts: row.assessmentCount,
      weakDomainCount: weakDomains.length,
      hasDueSoonNotStarted: pendingAssignments.some((assignment) => isDueSoon(assignment.dueAt)),
      hasOverdueNotStarted: pendingAssignments.some((assignment) => isPastDue(assignment.dueAt)),
    });
    return {
      userId: row.learnerId,
      displayName: student.displayName || 'Learner',
      email: student.email || '',
      groupName: student.groupName || '',
      groupId: student.groupId || '',
      examKey: normalizeExamScopeKey(row.examKey),
      examScopeKey: normalizeExamScopeKey(row.examKey),
      examTitle: getExamDisplayLabel(row.examKey, { fallback: 'Protected exam' }),
      latestScore: row.latestPercentage == null ? null : row.latestPercentage * 10,
      bestScore: row.bestPercentage == null ? null : row.bestPercentage * 10,
      averageScore: average,
      domainAverages,
      domainSampleCount: domainAverages.reduce((total, domain) => total + (domain.sampleCount ?? 0), 0),
      passRate: row.passRate,
      passCount: row.passedCount,
      scopedAttemptCount: row.assessmentCount,
      totalAttempts: row.assessmentCount,
      latestAttemptDate: row.latestActivity,
      latestAttemptId: row.latestAttemptId ?? '',
      activityAttemptCount: learnerRows.reduce((total, item) => total + Number(item.activityCount ?? 0), 0),
      weakestDomain: domainAverages[0] ?? null,
      strongestDomain: domainAverages.at(-1) ?? null,
      weakDomainCount: weakDomains.length,
      readinessStatus: readiness.status,
      readinessLabel: readiness.label,
      readinessReason: readiness.reason,
      attemptsByExam: learnerRows.filter((item) => item.activityCount > 0).map((item) => ({
        examKey: item.examKey, examTitle: getExamDisplayLabel(item.examKey), count: item.activityCount,
        latestAttemptDate: item.latestActivity,
      })),
      assignmentSummaries: learnerAssignments
        .filter((assignment) => normalizeExamScopeKey(assignment.examKey) === normalizeExamScopeKey(row.examKey))
        .map((assignment) => buildAssignmentSummary(assignment,
          assignmentLearnerByKey.get(`${assignment.id}:${row.learnerId}`)?.assignmentAttemptCount ?? 0)),
      assignments: learnerAssignments,
      weakDomains,
    };
  });
  const examAnalytics = (authoritative.exams ?? []).map((row) => ({
    examKey: row.examKey,
    examTitle: getExamDisplayLabel(row.examKey),
    totalAttempts: row.assessmentCount,
    studentsAttempted: row.assessedLearnerCount,
    averageScore: row.averagePercentage == null ? null : row.averagePercentage * 10,
    passRate: row.passRate,
    bestScore: row.bestPercentage == null ? null : row.bestPercentage * 10,
    lowestScore: row.lowestPercentage == null ? null : row.lowestPercentage * 10,
    historicalCount: row.historicalCount,
    needsReviewCount: row.needsReviewCount,
  }));
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const assignmentById = new Map(effectiveAssignments.map((assignment) => [assignment.id, assignment]));
  const assignmentReadiness = (authoritative.assignments ?? []).map((row) => {
    const assignment = assignmentById.get(row.assignmentId) ?? {};
    const targetIds = new Set((assignment.targetStudents ?? []).map((student) => student.userId));
    if (assignment.studentUserId) targetIds.add(assignment.studentUserId);
    const studentRows = studentReadiness.filter((learner) =>
      (!targetIds.size || targetIds.has(learner.userId)) &&
      (!assignment.examKey || learner.examScopeKey === normalizeExamScopeKey(assignment.examKey)));
    const submittedRows = studentRows.filter((learner) =>
      (assignmentLearnerByKey.get(`${row.assignmentId}:${learner.userId}`)?.assignmentAttemptCount ?? 0) > 0);
    const readyCount = submittedRows.filter((learner) => learner.readinessStatus === 'ready').length;
    const needsReviewCount = submittedRows.filter((learner) => ['needs-review', 'at-risk'].includes(learner.readinessStatus)).length;
    const submittedCount = submittedRows.length;
    const unsubmittedCount = Math.max(0, (assignment.totalStudents ?? targetIds.size) - submittedCount);
    return {
      assignmentId: row.assignmentId,
      examKey: assignment.examKey || '',
      examTitle: assignment.examTitle || 'Protected exam',
      submittedCount,
      totalStudents: assignment.totalStudents ?? targetIds.size,
      averageScore: row.averagePercentage == null ? null : row.averagePercentage * 10,
      needsReviewCount,
      readyCount,
      completedButNotReadyCount: submittedRows.filter((learner) => learner.readinessStatus !== 'ready').length,
      dueSoonCount: isDueSoon(assignment.dueAt) ? unsubmittedCount : 0,
      overdueCount: isPastDue(assignment.dueAt) ? unsubmittedCount : 0,
      notStartedCount: unsubmittedCount,
      studentRows: studentRows.map((learner) => ({ ...learner,
        assignmentAttemptCount: assignmentLearnerByKey.get(`${row.assignmentId}:${learner.userId}`)?.assignmentAttemptCount ?? 0,
        assignmentStatus: getAssignmentStatus(assignment,
          assignmentLearnerByKey.get(`${row.assignmentId}:${learner.userId}`)?.assignmentAttemptCount ?? 0,
          learner.readinessStatus),
      })),
      commonWeakDomains: summarizeLearnerWeakDomains(submittedRows, 80),
    };
  });
  const assignmentReadinessByGroup = groupRows(assignmentReadiness, (row) => assignmentById.get(row.assignmentId)?.groupId);
  const authoritativeGroupById = new Map((authoritative.groups ?? []).map((row) => [row.groupId, row]));
  const groupAnalytics = groups.map((group) => {
    const row = authoritativeGroupById.get(group.id) ?? {};
    const groupStudents = students.filter((student) => student.groupId === group.id);
    const outcomes = assignmentReadinessByGroup.get(group.id) ?? [];
    const assignedTotal = outcomes.reduce((total, assignment) => total + assignment.totalStudents, 0);
    const readyTotal = outcomes.reduce((total, assignment) => total + assignment.readyCount, 0);
    return {
      groupId: group.id, groupName: groupById.get(group.id)?.name || 'Unnamed group',
      studentCount: groupStudents.length,
      activeStudents: groupStudents.filter((student) => student.status === 'active').length,
      studentsWithAttempts: row.assessedLearnerCount ?? 0,
      studentsWithoutAttempts: Math.max(0, groupStudents.length - (row.assessedLearnerCount ?? 0)),
      totalAttempts: row.assessmentCount ?? 0,
      averageScore: row.averagePercentage == null ? null : row.averagePercentage * 10,
      passRate: row.passRate ?? null,
      commonWeakDomains: toCommonWeakAreas(row.domains),
      completionRate: assignedTotal > 0 ? Math.min(100, (readyTotal / assignedTotal) * 100) : null,
      readyStudents: readyTotal,
    };
  }).filter((group) => group.studentCount > 0 || group.totalAttempts > 0);
  const domainPerformance = (authoritative.domains ?? []).map((row) => ({
    examKey: normalizeExamScopeKey(row.examKey),
    examTitle: getExamDisplayLabel(row.examKey),
    domainId: row.domainKey,
    domain: row.domainKey,
    domainLabel: row.domainKey,
    averagePercentage: row.averagePercentage,
    attemptCount: row.sampleCount,
    resultCount: row.sampleCount,
    weakCount: row.weakCount,
  }));
  const activityByLearner = new Map();
  (authoritative.learners ?? []).forEach((row) => {
    const current = activityByLearner.get(row.learnerId) ?? { totalAttempts: 0, latestAttemptDate: '' };
    current.totalAttempts += row.activityCount;
    if ((row.latestActivity || '') > current.latestAttemptDate) current.latestAttemptDate = row.latestActivity || '';
    activityByLearner.set(row.learnerId, current);
  });
  const activityRows = students.map((student) => ({ ...student, ...(activityByLearner.get(student.userId) ?? { totalAttempts: 0, latestAttemptDate: '' }) }));
  const activeRows = activityRows.filter((row) => row.totalAttempts > 0);
  return {
    ...pageDerived,
    analyticsMode: 'server-authoritative-full-scope',
    activityAnalytics: {
      mostActiveStudents: [...activeRows].sort((a, b) => b.totalAttempts - a.totalAttempts).slice(0, 5),
      leastActiveStudents: [...activeRows].sort((a, b) => a.totalAttempts - b.totalAttempts).slice(0, 5),
      studentsWithNoAttempts: activityRows.filter((row) => row.totalAttempts === 0).slice(0, 8),
    },
    assignmentReadiness,
    examAnalytics,
    groupAnalytics,
    studentReadiness,
    weakAreaAnalytics: {
      commonWeakAreas: toCommonWeakAreas(authoritative.domains).slice(0, 8),
      domainPerformance: domainPerformance.slice(0, 8),
    },
    readinessSummary: pageDerived.readinessSummary.map((entry) => ({
      ...entry,
      count: studentReadiness.filter((row) => row.readinessStatus === entry.id).length,
    })),
    totals: {
      ...pageDerived.totals,
      results: authoritative.totals?.historicalActivity ?? 0,
      students: authoritative.totals?.visibleLearners ?? students.length,
    },
  };
}

function toCommonWeakAreas(domains = []) {
  return domains
    .filter((domain) => Number(domain.weakCount ?? 0) > 0)
    .map((domain) => ({
      averagePercentage: domain.averagePercentage,
      label: `${domain.examKey}: ${domain.domainKey}`,
      occurrences: domain.weakCount,
      studentCount: domain.studentCount,
    }))
    .sort((left, right) => right.studentCount - left.studentCount || right.occurrences - left.occurrences);
}

function summarizeLearnerWeakDomains(rows = [], threshold = 70) {
  const domains = new Map();
  rows.forEach((row) => (row.domainAverages ?? []).filter(
    (domain) => domain.averagePercentage < threshold,
  ).forEach((domain) => {
    const key = `${row.examScopeKey}:${domain.domainKey ?? domain.domainId}`;
    const current = domains.get(key) ?? {
      averagePercentage: 0,
      label: `${row.examTitle}: ${domain.domainKey ?? domain.domainLabel}`,
      occurrences: 0,
      studentCount: 0,
    };
    current.averagePercentage += Number(domain.averagePercentage ?? 0);
    current.occurrences += Number(domain.sampleCount ?? 1);
    current.studentCount += 1;
    domains.set(key, current);
  }));
  return [...domains.values()].map((domain) => ({
    ...domain,
    averagePercentage: domain.studentCount ? domain.averagePercentage / domain.studentCount : null,
  }));
}

function groupRows(rows, getKey) {
  return rows.reduce((map, row) => {
    const key = getKey(row);
    if (key == null) return map;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
    return map;
  }, new Map());
}

function assignmentTargetsLearner(assignment, learner, assignmentLearnerByKey) {
  if (assignmentLearnerByKey?.has(`${assignment.id}:${learner.userId}`)) return true;
  if (assignment.studentUserId) return assignment.studentUserId === learner.userId;
  if (assignment.groupId && assignment.groupId === learner.groupId) return true;
  return (assignment.targetStudents ?? []).some((target) => target.userId === learner.userId);
}

function buildAssignmentSummary(assignment, attemptCount) {
  let status = 'not-started';
  let label = 'Not started';
  if (attemptCount > 0) { status = 'submitted'; label = 'Submitted for this exam'; }
  else if (isPastDue(assignment.dueAt)) { status = 'overdue'; label = 'Overdue - no attempt submitted'; }
  else if (isDueSoon(assignment.dueAt)) { status = 'due-soon'; label = 'Due soon'; }
  return { id: assignment.id, examKey: assignment.examKey, examTitle: assignment.examTitle,
    dueAt: assignment.dueAt, status, label };
}

function getAssignmentStatus(assignment, attemptCount, readinessStatus) {
  if (attemptCount > 0) {
    if (readinessStatus === 'ready') return { status: 'ready', label: 'Ready' };
    if (readinessStatus === 'almost-ready') return { status: 'completed-not-ready', label: 'Completed but not ready' };
    return { status: 'needs-review', label: 'Needs review' };
  }
  if (isPastDue(assignment.dueAt)) return { status: 'overdue', label: 'Overdue - no attempt submitted' };
  if (isDueSoon(assignment.dueAt)) return { status: 'due-soon', label: 'Due soon' };
  return { status: 'not-started', label: 'Not started' };
}

function isPastDue(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) && time < Date.now();
}

function isDueSoon(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) && time >= Date.now() && time - Date.now() <= 7 * 24 * 60 * 60 * 1000;
}
