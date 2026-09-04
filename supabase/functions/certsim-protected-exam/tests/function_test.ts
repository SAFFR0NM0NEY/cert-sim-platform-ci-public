import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1.0.14";
import { resolvePrivilegedKey } from "../client.ts";
import { corsHeaders } from "../cors.ts";
import { SafeError, translateRpcFailure } from "../errors.ts";
import { handleProtectedExam } from "../handler.ts";
import { matchRoute } from "../routes.ts";
import { assertNoProtectedPreReview, assertPracticeFeedbackSafe, mapAttempt, mapCurrentAttemptBindings, mapFlag, mapFlags, mapHistory, mapPracticeCheck, mapQuestionIssue, mapResult, mapReview, mapStaffAnalytics, mapStaffDashboardQuery, mapStaffDashboardScope, mapStaffHistory, mapStaffScopeOptions } from "../responses.ts";
import {
  MAX_BODY_BYTES,
  readJsonBody,
  validateObject,
  validateResponsePayload,
} from "../validation.ts";

const ACTOR = "11000000-0000-4000-8000-000000000001",
  ATTEMPT = "12000000-0000-4000-8000-000000000001",
  ITEM = "13000000-0000-4000-8000-000000000001",
  REQUEST = "14000000-0000-4000-8000-000000000001";
const ORIGIN = "http://localhost:5173";
const EMPTY_STAFF_ANALYTICS = {
  scopeComplete: true,
  totals: { visibleLearners: 0, learnersWithActivity: 0, learnersWithoutActivity: 0, historicalActivity: 0, protectedAssessments: 0, legacyHistorical: 0 },
  learners: [],
  exams: [],
  groups: [],
  assignments: [],
  assignmentLearners: [],
  domains: [],
};

