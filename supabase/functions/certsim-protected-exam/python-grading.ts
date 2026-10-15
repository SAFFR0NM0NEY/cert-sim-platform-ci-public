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
const ACTIVE_GRADING_STATES = new Set(["queued", "running", "cancel_requested"]);
const MAX_SUBMISSION_PASSES = 2;
const DIAGNOSTIC_VERSION = "certsim.python-grading.diagnostic.v1";
const MAX_DIAGNOSTIC_EVENTS = 32;
const MAX_ERROR_BODY_BYTES = 512;
const ERROR_BODY_READ_MS = 75;
// Exact codes emitted by the checked-in Modal bridge server/service contract.
const BRIDGE_ERROR_CODES = new Set([
  "not_found", "invalid_request", "service_unavailable",
  "request_authentication_failed", "grading_material_incomplete",
  "grading_failed", "execution_failed", "disposal_unconfirmed",
]);

type Obj = Record<string, unknown>;
type AdminClient = {
  rpc: (name: string, args: Obj) => PromiseLike<{ data: unknown; error: unknown }>;
};
type Environment = { get: (name: string) => string | undefined };
type DiagnosticStage = "grade_request" | "cancellation" | "reconciliation" | "finalization";
type DiagnosticCategory =
  | "HTTP_REJECTION" | "UNEXPECTED_CONTENT_TYPE" | "MALFORMED_JSON"
  | "NETWORK_FAILURE" | "EXTERNAL_ABORT" | "OWN_TIMEOUT" | "RESPONSE_CONTRACT_FAILURE"
  | "EVIDENCE_VALIDATION_FAILURE" | "EVIDENCE_PERSISTENCE_FAILURE"
  | "RECONCILIATION_FAILURE" | "TRANSPORT_RECONCILED"
  | "FINALIZATION_FAILURE";
type DiagnosticEvent = {
  version: typeof DIAGNOSTIC_VERSION;
  trace: string | null;
  stage: DiagnosticStage;
  category: DiagnosticCategory;
  httpStatus: number | null;
  upstreamCode: string;
  elapsedMs: number | null;
  ownTimeoutFired: boolean;
  pass: number | null;
  generation: number | null;
  taskOrdinal: number | null;
};
type DiagnosticSink = (event: DiagnosticEvent) => unknown;
type DiagnosticContext = {
  emit: (stage: DiagnosticStage, category: DiagnosticCategory, fields?: {
    httpStatus?: number | null;
    upstreamCode?: string;
    elapsedMs?: number | null;
    ownTimeoutFired?: boolean;
  }) => void;
  withItem: (pass: number, generation: unknown, taskOrdinal: number) => DiagnosticContext;
};

function boundedNumber(value: unknown, max: number): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= max
    ? Number(value) : null;
}

function createDiagnosticContext(
  sink: DiagnosticSink,
): DiagnosticContext {
  let remaining = MAX_DIAGNOSTIC_EVENTS;
  let trace: string | null = null;
  try { trace = crypto.randomUUID(); } catch { /* diagnostics never block grading */ }
  const base = (pass: number | null, generation: number | null, taskOrdinal: number | null): DiagnosticContext => ({
    emit: (stage, category, fields = {}) => {
      if (remaining <= 0) return;
      remaining -= 1;
      const event: DiagnosticEvent = {
        version: DIAGNOSTIC_VERSION,
        trace,
        stage,
        category,
        httpStatus: Number.isSafeInteger(fields.httpStatus) && Number(fields.httpStatus) >= 100 && Number(fields.httpStatus) <= 599
          ? Number(fields.httpStatus) : null,
        upstreamCode: BRIDGE_ERROR_CODES.has(String(fields.upstreamCode))
          ? String(fields.upstreamCode) : "UNKNOWN_UPSTREAM_CODE",
        elapsedMs: Number.isFinite(fields.elapsedMs) && Number(fields.elapsedMs) >= 0
          ? Math.min(600_000, Math.round(Number(fields.elapsedMs))) : null,
        ownTimeoutFired: fields.ownTimeoutFired === true,
        pass,
        generation,
        taskOrdinal,
      };
      try {
        const outcome = sink(event);
        if (outcome && typeof (outcome as PromiseLike<unknown>).then === "function") {
          Promise.resolve(outcome).catch(() => {});
        }
      } catch { /* diagnostics never block grading */ }
    },
    withItem: (nextPass, nextGeneration, nextOrdinal) => base(
      boundedNumber(nextPass, MAX_SUBMISSION_PASSES),
      boundedNumber(nextGeneration, 100),
      boundedNumber(nextOrdinal, 32),
    ),
  });
  return base(null, null, null);
}

