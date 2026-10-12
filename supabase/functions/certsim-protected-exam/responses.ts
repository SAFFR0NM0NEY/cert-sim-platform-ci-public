import { SafeError } from "./errors.ts";

const BASE_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};
export function jsonResponse(
  status: number,
  body: unknown,
  extra: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, ...Object.fromEntries(new Headers(extra)) },
  });
}
export function errorResponse(
  error: SafeError,
  correlationId: string,
  extra: HeadersInit = {},
): Response {
  return jsonResponse(error.status, {
    error: { code: error.code, correlationId },
  }, extra);
}

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SafeError("internal_failure");
  }
  return value as Obj;
};
const pick = (source: Obj, keys: readonly string[]): Obj =>
  Object.fromEntries(
    keys.filter((key) => key in source).map((key) => [key, source[key]]),
  );
const safeArray = (value: unknown, mapper: (v: Obj) => Obj): Obj[] =>
  Array.isArray(value) ? value.map((v) => mapper(object(v))) : [];

export function mapEligibility(raw: unknown): Obj {
  const v = object(raw);
  return pick(v, [
    "eligible",
    "reasonCode",
    "examKey",
    "packageVersion",
    "profileKey",
    "profileName",
    "questionCount",
    "timeLimitMinutes",
    "purpose",
  ]);
}
export function mapAttempt(raw: unknown): Obj {
  const v = object(raw);
  const attempt = object(v.attempt);
  if (attempt.assignmentId != null && typeof attempt.assignmentId !== "string") {
    throw new SafeError("internal_failure");
  }
  return {
    attempt: normalizeAttemptLanguage(pick(attempt, [
      "attemptId",
      "assignmentId",
      "examKey",
      "packageVersion",
      "profileKey",
      "profileName",
      "status",
      "startedAt",
      "expiresAt",
      "timeLimitMinutes",
      "timed",
      "itemCount",
      "purpose",
      "languagePreference",
    ])),
    items: mapPresentationItems(v.items, (item, questionNumber) => ({
      ...pick(item, [
        "itemId",
        "questionId",
        "questionType",
        "domain",
        "section",
        "response",
        "revision",
      ]),
      questionNumber,
      presentation: sanitizeQuestionPresentation(item.questionType, item.presentation),
    })),
    page: v.page == null
      ? { afterPosition: 0, returnedThrough: Array.isArray(v.items) ? v.items.length : 0, totalCount: Array.isArray(v.items) ? v.items.length : 0, hasMore: false }
      : pick(object(v.page), ["afterPosition", "returnedThrough", "totalCount", "hasMore"]),
  };
}

export function mapAttemptItemPage(raw: unknown): Obj {
  const v = object(raw);
  const afterPosition = Number(v.afterPosition);
  const returnedThrough = Number(v.returnedThrough);
  const totalCount = Number(v.totalCount);
  if (!Number.isInteger(v.afterPosition) || !Number.isInteger(v.returnedThrough) ||
    !Number.isInteger(v.totalCount) || typeof v.hasMore !== "boolean" ||
    returnedThrough < afterPosition || returnedThrough > totalCount) {
    throw new SafeError("internal_failure");
  }
  return {
    ...pick(v, ["afterPosition", "returnedThrough", "totalCount", "hasMore"]),
    items: mapPresentationItems(v.items, (item, questionNumber) => ({
      ...pick(item, ["itemId", "questionId", "questionType", "domain", "section", "response", "revision"]),
      questionNumber: Number.isInteger(item.questionNumber) ? item.questionNumber : questionNumber,
      presentation: sanitizeQuestionPresentation(item.questionType, item.presentation),
    })),
  };
}

export function mapCurrentAttemptBindings(raw: unknown): Obj {
  const value = object(raw);
  if (!Array.isArray(value.candidates) || value.candidates.length > 8) {
    throw new SafeError("internal_failure");
  }
  return {
    candidates: safeArray(value.candidates, (candidate) => {
      for (const key of ["attemptId", "examKey", "packageVersion", "profileKey", "profileName", "purpose", "startedAt"]) {
        if (typeof candidate[key] !== "string" || !candidate[key]) throw new SafeError("internal_failure");
      }
      if (candidate.expiresAt != null && typeof candidate.expiresAt !== "string") throw new SafeError("internal_failure");
      if (typeof candidate.timed !== "boolean") throw new SafeError("internal_failure");
      if (candidate.languagePreference != null && typeof candidate.languagePreference !== "string") throw new SafeError("internal_failure");
      if (candidate.assignmentId != null && typeof candidate.assignmentId !== "string") throw new SafeError("internal_failure");
      if (typeof candidate.replacementPermitted !== "boolean") throw new SafeError("internal_failure");
      if (!Number.isInteger(candidate.selectedCount) || typeof candidate.fixedProfileSize !== "boolean") throw new SafeError("internal_failure");
      object(candidate.profileComposition);
      return normalizeAttemptLanguage(pick(candidate, ["attemptId", "assignmentId", "examKey", "packageVersion", "profileKey", "profileName", "purpose", "languagePreference", "startedAt", "expiresAt", "timed", "selectedCount", "fixedProfileSize", "profileComposition", "replacementPermitted"]));
    }),
  };
}

