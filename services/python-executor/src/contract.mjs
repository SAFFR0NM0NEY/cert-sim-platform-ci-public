import { createHmac, timingSafeEqual } from 'node:crypto';

export const EXECUTION_REQUEST_VERSION = 'certsim.python-execution.request.v1';
export const EXECUTION_RESULT_VERSION = 'certsim.python-execution.result.v1';
export const SIGNED_ENVELOPE_VERSION = 'certsim.python-execution.envelope.v1';
export const SIGNATURE_ALGORITHM = 'hmac-sha256';
export const SIGNATURE_DOMAIN = 'certsim.python-execution.request-signature.v1';

export const EXECUTION_LIMITS = Object.freeze({
  maxFiles: 16,
  maxPathBytes: 240,
  maxFileBytes: 64 * 1024,
  maxTotalSourceBytes: 256 * 1024,
  minWallTimeMs: 100,
  maxWallTimeMs: 30_000,
  minMemoryBytes: 16 * 1024 * 1024,
  maxMemoryBytes: 512 * 1024 * 1024,
  minOutputBytes: 1,
  maxOutputBytes: 1024 * 1024,
  maxOpaqueIdBytes: 128,
  maxDiagnostics: 8,
  maxDiagnosticCodeBytes: 64,
  maxDiagnosticMessageBytes: 512,
});

const REQUEST_KEYS = ['contractVersion', 'limits', 'requestId', 'runtime', 'workspace'];
const RUNTIME_KEYS = ['contract', 'language'];
const WORKSPACE_KEYS = ['entryPoint', 'files'];
const FILE_KEYS = ['content', 'path'];
const LIMIT_KEYS = ['memoryBytes', 'outputBytes', 'wallTimeMs'];
const ENVELOPE_KEYS = ['algorithm', 'envelopeVersion', 'signature'];
const RESULT_KEYS = [
  'contractVersion',
  'diagnostics',
  'executionId',
  'exitCode',
  'outcome',
  'status',
  'stderr',
  'stdout',
];
const DIAGNOSTIC_KEYS = ['code', 'message'];
const ACTIVE_STATUSES = new Set(['accepted', 'running']);
const TERMINAL_STATUSES = new Set(['finished', 'cancelled', 'failed']);
const FINISHED_OUTCOMES = new Set(['completed', 'timeout', 'resource_limit', 'failed']);
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIAGNOSTIC_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const SIGNATURE_PATTERN = /^[a-f0-9]{64}$/;

const SAFE_MESSAGES = Object.freeze({
  DUPLICATE_SOURCE_PATH: 'The execution request contains a duplicate source path.',
  EXECUTION_RESULT_TOO_LARGE: 'The execution result exceeds its output boundary.',
  INVALID_EXECUTION_REQUEST: 'The execution request does not match the contract.',
  INVALID_EXECUTION_RESULT: 'The execution result does not match the contract.',
  INVALID_SIGNED_ENVELOPE: 'The signed envelope does not match the contract.',
  INVALID_SIGNING_SECRET: 'The signing secret does not meet the contract.',
  INVALID_SOURCE_PATH: 'The execution request contains an invalid source path.',
  REQUEST_SOURCE_TOO_LARGE: 'The execution request exceeds its source boundary.',
  SIGNATURE_INVALID: 'The execution request signature is invalid.',
  UNSUPPORTED_SOURCE_TYPE: 'The execution request contains an unsupported source type.',
});

export class PythonExecutorContractError extends Error {
  constructor(code) {
    super(SAFE_MESSAGES[code] ?? 'The executor contract rejected the operation.');
    this.name = 'PythonExecutorContractError';
    this.code = code;
  }
}

function reject(code) {
  throw new PythonExecutorContractError(code);
}

function assertPlainRecord(value, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) reject(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) reject(code);

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') reject(code);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) reject(code);
  }
}

function assertExactKeys(value, expected, code) {
  assertPlainRecord(value, code);
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    reject(code);
  }
}

function assertUnicodeScalarString(value, code) {
  if (typeof value !== 'string') reject(code);
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) reject(code);
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      reject(code);
    }
  }
}

