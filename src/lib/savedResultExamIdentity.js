import {
  getExamDisplayMetadata,
} from '../exams/examDisplayMetadata.js';

export const UNKNOWN_EXAM_LABEL = 'Unknown exam';

export function getSavedResultExamLabel(...identities) {
  for (const identity of identities) {
    const metadata = getExamDisplayMetadata(identity);
    if (metadata) return `${metadata.code} — ${metadata.shortTitle}`;
  }

  return UNKNOWN_EXAM_LABEL;
}

export function getSavedResultExamFilterOptions(exams = []) {
  return exams.map((exam) => ({
    label: getSavedResultExamLabel(
      exam?.id,
      exam?.code,
      exam?.shortName,
      exam?.title,
    ),
    value: exam?.id ?? '',
  }));
}
