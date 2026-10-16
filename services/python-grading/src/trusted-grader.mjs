import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  TRUSTED_GRADING_RUNTIME_TYPES,
  normalizeTrustedGradingObservation,
  normalizeTrustedGradingMaterial,
} from './trusted-grading-contract.mjs';

export const TRUSTED_PROBE_ENTRY_POINT = '__certsim_runtime_probe__.py';
export const TRUSTED_PROBE_RESULT_PREFIX = 'CERTSIM_TRUSTED_PROBE_RESULT=';
const PROBE_HARNESS = readFileSync(new URL('./runtime-probe-harness.py', import.meta.url), 'utf8');
const STRUCTURAL_WORKER = new URL('./trusted-structural-worker.py', import.meta.url);
const MAX_SOURCE_BYTES = 262_144;

export class TrustedPythonGradingError extends Error {
  constructor(code) {
    super(code);
    this.name = 'TrustedPythonGradingError';
    this.code = code;
  }
}

function reject(code) {
  throw new TrustedPythonGradingError(code);
}

function normalizeWorkspace(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'entryPoint,files' ||
      typeof value.entryPoint !== 'string' || !Array.isArray(value.files) ||
      value.files.length < 1 || value.files.length > 16) reject('INVALID_GRADING_WORKSPACE');
  const paths = new Set();
  const files = value.files.map((file) => {
    if (!file || typeof file !== 'object' || Array.isArray(file) ||
        Object.keys(file).sort().join(',') !== 'content,path' ||
        typeof file.path !== 'string' || !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*[.]py$/.test(file.path) ||
        file.path.startsWith('__certsim_') || typeof file.content !== 'string' ||
        Buffer.byteLength(file.content, 'utf8') > MAX_SOURCE_BYTES || paths.has(file.path)) {
      reject('INVALID_GRADING_WORKSPACE');
    }
    paths.add(file.path);
    return { path: file.path, content: file.content };
  });
  if (!paths.has(value.entryPoint)) reject('INVALID_GRADING_WORKSPACE');
  return { entryPoint: value.entryPoint, files };
}

function stripExpected(compiled) {
  const { expectedObservation: _expected, ...probe } = compiled;
  return probe;
}

export function buildTrustedRuntimeProbeWorkspace(workspace, material) {
  const canonicalWorkspace = normalizeWorkspace(workspace);
  const canonicalMaterial = normalizeTrustedGradingMaterial(material);
  const runtimeRules = canonicalMaterial.rules.filter(({ type }) =>
    TRUSTED_GRADING_RUNTIME_TYPES.includes(type));
  if (!runtimeRules.length) return null;
  const probeInput = {
    contractVersion: canonicalMaterial.contractVersion,
    entryPoint: canonicalWorkspace.entryPoint,
    files: canonicalWorkspace.files,
    probes: runtimeRules.map(({ compiled }) => stripExpected(compiled)),
  };
  const payload = Buffer.from(JSON.stringify(probeInput), 'utf8').toString('base64');
  const harness = PROBE_HARNESS.replace('__CERTSIM_PAYLOAD_B64__', payload);
  return Object.freeze({
    entryPoint: TRUSTED_PROBE_ENTRY_POINT,
    files: [{ path: TRUSTED_PROBE_ENTRY_POINT, content: harness }],
  });
}

function pythonCandidates() {
  return process.platform === 'win32'
    ? [['py', ['-3']], ['python', []], ['python3', []]]
    : [['python3', []], ['python', []]];
}

export function evaluateTrustedStructuralRules({ workspace, rules }) {
  const canonicalWorkspace = normalizeWorkspace(workspace);
  const source = canonicalWorkspace.files.find(({ path }) => path === canonicalWorkspace.entryPoint).content;
  const payload = JSON.stringify({ source, rules: rules.map(({ compiled }) => compiled) });
  let unavailable = true;
  for (const [command, prefix] of pythonCandidates()) {
    const result = spawnSync(command, [...prefix, fileURLToPath(STRUCTURAL_WORKER)], {
      encoding: 'utf8', input: payload, timeout: 5_000, maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, PYTHONUTF8: '1' },
    });
    if (result.error?.code === 'ENOENT') continue;
    unavailable = false;
    if (result.status !== 0) reject('STRUCTURAL_GRADING_FAILED');
    try {
      const values = JSON.parse(result.stdout);
      if (!Array.isArray(values) || values.length !== rules.length ||
          values.some((value) => typeof value !== 'boolean')) reject('STRUCTURAL_GRADING_FAILED');
      return values;
    } catch (error) {
      if (error instanceof TrustedPythonGradingError) throw error;
      reject('STRUCTURAL_GRADING_FAILED');
    }
  }
  if (unavailable) reject('TRUSTED_PYTHON_UNAVAILABLE');
  reject('STRUCTURAL_GRADING_FAILED');
}