function normalizeAttemptLanguage<T extends Obj>(value: T): T {
  if (value.examKey !== "az204" && value.languagePreference === "not_applicable") {
    return { ...value, languagePreference: null } as T;
  }
  return value;
}
export function mapSavedResponse(raw: unknown): Obj {
  return pick(object(raw), ["itemId", "revision", "updatedAt"]);
}
export function mapPythonWorkspace(raw: unknown): Obj {
  const value = object(raw);
  requireOnlyKeys(value, ["ok", "itemId", "exists", "revision", "workspaceHash", "workspace", "updatedAt"]);
  if (typeof value.itemId !== "string" || typeof value.exists !== "boolean" ||
    !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 ||
    (value.workspaceHash !== null && (typeof value.workspaceHash !== "string" || !/^[0-9a-f]{64}$/.test(value.workspaceHash))) ||
    (value.updatedAt !== null && typeof value.updatedAt !== "string") ||
    (value.exists ? !value.workspace || typeof value.workspace !== "object" || Array.isArray(value.workspace) : value.workspace !== null)) {
    throw new SafeError("internal_failure");
  }
  return pick(value, ["itemId", "exists", "revision", "workspaceHash", "workspace", "updatedAt"]);
}
export function mapPythonWorkspaceSave(raw: unknown): Obj {
  const value = object(raw);
  requireOnlyKeys(value, ["ok", "itemId", "revision", "workspaceHash", "updatedAt"]);
  if (typeof value.itemId !== "string" || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 ||
    typeof value.workspaceHash !== "string" || !/^[0-9a-f]{64}$/.test(value.workspaceHash) ||
    typeof value.updatedAt !== "string") throw new SafeError("internal_failure");
  return pick(value, ["itemId", "revision", "workspaceHash", "updatedAt"]);
}
export function mapPythonRun(raw: unknown): Obj {
  const value = object(raw);
  requireOnlyKeys(value, ["ok", "runId", "state", "terminalOutcome", "stdout", "stderr", "exitCode", "cancellationRequestedAt", "disposalState", "createdAt", "updatedAt"]);
  const states = new Set(["authorized", "queued", "running", "cancel_requested", "completed", "failed", "cancelled"]);
  const outcomes = new Set(["completed", "timeout", "resource_limit", "failed", "cancelled"]);
  const disposal = new Set(["not_requested", "pending", "confirmed", "failed"]);
  if (typeof value.runId !== "string" || typeof value.state !== "string" || !states.has(value.state) ||
    (value.terminalOutcome !== null && (typeof value.terminalOutcome !== "string" || !outcomes.has(value.terminalOutcome))) ||
    typeof value.stdout !== "string" || typeof value.stderr !== "string" ||
    new TextEncoder().encode(value.stdout).byteLength + new TextEncoder().encode(value.stderr).byteLength > 1024 * 1024 ||
    (value.exitCode !== null && (!Number.isSafeInteger(value.exitCode) || Number(value.exitCode) < 0 || Number(value.exitCode) > 255)) ||
    (value.cancellationRequestedAt !== null && typeof value.cancellationRequestedAt !== "string") ||
    typeof value.disposalState !== "string" || !disposal.has(value.disposalState) ||
    typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") {
    throw new SafeError("internal_failure");
  }
  return pick(value, ["runId", "state", "terminalOutcome", "stdout", "stderr", "exitCode", "cancellationRequestedAt", "disposalState", "createdAt", "updatedAt"]);
}
export function mapLatestPythonRun(raw: unknown): Obj {
  const value = object(raw);
  requireOnlyKeys(value, ["ok", "itemId", "workspaceRevision", "run"]);
  if (typeof value.itemId !== "string" || !Number.isSafeInteger(value.workspaceRevision) ||
    Number(value.workspaceRevision) < 0 || (value.run !== null && typeof value.run !== "object")) {
    throw new SafeError("internal_failure");
  }
  const run = value.run === null
    ? null
    : mapPythonRun({ ok: true, ...object(value.run) });
  return { itemId: value.itemId, workspaceRevision: value.workspaceRevision, run };
}
export function mapFlags(raw: unknown): Obj {
  const value = object(raw);
  if (!Array.isArray(value.itemIds) || value.itemIds.some((id) => typeof id !== "string")) throw new SafeError("internal_failure");
  return { itemIds: value.itemIds };
}
export function mapFlag(raw: unknown): Obj {
  const value = object(raw);
  if (typeof value.itemId !== "string" || typeof value.flagged !== "boolean") throw new SafeError("internal_failure");
  return pick(value, ["itemId", "flagged", "updatedAt"]);
}
export function mapQuestionIssue(raw: unknown): Obj {
  const value = object(raw);
  if (value.received !== true) throw new SafeError("internal_failure");
  return { received: true };
}
export function mapAbandonedAttempt(raw: unknown): Obj {
  const value = object(raw);
  if (value.status !== "abandoned" || typeof value.attemptId !== "string") {
    throw new SafeError("internal_failure");
  }
  return pick(value, ["attemptId", "status", "abandonedAt"]);
}

const ATTEMPT_PURPOSE_VALUES = new Set([
  "assigned_assessment",
  "self_directed_exam",
  "study_sandbox",
  "targeted_domain",
  "weak_area",
  "pbq_practice",
]);
const ATTEMPT_STATUS_VALUES = new Set([
  "in_progress",
  "submitted",
  "completed",
  "expired",
  "abandoned",
  "voided",
]);
const SANDBOX_CANDIDATE_LIMIT = 8;
const LIFECYCLE_COUNT_LIMIT = 10_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXAM_KEY_PATTERN = /^[a-z0-9][a-z0-9+._-]*$/i;
const PROFILE_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const PACKAGE_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function lifecycleString(value: unknown, maximumLength = 200): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximumLength) {
    throw new SafeError("internal_failure");
  }
  return value;
}

function lifecycleUuid(value: unknown): string {
  const uuid = lifecycleString(value, 36);
  if (!UUID_PATTERN.test(uuid)) throw new SafeError("internal_failure");
  return uuid;
}

function lifecycleDate(value: unknown): string {
  const date = lifecycleString(value, 64);
  if (!ISO_TIMESTAMP_PATTERN.test(date) || !Number.isFinite(Date.parse(date))) {
    throw new SafeError("internal_failure");
  }
  return date;
}

function lifecycleCount(value: unknown): number {
  const count = normalizeCount(value);
  if (count > LIFECYCLE_COUNT_LIMIT) throw new SafeError("internal_failure");
  return count;
}

export function mapAttemptLifecycleSummary(raw: unknown): Obj {
  const value = object(raw);
  const purpose = lifecycleString(value.purpose, 40);
  const status = lifecycleString(value.status, 20);
  if (!ATTEMPT_PURPOSE_VALUES.has(purpose) || !ATTEMPT_STATUS_VALUES.has(status)) {
    throw new SafeError("internal_failure");
  }
  return {
    attemptId: lifecycleUuid(value.attemptId),
    purpose,
    status,
    savedResponseCount: lifecycleCount(value.savedResponseCount),
  };
}

export function mapRecoverableStudySandboxes(raw: unknown): Obj {
  const value = object(raw);
  if (!Array.isArray(value.candidates) || value.candidates.length > SANDBOX_CANDIDATE_LIMIT) {
    throw new SafeError("internal_failure");
  }
  return {
    candidates: value.candidates.map((rawCandidate) => {
      const candidate = object(rawCandidate);
      const languagePreference = candidate.languagePreference;
      const examKey = lifecycleString(candidate.examKey, 64);
      const packageVersion = lifecycleString(candidate.packageVersion, 64);
      const profileKey = lifecycleString(candidate.profileKey, 128);
      if (candidate.purpose !== "study_sandbox" || candidate.recoverable !== true ||
        !EXAM_KEY_PATTERN.test(examKey) || !PACKAGE_VERSION_PATTERN.test(packageVersion) ||
        !PROFILE_KEY_PATTERN.test(profileKey) ||
        (examKey === "az204"
          ? !["csharp", "python", "mixed"].includes(String(languagePreference))
          : languagePreference !== null && languagePreference !== "not_applicable")) {
        throw new SafeError("internal_failure");
      }
      const itemCount = lifecycleCount(candidate.itemCount);
      const savedResponseCount = lifecycleCount(candidate.savedResponseCount);
      if (savedResponseCount > itemCount) throw new SafeError("internal_failure");
      return normalizeAttemptLanguage({
        attemptId: lifecycleUuid(candidate.attemptId),
        examKey,
        packageVersion,
        profileKey,
        profileName: lifecycleString(candidate.profileName, 200),
        purpose: "study_sandbox",
        languagePreference,
        startedAt: lifecycleDate(candidate.startedAt),
        lastActivityAt: lifecycleDate(candidate.lastActivityAt),
        itemCount,
        savedResponseCount,
        recoverable: true,
      });
    }),
  };
}

