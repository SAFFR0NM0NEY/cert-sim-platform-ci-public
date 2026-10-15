import { createHash } from 'node:crypto';

export const TRUSTED_GRADING_CONTRACT_VERSION = 'certsim-python-trusted-grading-v1';
export const TRUSTED_GRADING_RUNTIME_TYPES = Object.freeze([
  'filesystem', 'filesystem_cli', 'filesystem_cwd', 'function_call',
  'introspection', 'seeded_random', 'stdin_stdout', 'stdout_cli', 'unittest',
]);
export const TRUSTED_GRADING_STRUCTURAL_TYPES = Object.freeze(['AST', 'AST-negative', 'TOKEN']);

const MATERIAL_KEYS = ['contractVersion', 'maximumRawPoints', 'rules', 'taskId'];
const RULE_KEYS = ['compiled', 'id', 'points', 'type'];
const OBSERVATION_KEYS = ['argumentsAfter', 'argvRestored', 'cwdUnchanged', 'files', 'handlesReleased', 'result', 'status', 'stderr', 'stdout'];
const SETUP_KEYS = ['content', 'kind', 'name'];
const NODE_REQUIREMENT_KEYS = ['minimum', 'type'];
const RUNTIME_KEYS = Object.freeze({
  function_call: ['arguments', 'contractVersion', 'expectedObservation', 'family', 'keywordArguments', 'repeat', 'target'],
  seeded_random: ['arguments', 'contractVersion', 'expectedObservation', 'family', 'keywordArguments', 'repeat', 'seed', 'target'],
  introspection: ['attribute', 'contractVersion', 'expectedObservation', 'family', 'target'],
  stdin_stdout: ['contractVersion', 'expectedObservation', 'family', 'inputs', 'target'],
  stdout_cli: ['argv', 'contractVersion', 'expectedObservation', 'family', 'target'],
  filesystem: ['arguments', 'captureCwd', 'captureHandles', 'capturePaths', 'contractVersion', 'expectedObservation', 'family', 'repeat', 'setup', 'target'],
  filesystem_cli: ['argv', 'captureHandles', 'capturePaths', 'contractVersion', 'expectedObservation', 'family', 'setup', 'target'],
  filesystem_cwd: ['arguments', 'captureCwd', 'contractVersion', 'expectedObservation', 'family', 'setup', 'target'],
  unittest: ['contractVersion', 'expectedObservation', 'family', 'operation', 'target'],
});
const STRUCTURAL_KEYS = Object.freeze({
  ast_features: ['contractVersion', 'family', 'forbiddenAttributes', 'forbiddenCalls', 'orderedNames', 'requireDynamicReturn', 'requiredAttributes', 'requiredCalls', 'requiredDefinitions', 'requiredLiterals', 'requiredNames', 'requiredNodes', 'requiredOperators'],
  ast_docstring: ['contractVersion', 'expected', 'family', 'target'],
  ast_signature: ['contractVersion', 'defaults', 'family', 'parameters', 'target'],
  ast_absence: ['contractVersion', 'family', 'forbiddenAttributes', 'forbiddenCalls'],
  token_comment: ['anchor', 'anchorOccurrence', 'contractVersion', 'family', 'relation', 'requiredConceptGroups', 'target'],
});
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_.]{0,127}$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PATH_NAME = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const TYPES = new Set([...TRUSTED_GRADING_RUNTIME_TYPES, ...TRUSTED_GRADING_STRUCTURAL_TYPES]);

export class TrustedGradingContractError extends Error {
  constructor(code) {
    super(code);
    this.name = 'TrustedGradingContractError';
    this.code = code;
  }
}

function reject(code = 'INVALID_TRUSTED_GRADING_MATERIAL') {
  throw new TrustedGradingContractError(code);
}

function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) reject();
  return value;
}

function exact(value, keys) {
  record(value);
  const actual = Object.keys(value).sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) reject();
}

function text(value, { pattern, maximum = 4096, allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.length < 1) ||
      Buffer.byteLength(value, 'utf8') > maximum || (pattern && !pattern.test(value))) reject();
  return value;
}

function integer(value, { minimum = 0, maximum = 1_000_000 } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) reject();
  return value;
}

