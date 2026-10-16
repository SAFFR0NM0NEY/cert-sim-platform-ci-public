import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  canonicalizeExecutionRequest,
  canonicalizeExecutionResult,
  normalizeExecutionRequest,
  normalizeExecutionResult,
} from '../../python-executor/src/contract.mjs';

export const GRADING_BINDING_VERSION = 'certsim.python-grading.binding.v1';
export const GRADING_EVIDENCE_VERSION = 'certsim.python-grading.evidence.v1';
export const GRADING_EVIDENCE_ENVELOPE_VERSION =
  'certsim.python-grading.evidence-envelope.v1';
export const GRADING_EVIDENCE_SIGNATURE_DOMAIN =
  'certsim.python-grading.evidence-signature.v1';
export const GRADING_SIGNATURE_ALGORITHM = 'hmac-sha256';

export const GRADING_LIMITS = Object.freeze({
  maxOpaqueIdBytes: 128,
  maxRuleCount: 128,
  maxRawPoints: 1_000_000,
});

const BINDING_KEYS = [
  'bindingVersion',
  'gradingContractVersion',
  'gradingSessionId',
  'materialDigest',
  'materializationId',
  'maximumRawPoints',
  'requestDigest',
  'requestId',
];
const BINDING_DEFINITION_KEYS = [
  'gradingContractVersion',
  'gradingSessionId',
  'materialDigest',
  'materializationId',
  'maximumRawPoints',
  'request',
];
const EVIDENCE_KEYS = [
  'earnedRawPoints',
  'evidenceId',
  'evidenceVersion',
  'executionId',
  'executionResultDigest',
  'gradingContractVersion',
  'gradingSessionId',
  'materialDigest',
  'materializationId',
  'maximumRawPoints',
  'requestDigest',
  'requestId',
  'rules',
];
const RULE_KEYS = ['earnedRawPoints', 'maximumRawPoints', 'ruleId'];
const ENVELOPE_KEYS = ['algorithm', 'envelopeVersion', 'signature'];
const AUTHENTICATION_INPUT_KEYS = [
  'binding',
  'envelope',
  'evidence',
  'executionResult',
  'request',
  'secret',
];
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const SIGNATURE_PATTERN = /^[a-f0-9]{64}$/;
const TERMINAL_RESULT_STATUSES = new Set(['finished', 'cancelled', 'failed']);

const SAFE_MESSAGES = Object.freeze({
  DUPLICATE_GRADING_RULE_ID: 'The grading evidence contains a duplicate opaque rule ID.',
  EXECUTION_RESULT_NOT_TERMINAL: 'Grading evidence requires a terminal execution result.',
  GRADING_BINDING_MISMATCH: 'The grading evidence does not match the bound execution.',
  GRADING_EVIDENCE_SIGNATURE_INVALID: 'The grading evidence signature is invalid.',
  INVALID_GRADING_BINDING: 'The grading binding does not match the contract.',
  INVALID_GRADING_EVIDENCE: 'The grading evidence does not match the contract.',
  INVALID_GRADING_EVIDENCE_ENVELOPE: 'The grading evidence envelope does not match the contract.',
  INVALID_GRADING_SIGNING_SECRET: 'The grading signing secret does not meet the contract.',
});

export class PythonGradingContractError extends Error {
  constructor(code) {
    super(SAFE_MESSAGES[code] ?? 'The grading contract rejected the operation.');
    this.name = 'PythonGradingContractError';
    this.code = code;
  }
}

function reject(code) {
  throw new PythonGradingContractError(code);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
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

function normalizeOpaqueId(value, code) {
  assertUnicodeScalarString(value, code);
  if (utf8Bytes(value) > GRADING_LIMITS.maxOpaqueIdBytes || !OPAQUE_ID_PATTERN.test(value)) {
    reject(code);
  }
  return value;
}

function normalizeDigest(value, code) {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) reject(code);
  return value;
}

function normalizeRawPoints(value, code, { positive = false } = {}) {
  if (
    !Number.isSafeInteger(value)
    || value < (positive ? 1 : 0)
    || value > GRADING_LIMITS.maxRawPoints
  ) {
    reject(code);
  }
  return value;
}

function serializeCanonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) reject('INVALID_GRADING_EVIDENCE');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    assertUnicodeScalarString(value, 'INVALID_GRADING_EVIDENCE');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(serializeCanonicalJson).join(',')}]`;
  }
  assertPlainRecord(value, 'INVALID_GRADING_EVIDENCE');
  const members = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${serializeCanonicalJson(value[key])}`);
  return `{${members.join(',')}}`;
}

export function createExecutionRequestDigest(request) {
  return createHash('sha256')
    .update(canonicalizeExecutionRequest(request), 'utf8')
    .digest('hex');
}

export function createExecutionResultDigest(result, options) {
  return createHash('sha256')
    .update(canonicalizeExecutionResult(result, options), 'utf8')
    .digest('hex');
}

