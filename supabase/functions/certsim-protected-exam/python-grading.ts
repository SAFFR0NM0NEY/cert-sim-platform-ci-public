import { SafeError, translateRpcFailure } from "./errors.ts";
import {
  PYTHON_EXECUTION_LIMITS,
  pythonExecutionContract,
} from "./python-execution.ts";

const encoder = new TextEncoder();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const EXECUTION_RESULT_VERSION = "certsim.python-execution.result.v1";
const GRADING_BINDING_VERSION = "certsim.python-grading.binding.v1";
const GRADING_EVIDENCE_VERSION = "certsim.python-grading.evidence.v1";
const GRADING_ENVELOPE_VERSION = "certsim.python-grading.evidence-envelope.v1";
const GRADING_SIGNATURE_DOMAIN = "certsim.python-grading.evidence-signature.v1";
const HMAC = "hmac-sha256";

type Obj = Record<string, unknown>;
type AdminClient = {
  rpc: (name: string, args: Obj) => PromiseLike<{ data: unknown; error: unknown }>;
};
type Environment = { get: (name: string) => string | undefined };

function exact(value: unknown, keys: string[], code: "grading_failed" | "internal_failure" = "grading_failed"): Obj {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
    throw new SafeError(code);
  }
  return value as Obj;
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

function environmentValue(env: Environment, name: string): string {
  const value = env.get(name);
  if (!value) throw new SafeError("executor_disabled");
  return value;
}

function readTrustedEnvironment(env: Environment) {
  if (env.get("CERTSIM_PYTHON_EXECUTION_ENABLED") !== "YES" ||
      env.get("CERTSIM_PYTHON_GRADING_ENABLED") !== "YES") {
    throw new SafeError("executor_disabled");
  }
  const executionSigningSecret = environmentValue(env, "CERTSIM_EXECUTION_SIGNING_SECRET");
  const gradingSigningSecret = environmentValue(env, "CERTSIM_GRADING_SIGNING_SECRET");
  const proxyKey = environmentValue(env, "CERTSIM_MODAL_PROXY_KEY");
  const proxySecret = environmentValue(env, "CERTSIM_MODAL_PROXY_SECRET");
  if (encoder.encode(executionSigningSecret).byteLength < 32 ||
      encoder.encode(gradingSigningSecret).byteLength < 32 ||
      gradingSigningSecret === executionSigningSecret || gradingSigningSecret === proxyKey ||
      gradingSigningSecret === proxySecret) {
    throw new SafeError("executor_disabled");
  }
  return {
    bridgeUrl: environmentValue(env, "CERTSIM_MODAL_BRIDGE_URL").replace(/\/$/, ""),
    executionSigningSecret,
    gradingSigningSecret,
    proxyKey,
    proxySecret,
  };
}

function fromHex(value: string): ArrayBuffer {
  if (!DIGEST.test(value)) throw new SafeError("grading_failed");
  return Uint8Array.from(
    value.match(/../g) ?? [],
    (byte) => Number.parseInt(byte, 16),
  ).buffer;
}

async function postJson(
  url: string,
  payload: Obj,
  credentials: { proxyKey: string; proxySecret: string },
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<unknown> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "modal-key": credentials.proxyKey,
        "modal-secret": credentials.proxySecret,
      },
      body: JSON.stringify(payload),
      signal: abort.signal,
    });
    if (!response.ok || !String(response.headers.get("content-type") ?? "").startsWith("application/json")) {
      throw new SafeError("grading_failed");
    }
    return await response.json();
  } catch (error) {
    if (error instanceof SafeError) throw error;
    throw new SafeError("grading_failed");
  } finally {
    clearTimeout(timer);
  }
}

