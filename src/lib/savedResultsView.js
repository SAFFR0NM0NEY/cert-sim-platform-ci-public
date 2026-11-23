import { isPBQQuestion } from '../utils/pbqScoring.js';

export const SAVED_RESULTS_PAGE_SIZE = 10;
export const SAVED_REVIEW_PAGE_SIZE = 10;

export function filterSavedAttempts(results = [], examKey = '') {
  if (!examKey) return results;
  return results.filter((result) => normalize(result.examKey) === normalize(examKey));
}

export function filterSavedReviewItems(items = [], { search = '', filter = 'all' } = {}) {
  const query = normalize(search);
  return items.filter((item) => {
    if (query && !normalize(item.id).includes(query)) return false;
    if (filter === 'all') return true;
    if (filter === 'pbq') return item.isPBQ === true || isPBQQuestion(item);
    if (filter === 'flagged') return item.isFlagged === true;
    return normalize(item.status) === normalize(filter);
  });
}

export function paginateItems(items = [], page = 1, pageSize = 10) {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const start = (currentPage - 1) * pageSize;
  return { currentPage, totalPages, items: items.slice(start, start + pageSize) };
}

export function getReviewFilterCounts(items = []) {
  return {
    all: items.length,
    incorrect: countStatus(items, 'incorrect'),
    incomplete: countStatus(items, 'incomplete'),
    partial: countStatus(items, 'partial'),
    unanswered: countStatus(items, 'unanswered'),
    correct: countStatus(items, 'correct'),
    pbq: items.filter((item) => item.isPBQ === true || isPBQQuestion(item)).length,
    flagged: items.filter((item) => item.isFlagged === true).length,
  };
}

function countStatus(items, status) {
  return items.filter((item) => normalize(item.status) === status).length;
}

function normalize(value) {
  return String(value ?? '').trim().toLowerCase();
}