Deno.test("result mapper explicitly retains only the strict authority marker", () => {
  const mapped = mapResult({
    ok: true,
    result: {
      attemptId: ATTEMPT,
      serverAuthoritative: true,
      correctAnswer: "blocked",
      protectedSnapshot: { blocked: true },
    },
  });
  assertEquals(mapped, {
    result: { attemptId: ATTEMPT, serverAuthoritative: true },
  });
});
Deno.test("staff analytics mapper accepts only complete bounded public aggregates", () => {
  const analytics = {
    scopeComplete: true,
    totals: { visibleLearners: 2, learnersWithActivity: 1, learnersWithoutActivity: 1, historicalActivity: 3, protectedAssessments: 2, legacyHistorical: 1 },
    learners: [
      { learnerId: ACTOR, examKey: "az204", activityCount: "3", assessmentCount: "2", historicalCount: "1", assessedLearnerCount: "1", needsReviewCount: "1", passedCount: "1", latestActivity: "2026-09-01T00:00:00Z", latestAttemptId: ATTEMPT, latestPercentage: "80", bestPercentage: "90", lowestPercentage: "70", averagePercentage: "80", passRate: "50", domains: [{ domainKey: "implement", averagePercentage: "65", sampleCount: "2" }], protectedPayload: "blocked" },
      { learnerId: "11000000-0000-4000-8000-000000000002", examKey: "ai901", activityCount: "0", assessmentCount: "0", historicalCount: "0", assessedLearnerCount: "1", needsReviewCount: "0", passedCount: "0", latestActivity: null, latestAttemptId: null, latestPercentage: null, bestPercentage: null, lowestPercentage: null, averagePercentage: null, passRate: null, domains: [] },
    ],
    exams: [{ examKey: "az204", activityCount: "3", assessmentCount: "2", historicalCount: "1", assessedLearnerCount: "1", needsReviewCount: "1", passedCount: "1", latestActivity: "2026-09-01T00:00:00Z", bestPercentage: "90", lowestPercentage: "70", averagePercentage: "80", passRate: "50" }],
    groups: [{ groupId: ACTOR, assessmentCount: "2", assessedLearnerCount: "1", averagePercentage: "80", passRate: "50", domains: [{ examKey: "az204", domainKey: "implement", sampleCount: "2", studentCount: "1", weakCount: "1", averagePercentage: "65" }] }],
    assignments: [{ assignmentId: ATTEMPT, examKey: "az204", groupId: ACTOR, dueAt: null, totalStudents: "1", assessmentCount: "2", assessedLearnerCount: "1", needsReviewCount: "1", averagePercentage: "80", passRate: "50" }],
    assignmentLearners: [{ assignmentId: ATTEMPT, learnerId: ACTOR, assignmentAttemptCount: "2", latestAssignmentActivity: "2026-09-01T00:00:00Z", latestAssignmentAttemptId: ATTEMPT }],
    domains: [{ examKey: "az204", domainKey: "implement", sampleCount: "2", studentCount: "1", weakCount: "1", averagePercentage: "65" }],
  };
  const query = mapStaffDashboardQuery({
    role: "trainer",
    workflow: "overview",
    selection: { organisationId: ACTOR, campusId: null, groupId: null, assignmentId: null },
    assignmentPage: { items: [], nextCursor: null, complete: true, returnedCount: 0, totalCount: 0 },
    learnerIds: [ACTOR],
    history: {
      items: [
        { attemptId: ATTEMPT, learnerId: ACTOR, assignmentId: null, examKey: "az204", packageVersion: "1.0.0", profileKey: "full", purpose: "self_directed_exam", analyticsEligible: true, completedAt: "2026-09-01T00:00:00Z", serverAuthoritative: true, source: "protected" },
        { attemptId: "12000000-0000-4000-8000-000000000002", learnerId: ACTOR, assignmentId: null, examKey: "az204", packageVersion: "legacy", profileKey: "full", purpose: "self_directed_exam", analyticsEligible: true, completedAt: "2026-08-01T00:00:00Z", serverAuthoritative: false, source: "legacy_authoritative" },
      ],
      totalCount: 2,
      completedCount: 2,
      returnedCount: 2,
      nextCursor: null,
    },
    analytics,
  });
  const mapped = query.analytics as Record<string, unknown>;
  assertEquals(mapped.scopeComplete, true);
  assertEquals((mapped.learners as Array<Record<string, unknown>>)[0].activityCount, 3);
  assertEquals((mapped.exams as Array<Record<string, unknown>>)[0].lowestPercentage, 70);
  assertEquals((mapped.exams as Array<Record<string, unknown>>)[0].latestPercentage, undefined);
  assertEquals((mapped.learners as Array<Record<string, unknown>>)[1].latestPercentage, null);
  assertEquals((mapped.learners as Array<Record<string, unknown>>)[0].protectedPayload, undefined);
  assertEquals((mapped.learners as Array<Record<string, unknown>>)[0].latestAttemptId, ATTEMPT);
  assertEquals((mapped.assignmentLearners as Array<Record<string, unknown>>)[0].assignmentAttemptCount, 2);
  assertEquals((mapped.assignments as Array<Record<string, unknown>>)[0].totalStudents, 1);
  assertEquals((mapped.assignments as Array<Record<string, unknown>>)[0].examKey, "az204");
});
Deno.test("staff analytics mapper fails closed on missing or malformed rows", () => {
  const totals = { visibleLearners: 0, learnersWithActivity: 0, learnersWithoutActivity: 0, historicalActivity: 0, protectedAssessments: 0, legacyHistorical: 0 };
  assertThrows(() => mapStaffAnalytics({ scopeComplete: true, totals, exams: [] }), SafeError);
  assertThrows(() => mapStaffAnalytics({ scopeComplete: true, totals, learners: [], exams: [{ examKey: "az204", activityCount: -1, assessmentCount: 0, historicalCount: 0, assessedLearnerCount: 0, needsReviewCount: 0, latestActivity: null, bestPercentage: null, lowestPercentage: null, averagePercentage: null, passRate: null }] }), SafeError);
  assertThrows(() => mapStaffAnalytics({ scopeComplete: true, totals, learners: [], exams: [{ examKey: "az204", activityCount: "not-a-count", assessmentCount: 0, historicalCount: 0, assessedLearnerCount: 0, needsReviewCount: 0, latestActivity: null, bestPercentage: null, lowestPercentage: null, averagePercentage: null, passRate: null }] }), SafeError);
  assertThrows(() => mapStaffAnalytics({ scopeComplete: true, totals, learners: [{ learnerId: ACTOR, examKey: "az204", activityCount: 0, assessmentCount: 0, historicalCount: 0, assessedLearnerCount: 1, needsReviewCount: 0, passedCount: 0, latestActivity: null, latestAttemptId: null, bestPercentage: null, lowestPercentage: null, averagePercentage: null, passRate: null, domains: [] }], exams: [], groups: [], assignments: [], assignmentLearners: [], domains: [] }), SafeError);
});
Deno.test("staff dashboard scope mapper is content-free and fail-closed", () => {
  const assignment = "15000000-0000-4000-8000-000000000001";
  const mapped = mapStaffDashboardScope({
    role: "developer",
    locks: { organisation: false, campus: false },
    selection: { organisationId: null, campusId: null, groupId: null, assignmentId: null },
    organisations: [{ id: ACTOR, name: "Synthetic college", internal: "blocked" }],
    campuses: [], groups: [], learnerIds: [],
    assignmentPage: { items: [{ id: assignment, name: "Synthetic assignment", organisationId: ACTOR, campusId: null, groupId: null, studentUserId: ACTOR, examKey: "securityplussy0701", profileId: "strict-beta-full", status: "active", dueAt: null, availableFrom: null, createdAt: "2026-09-01T00:00:00Z", internal: "blocked" }], nextCursor: null, complete: true, returnedCount: 1 },
    history: { items: [
      { attemptId: ATTEMPT, learnerId: ACTOR, assignmentId: assignment, examKey: "security-plus-sy0-701", packageVersion: "1.0.0", profileKey: "strict-beta-full", purpose: "assigned_assessment", completedAt: "2026-09-01T01:00:00Z", score: 0, percentage: 0, passed: false, domainSummary: {}, analyticsEligible: true, serverAuthoritative: true, source: "protected", protectedPayload: "blocked" },
      { attemptId: assignment, learnerId: ACTOR, assignmentId: null, examKey: "az204", packageVersion: "legacy", profileKey: "full", purpose: "self_directed_exam", completedAt: "2026-08-01T01:00:00Z", score: null, percentage: null, passed: null, domainSummary: {}, analyticsEligible: true, serverAuthoritative: false, source: "legacy_authoritative" },
    ], totalCount: 2, completedCount: 2, averagePercentage: 0, passRate: 0 },
  });
  assertEquals((mapped.organisations as Array<Record<string, unknown>>)[0], { id: ACTOR, name: "Synthetic college" });
  const mappedAssignmentPage = mapped.assignmentPage as Record<string, unknown>;
  const mappedHistory = mapped.history as Record<string, unknown>;
  assertEquals((mappedAssignmentPage.items as Array<Record<string, unknown>>)[0].examKey, "securityplussy0701");
  assertEquals((mappedHistory.items as Array<Record<string, unknown>>)[0].percentage, 0);
  assertEquals((mappedHistory.items as Array<Record<string, unknown>>)[0].protectedPayload, undefined);
  assertEquals((mappedHistory.items as Array<Record<string, unknown>>)[1].serverAuthoritative, false);
  assertThrows(() => mapStaffDashboardScope({ role: "developer", organisations: [], campuses: [], groups: [], learnerIds: [], assignmentPage: { items: [], nextCursor: 7, complete: true, returnedCount: 0 }, history: { items: [], totalCount: 0, completedCount: 0 } }), SafeError);
  assertThrows(() => mapStaffDashboardScope({ role: "developer", organisations: [], campuses: [], groups: [], learnerIds: [], assignmentPage: { items: [{ id: assignment, name: "Bad", examKey: "az204", status: "active" }], nextCursor: null, complete: true, returnedCount: 1 }, history: { items: [{ attemptId: ATTEMPT, learnerId: ACTOR, assignmentId: assignment, examKey: "az204", purpose: "weak_area", analyticsEligible: true, serverAuthoritative: true, source: "protected" }], totalCount: 1, completedCount: 1 } }), SafeError);
});
Deno.test("staff filter options and bounded query DTOs stay minimal and fail closed", () => {
  const assignment = "15000000-0000-4000-8000-000000000001";
  const options = mapStaffScopeOptions({ role: "trainer", locks: { organisation: true, campus: false }, selection: { organisationId: ACTOR }, organisations: [{ id: ACTOR, name: "Org" }], campuses: [], groups: [], assignments: [{ id: assignment, name: "Assignment", organisationId: ACTOR, campusId: null, groupId: null, examKey: "az204", status: "active", hidden: "blocked" }], exams: [{ id: "az204", name: "az204" }] });
  assertEquals((options.assignments as Array<Record<string, unknown>>)[0].hidden, undefined);
  const query = mapStaffDashboardQuery({ role: "trainer", workflow: "results", selection: { organisationId: ACTOR, campusId: null, groupId: null, assignmentId: null }, assignmentPage: { items: [], nextCursor: null, complete: true, returnedCount: 0, totalCount: 0 }, learnerIds: [], history: { items: [], totalCount: 0, completedCount: 0, returnedCount: 0, nextCursor: null }, analytics: EMPTY_STAFF_ANALYTICS });
  assertEquals(query.workflow, "results");
  assertEquals((query.history as Record<string, unknown>).nextCursor, null);
  assertThrows(() => mapStaffDashboardQuery({ role: "trainer", workflow: "results", selection: {}, assignmentPage: { items: [], nextCursor: null, complete: true, returnedCount: 0, totalCount: 0 }, learnerIds: [], history: { items: [], totalCount: 0, completedCount: 0, nextCursor: null } }), SafeError);
  assertThrows(() => mapStaffDashboardQuery({ role: "trainer", workflow: "results", selection: {}, assignmentPage: { items: [], nextCursor: 7, complete: true, returnedCount: 0, totalCount: 0 }, learnerIds: [], history: { items: [], totalCount: 0, completedCount: 0, returnedCount: 0, nextCursor: null } }), SafeError);
  assertThrows(() => mapStaffScopeOptions({ role: "trainer", organisations: [], campuses: [], groups: [], assignments: [], exams: [{ id: "", name: "bad" }] }), SafeError);
});
function request(path: string, init: RequestInit = {}) {
  return new Request(
    `http://localhost/functions/v1/certsim-protected-exam${path}`,
    {
      headers: {
        authorization: "Bearer valid",
        "content-type": "application/json",
        origin: ORIGIN,
        ...init.headers,
      },
      ...init,
    },
  );
}
function deps(
  rpcData: unknown = {
    eligible: true,
    reasonCode: "eligible",
    profileKey: "p",
    profileName: "P",
    questionCount: 1,
    timeLimitMinutes: 1,
  },
  user: { id: string; user_metadata?: unknown } | null = { id: ACTOR },
) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let created = 0;
  return {
    calls,
    get created() {
      return created;
    },
    value: {
      origins: new Set([ORIGIN]),
      log: (_line: string) => {},
      userClient: {
        auth: {
          getUser: async () => ({
            data: { user },
            error: user ? null : { message: "bad" },
          }),
        },
      },
      createAdmin: () => {
        created++;
        return {
          rpc: async (name: string, args: Record<string, unknown>) => {
            calls.push({ name, args });
            return { data: rpcData, error: null };
          },
        } as never;
      },
    },
  };
}

