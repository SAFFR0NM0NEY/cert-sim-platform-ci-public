export const DEFAULT_ATTEMPT_HISTORY_EXAM_ID = 'az204';
export const ATTEMPT_HISTORY_VERSION = 'v1';
export const ATTEMPT_HISTORY_STORAGE_KEY = getAttemptHistoryStorageKey(
  DEFAULT_ATTEMPT_HISTORY_EXAM_ID,
);
export const MAX_ATTEMPT_HISTORY_RECORDS = 10;

const STORAGE_UNAVAILABLE_MESSAGE =
  'Attempt history is unavailable in this browser session. The app is still usable.';
const STORAGE_SAVE_FAILED_MESSAGE =
  'Attempt history could not be saved locally. The app is still usable.';
const STORAGE_CLEAR_FAILED_MESSAGE =
  'Attempt history could not be cleared. Check browser storage settings.';

export function getAttemptHistory(examId = DEFAULT_ATTEMPT_HISTORY_EXAM_ID) {
  if (!hasLocalStorage()) {
    return { records: [], error: STORAGE_UNAVAILABLE_MESSAGE };
  }

  try {
    const rawHistory = window.localStorage.getItem(
      getAttemptHistoryStorageKey(examId),
    );

    if (!rawHistory) {
      return { records: [], error: null };
    }

    const parsedHistory = JSON.parse(rawHistory);
    const records = Array.isArray(parsedHistory)
      ? parsedHistory.map(normalizeHistoryRecord).filter(Boolean)
      : [];

    return { records, error: null };
  } catch {
    return {
      records: [],
      error: 'Attempt history could not be read. The app is still usable.',
    };
  }
}

export function saveAttemptHistoryRecord(
  record,
  examId = record?.examRegistryId ?? DEFAULT_ATTEMPT_HISTORY_EXAM_ID,
) {
  const currentHistory = getAttemptHistory(examId);

  if (!hasLocalStorage()) {
    return currentHistory;
  }

  try {
    const currentRecords = currentHistory.records ?? [];
    const normalizedRecord = normalizeHistoryRecord(record);

    if (!normalizedRecord) {
      return {
        records: currentRecords,
        error: 'Attempt history record was incomplete and was not saved.',
      };
    }

    const nextRecords = [
      normalizedRecord,
      ...currentRecords.filter((item) => item.id !== normalizedRecord.id),
    ].slice(0, MAX_ATTEMPT_HISTORY_RECORDS);

    window.localStorage.setItem(
      getAttemptHistoryStorageKey(examId),
      JSON.stringify(nextRecords),
    );

    return { records: nextRecords, error: null };
  } catch {
    return {
      records: currentHistory.records ?? [],
      error: STORAGE_SAVE_FAILED_MESSAGE,
    };
  }
}

export function clearAttemptHistory(examId = DEFAULT_ATTEMPT_HISTORY_EXAM_ID) {
  if (!hasLocalStorage()) {
    return { records: [], error: STORAGE_UNAVAILABLE_MESSAGE };
  }

  try {
    window.localStorage.removeItem(getAttemptHistoryStorageKey(examId));
    return { records: [], error: null };
  } catch {
    return {
      records: getAttemptHistory(examId).records,
      error: STORAGE_CLEAR_FAILED_MESSAGE,
    };
  }
}