export function mapStudySandboxRecovery(raw: unknown): Obj {
  const value = object(raw);
  if (value.status !== "in_progress") throw new SafeError("internal_failure");
  return {
    attemptId: lifecycleUuid(value.attemptId),
    status: "in_progress",
    recoveredAt: lifecycleDate(value.recoveredAt),
    savedResponseCount: lifecycleCount(value.savedResponseCount),
  };
}
export function mapResult(raw: unknown): Obj {
  const result = object(object(raw).result);
  return {
    result: pick(result, [
      "attemptId",
      "examKey",
      "profileKey",
      "completedAt",
      "questionCount",
      "answeredCount",
      "rawScore",
      "maxScore",
      "rawPercentage",
      "scaledScore",
      "passed",
      "passMark",
      "domainBreakdown",
      "reviewStatus",
      "serverAuthoritative",
    ]),
  };
}
export function mapReview(raw: unknown): Obj {
  const review = object(object(raw).review);
  return {
    review: {
      items: mapPresentationItems(review.items, (item, questionNumber) => {
        if (item.questionType === "executable-python-lab-v1") {
          return {
            ...pick(item, [
              "itemId", "questionType", "status", "earnedPoints", "maxPoints",
            ]),
            questionNumber,
            presentation: sanitizeQuestionPresentation(item.questionType, item.presentation),
          };
        }
        const mapped = {
          ...pick(item, [
          "itemId",
          "questionId",
          "questionType",
          "domain",
          "section",
          "response",
          "status",
          "earnedPoints",
          "maxPoints",
          "correctAnswer",
          "explanation",
          "remediation",
          ]),
          questionNumber,
          presentation: sanitizeQuestionPresentation(item.questionType, item.presentation),
        };
        let wholeStateDisplayUnavailable = false;
        if ("correctAnswer" in mapped) {
          mapped.correctAnswer = sanitizeReleasedCorrectAnswer(item.questionType, mapped.correctAnswer);
          wholeStateDisplayUnavailable = isReleasedAnswerUnavailable(mapped.correctAnswer);
        }
        if ("response" in mapped) {
          mapped.response = sanitizeReleasedPbqResponse(
            item.questionType,
            mapped.response,
            wholeStateDisplayUnavailable,
          );
        }
        return mapped;
      }),
    },
  };
}

const PBQ_REVIEW_TYPES = new Set([
  "pbq-terminal", "pbq-multi-host-terminal", "pbq-firewall", "pbq-siem",
  "pbq-network-diagram", "pbq-config-panel", "pbq-hotspot",
  "pbq-drag-drop-match", "pbq-ordering", "pbq-workspace",
]);
const PBQ_REVIEW_STRATEGIES = new Set([
  "per-component-map", "per-component-positive", "exact-ordered-sequence",
  "weighted-rule-evaluation", "exact-whole-state",
]);
const RELEASED_ANSWER_UNAVAILABLE = Object.freeze({ displayUnavailable: true });

function sanitizeReleasedCorrectAnswer(questionType: unknown, value: unknown): unknown {
  if (!isSupportedPbqReviewType(questionType)) return value;
  const source = object(value);
  const strategy = source.strategy;
  if (typeof strategy !== "string" || !PBQ_REVIEW_STRATEGIES.has(strategy)) {
    throw new SafeError("internal_failure");
  }
  const requiredCommandIds = safeReleasedIds(source.requiredCommandIds, false);

  if (strategy === "per-component-map" || strategy === "per-component-positive") {
    requireOnlyKeys(source, ["strategy", "expectedMap", "requiredCommandIds"]);
    const expectedMap = object(source.expectedMap);
    const entries = Object.entries(expectedMap);
    if (entries.length === 0 || entries.length > 256 || entries.some(([key, answer]) =>
      !isBoundedReleasedId(key) || !isBoundedReleasedId(answer))) {
      throw new SafeError("internal_failure");
    }
    return { expectedMap, requiredCommandIds };
  }

  if (strategy === "exact-ordered-sequence") {
    requireOnlyKeys(source, ["strategy", "expectedOrder", "requiredCommandIds"]);
    return {
      expectedOrder: safeReleasedIds(source.expectedOrder, true),
      requiredCommandIds,
    };
  }

  if (strategy === "weighted-rule-evaluation") {
    requireOnlyKeys(source, ["strategy", "expectedAnswer", "finalAnswerPoints", "criteria", "requiredCommandIds"]);
    if (!isBoundedReleasedId(source.expectedAnswer) ||
      typeof source.finalAnswerPoints !== "number" || !Number.isFinite(source.finalAnswerPoints) ||
      !Array.isArray(source.criteria) || source.criteria.length > 256) {
      throw new SafeError("internal_failure");
    }
    for (const criterion of source.criteria) {
      const item = object(criterion);
      requireOnlyKeys(item, ["commandIds", "points"]);
      if (typeof item.points !== "number" || !Number.isFinite(item.points)) throw new SafeError("internal_failure");
      safeReleasedIds(item.commandIds, true);
    }
    return { expectedAnswer: source.expectedAnswer, requiredCommandIds };
  }

  requireOnlyKeys(source, ["strategy", "expectedAnswer", "requiredCommandIds"]);
  validateReleasedWholeState(source.expectedAnswer);
  return { ...RELEASED_ANSWER_UNAVAILABLE };
}

function sanitizeReleasedPbqResponse(
  questionType: unknown,
  value: unknown,
  wholeStateDisplayUnavailable: boolean,
): unknown {
  if (!isSupportedPbqReviewType(questionType)) return value;
  const source = object(value);
  requireOnlyKeys(source, ["selectedAnswer", "selectedAnswers", "selectedOrder", "executedCommands"]);
  if (wholeStateDisplayUnavailable && "selectedAnswer" in source && source.selectedAnswer !== null &&
    typeof source.selectedAnswer === "object" && !Array.isArray(source.selectedAnswer)) {
    requireOnlyKeys(source, ["selectedAnswer", "executedCommands"]);
    validateReleasedWholeState(source.selectedAnswer);
    if ("executedCommands" in source) {
      const commands = safeReleasedIds(source.executedCommands, false);
      if (commands.length > 100 || commands.some((command) => command.length > 256)) {
        throw new SafeError("internal_failure");
      }
    }
    return { ...RELEASED_ANSWER_UNAVAILABLE };
  }
  const output: Obj = {};
  if ("selectedAnswer" in source) {
    if (source.selectedAnswer !== "" && !isBoundedReleasedId(source.selectedAnswer)) throw new SafeError("internal_failure");
    output.selectedAnswer = source.selectedAnswer;
  }
  if ("selectedAnswers" in source) {
    const selectedAnswers = object(source.selectedAnswers);
    const entries = Object.entries(selectedAnswers);
    if (entries.length > 256 || entries.some(([key, answer]) =>
      !isBoundedReleasedId(key) || !isBoundedReleasedId(answer))) {
      throw new SafeError("internal_failure");
    }
    output.selectedAnswers = selectedAnswers;
  }
  if ("selectedOrder" in source) output.selectedOrder = safeReleasedIds(source.selectedOrder, false);
  if ("executedCommands" in source) {
    const commands = safeReleasedIds(source.executedCommands, false);
    if (commands.length > 100 || commands.some((command) => command.length > 256)) throw new SafeError("internal_failure");
    output.executedCommands = commands;
  }
  return output;
}

