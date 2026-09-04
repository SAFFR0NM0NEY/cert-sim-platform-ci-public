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
      presentation: sanitizePresentation(item.presentation),
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
      presentation: sanitizePresentation(item.presentation),
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
      items: mapPresentationItems(review.items, (item, questionNumber) => ({
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
        presentation: sanitizePresentation(item.presentation),
      })),
    },
  };
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
]);
const PRE_REVIEW_RESPONSE_KEYS = new Set([
  "acceptedanswer", "acceptedanswers", "answerkey", "correctanswer",
  "correctanswers", "correctness", "correctorder", "correctpairs",
  "expectedactions", "expectedanswer", "expectedanswers", "explanation",
  "hiddenanswermetadata", "iscorrect", "remediation", "rubric", "scoring",
  "scoringkey", "scoringkeys", "scoringrules", "protectedpayload",
  "protectedsnapshot", "packagehash", "validationhash",
  "publicationrequestid", "internaluuid",
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

export function assertNoProtectedPreReview(value: unknown): void {
  sanitizePresentation(value, 0, PRE_REVIEW_RESPONSE_KEYS);
}

export function mapPracticeAvailability(raw: unknown): Obj {
  const mapped = pick(object(raw), ["examKey", "packageVersion", "profileKey", "purpose", "available", "selectedCount", "adjustedCount", "profileQuestionCount", "timeLimitMinutes", "timed", "deliveryMode", "fixedProfileSize", "profileComposition", "domainCounts", "missedCount", "newCount", "pbqCount", "languages"]);
  if (mapped.examKey !== "az204") mapped.languages = [];
  return mapped;
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
  if (value.scopeComplete !== true || !Array.isArray(value.learners) || !Array.isArray(value.exams) ||
    !Array.isArray(value.groups) || !Array.isArray(value.assignments) ||
    !Array.isArray(value.assignmentLearners) || !Array.isArray(value.domains)) {
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
        };
      });
    }
    return mapped;
  };
  const learners = safeArray(value.learners, (item) => mapRow(item, "learnerId"));
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
    };
  });
  const aggregateRows = (items: unknown[], identityKey: string) => safeArray(items, (item) => {
    if (typeof item[identityKey] !== "string" || !item[identityKey]) throw new SafeError("internal_failure");
    const mapped = pick(item, [identityKey]);
    ["assessmentCount", "assessedLearnerCount", "needsReviewCount", "sampleCount"].forEach((key) => {
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
    learners,
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
      };
    }),
    assignmentLearners: safeArray(value.assignmentLearners, (item) => {
      if (typeof item.assignmentId !== "string" || !item.assignmentId ||
        typeof item.learnerId !== "string" || !item.learnerId ||
        (item.latestAssignmentActivity !== null && typeof item.latestAssignmentActivity !== "string") ||
        (item.latestAssignmentAttemptId !== null && typeof item.latestAssignmentAttemptId !== "string")) {
        throw new SafeError("internal_failure");
      }
      return {
        assignmentId: item.assignmentId,
        learnerId: item.learnerId,
        assignmentAttemptCount: normalizeCount(item.assignmentAttemptCount),
        latestAssignmentActivity: item.latestAssignmentActivity ?? null,
        latestAssignmentAttemptId: item.latestAssignmentAttemptId ?? null,
      };
    }),
    domains: mapDomains(value.domains),
  };
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
  const mapped = mapStaffDashboardScope({ ...value, organisations: [], campuses: [], groups: [], locks: {} });
  return { ...mapped, workflow: value.workflow, analytics: mapStaffAnalytics(value.analytics) };
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
export function mapHistorySummary(raw: unknown): Obj {
  return pick(object(raw), ["latest", "best", "completedCount", "scoredCount", "averagePercentage", "averageScore", "passedCount", "needsReviewCount", "weakDomains", "serverAuthoritative", "historicalUnclassifiedExcluded"]);
}
export function mapPrintSummary(raw: unknown): Obj {
  return pick(object(raw), ["exam", "profile", "purpose", "completedAt", "score", "percentage", "passed", "domainSummary", "completionStatus", "serverAuthoritative", "reviewStatus", "source"]);
}