function utf8Bytes(value) {
  return Buffer.byteLength(value, 'utf8');
}

function assertBoundedString(value, maximumBytes, code, { allowEmpty = false } = {}) {
  assertUnicodeScalarString(value, code);
  const size = utf8Bytes(value);
  if ((!allowEmpty && size === 0) || size > maximumBytes) reject(code);
}

function assertBoundedInteger(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) reject(code);
}

function normalizeOpaqueId(value, code) {
  assertBoundedString(value, EXECUTION_LIMITS.maxOpaqueIdBytes, code);
  if (!OPAQUE_ID_PATTERN.test(value)) reject(code);
  return value;
}

function normalizeSourcePath(value) {
  assertBoundedString(value, EXECUTION_LIMITS.maxPathBytes, 'INVALID_SOURCE_PATH');
  if (
    value.includes('\\')
    || value.includes('\0')
    || value.startsWith('/')
    || /^[A-Za-z]:/.test(value)
    || value.endsWith('/')
    || value.includes('//')
  ) {
    reject('INVALID_SOURCE_PATH');
  }

  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    reject('INVALID_SOURCE_PATH');
  }
  if (!segments.every((segment) => /^[A-Za-z0-9._-]+$/.test(segment))) {
    reject('INVALID_SOURCE_PATH');
  }
  if (!value.endsWith('.py')) reject('UNSUPPORTED_SOURCE_TYPE');
  return value;
}

function normalizeRuntime(runtime) {
  assertExactKeys(runtime, RUNTIME_KEYS, 'INVALID_EXECUTION_REQUEST');
  if (runtime.language !== 'python' || runtime.contract !== 'python-source-v1') {
    reject('INVALID_EXECUTION_REQUEST');
  }
  return { language: runtime.language, contract: runtime.contract };
}

function normalizeLimits(limits) {
  assertExactKeys(limits, LIMIT_KEYS, 'INVALID_EXECUTION_REQUEST');
  assertBoundedInteger(
    limits.wallTimeMs,
    EXECUTION_LIMITS.minWallTimeMs,
    EXECUTION_LIMITS.maxWallTimeMs,
    'INVALID_EXECUTION_REQUEST',
  );
  assertBoundedInteger(
    limits.memoryBytes,
    EXECUTION_LIMITS.minMemoryBytes,
    EXECUTION_LIMITS.maxMemoryBytes,
    'INVALID_EXECUTION_REQUEST',
  );
  assertBoundedInteger(
    limits.outputBytes,
    EXECUTION_LIMITS.minOutputBytes,
    EXECUTION_LIMITS.maxOutputBytes,
    'INVALID_EXECUTION_REQUEST',
  );
  return {
    wallTimeMs: limits.wallTimeMs,
    memoryBytes: limits.memoryBytes,
    outputBytes: limits.outputBytes,
  };
}

function normalizeWorkspace(workspace) {
  assertExactKeys(workspace, WORKSPACE_KEYS, 'INVALID_EXECUTION_REQUEST');
  if (!Array.isArray(workspace.files) || workspace.files.length < 1) {
    reject('INVALID_EXECUTION_REQUEST');
  }
  if (workspace.files.length > EXECUTION_LIMITS.maxFiles) reject('REQUEST_SOURCE_TOO_LARGE');

  let totalSourceBytes = 0;
  const portablePaths = new Set();
  const files = workspace.files.map((file) => {
    assertExactKeys(file, FILE_KEYS, 'INVALID_EXECUTION_REQUEST');
    const path = normalizeSourcePath(file.path);
    const portablePath = path.toLowerCase();
    if (portablePaths.has(portablePath)) reject('DUPLICATE_SOURCE_PATH');
    portablePaths.add(portablePath);

    assertUnicodeScalarString(file.content, 'INVALID_EXECUTION_REQUEST');
    const fileBytes = utf8Bytes(file.content);
    if (fileBytes > EXECUTION_LIMITS.maxFileBytes) reject('REQUEST_SOURCE_TOO_LARGE');
    totalSourceBytes += fileBytes;
    if (totalSourceBytes > EXECUTION_LIMITS.maxTotalSourceBytes) reject('REQUEST_SOURCE_TOO_LARGE');
    return { path, content: file.content };
  });

  const entryPoint = normalizeSourcePath(workspace.entryPoint);
  if (!files.some((file) => file.path === entryPoint)) reject('INVALID_EXECUTION_REQUEST');
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { entryPoint, files };
}