function validateAuthority(value: unknown): Obj[] {
  const authority = exact(value, ["completed", "items", "ok", "ready", "required"], "internal_failure");
  if (authority.ok !== true || typeof authority.required !== "boolean" ||
      typeof authority.ready !== "boolean" || typeof authority.completed !== "boolean" ||
      !Array.isArray(authority.items) || authority.items.length > 32) {
    throw new SafeError("internal_failure");
  }
  return authority.items.map((entry) => {
    const item = exact(entry, [
      "attemptNumber", "createdAt", "executionRequestDigest", "executionRequestId",
      "gradingContractVersion", "gradingMaterial", "gradingSessionId", "itemId",
      "materialDigest", "materializationId", "maximumRawPoints", "runId", "state",
      "workspace", "workspaceHash", "workspaceRevision",
    ], "internal_failure");
    for (const key of ["itemId", "runId", "executionRequestId", "gradingSessionId", "materializationId"]) {
      if (typeof item[key] !== "string" || !UUID.test(String(item[key]))) throw new SafeError("internal_failure");
    }
    if (!DIGEST.test(String(item.workspaceHash)) || !DIGEST.test(String(item.materialDigest)) ||
        !Number.isSafeInteger(item.workspaceRevision) || Number(item.workspaceRevision) < 1 ||
        !Number.isSafeInteger(item.maximumRawPoints) || Number(item.maximumRawPoints) < 1 ||
        !item.workspace || typeof item.workspace !== "object" || Array.isArray(item.workspace) ||
        !item.gradingMaterial || typeof item.gradingMaterial !== "object" || Array.isArray(item.gradingMaterial)) {
      throw new SafeError("internal_failure");
    }
    if (item.executionRequestDigest !== null && !DIGEST.test(String(item.executionRequestDigest))) {
      throw new SafeError("internal_failure");
    }
    return item;
  });
}

function databaseState(result: Obj): string {
  if (result.status === "cancelled") return "cancelled";
  return result.outcome === "completed" ? "completed" : "failed";
}

async function persistTerminal(admin: AdminClient, runId: string, requestDigest: string, result: Obj) {
  const resultDigest = await pythonExecutionContract.sha256(pythonExecutionContract.canonicalJson(result));
  return await rpc(admin, "certsim_service_complete_python_execution", {
    p_run_id: runId,
    p_execution_request_digest: requestDigest,
    p_provider_execution_id: result.executionId,
    p_execution_result_digest: resultDigest,
    p_state: databaseState(result),
    p_terminal_outcome: result.outcome,
    p_stdout: result.stdout,
    p_stderr: result.stderr,
    p_exit_code: result.exitCode,
    p_disposal_confirmed: true,
  });
}

function normalizeEvidence(value: unknown, binding: Obj, request: Obj, result: Obj): Obj {
  const evidence = exact(value, [
    "earnedRawPoints", "evidenceId", "evidenceVersion", "executionId",
    "executionResultDigest", "gradingContractVersion", "gradingSessionId",
    "materialDigest", "materializationId", "maximumRawPoints", "requestDigest",
    "requestId", "rules",
  ]);
  if (evidence.evidenceVersion !== GRADING_EVIDENCE_VERSION ||
      evidence.evidenceId !== binding.gradingSessionId ||
      evidence.gradingSessionId !== binding.gradingSessionId ||
      evidence.requestId !== request.requestId || evidence.requestDigest !== binding.requestDigest ||
      evidence.executionId !== result.executionId ||
      evidence.materializationId !== binding.materializationId ||
      evidence.materialDigest !== binding.materialDigest ||
      evidence.gradingContractVersion !== binding.gradingContractVersion ||
      evidence.maximumRawPoints !== binding.maximumRawPoints ||
      !DIGEST.test(String(evidence.executionResultDigest)) || !Array.isArray(evidence.rules) ||
      evidence.rules.length < 1 || evidence.rules.length > 128 ||
      !Number.isSafeInteger(evidence.earnedRawPoints) || Number(evidence.earnedRawPoints) < 0 ||
      Number(evidence.earnedRawPoints) > Number(evidence.maximumRawPoints)) {
    throw new SafeError("grading_failed");
  }
  const rules = evidence.rules.map((entry) => {
    const rule = exact(entry, ["earnedRawPoints", "maximumRawPoints", "ruleId"]);
    if (typeof rule.ruleId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(rule.ruleId) ||
        !Number.isSafeInteger(rule.earnedRawPoints) || !Number.isSafeInteger(rule.maximumRawPoints) ||
        Number(rule.maximumRawPoints) < 1 || Number(rule.earnedRawPoints) < 0 ||
        Number(rule.earnedRawPoints) > Number(rule.maximumRawPoints)) throw new SafeError("grading_failed");
    return { ruleId: rule.ruleId, earnedRawPoints: rule.earnedRawPoints, maximumRawPoints: rule.maximumRawPoints };
  }).sort((left, right) => String(left.ruleId) < String(right.ruleId) ? -1 : String(left.ruleId) > String(right.ruleId) ? 1 : 0);
  if (new Set(rules.map(({ ruleId }) => ruleId)).size !== rules.length ||
      rules.reduce((sum, rule) => sum + Number(rule.earnedRawPoints), 0) !== evidence.earnedRawPoints ||
      rules.reduce((sum, rule) => sum + Number(rule.maximumRawPoints), 0) !== evidence.maximumRawPoints) {
    throw new SafeError("grading_failed");
  }
  return { ...evidence, rules };
}

