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
  const result = executionResult();
  const evidence = {
    evidenceVersion: "certsim.python-grading.evidence.v1",
    evidenceId: gradingSessionId,
    gradingSessionId,
    requestId: request.requestId,
    requestDigest: binding.requestDigest,
    executionId: result.executionId,
    executionResultDigest: await pythonExecutionContractForTests.sha256(
      pythonExecutionContractForTests.canonicalJson(result),
    ),
    materializationId,
    materialDigest,
    gradingContractVersion: "certsim-python-trusted-grading-v1",
    earnedRawPoints: 4,
    maximumRawPoints: 5,
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

Deno.test("ambiguous grading transport cancels primary and deterministic runtime executions before failing", async () => {
  const { admin, calls } = adminFixture();
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
  assertEquals(cancelled, new Set([executionRequestId, gradingSessionId]));
  assertEquals(calls.filter(({ name }) => name === "certsim_service_complete_python_execution").length, 1);
  assertEquals(calls.some(({ name }) => name === "certsim_service_persist_verified_python_grading_evidence"), false);
  assertEquals(calls.some(({ name }) => name === "certsim_protected_submit_attempt"), false);
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
