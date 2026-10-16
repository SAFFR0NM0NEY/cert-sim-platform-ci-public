import { setTimeout as delay } from 'node:timers/promises';
import {
  normalizeExecutionRequest,
  normalizeExecutionResult,
  verifySignedExecutionEnvelope,
} from '../../python-executor/src/contract.mjs';
import {
  PythonExecutionProviderError,
  assertPythonExecutionProvider,
} from '../../python-executor/src/provider.mjs';

const ACTIVE = new Set(['accepted', 'running']);

function authenticationError() {
  return new PythonExecutionProviderError('REQUEST_AUTHENTICATION_FAILED');
}

export async function executeSignedRequestToTerminal({
  envelope,
  maximumPolls = 1_500,
  pollIntervalMs = 20,
  provider,
  request,
  signal,
  signingSecret,
}) {
  assertPythonExecutionProvider(provider);
  const canonicalRequest = normalizeExecutionRequest(request);
  if (!verifySignedExecutionEnvelope(canonicalRequest, envelope, signingSecret)) {
    throw authenticationError();
  }
  if (!Number.isSafeInteger(maximumPolls) || maximumPolls < 1 ||
      !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new TypeError('Execution polling bounds are invalid.');
  }

  let executionId = '';
  let disposalConfirmed = false;
  try {
    let result = normalizeExecutionResult(await provider.execute(canonicalRequest), {
      outputByteLimit: canonicalRequest.limits.outputBytes,
    });
    executionId = result.executionId;
    for (let poll = 0; ACTIVE.has(result.status); poll += 1) {
      if (signal?.aborted) {
        result = normalizeExecutionResult(await provider.cancel(executionId), {
          outputByteLimit: canonicalRequest.limits.outputBytes,
        });
        break;
      }
      if (poll >= maximumPolls) {
        await provider.cancel(executionId);
        throw new PythonExecutionProviderError('PROVIDER_OPERATION_FAILED');
      }
      await delay(pollIntervalMs, undefined, { signal }).catch((error) => {
        if (error?.name !== 'AbortError') throw error;
      });
      if (signal?.aborted) continue;
      result = normalizeExecutionResult(await provider.getStatus(executionId), {
        outputByteLimit: canonicalRequest.limits.outputBytes,
      });
    }
    result = normalizeExecutionResult(await provider.dispose(executionId), {
      outputByteLimit: canonicalRequest.limits.outputBytes,
    });
    disposalConfirmed = true;
    return Object.freeze({ result, disposalConfirmed });
  } finally {
    if (executionId && !disposalConfirmed) {
      try {
        await provider.dispose(executionId);
      } catch {
        // close() performs the final bounded cleanup attempt below.
      }
    }
    await provider.close?.();
  }
}