function monotonicElapsed(now: () => number, started: number): number | null {
  try {
    const elapsed = now() - started;
    return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
  } catch { return null; }
}

async function readAllowlistedBridgeCode(response: Response): Promise<string> {
  if (!String(response.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json") ||
      !response.body) return "UNKNOWN_UPSTREAM_CODE";
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    reader = response.body.getReader();
    const bytes: number[] = [];
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ERROR_BODY_READ_MS);
    });
    while (bytes.length <= MAX_ERROR_BODY_BYTES) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next === null) return "UNKNOWN_UPSTREAM_CODE";
      if (next.done) {
        const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes)));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
            Object.keys(parsed).sort().join(",") !== "code,ok" || parsed.ok !== false) {
          return "UNKNOWN_UPSTREAM_CODE";
        }
        return BRIDGE_ERROR_CODES.has(parsed.code) ? parsed.code : "UNKNOWN_UPSTREAM_CODE";
      }
      if (bytes.length + next.value.byteLength > MAX_ERROR_BODY_BYTES) return "UNKNOWN_UPSTREAM_CODE";
      bytes.push(...next.value);
    }
  } catch { /* optional diagnostics only */ }
  finally {
    if (timer !== undefined) clearTimeout(timer);
    try { void reader?.cancel().catch(() => {}); } catch { /* optional diagnostics only */ }
  }
  return "UNKNOWN_UPSTREAM_CODE";
}

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
  diagnostic?: DiagnosticContext,
  diagnosticStage: DiagnosticStage = "grade_request",
  now: () => number = () => performance.now(),
): Promise<unknown> {
  const abort = new AbortController();
  let ownTimeoutFired = false;
  let started = Number.NaN;
  try { started = now(); } catch { /* diagnostics never block grading */ }
  const timer = setTimeout(() => {
    ownTimeoutFired = true;
    abort.abort();
  }, timeoutMs);
  let category: DiagnosticCategory | null = null;
  let httpStatus: number | null = null;
  let upstreamCode = "UNKNOWN_UPSTREAM_CODE";
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
    httpStatus = response.status;
    if (!response.ok) {
      category = "HTTP_REJECTION";
      if (diagnostic) upstreamCode = await readAllowlistedBridgeCode(response);
      throw new SafeError("grading_failed");
    }
    if (!String(response.headers.get("content-type") ?? "").startsWith("application/json")) {
      category = "UNEXPECTED_CONTENT_TYPE";
      throw new SafeError("grading_failed");
    }
    try { return await response.json(); }
    catch {
      category = ownTimeoutFired ? "OWN_TIMEOUT" : "MALFORMED_JSON";
      throw new SafeError("grading_failed");
    }
  } catch (error) {
    let errorName: unknown = null;
    try { errorName = error && typeof error === "object" && "name" in error ? error.name : null; }
    catch { /* diagnostics never change the thrown business error */ }
    diagnostic?.emit(diagnosticStage, category ?? (ownTimeoutFired ? "OWN_TIMEOUT"
      : errorName === "AbortError" || errorName === "TimeoutError" ? "EXTERNAL_ABORT" : "NETWORK_FAILURE"), {
      httpStatus, upstreamCode, elapsedMs: monotonicElapsed(now, started), ownTimeoutFired,
    });
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
  diagnostic?: DiagnosticContext,
  now?: () => number,
): Promise<Obj> {
  const envelope = await pythonExecutionContract.signRequest(request, credentials.executionSigningSecret);
  const body = await postJson(
    `${credentials.bridgeUrl}/v1/cancel`, { request, envelope }, credentials, fetchImpl, 15_000,
    diagnostic, "cancellation", now,
  );
  return pythonExecutionContract.validateBridgeResult(body, String(request.requestId).slice("request.".length));
}

