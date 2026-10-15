export const ASSESSMENT_ATTEMPT_PURPOSES = Object.freeze([
  'assigned_assessment',
  'self_directed_exam',
]);

export const PRACTICE_ATTEMPT_PURPOSES = Object.freeze([
  'study_sandbox',
  'targeted_domain',
  'weak_area',
  'pbq_practice',
]);

const assessmentPurposes = new Set(ASSESSMENT_ATTEMPT_PURPOSES);
const practicePurposes = new Set(PRACTICE_ATTEMPT_PURPOSES);
const legacyPracticePatterns = [
  ['weak_area', /weak[-_ ]area|weak[-_ ]area[-_ ]focus/i],
  ['study_sandbox', /study[-_ ]sandbox|sandbox/i],
  ['targeted_domain', /targeted[-_ ]domain|targeted[-_ ]practice/i],
  ['pbq_practice', /pbq[-_ ]practice|pbq[-_ ]preview/i],
];

export function getAttemptPurpose(record = {}) {
  const snapshot = object(record.resultSnapshot ?? record.result_snapshot);
  const exam = object(snapshot.exam);
  const metadata = object(snapshot.metadata);
  const explicit = clean(record.purpose ?? snapshot.purpose ?? metadata.purpose ?? exam.purpose);
  if (assessmentPurposes.has(explicit) || practicePurposes.has(explicit)) return explicit;
  const legacyText = [record.sourceFlow, record.modeLabel, record.mode_label,
    snapshot.sourceFlow, metadata.sourceFlow, exam.sourceFlow,
    object(exam.mode).id, object(exam.mode).name].filter(Boolean).join(' ');
  return legacyPracticePatterns.find(([, pattern]) => pattern.test(legacyText))?.[0] ?? '';
}

export function classifyAttempt(record = {}) {
  const purpose = getAttemptPurpose(record);
  if (assessmentPurposes.has(purpose)) return { kind: 'assessment', purpose, authoritative: true };
  if (practicePurposes.has(purpose)) return { kind: 'practice', purpose, authoritative: true };
  return { kind: 'legacy-unclassified', purpose: '', authoritative: false };
}

export function isAssessmentResult(record = {}) {
  return classifyAttempt(record).kind === 'assessment';
}

export function getAttemptKindLabel(record = {}) {
  const kind = classifyAttempt(record).kind;
  if (kind === 'practice') return 'Practice';
  if (kind === 'assessment') return 'Exam attempt';
  return 'Historical attempt (type unavailable)';
}

function clean(value) {
  return String(value ?? '').trim().toLowerCase().replaceAll('-', '_').replaceAll(' ', '_');
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