Deno.test("matches normalized exact routes and rejects wrong methods", () => {
  assertEquals(
    matchRoute(request("/attempts/" + ATTEMPT + "/result")).id,
    "result",
  );
  assertEquals(
    matchRoute(request("//attempts//" + ATTEMPT + "//review/")).id,
    "review",
  );
  assertEquals(
    matchRoute(request("/attempts/current?examKey=ai-901&packageVersion=1.0.0&profileId=ai901-controlled-beta-compact&purpose=assigned_assessment&language=not_applicable")).id,
    "current",
  );
  try {
    matchRoute(request("/attempts", { method: "PUT" }));
    throw new Error("expected");
  } catch (e) {
    assertEquals((e as SafeError).code, "method_not_allowed");
  }
});
Deno.test("current attempt derives identity and accepts no actor or attempt id", async () => {
  const d = deps({
    ok: true,
    attempt: { attemptId: ATTEMPT, examKey: "ai901", profileKey: "p" },
    items: [],
  });
  const response = await handleProtectedExam(
    request("/attempts/current?examKey=ai-901&packageVersion=1.0.0&profileId=ai901-controlled-beta-compact&purpose=assigned_assessment&language=not_applicable"),
    d.value,
  );
  assertEquals(response.status, 200);
  assertEquals(d.calls, [{
    name: "certsim_protected_discover_current_attempt",
    args: {
      p_actor_id: ACTOR,
      p_exam_key: "ai-901",
      p_package_version: "1.0.0",
      p_profile_key: "ai901-controlled-beta-compact",
      p_purpose: "assigned_assessment",
      p_language: "not_applicable",
    },
  }]);
  const rejected = await handleProtectedExam(
    request(`/attempts/current?examKey=ai-901&packageVersion=1.0.0&profileId=ai901-controlled-beta-compact&purpose=assigned_assessment&language=not_applicable&actorId=${ACTOR}`),
    d.value,
  );
  assertEquals(rejected.status, 400);
});
Deno.test("current binding reconciliation is identity-derived, read-only, and safely mapped", async () => {
  const d = deps({ ok: true, candidates: [{ examKey: "az204", packageVersion: "1.1.0", profileKey: "standard-profile", profileName: "Standard", purpose: "self_directed_exam", languagePreference: "csharp", startedAt: "2026-09-02T00:00:00Z", expiresAt: "2026-09-02T02:00:00Z", timed: true, attemptId: ATTEMPT, selectedCount: 50, fixedProfileSize: true, profileComposition: { questionCount: 50 }, replacementPermitted: true }] });
  const response = await handleProtectedExam(request("/attempts/current-bindings?examKey=az204&purpose=self_directed_exam"), d.value);
  assertEquals(response.status, 200);
  assertEquals(d.calls, [{ name: "certsim_protected_list_current_attempt_bindings", args: { p_actor_id: ACTOR, p_exam_key: "az204", p_purpose: "self_directed_exam" } }]);
  const body = await response.json();
  assertEquals(body.candidates[0].attemptId, ATTEMPT);
  assertEquals(body.candidates[0].profileKey, "standard-profile");
  assertEquals(body.candidates[0].replacementPermitted, true);
  assertEquals(body.candidates[0].selectedCount, 50);
});
Deno.test("large untimed practice inventory is delivered through bounded stable pages", async () => {
  const d = deps({ ok: true, afterPosition: 20, returnedThrough: 40, totalCount: 234, hasMore: true, items: Array.from({ length: 20 }, (_, index) => ({
    itemId: `${String(index + 1).padStart(8, "0")}-0000-4000-8000-000000000001`,
    questionNumber: index + 21,
    questionId: `safe-${index + 21}`,
    questionType: "single-choice",
    presentation: { stem: `Safe item ${index + 21}`, options: [{ id: "a", text: "A" }] },
    revision: 0,
  })) });
  const response = await handleProtectedExam(request(`/attempts/${ATTEMPT}/items?afterPosition=20&pageSize=20`), d.value);
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.items.length, 20);
  assertEquals(body.items[0].questionNumber, 21);
  assertEquals(body.totalCount, 234);
  assertEquals(body.hasMore, true);
  assertEquals(d.calls, [{ name: "certsim_protected_list_attempt_item_page", args: { p_actor_id: ACTOR, p_attempt_id: ATTEMPT, p_after_position: 20, p_page_size: 20 } }]);
});
Deno.test("current binding mapper fails closed on malformed or excessive candidates", () => {
  assertThrows(() => mapCurrentAttemptBindings({ candidates: [{ examKey: "az204" }] }), SafeError);
  assertThrows(() => mapCurrentAttemptBindings({ candidates: Array.from({ length: 9 }, () => ({})) }), SafeError);
});
Deno.test("practice replacement is a fixed authenticated RPC with a validated request", async () => {
  const d = deps({ ok: true, attempt: { attemptId: ATTEMPT, examKey: "az204", profileKey: "standard-profile", languagePreference: "python" }, items: [] });
  const response = await handleProtectedExam(request("/practice/sessions/replace", { method: "POST", body: JSON.stringify({ examKey: "az204", profileId: "standard-profile", purpose: "self_directed_exam", includePbqs: true, language: "python", clientRequestId: REQUEST }) }), d.value);
  assertEquals(response.status, 201);
  assertEquals(d.calls, [{ name: "certsim_protected_replace_current_practice_attempt", args: { p_actor_id: ACTOR, p_request: { examKey: "az204", profileId: "standard-profile", purpose: "self_directed_exam", includePbqs: true, language: "python", clientRequestId: REQUEST } } }]);
});
Deno.test("non-language replacement omits the public sentinel and normalizes only at the RPC boundary", async () => {
  const d = deps({ ok: true, attempt: { attemptId: ATTEMPT, examKey: "az400", profileKey: "az400-mvp-full-profile", languagePreference: "not_applicable" }, items: [] });
  const response = await handleProtectedExam(request("/practice/sessions/replace", { method: "POST", body: JSON.stringify({ examKey: "az400", profileId: "az400-mvp-full-profile", purpose: "self_directed_exam", includePbqs: true, clientRequestId: REQUEST }) }), d.value);
  assertEquals(response.status, 201);
  assertEquals(d.calls[0], { name: "certsim_protected_replace_current_practice_attempt", args: { p_actor_id: ACTOR, p_request: { examKey: "az400", profileId: "az400-mvp-full-profile", purpose: "self_directed_exam", includePbqs: true, clientRequestId: REQUEST, language: "not_applicable" } } });
  assertEquals((await response.json()).attempt.languagePreference, null);
});
Deno.test("current attempt forwards an exact assignment context", async () => {
  const assignmentId = "16000000-0000-4000-8000-000000000001";
  const d = deps({ ok: true, attempt: { attemptId: ATTEMPT }, items: [] });
  const response = await handleProtectedExam(request(`/attempts/current?examKey=ai-901&packageVersion=1.0.0&profileId=ai901-controlled-beta-compact&purpose=assigned_assessment&language=not_applicable&assignmentId=${assignmentId}`), d.value);
  assertEquals(response.status, 200);
  assertEquals(d.calls[0].args.p_assignment_id, assignmentId);
});
Deno.test("current attempt requires the complete fixed binding", async () => {
  for (const query of [
    "examKey=az204&profileId=compact-profile&purpose=self_directed_exam&language=mixed",
    "examKey=az204&packageVersion=1.1.0&profileId=compact-profile&language=mixed",
    "examKey=az204&packageVersion=1.1.0&profileId=compact-profile&purpose=invented&language=mixed",
    "examKey=az204&packageVersion=1.1.0&profileId=compact-profile&purpose=self_directed_exam&language=invented",
  ]) {
    const d = deps();
    const response = await handleProtectedExam(request(`/attempts/current?${query}`), d.value);
    assertEquals(response.status, 400);
    assertEquals(d.calls.length, 0);
  }
});
Deno.test("CORS allows configured origin and rejects another", () => {
  assertEquals(
    new Headers(corsHeaders(request("/eligibility"), new Set([ORIGIN]))).get(
      "access-control-allow-origin",
    ),
    ORIGIN,
  );
  try {
    corsHeaders(
      new Request("http://x", { headers: { origin: "https://evil.test" } }),
      new Set([ORIGIN]),
    );
    throw new Error("expected");
  } catch (e) {
    assertEquals((e as SafeError).code, "origin_not_allowed");
  }
});
Deno.test("body parser enforces media type, declared and decoded 64 KiB limits", async () => {
  await assertRejects(
    () => readJsonBody(new Request("http://x", { method: "POST", body: "{}" })),
    SafeError,
  );
  await assertRejects(
    () =>
      readJsonBody(
        new Request("http://x", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": String(MAX_BODY_BYTES + 1),
          },
          body: "{}",
        }),
      ),
    SafeError,
  );
  await assertRejects(
    () =>
      readJsonBody(
        new Request("http://x", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ x: "a".repeat(MAX_BODY_BYTES) }),
        }),
      ),
    SafeError,
  );
  await assertRejects(
    () =>
      readJsonBody(
        new Request("http://x", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{",
        }),
      ),
    SafeError,
  );
});
Deno.test("schemas reject arrays, unknown and identity fields, invalid revision shapes", () => {
  for (
    const value of [[], { examKey: "ai-901", actorId: ACTOR }, {
      examKey: "ai-901",
      extra: true,
    }]
  ) {
    try {
      validateObject(value, ["examKey"], ["examKey"]);
      throw new Error("expected");
    } catch (e) {
      assert(e instanceof SafeError);
    }
  }
  try {
    validateResponsePayload({
      answer: { nested: { more: { x: { x: { x: { x: { x: { x: 1 } } } } } } } },
    });
    throw new Error("expected");
  } catch (e) {
    assert(e instanceof SafeError);
  }
});
Deno.test("verified auth actor is injected and request actor cannot override it", async () => {
  const d = deps();
  const body = {
    examKey: "ai-901",
    profileId: "p",
    clientRequestId: REQUEST,
    actorId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  };
  const rejected = await handleProtectedExam(
    request("/attempts", { method: "POST", body: JSON.stringify(body) }),
    d.value,
  );
  assertEquals(rejected.status, 400);
  assertEquals(d.created, 0);
  const ok = await handleProtectedExam(
    request("/eligibility?examKey=ai-901&packageVersion=1.0.0&profileId=p&purpose=assigned_assessment"),
    d.value,
  );
  assertEquals(ok.status, 200);
  assertEquals(d.calls[0], {
    name: "certsim_protected_check_profile_eligibility",
    args: {
      p_actor_id: ACTOR,
      p_exam_key: "ai-901",
      p_package_version: "1.0.0",
      p_profile_key: "p",
      p_purpose: "assigned_assessment",
    },
  });
});
Deno.test("semantic eligibility denial remains a read-only HTTP 200 contract", async () => {
  const d = deps({
    eligible: false,
    reasonCode: "access_not_granted",
    examKey: "ai901",
    packageVersion: "2.0.0",
    profileKey: "ai901-controlled-beta-full",
    purpose: "self_directed_exam",
  });
  const response = await handleProtectedExam(
    request("/eligibility?examKey=ai901&packageVersion=2.0.0&profileId=ai901-controlled-beta-full&purpose=self_directed_exam"),
    d.value,
  );
  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    eligible: false,
    reasonCode: "access_not_granted",
    examKey: "ai901",
    packageVersion: "2.0.0",
    profileKey: "ai901-controlled-beta-full",
    purpose: "self_directed_exam",
  });
  assertEquals(d.calls.length, 1);
});
Deno.test("auth fails before privileged client creation and metadata is ignored", async () => {
  const missing = deps({}, null);
  const result = await handleProtectedExam(
    request("/eligibility?examKey=ai-901&packageVersion=1.0.0&profileId=p&purpose=assigned_assessment"),
    missing.value,
  );
  assertEquals(result.status, 401);
  assertEquals(missing.created, 0);
  const valid = deps(undefined, {
    id: ACTOR,
    user_metadata: { actorId: "ffffffff-ffff-4fff-8fff-ffffffffffff" },
  });
  await handleProtectedExam(
    request("/eligibility?examKey=ai-901&packageVersion=1.0.0&profileId=p&purpose=assigned_assessment"),
    valid.value,
  );
  assertEquals(valid.calls[0].args.p_actor_id, ACTOR);
});
Deno.test("missing, malformed, invalid and expired auth are stable", async () => {
  for (
    const authorization of [
      undefined,
      "Token malformed",
      "Bearer invalid",
      "Bearer expired",
    ]
  ) {
    const d = deps(
      {},
      authorization?.endsWith("invalid") || authorization?.endsWith("expired")
        ? null
        : { id: ACTOR },
    );
    const headers: Record<string, string> = { origin: ORIGIN };
    if (authorization) headers.authorization = authorization;
    const response = await handleProtectedExam(
      new Request(
        "http://localhost/functions/v1/certsim-protected-exam/eligibility?examKey=ai-901&packageVersion=1.0.0&profileId=p&purpose=assigned_assessment",
        { headers },
      ),
      d.value,
    );
    assertEquals(response.status, 401);
    assertEquals((await response.json()).error.code, "unauthenticated");
    assertEquals(d.created, 0);
  }
});
Deno.test("save route validates and selects one exact RPC", async () => {
  const d = deps({
    ok: true,
    itemId: ITEM,
    revision: 1,
    updatedAt: "now",
    protectedSnapshot: "leak",
  });
  const response = await handleProtectedExam(
    request(`/attempts/${ATTEMPT}/items/${ITEM}/response`, {
      method: "PUT",
      body: JSON.stringify({
        response: { answer: "a" },
        expectedRevision: 0,
        requestId: REQUEST,
      }),
    }),
    d.value,
  );
  assertEquals(response.status, 200);
  assertEquals(d.calls.length, 1);
  assertEquals(d.calls[0].name, "certsim_protected_save_response");
  assertEquals(await response.json(), {
    itemId: ITEM,
    revision: 1,
    updatedAt: "now",
  });
});
Deno.test("flags remain owner-derived and use fixed protected routes", async () => {
  const listed = deps({ ok: true, itemIds: [ITEM], protectedPayload: "blocked" });
  const listResponse = await handleProtectedExam(request(`/attempts/${ATTEMPT}/flags`), listed.value);
  assertEquals(listResponse.status, 200);
  assertEquals(listed.calls[0], { name: "certsim_protected_list_flags", args: { p_actor_id: ACTOR, p_attempt_id: ATTEMPT } });
  assertEquals(await listResponse.json(), { itemIds: [ITEM] });

  const changed = deps({ ok: true, itemId: ITEM, flagged: true, updatedAt: "now" });
  const changeResponse = await handleProtectedExam(request(`/attempts/${ATTEMPT}/items/${ITEM}/flag`, { method: "PUT", body: JSON.stringify({ flagged: true, requestId: REQUEST }) }), changed.value);
  assertEquals(changeResponse.status, 200);
  assertEquals(changed.calls[0].name, "certsim_protected_set_flag");
  assertEquals(changed.calls[0].args.p_actor_id, ACTOR);
  assertEquals(await changeResponse.json(), { itemId: ITEM, flagged: true, updatedAt: "now" });
  assertThrows(() => mapFlags({ itemIds: [1] }), SafeError);
  assertThrows(() => mapFlag({ itemId: ITEM, flagged: "true" }), SafeError);
});
Deno.test("attempt mapper preserves only safe assignment provenance", () => {
  const assignmentId = "16000000-0000-4000-8000-000000000001";
  const mapped = mapAttempt({ attempt: { attemptId: ATTEMPT, assignmentId, examKey: "az204", protectedPayload: "blocked" }, items: [] });
  assertEquals((mapped.attempt as Record<string, unknown>).assignmentId, assignmentId);
  assertEquals("protectedPayload" in (mapped.attempt as Record<string, unknown>), false);
  assertThrows(() => mapAttempt({ attempt: { attemptId: ATTEMPT, assignmentId: 7 }, items: [] }), SafeError);
});
Deno.test("learner history retains only safe assignment provenance", () => {
  const assignmentId = "15000000-0000-4000-8000-000000000001";
  const mapped = mapHistory({ items: [{ attemptId: ATTEMPT, assignmentId, examKey: "az204", protectedPayload: "blocked" }], nextCursor: null, returnedCount: 1, totalCount: 1, remainingCount: 0 });
  assertEquals((mapped.items as Array<Record<string, unknown>>)[0].assignmentId, assignmentId);
  assertEquals((mapped.items as Array<Record<string, unknown>>)[0].protectedPayload, undefined);
  assertThrows(() => mapHistory({ items: [{ attemptId: ATTEMPT, assignmentId: 7 }], returnedCount: 1, totalCount: 1, remainingCount: 0 }), SafeError);
});
Deno.test("public assignment practice and replacement preserve provenance for every AZ-204 language", async () => {
  const assignmentId = "16000000-0000-4000-8000-000000000001";
  for (const [fromLanguage, toLanguage] of [["csharp", "python"], ["python", "mixed"], ["mixed", "csharp"]]) {
    const start = deps({ ok: true, attempt: { attemptId: ATTEMPT, examKey: "az204", profileKey: "standard-profile", languagePreference: fromLanguage }, items: [] });
    const startResponse = await handleProtectedExam(request("/practice/sessions", {
      method: "POST",
      body: JSON.stringify({ examKey: "az204", profileId: "standard-profile", purpose: "self_directed_exam", includePbqs: true, mixStrategy: "balanced", language: fromLanguage, assignmentId, clientRequestId: REQUEST }),
    }), start.value);
    assertEquals(startResponse.status, 201);
    const startRequest = start.calls[0].args.p_request as Record<string, unknown>;
    assertEquals(startRequest.language, fromLanguage);
    assertEquals(startRequest.assignmentId, assignmentId);

    const replacement = deps({ ok: true, attempt: { attemptId: ATTEMPT, examKey: "az204", profileKey: "standard-profile", languagePreference: toLanguage }, items: [] });
    const replacementResponse = await handleProtectedExam(request("/practice/sessions/replace", {
      method: "POST",
      body: JSON.stringify({ examKey: "az204", profileId: "standard-profile", purpose: "self_directed_exam", includePbqs: true, mixStrategy: "balanced", language: toLanguage, assignmentId, clientRequestId: REQUEST }),
    }), replacement.value);
    assertEquals(replacementResponse.status, 201);
    const replaceRequest = replacement.calls[0].args.p_request as Record<string, unknown>;
    assertEquals(replaceRequest.language, toLanguage);
    assertEquals(replaceRequest.assignmentId, assignmentId);
  }
});
Deno.test("abandon is an owner-derived fixed mutation and returns no result", async () => {
  const abandoned = deps({ ok: true, attemptId: ATTEMPT, status: "abandoned", abandonedAt: "2026-09-03T00:00:00Z", result: "blocked" });
  const response = await handleProtectedExam(request(`/attempts/${ATTEMPT}/abandon`, {
    method: "POST",
    body: JSON.stringify({ requestId: REQUEST }),
  }), abandoned.value);
  assertEquals(response.status, 200);
  assertEquals(abandoned.calls, [{
    name: "certsim_protected_abandon_attempt",
    args: { p_actor_id: ACTOR, p_attempt_id: ATTEMPT, p_request_id: REQUEST },
  }]);
  assertEquals(await response.json(), {
    attemptId: ATTEMPT,
    status: "abandoned",
    abandonedAt: "2026-09-03T00:00:00Z",
  });
});
Deno.test("question issue reports are bounded, content-free, and identity-derived", async () => {
  const d = deps({ ok: true, received: true, id: "blocked", questionContent: "blocked" });
  const response = await handleProtectedExam(request(`/attempts/${ATTEMPT}/items/${ITEM}/issue`, { method: "POST", body: JSON.stringify({ message: "Synthetic wording issue", requestId: REQUEST }) }), d.value);
  assertEquals(response.status, 200);
  assertEquals(d.calls[0].name, "certsim_protected_report_question_issue");
  assertEquals(d.calls[0].args.p_actor_id, ACTOR);
  assertEquals(await response.json(), { received: true });
  assertEquals(mapQuestionIssue({ received: true, identity: "blocked" }), { received: true });
  const invalid = deps({ ok: true, received: true });
  const invalidResponse = await handleProtectedExam(request(`/attempts/${ATTEMPT}/items/${ITEM}/issue`, { method: "POST", body: JSON.stringify({ message: "", requestId: REQUEST }) }), invalid.value);
  assertEquals(invalidResponse.status, 400);
  assertEquals(invalid.calls.length, 0);
});
Deno.test("pre-review mapping fails closed on recursively protected content", () => {
  assertRejects(
    async () =>
      assertNoProtectedPreReview({ a: { b: { correctAnswer: "x" } } }),
    SafeError,
  );
  const mapped = mapReview({
    review: {
      items: [{
        itemId: ITEM,
        presentation: { stem: "safe" },
        correctAnswer: { id: "a" },
        explanation: "why",
        scoringSpec: "drop",
      }],
    },
  });
  assertEquals((mapped.review as { items: unknown[] }).items.length, 1);
});
Deno.test("known errors are stable and unknown errors fail closed", () => {
  assertEquals(
    translateRpcFailure({ code: "pilot_unavailable" }).code,
    "pilot_disabled",
  );
  assertEquals(
    translateRpcFailure({ code: "practice_unavailable" }).code,
    "practice_unavailable",
  );
  assertEquals(
    translateRpcFailure({ code: "practice_unavailable" }).status,
    403,
  );
  assertEquals(translateRpcFailure({ code: "scope_required" }).code, "scope_required");
  assertEquals(translateRpcFailure({ code: "scope_required" }).status, 400);
  assertEquals(
    translateRpcFailure({ code: "raw postgres detail" }).code,
    "internal_failure",
  );
});
Deno.test("assignment availability conflicts remain safe business responses", async () => {
  const assignmentId = "15000000-0000-4000-8000-000000000001";
  for (const classification of ["not-owned", "expired", "closed", "wrong-profile"]) {
    const d = deps({ ok: false, code: "assignment_conflict", internal: classification });
    const response = await handleProtectedExam(request(
      `/practice/availability?examKey=az204&profileId=standard-profile&purpose=self_directed_exam&includePbqs=false&language=csharp&assignmentId=${assignmentId}`,
    ), d.value);
    assertEquals(response.status, 409);
    const body = await response.json();
    assertEquals(body.error.code, "assignment_conflict");
    assertEquals(JSON.stringify(body).includes(classification), false);
  }
});
Deno.test("named secret selection is exact and local fallback is bounded", () => {
  assertEquals(
    resolvePrivilegedKey((n) =>
      n === "SUPABASE_SECRET_KEYS"
        ? JSON.stringify({ certsim_protected_runtime: "synthetic-secret" })
        : undefined
    ),
    "synthetic-secret",
  );
  assertEquals(
    resolvePrivilegedKey((n) =>
      n === "CERTSIM_PROTECTED_RUNTIME_SECRET_KEY"
        ? "local"
        : n === "CERTSIM_RUNTIME_MODE"
        ? "disposable-local"
        : undefined
    ),
    "local",
  );
  assertEquals(
    resolvePrivilegedKey((n) =>
      n === "SUPABASE_SECRET_KEYS"
        ? JSON.stringify({ default: "synthetic-local-default" })
        : n === "CERTSIM_PROTECTED_RUNTIME_SECRET_KEY"
        ? "local"
        : n === "CERTSIM_RUNTIME_MODE"
        ? "disposable-local"
        : undefined
    ),
    "local",
  );
  for (
    const dictionary of [
      "bad",
      JSON.stringify(null),
      JSON.stringify([]),
      JSON.stringify({ default: "synthetic-default" }),
      JSON.stringify({ "certsim-protected-runtime": "synthetic-old-name" }),
      JSON.stringify({ another_name: "synthetic-other" }),
      JSON.stringify({ certsim_protected_runtime: "" }),
    ]
  ) {
    try {
      resolvePrivilegedKey((n) =>
        n === "SUPABASE_SECRET_KEYS"
          ? dictionary
          : n === "CERTSIM_PROTECTED_RUNTIME_SECRET_KEY"
          ? "synthetic-local-must-not-win"
          : n === "SUPABASE_SERVICE_ROLE_KEY"
          ? "synthetic-service-role-must-not-win"
          : undefined
      );
      throw new Error("expected");
    } catch (e) {
      assertEquals((e as SafeError).code, "internal_failure");
    }
  }
  try {
    resolvePrivilegedKey(() => undefined);
    throw new Error("expected");
  } catch (e) {
    assertEquals((e as SafeError).code, "internal_failure");
  }
  try {
    resolvePrivilegedKey((n) =>
      n === "CERTSIM_PROTECTED_RUNTIME_SECRET_KEY"
        ? "synthetic-local-must-not-win"
        : undefined
    );
    throw new Error("expected");
  } catch (e) {
    assertEquals((e as SafeError).code, "internal_failure");
  }
});
Deno.test("safe logger output contains no bodies, headers, JWTs or identifiers", async () => {
  const lines: string[] = [];
  const d = deps();
  d.value.log = (line: string) => {
    lines.push(line);
  };
  await handleProtectedExam(request("/eligibility?examKey=ai-901&packageVersion=1.0.0&profileId=p&purpose=assigned_assessment"), d.value);
  assertEquals(lines.length, 1);
  assertMatch(lines[0], /correlationId/);
  assert(!lines[0].includes(ACTOR));
  assert(!lines[0].includes("Bearer"));
});
Deno.test("sandbox feedback uses a dedicated fail-closed response contract", () => {
  const valid = mapPracticeCheck({ ok: true, itemId: ITEM, revision: 1, status: "incorrect", earnedPoints: 0, maxPoints: 1, review: { explanation: "Synthetic feedback", remediation: "Synthetic remediation" }, releasedAt: "2026-08-31T00:00:00Z" });
  assertPracticeFeedbackSafe(valid);
  for (const invalid of [
    { ...valid, packageHash: "blocked" },
    { ...valid, scoringRules: {} },
    { ...valid, review: { ...(valid.review as Record<string, unknown>), correctAnswer: "blocked" } },
    { ...valid, review: { explanation: "Synthetic feedback" } },
  ]) assertRejects(async () => assertPracticeFeedbackSafe(invalid), SafeError);
  assertRejects(async () => assertNoProtectedPreReview(valid), SafeError);
  assertRejects(async () => mapPracticeCheck({ ...valid, unexpected: true }), SafeError);
});
Deno.test("sandbox feedback survives its dedicated handler boundary", async () => {
  const d = deps({ ok: true, itemId: ITEM, revision: 1, status: "incorrect", earnedPoints: 0, maxPoints: 1, review: { explanation: "Synthetic feedback", remediation: "Synthetic remediation" }, releasedAt: "2026-08-31T00:00:00Z" });
  const response = await handleProtectedExam(request(`/practice/sessions/${ATTEMPT}/items/${ITEM}/check`, { method: "POST", body: JSON.stringify({ expectedRevision: 1, requestId: REQUEST }) }), d.value);
  assertEquals(response.status, 200);
  const body = await response.json();
  assertPracticeFeedbackSafe(body);
  assertEquals(d.calls.length, 1);
});