export function normalizeExecutionRequest(request) {
  assertExactKeys(request, REQUEST_KEYS, 'INVALID_EXECUTION_REQUEST');
  if (request.contractVersion !== EXECUTION_REQUEST_VERSION) reject('INVALID_EXECUTION_REQUEST');
  return {
    contractVersion: request.contractVersion,
    requestId: normalizeOpaqueId(request.requestId, 'INVALID_EXECUTION_REQUEST'),
    runtime: normalizeRuntime(request.runtime),
    workspace: normalizeWorkspace(request.workspace),
    limits: normalizeLimits(request.limits),
  };
}

function serializeCanonicalJson(value, code = 'INVALID_EXECUTION_REQUEST') {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) reject(code);
    return Object.is(value, -0) ? '0' : JSON.stringify(value);
  }
  if (typeof value === 'string') {
    assertUnicodeScalarString(value, code);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => serializeCanonicalJson(entry, code)).join(',')}]`;
  }

  assertPlainRecord(value, code);
  const members = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${serializeCanonicalJson(value[key], code)}`);
  return `{${members.join(',')}}`;
}

export function canonicalizeExecutionRequest(request) {
  return serializeCanonicalJson(normalizeExecutionRequest(request));
}

function normalizeSigningSecret(secret) {
  let bytes;
  if (typeof secret === 'string') {
    assertUnicodeScalarString(secret, 'INVALID_SIGNING_SECRET');
    bytes = Buffer.from(secret, 'utf8');
  } else if (secret instanceof Uint8Array) {
    bytes = Buffer.from(secret);
  } else {
    reject('INVALID_SIGNING_SECRET');
  }
  if (bytes.byteLength < 32) reject('INVALID_SIGNING_SECRET');
  return bytes;
}

function buildSignatureFrame(canonicalPayload) {
  return [
    SIGNATURE_DOMAIN,
    SIGNED_ENVELOPE_VERSION,
    EXECUTION_REQUEST_VERSION,
    String(utf8Bytes(canonicalPayload)),
    canonicalPayload,
  ].join('\n');
}

function calculateSignature(request, secret) {
  const canonicalPayload = canonicalizeExecutionRequest(request);
  return createHmac('sha256', normalizeSigningSecret(secret))
    .update(buildSignatureFrame(canonicalPayload), 'utf8')
    .digest();
}

export function createSignedExecutionEnvelope(request, secret) {
  return {
    envelopeVersion: SIGNED_ENVELOPE_VERSION,
    algorithm: SIGNATURE_ALGORITHM,
    signature: calculateSignature(request, secret).toString('hex'),
  };
}

function normalizeSignedEnvelope(envelope) {
  assertExactKeys(envelope, ENVELOPE_KEYS, 'INVALID_SIGNED_ENVELOPE');
  if (
    envelope.envelopeVersion !== SIGNED_ENVELOPE_VERSION
    || envelope.algorithm !== SIGNATURE_ALGORITHM
    || typeof envelope.signature !== 'string'
    || !SIGNATURE_PATTERN.test(envelope.signature)
  ) {
    reject('INVALID_SIGNED_ENVELOPE');
  }
  return Buffer.from(envelope.signature, 'hex');
}

export function verifySignedExecutionEnvelope(request, envelope, secret) {
  const suppliedSignature = normalizeSignedEnvelope(envelope);
  const expectedSignature = calculateSignature(request, secret);
  return suppliedSignature.byteLength === expectedSignature.byteLength
    && timingSafeEqual(suppliedSignature, expectedSignature);
}

