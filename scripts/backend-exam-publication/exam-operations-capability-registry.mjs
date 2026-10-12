import {
  MULTI_EXAM_QUESTION_CAPABILITIES,
} from './multi-exam-contract.mjs';

export const CAPABILITY_COMPATIBILITY_REGISTRY_VERSION =
  'certsim-exam-operations-capability-registry-v1';

export const SUPPORTED_EXISTING_PLATFORM_CAPABILITY =
  'SUPPORTED_EXISTING_PLATFORM_CAPABILITY';
export const PLATFORM_CAPABILITY_CHANGE_REQUIRED =
  'PLATFORM_CAPABILITY_CHANGE_REQUIRED';

export const PBQ_RUNTIME_VERSION = 'certsim-protected-pbq-runtime-v1';

export const PYTHON_EXECUTOR_REQUIREMENT = Object.freeze({
  provider: 'modal',
  requestContractVersion: 'certsim.python-execution.request.v1',
  resultContractVersion: 'certsim.python-execution.result.v1',
  isolationContractVersion: 'certsim.python-execution.isolation.v1',
  sourceRuntimeContract: 'python-source-v1',
  trustedGradingContractVersion: 'certsim-python-trusted-grading-v1',
});

const STANDARD_CAPABILITIES = [
  'single-choice',
  'multi-select',
  'reorder',
  'drag-drop-match',
  'dropdown-code',
  'dropdown-command',
  'true-false-single-v1',
  'true-false-composite-v1',
  'matching-v1',
  'code-dropdown-completion-v1',
];

const INFORMATIONAL_CAPABILITIES = [
  'case-study-context',
  'informational',
];

export const PBQ_CAPABILITIES = Object.freeze([
  'pbq-terminal',
  'pbq-multi-host-terminal',
  'pbq-firewall',
  'pbq-siem',
  'pbq-network-diagram',
  'pbq-config-panel',
  'pbq-hotspot',
  'pbq-drag-drop-match',
  'pbq-ordering',
  'pbq-workspace',
]);

export const EXECUTABLE_CAPABILITY = 'executable-python-lab-v1';

function compatibility(overrides = {}) {
  return Object.freeze({
    packageSchemaValidation: 'supported',
    responseSaveContract: 'supported',
    scorer: 'supported',
    frontendRuntime: 'supported',
    releasedReview: 'supported',
    practice: 'supported',
    historicalCompatibility: 'supported',
    runtimeRequirement: null,
    ...overrides,
  });
}

const entries = [
  ...STANDARD_CAPABILITIES.map((capability) => [capability, compatibility()]),
  ...INFORMATIONAL_CAPABILITIES.map((capability) => [capability, compatibility({
    responseSaveContract: 'not_applicable',
    scorer: 'not_applicable',
  })]),
  ...PBQ_CAPABILITIES.map((capability) => [capability, compatibility({
    runtimeRequirement: PBQ_RUNTIME_VERSION,
  })]),
  [EXECUTABLE_CAPABILITY, compatibility({
    responseSaveContract: 'dedicated_workspace_contract',
    scorer: 'trusted_grading',
    runtimeRequirement: PYTHON_EXECUTOR_REQUIREMENT,
  })],
];

export const CAPABILITY_COMPATIBILITY_REGISTRY = Object.freeze(
  Object.fromEntries(entries),
);

export const SUPPORTED_RUNTIME_TUPLES = Object.freeze([
  tuple('certsim-ai901-weighted-generator-v2', 'certsim-ai901-exact-scorer-v2'),
  tuple('certsim-az204-grouped-generator-v1', 'certsim-az204-exact-scorer-v1'),
  tuple(
    'certsim-security-plus-pbq-first-generator-v1',
    'certsim-security-plus-authoritative-pbq-scorer-v1',
  ),
  tuple(
    'certsim-az400-case-workspace-generator-v1',
    'certsim-az400-authoritative-scorer-v1',
  ),
  tuple(
    'certsim-sc200-canonical-forms-v1',
    'certsim-selected-response-partial-v1',
  ),
  tuple(
    'certsim-python-standard-canonical-forms-v1',
    'certsim-versioned-structured-partial-v1',
  ),
  tuple(
    'certsim-python-next-generation-canonical-forms-v1',
    'certsim-python-trusted-grading-v1',
    { executable: true },
  ),
]);

