import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  EXECUTION_REQUEST_VERSION,
  createSignedExecutionEnvelope,
  normalizeExecutionResult,
} from '../services/python-executor/src/contract.mjs';
import { createConfiguredModalClient } from '../services/python-executor-modal/src/config.mjs';
import { MODAL_EXECUTOR_APP } from '../services/python-executor-modal/src/provider.mjs';

const bridgeUrl = required('CERTSIM_MODAL_BRIDGE_URL').replace(/\/$/, '');
const proxyKey = required('CERTSIM_MODAL_PROXY_KEY');
const proxySecret = required('CERTSIM_MODAL_PROXY_SECRET');
const signingSecret = required('CERTSIM_EXECUTION_SIGNING_SECRET');
const denoPath = required('CERTSIM_DENO_PATH');
const denoClientPath = fileURLToPath(new URL('./issue86-modal-live-deno-client.ts', import.meta.url));
const headers = Object.freeze({
  'content-type': 'application/json',
  'Modal-Key': proxyKey,
  'Modal-Secret': proxySecret,
});

const unauthenticated = await fetch(`${bridgeUrl}/health`);
assert.ok([401, 403].includes(unauthenticated.status), 'Modal proxy auth must reject an unauthenticated request');
const health = await fetch(`${bridgeUrl}/health`, { headers });
assert.equal(health.status, 200);
const healthBody = await health.json();
assert.equal(healthBody.ok, true);
assert.ok(healthBody.nodeMajor >= 22, 'the deployed bridge must run Node 22 or newer');

const cases = Array.from({ length: 5 }, (_, index) => {
  const uuid = randomUUID();
  const marker = `issue86-synthetic-${index + 1}`;
  const request = {
    contractVersion: EXECUTION_REQUEST_VERSION,
    requestId: `request.${uuid}`,
    runtime: { language: 'python', contract: 'python-source-v1' },
    workspace: {
      entryPoint: 'main.py',
      files: [{
        path: 'main.py',
        content: `import sys\nprint("stdout:${marker}")\nprint("stderr:${marker}", file=sys.stderr)\n`,
      }],
    },
    limits: { wallTimeMs: 20_000, memoryBytes: 128 * 1024 * 1024, outputBytes: 1024 * 1024 },
  };
  const payload = { request, envelope: createSignedExecutionEnvelope(request, signingSecret) };
  assert.deepEqual(Object.keys(payload).sort(), ['envelope', 'request']);
  assert.doesNotMatch(JSON.stringify(payload), /learner(?:Id|Email|Name)|grading|hidden|protectedContent/i);
  return { marker, payload, expectedExecutionId: `execution.${uuid}` };
});

const startedAt = performance.now();
const [denoResult, ...nodeResults] = await Promise.all([
  executeWithDeno(cases[0].payload),
  ...cases.slice(1).map(({ payload }) => executeWithNode(payload)),
]);
const responses = [denoResult, ...nodeResults];
const durationMs = Math.round(performance.now() - startedAt);

responses.forEach((response, index) => {
  assert.equal(response.ok, true);
  assert.equal(response.disposalConfirmed, true);
  const result = normalizeExecutionResult(response.result, { outputByteLimit: 1024 * 1024 });
  assert.equal(result.executionId, cases[index].expectedExecutionId);
  assert.equal(result.status, 'finished');
  assert.equal(result.outcome, 'completed');
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, new RegExp(`^stdout:${cases[index].marker}\\r?\\n$`));
  assert.match(result.stderr, new RegExp(`^stderr:${cases[index].marker}\\r?\\n$`));
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 1024 * 1024);
  cases.forEach(({ marker }, otherIndex) => {
    if (otherIndex !== index) assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(marker));
  });
});
assert.equal(new Set(responses.map(({ result }) => result.executionId)).size, 5);

await new Promise((resolve) => setTimeout(resolve, 2_000));
const remainingSandboxes = await countRunningSandboxes();
assert.equal(remainingSandboxes, 0, 'all integration Sandboxes must be terminated');

process.stdout.write(`${JSON.stringify({
  ok: true,
  nodeMajor: healthBody.nodeMajor,
  proxyAuthenticated: true,
  unauthenticatedRejected: true,
  denoClient: '2.1.14',
  simultaneousRuns: 5,
  successfulRuns: 5,
  distinctExecutionIdentities: 5,
  isolatedWorkspaces: true,
  crossResultContamination: 0,
  disposalConfirmed: 5,
  remainingSandboxes,
  durationMs,
  protectedMaterialBodies: 0,
  learnerIdentities: 0,
})}\n`);

async function executeWithNode(payload) {
  const response = await fetch(`${bridgeUrl}/v1/execute`, {
    method: 'POST', headers, body: JSON.stringify(payload),
  });
  assert.equal(response.status, 200, `Node client request failed with ${response.status}`);
  return response.json();
}

async function executeWithDeno(payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(denoPath, [
      'run', '--no-lock', '--allow-env=CERTSIM_MODAL_BRIDGE_URL,CERTSIM_MODAL_PROXY_KEY,CERTSIM_MODAL_PROXY_SECRET',
      '--allow-net', denoClientPath,
    ], {
      env: {
        ...process.env,
        CERTSIM_MODAL_BRIDGE_URL: bridgeUrl,
        CERTSIM_MODAL_PROXY_KEY: proxyKey,
        CERTSIM_MODAL_PROXY_SECRET: proxySecret,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', () => reject(new Error('DENO_LIVE_CLIENT_FAILED')));
    child.once('close', (code) => {
      if (code !== 0) return reject(new Error(`DENO_LIVE_CLIENT_FAILED_${safeCode(stderr)}`));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('DENO_LIVE_CLIENT_RESPONSE_INVALID')); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function countRunningSandboxes() {
  const client = await createConfiguredModalClient();
  try {
    const app = await client.apps.fromName(MODAL_EXECUTOR_APP, { createIfMissing: false });
    let count = 0;
    for await (const sandbox of client.sandboxes.list({
      appId: app.appId,
      tags: { purpose: MODAL_EXECUTOR_APP, lifecycle: 'one-disposable-execution' },
    })) {
      void sandbox;
      count += 1;
    }
    return count;
  } finally {
    client.close();
  }
}

function required(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name}_REQUIRED`);
  return value;
}

function safeCode(value) {
  return String(value).match(/[A-Z][A-Z0-9_]{2,80}/)?.[0] ?? 'UNKNOWN';
}