export function parseTrustedRuntimeProbeObservations(result, expectedCount) {
  if (!result || result.status !== 'finished' || result.outcome !== 'completed' || result.exitCode !== 0 ||
      typeof result.stdout !== 'string' || !Number.isSafeInteger(expectedCount) || expectedCount < 1) {
    reject('RUNTIME_GRADING_INDETERMINATE');
  }
  const matches = result.stdout.split(/\r?\n/).filter((line) => line.startsWith(TRUSTED_PROBE_RESULT_PREFIX));
  if (matches.length !== 1) reject('RUNTIME_GRADING_INDETERMINATE');
  try {
    const observations = JSON.parse(matches[0].slice(TRUSTED_PROBE_RESULT_PREFIX.length));
    if (!Array.isArray(observations) || observations.length !== expectedCount) reject('RUNTIME_GRADING_INDETERMINATE');
    return observations.map((observation) => normalizeTrustedGradingObservation(observation));
  } catch (error) {
    if (error instanceof TrustedPythonGradingError) throw error;
    reject('RUNTIME_GRADING_INDETERMINATE');
  }
}

function sameObservation(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function gradeTrustedPythonWorkspace({
  workspace,
  material,
  executeRuntimeBatch,
  evaluateStructural = evaluateTrustedStructuralRules,
  runtimeRequestId,
}) {
  const canonicalMaterial = normalizeTrustedGradingMaterial(material);
  const canonicalWorkspace = normalizeWorkspace(workspace);
  const structuralRules = canonicalMaterial.rules.filter(({ type }) =>
    !TRUSTED_GRADING_RUNTIME_TYPES.includes(type));
  const runtimeRules = canonicalMaterial.rules.filter(({ type }) =>
    TRUSTED_GRADING_RUNTIME_TYPES.includes(type));
  const structuralResults = structuralRules.length
    ? await evaluateStructural({ workspace: canonicalWorkspace, rules: structuralRules })
    : [];
  if (!Array.isArray(structuralResults) || structuralResults.length !== structuralRules.length ||
      structuralResults.some((value) => typeof value !== 'boolean')) reject('STRUCTURAL_GRADING_FAILED');
  let runtimeResults = [];
  if (runtimeRules.length) {
    if (typeof executeRuntimeBatch !== 'function') reject('RUNTIME_GRADING_UNAVAILABLE');
    const probeWorkspace = buildTrustedRuntimeProbeWorkspace(canonicalWorkspace, canonicalMaterial);
    const terminalResult = await executeRuntimeBatch(Object.freeze({
      requestId: runtimeRequestId ?? `request.${randomUUID()}`,
      workspace: probeWorkspace,
      limits: Object.freeze({ wallTimeMs: 20_000, memoryBytes: 128 * 1024 * 1024, outputBytes: 1024 * 1024 }),
    }));
    const observations = parseTrustedRuntimeProbeObservations(terminalResult, runtimeRules.length);
    runtimeResults = runtimeRules.map(({ compiled }, index) =>
      sameObservation(observations[index], compiled.expectedObservation));
  }
  const structuralById = new Map(structuralRules.map((rule, index) => [rule.id, structuralResults[index]]));
  const runtimeById = new Map(runtimeRules.map((rule, index) => [rule.id, runtimeResults[index]]));
  const rules = canonicalMaterial.rules.map((rule) => ({
    ruleId: rule.id,
    earnedRawPoints: (runtimeById.get(rule.id) ?? structuralById.get(rule.id)) ? rule.points : 0,
    maximumRawPoints: rule.points,
  }));
  const earnedRawPoints = rules.reduce((total, rule) => total + rule.earnedRawPoints, 0);
  return Object.freeze({
    gradingContractVersion: canonicalMaterial.contractVersion,
    earnedRawPoints,
    maximumRawPoints: canonicalMaterial.maximumRawPoints,
    rules,
  });
}