async function reconcileFailedTransport(
  admin: AdminClient,
  actorId: string,
  attemptId: string,
  submissionId: string,
  item: Obj,
  request: Obj,
  requestDigest: string,
  credentials: ReturnType<typeof readTrustedEnvironment>,
  fetchImpl: typeof fetch,
  diagnostic?: DiagnosticContext,
  now?: () => number,
) {
  await rpc(admin, "certsim_service_request_python_submission_grading_cancellation", {
    p_actor_id: actorId,
    p_attempt_id: attemptId,
    p_submission_id: submissionId,
    p_item_id: item.itemId,
    p_run_id: item.runId,
    p_request_id: item.runId,
  });
  const runtimeRequest = { ...request, requestId: `request.${item.gradingSessionId}` };
  const [primary] = await Promise.all([
    cancelNamedExecution(request, credentials, fetchImpl, diagnostic, now),
    cancelNamedExecution(runtimeRequest, credentials, fetchImpl, diagnostic, now),
  ]);
  await persistTerminal(admin, String(item.runId), requestDigest, primary);
  diagnostic?.emit("reconciliation", "TRANSPORT_RECONCILED");
}

async function boundExecutionRequest(item: Obj) {
  const request = pythonExecutionContract.createRequest(
    item.workspace as Obj, String(item.executionRequestId),
  );
  const requestDigest = await pythonExecutionContract.sha256(
    pythonExecutionContract.canonicalJson(request),
  );
  return { request, requestDigest };
}

async function reconcileActiveGeneration(
  admin: AdminClient,
  actorId: string,
  attemptId: string,
  submissionId: string,
  item: Obj,
  credentials: ReturnType<typeof readTrustedEnvironment>,
  fetchImpl: typeof fetch,
  diagnostic?: DiagnosticContext,
  now?: () => number,
) {
  if (!ACTIVE_GRADING_STATES.has(String(item.state))) {
    throw new SafeError("grading_reconciliation_required");
  }
  const { request, requestDigest } = await boundExecutionRequest(item);
  if (item.executionRequestDigest !== requestDigest) {
    throw new SafeError("grading_reconciliation_required");
  }
  try {
    await reconcileFailedTransport(
      admin, actorId, attemptId, submissionId,
      item, request, requestDigest, credentials, fetchImpl, diagnostic, now,
    );
  } catch {
    diagnostic?.emit("reconciliation", "RECONCILIATION_FAILURE");
    throw new SafeError("grading_reconciliation_required");
  }
}