export function normalizeGradingBinding(binding) {
  assertExactKeys(binding, BINDING_KEYS, 'INVALID_GRADING_BINDING');
  if (binding.bindingVersion !== GRADING_BINDING_VERSION) reject('INVALID_GRADING_BINDING');
  return deepFreeze({
    bindingVersion: binding.bindingVersion,
    gradingSessionId: normalizeOpaqueId(binding.gradingSessionId, 'INVALID_GRADING_BINDING'),
    requestId: normalizeOpaqueId(binding.requestId, 'INVALID_GRADING_BINDING'),
    requestDigest: normalizeDigest(binding.requestDigest, 'INVALID_GRADING_BINDING'),
    materializationId: normalizeOpaqueId(binding.materializationId, 'INVALID_GRADING_BINDING'),
    materialDigest: normalizeDigest(binding.materialDigest, 'INVALID_GRADING_BINDING'),
    gradingContractVersion: normalizeOpaqueId(
      binding.gradingContractVersion,
      'INVALID_GRADING_BINDING',
    ),
    maximumRawPoints: normalizeRawPoints(
      binding.maximumRawPoints,
      'INVALID_GRADING_BINDING',
      { positive: true },
    ),
  });
}

export function createGradingBinding(definition) {
  assertExactKeys(definition, BINDING_DEFINITION_KEYS, 'INVALID_GRADING_BINDING');
  const request = normalizeExecutionRequest(definition.request);
  return normalizeGradingBinding({
    bindingVersion: GRADING_BINDING_VERSION,
    gradingSessionId: definition.gradingSessionId,
    requestId: request.requestId,
    requestDigest: createExecutionRequestDigest(request),
    materializationId: definition.materializationId,
    materialDigest: definition.materialDigest,
    gradingContractVersion: definition.gradingContractVersion,
    maximumRawPoints: definition.maximumRawPoints,
  });
}

function normalizeRuleEvidence(rule) {
  assertExactKeys(rule, RULE_KEYS, 'INVALID_GRADING_EVIDENCE');
  const maximumRawPoints = normalizeRawPoints(
    rule.maximumRawPoints,
    'INVALID_GRADING_EVIDENCE',
    { positive: true },
  );
  const earnedRawPoints = normalizeRawPoints(rule.earnedRawPoints, 'INVALID_GRADING_EVIDENCE');
  if (earnedRawPoints > maximumRawPoints) reject('INVALID_GRADING_EVIDENCE');
  return {
    ruleId: normalizeOpaqueId(rule.ruleId, 'INVALID_GRADING_EVIDENCE'),
    earnedRawPoints,
    maximumRawPoints,
  };
}

export function normalizeGradingEvidence(evidence) {
  assertExactKeys(evidence, EVIDENCE_KEYS, 'INVALID_GRADING_EVIDENCE');
  if (evidence.evidenceVersion !== GRADING_EVIDENCE_VERSION) {
    reject('INVALID_GRADING_EVIDENCE');
  }
  if (
    !Array.isArray(evidence.rules)
    || evidence.rules.length < 1
    || evidence.rules.length > GRADING_LIMITS.maxRuleCount
  ) {
    reject('INVALID_GRADING_EVIDENCE');
  }
  const rules = evidence.rules.map(normalizeRuleEvidence);
  rules.sort((left, right) => (
    left.ruleId < right.ruleId ? -1 : left.ruleId > right.ruleId ? 1 : 0
  ));
  if (new Set(rules.map(({ ruleId }) => ruleId)).size !== rules.length) {
    reject('DUPLICATE_GRADING_RULE_ID');
  }
  const maximumRawPoints = normalizeRawPoints(
    evidence.maximumRawPoints,
    'INVALID_GRADING_EVIDENCE',
    { positive: true },
  );
  const earnedRawPoints = normalizeRawPoints(
    evidence.earnedRawPoints,
    'INVALID_GRADING_EVIDENCE',
  );
  if (
    earnedRawPoints > maximumRawPoints
    || rules.reduce((total, rule) => total + rule.maximumRawPoints, 0) !== maximumRawPoints
    || rules.reduce((total, rule) => total + rule.earnedRawPoints, 0) !== earnedRawPoints
  ) {
    reject('INVALID_GRADING_EVIDENCE');
  }
  return deepFreeze({
    evidenceVersion: evidence.evidenceVersion,
    evidenceId: normalizeOpaqueId(evidence.evidenceId, 'INVALID_GRADING_EVIDENCE'),
    gradingSessionId: normalizeOpaqueId(
      evidence.gradingSessionId,
      'INVALID_GRADING_EVIDENCE',
    ),
    requestId: normalizeOpaqueId(evidence.requestId, 'INVALID_GRADING_EVIDENCE'),
    requestDigest: normalizeDigest(evidence.requestDigest, 'INVALID_GRADING_EVIDENCE'),
    executionId: normalizeOpaqueId(evidence.executionId, 'INVALID_GRADING_EVIDENCE'),
    executionResultDigest: normalizeDigest(
      evidence.executionResultDigest,
      'INVALID_GRADING_EVIDENCE',
    ),
    materializationId: normalizeOpaqueId(
      evidence.materializationId,
      'INVALID_GRADING_EVIDENCE',
    ),
    materialDigest: normalizeDigest(evidence.materialDigest, 'INVALID_GRADING_EVIDENCE'),
    gradingContractVersion: normalizeOpaqueId(
      evidence.gradingContractVersion,
      'INVALID_GRADING_EVIDENCE',
    ),
    earnedRawPoints,
    maximumRawPoints,
    rules,
  });
}

