import { EXECUTION_LIMITS, normalizeExecutionRequest } from './contract.mjs';

export const ISOLATION_CONTRACT_VERSION = 'certsim.python-execution.isolation.v1';
export const ISOLATION_DECLARATION_ASSURANCE = 'declaration-only-not-security-evidence';

const SAFE_MESSAGES = Object.freeze({
  EXECUTION_LIMIT_EXCEEDS_DECLARED_CAPABILITY:
    'The execution request exceeds a declared isolation capability.',
  INVALID_ISOLATION_DECLARATION:
    'The isolation capability declaration does not match the contract.',
  ISOLATION_POLICY_NOT_MET:
    'The declared isolation capabilities do not meet the required policy.',
});

export class PythonIsolationContractError extends Error {
  constructor(code) {
    super(SAFE_MESSAGES[code] ?? 'The isolation contract rejected the operation.');
    this.name = 'PythonIsolationContractError';
    this.code = code;
  }
}

function reject(code) {
  throw new PythonIsolationContractError(code);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

const booleanValue = deepFreeze({ kind: 'boolean' });
const finiteMaximum = deepFreeze({ kind: 'finite-maximum' });
const enumeration = (...values) => deepFreeze({ kind: 'enum', values });

const DECLARATION_SCHEMA = deepFreeze({
  contractVersion: enumeration(ISOLATION_CONTRACT_VERSION),
  dependencies: {
    packageInstallation: enumeration('unsupported', 'allowed'),
    networkFetch: enumeration('prohibited', 'allowed'),
    manifestExecution: enumeration('prohibited', 'allowed'),
  },
  environment: {
    hostInheritance: enumeration('denied', 'allowed'),
    safeAllowlistOnly: booleanValue,
    secretInjection: enumeration('prohibited', 'allowed'),
    signingKeyExposure: enumeration('prohibited', 'allowed'),
  },
  filesystem: {
    workspace: enumeration('per-run-ephemeral', 'reused'),
    hostFilesystem: enumeration('not-mounted', 'mounted'),
    outsideWorkspace: enumeration('denied', 'allowed'),
    pathEscape: enumeration('prevented', 'possible'),
    specialFiles: enumeration('denied', 'available'),
    crossRunState: enumeration('prohibited', 'retained'),
    disposeState: enumeration('destroyed', 'retained'),
  },
  identity: {
    executionIdentity: enumeration('opaque-only', 'correlated'),
    externalIdentityData: enumeration('prohibited', 'allowed'),
  },
  lifecycle: {
    environmentPerRequest: enumeration('one-disposable', 'shared'),
    crossLearnerReuse: enumeration('prohibited', 'allowed'),
    cancellation: enumeration('supported', 'unsupported'),
    timeoutTermination: enumeration('supported', 'unsupported'),
    cancelledResourceConsumption: enumeration('bounded', 'unbounded'),
    postTerminalDisposal: enumeration('required', 'optional'),
    repeatedCancellation: enumeration('idempotent', 'unsafe'),
    repeatedDisposal: enumeration('idempotent', 'unsafe'),
    ambiguousTermination: enumeration('reconcile-before-retry', 'retry-without-reconcile'),
  },
  logging: {
    executionId: enumeration('opaque-only', 'correlated'),
    timingAndOutcome: enumeration('sanitized', 'raw'),
    resourceFacts: enumeration('aggregate-only', 'detailed'),
    learnerSource: enumeration('prohibited', 'allowed'),
    executionOutput: enumeration('prohibited-by-default', 'allowed'),
    sensitiveAssessmentMaterial: enumeration('prohibited', 'allowed'),
    credentials: enumeration('prohibited', 'allowed'),
    identityData: enumeration('prohibited', 'allowed'),
  },
  network: {
    learnerInbound: enumeration('denied', 'allowed'),
    publicEgress: enumeration('denied', 'allowed'),
    metadataServices: enumeration('unreachable', 'reachable'),
    dnsBypass: enumeration('prevented', 'possible'),
    callerOverride: enumeration('prohibited', 'allowed'),
  },
  process: {
    privileged: enumeration('denied', 'allowed'),
    hostNamespaces: enumeration('isolated', 'shared'),
    hostInspection: enumeration('denied', 'allowed'),
    learnerSubprocess: enumeration('denied', 'unrestricted'),
    orchestrationShell: enumeration('unreachable', 'reachable'),
  },
  resources: {
    callerCanExceedMaximum: booleanValue,
    wallTime: {
      enforced: booleanValue,
      maximumMs: finiteMaximum,
    },
    memory: {
      enforced: booleanValue,
      maximumBytes: finiteMaximum,
    },
    cpuTime: {
      enforced: booleanValue,
      maximumMs: finiteMaximum,
    },
    disk: {
      enforced: booleanValue,
      maximumBytes: finiteMaximum,
    },
    processCount: {
      enforced: booleanValue,
      maximum: finiteMaximum,
    },
    output: {
      enforcedDuringStreaming: booleanValue,
      maximumBytes: finiteMaximum,
    },
  },
  retention: {
    sourceAfterDisposal: enumeration('not-retained', 'retained'),
    workspaceAfterDisposal: enumeration('destroyed', 'retained'),
    operationalMetadata: enumeration('bounded-non-sensitive-only', 'unbounded'),
    retentionPeriod: enumeration('production-unset', 'production-fixed'),
  },
});

const REQUIRED_LITERAL_CONTROLS = deepFreeze([
  ['dependencies.packageInstallation', 'unsupported'],
  ['dependencies.networkFetch', 'prohibited'],
  ['dependencies.manifestExecution', 'prohibited'],
  ['environment.hostInheritance', 'denied'],
  ['environment.safeAllowlistOnly', true],
  ['environment.secretInjection', 'prohibited'],
  ['environment.signingKeyExposure', 'prohibited'],
  ['filesystem.workspace', 'per-run-ephemeral'],
  ['filesystem.hostFilesystem', 'not-mounted'],
  ['filesystem.outsideWorkspace', 'denied'],
  ['filesystem.pathEscape', 'prevented'],
  ['filesystem.specialFiles', 'denied'],
  ['filesystem.crossRunState', 'prohibited'],
  ['filesystem.disposeState', 'destroyed'],
  ['identity.executionIdentity', 'opaque-only'],
  ['identity.externalIdentityData', 'prohibited'],
  ['lifecycle.environmentPerRequest', 'one-disposable'],
  ['lifecycle.crossLearnerReuse', 'prohibited'],
  ['lifecycle.cancellation', 'supported'],
  ['lifecycle.timeoutTermination', 'supported'],
  ['lifecycle.cancelledResourceConsumption', 'bounded'],
  ['lifecycle.postTerminalDisposal', 'required'],
  ['lifecycle.repeatedCancellation', 'idempotent'],
  ['lifecycle.repeatedDisposal', 'idempotent'],
  ['lifecycle.ambiguousTermination', 'reconcile-before-retry'],
  ['logging.executionId', 'opaque-only'],
  ['logging.timingAndOutcome', 'sanitized'],
  ['logging.resourceFacts', 'aggregate-only'],
  ['logging.learnerSource', 'prohibited'],
  ['logging.executionOutput', 'prohibited-by-default'],
  ['logging.sensitiveAssessmentMaterial', 'prohibited'],
  ['logging.credentials', 'prohibited'],
  ['logging.identityData', 'prohibited'],
  ['network.learnerInbound', 'denied'],
  ['network.publicEgress', 'denied'],
  ['network.metadataServices', 'unreachable'],
  ['network.dnsBypass', 'prevented'],
  ['network.callerOverride', 'prohibited'],
  ['process.privileged', 'denied'],
  ['process.hostNamespaces', 'isolated'],
  ['process.hostInspection', 'denied'],
  ['process.learnerSubprocess', 'denied'],
  ['process.orchestrationShell', 'unreachable'],
  ['resources.callerCanExceedMaximum', false],
  ['resources.wallTime.enforced', true],
  ['resources.memory.enforced', true],
  ['resources.cpuTime.enforced', true],
  ['resources.disk.enforced', true],
  ['resources.processCount.enforced', true],
  ['resources.output.enforcedDuringStreaming', true],
  ['retention.sourceAfterDisposal', 'not-retained'],
  ['retention.workspaceAfterDisposal', 'destroyed'],
  ['retention.operationalMetadata', 'bounded-non-sensitive-only'],
  ['retention.retentionPeriod', 'production-unset'],
]);

const REQUIRED_TRUSTED_BOUNDED_CONTROLS = deepFreeze([
  [
    'resources.wallTime.maximumMs',
    EXECUTION_LIMITS.minWallTimeMs,
    EXECUTION_LIMITS.maxWallTimeMs,
  ],
  [
    'resources.memory.maximumBytes',
    EXECUTION_LIMITS.minMemoryBytes,
    EXECUTION_LIMITS.maxMemoryBytes,
  ],
  [
    'resources.output.maximumBytes',
    EXECUTION_LIMITS.minOutputBytes,
    EXECUTION_LIMITS.maxOutputBytes,
  ],
]);

const REQUIRED_FINITE_CONTROLS = deepFreeze([
  ['resources.cpuTime.maximumMs', 1],
  ['resources.disk.maximumBytes', 1],
  ['resources.processCount.maximum', 1],
]);

export const ISOLATION_REQUIRED_CONTROL_COUNT =
  REQUIRED_LITERAL_CONTROLS.length
  + REQUIRED_TRUSTED_BOUNDED_CONTROLS.length
  + REQUIRED_FINITE_CONTROLS.length;

function assertPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    reject('INVALID_ISOLATION_DECLARATION');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    reject('INVALID_ISOLATION_DECLARATION');
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') reject('INVALID_ISOLATION_DECLARATION');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      reject('INVALID_ISOLATION_DECLARATION');
    }
  }
}

