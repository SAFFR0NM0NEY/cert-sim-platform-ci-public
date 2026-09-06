import {
  getExamLifecycle,
  getLifecycleStatusLabel,
} from '../../exams/examLifecycle.js';
import { getExamDisplaySearchTerms } from '../../exams/examDisplayMetadata.js';

export const EXAM_LIBRARY_DEFAULTS = Object.freeze({
  query: '',
  vendor: 'all',
  lifecycle: 'all',
  sort: 'recommended',
});

export function normalizeExamLibrarySearch(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .toLocaleLowerCase()
    .replace(/\+/g, ' plus ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function buildExamSearchText(exam) {
  return normalizeExamLibrarySearch([
    exam?.code,
    exam?.shortName,
    exam?.name,
    exam?.title,
    exam?.vendor,
    exam?.description,
    exam?.shortDescription,
    exam?.longDescription,
    exam?.statusLabel,
    exam?.statusDescription,
    ...getExamDisplaySearchTerms(exam?.id ?? exam?.slug),
    ...(exam?.domains ?? []),
  ]
    .filter(Boolean)
    .join(' '));
}

export function deriveExamLibraryOptions(exams) {
  const vendors = [...new Set(exams.map((exam) => exam.vendor).filter(Boolean))]
    .sort(compareLabels);
  const lifecycleValues = [...new Set(exams.map(getExamLifecycle).filter(Boolean))]
    .map((value) => ({ value, label: getLifecycleStatusLabel(value) }))
    .sort((left, right) => compareLabels(left.label, right.label));

  return { vendors, lifecycles: lifecycleValues };
}

export function filterAndSortExamLibrary(exams, state = EXAM_LIBRARY_DEFAULTS) {
  const query = normalizeExamLibrarySearch(state.query);
  const indexedExams = exams.map((exam, registryIndex) => ({ exam, registryIndex }));

  const filtered = indexedExams.filter(({ exam }) => {
    const searchText = buildExamSearchText(exam);
    const compactQuery = query.replaceAll(' ', '');
    const matchesQuery = !query || searchText.includes(query) ||
      searchText.replaceAll(' ', '').includes(compactQuery);
    const matchesVendor = state.vendor === 'all' || exam.vendor === state.vendor;
    const matchesLifecycle =
      state.lifecycle === 'all' || getExamLifecycle(exam) === state.lifecycle;

    return matchesQuery && matchesVendor && matchesLifecycle;
  });

  return filtered
    .sort((left, right) => {
      const comparison = compareExamLibrarySort(left.exam, right.exam, state.sort);
      return comparison || left.registryIndex - right.registryIndex;
    })
    .map(({ exam }) => exam);
}

export function isDefaultExamLibraryState(state) {
  return Object.entries(EXAM_LIBRARY_DEFAULTS).every(
    ([key, value]) => state[key] === value,
  );
}

function compareExamLibrarySort(left, right, sort) {
  if (sort === 'name') {
    return compareLabels(left.name ?? left.title, right.name ?? right.title);
  }

  if (sort === 'vendor') {
    return compareLabels(left.vendor, right.vendor);
  }

  if (sort === 'lifecycle') {
    return compareLabels(
      getLifecycleStatusLabel(getExamLifecycle(left)),
      getLifecycleStatusLabel(getExamLifecycle(right)),
    );
  }

  return 0;
}

function compareLabels(left, right) {
  return String(left ?? '').localeCompare(String(right ?? ''), undefined, {
    sensitivity: 'base',
  });
}
