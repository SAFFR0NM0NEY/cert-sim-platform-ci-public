import { canonicalSerialize } from './canonical-json.mjs';

export const PBQ_RUNTIME_VERSION = 'certsim-protected-pbq-runtime-v1';
export const PBQ_SCORING_STRATEGIES = Object.freeze([
  'per-component-map', 'per-component-positive', 'exact-ordered-sequence',
  'weighted-rule-evaluation', 'exact-whole-state',
]);
const RESPONSE_KEYS = new Set(['selectedAnswer', 'selectedAnswers', 'selectedOrder', 'executedCommands', 'revision']);
const MAX_RESPONSE_BYTES = 64 * 1024;

export function validateAndCanonicalizePBQResponse(definition, response) {
  requirePlainObject(response, 'PBQ_RESPONSE_OBJECT_REQUIRED');
  if (Buffer.byteLength(JSON.stringify(response), 'utf8') > MAX_RESPONSE_BYTES) fail('PBQ_RESPONSE_TOO_LARGE');
  for (const key of Object.keys(response)) if (!RESPONSE_KEYS.has(key)) fail('PBQ_RESPONSE_UNKNOWN_KEY', key);
  const allowed = definition.responseAllowlist ?? {};
  const normalized = {};
  if (response.selectedAnswer !== undefined) {
    if (typeof response.selectedAnswer !== 'string' || !allowed.answerIds?.includes(response.selectedAnswer)) fail('PBQ_RESPONSE_FOREIGN_ANSWER');
    normalized.selectedAnswer = response.selectedAnswer;
  }
  if (response.selectedAnswers !== undefined) {
    requirePlainObject(response.selectedAnswers, 'PBQ_RESPONSE_MAP_REQUIRED');
    normalized.selectedAnswers = {};
    for (const [target, answer] of Object.entries(response.selectedAnswers).sort(([a], [b]) => a.localeCompare(b))) {
      if (!allowed.targetIds?.includes(target)) fail('PBQ_RESPONSE_FOREIGN_TARGET', target);
      const targetAnswers = Array.isArray(allowed.answerIdsByTarget)
        ? allowed.answerIdsByTarget.find((entry) => entry.targetId === target)?.answerIds
        : allowed.answerIdsByTarget?.[target];
      if (typeof answer !== 'string' || !targetAnswers?.includes(answer)) fail('PBQ_RESPONSE_FOREIGN_ANSWER', target);
      normalized.selectedAnswers[target] = answer;
    }
  }
  if (response.selectedOrder !== undefined) {
    if (!Array.isArray(response.selectedOrder)) fail('PBQ_RESPONSE_ORDER_REQUIRED');
    if (new Set(response.selectedOrder).size !== response.selectedOrder.length) fail('PBQ_RESPONSE_DUPLICATE_ORDER_ID');
    if (response.selectedOrder.some((id) => typeof id !== 'string' || !allowed.orderIds?.includes(id))) fail('PBQ_RESPONSE_FOREIGN_ORDER_ID');
    normalized.selectedOrder = [...response.selectedOrder];
  }
  if (response.executedCommands !== undefined) {
    if (!Array.isArray(response.executedCommands) || response.executedCommands.length > 100) fail('PBQ_RESPONSE_COMMANDS_INVALID');
    normalized.executedCommands = response.executedCommands.map((command) => {
      if (typeof command !== 'string' || command.length > 256) fail('PBQ_RESPONSE_COMMAND_INVALID');
      const canonical = normalizeCommand(command);
      if (!allowed.commandIds?.includes(canonical)) fail('PBQ_RESPONSE_COMMAND_NOT_ALLOWLISTED');
      return canonical;
    });
  }
  if (response.revision !== undefined) {
    if (!Number.isInteger(response.revision) || response.revision < 0) fail('PBQ_RESPONSE_REVISION_INVALID');
    normalized.revision = response.revision;
  }
  return Object.freeze({ value: normalized, canonical: canonicalSerialize(normalized) });
}

export function scorePBQResponse(privateScoring, canonicalResponse) {
  const response = typeof canonicalResponse === 'string' ? JSON.parse(canonicalResponse) : canonicalResponse;
  const strategy = privateScoring.strategy;
  if (!PBQ_SCORING_STRATEGIES.includes(strategy)) fail('PBQ_SCORING_STRATEGY_INVALID');
  let earned = 0;
  let maximum = 0;
  let complete = true;
  if (strategy === 'per-component-map' || strategy === 'per-component-positive') {
    const expected = privateScoring.expectedMap ?? {};
    maximum = Object.keys(expected).length;
    earned = Object.entries(expected).filter(([key, value]) => response.selectedAnswers?.[key] === value).length;
    if (strategy === 'per-component-positive' && Object.entries(response.selectedAnswers ?? {}).some(([key, value]) => expected[key] !== value)) complete = false;
  } else if (strategy === 'exact-ordered-sequence') {
    const expected = privateScoring.expectedOrder ?? [];
    maximum = expected.length;
    earned = expected.filter((id, index) => response.selectedOrder?.[index] === id).length;
  } else if (strategy === 'weighted-rule-evaluation') {
    maximum = privateScoring.finalAnswerPoints + privateScoring.criteria.reduce((sum, item) => sum + item.points, 0);
    if (response.selectedAnswer === privateScoring.expectedAnswer) earned += privateScoring.finalAnswerPoints;
    const commands = new Set(response.executedCommands ?? []);
    for (const criterion of privateScoring.criteria) if (criterion.commandIds.some((id) => commands.has(id))) earned += criterion.points;
  } else {
    maximum = 1;
    earned = response.selectedAnswer === privateScoring.expectedAnswer ? 1 : 0;
  }
  const answered = Object.keys(response).some((key) => key !== 'revision');
  const commandSet = new Set(response.executedCommands ?? []);
  if ((privateScoring.requiredCommandIds ?? []).some((id) => !commandSet.has(id))) complete = false;
  const status = !answered || !complete ? 'Incomplete' : earned === maximum ? 'Correct' : earned > 0 ? 'Partial' : 'Incorrect';
  return Object.freeze({ status, earnedPoints: earned, maxPoints: maximum, scoringStrategy: strategy });
}

export function applyPBQReviewPolicy(result, privateReview, policy, attemptStatus) {
  const released = policy === 'immediate_study_feedback' || (policy === 'after_submission' && attemptStatus === 'completed');
  return released ? { ...result, review: privateReview } : { ...result };
}

export function simulateTerminalCommand(command, presentation) {
  const normalized = normalizeCommand(command);
  if (!presentation.allowedCommands?.includes(normalized)) return { status: 'rejected', code: 'COMMAND_NOT_ALLOWLISTED' };
  return { status: 'accepted', commandId: normalized, outputId: presentation.outputIdByCommand?.[normalized] ?? null };
}

function normalizeCommand(value) { return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase(); }
function requirePlainObject(value, code) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code); }
function fail(code, path) { throw new Error(path ? `${code} [${path}]` : code); }