async function gradeItem(
  admin: AdminClient,
  actorId: string,
  attemptId: string,
  submissionId: string,
  item: Obj,
  credentials: ReturnType<typeof readTrustedEnvironment>,
  fetchImpl: typeof fetch,
  diagnostic?: DiagnosticContext,
  now?: () => number,
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
  const { request, requestDigest } = await boundExecutionRequest(item);
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
      diagnostic,
      "grade_request",
      now,
    );
  } catch {
    try {
      await reconcileFailedTransport(
        admin, actorId, attemptId, submissionId,
        item, request, requestDigest, credentials, fetchImpl, diagnostic, now,
      );
    } catch {
      diagnostic?.emit("reconciliation", "RECONCILIATION_FAILURE");
      throw new SafeError("grading_reconciliation_required");
    }
    return "reconciled" as const;
  }
  let body: Obj;
  let result: Obj;
  try {
    body = exact(responseBody, ["disposalConfirmed", "envelope", "evidence", "executionResult", "ok"]);
    if (body.ok !== true || body.disposalConfirmed !== true) throw new SafeError("grading_failed");
    result = pythonExecutionContract.validateBridgeResult({
      ok: true, result: body.executionResult, disposalConfirmed: true,
    }, String(item.executionRequestId));
  } catch (error) {
    diagnostic?.emit("grade_request", "RESPONSE_CONTRACT_FAILURE");
    throw error;
  }
  await persistTerminal(admin, String(item.runId), requestDigest, result);
  let evidence: Obj;
  try {
    evidence = await verifyEvidence(
      body.evidence, body.envelope, binding, request, result, credentials.gradingSigningSecret,
    );
  } catch (error) {
    diagnostic?.emit("grade_request", "EVIDENCE_VALIDATION_FAILURE");
    throw error;
  }
  try {
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
  } catch (error) {
    diagnostic?.emit("grade_request", "EVIDENCE_PERSISTENCE_FAILURE");
    throw error;
  }
  return "graded" as const;
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
  diagnosticSink = (event) => console.warn(JSON.stringify(event)),
  diagnosticNow = () => performance.now(),
}: {
  actorId: string;
  admin: AdminClient;
  attemptId: string;
  submissionId: string;
  env?: Environment;
  fetchImpl?: typeof fetch;
  diagnosticSink?: DiagnosticSink;
  diagnosticNow?: () => number;
}): Promise<Obj> {
  const diagnostic = createDiagnosticContext(diagnosticSink);
  let prepared = await rpc(admin, "certsim_service_prepare_python_submission_grading", {
    p_actor_id: actorId, p_attempt_id: attemptId, p_submission_id: submissionId,
  });
  let items = validateAuthority(prepared);
  if (prepared.required === true && prepared.ready !== true) {
    const credentials = readTrustedEnvironment(env);
    for (let pass = 0; pass < MAX_SUBMISSION_PASSES && prepared.ready !== true; pass += 1) {
      let recoverableGenerationFailure = false;
      await runBounded(items.filter(({ state }) => state !== "graded"), 3, async (item) => {
        const itemDiagnostic = diagnostic.withItem(pass + 1, item.attemptNumber, items.indexOf(item) + 1);
        if (item.state === "authorized") {
          const outcome = await gradeItem(
            admin, actorId, attemptId, submissionId, item, credentials, fetchImpl,
            itemDiagnostic, diagnosticNow,
          );
          if (outcome === "reconciled") recoverableGenerationFailure = true;
          return;
        }
        await reconcileActiveGeneration(
          admin, actorId, attemptId, submissionId, item, credentials, fetchImpl,
          itemDiagnostic, diagnosticNow,
        );
      });
      if (recoverableGenerationFailure && pass === MAX_SUBMISSION_PASSES - 1) {
        throw new SafeError("grading_failed");
      }
      prepared = await rpc(admin, "certsim_service_prepare_python_submission_grading", {
        p_actor_id: actorId, p_attempt_id: attemptId, p_submission_id: submissionId,
      });
      items = validateAuthority(prepared);
    }
    if (prepared.ready !== true) throw new SafeError("grading_reconciliation_required");
  }
  try {
    return await rpc(admin, "certsim_protected_submit_attempt", {
      p_actor_id: actorId, p_attempt_id: attemptId, p_submission_id: submissionId,
    });
  } catch (error) {
    diagnostic.emit("finalization", "FINALIZATION_FAILURE");
    throw error;
  }
}

// Production shared boundary. Manual orchestration still calls these exact
// implementations; internal workers never depend on test-only exports.
export const pythonGradingContract = Object.freeze({
  exact,
  readTrustedEnvironment,
  postJson,
  boundExecutionRequest,
  cancelNamedExecution,
  normalizeEvidence,
  verifyEvidence,
});
export const pythonGradingContractForTests = pythonGradingContract;
