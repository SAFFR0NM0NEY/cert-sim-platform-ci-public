import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import { SafeError } from "../errors.ts";
import {
  executeProtectedPythonRun,
  pythonExecutionContractForTests,
} from "../python-execution.ts";

const actorId = "86000000-0000-4000-8000-000000000001";
const attemptId = "86000000-0000-4000-8000-000000000002";
const itemId = "86000000-0000-4000-8000-000000000003";
const clientRequestId = "86000000-0000-4000-8000-000000000004";
const executionRequestId = "86000000-0000-4000-8000-000000000005";
const runId = "86000000-0000-4000-8000-000000000006";
const signingSecret = "synthetic-edge-signing-secret-000000000000000000";
const workspace = {
  entryPoint: "main.py",
  files: [{ path: "main.py", content: "print('authoritative')\n" }],
};

function environment(overrides: Record<string, string> = {}) {
  const values = {
    CERTSIM_PYTHON_EXECUTION_ENABLED: "YES",
    CERTSIM_MODAL_BRIDGE_URL: "https://synthetic.invalid",
    CERTSIM_MODAL_PROXY_KEY: "synthetic-key",
    CERTSIM_MODAL_PROXY_SECRET: "synthetic-secret",
    CERTSIM_EXECUTION_SIGNING_SECRET: signingSecret,
    ...overrides,
  };
  return { get: (name: string) => values[name as keyof typeof values] };
}

function terminalResult() {
  return {
    contractVersion: "certsim.python-execution.result.v1",
    executionId: `execution.${executionRequestId}`,
    status: "finished",
    stdout: "authoritative\n",
    stderr: "notice\n",
    exitCode: 0,
    outcome: "completed",
    diagnostics: [],
  };
}

Deno.test("Edge constructs and signs the exact authoritative saved workspace", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let posted: Record<string, unknown> = {};
  const admin = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "certsim_protected_get_python_workspace") return { data: {
        ok: true, itemId, exists: true, revision: 7, workspaceHash: "a".repeat(64),
        workspace, updatedAt: "2026-09-15T00:00:00Z",
      }, error: null };
      if (name === "certsim_service_begin_python_execution") return { data: {
        ok: true, runId, state: "running", replayed: false,
        executionRequestId, executionRequestDigest: args.p_execution_request_digest,
        workspaceRevision: 7, workspaceHash: "a".repeat(64),
        createdAt: "2026-09-15T00:00:00Z", updatedAt: "2026-09-15T00:00:00Z",
      }, error: null };
      return { data: {
        ok: true, runId, state: "completed", terminalOutcome: "completed",
        stdout: "authoritative\n", stderr: "notice\n", exitCode: 0,
        cancellationRequestedAt: null, disposalState: "confirmed",
        createdAt: "2026-09-15T00:00:00Z", updatedAt: "2026-09-15T00:00:01Z",
      }, error: null };
    },
  };
  const result = await executeProtectedPythonRun({
    actorId, admin, attemptId, clientRequestId, env: environment(), expectedRevision: 7,
    itemId, uuid: () => executionRequestId,
    fetchImpl: async (_url, init) => {
      posted = JSON.parse(String(init?.body));
      assertEquals((init?.headers as Record<string, string>)["modal-key"], "synthetic-key");
      return new Response(JSON.stringify({ ok: true, result: terminalResult(), disposalConfirmed: true }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    },
  });
  assertEquals(result.stdout, "authoritative\n");
  assertEquals((posted.request as Record<string, unknown>).workspace, workspace);
  assertEquals("actorId" in (posted.request as Record<string, unknown>), false);
  assertEquals(calls.map(({ name }) => name), [
    "certsim_protected_get_python_workspace",
    "certsim_service_begin_python_execution",
    "certsim_service_complete_python_execution",
  ]);
  assertEquals(calls[1].args.p_expected_revision, 7);
  assertEquals(calls[1].args.p_wall_time_ms, 20_000);
  assertEquals(calls[2].args.p_provider_execution_id, `execution.${executionRequestId}`);
});

Deno.test("ambiguous client retry returns the durable run without a second bridge call", async () => {
  let fetches = 0;
  const admin = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === "certsim_protected_get_python_workspace") return { data: {
        ok: true, itemId, exists: true, revision: 7, workspaceHash: "a".repeat(64),
        workspace, updatedAt: "2026-09-15T00:00:00Z",
      }, error: null };
      if (name === "certsim_service_begin_python_execution") return { data: {
        ok: true, runId, state: "running", replayed: true,
        executionRequestId: "86000000-0000-4000-8000-000000000099",
        executionRequestDigest: String(args.p_execution_request_digest),
        workspaceRevision: 7, workspaceHash: "a".repeat(64),
        createdAt: "2026-09-15T00:00:00Z", updatedAt: "2026-09-15T00:00:00Z",
      }, error: null };
      return { data: {
        ok: true, runId, state: "running", terminalOutcome: null, stdout: "", stderr: "",
        exitCode: null, cancellationRequestedAt: null, disposalState: "not_requested",
        createdAt: "2026-09-15T00:00:00Z", updatedAt: "2026-09-15T00:00:00Z",
      }, error: null };
    },
  };
  const result = await executeProtectedPythonRun({
    actorId, admin, attemptId, clientRequestId, env: environment(), expectedRevision: 7,
    itemId, uuid: () => executionRequestId,
    fetchImpl: async () => { fetches += 1; throw new Error("must not call"); },
  });
  assertEquals(result.state, "running");
  assertEquals(fetches, 0);
});

Deno.test("feature and private proxy credentials fail closed before provider transport", async () => {
  const admin = { rpc: async () => { throw new Error("must not call"); } };
  await assertRejects(
    () => executeProtectedPythonRun({
      actorId, admin, attemptId, clientRequestId,
      env: environment({ CERTSIM_PYTHON_EXECUTION_ENABLED: "NO" }),
      expectedRevision: 7, itemId,
    }),
    SafeError,
    "executor_disabled",
  );
  await assertRejects(
    () => executeProtectedPythonRun({
      actorId, admin, attemptId, clientRequestId,
      env: { get: (name) => name === "CERTSIM_PYTHON_EXECUTION_ENABLED" ? "YES" : undefined },
      expectedRevision: 7, itemId,
    }),
    SafeError,
    "executor_disabled",
  );
});

Deno.test("Edge canonicalization is stable and signs only the R2 request", async () => {
  const request = pythonExecutionContractForTests.createRequest(workspace, executionRequestId);
  const reordered = { limits: request.limits, workspace: request.workspace, requestId: request.requestId, runtime: request.runtime, contractVersion: request.contractVersion };
  assertEquals(
    pythonExecutionContractForTests.canonicalJson(request),
    pythonExecutionContractForTests.canonicalJson(reordered),
  );
  const envelope = await pythonExecutionContractForTests.signRequest(request, signingSecret);
  assertEquals(envelope.algorithm, "hmac-sha256");
});
