import type { SupabaseClient } from "@supabase/supabase-js";
import { createPrivilegedClient } from "./client.ts";
import { corsHeaders } from "./cors.ts";
import { SafeError, translateRpcFailure } from "./errors.ts";
import { logSafe } from "./logging.ts";
import { matchRoute } from "./routes.ts";
import {
  assertNoProtectedPreReview,
  assertPracticeFeedbackSafe,
  errorResponse,
  jsonResponse,
  mapAttempt,
  mapAttemptItemPage,
  mapCurrentAttemptBindings,
  mapEligibility,
  mapResult,
  mapReview,
  mapSavedResponse,
  mapFlags,
  mapFlag,
  mapQuestionIssue,
  mapAbandonedAttempt,
  mapPracticeAvailability,
  mapPracticeCheck,
  mapHistory,
  mapStaffHistory,
  mapStaffAnalytics,
  mapStaffDashboardScope,
  mapStaffDashboardQuery,
  mapStaffScopeOptions,
  mapHistorySummary,
  mapPrintSummary,
} from "./responses.ts";
import {
  assertUuid,
  readJsonBody,
  validateObject,
  validateResponsePayload,
} from "./validation.ts";
type UserClient = {
  auth: {
    getUser: () => Promise<
      {
        data: { user: { id: string; user_metadata?: unknown } | null };
        error: unknown;
      }
    >;
  };
};
type Deps = {
  userClient: UserClient;
  createAdmin?: () => SupabaseClient;
  origins?: Set<string>;
  log?: (line: string) => void;
};
export async function handleProtectedExam(
  request: Request,
  deps: Deps,
): Promise<Response> {
  const correlationId = crypto.randomUUID(), started = performance.now();
  let route = "unmatched", status = 500, outcome = "internal_failure";
  let cors: HeadersInit = {};
  try {
    cors = corsHeaders(request, deps.origins ?? new Set());
    if (request.method === "OPTIONS") {
      status = 204;
      outcome = "ok";
      return new Response(null, { status, headers: cors });
    }
    const matched = matchRoute(request);
    route = matched.id;
    if (matched.method === "GET" && request.body !== null) {
      throw new SafeError("invalid_request");
    }
    const authHeader = request.headers.get("authorization");
    if (!authHeader || !/^Bearer\s+\S+$/.test(authHeader)) {
      throw new SafeError("unauthenticated");
    }
    const { data, error } = await deps.userClient.auth.getUser();
    const actorId = data?.user?.id;
    if (error || !actorId) throw new SafeError("unauthenticated");
    assertUuid(actorId);
    let args: Record<string, unknown>;
    let body: Record<string, unknown> | undefined;
    if (matched.id === "eligibility" || matched.id === "current") {
      const u = new URL(request.url);
      const examKey = u.searchParams.get("examKey");
      const profileId = u.searchParams.get("profileId");
      const packageVersion = u.searchParams.get("packageVersion");
      const purpose = u.searchParams.get("purpose");
      const language = u.searchParams.get("language");
      const assignmentId = u.searchParams.get("assignmentId");
      const permitted = matched.id === "current"
        ? ["examKey", "profileId", "purpose", "language", "assignmentId"]
        : ["examKey", "packageVersion", "profileId", "purpose"];
      if (!isExamKey(examKey) || !isProfileId(profileId) ||
        [...u.searchParams.keys()].some((k) => !permitted.includes(k)) ||
        (matched.id === "eligibility" &&
          (!isPackageVersion(packageVersion) || !isPracticePurpose(purpose, true))) ||
        (matched.id === "current" &&
          (!isPracticePurpose(purpose, true) ||
            !isCanonicalLanguage(examKey, language)))) {
        throw new SafeError("invalid_request");
      }
      args = matched.id === "current"
        ? {
          p_actor_id: actorId,
          p_exam_key: examKey,
          p_profile_key: profileId,
          p_purpose: purpose,
          p_language: toDatabaseLanguage(examKey, language),
          ...(assignmentId == null ? {} : { p_assignment_id: assertUuid(assignmentId) }),
        }
        : {
          p_actor_id: actorId,
          p_exam_key: examKey,
          p_package_version: packageVersion,
          p_profile_key: profileId,
          p_purpose: purpose,
        };
    } else if (matched.id === "currentBindings") {
      const u = new URL(request.url);
      const examKey = u.searchParams.get("examKey");
      const purpose = u.searchParams.get("purpose");
      if (!isExamKey(examKey) || !isPracticePurpose(purpose, true) ||
        [...u.searchParams.keys()].some((key) => !["examKey", "purpose"].includes(key))) {
        throw new SafeError("invalid_request");
      }
      args = { p_actor_id: actorId, p_exam_key: examKey, p_purpose: purpose };
    } else if (matched.id === "itemPage") {
      const u = new URL(request.url);
      const afterPosition = Number(u.searchParams.get("afterPosition") ?? "0");
      const pageSize = Number(u.searchParams.get("pageSize") ?? "20");
      if ([...u.searchParams.keys()].some((key) => !["afterPosition", "pageSize"].includes(key)) ||
        !Number.isSafeInteger(afterPosition) || afterPosition < 0 ||
        !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) throw new SafeError("invalid_request");
      args = { p_actor_id: actorId, p_attempt_id: assertUuid(matched.params.attemptId), p_after_position: afterPosition, p_page_size: pageSize };
    } else if (matched.id === "practiceAvailability") {
      const u = new URL(request.url);
      const permitted = ["examKey", "profileId", "purpose", "domain", "count", "includePbqs", "mixStrategy", "language", "contentKind", "assignmentId"];
      if ([...u.searchParams.keys()].some((key) => !permitted.includes(key))) throw new SafeError("invalid_request");
      const practice = validatePracticeRequest(Object.fromEntries(u.searchParams), false);
      args = { p_actor_id: actorId, p_request: toDatabasePracticeRequest(practice) };
    } else if (matched.id === "practiceStart" || matched.id === "practiceReplace") {
      body = validateObject(await readJsonBody(request), ["examKey", "profileId", "purpose", "domain", "count", "includePbqs", "mixStrategy", "language", "contentKind", "assignmentId", "clientRequestId"], ["examKey", "profileId", "purpose", "includePbqs", "clientRequestId"]);
      const practice = validatePracticeRequest(body, true);
      args = { p_actor_id: actorId, p_request: toDatabasePracticeRequest(practice) };
    } else if (matched.id === "practiceCheck") {
      body = validateObject(await readJsonBody(request), ["expectedRevision", "requestId"], ["expectedRevision", "requestId"]);
      if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1) throw new SafeError("invalid_request");
      args = { p_actor_id: actorId, p_attempt_id: assertUuid(matched.params.attemptId), p_item_id: assertUuid(matched.params.itemId), p_expected_revision: body.expectedRevision, p_request_id: assertUuid(body.requestId) };
    } else if (matched.id === "history" || matched.id === "staffHistory") {
      const u = new URL(request.url); const size = Number(u.searchParams.get("pageSize") ?? "20");
      const permitted = matched.id === "history" ? ["cursor", "pageSize", "examKey"] : ["cursor", "pageSize"];
      if (![...u.searchParams.keys()].every((key) => permitted.includes(key)) || !Number.isSafeInteger(size) || size < 1 || size > 50) throw new SafeError("invalid_request");
      args = matched.id === "history"
        ? { p_actor_id: actorId, p_exam_key: u.searchParams.get("examKey"), p_cursor: u.searchParams.get("cursor"), p_page_size: size }
        : { p_actor_id: actorId, p_cursor: u.searchParams.get("cursor"), p_page_size: size };
    } else if (matched.id === "staffDashboardScope" || matched.id === "staffScopeOptions" || matched.id === "staffDashboardQuery") {
      const u = new URL(request.url);
      const permitted = matched.id === "staffScopeOptions"
        ? ["organisationId"]
        : ["organisationId", "campusId", "groupId", "assignmentId", "examKey", "resultStatus", "search", "workflow", "cursor", "pageSize"];
      if ([...u.searchParams.keys()].some((key) => !permitted.includes(key))) throw new SafeError("invalid_request");
      const pageSize = Number(u.searchParams.get("pageSize") ?? "50");
      const search = u.searchParams.get("search") ?? "";
      if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50 || search.length > 100) throw new SafeError("invalid_request");
      args = { p_actor_id: actorId, p_request: Object.fromEntries([...u.searchParams.entries()].filter(([, value]) => value !== "")) };
    } else if (matched.id === "staffAnalytics") {
      const u = new URL(request.url);
      if ([...u.searchParams.keys()].length > 0) throw new SafeError("invalid_request");
      args = { p_actor_id: actorId };
    } else if (matched.id === "historySummary") {
      const u = new URL(request.url); const examKey = u.searchParams.get("examKey");
      if (!isExamKey(examKey) || [...u.searchParams.keys()].some((key) => key !== "examKey")) throw new SafeError("invalid_request");
      args = { p_actor_id: actorId, p_exam_key: examKey };
    } else if (matched.id === "printSummary") {
      args = { p_actor_id: actorId, p_attempt_id: assertUuid(matched.params.attemptId) };
    } else if (matched.id === "start") {
      body = validateObject(await readJsonBody(request), [
        "examKey",
        "profileId",
        "clientRequestId",
        "assignmentId",
      ], ["examKey", "profileId", "clientRequestId"]);
      if (!isExamKey(body.examKey) || !isProfileId(body.profileId)) {
        throw new SafeError("invalid_request");
      }
      args = {
        p_actor_id: actorId,
        p_exam_key: body.examKey,
        p_profile_key: body.profileId,
        p_request_id: assertUuid(body.clientRequestId),
        ...(body.assignmentId == null ? {} : { p_assignment_id: assertUuid(body.assignmentId) }),
      };
    } else if (matched.id === "save") {
      body = validateObject(await readJsonBody(request), [
        "response",
        "expectedRevision",
        "requestId",
      ], ["response", "expectedRevision", "requestId"]);
      if (
        !Number.isSafeInteger(body.expectedRevision) ||
        Number(body.expectedRevision) < 0
      ) throw new SafeError("invalid_request");
      validateResponsePayload(body.response);
      args = {
        p_actor_id: actorId,
        p_attempt_id: assertUuid(matched.params.attemptId),
        p_item_id: assertUuid(matched.params.itemId),
        p_response: body.response,
        p_expected_revision: body.expectedRevision,
        p_request_id: assertUuid(body.requestId),
      };
    } else if (matched.id === "flags") {
      args = { p_actor_id: actorId, p_attempt_id: assertUuid(matched.params.attemptId) };
    } else if (matched.id === "flag") {
      body = validateObject(await readJsonBody(request), ["flagged", "requestId"], ["flagged", "requestId"]);
      if (typeof body.flagged !== "boolean") throw new SafeError("invalid_request");
      args = { p_actor_id: actorId, p_attempt_id: assertUuid(matched.params.attemptId), p_item_id: assertUuid(matched.params.itemId), p_flagged: body.flagged, p_request_id: assertUuid(body.requestId) };
    } else if (matched.id === "questionIssue") {
      body = validateObject(await readJsonBody(request), ["message", "requestId"], ["message", "requestId"]);
      if (typeof body.message !== "string" || body.message.trim().length < 1 || body.message.length > 2000) throw new SafeError("invalid_request");
      args = { p_actor_id: actorId, p_attempt_id: assertUuid(matched.params.attemptId), p_item_id: assertUuid(matched.params.itemId), p_message: body.message.trim(), p_request_id: assertUuid(body.requestId) };
    } else if (matched.id === "abandon") {
      body = validateObject(await readJsonBody(request), ["requestId"], ["requestId"]);
      args = { p_actor_id: actorId, p_attempt_id: assertUuid(matched.params.attemptId), p_request_id: assertUuid(body.requestId) };
    } else if (matched.id === "submit") {
      body = validateObject(await readJsonBody(request), ["submissionId"], [
        "submissionId",
      ]);
      args = {
        p_actor_id: actorId,
        p_attempt_id: assertUuid(matched.params.attemptId),
        p_submission_id: assertUuid(body.submissionId),
      };
    } else {args = {
        p_actor_id: actorId,
        p_attempt_id: assertUuid(matched.params.attemptId),
      };}
    const admin = (deps.createAdmin ?? createPrivilegedClient)();
    const { data: rpcData, error: rpcError } = await admin.rpc(
      matched.rpc,
      args,
    );
    if (rpcError) {
      const safeRateLimit = rpcError as { status?: number; code?: string };
      if (
        safeRateLimit.status === 429 || safeRateLimit.code === "rate_limited"
      ) {
        throw new SafeError("rate_limited");
      }
      throw new SafeError("internal_failure");
    }
    if (
      !rpcData ||
      (typeof rpcData === "object" &&
        (rpcData as Record<string, unknown>).ok === false)
    ) throw translateRpcFailure(rpcData);
    let mapped: unknown;
    if (matched.id === "eligibility") mapped = mapEligibility(rpcData);
    else if (matched.id === "itemPage") mapped = mapAttemptItemPage(rpcData);
    else if (matched.id === "currentBindings") mapped = mapCurrentAttemptBindings(rpcData);
    else if (matched.id === "practiceAvailability") mapped = mapPracticeAvailability(rpcData);
    else if (matched.id === "practiceCheck") mapped = mapPracticeCheck(rpcData);
    else if (matched.id === "history") mapped = mapHistory(rpcData);
    else if (matched.id === "staffHistory") mapped = mapStaffHistory(rpcData);
    else if (matched.id === "staffAnalytics") mapped = mapStaffAnalytics(rpcData);
    else if (matched.id === "staffDashboardScope") mapped = mapStaffDashboardScope(rpcData);
    else if (matched.id === "staffScopeOptions") mapped = mapStaffScopeOptions(rpcData);
    else if (matched.id === "staffDashboardQuery") mapped = mapStaffDashboardQuery(rpcData);
    else if (matched.id === "historySummary") mapped = mapHistorySummary(rpcData);
    else if (matched.id === "printSummary") mapped = mapPrintSummary(rpcData);
    else if (matched.id === "start" || matched.id === "practiceStart" || matched.id === "practiceReplace" || matched.id === "resume" || matched.id === "current") {
      mapped = mapAttempt(rpcData);
    } else if (matched.id === "save") mapped = mapSavedResponse(rpcData);
    else if (matched.id === "flags") mapped = mapFlags(rpcData);
    else if (matched.id === "flag") mapped = mapFlag(rpcData);
    else if (matched.id === "questionIssue") mapped = mapQuestionIssue(rpcData);
    else if (matched.id === "abandon") mapped = mapAbandonedAttempt(rpcData);
    else if (matched.id === "review") mapped = mapReview(rpcData);
    else mapped = mapResult(rpcData);
    if (matched.id === "practiceCheck") assertPracticeFeedbackSafe(mapped);
    else if (matched.id !== "review") assertNoProtectedPreReview(mapped);
    status = matched.id === "start" || matched.id === "practiceStart" || matched.id === "practiceReplace" ? 201 : 200;
    outcome = "ok";
    return jsonResponse(status, mapped, cors);
  } catch (error) {
    const safe = error instanceof SafeError
      ? error
      : new SafeError("internal_failure");
    status = safe.status;
    outcome = safe.code;
    return errorResponse(safe, correlationId, cors);
  } finally {
    logSafe({
      correlationId,
      route,
      method: request.method,
      outcome,
      status,
      durationMs: Math.round(performance.now() - started),
    }, deps.log);
  }
}

