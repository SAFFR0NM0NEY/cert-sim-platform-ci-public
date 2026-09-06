import { getExamDisplayMetadata } from '../exams/examDisplayMetadata.js';
import { examRegistry } from '../exams/examRegistry.protected.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function getAssignedExamLaunchRoute(assignment = {}) {
  if (assignment.contractVersion !== 'live-v2') {
    return assignment.examRoute ?? '';
  }

  const assignmentId = cleanText(assignment.id || assignment.assignmentId);
  const profileId = cleanText(assignment.profileId);
  const display = getExamDisplayMetadata(assignment.examKey);
  const examConfig = display
    ? examRegistry.find((candidate) => candidate.id === display.canonicalId)
    : null;
  const profile = examConfig?.strictBetaProfiles?.find(
    (candidate) => candidate.id === profileId,
  );

  if (!UUID_PATTERN.test(assignmentId) || !display?.routeSlug || !profile?.routeAction) {
    return '';
  }

  return `/exams/${encodeURIComponent(display.routeSlug)}/${encodeURIComponent(profile.routeAction)}?assignment=${encodeURIComponent(assignmentId)}`;
}

export function getAssignedExamAction(assignment = {}, now = Date.now()) {
  if (assignment.activeAttempt) {
    return enabledAction('resume', 'Resume assigned exam', assignment.assignmentLaunchRoute);
  }

  if (assignment.latestResult) {
    return enabledAction('result', 'View result', assignment.savedResultRoute);
  }

  const status = cleanText(assignment.status).toLowerCase();
  if (status === 'revoked') {
    return disabledAction('This assignment has been revoked.');
  }
  if (status === 'archived') {
    return disabledAction('This assignment is archived.');
  }
  if (status === 'closed') {
    return disabledAction('This assignment is closed.');
  }

  const availableFrom = parseTime(assignment.availableFrom);
  if (availableFrom && availableFrom > now) {
    return disabledAction(`Available ${new Date(availableFrom).toLocaleString()}.`);
  }

  const dueAt = parseTime(assignment.dueAt);
  if (dueAt && dueAt < now) {
    return disabledAction('This assignment has expired.');
  }

  if (assignment.attemptsRemaining === 0) {
    return disabledAction('The assignment attempt limit has been reached.');
  }

  if (!assignment.assignmentLaunchRoute) {
    return disabledAction('This assigned exam is not available to launch.');
  }

  return enabledAction('start', 'Start assigned exam', assignment.assignmentLaunchRoute);
}

function enabledAction(kind, label, href) {
  return href
    ? { enabled: true, href, kind, label, reason: '' }
    : disabledAction('This assigned exam is not available to open.');
}

function disabledAction(reason) {
  return { enabled: false, href: '', kind: 'unavailable', label: 'Unavailable', reason };
}

function parseTime(value) {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}
