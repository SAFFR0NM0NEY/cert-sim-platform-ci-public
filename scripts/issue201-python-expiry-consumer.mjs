import { pythonExecutionContract } from '../supabase/functions/certsim-protected-exam/python-execution.ts';
import { normalizeExecutionRequest } from '../services/python-executor/src/contract.mjs';
import { createExecutionRequestDigest } from '../services/python-grading/src/contract.mjs';
import { createTrustedGradingMaterialDigest } from '../services/python-grading/src/trusted-grading-contract.mjs';

// A separate process: stdin contains only attempt/token and control mode. No
// DBA connection, seed state, workspace, grading material, or fixture imports.
let input = '';
for await (const chunk of process.stdin) input += chunk;
const { attemptId, token, mode = 'materialize' } = JSON.parse(input);
const api = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!api || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(api).hostname)) throw Error('LOOPBACK_REQUIRED');
let stage = 'TRANSPORT';
const check = (condition, label) => { stage = label; if (!condition) throw Error(label); };
async function rpc(name, args) {
  const response = await fetch(`${api}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  return response.ok ? response.json() : { denied: response.status };
}
try {
  const prepared = await rpc('certsim_service_prepare_python_expiry', { p_attempt_id: attemptId, p_token: token });
  check(prepared.ok && prepared.items?.length, 'PREPARATION_FAILED');
  const tasks = prepared.items.filter(item => item.state !== 'unanswered');
  if (mode === 'reproduce') {
    check(tasks.length > 0 && tasks.every(item => !item.workspace && !item.gradingMaterial), 'UNEXPECTED_INPUT_PATH');
    let rejected = false;
    try { normalizeExecutionRequest(pythonExecutionContract.createRequest(tasks[0].workspace, tasks[0].executionRequestId)); }
    catch { rejected = true; }
    check(rejected, 'BUILDER_UNEXPECTEDLY_ACCEPTED_MISSING_WORKSPACE');
    const response = await rpc('certsim_service_materialize_python_expiry', {
      p_attempt_id: attemptId, p_token: token, p_item_id: tasks[0].itemId, p_run_id: tasks[0].runId,
    });
    check(response.denied >= 400, 'DIGEST_NOT_REQUIRED');
    console.log(JSON.stringify({ gapConfirmed: true, builderRejectedMissingWorkspace: true, digestRequiredBeforeInputs: true }));
  } else {
    const summaries = [];
    for (const task of tasks) {
      const args = { p_attempt_id: attemptId, p_token: token, p_item_id: task.itemId, p_run_id: task.runId };
      const inputs = await rpc('certsim_service_read_python_expiry_task', args);
      check(inputs.ok, 'FROZEN_READ_FAILED');
      check(inputs.submissionId === prepared.submissionId && inputs.runId === task.runId
        && inputs.workspaceRevision === task.workspaceRevision && inputs.workspaceHash === task.workspaceHash,
      'FROZEN_IDENTITY_MISMATCH');
      check(createTrustedGradingMaterialDigest(inputs.gradingMaterial) === task.materialDigest, 'MATERIAL_DIGEST_MISMATCH');
      const request = normalizeExecutionRequest(pythonExecutionContract.createRequest(inputs.workspace, inputs.executionRequestId));
      check(request.limits.wallTimeMs === inputs.wallTimeMs && request.limits.memoryBytes === inputs.memoryBytes
        && request.limits.outputBytes === inputs.outputBytes, 'REQUEST_LIMIT_MISMATCH');
      const digest = createExecutionRequestDigest(request);
      check(digest === await pythonExecutionContract.sha256(pythonExecutionContract.canonicalJson(request)), 'CANONICAL_DIGEST_MISMATCH');
      if (inputs.executionRequestDigest !== null) check(inputs.executionRequestDigest === digest, 'STORED_DIGEST_MISMATCH');
      if (mode !== 'read') {
        const result = await rpc('certsim_service_materialize_python_expiry', { ...args, p_execution_request_digest: digest });
        check(result.ok && result.claimed === (inputs.executionRequestDigest === null), 'MATERIALIZATION_FAILED');
        const replay = await rpc('certsim_service_materialize_python_expiry', { ...args, p_execution_request_digest: digest });
        check(replay.ok && replay.claimed === false, 'LOST_RESPONSE_REPLAY_FAILED');
        const after = await rpc('certsim_service_read_python_expiry_task', args);
        check(after.ok && after.executionRequestDigest === digest && after.state === 'running', 'PERSISTED_DIGEST_MISMATCH');
        check(createExecutionRequestDigest(normalizeExecutionRequest(pythonExecutionContract.createRequest(
          after.workspace, after.executionRequestId))) === digest, 'RESTART_REQUEST_MISMATCH');
        const conflict = await rpc('certsim_service_materialize_python_expiry', { ...args,
          p_execution_request_digest: digest === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64) });
        check(conflict.ok === false, 'DIGEST_REWRITE_ALLOWED');
      }
      // Only opaque bindings and digests cross back to the fixture, never inputs.
      summaries.push({ runId: task.runId, digest, alreadyBound: inputs.executionRequestDigest !== null });
    }
    console.log(JSON.stringify({ ok: true, tasks: summaries }));
  }
} catch {
  // Do not surface response bodies, input source, credentials or identities.
  console.error(`FROZEN_CONSUMER_FAILED:${stage}`);
  process.exitCode = 1;
}
