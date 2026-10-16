import {
  createConfiguredModalClient,
  createConfiguredPythonExecutionProvider,
} from './config.mjs';
import {
  normalizeExecutionRequest,
  verifySignedExecutionEnvelope,
} from '../../python-executor/src/contract.mjs';
import { terminateModalSandboxForRequest } from './provider.mjs';
import { executeSignedRequestToTerminal } from './terminal-execution.mjs';
import { executeTrustedPythonGradingRequest } from './trusted-grading-flow.mjs';

const REQUEST_KEYS = ['envelope', 'request'];
const GRADING_REQUEST_KEYS = ['binding', 'envelope', 'gradingMaterial', 'request'];

export class ModalBridgeRequestError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'ModalBridgeRequestError';
    this.code = code;
    this.status = status;
  }
}

function assertPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join(',') !== REQUEST_KEYS.join(',')) {
    throw new ModalBridgeRequestError('invalid_request');
  }
  return value;
}

function assertGradingPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join(',') !== GRADING_REQUEST_KEYS.join(',')) {
    throw new ModalBridgeRequestError('invalid_request');
  }
  return value;
}

function readSigningSecret(env) {
  const value = env.CERTSIM_EXECUTION_SIGNING_SECRET;
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') < 32) {
    throw new ModalBridgeRequestError('service_unavailable', 503);
  }
  return value;
}

function readGradingSecret(env) {
  if (env.CERTSIM_PYTHON_GRADING_ENABLED !== 'YES') {
    throw new ModalBridgeRequestError('service_unavailable', 503);
  }
  const execution = readSigningSecret(env);
  const grading = env.CERTSIM_GRADING_SIGNING_SECRET;
  if (typeof grading !== 'string' || Buffer.byteLength(grading, 'utf8') < 32 || grading === execution) {
    throw new ModalBridgeRequestError('service_unavailable', 503);
  }
  return grading;
}

export async function executeModalBridgePayload(payload, {
  env = process.env,
  providerFactory = createConfiguredPythonExecutionProvider,
  signal,
} = {}) {
  const body = assertPayload(payload);
  const provider = await providerFactory({ env });
  try {
    return await executeSignedRequestToTerminal({
      envelope: body.envelope,
      provider,
      request: body.request,
      signal,
      signingSecret: readSigningSecret(env),
    });
  } catch (error) {
    if (error?.code === 'REQUEST_AUTHENTICATION_FAILED' ||
        error?.code === 'SIGNATURE_INVALID' ||
        error?.code === 'INVALID_SIGNED_ENVELOPE') {
      throw new ModalBridgeRequestError('request_authentication_failed', 401);
    }
    if (error instanceof ModalBridgeRequestError) throw error;
    if (String(error?.code ?? '').startsWith('INVALID_')) {
      throw new ModalBridgeRequestError('invalid_request');
    }
    throw new ModalBridgeRequestError('execution_failed', 503);
  }
}

export async function cancelModalBridgePayload(payload, {
  clientFactory = createConfiguredModalClient,
  env = process.env,
} = {}) {
  const body = assertPayload(payload);
  let request;
  try {
    request = normalizeExecutionRequest(body.request);
    if (!verifySignedExecutionEnvelope(request, body.envelope, readSigningSecret(env))) {
      throw new ModalBridgeRequestError('request_authentication_failed', 401);
    }
  } catch (error) {
    if (error instanceof ModalBridgeRequestError) throw error;
    throw new ModalBridgeRequestError('request_authentication_failed', 401);
  }
  const client = await clientFactory({ env });
  try {
    const result = await terminateModalSandboxForRequest(client, request.requestId);
    return Object.freeze({ result, disposalConfirmed: true });
  } catch {
    throw new ModalBridgeRequestError('disposal_unconfirmed', 503);
  } finally {
    client.close?.();
  }
}

export async function gradeModalBridgePayload(payload, {
  env = process.env,
  providerFactory = createConfiguredPythonExecutionProvider,
  signal,
} = {}) {
  const body = assertGradingPayload(payload);
  const executionSigningSecret = readSigningSecret(env);
  const gradingSecret = readGradingSecret(env);
  const provider = await providerFactory({ env });
  try {
    return await executeTrustedPythonGradingRequest({
      provider,
      request: body.request,
      binding: body.binding,
      executionEnvelope: body.envelope,
      executionSigningSecret,
      gradingSecret,
      material: body.gradingMaterial,
      signal,
    });
  } catch (error) {
    if (error?.code === 'REQUEST_AUTHENTICATION_FAILED' ||
        error?.code === 'SIGNATURE_INVALID' || error?.code === 'INVALID_SIGNED_ENVELOPE') {
      throw new ModalBridgeRequestError('request_authentication_failed', 401);
    }
    if (String(error?.code ?? error?.message ?? '').includes('INCOMPLETE_TRUSTED_GRADING_MATERIAL')) {
      throw new ModalBridgeRequestError('grading_material_incomplete', 409);
    }
    if (error instanceof ModalBridgeRequestError) throw error;
    throw new ModalBridgeRequestError('grading_failed', 503);
  }
}