export function createAttemptHistoryRecord(result) {
  const domainBreakdown = (result.domainBreakdown ?? []).map((domainResult) => ({
    domain: domainResult.domain,
    correct: domainResult.correct,
    total: domainResult.total,
    percentage: domainResult.percentage,
  }));
  const weakDomains = getWeakDomains(domainBreakdown);
  const weakestDomain = getWeakestDomain(domainBreakdown);
  const timeUsedSeconds = getTimeUsedSeconds(result);

  return {
    id: createAttemptHistoryId(result),
    attemptedAt: result.submittedAt ?? new Date().toISOString(),
    examRegistryId: result.exam?.registryId ?? DEFAULT_ATTEMPT_HISTORY_EXAM_ID,
    examCode: result.exam?.code ?? 'Not recorded',
    examVendor: result.exam?.vendor ?? 'Not recorded',
    studentName: result.student?.name ?? 'Unknown student',
    studentEmail: result.student?.email ?? 'Not recorded',
    campusCompany: result.student?.campusCompany ?? '',
    examId: result.exam?.id ?? 'unknown-exam',
    examName: result.exam?.name ?? 'Unknown exam',
    examMode: result.exam?.mode?.name ?? 'Not recorded',
    selectedProfileName: result.exam?.profile?.name ?? 'Not recorded',
    profileId: result.exam?.profile?.id ?? 'Not recorded',
    codingLanguagePreference: result.exam?.codingLanguagePreference ?? null,
    codingLanguageLabel: result.exam?.codingLanguageLabel ?? null,
    timerLengthMinutes: result.exam?.durationMinutes ?? null,
    totalScoredQuestions: result.totalScoredQuestions,
    correctCount: result.totalCorrect,
    unansweredCount: result.unansweredQuestions?.length ?? 0,
    incompleteCount: result.incompleteQuestions?.length ?? 0,
    openQuestionCount:
      (result.unansweredQuestions?.length ?? 0) +
      (result.incompleteQuestions?.length ?? 0),
    flaggedCount: result.flaggedQuestionIds?.length ?? 0,
    percentage: result.percentage,
    scaledScore: result.scaledScore ?? result.microsoftScore,
    scoreLabel: result.exam?.scoreLabel ?? 'Microsoft-style score',
    scoreScale: result.scoreScale ?? result.exam?.scoreScale ?? {
      min: 0,
      max: 1000,
      pass: result.passingScoreOutOf1000,
    },
    microsoftScore: result.microsoftScore,
    passed: result.passed,
    passingScore: result.passingScore ?? result.passingScoreOutOf1000,
    passingScoreOutOf1000: result.passingScoreOutOf1000,
    domainBreakdown,
    weakDomains,
    weakestDomain,
    ...(timeUsedSeconds === null ? {} : { timeUsedSeconds }),
  };
}

export function getAttemptHistoryStorageKey(
  examId = DEFAULT_ATTEMPT_HISTORY_EXAM_ID,
) {
  return `certsim.${examId}.attemptHistory.${ATTEMPT_HISTORY_VERSION}`;
}

export function getWeakDomains(domainBreakdown) {
  return [...(domainBreakdown ?? [])]
    .filter((domainResult) => domainResult.percentage < 70)
    .sort((a, b) => {
      if (a.percentage !== b.percentage) {
        return a.percentage - b.percentage;
      }

      return a.domain.localeCompare(b.domain);
    });
}

function getWeakestDomain(domainBreakdown) {
  const [weakestDomain] = [...(domainBreakdown ?? [])].sort((a, b) => {
    if (a.percentage !== b.percentage) {
      return a.percentage - b.percentage;
    }

    return a.domain.localeCompare(b.domain);
  });

  return weakestDomain ?? null;
}

function normalizeHistoryRecord(record) {
  if (!record || !record.id || !record.attemptedAt) {
    return null;
  }

  const domainBreakdown = Array.isArray(record.domainBreakdown)
    ? record.domainBreakdown.map(normalizeDomainResult).filter(Boolean)
    : [];

  return {
    ...record,
    domainBreakdown,
    weakDomains: getWeakDomains(domainBreakdown),
    weakestDomain: record.weakestDomain
      ? normalizeDomainResult(record.weakestDomain)
      : getWeakestDomain(domainBreakdown),
  };
}

function normalizeDomainResult(domainResult) {
  if (!domainResult?.domain) {
    return null;
  }

  return {
    domain: domainResult.domain,
    correct: Number(domainResult.correct ?? 0),
    total: Number(domainResult.total ?? 0),
    percentage: Number(domainResult.percentage ?? 0),
  };
}

function createAttemptHistoryId(result) {
  const examKey = result.exam?.registryId ?? DEFAULT_ATTEMPT_HISTORY_EXAM_ID;
  const source = [
    examKey,
    result.exam?.id,
    result.exam?.generatedAt,
    result.submittedAt,
    result.student?.email,
    result.exam?.profile?.id,
  ].join('|');

  return `${examKey}-${hashString(source)}`;
}

function hashString(value) {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return hash.toString(16).padStart(8, '0');
}

function getTimeUsedSeconds(result) {
  const durationSeconds = Number(result.exam?.durationMinutes) * 60;
  const remainingSeconds = Number(result.remainingSeconds);

  if (!Number.isFinite(durationSeconds) || !Number.isFinite(remainingSeconds)) {
    return null;
  }

  return Math.max(0, durationSeconds - remainingSeconds);
}

function hasLocalStorage() {
  return (
    typeof window !== 'undefined' &&
    typeof window.localStorage !== 'undefined'
  );
}
