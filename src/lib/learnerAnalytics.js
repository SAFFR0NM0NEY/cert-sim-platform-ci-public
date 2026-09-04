import { isAssessmentResult } from './attemptPurpose.js';
import { getNormalizedDomainItems } from './resultStorageMappers.js';

export function aggregateWeakDomains(results = [], threshold = 70) {
  const domains = new Map();
  results.filter(isAssessmentResult).forEach((result) => {
    getNormalizedDomainItems(result.domainSummary ?? result.domainBreakdown).forEach((row) => {
      if (row.earnedPoints == null || row.maxPoints == null || row.maxPoints <= 0) return;
      const id = normalizeDomainKey(row.domainId || row.domainLabel);
      const current = domains.get(id) ?? { id, label: row.domainLabel, earned: 0, maximum: 0, samples: 0 };
      current.earned += Number(row.earnedPoints);
      current.maximum += Number(row.maxPoints);
      current.samples += 1;
      domains.set(id, current);
    });
  });
  return [...domains.values()]
    .map((row) => ({ ...row, percentage: 100 * row.earned / row.maximum }))
    .filter((row) => row.percentage < threshold)
    .sort((left, right) => left.percentage - right.percentage || left.label.localeCompare(right.label));
}

function normalizeDomainKey(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