function normalizeWithSchema(value, schema) {
  if (schema.kind === 'boolean') {
    if (typeof value !== 'boolean') reject('INVALID_ISOLATION_DECLARATION');
    return value;
  }
  if (schema.kind === 'finite-maximum') {
    if (value === null) return null;
    if (!Number.isSafeInteger(value) || value < 1) reject('INVALID_ISOLATION_DECLARATION');
    return value;
  }
  if (schema.kind === 'enum') {
    if (!schema.values.includes(value)) reject('INVALID_ISOLATION_DECLARATION');
    return value;
  }

  assertPlainRecord(value);
  const expectedKeys = Object.keys(schema).sort();
  const actualKeys = Object.keys(value).sort();
  if (
    actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    reject('INVALID_ISOLATION_DECLARATION');
  }
  return Object.fromEntries(
    Object.keys(schema).map((key) => [key, normalizeWithSchema(value[key], schema[key])]),
  );
}

function readPath(value, path) {
  return path.split('.').reduce((current, segment) => current?.[segment], value);
}

export function normalizeIsolationCapabilityDeclaration(declaration) {
  return deepFreeze(normalizeWithSchema(declaration, DECLARATION_SCHEMA));
}

/**
 * Validates only the declaration's claimed shape and policy. This is not
 * security evidence and does not prove enforcement by an execution system.
 */
