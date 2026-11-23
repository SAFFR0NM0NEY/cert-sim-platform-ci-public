import { domainDisplayMetadata } from '../exams/domainDisplayMetadata.js';
import { getExamDisplayMetadata } from '../exams/examDisplayMetadata.js';
import { getNormalizedDomainItems } from './resultStorageMappers.js';

export const DOMAIN_LABEL_UNAVAILABLE = 'Domain label unavailable';
const text = value => typeof value === 'string' ? value.trim() : '';
const ownLabel = (domains, id) => domains && Object.hasOwn(domains, id) && typeof domains[id] === 'string'
  ? domains[id] : undefined;
const slug = value => text(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function readable(value, id) {
  const label = text(value);
  const tail = label.split(':').at(-1).trim();
  return label && /[a-z]/i.test(tail) && !/^domain[-_\s]*\d+$/i.test(tail)
    && !/^[a-z]+[A-Z][a-zA-Z0-9]*$/.test(tail)
    && !/^[a-z0-9_.]+(?:[-_:][a-z0-9_.]+)+$/i.test(tail)
    && !(tail === id && !/\s/.test(tail) && tail === tail.toLowerCase());
}

// Display projection only. No domain identity, scores, mappings or stored rows
// are changed. Never infer a historical version from the current catalogue.
export function getDomainDisplayLabel(row = {}, context = {}, metadata = domainDisplayMetadata) {
  const id = text(row.domainId ?? row.domainKey ?? row.id ?? row.domain ?? row.label);
  for (const value of [row.displayLabel, row.domainLabel, row.label, row.name, row.domain]) {
    if (readable(value, id)) return text(value);
  }
  const examKey = row.examKey ?? context.examKey ?? context.examScopeKey ?? context.exam?.key;
  const exam = getExamDisplayMetadata(examKey)?.canonicalId;
  const versions = metadata[exam];
  if (!versions || !id) return DOMAIN_LABEL_UNAVAILABLE;
  const version = row.packageVersion ?? context.packageVersion ?? context.package?.version;
  if (version != null && version !== '') {
    return (Object.hasOwn(versions, version) ? ownLabel(versions[version], id) : undefined)
      ?? DOMAIN_LABEL_UNAVAILABLE;
  }
  // Missing-version compatibility is lexical only: an explicitly known slug
  // must be the canonical spelling of its label, with no version disagreement.
  // Positional IDs and renamed semantic aliases never receive current names.
  const labels = Object.values(versions).map(domains => ownLabel(domains, id)).filter(Boolean);
  return labels.length && new Set(labels).size === 1 && slug(labels[0]) === id
    ? labels[0] : DOMAIN_LABEL_UNAVAILABLE;
}

export function getDisplayDomainItems(value, context = {}) {
  return getNormalizedDomainItems(value).map(row => ({
    ...row, domainLabel: getDomainDisplayLabel(row, context),
  }));
}

export function agreeDomainLabels(left, right) {
  return left === right ? left : DOMAIN_LABEL_UNAVAILABLE;
}
