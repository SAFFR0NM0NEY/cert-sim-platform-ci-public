const STAGE1_BINDING = Object.freeze({
  examKey: 'az204',
  packageVersion: '1.1.0',
  profileKey: 'compact-profile',
  purpose: 'self_directed_exam',
});

export function discoverStage1Result(historyItems) {
  if (!Array.isArray(historyItems)) throw new Error('MALFORMED_HISTORY');
  const candidates = historyItems.filter((item) => item && typeof item === 'object' &&
    Object.entries(STAGE1_BINDING).every(([key, value]) => item[key] === value));
  if (candidates.length !== 1 || typeof candidates[0].attemptId !== 'string' || !candidates[0].attemptId) {
    throw new Error('STAGE1_RESULT_NOT_UNIQUE');
  }
  return candidates[0];
}

export function verifyStage1Result(candidate, response) {
  const result = response?.data?.result;
  if (response?.status !== 200 || !result || typeof result !== 'object') throw new Error('RESULT_RETRIEVAL_FAILED');
  if (result.serverAuthoritative !== true) throw new Error('RESULT_NOT_AUTHORITATIVE');
  const historyBindingVerified = Object.entries(STAGE1_BINDING).every(([key, value]) => candidate[key] === value);
  const resultBoundToDiscoveredEntry = result.attemptId === candidate.attemptId &&
    result.examKey === candidate.examKey && result.profileKey === candidate.profileKey;
  if (!historyBindingVerified || !resultBoundToDiscoveredEntry) throw new Error('RESULT_BINDING_FAILED');
  return Object.freeze({
    ok: true,
    stage: 'stage1-read-only-result-verification',
    historyCandidateCount: 1,
    historyBindingVerified,
    resultRequests: 1,
    resultBoundToDiscoveredEntry,
    serverAuthoritative: result.serverAuthoritative === true,
    lifecycleRequests: 0,
  });
}