Deno.test("practice and history routes are fixed and purpose-specific", () => {
  assertEquals(matchRoute(request("/practice/availability?examKey=az204&profileId=p&purpose=study_sandbox&count=10&includePbqs=false&language=csharp")).id, "practiceAvailability");
  assertEquals(matchRoute(request("/practice/sessions", { method: "POST", body: "{}" })).id, "practiceStart");
  assertEquals(matchRoute(request(`/practice/sessions/${ATTEMPT}/items/${ITEM}/check`, { method: "POST", body: "{}" })).id, "practiceCheck");
  assertEquals(matchRoute(request("/history?pageSize=20")).id, "history");
  assertEquals(matchRoute(request("/history/summary?examKey=az204")).id, "historySummary");
  assertEquals(matchRoute(request("/staff/history?pageSize=25")).id, "staffHistory");
  assertEquals(matchRoute(request("/staff/dashboard-scope?pageSize=50")).id, "staffDashboardScope");
  assertEquals(matchRoute(request("/staff/scope-options")).id, "staffScopeOptions");
  assertEquals(matchRoute(request("/staff/dashboard-query?workflow=results&pageSize=25")).id, "staffDashboardQuery");
  assertEquals(matchRoute(request(`/attempts/${ATTEMPT}/print-summary`)).id, "printSummary");
});
Deno.test("fixed self-directed practice omits caller sizing and exposes profile sizing", async () => {
  const d = deps({
    ok: true,
    examKey: "ai901",
    packageVersion: "2.0.0",
    profileKey: "ai901-controlled-beta-compact",
    purpose: "self_directed_exam",
    available: 234,
    selectedCount: 25,
    adjustedCount: false,
    profileQuestionCount: 25,
    timeLimitMinutes: 25,
    fixedProfileSize: true,
    protectedPayload: "blocked",
  });
  const response = await handleProtectedExam(
    request("/practice/availability?examKey=ai901&profileId=ai901-controlled-beta-compact&purpose=self_directed_exam&includePbqs=true&language=not_applicable"),
    d.value,
  );
  assertEquals(response.status, 200);
  assertEquals(d.calls[0].args.p_request, {
    examKey: "ai901",
    profileId: "ai901-controlled-beta-compact",
    purpose: "self_directed_exam",
    includePbqs: true,
    language: "not_applicable",
  });
  const payload = await response.json();
  assertEquals(payload.profileQuestionCount, 25);
  assertEquals(payload.timeLimitMinutes, 25);
  assertEquals(payload.fixedProfileSize, true);
  assertEquals("protectedPayload" in payload, false);
});
Deno.test("fixed and flexible practice counts have distinct Edge contracts", async () => {
  const fixedItems = Array.from({ length: 25 }, (_, index) => ({
    itemId: crypto.randomUUID(),
    questionNumber: index + 1,
    questionId: `synthetic-ai901-${index + 1}`,
    questionType: "single-choice",
    domain: "Synthetic",
    section: "Synthetic",
    response: null,
    revision: 0,
    presentation: { prompt: "Synthetic", options: [{ id: "a", text: "A" }] },
  }));
  const validFixed = deps({ ok: true, attempt: { attemptId: ATTEMPT }, items: fixedItems });
  const fixedResponse = await handleProtectedExam(request("/practice/sessions", {
    method: "POST",
    body: JSON.stringify({ examKey: "ai901", profileId: "ai901-controlled-beta-compact", purpose: "self_directed_exam", count: 25, includePbqs: true, language: "not_applicable", clientRequestId: REQUEST }),
  }), validFixed.value);
  assertEquals(fixedResponse.status, 201);
  assertEquals((validFixed.calls[0].args.p_request as Record<string, unknown>).count, 25);
  assertEquals((await fixedResponse.json()).items.length, 25);

  for (const count of [10, 20, 30, 40, "all"]) {
    const d = deps({ ok: true, available: 50, selectedCount: count === "all" ? 50 : count });
    const response = await handleProtectedExam(request(`/practice/availability?examKey=az204&profileId=compact-profile&purpose=weak_area&count=${count}&includePbqs=false&language=mixed`), d.value);
    assertEquals(response.status, 200);
  }
  for (const count of [9, 25, 41]) {
    const d = deps();
    const response = await handleProtectedExam(request(`/practice/availability?examKey=az204&profileId=compact-profile&purpose=weak_area&count=${count}&includePbqs=false&language=mixed`), d.value);
    assertEquals(response.status, 400);
    assertEquals(d.calls.length, 0);
  }
});
Deno.test("staff history derives the actor and exposes only bounded analytics metadata", async () => {
  const row = {
    attemptId: ATTEMPT,
    learnerId: "15000000-0000-4000-8000-000000000001",
    examKey: "ai901",
    packageVersion: "1.0.0",
    purpose: "self_directed_exam",
    actorClassification: "student",
    analyticsEligible: true,
    completedAt: "2026-09-01T00:00:00Z",
    percentage: 80,
    protectedPayload: "blocked",
  };
  const d = deps({ items: [row], returnedCount: 1, totalCount: 1, remainingCount: 0, nextCursor: null });
  const response = await handleProtectedExam(request("/staff/history?pageSize=25"), d.value);
  assertEquals(response.status, 200);
  assertEquals(d.calls, [{
    name: "certsim_protected_list_staff_history",
    args: { p_actor_id: ACTOR, p_cursor: null, p_page_size: 25 },
  }]);
  const payload = await response.json();
  assertEquals(payload.items[0].analyticsEligible, true);
  assertEquals(payload.items[0].actorClassification, "student");
  assertEquals("protectedPayload" in payload.items[0], false);
  assertEquals(payload.totalCount, 1);
});
Deno.test("staff history mapper preserves practice visibility without making it analytics eligible", () => {
  const mapped = mapStaffHistory({
    items: [{ attemptId: ATTEMPT, learnerId: ACTOR, purpose: "weak_area", analyticsEligible: false, source: "protected" }],
    returnedCount: 1,
    totalCount: 1,
    remainingCount: 0,
    nextCursor: null,
  });
  assertEquals((mapped.items as Record<string, unknown>[])[0].analyticsEligible, false);
});
Deno.test("public PBQ scoring labels pass while protected scoring fields fail closed", () => {
  assertNoProtectedPreReview({
    items: [{ presentation: { decisions: [{ scoringLabel: "Synthetic public label" }] } }],
  });
  for (const key of ["scoring", "scoringRules", "correctAnswer", "packageHash"]) {
    assertRejects(
      async () => assertNoProtectedPreReview({ presentation: { [key]: "blocked" } }),
      SafeError,
    );
  }
  assertNoProtectedPreReview({ result: { rawScore: 1, maxScore: 2, domainBreakdown: [{ score: 1, points: 1 }] } });
});
Deno.test("full sectioned attempt maps all presentation records including PBQs", async () => {
  const contract = [
    ...Array.from({ length: 2 }, (_, caseIndex) => ({ type: "case-study-context", section: `case-${caseIndex + 1}` })),
    ...Array.from({ length: 12 }, (_, index) => ({ type: "single-choice", section: `case-${Math.floor(index / 6) + 1}` })),
    ...Array.from({ length: 66 }, () => ({ type: "single-choice", section: "standard" })),
    ...Array.from({ length: 2 }, () => ({ type: "pbq-config-panel", section: "pbq" })),
  ];
  const items = contract.map(({ type, section }, index) => ({
    itemId: crypto.randomUUID(),
    questionNumber: index + 1,
    questionId: `synthetic-${index + 1}`,
    questionType: type,
    domain: "Synthetic domain",
    section,
    response: null,
    revision: 0,
    presentation: type === "case-study-context" || type === "pbq-config-panel"
      ? { prompt: "Synthetic", decisions: [{ scoringLabel: "Visible label" }] }
      : { question: "Synthetic", options: [{ id: "a", text: "Option" }] },
  }));
  const d = deps({
    ok: true,
    attempt: {
      attemptId: ATTEMPT,
      examKey: "az400",
      packageVersion: "1.0.0",
      profileKey: "az400-sectioned-full-exam-profile",
      status: "in_progress",
    },
    items,
  });
  const response = await handleProtectedExam(request("/attempts", {
    method: "POST",
    body: JSON.stringify({
      examKey: "az400",
      profileId: "az400-sectioned-full-exam-profile",
      clientRequestId: REQUEST,
    }),
  }), d.value);
  assertEquals(response.status, 201);
  const payload = await response.json();
  assertEquals(payload.items.length, 82);
  assertEquals(payload.items.filter((item: Record<string, unknown>) => item.questionType === "case-study-context").length, 2);
  assertEquals(payload.items.filter((item: Record<string, unknown>) => String(item.section).startsWith("case-") && item.questionType !== "case-study-context").length, 12);
  assertEquals(payload.items.filter((item: Record<string, unknown>) => item.section === "standard").length, 66);
  assertEquals(payload.items.filter((item: Record<string, unknown>) => item.questionType === "pbq-config-panel").length, 2);
  assertEquals(payload.items.filter((item: Record<string, unknown>) => item.questionNumber === null).length, 2);
  assertEquals(payload.items.filter((item: Record<string, unknown>) => typeof item.questionNumber === "number").map((item: Record<string, unknown>) => item.questionNumber), Array.from({ length: 80 }, (_, index) => index + 1));
});