async function verifyEvidence(
  evidenceValue: unknown,
  envelopeValue: unknown,
  binding: Obj,
  request: Obj,
  result: Obj,
  gradingSecret: string,
): Promise<Obj> {
  const evidence = normalizeEvidence(evidenceValue, binding, request, result);
  const expectedResultDigest = await pythonExecutionContract.sha256(
    pythonExecutionContract.canonicalJson(result),
  );
  if (evidence.executionResultDigest !== expectedResultDigest) throw new SafeError("grading_failed");
  const envelope = exact(envelopeValue, ["algorithm", "envelopeVersion", "signature"]);
  if (envelope.algorithm !== HMAC || envelope.envelopeVersion !== GRADING_ENVELOPE_VERSION ||
      typeof envelope.signature !== "string" || !DIGEST.test(envelope.signature)) {
    throw new SafeError("grading_failed");
  }
  const canonical = pythonExecutionContract.canonicalJson(evidence);
  const frame = [
    GRADING_SIGNATURE_DOMAIN,
    GRADING_ENVELOPE_VERSION,
    GRADING_EVIDENCE_VERSION,
    String(encoder.encode(canonical).byteLength),
    canonical,
  ].join("\n");
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(gradingSecret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"],
  );
  if (!await crypto.subtle.verify("HMAC", key, fromHex(envelope.signature), encoder.encode(frame))) {
    throw new SafeError("grading_failed");
  }
  return evidence;
}

async function cancelNamedExecution(
  request: Obj,
  credentials: ReturnType<typeof readTrustedEnvironment>,
  fetchImpl: typeof fetch,
): Promise<Obj> {
  const envelope = await pythonExecutionContract.signRequest(request, credentials.executionSigningSecret);
  const body = await postJson(
    `${credentials.bridgeUrl}/v1/cancel`, { request, envelope }, credentials, fetchImpl, 15_000,
  );
  return pythonExecutionContract.validateBridgeResult(body, String(request.requestId).slice("request.".length));
}

async function reconcileFailedTransport(
  admin: AdminClient,
  item: Obj,
  request: Obj,
  requestDigest: string,
  credentials: ReturnType<typeof readTrustedEnvironment>,
  fetchImpl: typeof fetch,
) {
  const runtimeRequest = { ...request, requestId: `request.${item.gradingSessionId}` };
  const [primary] = await Promise.all([
    cancelNamedExecution(request, credentials, fetchImpl),
    cancelNamedExecution(runtimeRequest, credentials, fetchImpl),
  ]);
  await persistTerminal(admin, String(item.runId), requestDigest, primary);
}

