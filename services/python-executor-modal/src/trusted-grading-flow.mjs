import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  EXECUTION_REQUEST_VERSION,
  normalizeExecutionRequest,
  normalizeExecutionResult,
  verifySignedExecutionEnvelope,
} from '../../python-executor/src/contract.mjs';
import {
  PythonExecutionProviderError,
  assertPythonExecutionProvider,
} from '../../python-executor/src/provider.mjs';
import { createSignedExecutionEnvelope } from '../../python-executor/src/contract.mjs';
import {
  GRADING_EVIDENCE_VERSION,
  assertAuthenticatedGradingEvidenceForExecution,
  createExecutionResultDigest,
  createExecutionRequestDigest,
  createSignedGradingEvidenceEnvelope,
  normalizeGradingBinding,
  normalizeGradingEvidence,
} from '../../python-grading/src/contract.mjs';
import {
  createTrustedGradingMaterialDigest,
  normalizeTrustedGradingMaterial,
} from '../../python-grading/src/trusted-grading-contract.mjs';
import { gradeTrustedPythonWorkspace } from '../../python-grading/src/trusted-grader.mjs';

const ACTIVE = new Set(['accepted', 'running']);

async function executeProbeToTerminal({ provider, request, envelope, signingSecret, pollIntervalMs, maximumPolls, signal }) {
  let result = normalizeExecutionResult(await executeAuthenticatedRequest({
    provider,
    request,
    envelope: envelope ?? createSignedExecutionEnvelope(request, signingSecret),
    signingSecret,
  }), { outputByteLimit: request.limits.outputBytes });
  for (let poll = 0; ACTIVE.has(result.status); poll += 1) {
    if (signal?.aborted) {
      await provider.cancel(result.executionId);
      throw new Error('GRADING_ABORTED');
    }
    if (poll >= maximumPolls) {
      await provider.cancel(result.executionId);
      throw new Error('EXECUTION_STATUS_TIMEOUT');
    }
    await delay(pollIntervalMs, undefined, signal ? { signal } : undefined).catch((error) => {
      if (error?.name !== 'AbortError') throw error;
    });
    if (signal?.aborted) {
      await provider.cancel(result.executionId);
      throw new Error('GRADING_ABORTED');
    }
    result = normalizeExecutionResult(await provider.getStatus(result.executionId), {
      outputByteLimit: request.limits.outputBytes,
    });
  }
  return normalizeExecutionResult(await provider.dispose(result.executionId), {
    outputByteLimit: request.limits.outputBytes,
  });
}

export function createTrustedPythonGradeCallback({
  provider,
  material,
  executionSigningSecret,
  gradingSecret,
  idFactory = randomUUID,
  pollIntervalMs = 25,
  maximumPolls = 1_500,
  signal,
}) {
  assertPythonExecutionProvider(provider);
  const canonicalMaterial = normalizeTrustedGradingMaterial(material);
  const materialDigest = createTrustedGradingMaterialDigest(canonicalMaterial);
  return async ({ request, executionResult, binding }) => {
    if (
      binding.materialDigest !== materialDigest
      || binding.gradingContractVersion !== canonicalMaterial.contractVersion
      || binding.maximumRawPoints !== canonicalMaterial.maximumRawPoints
    ) {
      throw new Error('GRADING_BINDING_MISMATCH');
    }
    const graded = await gradeTrustedPythonWorkspace({
      workspace: request.workspace,
      material: canonicalMaterial,
      runtimeRequestId: `request.${binding.gradingSessionId}`,
      executeRuntimeBatch: async ({ requestId, workspace, limits }) => {
        const probeRequest = normalizeExecutionRequest({
          contractVersion: EXECUTION_REQUEST_VERSION,
          requestId,
          runtime: { language: 'python', contract: 'python-source-v1' },
          workspace,
          limits,
        });
        return executeProbeToTerminal({
          provider,
          request: probeRequest,
          signingSecret: executionSigningSecret,
          pollIntervalMs,
          maximumPolls,
          signal,
        });
      },
    });
    const evidence = {
      evidenceVersion: GRADING_EVIDENCE_VERSION,
      evidenceId: binding.gradingSessionId,
      gradingSessionId: binding.gradingSessionId,
      requestId: binding.requestId,
      requestDigest: binding.requestDigest,
      executionId: executionResult.executionId,
      executionResultDigest: createExecutionResultDigest(executionResult, {
        outputByteLimit: request.limits.outputBytes,
      }),
      materializationId: binding.materializationId,
      materialDigest: binding.materialDigest,
      gradingContractVersion: binding.gradingContractVersion,
      earnedRawPoints: graded.earnedRawPoints,
      maximumRawPoints: graded.maximumRawPoints,
      rules: graded.rules,
    };
    return Object.freeze({
      evidence,
      envelope: createSignedGradingEvidenceEnvelope(evidence, gradingSecret),
    });
  };
}

