import { equalCredential, emptyRequestBody } from '../certsim-expiry-worker/worker.ts';
import { pythonExecutionContract, PYTHON_EXECUTION_LIMITS } from '../certsim-protected-exam/python-execution.ts';
import { pythonGradingContract } from '../certsim-protected-exam/python-grading.ts';

import { readFenceSecret, signFenceAuthority } from '../_shared/python-fence-auth.mjs';

type Obj = Record<string, unknown>;
type Env = (name: string) => string | undefined;
export const INVOCATION_MS = 145_000;
export const DISPATCH_RESERVE_MS = 125_000;
export const START_RESERVE_MS = 133_000;
export const HEARTBEAT_MS = 10_000;
const DB_MS = 4_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function hasDispatchBudget(started: number, now: number) {
  return Number.isFinite(started) && Number.isFinite(now) && now >= started && now - started <= INVOCATION_MS - DISPATCH_RESERVE_MS;
}
export function hasStartBudget(started: number, now: number) {
  return hasDispatchBudget(started, now) && now - started <= INVOCATION_MS - START_RESERVE_MS;
}

// Each request has fresh local state. All authority/admission survives restart
// in SQL; no promise, timer or in-memory mutex owns a generation across calls.
export function createHandler(env: Env, fetcher: typeof fetch = fetch, now = () => performance.now()) {
  return async (request: Request): Promise<Response> => {
    const started = now();
    const key = env('SUPABASE_SERVICE_ROLE_KEY'), supplied = request.headers.get('apikey') ?? '';
    if (!key || key.length < 32 || supplied.length > 4096 || !await equalCredential(supplied, key)) {
      return Response.json({ code: 'unauthorized' }, { status: 401 });
    }
    if (request.method !== 'POST') return Response.json({ code: 'method_not_allowed' }, { status: 405 });
    if (new URL(request.url).search || !await emptyRequestBody(request)) return Response.json({ code: 'invalid_request' }, { status: 400 });
    const dispatchEnabled = env('CERTSIM_PYTHON_EXPIRY_WORKER_ENABLED') === 'true';
    const recoveryEnabled = env('CERTSIM_PYTHON_EXPIRY_RECOVERY_ENABLED') === 'true';
    const fencedMode = env('CERTSIM_PYTHON_EXPIRY_FENCING_ENABLED') === 'true';
    if (!dispatchEnabled && !recoveryEnabled) return Response.json({ state: 'disabled', actions: 0 });
    const url = env('SUPABASE_URL');
    if (!url || !/^https?:\/\//.test(url)) return Response.json({ state: 'unavailable', actions: 0 }, { status: 503 });
    const deadline = AbortSignal.timeout(Math.max(1, Math.ceil(INVOCATION_MS - (now() - started))));
    let recoveryAttempted = false;
    let owner: Obj | null = null, lost = false, dispatchAllowed = false, renewing = false, ownerUntil = started;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const rpc = async (name: string, args: Obj = {}): Promise<Obj> => {
      const response = await fetcher(`${url}/rest/v1/rpc/${name}`, {
        method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(args), signal: AbortSignal.any([deadline, AbortSignal.timeout(DB_MS)]),
      });
      if (!response.ok) throw Error('database_unavailable');
      const value = await response.json();
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('database_contract');
      return value;
    };
    const fixed = (operation: string, args: Obj = {}) => rpc(`certsim_service_python_worker_${operation}`, { ...owner, ...args });
    const renew = async () => {
      if (!owner || lost) return false;
      const renewalStarted = now();
      try {
        const value = await fixed('renew');
        lost = value.ok !== true;
        if (!lost) ownerUntil = renewalStarted + 30_000;
        dispatchAllowed = value.dispatchAllowed === true && env('CERTSIM_PYTHON_EXPIRY_WORKER_ENABLED') === 'true';
      } catch { lost = true; dispatchAllowed = false; }
      return !lost;
    };
    const yieldState = async (state: string, outcome: string, actions = 0) => {
      if (!lost && owner) {
        try { const result = await fixed('yield', { p_outcome: outcome }); if (result.ok !== true) lost = true; }
        catch { lost = true; }
      }
      return Response.json({ state: lost ? 'ownership_lost' : state, actions });
    };
    try {
      // Recovery is one separate finite action, never followed by grading.
      if (recoveryEnabled) {
        const secret = readFenceSecret(env);
        const recovery = await rpc('certsim_service_python_fence_recovery');
        if (recovery.state === 'legacy_unprovable') return Response.json({ state: 'legacy_recovery_blocked', actions: 0 });
        if (recovery.state === 'claimed') {
          recoveryAttempted = true;
          const credentials = { bridgeUrl: String(env('CERTSIM_MODAL_BRIDGE_URL') ?? '').replace(/\/$/, ''),
            proxyKey: String(env('CERTSIM_MODAL_PROXY_KEY') ?? ''), proxySecret: String(env('CERTSIM_MODAL_PROXY_SECRET') ?? '') };
          if (!credentials.bridgeUrl || !credentials.proxyKey || !credentials.proxySecret) throw Error('fence_config');
          const payload = { fence: recovery.fence, token: recovery.token };
          const auth = await signFenceAuthority(payload, 'recover', secret);
          const recovered = await pythonGradingContract.postJson(`${credentials.bridgeUrl}/v2/expiry-recover`,
            { recovery: payload, auth }, credentials, fetcher, Math.max(1, Math.min(25_000, 35_000 - (now() - started))));
          return Response.json({ state: (recovered as Obj)?.state === 'capacity_recovered' ? 'capacity_recovered' : 'recovery_blocked', actions: 1 });
        }
      }
      if (!dispatchEnabled) return Response.json({ state: 'disabled', actions: 0 });
      // Missing protocol configuration cannot fall through to legacy dispatch.
      if (fencedMode) readFenceSecret(env);
      const claim = await rpc('certsim_service_python_worker_claim');
      if (claim.outcome !== 'claimed') return Response.json({ state: claim.outcome === 'disabled' ? 'disabled' : 'idle', actions: 0 });
      if (!UUID.test(String(claim.attemptId)) || !UUID.test(String(claim.token))) throw Error('claim_contract');
      owner = { p_attempt_id: claim.attemptId, p_token: claim.token };
      ownerUntil = started + 30_000;
      dispatchAllowed = claim.dispatchAllowed === true;
      heartbeat = setInterval(async () => {
        if (renewing || lost) return;
        renewing = true;
        try { await renew(); } finally { renewing = false; }
      }, HEARTBEAT_MS);
      const plan = await fixed('plan');
      if (plan.ok !== true) return await yieldState('blocked', 'blocked');
      if (plan.action === 'complete') {
        const result = await fixed('complete');
        return await yieldState(result.completed === true ? 'completed' : 'pending', result.completed === true ? 'completed' : 'failure', 1);
      }
      if (plan.action === 'manual_pending') return await yieldState('manual_pending', 'deferred');
      const runArgs = { p_run_id: plan.runId };
      if (plan.action === 'receipt_replay') {
        const result = await fixed('replay', runArgs);
        return await yieldState(result.ok === true ? 'progress' : 'recovery_blocked', result.ok === true ? 'progress' : 'failure', 1);
      }
      if (plan.action === 'replace' && plan.fenced === true) return await yieldState('recovery_blocked', 'uncertain');
      if (plan.action === 'replace') {
        if (!dispatchAllowed || !await renew() || !dispatchAllowed) return await yieldState('disabled', 'deferred');
        const result = await fixed('replace', runArgs);
        return await yieldState(result.ok === true ? 'replacement_ready' : 'recovery_blocked', result.ok === true ? 'progress' : 'blocked', 1);
      }
      const item = await fixed('read', { p_item_id: plan.itemId, ...runArgs });
      if (item.ok !== true) return await yieldState('blocked', 'blocked');
      for (const field of ['itemId', 'runId', 'executionRequestId', 'materializationId', 'gradingSessionId']) {
        if (!UUID.test(String(item[field]))) return await yieldState('blocked', 'blocked');
      }
      const material = item.gradingMaterial as Obj;
      if (!material || material.contractVersion !== item.gradingContractVersion || material.maximumRawPoints !== item.maximumRawPoints
        || await pythonExecutionContract.sha256(pythonExecutionContract.canonicalJson(material)) !== item.materialDigest
        || !Number.isSafeInteger(item.workspaceRevision) || Number(item.workspaceRevision) < 1
        || item.wallTimeMs !== PYTHON_EXECUTION_LIMITS.wallTimeMs || item.memoryBytes !== PYTHON_EXECUTION_LIMITS.memoryBytes
        || item.outputBytes !== PYTHON_EXECUTION_LIMITS.outputBytes) return await yieldState('blocked', 'blocked');
      const { request: executionRequest, requestDigest } = await pythonGradingContract.boundExecutionRequest(item);
      if (item.executionRequestDigest !== null && item.executionRequestDigest !== requestDigest) return await yieldState('blocked', 'blocked');
      const credentials = pythonGradingContract.readTrustedEnvironment({ get: env });
      const binding = {
        bindingVersion: 'certsim.python-grading.binding.v1', gradingSessionId: item.gradingSessionId,
        requestId: executionRequest.requestId, requestDigest, materializationId: item.materializationId,
        materialDigest: item.materialDigest, gradingContractVersion: item.gradingContractVersion, maximumRawPoints: item.maximumRawPoints,
      };
      const reconcile = async (settled: boolean) => {
        const cancellation = await fixed('cleanup', runArgs);
        if (cancellation.ok !== true) return await yieldState('recovery_blocked', settled ? 'failure' : 'uncertain', 1);
        try {
          const [primary] = await Promise.all([
            pythonGradingContract.cancelNamedExecution(executionRequest, credentials, fetcher),
            pythonGradingContract.cancelNamedExecution({ ...executionRequest, requestId: `request.${item.gradingSessionId}` }, credentials, fetcher),
          ]);
          const result = await fixed('cleanup', { ...runArgs, p_primary: { result: primary,
            digest: await pythonExecutionContract.sha256(pythonExecutionContract.canonicalJson(primary)) } });
          return await yieldState(settled && result.ok === true ? 'reconciled' : 'recovery_blocked',
            settled && result.ok === true ? 'progress' : 'uncertain', 1);
        } catch { return await yieldState('recovery_blocked', settled ? 'failure' : 'uncertain', 1); }
      };
      if (plan.fenced === true && ['reconcile', 'replace'].includes(String(plan.action))) return await yieldState('recovery_blocked', 'uncertain');
      if (plan.action === 'reconcile') return await reconcile(plan.transportSettled === true);
      if (plan.action !== 'dispatch' || !hasDispatchBudget(started, now())) return await yieldState('yielded', 'deferred');
      if (!await renew() || !dispatchAllowed) return await yieldState('disabled', 'deferred');
      if (!hasStartBudget(started, now())) return await yieldState('yielded', 'deferred');
      const materialized = await fixed(fencedMode ? 'fenced_start' : 'start', { p_item_id: plan.itemId, ...runArgs, p_digest: requestDigest });
      if (materialized.ok !== true || materialized.claimed !== true) return await yieldState('yielded', 'deferred');
      const permit = await fixed('transport', { ...runArgs, p_settled: false });
      if (permit.ok !== true || lost || !dispatchAllowed || env('CERTSIM_PYTHON_EXPIRY_WORKER_ENABLED') !== 'true'
        || now() >= ownerUntil || !hasDispatchBudget(started, now())) return await yieldState('recovery_blocked', 'uncertain', 1);
      const fence = materialized.fence as Obj | undefined;
      if (fencedMode && (!fence || fence.requestDigest !== requestDigest || fence.primaryId !== item.executionRequestId || fence.probeId !== item.gradingSessionId)) return await yieldState('recovery_blocked', 'uncertain', 1);
      const fencedSecret = fencedMode ? readFenceSecret(env) : undefined;
      const envelope = await pythonExecutionContract.signRequest(executionRequest, fencedSecret ?? credentials.executionSigningSecret);
      const fenceAuth = fencedMode ? await signFenceAuthority({ fence }, 'grade', fencedSecret) : undefined;
      if (lost || now() >= ownerUntil || !hasDispatchBudget(started, now())) return await yieldState('recovery_blocked', 'uncertain', 1);
      let httpSettled = false, responseBody: unknown;
      // Buffer completion under the existing 90s abort signal. A full HTTP
      // response is distinguishable from aborting an outstanding transport.
      const observedFetch: typeof fetch = async (input, init) => {
        const response = await fetcher(input, { ...init, signal: AbortSignal.any([deadline, init?.signal ?? deadline]) });
        const reader = response.body?.getReader(), chunks: Uint8Array[] = [];
        let size = 0;
        if (reader) {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > 8 * 1024 * 1024) { await reader.cancel(); throw Error('response_limit'); }
            chunks.push(part.value);
          }
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        httpSettled = true;
        return new Response(bytes, { status: response.status, headers: response.headers });
      };
      let verified: { evidence: Obj; result: Obj };
      try {
        responseBody = await pythonGradingContract.postJson(`${credentials.bridgeUrl}${fencedMode ? '/v2/expiry-grade' : '/v1/grade'}`, {
          request: executionRequest, envelope, binding, gradingMaterial: material,
          ...(fencedMode ? { fence, auth: fenceAuth } : {}),
        }, credentials, observedFetch, 90_000);
      } catch {
        if (httpSettled && !lost) {
          const ack = await fixed('transport', { ...runArgs, p_settled: true });
          if (ack.ok !== true) lost = true;
        }
        if (lost) return Response.json({ state: 'ownership_lost', actions: 1 });
        if (fencedMode) return await yieldState('recovery_blocked', 'uncertain', 1);
        return await reconcile(httpSettled);
      }
      // A successful response is resolved by its verified durable receipt,
      // never by transport settlement alone. If persistence cannot reach SQL,
      // a restart must not turn potentially valid lost evidence into a regrade.
      try {
        const body = pythonGradingContract.exact(responseBody, ['disposalConfirmed', 'envelope', 'evidence', 'executionResult', 'ok']);
        if (body.ok !== true || body.disposalConfirmed !== true) throw Error('disposal_missing');
        const result = pythonExecutionContract.validateBridgeResult({ ok: true, result: body.executionResult, disposalConfirmed: true }, String(item.executionRequestId));
        const evidence = await pythonGradingContract.verifyEvidence(body.evidence, body.envelope, binding, executionRequest, result, credentials.gradingSigningSecret);
        verified = { evidence, result };
      } catch { return await yieldState('blocked', 'blocked', 1); }
      try {
        // Valid late evidence is retained even after heartbeat/token loss, with
        // no dispatch or finalization authority granted to this stale process.
        const retained = await rpc('certsim_service_python_worker_receipt', { p_run_id: item.runId, p_evidence: verified.evidence, p_result: verified.result });
        return await yieldState(retained.ok === true ? 'progress' : 'recovery_blocked', retained.ok === true ? 'progress' : 'failure', 1);
      } catch { return await yieldState('recovery_blocked', 'failure', 1); }
    } catch {
      if (recoveryAttempted) return Response.json({ state: 'recovery_blocked', actions: 1 });
      return await yieldState('unavailable', 'failure');
    } finally { if (heartbeat !== undefined) clearInterval(heartbeat); }
  };
}