export function getCapabilityCompatibility(capability) {
  return CAPABILITY_COMPATIBILITY_REGISTRY[capability] ?? null;
}

export function classifyCapabilityCompatibility(capabilities) {
  const declared = uniqueSorted(capabilities);
  const unsupported = declared.filter(
    (capability) => !getCapabilityCompatibility(capability),
  );
  return Object.freeze({
    verdict: unsupported.length === 0
      ? SUPPORTED_EXISTING_PLATFORM_CAPABILITY
      : PLATFORM_CAPABILITY_CHANGE_REQUIRED,
    supported: declared.filter((capability) => !unsupported.includes(capability)),
    unsupported,
  });
}

export function classifyRuntimeCompatibility(runtime, capabilities) {
  const generatorVersion = text(runtime?.generatorVersion);
  const scorerVersion = text(runtime?.scorerVersion);
  const pbqRuntimeVersion = text(runtime?.pbqRuntimeVersion) || null;
  const declared = new Set(capabilities ?? []);
  const usesPbq = PBQ_CAPABILITIES.some((capability) => declared.has(capability));
  const usesExecutable = declared.has(EXECUTABLE_CAPABILITY);
  const tupleMatch = SUPPORTED_RUNTIME_TUPLES.find((candidate) => (
    candidate.generatorVersion === generatorVersion
      && candidate.scorerVersion === scorerVersion
  ));
  const reasons = [];

  if (!tupleMatch) reasons.push('RUNTIME_TUPLE_UNSUPPORTED');
  if (pbqRuntimeVersion && pbqRuntimeVersion !== PBQ_RUNTIME_VERSION) {
    reasons.push('PBQ_RUNTIME_UNSUPPORTED');
  }
  if (usesPbq && pbqRuntimeVersion !== PBQ_RUNTIME_VERSION) {
    reasons.push('PBQ_RUNTIME_REQUIRED');
  }
  if (usesExecutable && !tupleMatch?.executable) {
    reasons.push('EXECUTOR_REQUIREMENT_UNSUPPORTED');
  }
  if (usesExecutable && pbqRuntimeVersion !== null) {
    reasons.push('EXECUTABLE_PBQ_RUNTIME_CONFLICT');
  }

  return Object.freeze({
    verdict: reasons.length === 0
      ? SUPPORTED_EXISTING_PLATFORM_CAPABILITY
      : PLATFORM_CAPABILITY_CHANGE_REQUIRED,
    generatorVersion,
    scorerVersion,
    pbqRuntimeVersion,
    executorRequirement: usesExecutable ? PYTHON_EXECUTOR_REQUIREMENT : null,
    reasons: uniqueSorted(reasons),
  });
}

export function compareRegistryCapabilitySets(otherCapabilities) {
  const registry = Object.keys(CAPABILITY_COMPATIBILITY_REGISTRY).sort();
  const other = uniqueSorted(otherCapabilities);
  return Object.freeze({
    matches: registry.length === other.length
      && registry.every((capability, index) => capability === other[index]),
    missingFromRegistry: other.filter((capability) => !registry.includes(capability)),
    missingFromComparedLayer: registry.filter((capability) => !other.includes(capability)),
  });
}

export function validatePackageCapabilityRegistryDrift() {
  return compareRegistryCapabilitySets(MULTI_EXAM_QUESTION_CAPABILITIES);
}

function tuple(generatorVersion, scorerVersion, options = {}) {
  return Object.freeze({
    generatorVersion,
    scorerVersion,
    executable: options.executable === true,
  });
}

function uniqueSorted(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .filter((value) => typeof value === 'string' && value),
  )].sort();
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}
