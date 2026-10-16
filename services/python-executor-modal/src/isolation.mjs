import {
  ISOLATION_CONTRACT_VERSION,
  assertDeclaredIsolationCapabilitiesMeetPolicy,
} from '../../python-executor/src/isolation.mjs';

export const MODAL_PROVIDER_LIMITS = Object.freeze({
  cpuRequest: 0.125,
  cpuLimit: 0.25,
  cpuTimeMs: 4_000,
  diskBytes: 16 * 1024 * 1024,
  memoryBytes: 128 * 1024 * 1024,
  outputBytes: 1024 * 1024,
  processCount: 1,
  wallTimeMs: 20_000,
});

export const MODAL_ISOLATION_CAPABILITIES = Object.freeze({
  contractVersion: ISOLATION_CONTRACT_VERSION,
  dependencies: {
    packageInstallation: 'unsupported',
    networkFetch: 'prohibited',
    manifestExecution: 'prohibited',
  },
  environment: {
    hostInheritance: 'denied',
    safeAllowlistOnly: true,
    secretInjection: 'prohibited',
    signingKeyExposure: 'prohibited',
  },
  filesystem: {
    workspace: 'per-run-ephemeral',
    hostFilesystem: 'not-mounted',
    outsideWorkspace: 'denied',
    pathEscape: 'prevented',
    specialFiles: 'denied',
    crossRunState: 'prohibited',
    disposeState: 'destroyed',
  },
  identity: {
    executionIdentity: 'opaque-only',
    externalIdentityData: 'prohibited',
  },
  lifecycle: {
    environmentPerRequest: 'one-disposable',
    crossLearnerReuse: 'prohibited',
    cancellation: 'supported',
    timeoutTermination: 'supported',
    cancelledResourceConsumption: 'bounded',
    postTerminalDisposal: 'required',
    repeatedCancellation: 'idempotent',
    repeatedDisposal: 'idempotent',
    ambiguousTermination: 'reconcile-before-retry',
  },
  logging: {
    executionId: 'opaque-only',
    timingAndOutcome: 'sanitized',
    resourceFacts: 'aggregate-only',
    learnerSource: 'prohibited',
    executionOutput: 'prohibited-by-default',
    sensitiveAssessmentMaterial: 'prohibited',
    credentials: 'prohibited',
    identityData: 'prohibited',
  },
  network: {
    learnerInbound: 'denied',
    publicEgress: 'denied',
    metadataServices: 'unreachable',
    dnsBypass: 'prevented',
    callerOverride: 'prohibited',
  },
  process: {
    privileged: 'denied',
    hostNamespaces: 'isolated',
    hostInspection: 'denied',
    learnerSubprocess: 'denied',
    orchestrationShell: 'unreachable',
  },
  resources: {
    callerCanExceedMaximum: false,
    wallTime: { enforced: true, maximumMs: MODAL_PROVIDER_LIMITS.wallTimeMs },
    memory: { enforced: true, maximumBytes: MODAL_PROVIDER_LIMITS.memoryBytes },
    cpuTime: { enforced: true, maximumMs: MODAL_PROVIDER_LIMITS.cpuTimeMs },
    disk: { enforced: true, maximumBytes: MODAL_PROVIDER_LIMITS.diskBytes },
    processCount: { enforced: true, maximum: MODAL_PROVIDER_LIMITS.processCount },
    output: { enforcedDuringStreaming: true, maximumBytes: MODAL_PROVIDER_LIMITS.outputBytes },
  },
  retention: {
    sourceAfterDisposal: 'not-retained',
    workspaceAfterDisposal: 'destroyed',
    operationalMetadata: 'bounded-non-sensitive-only',
    retentionPeriod: 'production-unset',
  },
});

assertDeclaredIsolationCapabilitiesMeetPolicy(MODAL_ISOLATION_CAPABILITIES);
