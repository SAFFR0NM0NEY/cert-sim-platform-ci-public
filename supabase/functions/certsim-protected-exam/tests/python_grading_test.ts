import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import { SafeError } from "../errors.ts";
import { submitProtectedAttemptWithPythonGrading } from "../python-grading.ts";
import { pythonExecutionContractForTests } from "../python-execution.ts";

const actorId = "86100000-0000-4000-8000-000000000001";
const attemptId = "86100000-0000-4000-8000-000000000002";
const itemId = "86100000-0000-4000-8000-000000000003";
const runId = "86100000-0000-4000-8000-000000000004";
const executionRequestId = "86100000-0000-4000-8000-000000000005";
const materializationId = "86100000-0000-4000-8000-000000000006";
const gradingSessionId = "86100000-0000-4000-8000-000000000007";
const submissionId = "86100000-0000-4000-8000-000000000008";
const stuckRunId = "86100000-0000-4000-8000-000000000009";
const stuckExecutionRequestId = "86100000-0000-4000-8000-000000000010";
const stuckMaterializationId = "86100000-0000-4000-8000-000000000011";
const stuckGradingSessionId = "86100000-0000-4000-8000-000000000012";
const alreadyGradedItemId = "86100000-0000-4000-8000-000000000013";
const executionSecret = "synthetic-execution-secret-00000000000000000001";
const gradingSecret = "synthetic-grading-secret-000000000000000000002";
const encoder = new TextEncoder();
const workspace = {
  entryPoint: "main.py",
  files: [{ path: "main.py", content: "print('synthetic')\n" }],
};
const gradingMaterial = {
  contractVersion: "certsim-python-trusted-grading-v1",
  taskId: "synthetic-edge-grading",
  maximumRawPoints: 5,
  rules: [{
    id: "rule.synthetic",
    type: "TOKEN",
    points: 5,
    compiled: {
      contractVersion: "certsim-python-trusted-grading-v1",
      family: "token_comment",
      target: "process_records",
      anchor: "For",
      anchorOccurrence: 1,
      relation: "immediately_before_same_block",
      requiredConceptGroups: [["store", "stores"], ["record", "records"], ["batch", "output"]],
    },
  }],
};
const materialDigest = await pythonExecutionContractForTests.sha256(
  pythonExecutionContractForTests.canonicalJson(gradingMaterial),
);

type Call = { name: string; args: Record<string, unknown> };

function environment(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    CERTSIM_PYTHON_EXECUTION_ENABLED: "YES",
    CERTSIM_PYTHON_GRADING_ENABLED: "YES",
    CERTSIM_MODAL_BRIDGE_URL: "https://synthetic.invalid",
    CERTSIM_MODAL_PROXY_KEY: "synthetic-proxy-key",
    CERTSIM_MODAL_PROXY_SECRET: "synthetic-proxy-secret",
    CERTSIM_EXECUTION_SIGNING_SECRET: executionSecret,
    CERTSIM_GRADING_SIGNING_SECRET: gradingSecret,
    ...overrides,
  };
  return { get: (name: string) => values[name] };
}

function authority(ready: boolean) {
  return {
    ok: true,
    required: true,
    ready,
    completed: false,
    items: [{
      itemId,
      runId,
      state: ready ? "graded" : "authorized",
      attemptNumber: 1,
      executionRequestId,
      executionRequestDigest: null,
      workspaceRevision: 7,
      workspaceHash: "a".repeat(64),
      workspace,
      materializationId,
      gradingSessionId,
      materialDigest,
      gradingContractVersion: "certsim-python-trusted-grading-v1",
      maximumRawPoints: 5,
      gradingMaterial,
      createdAt: "2026-09-16T00:00:00Z",
    }],
  };
}

