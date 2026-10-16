import { SafeError, translateRpcFailure, type StableCode } from "./errors.ts";

export const PYTHON_EXECUTION_LIMITS = Object.freeze({
  wallTimeMs: 20_000,
  memoryBytes: 128 * 1024 * 1024,
  outputBytes: 1024 * 1024,
});

const encoder = new TextEncoder();
const REQUEST_VERSION = "certsim.python-execution.request.v1";
const RESULT_VERSION = "certsim.python-execution.result.v1";
const ENVELOPE_VERSION = "certsim.python-execution.envelope.v1";
const SIGNATURE_DOMAIN = "certsim.python-execution.request-signature.v1";
const SIGNATURE_ALGORITHM = "hmac-sha256";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const ACTIVE_STATES = new Set(["authorized", "queued", "running", "cancel_requested"]);

type Obj = Record<string, unknown>;
type AdminClient = {
  rpc: (name: string, args: Obj) => PromiseLike<{ data: unknown; error: unknown }>;
};
type Environment = { get: (name: string) => string | undefined };

function exactObject(value: unknown, keys: string[], code: StableCode = "internal_failure"): Obj {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
    throw new SafeError(code);
  }
  return value as Obj;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new SafeError("internal_failure");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") throw new SafeError("internal_failure");
  return `{${Object.keys(value as Obj).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson((value as Obj)[key])}`).join(",")}}`;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function signRequest(request: Obj, secret: string): Promise<Obj> {
  if (encoder.encode(secret).byteLength < 32) throw new SafeError("executor_disabled");
  const canonical = canonicalJson(request);
  const frame = [
    SIGNATURE_DOMAIN,
    ENVELOPE_VERSION,
    REQUEST_VERSION,
    String(encoder.encode(canonical).byteLength),
    canonical,
  ].join("\n");
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return {
    envelopeVersion: ENVELOPE_VERSION,
    algorithm: SIGNATURE_ALGORITHM,
    signature: hex(await crypto.subtle.sign("HMAC", key, encoder.encode(frame))),
  };
}

async function rpc(admin: AdminClient, name: string, args: Obj): Promise<Obj> {
  const { data, error } = await admin.rpc(name, args);
  if (error || !data || typeof data !== "object" || Array.isArray(data)) {
    throw new SafeError("internal_failure");
  }
  const value = data as Obj;
  if (value.ok === false) throw translateRpcFailure(value);
  return value;
}

function readEnvironment(env: Environment, name: string): string {
  const value = env.get(name);
  if (!value) throw new SafeError("executor_disabled");
  return value;
}

function validateWorkspaceAuthority(value: Obj, itemId: string, expectedRevision: number): Obj {
  exactObject(value, ["ok", "itemId", "exists", "revision", "workspaceHash", "workspace", "updatedAt"]);
  if (value.ok !== true || value.itemId !== itemId || value.exists !== true ||
      value.revision !== expectedRevision || typeof value.workspaceHash !== "string" ||
      !DIGEST.test(value.workspaceHash) || !value.workspace || typeof value.workspace !== "object" ||
      Array.isArray(value.workspace)) {
    throw new SafeError(value.revision !== expectedRevision ? "revision_conflict" : "internal_failure");
  }
  return value.workspace as Obj;
}

function createRequest(workspace: Obj, executionRequestId: string): Obj {
  return {
    contractVersion: REQUEST_VERSION,
    requestId: `request.${executionRequestId}`,
    runtime: { language: "python", contract: "python-source-v1" },
    workspace,
    limits: { ...PYTHON_EXECUTION_LIMITS },
  };
}

function validateBridgeResult(value: unknown, requestId: string): Obj {
  const body = exactObject(value, ["ok", "result", "disposalConfirmed"]);
  if (body.ok !== true || body.disposalConfirmed !== true) throw new SafeError("internal_failure");
  const result = exactObject(body.result, [
    "contractVersion", "executionId", "status", "stdout", "stderr",
    "exitCode", "outcome", "diagnostics",
  ]);
  const expectedExecutionId = `execution.${requestId}`;
  const statuses = new Set(["finished", "cancelled", "failed"]);
  const outcomes = new Set(["completed", "timeout", "resource_limit", "failed", "cancelled"]);
  if (result.contractVersion !== RESULT_VERSION || result.executionId !== expectedExecutionId ||
      typeof result.status !== "string" || !statuses.has(result.status) ||
      typeof result.outcome !== "string" || !outcomes.has(result.outcome) ||
      typeof result.stdout !== "string" || typeof result.stderr !== "string" ||
      !Array.isArray(result.diagnostics) || result.diagnostics.length > 8 ||
      encoder.encode(result.stdout).byteLength + encoder.encode(result.stderr).byteLength >
        PYTHON_EXECUTION_LIMITS.outputBytes) {
    throw new SafeError("internal_failure");
  }
  const stateValid =
    (result.status === "finished" && result.outcome === "completed" && result.exitCode === 0) ||
    (result.status === "finished" && result.outcome === "failed" &&
      (result.exitCode === null || Number.isSafeInteger(result.exitCode) && Number(result.exitCode) >= 1 && Number(result.exitCode) <= 255)) ||
    (result.status === "finished" && ["timeout", "resource_limit"].includes(String(result.outcome)) && result.exitCode === null) ||
    (result.status === "cancelled" && result.outcome === "cancelled" && result.exitCode === null) ||
    (result.status === "failed" && result.outcome === "failed" && result.exitCode === null);
  if (!stateValid) throw new SafeError("internal_failure");
  if (result.diagnostics.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) {
    throw new SafeError("internal_failure");
  }
  return result;
}

function databaseTerminalState(result: Obj): string {
  if (result.status === "cancelled") return "cancelled";
  return result.outcome === "completed" ? "completed" : "failed";
}

async function postBridge({
  bridgeUrl,
  envelope,
  fetchImpl,
  path,
  proxyKey,
  proxySecret,
  request,
}: {
  bridgeUrl: string;
  envelope: Obj;
  fetchImpl: typeof fetch;
  path: "/v1/execute" | "/v1/cancel";
  proxyKey: string;
  proxySecret: string;
  request: Obj;
}): Promise<unknown> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), path === "/v1/execute" ? 45_000 : 15_000);
  try {
    const response = await fetchImpl(`${bridgeUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "modal-key": proxyKey,
        "modal-secret": proxySecret,
      },
      body: JSON.stringify({ request, envelope }),
      signal: timeout.signal,
    });
    if (!response.ok || !String(response.headers.get("content-type") ?? "").startsWith("application/json")) {
      throw new SafeError("internal_failure");
    }
    return await response.json();
  } catch {
    throw new SafeError("internal_failure");
  } finally {
    clearTimeout(timer);
  }
}