const PRACTICE_PURPOSES = new Set(["self_directed_exam", "study_sandbox", "targeted_domain", "weak_area", "pbq_practice"]);
const ATTEMPT_PURPOSES = new Set(["assigned_assessment", ...PRACTICE_PURPOSES]);
const LANGUAGES = new Set(["csharp", "python", "mixed", "not_applicable"]);
function validatePracticeRequest(value: Record<string, unknown>, mutation: boolean): Record<string, unknown> {
  if (!isExamKey(value.examKey) || !isProfileId(value.profileId) || !PRACTICE_PURPOSES.has(String(value.purpose))) throw new SafeError("invalid_request");
  const fixedProfile = value.purpose === "self_directed_exam";
  const count = value.count == null ? undefined : Number(value.count);
  if (fixedProfile) {
    if (value.count != null && (!Number.isSafeInteger(count) || Number(count) < 1 || Number(count) > 100)) throw new SafeError("invalid_request");
  } else if (["study_sandbox", "targeted_domain", "pbq_practice"].includes(String(value.purpose))) {
    if (value.count != null) throw new SafeError("invalid_request");
  } else if (![10, 20, 30, 40].includes(Number(count)) && value.count !== "all") throw new SafeError("invalid_request");
  if (![true, false, "true", "false"].includes(value.includePbqs as never)) throw new SafeError("invalid_request");
  if (!isCanonicalLanguage(value.examKey, value.language)) throw new SafeError("invalid_request");
  if (value.mixStrategy != null && !["missed-heavy", "balanced", "new-heavy"].includes(String(value.mixStrategy))) throw new SafeError("invalid_request");
  if (value.domain != null && (typeof value.domain !== "string" || value.domain.length > 128)) throw new SafeError("invalid_request");
  if (value.contentKind != null && !["pbq", "case-study"].includes(String(value.contentKind))) throw new SafeError("invalid_request");
  if (mutation) assertUuid(value.clientRequestId);
  const canonical: Record<string, unknown> = { ...value, ...(count == null ? {} : { count }), includePbqs: value.includePbqs === true || value.includePbqs === "true" };
  if (String(value.examKey).toLowerCase() !== "az204") delete canonical.language;
  return canonical;
}