function adminFixture({ ready = false } = {}) {
  const calls: Call[] = [];
  let evidencePersisted = ready;
  const admin = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "certsim_service_prepare_python_submission_grading") {
        return { data: authority(evidencePersisted), error: null };
      }
      if (name === "certsim_service_materialize_python_submission_grading") {
        return { data: {
          ok: true, claimed: true, state: "running", runId,
          materializationId, gradingSessionId,
        }, error: null };
      }
      if (name === "certsim_service_request_python_submission_grading_cancellation") {
        return { data: { ok: true, state: "cancel_requested", disposalState: "pending" }, error: null };
      }
      if (name === "certsim_service_complete_python_execution") {
        return { data: { ok: true, runId, state: "completed" }, error: null };
      }
      if (name === "certsim_service_persist_verified_python_grading_evidence") {
        evidencePersisted = true;
        return { data: {
          ok: true, replayed: false, evidenceId: gradingSessionId,
          earnedRawPoints: 4, maximumRawPoints: 5,
        }, error: null };
      }
      if (name === "certsim_protected_submit_attempt") {
        return { data: { ok: true, result: { attemptId, rawScore: 5, maxScore: 6 } }, error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
  };
  return { admin, calls };
}

function executionResult(requestId = executionRequestId, cancelled = false) {
  return {
    contractVersion: "certsim.python-execution.result.v1",
    executionId: `execution.${requestId}`,
    status: cancelled ? "cancelled" : "finished",
    stdout: "",
    stderr: "",
    exitCode: cancelled ? null : 0,
    outcome: cancelled ? "cancelled" : "completed",
    diagnostics: [],
  };
}