async function persistTerminalResult(
  admin: AdminClient,
  runId: unknown,
  requestDigest: string,
  result: Obj,
): Promise<Obj> {
  const resultDigest = await sha256(canonicalJson(result));
  return await rpc(admin, "certsim_service_complete_python_execution", {
    p_run_id: runId,
    p_execution_request_digest: requestDigest,
    p_provider_execution_id: result.executionId,
    p_execution_result_digest: resultDigest,
    p_state: databaseTerminalState(result),
    p_terminal_outcome: result.outcome,
    p_stdout: result.stdout,
    p_stderr: result.stderr,
    p_exit_code: result.exitCode,
    p_disposal_confirmed: true,
  });
}

export async function executeProtectedPythonRun({
  actorId,
  admin,
  attemptId,
  clientRequestId,
  env = Deno.env,
  expectedRevision,
  fetchImpl = fetch,
  itemId,
  uuid = () => crypto.randomUUID(),
}: {
  actorId: string;
  admin: AdminClient;
  attemptId: string;
  clientRequestId: string;
  env?: Environment;
  expectedRevision: number;
  fetchImpl?: typeof fetch;
  itemId: string;
  uuid?: () => string;
}): Promise<Obj> {
  if (env.get("CERTSIM_PYTHON_EXECUTION_ENABLED") !== "YES") {
    throw new SafeError("executor_disabled");
  }
  const bridgeUrl = readEnvironment(env, "CERTSIM_MODAL_BRIDGE_URL");
  const proxyKey = readEnvironment(env, "CERTSIM_MODAL_PROXY_KEY");
  const proxySecret = readEnvironment(env, "CERTSIM_MODAL_PROXY_SECRET");
  const signingSecret = readEnvironment(env, "CERTSIM_EXECUTION_SIGNING_SECRET");

  const authority = await rpc(admin, "certsim_protected_get_python_workspace", {
    p_actor_id: actorId, p_attempt_id: attemptId, p_item_id: itemId,
  });
  const workspace = validateWorkspaceAuthority(authority, itemId, expectedRevision);
  const executionRequestId = uuid();
  if (!UUID.test(executionRequestId)) throw new SafeError("internal_failure");
  const request = createRequest(workspace, executionRequestId);
  const requestDigest = await sha256(canonicalJson(request));
  const envelope = await signRequest(request, signingSecret);
  const begun = await rpc(admin, "certsim_service_begin_python_execution", {
    p_actor_id: actorId,
    p_attempt_id: attemptId,
    p_item_id: itemId,
    p_expected_revision: expectedRevision,
    p_client_request_id: clientRequestId,
    p_execution_request_id: executionRequestId,
    p_execution_request_digest: requestDigest,
    p_wall_time_ms: PYTHON_EXECUTION_LIMITS.wallTimeMs,
    p_memory_bytes: PYTHON_EXECUTION_LIMITS.memoryBytes,
    p_output_bytes: PYTHON_EXECUTION_LIMITS.outputBytes,
  });
  if (begun.replayed === true || ACTIVE_STATES.has(String(begun.state)) && begun.state !== "running") {
    return await rpc(admin, "certsim_protected_get_python_run", {
      p_actor_id: actorId, p_attempt_id: attemptId, p_item_id: itemId, p_run_id: begun.runId,
    });
  }
  if (begun.replayed !== false || typeof begun.runId !== "string" ||
      begun.executionRequestId !== executionRequestId || begun.executionRequestDigest !== requestDigest) {
    throw new SafeError("internal_failure");
  }

  let responseBody: unknown;
  try {
    responseBody = await postBridge({
      bridgeUrl, envelope, fetchImpl, path: "/v1/execute", proxyKey, proxySecret, request,
    });
  } catch {
    await rpc(admin, "certsim_protected_cancel_python_run", {
      p_actor_id: actorId, p_attempt_id: attemptId, p_item_id: itemId,
      p_run_id: begun.runId, p_request_id: uuid(),
    });
    const cancelled = validateBridgeResult(await postBridge({
      bridgeUrl, envelope, fetchImpl, path: "/v1/cancel", proxyKey, proxySecret, request,
    }), executionRequestId);
    if (cancelled.status !== "cancelled") throw new SafeError("internal_failure");
    return await persistTerminalResult(admin, begun.runId, requestDigest, cancelled);
  }
  const result = validateBridgeResult(responseBody, executionRequestId);
  return await persistTerminalResult(admin, begun.runId, requestDigest, result);
}