export async function executeTrustedPythonGradingRequest({
  provider,
  request,
  binding,
  executionEnvelope,
  executionSigningSecret,
  gradingSecret,
  material,
  idFactory = randomUUID,
  pollIntervalMs = 25,
  maximumPolls = 1_500,
  signal,
}) {
  assertPythonExecutionProvider(provider);
  const canonicalRequest = normalizeExecutionRequest(request);
  const canonicalBinding = normalizeGradingBinding(binding);
  const canonicalMaterial = normalizeTrustedGradingMaterial(material);
  const materialDigest = createTrustedGradingMaterialDigest(canonicalMaterial);
  if (
    canonicalBinding.requestId !== canonicalRequest.requestId
    || canonicalBinding.requestDigest !== createExecutionRequestDigest(canonicalRequest)
    || canonicalBinding.materialDigest !== materialDigest
    || canonicalBinding.gradingContractVersion !== canonicalMaterial.contractVersion
    || canonicalBinding.maximumRawPoints !== canonicalMaterial.maximumRawPoints
  ) throw new Error('GRADING_BINDING_MISMATCH');
  try {
    const executionResult = await executeProbeToTerminal({
      provider,
      request: canonicalRequest,
      envelope: executionEnvelope,
      signingSecret: executionSigningSecret,
      pollIntervalMs,
      maximumPolls,
      signal,
    });
    const grade = createTrustedPythonGradeCallback({
      provider, material: canonicalMaterial, executionSigningSecret, gradingSecret, idFactory,
      pollIntervalMs, maximumPolls, signal,
    });
    const graded = await grade({
      request: canonicalRequest,
      executionResult,
      binding: canonicalBinding,
    });
    assertAuthenticatedGradingEvidenceForExecution({
      request: canonicalRequest,
      executionResult,
      binding: canonicalBinding,
      evidence: graded.evidence,
      envelope: graded.envelope,
      secret: gradingSecret,
    });
    return Object.freeze({ executionResult, evidence: graded.evidence, envelope: graded.envelope, disposalConfirmed: true });
  } finally {
    await provider.close?.();
  }
}

export function createServerExecutionRequest(definition, { idFactory = randomUUID } = {}) {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    throw new TypeError('Execution request definition is required.');
  }
  const keys = Object.keys(definition).sort();
  if (keys.join(',') !== 'limits,runtime,workspace' || typeof idFactory !== 'function') {
    throw new TypeError('Execution request definition is invalid.');
  }
  return normalizeExecutionRequest({
    contractVersion: EXECUTION_REQUEST_VERSION,
    requestId: `request.${idFactory()}`,
    runtime: definition.runtime,
    workspace: definition.workspace,
    limits: definition.limits,
  });
}

export async function executeAuthenticatedRequest({
  provider,
  request,
  envelope,
  signingSecret,
}) {
  assertPythonExecutionProvider(provider);
  const canonicalRequest = normalizeExecutionRequest(request);
  if (!verifySignedExecutionEnvelope(canonicalRequest, envelope, signingSecret)) {
    throw new PythonExecutionProviderError('REQUEST_AUTHENTICATION_FAILED');
  }
  return provider.execute(canonicalRequest);
}

export function createVerifiedEvidencePersistenceRecord(evidence) {
  const value = normalizeGradingEvidence(evidence);
  return Object.freeze({
    evidenceId: value.evidenceId,
    runId: null,
    materializationId: value.materializationId,
    gradingSessionId: value.gradingSessionId,
    executionRequestDigest: value.requestDigest,
    executionResultDigest: value.executionResultDigest,
    materialDigest: value.materialDigest,
    gradingContractVersion: value.gradingContractVersion,
    earnedRawPoints: value.earnedRawPoints,
    maximumRawPoints: value.maximumRawPoints,
    rulePoints: value.rules,
  });
}

export async function runTrustedExecutionAndGrading({
  provider,
  request,
  binding,
  executionEnvelope,
  executionSigningSecret,
  gradingSecret,
  grade,
  persistVerifiedEvidence,
  applyGenericScore,
  runId,
  pollIntervalMs = 25,
  maximumPolls = 1_500,
}) {
  assertPythonExecutionProvider(provider);
  if (typeof grade !== 'function' || typeof persistVerifiedEvidence !== 'function' ||
      typeof applyGenericScore !== 'function') {
    throw new TypeError('Trusted grading callbacks are required.');
  }
  const canonicalRequest = normalizeExecutionRequest(request);
  const canonicalBinding = normalizeGradingBinding(binding);
  if (typeof runId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(runId)) {
    throw new TypeError('A canonical run ID is required.');
  }
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1
      || !Number.isSafeInteger(maximumPolls) || maximumPolls < 1) {
    throw new TypeError('Execution polling bounds are invalid.');
  }
  if (canonicalBinding.requestId !== canonicalRequest.requestId
      || canonicalBinding.requestDigest !== createExecutionRequestDigest(canonicalRequest)) {
    throw new Error('GRADING_BINDING_MISMATCH');
  }
  let result = normalizeExecutionResult(await executeAuthenticatedRequest({
    provider,
    request: canonicalRequest,
    envelope: executionEnvelope,
    signingSecret: executionSigningSecret,
  }), {
    outputByteLimit: canonicalRequest.limits.outputBytes,
  });
  for (let poll = 0; ACTIVE.has(result.status); poll += 1) {
    if (poll >= maximumPolls) throw new Error('EXECUTION_STATUS_TIMEOUT');
    await delay(pollIntervalMs);
    result = normalizeExecutionResult(await provider.getStatus(result.executionId), {
      outputByteLimit: canonicalRequest.limits.outputBytes,
    });
  }

  const graded = await grade(Object.freeze({
    request: canonicalRequest,
    executionResult: result,
    binding: canonicalBinding,
  }));
  if (!graded || typeof graded !== 'object') throw new TypeError('Trusted grading failed.');
  assertAuthenticatedGradingEvidenceForExecution({
    request: canonicalRequest,
    executionResult: result,
    binding: canonicalBinding,
    evidence: graded.evidence,
    envelope: graded.envelope,
    secret: gradingSecret,
  });

  const persistence = { ...createVerifiedEvidencePersistenceRecord(graded.evidence), runId };
  const persisted = await persistVerifiedEvidence(Object.freeze(persistence));
  const score = await applyGenericScore(Object.freeze({
    evidenceId: persistence.evidenceId,
    earnedRawPoints: persistence.earnedRawPoints,
    maximumRawPoints: persistence.maximumRawPoints,
    persisted,
  }));
  return Object.freeze({ executionResult: result, persisted, score });
}