function stringArray(value, options = {}) {
  if (!Array.isArray(value) || value.length > (options.maximumItems ?? 256)) reject();
  return value.map((item) => text(item, { maximum: options.maximumBytes ?? 4096, allowEmpty: options.allowEmpty ?? false, pattern: options.pattern }));
}

export function normalizeTypedValue(value, depth = 0) {
  if (depth > 16) reject();
  record(value);
  const kind = value.type;
  if (!['none', 'bool', 'int', 'float', 'string', 'bytes', 'list', 'tuple', 'set', 'dict', 'object', 'exception'].includes(kind)) reject();
  if (kind === 'none') { exact(value, ['type']); return { type: kind }; }
  if (kind === 'bool') { exact(value, ['type', 'value']); if (typeof value.value !== 'boolean') reject(); return { type: kind, value: value.value }; }
  if (kind === 'int') { exact(value, ['type', 'value']); text(value.value, { pattern: /^-?(?:0|[1-9][0-9]*)$/, maximum: 512 }); return { type: kind, value: value.value }; }
  if (kind === 'float') { exact(value, ['type', 'value']); text(value.value, { pattern: /^(?:-?0x[0-9a-f.]+p[+-][0-9]+|nan|infinity|-infinity)$/i, maximum: 128 }); return { type: kind, value: value.value.toLowerCase() }; }
  if (kind === 'string' || kind === 'bytes') { exact(value, ['type', 'value']); text(value.value, { maximum: 1_048_576, allowEmpty: true, ...(kind === 'bytes' ? { pattern: /^(?:[a-f0-9]{2})*$/ } : {}) }); return { type: kind, value: value.value }; }
  if (['list', 'tuple', 'set'].includes(kind)) {
    exact(value, ['items', 'type']);
    if (!Array.isArray(value.items) || value.items.length > 4096) reject();
    return { type: kind, items: value.items.map((item) => normalizeTypedValue(item, depth + 1)) };
  }
  if (kind === 'dict') {
    exact(value, ['items', 'type']);
    if (!Array.isArray(value.items) || value.items.length > 4096) reject();
    return { type: kind, items: value.items.map((pair) => {
      if (!Array.isArray(pair) || pair.length !== 2) reject();
      return [normalizeTypedValue(pair[0], depth + 1), normalizeTypedValue(pair[1], depth + 1)];
    }) };
  }
  exact(value, ['class', 'type']);
  return { type: kind, class: text(value.class, { pattern: /^[A-Za-z_][A-Za-z0-9_]{0,127}$/ }) };
}

export function normalizeTrustedGradingObservation(value) {
  exact(value, OBSERVATION_KEYS);
  if (!['completed', 'error'].includes(value.status) || typeof value.cwdUnchanged !== 'boolean' ||
      typeof value.argvRestored !== 'boolean' || typeof value.handlesReleased !== 'boolean') reject();
  if (!Array.isArray(value.argumentsAfter) || value.argumentsAfter.length > 128 ||
      !Array.isArray(value.files) || value.files.length > 128) reject();
  return {
    status: value.status,
    result: normalizeTypedValue(value.result),
    argumentsAfter: value.argumentsAfter.map((item) => normalizeTypedValue(item)),
    stdout: text(value.stdout, { maximum: 1_048_576, allowEmpty: true }),
    stderr: text(value.stderr, { maximum: 1_048_576, allowEmpty: true }),
    files: value.files.map((item) => {
      exact(item, ['content', 'kind', 'name']);
      if (!['file', 'directory', 'missing'].includes(item.kind)) reject();
      return { name: text(item.name, { pattern: PATH_NAME, maximum: 240 }), kind: item.kind, content: text(item.content, { maximum: 1_048_576, allowEmpty: true }) };
    }),
    cwdUnchanged: value.cwdUnchanged,
    argvRestored: value.argvRestored,
    handlesReleased: value.handlesReleased,
  };
}

function normalizeSetup(value) {
  if (!Array.isArray(value) || value.length > 64) reject();
  return value.map((item) => {
    exact(item, SETUP_KEYS);
    if (!['file', 'directory'].includes(item.kind)) reject();
    return { name: text(item.name, { pattern: PATH_NAME, maximum: 240 }), kind: item.kind, content: text(item.content, { maximum: 1_048_576, allowEmpty: true }) };
  });
}