function isReleasedAnswerUnavailable(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value as Obj;
  return Object.keys(source).length === 1 && source.displayUnavailable === true;
}

function validateReleasedWholeState(value: unknown): void {
  object(value);
  let entries = 0;
  const visit = (entry: unknown, depth: number): void => {
    entries += 1;
    if (depth > 12 || entries > 4096) throw new SafeError("internal_failure");
    if (entry === null || typeof entry === "boolean") return;
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) throw new SafeError("internal_failure");
      return;
    }
    if (typeof entry === "string") {
      if (entry.length > 4096) throw new SafeError("internal_failure");
      return;
    }
    if (Array.isArray(entry)) {
      if (entry.length > 256) throw new SafeError("internal_failure");
      for (const item of entry) visit(item, depth + 1);
      return;
    }
    if (!entry || typeof entry !== "object") throw new SafeError("internal_failure");
    const values = Object.entries(entry as Obj);
    if (values.length > 256 || values.some(([key]) => key.length === 0 || key.length > 256)) {
      throw new SafeError("internal_failure");
    }
    for (const [, nested] of values) visit(nested, depth + 1);
  };
  visit(value, 0);
}

function isSupportedPbqReviewType(questionType: unknown): boolean {
  const type = String(questionType ?? "").toLowerCase();
  if (!type.startsWith("pbq-")) return false;
  if (!PBQ_REVIEW_TYPES.has(type)) throw new SafeError("internal_failure");
  return true;
}

function safeReleasedIds(value: unknown, requireNonEmpty: boolean): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 256 ||
    (requireNonEmpty && value.length === 0) || new Set(value).size !== value.length ||
    value.some((entry) => !isBoundedReleasedId(entry))) {
    throw new SafeError("internal_failure");
  }
  return [...value] as string[];
}

function isBoundedReleasedId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function requireOnlyKeys(value: Obj, allowed: readonly string[]): void {
  const keys = new Set(allowed);
  if (Object.keys(value).some((key) => !keys.has(key))) throw new SafeError("internal_failure");
}

function mapPresentationItems(
  value: unknown,
  mapper: (item: Obj, questionNumber: number | null) => Obj,
): Obj[] {
  if (!Array.isArray(value)) return [];
  let scoredQuestionNumber = 0;
  return value.map((entry) => {
    const item = object(entry);
    const type = String(item.questionType ?? "").toLowerCase();
    const informational = type === "case-study-context" || type === "case-study-info" || type === "informational";
    if (!informational) scoredQuestionNumber += 1;
    return mapper(item, informational ? null : scoredQuestionNumber);
  });
}

const PROTECTED_KEYS = new Set([
  "acceptedanswer", "acceptedanswers", "answer", "answerkey", "answers",
  "correctanswer", "correctanswers", "correctness", "correctorder",
  "correctpairs", "expectedactions", "expectedanswer", "expectedanswers",
  "explanation", "hiddenanswermetadata", "iscorrect", "maxpoints",
  "partialcredit", "points", "remediation", "rubric", "score", "scoring",
  "scoringkey", "scoringkeys", "scoringrules", "weight", "weights",
  "protectedpayload", "protectedsnapshot", "packagehash", "validationhash",
  "publicationrequestid", "internaluuid",
  "correctvalue", "correctvaluesbystatement", "correcttargetidsbysource",
  "correctoptionidsbyblank", "pointsbyblank", "maximumrawpoints", "modelsolution",
  "correctcode", "expectedoutput", "expectedoutputs", "gradingkey", "gradingkeys",
  "gradingrule", "gradingrules", "hiddentest", "hiddentests", "materialdigest",
  "protectedmaterialdigest",
]);
const PRE_REVIEW_RESPONSE_KEYS = new Set([
  "acceptedanswer", "acceptedanswers", "answerkey", "correctanswer",
  "correctanswers", "correctness", "correctorder", "correctpairs",
  "expectedactions", "expectedanswer", "expectedanswers", "explanation",
  "hiddenanswermetadata", "iscorrect", "remediation", "rubric", "scoring",
  "scoringkey", "scoringkeys", "scoringrules", "protectedpayload",
  "protectedsnapshot", "packagehash", "validationhash",
  "publicationrequestid", "internaluuid",
  "correctvalue", "correctvaluesbystatement", "correcttargetidsbysource",
  "correctoptionidsbyblank", "pointsbyblank", "maximumrawpoints", "modelsolution",
  "correctcode", "expectedoutput", "expectedoutputs", "gradingkey", "gradingkeys",
  "gradingrule", "gradingrules", "hiddentest", "hiddentests", "materialdigest",
  "protectedmaterialdigest",
]);
function sanitizePresentation(
  value: unknown,
  depth = 0,
  blockedKeys = PROTECTED_KEYS,
): unknown {
  if (depth > 12) throw new SafeError("internal_failure");
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizePresentation(entry, depth + 1, blockedKeys));
  }
  if (!value || typeof value !== "object") return value;
  const output: Obj = {};
  for (const [key, entry] of Object.entries(value as Obj)) {
    const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (blockedKeys.has(normalizedKey)) throw new SafeError("internal_failure");
    output[key] = sanitizePresentation(entry, depth + 1, blockedKeys);
  }
  return output;
}

function sanitizeQuestionPresentation(questionType: unknown, value: unknown): unknown {
  const type = String(questionType ?? "");
  const presentation = object(sanitizePresentation(value));
  const item = (entry: unknown) => pick(object(entry), ["id", "text"]);
  if (type === "true-false-single-v1") {
    return pick(presentation, ["prompt", "statementId", "interactionVersion"]);
  }
  if (type === "true-false-composite-v1") {
    return { ...pick(presentation, ["prompt", "interactionVersion"]), statements: safeArray(presentation.statements, item) };
  }
  if (type === "matching-v1") {
    return { ...pick(presentation, ["prompt", "allowTargetReuse", "interactionVersion"]), sources: safeArray(presentation.sources, item), targets: safeArray(presentation.targets, item) };
  }
  if (type === "code-dropdown-completion-v1") {
    return {
      ...pick(presentation, ["prompt", "codeTemplate", "interactionVersion", "language"]),
      blanks: safeArray(presentation.blanks, (blank) => ({ ...pick(blank, ["id", "label"]), options: safeArray(blank.options, item) })),
    };
  }
  return presentation;
}

export function assertNoProtectedPreReview(value: unknown): void {
  sanitizePresentation(value, 0, PRE_REVIEW_RESPONSE_KEYS);
}

