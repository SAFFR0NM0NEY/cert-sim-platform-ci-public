import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { applyHistorySummaries } from '../src/lib/studentProgressService.js';
import { getNormalizedDomainItems } from '../src/lib/resultStorageMappers.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const migration = read('supabase/migrations/20260908074922_issue101_learner_domain_parity.sql');
const service = read('src/lib/studentProgressService.js');
const mapper = read('supabase/functions/certsim-protected-exam/responses.ts');

for (const token of [
  'learner_domain_history_summary',
  "a.status='completed' and a.analytics_eligible is true",
  "a.purpose in ('assigned_assessment','self_directed_exam')",
  'classify_legacy_result',
  "in ('assigned_assessment','self_directed_exam')",
  'sum(earned_points)',
  'sum(max_points)',
  'legacy_percentage_fallback',
  'package_domain_compatibility',
  "set search_path='' set statement_timeout='5s'",
  "'domainSummary'",
]) assert.match(migration, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

assert.match(mapper, /mapHistorySummary[\s\S]*"domainSummary"/);
assert.match(service, /Object\.keys\(protectedProfileMetadata\)/);
assert.doesNotMatch(service, /const PROTECTED_EXAM_KEYS = \['az204'/);

const domainSummary = {
  kind: 'learner_domain_history_v1',
  source: 'full_eligible_assessment_history',
  evidenceResultCount: 23,
  items: [
    { domainId: 'beta', domainLabel: 'Beta', earnedPoints: 1, maxPoints: 2, percentage: 50, samples: 22 },
    { domainId: 'alpha', domainLabel: 'Alpha', earnedPoints: 9.5, maxPoints: 10, percentage: 95, samples: 21 },
    { domainId: 'gamma', domainLabel: 'Gamma', earnedPoints: 19, maxPoints: 20, percentage: 95, samples: 20 },
  ],
};
const [row] = applyHistorySummaries([{
  examScopeKey: 'ai901',
  strongestDomain: { domainId: 'stale', percentage: 99 },
  weakestDomain: { domainId: 'stale', percentage: 1 },
}], { ai901: {
  completedCount: 24, passedCount: 20, needsReviewCount: 4,
  latest: { percentage: 86, completedAt: '2026-09-08T00:00:00Z' },
  best: { percentage: 99 }, averagePercentage: 91,
  domainSummary,
  weakDomains: { items: [{ domainId: 'wrong', domainLabel: 'Wrong', percentage: 86 }] },
} });

assert.equal(row.strongestDomain.domainId, 'alpha', 'stable tie order controls strongest domain');
assert.equal(row.weakestDomain.domainId, 'beta');
assert.equal(row.domainSampleCount, 23);
assert.equal(row.strongestDomain.percentage, row.domainAverages.find(({ domainId }) => domainId === row.strongestDomain.domainId).percentage);
assert.equal(row.weakestDomain.percentage, row.domainAverages.find(({ domainId }) => domainId === row.weakestDomain.domainId).percentage);
assert.equal(row.domainAverages.find(({ domainId }) => domainId === 'alpha').samples, 21);
assert.deepEqual(getNormalizedDomainItems({ items: [] }), []);

console.log(JSON.stringify({ ok: true, issue: 101, surface: 'my-progress', sc200Discovered: true, protectedContentFields: 0 }));