async function hexHmac(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const bytes = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function gradingResponse(posted: Record<string, unknown>, invalidSignature = false) {
  const request = posted.request as Record<string, unknown>;
  const binding = posted.binding as Record<string, unknown>;
  const requestId = String(request.requestId).slice("request.".length);
  const result = executionResult(requestId);
  const evidence = {
    evidenceVersion: "certsim.python-grading.evidence.v1",
    evidenceId: binding.gradingSessionId,
    gradingSessionId: binding.gradingSessionId,
    requestId: request.requestId,
    requestDigest: binding.requestDigest,
    executionId: result.executionId,
    executionResultDigest: await pythonExecutionContractForTests.sha256(
      pythonExecutionContractForTests.canonicalJson(result),
    ),
    materializationId: binding.materializationId,
    materialDigest: binding.materialDigest,
    gradingContractVersion: binding.gradingContractVersion,
    earnedRawPoints: 4,
    maximumRawPoints: binding.maximumRawPoints,
    rules: [{ ruleId: "rule.synthetic", earnedRawPoints: 4, maximumRawPoints: 5 }],
  };
  const canonical = pythonExecutionContractForTests.canonicalJson(evidence);
  const frame = [
    "certsim.python-grading.evidence-signature.v1",
    "certsim.python-grading.evidence-envelope.v1",
    "certsim.python-grading.evidence.v1",
    String(encoder.encode(canonical).byteLength),
    canonical,
  ].join("\n");
  return {
    ok: true,
    executionResult: result,
    evidence,
    envelope: {
      envelopeVersion: "certsim.python-grading.evidence-envelope.v1",
      algorithm: "hmac-sha256",
      signature: invalidSignature ? "0".repeat(64) : await hexHmac(gradingSecret, frame),
    },
    disposalConfirmed: true,
  };
}

Deno.test("final submit freezes R2 input, verifies R4, persists R5, then invokes the generic scorer", async () => {
  const { admin, calls } = adminFixture();
  let posted: Record<string, unknown> = {};
  const result = await submitProtectedAttemptWithPythonGrading({
    actorId, admin, attemptId, submissionId, env: environment(),
    fetchImpl: (async (url, init) => {
      assertEquals(String(url), "https://synthetic.invalid/v1/grade");
      posted = JSON.parse(String(init?.body));
      const request = posted.request as Record<string, unknown>;
      assertEquals(request.workspace, workspace);
      assertEquals("gradingMaterial" in request, false);
      assertEquals("actorId" in request, false);
      assertEquals(posted.gradingMaterial, gradingMaterial);
      return new Response(JSON.stringify(await gradingResponse(posted)), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });
  assertEquals(result, { ok: true, result: { attemptId, rawScore: 5, maxScore: 6 } });
  assertEquals(calls.map(({ name }) => name), [
    "certsim_service_prepare_python_submission_grading",
    "certsim_service_materialize_python_submission_grading",
    "certsim_service_complete_python_execution",
    "certsim_service_persist_verified_python_grading_evidence",
    "certsim_service_prepare_python_submission_grading",
    "certsim_protected_submit_attempt",
  ]);
  assertEquals(calls[1].args.p_execution_request_digest, (posted.binding as Record<string, unknown>).requestDigest);
  assertEquals(calls[3].args.p_rule_points, [{ ruleId: "rule.synthetic", earnedRawPoints: 4, maximumRawPoints: 5 }]);
});

Deno.test("an invalid R4 signature persists terminal R2 state but never persists or scores evidence", async () => {
  const { admin, calls } = adminFixture();
  await assertRejects(
    () => submitProtectedAttemptWithPythonGrading({
      actorId, admin, attemptId, submissionId, env: environment(),
      fetchImpl: (async (_url, init) => {
        const posted = JSON.parse(String(init?.body));
        return new Response(JSON.stringify(await gradingResponse(posted, true)), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    }),
    SafeError,
    "grading_failed",
  );
  assertEquals(calls.some(({ name }) => name === "certsim_service_complete_python_execution"), true);
  assertEquals(calls.some(({ name }) => name === "certsim_service_persist_verified_python_grading_evidence"), false);
  assertEquals(calls.some(({ name }) => name === "certsim_protected_submit_attempt"), false);
});

Deno.test("ambiguous grading transport stops after one reconciled replacement generation", async () => {
  const replacement = {
    ...authority(false).items[0],
    runId: "86100000-0000-4000-8000-000000000018",
    executionRequestId: "86100000-0000-4000-8000-000000000019",
    materializationId: "86100000-0000-4000-8000-000000000020",
    gradingSessionId: "86100000-0000-4000-8000-000000000021",
    attemptNumber: 2,
  };
  const calls: Call[] = [];
  let preparations = 0;
  const admin = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "certsim_service_prepare_python_submission_grading") {
        preparations += 1;
        const current = preparations === 1 ? authority(false).items[0] : replacement;
        return { data: {
          ok: true, required: true, ready: false, completed: false, items: [current],
        }, error: null };
      }
      if (name === "certsim_service_materialize_python_submission_grading") {
        const current = args.p_run_id === runId ? authority(false).items[0] : replacement;
        return { data: {
          ok: true, claimed: true, state: "running", runId: current.runId,
          materializationId: current.materializationId,
          gradingSessionId: current.gradingSessionId,
        }, error: null };
      }
      if (name === "certsim_service_request_python_submission_grading_cancellation") {
        return { data: { ok: true, state: "cancel_requested", disposalState: "pending" }, error: null };
      }
      if (name === "certsim_service_complete_python_execution") {
        return { data: { ok: true, runId: args.p_run_id, state: args.p_state }, error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
  };
  const cancelled = new Set<string>();
  await assertRejects(
    () => submitProtectedAttemptWithPythonGrading({
      actorId, admin, attemptId, submissionId, env: environment(),
      fetchImpl: (async (url, init) => {
        if (String(url).endsWith("/v1/grade")) throw new Error("synthetic transport loss");
        const posted = JSON.parse(String(init?.body));
        const requestId = String(posted.request.requestId).slice("request.".length);
        cancelled.add(requestId);
        return new Response(JSON.stringify({
          ok: true, result: executionResult(requestId, true), disposalConfirmed: true,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    }),
    SafeError,
    "grading_failed",
  );
  assertEquals(cancelled, new Set([
    executionRequestId, gradingSessionId,
    replacement.executionRequestId, replacement.gradingSessionId,
  ]));
  assertEquals(preparations, 2);
  assertEquals(calls.filter(({ name }) => name === "certsim_service_complete_python_execution").length, 2);
  assertEquals(calls.some(({ name }) => name === "certsim_service_persist_verified_python_grading_evidence"), false);
  assertEquals(calls.some(({ name }) => name === "certsim_protected_submit_attempt"), false);
});

Deno.test("fresh two-workspace submit replaces one reconciled live provider failure in the same invocation", async () => {
  const itemAId = "86200000-0000-4000-8000-000000000001";
  const itemBId = "86200000-0000-4000-8000-000000000002";
  const runA = "86200000-0000-4000-8000-000000000003";
  const runB1 = "86200000-0000-4000-8000-000000000004";
  const runB2 = "86200000-0000-4000-8000-000000000005";
  const requestA = "86200000-0000-4000-8000-000000000006";
  const requestB1 = "86200000-0000-4000-8000-000000000007";
  const requestB2 = "86200000-0000-4000-8000-000000000008";
  const materializationA = "86200000-0000-4000-8000-000000000009";
  const materializationB1 = "86200000-0000-4000-8000-000000000010";
  const materializationB2 = "86200000-0000-4000-8000-000000000011";
  const sessionA = "86200000-0000-4000-8000-000000000012";
  const sessionB1 = "86200000-0000-4000-8000-000000000013";
  const sessionB2 = "86200000-0000-4000-8000-000000000014";
  const baseItem = authority(false).items[0];
  const itemA = {
    ...baseItem, itemId: itemAId, runId: runA, executionRequestId: requestA,
    materializationId: materializationA, gradingSessionId: sessionA,
  };
  const itemB1 = {
    ...baseItem, itemId: itemBId, runId: runB1, executionRequestId: requestB1,
    materializationId: materializationB1, gradingSessionId: sessionB1,
  };
  const itemB2 = {
    ...itemB1, runId: runB2, executionRequestId: requestB2,
    materializationId: materializationB2, gradingSessionId: sessionB2,
    attemptNumber: 2,
  };
  const prepared = (ready: boolean, items: Record<string, unknown>[]) => ({
    ok: true, required: true, ready, completed: false, items,
  });
  const byRun = new Map([
    [runA, itemA], [runB1, itemB1], [runB2, itemB2],
  ]);
  const calls: Call[] = [];
  const evidenceRuns = new Set<string>();
  const cancellationRuns = new Set<string>();
  let preparations = 0;
  let failedGenerationReconciled = false;
  const admin = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "certsim_service_prepare_python_submission_grading") {
        preparations += 1;
        if (preparations === 1) return { data: prepared(false, [itemA, itemB1]), error: null };
        if (preparations === 2) {
          assertEquals(failedGenerationReconciled, true);
          assertEquals(evidenceRuns, new Set([runA]));
          return { data: prepared(false, [{ ...itemA, state: "graded" }, itemB2]), error: null };
        }
        assertEquals(preparations, 3);
        assertEquals(evidenceRuns, new Set([runA, runB2]));
        return {
          data: prepared(true, [
            { ...itemA, state: "graded" }, { ...itemB2, state: "graded" },
          ]),
          error: null,
        };
      }
      if (name === "certsim_service_materialize_python_submission_grading") {
        const current = byRun.get(String(args.p_run_id));
        if (!current) throw new Error("unexpected grading run");
        return { data: {
          ok: true, claimed: true, state: "running", runId: current.runId,
          materializationId: current.materializationId,
          gradingSessionId: current.gradingSessionId,
        }, error: null };
      }
      if (name === "certsim_service_request_python_submission_grading_cancellation") {
        cancellationRuns.add(String(args.p_run_id));
        return { data: { ok: true, state: "cancel_requested", disposalState: "pending" }, error: null };
      }
      if (name === "certsim_service_complete_python_execution") {
        if (args.p_run_id === runB1) {
          assertEquals(args.p_state, "cancelled");
          assertEquals(args.p_disposal_confirmed, true);
          failedGenerationReconciled = true;
        }
        return { data: { ok: true, runId: args.p_run_id, state: args.p_state }, error: null };
      }
      if (name === "certsim_service_persist_verified_python_grading_evidence") {
        const persistedRun = String(args.p_run_id);
        assertEquals(evidenceRuns.has(persistedRun), false);
        evidenceRuns.add(persistedRun);
        return { data: {
          ok: true, replayed: false, evidenceId: args.p_evidence_id,
          earnedRawPoints: 4, maximumRawPoints: 5,
        }, error: null };
      }
      if (name === "certsim_protected_submit_attempt") {
        assertEquals(evidenceRuns, new Set([runA, runB2]));
        return { data: { ok: true, result: { attemptId, rawScore: 8, maxScore: 10 } }, error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
  };
  const gradingRequests: string[] = [];
  const cancelled = new Set<string>();
  const result = await submitProtectedAttemptWithPythonGrading({
    actorId, admin, attemptId, submissionId, env: environment(),
    fetchImpl: (async (url, init) => {
      const posted = JSON.parse(String(init?.body));
      const currentRequestId = String(posted.request.requestId).slice("request.".length);
      if (String(url).endsWith("/v1/cancel")) {
        cancelled.add(currentRequestId);
        return new Response(JSON.stringify({
          ok: true, result: executionResult(currentRequestId, true), disposalConfirmed: true,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      gradingRequests.push(currentRequestId);
      if (currentRequestId === requestB1) {
        return new Response(JSON.stringify({
          code: "learner_nonzero_exit", outcome: "failed", exitCode: 137,
        }), { status: 503, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify(await gradingResponse(posted)), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });

  assertEquals(result, { ok: true, result: { attemptId, rawScore: 8, maxScore: 10 } });
  assertEquals(preparations, 3);
  assertEquals(gradingRequests.filter((id) => id === requestA).length, 1);
  assertEquals(gradingRequests.filter((id) => id === requestB1).length, 1);
  assertEquals(gradingRequests.filter((id) => id === requestB2).length, 1);
  assertEquals(cancellationRuns, new Set([runB1]));
  assertEquals(cancelled, new Set([requestB1, sessionB1]));
  assertEquals(calls.filter(({ name }) =>
    name === "certsim_service_persist_verified_python_grading_evidence").length, 2);
  assertEquals(calls.filter(({ name }) => name === "certsim_protected_submit_attempt").length, 1);
});

Deno.test("invalid grading material remains terminal without provider or scorer work", async () => {
  const calls: Call[] = [];
  let fetches = 0;
  const invalidItem = {
    ...authority(false).items[0],
    gradingMaterial: { ...gradingMaterial, maximumRawPoints: 6 },
  };
  const admin = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "certsim_service_prepare_python_submission_grading") {
        return { data: {
          ok: true, required: true, ready: false, completed: false, items: [invalidItem],
        }, error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
  };
  await assertRejects(
    () => submitProtectedAttemptWithPythonGrading({
      actorId, admin, attemptId, submissionId, env: environment(),
      fetchImpl: (async () => {
        fetches += 1;
        throw new Error("must not call provider");
      }) as typeof fetch,
    }),
    SafeError,
    "grading_failed",
  );
  assertEquals(fetches, 0);
  assertEquals(calls.map(({ name }) => name), [
    "certsim_service_prepare_python_submission_grading",
  ]);
});

Deno.test("grading binding mismatch remains terminal without retry or scorer work", async () => {
  const fixture = adminFixture();
  let fetches = 0;
  const admin = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === "certsim_service_materialize_python_submission_grading") {
        fixture.calls.push({ name, args });
        return { data: { ok: false, code: "grading_binding_mismatch" }, error: null };
      }
      return await fixture.admin.rpc(name, args);
    },
  };
  await assertRejects(
    () => submitProtectedAttemptWithPythonGrading({
      actorId, admin, attemptId, submissionId, env: environment(),
      fetchImpl: (async () => {
        fetches += 1;
        throw new Error("must not call provider");
      }) as typeof fetch,
    }),
    SafeError,
    "grading_binding_mismatch",
  );
  assertEquals(fetches, 0);
  assertEquals(fixture.calls.some(({ name }) =>
    name === "certsim_service_persist_verified_python_grading_evidence"), false);
  assertEquals(fixture.calls.some(({ name }) => name === "certsim_protected_submit_attempt"), false);
});

Deno.test("same frozen submission reconciles one stranded generation and reuses existing evidence", async () => {
  const calls: Call[] = [];
  let preparations = 0;
  let replacementEvidencePersisted = false;
  let strandedTerminal = false;
  const stuckRequest = pythonExecutionContractForTests.createRequest(workspace, stuckExecutionRequestId);
  const stuckRequestDigest = await pythonExecutionContractForTests.sha256(
    pythonExecutionContractForTests.canonicalJson(stuckRequest),
  );
  const gradedItem = {
    ...authority(true).items[0],
    itemId: alreadyGradedItemId,
    runId: "86100000-0000-4000-8000-000000000014",
    executionRequestId: "86100000-0000-4000-8000-000000000015",
    materializationId: "86100000-0000-4000-8000-000000000016",
    gradingSessionId: "86100000-0000-4000-8000-000000000017",
  };
  const strandedItem = {
    ...authority(false).items[0],
    runId: stuckRunId,
    executionRequestId: stuckExecutionRequestId,
    executionRequestDigest: stuckRequestDigest,
    materializationId: stuckMaterializationId,
    gradingSessionId: stuckGradingSessionId,
    state: "running",
  };
  const replacementItem = { ...authority(false).items[0], attemptNumber: 2 };
  const prepared = (ready: boolean, current: Record<string, unknown>) => ({
    ok: true,
    required: true,
    ready,
    completed: false,
    items: [current, gradedItem],
  });
  const admin = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "certsim_service_prepare_python_submission_grading") {
        preparations += 1;
        if (preparations === 1) return { data: prepared(false, strandedItem), error: null };
        if (!replacementEvidencePersisted) {
          assertEquals(strandedTerminal, true);
          return { data: prepared(false, replacementItem), error: null };
        }
        return { data: prepared(true, { ...replacementItem, state: "graded" }), error: null };
      }
      if (name === "certsim_service_materialize_python_submission_grading") {
        return { data: {
          ok: true, claimed: true, state: "running", runId,
          materializationId, gradingSessionId,
        }, error: null };
      }
      if (name === "certsim_service_request_python_submission_grading_cancellation") {
        assertEquals(args.p_request_id, args.p_run_id);
        return { data: { ok: true, state: "cancel_requested", disposalState: "pending" }, error: null };
      }
      if (name === "certsim_service_complete_python_execution") {
        if (args.p_run_id === stuckRunId) strandedTerminal = true;
        return { data: { ok: true, runId: args.p_run_id, state: args.p_state }, error: null };
      }
      if (name === "certsim_service_persist_verified_python_grading_evidence") {
        replacementEvidencePersisted = true;
        return { data: {
          ok: true, replayed: false, evidenceId: gradingSessionId,
          earnedRawPoints: 4, maximumRawPoints: 5,
        }, error: null };
      }
      if (name === "certsim_protected_submit_attempt") {
        return { data: { ok: true, result: { attemptId, rawScore: 5, maxScore: 6 } }, error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
  };
  const cancelled = new Set<string>();
  let gradingCalls = 0;
  const result = await submitProtectedAttemptWithPythonGrading({
    actorId, admin, attemptId, submissionId, env: environment(),
    fetchImpl: (async (url, init) => {
      const posted = JSON.parse(String(init?.body));
      if (String(url).endsWith("/v1/cancel")) {
        const requestId = String(posted.request.requestId).slice("request.".length);
        cancelled.add(requestId);
        return new Response(JSON.stringify({
          ok: true, result: executionResult(requestId, true), disposalConfirmed: true,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      gradingCalls += 1;
      return new Response(JSON.stringify(await gradingResponse(posted)), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });
  assertEquals(result, { ok: true, result: { attemptId, rawScore: 5, maxScore: 6 } });
  assertEquals(cancelled, new Set([stuckExecutionRequestId, stuckGradingSessionId]));
  assertEquals(gradingCalls, 1);
  assertEquals(preparations, 3);
  assertEquals(calls.filter(({ name }) =>
    name === "certsim_service_persist_verified_python_grading_evidence").length, 1);
  assertEquals(calls.filter(({ name }) => name === "certsim_protected_submit_attempt").length, 1);
  assertEquals(calls.filter(({ name }) =>
    name === "certsim_service_materialize_python_submission_grading").length, 1);
  assertEquals(calls.filter(({ name }) =>
    name === "certsim_service_prepare_python_submission_grading").every(({ args }) =>
      args.p_submission_id === submissionId), true);
});

Deno.test("ready submission replay requires no provider credentials or resource call", async () => {
  const { admin, calls } = adminFixture({ ready: true });
  let fetches = 0;
  const result = await submitProtectedAttemptWithPythonGrading({
    actorId, admin, attemptId, submissionId,
    env: { get: () => undefined },
    fetchImpl: (async () => { fetches += 1; throw new Error("must not call"); }) as typeof fetch,
  });
  assertEquals(result, { ok: true, result: { attemptId, rawScore: 5, maxScore: 6 } });
  assertEquals(fetches, 0);
  assertEquals(calls.map(({ name }) => name), [
    "certsim_service_prepare_python_submission_grading",
    "certsim_protected_submit_attempt",
  ]);
});