export async function cancelProtectedPythonRun({
  actorId,
  admin,
  attemptId,
  cancelRequestId,
  env = Deno.env,
  fetchImpl = fetch,
  itemId,
  runId,
}: {
  actorId: string;
  admin: AdminClient;
  attemptId: string;
  cancelRequestId: string;
  env?: Environment;
  fetchImpl?: typeof fetch;
  itemId: string;
  runId: string;
}): Promise<Obj> {
  if (env.get("CERTSIM_PYTHON_EXECUTION_ENABLED") !== "YES") {
    throw new SafeError("executor_disabled");
  }
  const authority = await rpc(admin, "certsim_service_get_python_execution_authority", {
    p_actor_id: actorId, p_attempt_id: attemptId, p_item_id: itemId, p_run_id: runId,
  });
  if (!["authorized", "queued", "running", "cancel_requested"].includes(String(authority.state))) {
    return await rpc(admin, "certsim_protected_get_python_run", {
      p_actor_id: actorId, p_attempt_id: attemptId, p_item_id: itemId, p_run_id: runId,
    });
  }
  const executionRequestId = String(authority.executionRequestId);
  if (!UUID.test(executionRequestId) || !authority.workspace || typeof authority.workspace !== "object") {
    throw new SafeError("internal_failure");
  }
  const request = createRequest(authority.workspace as Obj, executionRequestId);
  const requestDigest = await sha256(canonicalJson(request));
  if (requestDigest !== authority.executionRequestDigest ||
      authority.wallTimeMs !== PYTHON_EXECUTION_LIMITS.wallTimeMs ||
      Number(authority.memoryBytes) !== PYTHON_EXECUTION_LIMITS.memoryBytes ||
      authority.outputBytes !== PYTHON_EXECUTION_LIMITS.outputBytes) {
    throw new SafeError("internal_failure");
  }
  const signingSecret = readEnvironment(env, "CERTSIM_EXECUTION_SIGNING_SECRET");
  const envelope = await signRequest(request, signingSecret);
  await rpc(admin, "certsim_protected_cancel_python_run", {
    p_actor_id: actorId, p_attempt_id: attemptId, p_item_id: itemId,
    p_run_id: runId, p_request_id: cancelRequestId,
  });
  const result = validateBridgeResult(await postBridge({
    bridgeUrl: readEnvironment(env, "CERTSIM_MODAL_BRIDGE_URL"),
    envelope,
    fetchImpl,
    path: "/v1/cancel",
    proxyKey: readEnvironment(env, "CERTSIM_MODAL_PROXY_KEY"),
    proxySecret: readEnvironment(env, "CERTSIM_MODAL_PROXY_SECRET"),
    request,
  }), executionRequestId);
  if (result.status !== "cancelled") throw new SafeError("internal_failure");
  return await persistTerminalResult(admin, runId, requestDigest, result);
}

export const pythonExecutionContract = Object.freeze({
  canonicalJson,
  createRequest,
  persistTerminalResult,
  sha256,
  signRequest,
  validateBridgeResult,
});
export const pythonExecutionContractForTests = pythonExecutionContract;