export function mapPracticeAvailability(raw: unknown): Obj {
  const mapped = pick(object(raw), ["examKey", "packageVersion", "profileKey", "purpose", "available", "selectedCount", "adjustedCount", "profileQuestionCount", "timeLimitMinutes", "timed", "deliveryMode", "fixedProfileSize", "profileComposition", "domainCounts", "objectiveCounts", "confirmedDomain", "confirmedObjective", "missedCount", "newCount", "pbqCount", "languages"]);
  if (mapped.examKey !== "az204") mapped.languages = [];
  return mapped;
}
export function mapWeakAreaOptions(raw: unknown): Obj {
  const value = object(raw);
  if (typeof value.examKey !== "string" || value.examKey.length < 2 || value.examKey.length > 64 ||
    typeof value.packageVersion !== "string" || value.packageVersion.length < 1 || value.packageVersion.length > 64 ||
    typeof value.profileKey !== "string" || value.profileKey.length < 1 || value.profileKey.length > 128 ||
    !Array.isArray(value.domains) || value.domains.length > 128) {
    throw new SafeError("internal_failure");
  }
  const seen = new Set<string>();
  const domains = safeArray(value.domains, (domain) => {
    const domainKey = domain.domainKey;
    const evidenceCount = domain.evidenceCount;
    const lowestPercentage = domain.lowestPercentage;
    if (typeof domainKey !== "string" || domainKey.length < 1 || domainKey.length > 128 ||
      seen.has(domainKey) || !Number.isSafeInteger(evidenceCount) || Number(evidenceCount) < 1 ||
      typeof lowestPercentage !== "number" || !Number.isFinite(lowestPercentage) ||
      lowestPercentage < 0 || lowestPercentage >= 70) {
      throw new SafeError("internal_failure");
    }
    seen.add(domainKey);
    return { domainKey, evidenceCount, lowestPercentage };
  });
  return {
    examKey: value.examKey,
    packageVersion: value.packageVersion,
    profileKey: value.profileKey,
    domains,
  };
}
export function mapPracticeCheck(raw: unknown): Obj {
  const value = object(raw);
  const allowed = new Set(["ok", "itemId", "revision", "status", "earnedPoints", "maxPoints", "review", "releasedAt"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new SafeError("internal_failure");
  return pick(value, ["itemId", "revision", "status", "earnedPoints", "maxPoints", "review", "releasedAt"]);
}
export function assertPracticeFeedbackSafe(value: unknown): void {
  const feedback = object(value);
  const allowed = new Set(["itemId", "revision", "status", "earnedPoints", "maxPoints", "review", "releasedAt"]);
  if (Object.keys(feedback).some((key) => !allowed.has(key))) throw new SafeError("internal_failure");
  if (typeof feedback.itemId !== "string" || !Number.isInteger(feedback.revision) ||
    typeof feedback.status !== "string" || typeof feedback.earnedPoints !== "number" ||
    typeof feedback.maxPoints !== "number" || typeof feedback.releasedAt !== "string") throw new SafeError("internal_failure");
  const review = object(feedback.review);
  if (Object.keys(review).some((key) => !["explanation", "remediation"].includes(key)) ||
    typeof review.explanation !== "string" || typeof review.remediation !== "string") throw new SafeError("internal_failure");
}
export function mapHistory(raw: unknown): Obj {
  const value = object(raw);
  return {
    items: safeArray(value.items, (item) => {
      if (item.assignmentId != null && typeof item.assignmentId !== "string") throw new SafeError("internal_failure");
      return pick(item, ["attemptId", "assignmentId", "examKey", "packageVersion", "profileKey", "purpose", "actorClassification", "completedAt", "score", "percentage", "passed", "domainSummary", "serverAuthoritative", "reviewStatus", "source"]);
    }),
    nextCursor: value.nextCursor ?? null,
    returnedCount: value.returnedCount,
    totalCount: value.totalCount,
    remainingCount: value.remainingCount,
  };
}
export function mapStaffHistory(raw: unknown): Obj {
  const value = object(raw);
  return {
    items: safeArray(value.items, (item) => pick(item, ["attemptId", "learnerId", "examKey", "packageVersion", "profileKey", "purpose", "actorClassification", "analyticsEligible", "completedAt", "score", "percentage", "passed", "domainSummary", "serverAuthoritative", "reviewStatus", "source"])),
    nextCursor: value.nextCursor ?? null,
    returnedCount: value.returnedCount,
    totalCount: value.totalCount,
    remainingCount: value.remainingCount,
  };
}
export function mapStaffAnalytics(raw: unknown): Obj {
  const value = object(raw);
  const totals = object(value.totals);
  const totalKeys = ["visibleLearners", "learnersWithActivity", "learnersWithoutActivity", "historicalActivity", "protectedAssessments", "legacyHistorical"] as const;
  if (value.scopeComplete !== true || !Array.isArray(value.exams) ||
    !Array.isArray(value.groups) || !Array.isArray(value.assignments) ||
    !Array.isArray(value.domains)) {
    throw new SafeError("internal_failure");
  }
  const mappedTotals = Object.fromEntries(totalKeys.map((key) => [key, normalizeCount(totals[key])])) as Obj;
  const mapRow = (item: Obj, identityKey: "learnerId" | "examKey") => {
    const countKeys = ["activityCount", "assessmentCount", "historicalCount", "assessedLearnerCount", "needsReviewCount", "passedCount"] as const;
    const percentageKeys = identityKey === "learnerId"
      ? ["latestPercentage", "bestPercentage", "lowestPercentage", "averagePercentage", "passRate"] as const
      : ["bestPercentage", "lowestPercentage", "averagePercentage", "passRate"] as const;
    if (typeof item[identityKey] !== "string" || !(item[identityKey] as string).trim() ||
      (item.latestActivity !== null && typeof item.latestActivity !== "string")) {
      throw new SafeError("internal_failure");
    }
    const mapped = pick(item, [identityKey, "examKey", "latestActivity"]);
    countKeys.forEach((key) => mapped[key] = normalizeCount(item[key]));
    percentageKeys.forEach((key) => mapped[key] = normalizePercentage(item[key]));
    if (identityKey === "learnerId") {
      if (item.latestAttemptId !== null && typeof item.latestAttemptId !== "string") throw new SafeError("internal_failure");
      mapped.latestAttemptId = item.latestAttemptId ?? null;
      if (!Array.isArray(item.domains)) throw new SafeError("internal_failure");
      mapped.domains = safeArray(item.domains, (domain) => {
        if (typeof domain.domainKey !== "string" || !domain.domainKey) throw new SafeError("internal_failure");
        return {
          domainKey: domain.domainKey,
          averagePercentage: normalizePercentage(domain.averagePercentage),
          sampleCount: normalizeCount(domain.sampleCount ?? 0),
          rawEarnedPoints: normalizeNonNegativeNumber(domain.rawEarnedPoints),
          rawMaximumPoints: normalizeNonNegativeNumber(domain.rawMaximumPoints),
        };
      });
    }
    return mapped;
  };
  const exams = safeArray(value.exams, (item) => mapRow(item, "examKey"));
  const mapDomains = (domains: unknown) => safeArray(Array.isArray(domains) ? domains : [], (domain) => {
    if (typeof domain.domainKey !== "string" || !domain.domainKey ||
      typeof domain.examKey !== "string" || !domain.examKey) throw new SafeError("internal_failure");
    return {
      examKey: domain.examKey,
      domainKey: domain.domainKey,
      sampleCount: normalizeCount(domain.sampleCount ?? 0),
      studentCount: normalizeCount(domain.studentCount ?? 0),
      weakCount: normalizeCount(domain.weakCount ?? 0),
      averagePercentage: normalizePercentage(domain.averagePercentage),
      rawEarnedPoints: normalizeNonNegativeNumber(domain.rawEarnedPoints),
      rawMaximumPoints: normalizeNonNegativeNumber(domain.rawMaximumPoints),
    };
  });
  const aggregateRows = (items: unknown[], identityKey: string) => safeArray(items, (item) => {
    if (typeof item[identityKey] !== "string" || !item[identityKey]) throw new SafeError("internal_failure");
    const mapped = pick(item, [identityKey]);
    ["assessmentCount", "assessedLearnerCount", "needsReviewCount", "sampleCount", "studentCount", "activeStudents", "studentsWithAttempts", "studentsWithoutAttempts", "readyStudents"].forEach((key) => {
      if (item[key] != null) mapped[key] = normalizeCount(item[key]);
    });
    ["averagePercentage", "passRate"].forEach((key) => {
      if (item[key] !== undefined) mapped[key] = normalizePercentage(item[key]);
    });
    if (Array.isArray(item.domains)) mapped.domains = mapDomains(item.domains);
    return mapped;
  });
  return {
    scopeComplete: true,
    totals: mappedTotals,
    exams,
    groups: aggregateRows(value.groups, "groupId"),
    assignments: safeArray(value.assignments, (item) => {
      if (typeof item.assignmentId !== "string" || !item.assignmentId ||
        typeof item.examKey !== "string" || !item.examKey ||
        (item.groupId !== null && typeof item.groupId !== "string") ||
        (item.dueAt !== null && typeof item.dueAt !== "string")) throw new SafeError("internal_failure");
      return {
        assignmentId: item.assignmentId,
        examKey: item.examKey,
        groupId: item.groupId ?? null,
        dueAt: item.dueAt ?? null,
        totalStudents: normalizeCount(item.totalStudents),
        assessmentCount: normalizeCount(item.assessmentCount),
        assessedLearnerCount: normalizeCount(item.assessedLearnerCount),
        needsReviewCount: normalizeCount(item.needsReviewCount),
        averagePercentage: normalizePercentage(item.averagePercentage),
        passRate: normalizePercentage(item.passRate),
        submittedCount: normalizeCount(item.submittedCount ?? 0),
        readyCount: normalizeCount(item.readyCount ?? 0),
        completedButNotReadyCount: normalizeCount(item.completedButNotReadyCount ?? 0),
        notStartedCount: normalizeCount(item.notStartedCount ?? 0),
        dueSoonCount: normalizeCount(item.dueSoonCount ?? 0),
        overdueCount: normalizeCount(item.overdueCount ?? 0),
      };
    }),
    domains: mapDomains(value.domains),
    readinessSummary: mapReadinessSummary(value.readinessSummary),
    activitySummary: mapActivitySummary(value.activitySummary),
  };
}

function mapReadinessSummary(raw: unknown): Obj {
  const value = object(raw);
  const keys = ["ready", "almost-ready", "needs-review", "at-risk", "insufficient-data", "not-started"];
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new SafeError("internal_failure");
  return Object.fromEntries(keys.map((key) => [key, normalizeCount(value[key] ?? 0)]));
}

function mapActivitySummary(raw: unknown): Obj {
  const value = object(raw);
  const mapActivity = (item: Obj) => {
    if (typeof item.learner_id !== "string" || typeof item.display_name !== "string" ||
      (item.latestAttemptDate !== null && typeof item.latestAttemptDate !== "string")) throw new SafeError("internal_failure");
    return {
      learnerId: item.learner_id,
      displayName: item.display_name,
      totalAttempts: normalizeCount(item.totalAttempts),
      latestAttemptDate: item.latestAttemptDate ?? null,
    };
  };
  return {
    mostActive: safeArray(value.mostActive, mapActivity),
    leastActive: safeArray(value.leastActive, mapActivity),
    noAttemptCount: normalizeCount(value.noAttemptCount),
    noAttemptPreview: safeArray(value.noAttemptPreview, mapActivity),
  };
}

function mapStaffLearnerPage(raw: unknown): Obj {
  const value = object(raw);
  if (!Array.isArray(value.items) || !Number.isSafeInteger(value.returnedCount) ||
    !Number.isSafeInteger(value.totalCount) || !Number.isSafeInteger(value.filteredCount) ||
    !Number.isSafeInteger(value.pageSize) || typeof value.complete !== "boolean" ||
    (value.nextCursor !== null && typeof value.nextCursor !== "string")) throw new SafeError("internal_failure");
  const returnedCount = normalizeCount(value.returnedCount);
  const totalCount = normalizeCount(value.totalCount);
  const filteredCount = normalizeCount(value.filteredCount);
  const pageSize = normalizeCount(value.pageSize);
  const items = safeArray(value.items, (item) => {
    if (typeof item.membershipId !== "string" || typeof item.learnerId !== "string" || typeof item.displayName !== "string" ||
      typeof item.email !== "string" || typeof item.examKey !== "string" ||
      typeof item.readinessStatus !== "string" || typeof item.status !== "string" ||
      (item.groupId !== null && typeof item.groupId !== "string") ||
      (item.campusId !== null && typeof item.campusId !== "string")) throw new SafeError("internal_failure");
    const assignmentSummaries = safeArray(item.assignmentSummaries, (summary) => {
      if (typeof summary.assignmentId !== "string") throw new SafeError("internal_failure");
      return { assignmentId: summary.assignmentId, assignmentAttemptCount: normalizeCount(summary.assignmentAttemptCount) };
    });
    return {
      membershipId: item.membershipId,
      learnerId: item.learnerId,
      displayName: item.displayName,
      email: item.email,
      groupId: item.groupId ?? null,
      groupName: typeof item.groupName === "string" ? item.groupName : "",
      campusId: item.campusId ?? null,
      campusName: typeof item.campusName === "string" ? item.campusName : "",
      status: item.status,
      examKey: item.examKey,
      readinessStatus: item.readinessStatus,
      analytics: mapStaffLearnerAnalytics(item.analytics),
      assignmentSummaries,
    };
  });
  if (items.length !== returnedCount || returnedCount > pageSize ||
    filteredCount < returnedCount) throw new SafeError("internal_failure");
  return pick({ ...value, items, returnedCount, totalCount, filteredCount, pageSize }, ["items", "returnedCount", "totalCount", "filteredCount", "pageSize", "nextCursor", "complete"]);
}

function mapStaffLearnerAnalytics(raw: unknown): Obj {
  const value = object(raw);
  if (Object.keys(value).length === 0) return {};
  if (typeof value.learnerId !== "string" || typeof value.examKey !== "string") throw new SafeError("internal_failure");
  const mapped = pick(value, ["learnerId", "examKey", "latestActivity", "latestAttemptId"]);
  ["activityCount", "assessmentCount", "historicalCount", "needsReviewCount", "passedCount"].forEach((key) => {
    mapped[key] = normalizeCount(value[key] ?? 0);
  });
  ["latestPercentage", "bestPercentage", "lowestPercentage", "averagePercentage", "passRate"].forEach((key) => {
    mapped[key] = normalizePercentage(value[key] ?? null);
  });
  mapped.domains = safeArray(value.domains, (domain) => {
    if (typeof domain.domainKey !== "string") throw new SafeError("internal_failure");
    return {
      domainKey: domain.domainKey,
      averagePercentage: normalizePercentage(domain.averagePercentage),
      sampleCount: normalizeCount(domain.sampleCount ?? 0),
      rawEarnedPoints: normalizeNonNegativeNumber(domain.rawEarnedPoints),
      rawMaximumPoints: normalizeNonNegativeNumber(domain.rawMaximumPoints),
    };
  });
  return mapped;
}

export function mapStaffDashboardScope(raw: unknown): Obj {
  const value = object(raw);
  if (typeof value.role !== "string" || !Array.isArray(value.organisations) ||
    !Array.isArray(value.campuses) || !Array.isArray(value.groups)) throw new SafeError("internal_failure");
  const mapOption = (item: Obj, includeCampus = false) => {
    if (typeof item.id !== "string" || typeof item.name !== "string" || !item.id || !item.name) throw new SafeError("internal_failure");
    return pick(item, includeCampus ? ["id", "name", "campusId"] : ["id", "name"]);
  };
  const mapAssignment = (item: Obj) => {
    const mapped = mapOption(item);
    if (typeof item.examKey !== "string" || !item.examKey || typeof item.status !== "string") {
      throw new SafeError("internal_failure");
    }
    return pick({ ...item, ...mapped }, [
      "id", "name", "organisationId", "campusId", "groupId", "studentUserId",
      "examKey", "profileId", "status", "dueAt", "availableFrom", "createdAt",
    ]);
  };
  const mapHistoryItem = (item: Obj) => {
    if (typeof item.attemptId !== "string" || typeof item.learnerId !== "string" ||
      typeof item.examKey !== "string" || item.analyticsEligible !== true ||
      !["assigned_assessment", "self_directed_exam"].includes(String(item.purpose))) {
      throw new SafeError("internal_failure");
    }
    const protectedAssessment = item.source === "protected" && item.serverAuthoritative === true;
    const legacyAssessment = item.source === "legacy_authoritative" && item.serverAuthoritative === false;
    if ((!protectedAssessment && !legacyAssessment) ||
      (item.assignmentId !== null && typeof item.assignmentId !== "string")) {
      throw new SafeError("internal_failure");
    }
    return pick(item, [
      "attemptId", "learnerId", "assignmentId", "examKey", "packageVersion",
      "profileKey", "purpose", "completedAt", "score", "percentage", "passed",
      "domainSummary", "analyticsEligible", "serverAuthoritative", "source",
    ]);
  };
  const assignmentPage = object(value.assignmentPage);
  const history = object(value.history);
  const nextCursor = assignmentPage.nextCursor;
  const historyNextCursor = history.nextCursor ?? null;
  if (!Array.isArray(assignmentPage.items) || typeof assignmentPage.complete !== "boolean" ||
    !Number.isSafeInteger(assignmentPage.returnedCount) ||
    (nextCursor !== null && typeof nextCursor !== "string") || !Array.isArray(history.items) ||
    !Number.isSafeInteger(history.totalCount) || !Number.isSafeInteger(history.completedCount) ||
    (historyNextCursor !== null && typeof historyNextCursor !== "string") ||
    !Array.isArray(value.learnerIds) || value.learnerIds.some((id) => typeof id !== "string")) throw new SafeError("internal_failure");
  return {
    role: value.role,
    locks: pick(object(value.locks), ["organisation", "campus"]),
    selection: pick(object(value.selection), ["organisationId", "campusId", "groupId", "assignmentId"]),
    organisations: safeArray(value.organisations, (item) => mapOption(item)),
    campuses: safeArray(value.campuses, (item) => mapOption(item)),
    groups: safeArray(value.groups, (item) => mapOption(item, true)),
    learnerIds: value.learnerIds,
    assignmentPage: {
      items: safeArray(assignmentPage.items, mapAssignment),
      nextCursor: nextCursor ?? null,
      complete: assignmentPage.complete,
      returnedCount: assignmentPage.returnedCount,
      totalCount: Number.isSafeInteger(assignmentPage.totalCount) ? assignmentPage.totalCount : assignmentPage.returnedCount,
    },
    history: {
      items: safeArray(history.items, mapHistoryItem),
      totalCount: history.totalCount,
      completedCount: history.completedCount,
      returnedCount: Number.isSafeInteger(history.returnedCount) ? history.returnedCount : (history.items as unknown[]).length,
      nextCursor: historyNextCursor,
      averagePercentage: history.averagePercentage ?? null,
      passRate: history.passRate ?? null,
    },
  };
}

export function mapStaffScopeOptions(raw: unknown): Obj {
  const value = object(raw);
  if (typeof value.role !== "string" || !Array.isArray(value.organisations) ||
    !Array.isArray(value.campuses) || !Array.isArray(value.groups) ||
    !Array.isArray(value.assignments) || !Array.isArray(value.exams)) throw new SafeError("internal_failure");
  const option = (item: Obj, fields: string[]) => {
    if (typeof item.id !== "string" || typeof item.name !== "string" || !item.id || !item.name) throw new SafeError("internal_failure");
    return pick(item, fields);
  };
  return {
    role: value.role,
    locks: pick(object(value.locks), ["organisation", "campus"]),
    selection: pick(object(value.selection), ["organisationId", "campusId"]),
    organisations: safeArray(value.organisations, (item) => option(item, ["id", "name"])),
    campuses: safeArray(value.campuses, (item) => option(item, ["id", "name"])),
    groups: safeArray(value.groups, (item) => option(item, ["id", "name", "campusId"])),
    assignments: safeArray(value.assignments, (item) => option(item, ["id", "name", "organisationId", "campusId", "groupId", "examKey", "status"])),
    exams: safeArray(value.exams, (item) => option(item, ["id", "name"])),
  };
}

export function mapStaffDashboardQuery(raw: unknown): Obj {
  const value = object(raw);
  const assignmentPage = object(value.assignmentPage);
  const history = object(value.history);
  if (!["overview", "analytics", "assignments", "students", "results"].includes(String(value.workflow)) ||
    !Number.isSafeInteger(assignmentPage.totalCount) || !Number.isSafeInteger(assignmentPage.returnedCount) ||
    !Number.isSafeInteger(history.totalCount) || !Number.isSafeInteger(history.returnedCount) ||
    (assignmentPage.nextCursor !== null && typeof assignmentPage.nextCursor !== "string") ||
    (history.nextCursor !== null && typeof history.nextCursor !== "string")) throw new SafeError("internal_failure");
  const mapped = mapStaffDashboardScope({ ...value, organisations: [], campuses: [], groups: [], locks: {}, learnerIds: [] });
  delete mapped.learnerIds;
  return { ...mapped, workflow: value.workflow, learnerPage: mapStaffLearnerPage(value.learnerPage), analytics: mapStaffAnalytics(value.analytics) };
}

export function mapStaffLearnerDetail(raw: unknown): Obj {
  const value = object(raw);
  const learner = object(value.learner);
  const assignmentPage = object(value.assignmentPage);
  const history = object(value.history);
  if (typeof value.role !== "string" || typeof learner.membershipId !== "string" ||
    typeof learner.learnerId !== "string" || typeof learner.displayName !== "string" ||
    typeof learner.email !== "string" || typeof learner.status !== "string" ||
    typeof learner.organisationId !== "string" || typeof learner.organisationName !== "string" ||
    (learner.campusId !== null && typeof learner.campusId !== "string") ||
    (learner.groupId !== null && typeof learner.groupId !== "string") ||
    !Array.isArray(assignmentPage.items) || !Array.isArray(value.assignmentAnalytics) ||
    !Number.isSafeInteger(assignmentPage.returnedCount) || !Number.isSafeInteger(assignmentPage.totalCount) ||
    !Number.isSafeInteger(assignmentPage.pageSize) || typeof assignmentPage.complete !== "boolean") {
    throw new SafeError("internal_failure");
  }
  const assignmentReturnedCount = normalizeCount(assignmentPage.returnedCount);
  const assignmentTotalCount = normalizeCount(assignmentPage.totalCount);
  const assignmentPageSize = normalizeCount(assignmentPage.pageSize);
  if (assignmentReturnedCount > assignmentPageSize || assignmentPageSize > 50) throw new SafeError("internal_failure");
  const assignments = safeArray(assignmentPage.items, (item) => {
    if (typeof item.id !== "string" || typeof item.name !== "string" ||
      typeof item.organisationId !== "string" || typeof item.examKey !== "string" ||
      typeof item.status !== "string" ||
      (item.campusId !== null && typeof item.campusId !== "string") ||
      (item.groupId !== null && typeof item.groupId !== "string") ||
      (item.studentUserId !== null && typeof item.studentUserId !== "string")) {
      throw new SafeError("internal_failure");
    }
    return pick(item, ["id", "name", "organisationId", "campusId", "groupId", "studentUserId", "examKey", "profileId", "status", "dueAt", "availableFrom", "createdAt"]);
  });
  if (assignments.length !== assignmentReturnedCount || assignmentTotalCount < assignments.length) {
    throw new SafeError("internal_failure");
  }
  const assignmentAnalytics = safeArray(value.assignmentAnalytics, (item) => {
    if (typeof item.assignmentId !== "string" || typeof item.examKey !== "string" ||
      (item.groupId !== null && typeof item.groupId !== "string") ||
      (item.dueAt !== null && typeof item.dueAt !== "string")) throw new SafeError("internal_failure");
    const mapped = pick(item, ["assignmentId", "examKey", "groupId", "dueAt"]);
    ["totalStudents", "assessmentCount", "assessedLearnerCount", "submittedCount", "readyCount", "needsReviewCount", "completedButNotReadyCount", "notStartedCount", "dueSoonCount", "overdueCount"]
      .forEach((key) => mapped[key] = normalizeCount(item[key] ?? 0));
    mapped.averagePercentage = normalizePercentage(item.averagePercentage ?? null);
    return mapped;
  });
  if (!Array.isArray(history.items) || !Number.isSafeInteger(history.returnedCount) ||
    !Number.isSafeInteger(history.totalCount) || !Number.isSafeInteger(history.remainingCount) ||
    (history.nextCursor !== null && typeof history.nextCursor !== "string")) throw new SafeError("internal_failure");
  const historyReturnedCount = normalizeCount(history.returnedCount);
  const historyTotalCount = normalizeCount(history.totalCount);
  const historyRemainingCount = normalizeCount(history.remainingCount);
  if (historyReturnedCount > 25 || history.items.length !== historyReturnedCount) throw new SafeError("internal_failure");
  const historyItems = safeArray(history.items, (item) => {
    if (typeof item.attemptId !== "string" || item.learnerId !== learner.learnerId ||
      typeof item.examKey !== "string" || item.analyticsEligible !== true ||
      !["assigned_assessment", "self_directed_exam"].includes(String(item.purpose)) ||
      (item.assignmentId !== null && typeof item.assignmentId !== "string")) throw new SafeError("internal_failure");
    const protectedAssessment = item.source === "protected" && item.serverAuthoritative === true;
    const legacyAssessment = item.source === "legacy_authoritative" && item.serverAuthoritative === false;
    if (!protectedAssessment && !legacyAssessment) throw new SafeError("internal_failure");
    return pick(item, ["attemptId", "learnerId", "assignmentId", "examKey", "packageVersion", "profileKey", "purpose", "actorClassification", "analyticsEligible", "completedAt", "score", "percentage", "passed", "domainSummary", "serverAuthoritative", "reviewStatus", "source"]);
  });
  return {
    role: value.role,
    locks: pick(object(value.locks), ["organisation", "campus"]),
    selection: pick(object(value.selection), ["organisationId", "campusId", "groupId", "assignmentId"]),
    learner: pick(learner, ["membershipId", "learnerId", "displayName", "email", "status", "organisationId", "organisationName", "campusId", "campusName", "groupId", "groupName"]),
    assignmentPage: {
      items: assignments,
      returnedCount: assignmentReturnedCount,
      totalCount: assignmentTotalCount,
      pageSize: assignmentPageSize,
      complete: assignmentPage.complete,
    },
    learnerPage: mapStaffLearnerPage(value.learnerPage),
    assignmentAnalytics,
    history: {
      items: historyItems,
      returnedCount: historyReturnedCount,
      totalCount: historyTotalCount,
      remainingCount: historyRemainingCount,
      nextCursor: history.nextCursor,
    },
  };
}

function normalizeCount(value: unknown): number {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || Number(number) < 0) throw new SafeError("internal_failure");
  return Number(number);
}

function normalizePercentage(value: unknown): number | null {
  if (value === null) return null;
  const number = typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number) || number < 0 || number > 100) throw new SafeError("internal_failure");
  return number;
}

function normalizeNonNegativeNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number) || number < 0) throw new SafeError("internal_failure");
  return number;
}
export function mapHistorySummary(raw: unknown): Obj {
  return pick(object(raw), ["latest", "best", "completedCount", "scoredCount", "averagePercentage", "averageScore", "passedCount", "needsReviewCount", "domainSummary", "weakDomains", "serverAuthoritative", "historicalUnclassifiedExcluded"]);
}
export function mapPrintSummary(raw: unknown): Obj {
  return pick(object(raw), ["exam", "profile", "purpose", "completedAt", "score", "percentage", "passed", "domainSummary", "completionStatus", "serverAuthoritative", "reviewStatus", "source"]);
}