function normalizeArgument(value) {
  record(value);
  if (value.kind === 'path') {
    exact(value, ['kind', 'name']);
    return { kind: 'path', name: text(value.name, { pattern: /^(?:\.|[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)$/, maximum: 240 }) };
  }
  exact(value, ['kind', 'value']);
  if (value.kind !== 'value') reject();
  return { kind: 'value', value: normalizeTypedValue(value.value) };
}

function normalizeRuntime(compiled, type) {
  const keys = RUNTIME_KEYS[type];
  exact(compiled, keys);
  if (compiled.contractVersion !== TRUSTED_GRADING_CONTRACT_VERSION || compiled.family !== type) reject();
  const result = { ...compiled, expectedObservation: normalizeTrustedGradingObservation(compiled.expectedObservation) };
  if ('target' in compiled) result.target = text(compiled.target, { pattern: IDENTIFIER, maximum: 128 });
  if ('arguments' in compiled) {
    if (!Array.isArray(compiled.arguments) || compiled.arguments.length > 64) reject();
    result.arguments = type === 'filesystem' || type === 'filesystem_cwd'
      ? compiled.arguments.map(normalizeArgument)
      : compiled.arguments.map((item) => normalizeTypedValue(item));
  }
  if ('keywordArguments' in compiled) {
    record(compiled.keywordArguments);
    result.keywordArguments = Object.fromEntries(Object.entries(compiled.keywordArguments).map(([key, value]) => [text(key, { pattern: IDENTIFIER, maximum: 128 }), normalizeTypedValue(value)]));
  }
  if ('repeat' in compiled) result.repeat = integer(compiled.repeat, { minimum: 1, maximum: 16 });
  if ('seed' in compiled) result.seed = integer(compiled.seed, { minimum: -2_147_483_648, maximum: 2_147_483_647 });
  if ('inputs' in compiled) result.inputs = stringArray(compiled.inputs, { allowEmpty: true, maximumItems: 128, maximumBytes: 65_536 });
  if ('argv' in compiled) {
    if (!Array.isArray(compiled.argv) || compiled.argv.length > 128) reject();
    result.argv = compiled.argv.map((item) => typeof item === 'string' ? text(item, { maximum: 65_536, allowEmpty: true }) : normalizeArgument(item));
  }
  if ('setup' in compiled) result.setup = normalizeSetup(compiled.setup);
  if ('capturePaths' in compiled) result.capturePaths = stringArray(compiled.capturePaths, { maximumItems: 128, pattern: PATH_NAME, maximumBytes: 240 });
  for (const key of ['captureCwd', 'captureHandles']) if (key in compiled && typeof compiled[key] !== 'boolean') reject();
  if ('operation' in compiled && !['is_test_case', 'case_count', 'run_suite', 'callable_test_method'].includes(compiled.operation)) reject();
  if ('attribute' in compiled && compiled.attribute !== '__doc__') reject();
  return result;
}

function normalizeStructural(compiled) {
  const keys = STRUCTURAL_KEYS[compiled?.family];
  if (!keys) reject();
  exact(compiled, keys);
  if (compiled.contractVersion !== TRUSTED_GRADING_CONTRACT_VERSION) reject();
  if (compiled.family === 'ast_docstring') return { ...compiled, target: text(compiled.target, { pattern: /^(?:module|[A-Za-z_][A-Za-z0-9_]*)$/ }), expected: text(compiled.expected, { maximum: 65_536, allowEmpty: true }) };
  if (compiled.family === 'ast_signature') {
    if (!Array.isArray(compiled.defaults) || compiled.defaults.length > 128) reject();
    return { ...compiled, target: text(compiled.target, { pattern: IDENTIFIER }), parameters: stringArray(compiled.parameters, { pattern: IDENTIFIER }), defaults: compiled.defaults.map((item) => normalizeTypedValue(item)) };
  }
  if (compiled.family === 'ast_absence') return { ...compiled, forbiddenCalls: stringArray(compiled.forbiddenCalls, { pattern: IDENTIFIER }), forbiddenAttributes: stringArray(compiled.forbiddenAttributes, { pattern: IDENTIFIER }) };
  if (compiled.family === 'token_comment') {
    if (!['For', 'Return'].includes(compiled.anchor)
        || compiled.relation !== 'immediately_before_same_block'
        || !Array.isArray(compiled.requiredConceptGroups)
        || compiled.requiredConceptGroups.length < 2
        || compiled.requiredConceptGroups.length > 8) reject();
    const requiredConceptGroups = compiled.requiredConceptGroups.map((group) => {
      const normalized = stringArray(group, { maximumItems: 32, pattern: /^[a-z][a-z0-9_-]{0,63}$/ });
      if (!normalized.length || new Set(normalized).size !== normalized.length) reject();
      return normalized;
    });
    return {
      ...compiled,
      target: text(compiled.target, { pattern: /^[A-Za-z_][A-Za-z0-9_]{0,127}$/ }),
      anchorOccurrence: integer(compiled.anchorOccurrence, { minimum: 1, maximum: 128 }),
      requiredConceptGroups,
    };
  }
  if (!Array.isArray(compiled.requiredNodes) || !Array.isArray(compiled.requiredLiterals) ||
      typeof compiled.requireDynamicReturn !== 'boolean') reject();
  return {
    ...compiled,
    requiredNodes: compiled.requiredNodes.map((item) => { exact(item, NODE_REQUIREMENT_KEYS); return { type: text(item.type, { pattern: /^[A-Za-z][A-Za-z0-9]{0,63}$/ }), minimum: integer(item.minimum, { minimum: 1, maximum: 128 }) }; }),
    requiredCalls: stringArray(compiled.requiredCalls, { pattern: IDENTIFIER }),
    requiredNames: stringArray(compiled.requiredNames, { pattern: IDENTIFIER }),
    requiredDefinitions: stringArray(compiled.requiredDefinitions, { pattern: IDENTIFIER }),
    requiredAttributes: stringArray(compiled.requiredAttributes, { pattern: IDENTIFIER }),
    requiredLiterals: compiled.requiredLiterals.map((item) => normalizeTypedValue(item)),
    requiredOperators: stringArray(compiled.requiredOperators, { pattern: /^[A-Za-z][A-Za-z0-9]{0,63}$/ }),
    forbiddenCalls: stringArray(compiled.forbiddenCalls, { pattern: IDENTIFIER }),
    forbiddenAttributes: stringArray(compiled.forbiddenAttributes, { pattern: IDENTIFIER }),
    orderedNames: stringArray(compiled.orderedNames, { pattern: IDENTIFIER }),
  };
}

export function normalizeTrustedGradingMaterial(value) {
  exact(value, MATERIAL_KEYS);
  if (value.contractVersion !== TRUSTED_GRADING_CONTRACT_VERSION) reject();
  const maximumRawPoints = integer(value.maximumRawPoints, { minimum: 1 });
  if (!Array.isArray(value.rules) || value.rules.length < 1 || value.rules.length > 128) reject();
  const ids = new Set();
  const rules = value.rules.map((rule) => {
    exact(rule, RULE_KEYS);
    const id = text(rule.id, { pattern: OPAQUE_ID, maximum: 128 });
    if (ids.has(id) || !TYPES.has(rule.type)) reject();
    ids.add(id);
    const points = integer(rule.points, { minimum: 1 });
    return { id, type: rule.type, points, compiled: TRUSTED_GRADING_RUNTIME_TYPES.includes(rule.type) ? normalizeRuntime(rule.compiled, rule.type) : normalizeStructural(rule.compiled) };
  });
  if (rules.reduce((total, rule) => total + rule.points, 0) !== maximumRawPoints) {
    reject('INCOMPLETE_TRUSTED_GRADING_MATERIAL');
  }
  return Object.freeze({ contractVersion: value.contractVersion, taskId: text(value.taskId, { pattern: OPAQUE_ID, maximum: 128 }), maximumRawPoints, rules });
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export function canonicalizeTrustedGradingMaterial(value) {
  return canonicalJson(normalizeTrustedGradingMaterial(value));
}

export function createTrustedGradingMaterialDigest(value) {
  return createHash('sha256').update(canonicalizeTrustedGradingMaterial(value)).digest('hex');
}