function normalizeDiagnostic(diagnostic) {
  assertExactKeys(diagnostic, DIAGNOSTIC_KEYS, 'INVALID_EXECUTION_RESULT');
  assertBoundedString(
    diagnostic.code,
    EXECUTION_LIMITS.maxDiagnosticCodeBytes,
    'INVALID_EXECUTION_RESULT',
  );
  if (!DIAGNOSTIC_CODE_PATTERN.test(diagnostic.code)) reject('INVALID_EXECUTION_RESULT');
  assertBoundedString(
    diagnostic.message,
    EXECUTION_LIMITS.maxDiagnosticMessageBytes,
    'INVALID_EXECUTION_RESULT',
    { allowEmpty: true },
  );
  return { code: diagnostic.code, message: diagnostic.message };
}

function assertResultState(status, outcome, exitCode) {
  if (ACTIVE_STATUSES.has(status)) {
    if (outcome !== null || exitCode !== null) reject('INVALID_EXECUTION_RESULT');
    return;
  }
  if (status === 'cancelled') {
    if (outcome !== 'cancelled' || exitCode !== null) reject('INVALID_EXECUTION_RESULT');
    return;
  }
  if (status === 'failed') {
    if (outcome !== 'failed' || exitCode !== null) reject('INVALID_EXECUTION_RESULT');
    return;
  }
  if (status !== 'finished' || !FINISHED_OUTCOMES.has(outcome)) {
    reject('INVALID_EXECUTION_RESULT');
  }
  if (outcome === 'completed') {
    if (exitCode !== 0) reject('INVALID_EXECUTION_RESULT');
  } else if (outcome === 'failed') {
    if (exitCode !== null && (!Number.isSafeInteger(exitCode) || exitCode < 1 || exitCode > 255)) {
      reject('INVALID_EXECUTION_RESULT');
    }
  } else if (exitCode !== null) {
    reject('INVALID_EXECUTION_RESULT');
  }
}

export function normalizeExecutionResult(result, { outputByteLimit = EXECUTION_LIMITS.maxOutputBytes } = {}) {
  assertBoundedInteger(
    outputByteLimit,
    EXECUTION_LIMITS.minOutputBytes,
    EXECUTION_LIMITS.maxOutputBytes,
    'INVALID_EXECUTION_RESULT',
  );
  assertExactKeys(result, RESULT_KEYS, 'INVALID_EXECUTION_RESULT');
  if (result.contractVersion !== EXECUTION_RESULT_VERSION) reject('INVALID_EXECUTION_RESULT');
  const executionId = normalizeOpaqueId(result.executionId, 'INVALID_EXECUTION_RESULT');
  if (!ACTIVE_STATUSES.has(result.status) && !TERMINAL_STATUSES.has(result.status)) {
    reject('INVALID_EXECUTION_RESULT');
  }
  assertUnicodeScalarString(result.stdout, 'INVALID_EXECUTION_RESULT');
  assertUnicodeScalarString(result.stderr, 'INVALID_EXECUTION_RESULT');
  if (!Array.isArray(result.diagnostics) || result.diagnostics.length > EXECUTION_LIMITS.maxDiagnostics) {
    reject('INVALID_EXECUTION_RESULT');
  }
  const diagnostics = result.diagnostics.map(normalizeDiagnostic);
  assertResultState(result.status, result.outcome, result.exitCode);

  const outputBytes = utf8Bytes(result.stdout)
    + utf8Bytes(result.stderr)
    + diagnostics.reduce(
      (total, diagnostic) => total + utf8Bytes(diagnostic.code) + utf8Bytes(diagnostic.message),
      0,
    );
  if (outputBytes > outputByteLimit) reject('EXECUTION_RESULT_TOO_LARGE');

  return {
    contractVersion: result.contractVersion,
    executionId,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    outcome: result.outcome,
    diagnostics,
  };
}

export function canonicalizeExecutionResult(result, options) {
  return serializeCanonicalJson(
    normalizeExecutionResult(result, options),
    'INVALID_EXECUTION_RESULT',
  );
}
