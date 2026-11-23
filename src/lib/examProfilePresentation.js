// Display only. Never changes profile identity, purpose, selection or scoring.
import { classifyAttempt } from './attemptPurpose.js';
export function getProfilePresentation({ examKey, profileKey = '', purpose, name = '' } = {}) {
  if (classifyAttempt({ purpose }).kind === 'practice') return { name, note: '' };
  if (/compact/i.test(profileKey)) return {
    name: 'Compact Simulation',
    note: 'A shorter timed examination simulation. Study Sandbox and other practice tools are available separately.',
  };
  if (/full/i.test(profileKey) || (examKey === 'inf303' && profileKey === 'inf303-standard')) return {
    name: examKey === 'az400' && profileKey === 'az400-sectioned-full-exam-profile' ? 'Sectioned Full Simulation' : 'Full Simulation',
    note: 'A complete timed examination simulation. CertSim is an unofficial simulator; official examination equivalence is not guaranteed.',
  };
  return { name, note: '' };
}

export function formatProfileQuestionCount(profile = {}) {
  const counts = profile.countPolicy?.allowedCounts;
  return Array.isArray(counts) && counts.length
    ? counts.join(' or ')
    : profile.totalScoredQuestions ?? profile.totalItems;
}

export function getAttemptDurationMinutes(attempt = {}) {
  if (attempt.timed === false) return null;
  const start = Date.parse(attempt.startedAt), end = Date.parse(attempt.expiresAt);
  return Number.isFinite(start) && Number.isFinite(end) && end > start
    ? (end - start) / 60000
    : Number.isFinite(attempt.timeLimitMinutes) ? attempt.timeLimitMinutes : null;
}

export function projectProfilePresentation(profile = {}, authority = {}, attempt = null) {
  const presentation = getProfilePresentation({
    examKey: attempt?.examKey ?? authority.examKey,
    profileKey: attempt?.profileKey ?? authority.profileKey ?? profile.id,
    packageVersion: attempt?.packageVersion ?? authority.packageVersion,
    purpose: attempt?.purpose ?? authority.purpose,
    name: attempt?.profileName ?? profile.name,
  });
  const minutes = attempt ? getAttemptDurationMinutes(attempt) : authority.timeLimitMinutes;
  return { ...profile, name: presentation.name, displayName: presentation.name,
    ...(Number.isFinite(minutes) ? { timeLimitMinutes: minutes } : {}),
    purposeNote: presentation.note };
}