Deno.test("eligibility and attempt allowlists retain immutable package binding", async () => {
  const eligibilityDeps = deps({
    eligible: true,
    reasonCode: "eligible",
    examKey: "az204",
    packageVersion: "1.0.0",
    profileKey: "full-profile",
    profileName: "Full",
    questionCount: 60,
    timeLimitMinutes: 120,
  });
  const eligibility = await handleProtectedExam(
    request("/eligibility?examKey=az204&packageVersion=1.0.0&profileId=full-profile&purpose=assigned_assessment"),
    eligibilityDeps.value,
  );
  assertEquals((await eligibility.json()).packageVersion, "1.0.0");

  const attemptDeps = deps({
    ok: true,
    attempt: {
      attemptId: ATTEMPT,
      examKey: "az204",
      packageVersion: "1.0.0",
      profileKey: "full-profile",
      status: "in_progress",
    },
    items: [],
  });
  const resumed = await handleProtectedExam(request(`/attempts/${ATTEMPT}`), attemptDeps.value);
  assertEquals((await resumed.json()).attempt.packageVersion, "1.0.0");
});

Deno.test("generic lifecycle reasons map to stable privacy-safe codes", () => {
  assertEquals(translateRpcFailure({ code: "authentication_required" }).code, "unauthenticated");
  assertEquals(translateRpcFailure({ code: "exam_disabled" }).code, "pilot_disabled");
  assertEquals(translateRpcFailure({ code: "package_unavailable" }).code, "no_published_package");
  assertEquals(translateRpcFailure({ code: "access_not_granted" }).code, "not_allowlisted");
  assertEquals(translateRpcFailure({ code: "assignment_required" }).code, "not_assigned");
  assertEquals(translateRpcFailure({ code: "invalid_response" }).code, "invalid_request");
});