export function canonicalizeGradingEvidence(evidence) {
  return serializeCanonicalJson(normalizeGradingEvidence(evidence));
}

function normalizeSigningSecret(secret) {
  let bytes;
  if (typeof secret === 'string') {
    assertUnicodeScalarString(secret, 'INVALID_GRADING_SIGNING_SECRET');
    bytes = Buffer.from(secret, 'utf8');
  } else if (secret instanceof Uint8Array) {
    bytes = Buffer.from(secret);
  } else {
    reject('INVALID_GRADING_SIGNING_SECRET');
  }
  if (bytes.byteLength < 32) reject('INVALID_GRADING_SIGNING_SECRET');
  return bytes;
}

function buildEvidenceSignatureFrame(canonicalEvidence) {
  return [
    GRADING_EVIDENCE_SIGNATURE_DOMAIN,
    GRADING_EVIDENCE_ENVELOPE_VERSION,
    GRADING_EVIDENCE_VERSION,
    String(utf8Bytes(canonicalEvidence)),
    canonicalEvidence,
  ].join('\n');
}

function calculateEvidenceSignature(evidence, secret) {
  const canonicalEvidence = canonicalizeGradingEvidence(evidence);
  return createHmac('sha256', normalizeSigningSecret(secret))
    .update(buildEvidenceSignatureFrame(canonicalEvidence), 'utf8')
    .digest();
}

export function createSignedGradingEvidenceEnvelope(evidence, secret) {
  return {
    envelopeVersion: GRADING_EVIDENCE_ENVELOPE_VERSION,
    algorithm: GRADING_SIGNATURE_ALGORITHM,
    signature: calculateEvidenceSignature(evidence, secret).toString('hex'),
  };
}

function normalizeGradingEvidenceEnvelope(envelope) {
  assertExactKeys(envelope, ENVELOPE_KEYS, 'INVALID_GRADING_EVIDENCE_ENVELOPE');
  if (
    envelope.envelopeVersion !== GRADING_EVIDENCE_ENVELOPE_VERSION
    || envelope.algorithm !== GRADING_SIGNATURE_ALGORITHM
    || typeof envelope.signature !== 'string'
    || !SIGNATURE_PATTERN.test(envelope.signature)
  ) {
    reject('INVALID_GRADING_EVIDENCE_ENVELOPE');
  }
  return Buffer.from(envelope.signature, 'hex');
}

export function verifySignedGradingEvidenceEnvelope(evidence, envelope, secret) {
  const suppliedSignature = normalizeGradingEvidenceEnvelope(envelope);
  const expectedSignature = calculateEvidenceSignature(evidence, secret);
  return suppliedSignature.byteLength === expectedSignature.byteLength
    && timingSafeEqual(suppliedSignature, expectedSignature);
}

export function assertAuthenticatedGradingEvidenceForExecution(input) {
  assertExactKeys(input, AUTHENTICATION_INPUT_KEYS, 'GRADING_BINDING_MISMATCH');
  const request = normalizeExecutionRequest(input.request);
  const binding = normalizeGradingBinding(input.binding);
  const evidence = normalizeGradingEvidence(input.evidence);
  const resultOptions = { outputByteLimit: request.limits.outputBytes };
  const executionResult = normalizeExecutionResult(input.executionResult, resultOptions);

  if (!verifySignedGradingEvidenceEnvelope(evidence, input.envelope, input.secret)) {
    reject('GRADING_EVIDENCE_SIGNATURE_INVALID');
  }
  if (!TERMINAL_RESULT_STATUSES.has(executionResult.status)) {
    reject('EXECUTION_RESULT_NOT_TERMINAL');
  }

  const requestDigest = createExecutionRequestDigest(request);
  const executionResultDigest = createExecutionResultDigest(executionResult, resultOptions);
  if (
    binding.requestId !== request.requestId
    || binding.requestDigest !== requestDigest
    || evidence.requestId !== binding.requestId
    || evidence.requestDigest !== binding.requestDigest
    || evidence.gradingSessionId !== binding.gradingSessionId
    || evidence.materializationId !== binding.materializationId
    || evidence.materialDigest !== binding.materialDigest
    || evidence.gradingContractVersion !== binding.gradingContractVersion
    || evidence.maximumRawPoints !== binding.maximumRawPoints
    || evidence.executionId !== executionResult.executionId
    || evidence.executionResultDigest !== executionResultDigest
  ) {
    reject('GRADING_BINDING_MISMATCH');
  }
  return true;
}