function isCanonicalLanguage(examKey: unknown, language: unknown): boolean {
  return String(examKey).toLowerCase() === "az204"
    ? ["csharp", "python", "mixed"].includes(String(language))
    : language == null || language === "not_applicable";
}

function toDatabaseLanguage(examKey: unknown, language: unknown): string {
  return String(examKey).toLowerCase() === "az204" ? String(language) : "not_applicable";
}

function toDatabasePracticeRequest(practice: Record<string, unknown>): Record<string, unknown> {
  return {
    ...practice,
    language: toDatabaseLanguage(practice.examKey, practice.language),
    ...(practice.assignmentId == null ? {} : { assignmentId: assertUuid(practice.assignmentId) }),
  };
}

function isExamKey(value: unknown): value is string {
  return typeof value === "string" && value.length >= 2 && value.length <= 64 &&
    /^[a-z0-9][a-z0-9+._-]*$/i.test(value);
}

function isProfileId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128 &&
    /^[a-z0-9][a-z0-9._-]*$/i.test(value);
}

function isPackageVersion(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(value);
}

function isPracticePurpose(value: unknown, includeAssessment = false): value is string {
  return (includeAssessment ? ATTEMPT_PURPOSES : PRACTICE_PURPOSES).has(String(value));
}

function isLanguage(value: unknown): value is string {
  return LANGUAGES.has(String(value));
}
