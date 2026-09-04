import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { examRegistry } from '../src/exams/examRegistry.protected.js';
import { loadAllProtectedHistory, partitionProtectedHistory, validateProtectedHistoryPage } from '../src/lib/protectedHistory.js';
import { getAttemptKindLabel } from '../src/lib/attemptPurpose.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [migration, routes, handler, responses, client, savedResults, progress, trainer, app] = await Promise.all([
  read('supabase/migrations/20260901203655_protected_unified_history_analytics.sql'),
  read('supabase/functions/certsim-protected-exam/routes.ts'),
  read('supabase/functions/certsim-protected-exam/handler.ts'),
  read('supabase/functions/certsim-protected-exam/responses.ts'),
  read('src/lib/protectedExamClient.js'),
  read('src/protected/ProtectedSavedResultsPage.jsx'),
  read('src/lib/studentProgressService.js'),
  read('src/lib/trainerDashboardService.js'),
  read('src/App.jsx'),
]);

const fixture = (id, completedAt, overrides = {}) => ({ attemptId: id, examKey: 'az204', packageVersion: '1.1.0', profileKey: 'compact-profile', purpose: 'self_directed_exam', completedAt, score: 35, percentage: 70, passed: true, domainSummary: {}, serverAuthoritative: true, reviewStatus: 'withheld', source: 'protected', ...overrides });
const pages = [
  { items: [fixture('00000000-0000-4000-8000-000000000003', '2026-09-01T03:00:00Z'), fixture('00000000-0000-4000-8000-000000000002', '2026-09-01T02:00:00Z', { purpose: 'weak_area' })], returnedCount: 2, totalCount: 3, remainingCount: 1, nextCursor: 'cursor-1' },
  { items: [fixture('00000000-0000-4000-8000-000000000001', '2026-09-01T01:00:00Z', { purpose: 'unclassified', source: 'legacy_authoritative', serverAuthoritative: false })], returnedCount: 1, totalCount: 3, remainingCount: 0, nextCursor: null },
];
let request = 0;
const traversal = await loadAllProtectedHistory({ listHistory: async () => pages[request++] });
assert.equal(traversal.items.length, 3);
assert.deepEqual(partitionProtectedHistory(traversal.items).assessments.map((row) => row.attemptId), ['00000000-0000-4000-8000-000000000003']);
assert.equal(partitionProtectedHistory(traversal.items).practice.length, 1);
assert.equal(partitionProtectedHistory(traversal.items).historical.length, 1);
assert.throws(() => validateProtectedHistoryPage({ ...pages[0], returnedCount: 1 }), /invalid_history_count/);
assert.throws(() => validateProtectedHistoryPage({ ...pages[0], nextCursor: {} }), /invalid_history_cursor/);
await assert.rejects(() => loadAllProtectedHistory({ listHistory: async ({ cursor }) => cursor ? { ...pages[1], items: [pages[0].items[0]] } : pages[0] }), /duplicate_history_item/);

const profiles = examRegistry.flatMap((exam) => exam.strictBetaProfiles.map((profile) => ({ exam, profile })));
assert.equal(profiles.length, 11);
assert.deepEqual(Object.fromEntries(examRegistry.map((exam) => [exam.id, exam.strictBetaProfiles.length])), { az204: 4, 'security-plus-sy0-701': 2, az400: 3, ai901: 2 });
for (const { exam, profile } of profiles) {
  assert.ok(profile.routeAction);
  assert.ok(profile.description);
  assert.ok(Number.isInteger(profile.totalScoredQuestions));
  assert.ok(Number.isInteger(profile.timeLimitMinutes));
  assert.equal(profile.availabilityStatus, 'available');
  const visible = [exam.statusLabel, exam.statusNote, exam.shortDescription, exam.longDescription, profile.name, profile.displayName, profile.description].join(' ');
  assert.doesNotMatch(visible, /\bbeta\b|trainer validation pending/i);
}
assert.equal(new Set(profiles.map(({ exam, profile }) => `${exam.slug}/${profile.routeAction}`)).size, 11);
assert.match(app, /protectedDeliveryMode === DELIVERY_MODES\.protected[\s\S]*getStrictProfileRouteAction/);
assert.match(app, /return routeAction \? `\$\{dashboardPath\}\/\$\{routeAction\}` : null/);

assert.match(savedResults, /getPrintableSummary/);
assert.equal(getAttemptKindLabel(pages[1].items[0]), 'Historical attempt (type unavailable)');
assert.match(savedResults, /reviewStatus === 'released'/);
assert.match(savedResults, /Browser-only records remain separate/);
assert.match(progress, /loadProtectedHistoryPage/);
assert.match(progress, /getHistorySummary/);
assert.doesNotMatch(progress, /loadAllProtectedHistory/);
assert.match(progress, /historicalActivityCount/);
assert.doesNotMatch(trainer, /getStaffAnalytics/);
assert.match(trainer, /Protected institutional analytics comes from the assignment-scoped DTO/);
assert.match(trainer, /getPrintableSummary/);

assert.match(migration, /exam_entitlements_revoked_by_idx/);
assert.match(migration, /revoke execute on function public\.certsim_grant_purchase_entitlement[\s\S]*authenticated/);
assert.match(migration, /create function exam_delivery\.staff_analytics/);
assert.match(migration, /security definer[\s\S]*set search_path=''[\s\S]*set statement_timeout='12s'/);
assert.match(migration, /a\.user_id is not null/);
assert.match(migration, /exam_delivery\.staff_can_view_learner/);
assert.match(migration, /role='reception'/);
assert.match(migration, /grant execute on function exam_delivery\.staff_analytics\(uuid\)[\s\S]*to service_role/);
for (const source of [routes, handler]) assert.match(source, /staffAnalytics/);
assert.match(responses, /mapStaffAnalytics/);
assert.match(client, /getStaffAnalytics/);
const analyticsMapper = responses.slice(responses.indexOf('export function mapStaffAnalytics'), responses.indexOf('export function mapHistorySummary'));
for (const forbidden of ['questionText', 'correctAnswer', 'explanation', 'protectedSnapshot', 'scoringRules']) assert.doesNotMatch(analyticsMapper, new RegExp(`"${forbidden}"`));

console.log(JSON.stringify({ ok: true, historyPages: 2, historyRows: 3, profiles: profiles.length, routes: profiles.length, hostedMutation: false }));
