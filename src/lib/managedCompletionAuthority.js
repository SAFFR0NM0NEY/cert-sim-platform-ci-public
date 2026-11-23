import { completionContractError, completionDeadlineAnchor, normalizeCompletionStatus } from './protectedCompletionStatus.js';

export function createManagedCompletionAuthority({ now = () => performance.now() } = {}) {
  let binding = null, status = null, deadlineAt = null, expired = false, suspended = false;
  function isExpired() {
    if (status?.expiryManaged && deadlineAt !== null && now() >= deadlineAt) expired = true;
    return expired;
  }
  return Object.freeze({
    reset: (attemptId, accountId) => { binding = { attemptId, accountId }; status = null; deadlineAt = null; expired = false; suspended = false; },
    matches: (attemptId, accountId) => binding?.attemptId === attemptId && binding?.accountId === accountId,
    observe: (next, requestStartedAt) => {
      normalizeCompletionStatus(next, binding?.attemptId);
      if (status?.expiryManaged && (!next.expiryManaged || next.deadline !== status.deadline)) throw completionContractError();
      status = next;
      if (next.expiryManaged) {
        const anchor = completionDeadlineAnchor(next, requestStartedAt, now());
        deadlineAt = deadlineAt === null ? anchor.deadlineAt : Math.min(deadlineAt, anchor.deadlineAt);
        if (!next.answeringAllowed) expired = true;
        isExpired();
        suspended = false;
      }
      return next;
    },
    suspend: () => { if (status?.expiryManaged) suspended = true; },
    isManaged: () => status?.expiryManaged === true,
    isExpired,
    isLocked: () => status?.expiryManaged === true && (isExpired() || suspended || !status.answeringAllowed),
    remainingSeconds: () => status?.expiryManaged ? Math.max(0, Math.ceil(((deadlineAt ?? now()) - now()) / 1000)) : null,
    getStatus: () => status,
  });
}