async function gradeItem(
  admin: AdminClient,
  actorId: string,
  attemptId: string,
  submissionId: string,
  item: Obj,
  credentials: ReturnType<typeof readTrustedEnvironment>,
  fetchImpl: typeof fetch,
) {
  if (item.state === "graded") return;
  if (item.state !== "authorized" || item.executionRequestDigest !== null) {
    throw new SafeError("grading_reconciliation_required");
  }
  const materialDigest = await pythonExecutionContract.sha256(
    pythonExecutionContract.canonicalJson(item.gradingMaterial),
  );
  if (materialDigest !== item.materialDigest ||
      (item.gradingMaterial as Obj).contractVersion !== item.gradingContractVersion ||
      (item.gradingMaterial as Obj).maximumRawPoints !== item.maximumRawPoints) {
    throw new SafeError("grading_failed");
  }
  const request = pythonExecutionContract.createRequest(
    item.workspace as Obj, String(item.executionRequestId),
  );
  const requestDigest = await pythonExecutionContract.sha256(
    pythonExecutionContract.canonicalJson(request),
  );
  const materialized = await rpc(admin, "certsim_service_materialize_python_submission_grading", {
    p_actor_id: actorId,
    p_attempt_id: attemptId,
    p_submission_id: submissionId,
    p_item_id: item.itemId,
    p_run_id: item.runId,
    p_execution_request_digest: requestDigest,
  });
  if (materialized.claimed !== true) throw new SafeError("grading_reconciliation_required");
  const binding: Obj = {
    bindingVersion: GRADING_BINDING_VERSION,
    gradingSessionId: item.gradingSessionId,
    requestId: request.requestId,
    requestDigest,
    materializationId: item.materializationId,
    materialDigest: item.materialDigest,
    gradingContractVersion: item.gradingContractVersion,
    maximumRawPoints: item.maximumRawPoints,
  };
  const envelope = await pythonExecutionContract.signRequest(request, credentials.executionSigningSecret);
  let responseBody: unknown;
  try {
    responseBody = await postJson(
      `${credentials.bridgeUrl}/v1/grade`,
      { request, envelope, binding, gradingMaterial: item.gradingMaterial },
      credentials,
      fetchImpl,
      90_000,
    );
  } catch {
    try {
      await reconcileFailedTransport(admin, item, request, requestDigest, credentials, fetchImpl);
    } catch {
      throw new SafeError("grading_reconciliation_required");
    }
    throw new SafeError("grading_failed");
  }
  const body = exact(responseBody, ["disposalConfirmed", "envelope", "evidence", "executionResult", "ok"]);
  if (body.ok !== true || body.disposalConfirmed !== true) throw new SafeError("grading_failed");
  const result = pythonExecutionContract.validateBridgeResult({
    ok: true, result: body.executionResult, disposalConfirmed: true,
  }, String(item.executionRequestId));
  await persistTerminal(admin, String(item.runId), requestDigest, result);
  const evidence = await verifyEvidence(
    body.evidence, body.envelope, binding, request, result, credentials.gradingSigningSecret,
  );
  await rpc(admin, "certsim_service_persist_verified_python_grading_evidence", {
    p_evidence_id: evidence.evidenceId,
    p_run_id: item.runId,
    p_materialization_id: evidence.materializationId,
    p_grading_session_id: evidence.gradingSessionId,
    p_execution_request_digest: evidence.requestDigest,
    p_execution_result_digest: evidence.executionResultDigest,
    p_material_digest: evidence.materialDigest,
    p_grading_contract_version: evidence.gradingContractVersion,
    p_earned_raw_points: evidence.earnedRawPoints,
    p_maximum_raw_points: evidence.maximumRawPoints,
    p_rule_points: evidence.rules,
  });
}

async function runBounded(items: Obj[], limit: number, operation: (item: Obj) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await operation(item);
    }
  }));
}

export async function submitProtectedAttemptWithPythonGrading({
  actorId,
  admin,
  attemptId,
  submissionId,
  env = Deno.env,
  fetchImpl = fetch,
}: {
  actorId: string;
  admin: AdminClient;
  attemptId: string;
  submissionId: string;
  env?: Environment;
  fetchImpl?: typeof fetch;
}): Promise<Obj> {
  const prepared = await rpc(admin, "certsim_service_prepare_python_submission_grading", {
    p_actor_id: actorId, p_attempt_id: attemptId, p_submission_id: submissionId,
  });
  const items = validateAuthority(prepared);
  if (prepared.required === true && prepared.ready !== true) {
    const credentials = readTrustedEnvironment(env);
    await runBounded(items.filter(({ state }) => state !== "graded"), 3, (item) =>
      gradeItem(admin, actorId, attemptId, submissionId, item, credentials, fetchImpl));
    const reconciled = await rpc(admin, "certsim_service_prepare_python_submission_grading", {
      p_actor_id: actorId, p_attempt_id: attemptId, p_submission_id: submissionId,
    });
    validateAuthority(reconciled);
    if (reconciled.ready !== true) throw new SafeError("grading_reconciliation_required");
  }
  return await rpc(admin, "certsim_protected_submit_attempt", {
    p_actor_id: actorId, p_attempt_id: attemptId, p_submission_id: submissionId,
  });
}

export const pythonGradingContractForTests = Object.freeze({
  normalizeEvidence,
  verifyEvidence,
});