export function assertDeclaredIsolationCapabilitiesMeetPolicy(declaration) {
  const normalized = normalizeIsolationCapabilityDeclaration(declaration);
  for (const [path, expected] of REQUIRED_LITERAL_CONTROLS) {
    if (!Object.is(readPath(normalized, path), expected)) reject('ISOLATION_POLICY_NOT_MET');
  }
  for (const [path, minimum, trustedMaximum] of REQUIRED_TRUSTED_BOUNDED_CONTROLS) {
    const declaredMaximum = readPath(normalized, path);
    if (
      !Number.isSafeInteger(declaredMaximum)
      || declaredMaximum < minimum
      || declaredMaximum > trustedMaximum
    ) {
      reject('ISOLATION_POLICY_NOT_MET');
    }
  }
  for (const [path, minimum] of REQUIRED_FINITE_CONTROLS) {
    const maximum = readPath(normalized, path);
    if (!Number.isSafeInteger(maximum) || maximum < minimum) reject('ISOLATION_POLICY_NOT_MET');
  }
  return normalized;
}

export function assertExecutionRequestWithinDeclaredCapabilities(request, declaration) {
  const normalizedRequest = normalizeExecutionRequest(request);
  const capabilities = assertDeclaredIsolationCapabilitiesMeetPolicy(declaration);
  if (
    normalizedRequest.limits.wallTimeMs > capabilities.resources.wallTime.maximumMs
    || normalizedRequest.limits.memoryBytes > capabilities.resources.memory.maximumBytes
    || normalizedRequest.limits.outputBytes > capabilities.resources.output.maximumBytes
  ) {
    reject('EXECUTION_LIMIT_EXCEEDS_DECLARED_CAPABILITY');
  }
  return true;
}
