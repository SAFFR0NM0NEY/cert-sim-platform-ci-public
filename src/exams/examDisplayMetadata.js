const definitions = [
  {
    canonicalId: 'az204',
    routeSlug: 'az204',
    code: 'AZ-204',
    shortTitle: 'Developing Solutions for Microsoft Azure',
    fullTitle: 'AZ-204: Developing Solutions for Microsoft Azure',
    vendor: 'Microsoft',
    aliases: ['AZ 204'],
    internalAliases: [],
    searchAliases: ['Developing Solutions', 'Microsoft Azure'],
  },
  {
    canonicalId: 'security-plus-sy0-701',
    routeSlug: 'security-plus',
    code: 'SY0-701',
    shortTitle: 'Security+',
    fullTitle: 'CompTIA Security+ (SY0-701)',
    vendor: 'CompTIA',
    aliases: ['SY0701', 'Security Plus'],
    internalAliases: ['securityplussy0701'],
    searchAliases: ['CompTIA Security+', 'CompTIA'],
  },
  {
    canonicalId: 'az400',
    routeSlug: 'az400',
    code: 'AZ-400',
    shortTitle: 'Designing and Implementing Microsoft DevOps Solutions',
    fullTitle: 'AZ-400: Designing and Implementing Microsoft DevOps Solutions',
    vendor: 'Microsoft',
    aliases: ['AZ 400'],
    internalAliases: [],
    searchAliases: ['DevOps Solutions', 'Microsoft DevOps'],
  },
  {
    canonicalId: 'ai901',
    routeSlug: 'ai901',
    code: 'AI-901',
    shortTitle: 'Azure AI Fundamentals',
    fullTitle: 'Microsoft Azure AI Fundamentals',
    vendor: 'Microsoft',
    aliases: ['AI 901'],
    internalAliases: [],
    searchAliases: ['Azure AI', 'AI Fundamentals'],
  },
];

export function normalizeExamDisplayIdentity(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .toLocaleLowerCase()
    .replace(/\+/g, 'plus')
    .replace(/[^a-z0-9]+/g, '');
}

const frozenDefinitions = definitions.map((definition) => Object.freeze({
  ...definition,
  aliases: Object.freeze([...definition.aliases]),
  internalAliases: Object.freeze([...definition.internalAliases]),
  searchAliases: Object.freeze([...definition.searchAliases]),
}));

const aliasIndex = new Map();
const canonicalIds = new Set();
const routeSlugs = new Set();
const codes = new Set();
for (const definition of frozenDefinitions) {
  for (const field of ['canonicalId', 'routeSlug', 'code', 'shortTitle', 'fullTitle', 'vendor']) {
    if (!String(definition[field] ?? '').trim()) throw new Error(`Exam display metadata is missing ${field}.`);
  }
  for (const [value, set, label] of [
    [definition.canonicalId, canonicalIds, 'canonical ID'],
    [definition.routeSlug, routeSlugs, 'route slug'],
    [definition.code, codes, 'code'],
  ]) {
    const normalized = normalizeExamDisplayIdentity(value);
    if (set.has(normalized)) throw new Error(`Duplicate exam display ${label}: ${value}`);
    set.add(normalized);
  }
  for (const alias of [definition.canonicalId, definition.routeSlug, definition.code, definition.shortTitle, definition.fullTitle, ...definition.aliases, ...definition.internalAliases]) {
    const normalized = normalizeExamDisplayIdentity(alias);
    const existing = aliasIndex.get(normalized);
    if (existing && existing.canonicalId !== definition.canonicalId) {
      throw new Error(`Exam display alias collision: ${alias}`);
    }
    aliasIndex.set(normalized, definition);
  }
}

export const examDisplayMetadata = Object.freeze(frozenDefinitions);

export function getExamDisplayMetadata(identity) {
  return aliasIndex.get(normalizeExamDisplayIdentity(identity)) ?? null;
}

export function getExamDisplayLabel(identity, { fallback = 'Exam', field = 'fullTitle' } = {}) {
  const metadata = getExamDisplayMetadata(identity);
  return metadata?.[field] || String(fallback || 'Exam').trim() || 'Exam';
}

export function getExamDisplaySearchTerms(identity) {
  const metadata = getExamDisplayMetadata(identity);
  return metadata
    ? [metadata.code, metadata.shortTitle, metadata.fullTitle, metadata.vendor, ...metadata.searchAliases]
    : [];
}
