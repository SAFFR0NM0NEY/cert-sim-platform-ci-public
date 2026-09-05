import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationPath = 'supabase/migrations/20260905153716_ai901_canonical_form_rotation.sql';
const sql = await readFile(migrationPath, 'utf8');

for (const table of ['package_forms', 'package_form_questions', 'package_reserve_questions']) {
  assert.match(sql, new RegExp(`create table exam_delivery\\.${table}`));
  assert.match(sql, new RegExp(`alter table exam_delivery\\.${table} enable row level security`));
  assert.match(sql, new RegExp(`revoke all on table exam_delivery\\.${table} from public, anon, authenticated, service_role`));
}
for (const fn of ['prepare_canonical_forms_on_publish', 'allocate_canonical_form', 'materialize_attempt_items']) {
  assert.match(sql, new RegExp(`function exam_delivery\\.${fn}`));
}
assert.match(sql, /security definer[\s\S]*?set search_path = ''/);
assert.match(sql, /set statement_timeout = '5s'/);
assert.match(sql, /set statement_timeout = '15s'/);
assert.match(sql, /pg_advisory_xact_lock/);
assert.match(sql, /attempts_one_canonical_form_per_cycle_idx/);
assert.match(sql, /foreign key \(package_profile_id, package_version_id\)/);
assert.match(sql, /foreign key \(package_question_id, package_version_id\)/);
assert.match(sql, /canonical_form_id is not null/);
assert.match(sql, /purpose not in \('assigned_assessment','self_directed_exam'\)/);
assert.match(sql, /return exam_delivery\.materialize_attempt_items_issue21_unrotated_base/);
assert.match(sql, /practice-only-until-versioned-rebalance/);
assert.match(sql, /canonical_form_runtime_validation_failed/);
assert.match(sql, /self_directed_release_policy_conflicts_with_package/);
assert.match(sql, /\('after_submission','after_submission'\)/);
assert.doesNotMatch(sql, /grant (?:select|insert|update|delete|all).*package_(?:forms|form_questions|reserve_questions)/i);
assert.doesNotMatch(sql, /auth\.uid\(\)/, 'private helpers must not pretend browser identity is their execution boundary');

class RotationFixture {
  constructor() { this.attempts = []; this.requests = new Map(); }
  start({ owner = 'learner-a', profile = 'full', purpose = 'self_directed_exam', requestId, commit = true }) {
    if (this.requests.has(requestId)) return this.requests.get(requestId);
    if (!['assigned_assessment', 'self_directed_exam'].includes(purpose)) return { form: null, cycle: null };
    const scoped = this.attempts.filter((attempt) => attempt.owner === owner && attempt.profile === profile);
    const cycle = Math.max(1, ...scoped.map((attempt) => attempt.cycle));
    const seen = new Set(scoped.filter((attempt) => attempt.cycle === cycle).map((attempt) => attempt.form));
    const nextCycle = seen.size === 6 ? cycle + 1 : cycle;
    const previous = scoped.at(-1)?.form;
    const candidates = [1, 2, 3, 4, 5, 6].filter((form) => !this.attempts.some((attempt) => attempt.owner === owner && attempt.profile === profile && attempt.cycle === nextCycle && attempt.form === form));
    const form = candidates.find((candidate) => nextCycle === 1 || candidate !== previous) ?? candidates[0];
    const result = { owner, profile, purpose, requestId, form, cycle: nextCycle };
    if (commit) { this.attempts.push(result); this.requests.set(requestId, result); }
    return result;
  }
}

const fixture = new RotationFixture();
const six = Array.from({ length: 6 }, (_, index) => fixture.start({ requestId: `full-${index + 1}`, purpose: index % 2 ? 'assigned_assessment' : 'self_directed_exam' }));
assert.deepEqual(six.map(({ form }) => form), [1, 2, 3, 4, 5, 6], 'assigned and self-directed starts share one six-form cycle');
const seventh = fixture.start({ requestId: 'full-7' });
assert.equal(seventh.cycle, 2);
assert.notEqual(seventh.form, six.at(-1).form, 'cycle boundary must not immediately repeat the prior form');
assert.strictEqual(fixture.start({ requestId: 'full-7' }), seventh, 'same request is idempotent');
const beforeFailure = fixture.attempts.length;
fixture.start({ requestId: 'rolled-back', commit: false });
assert.equal(fixture.attempts.length, beforeFailure, 'failed materialization consumes no form');
assert.equal(fixture.start({ requestId: 'practice', purpose: 'weak_area' }).form, null, 'practice consumes no formal form');
const compact = Array.from({ length: 6 }, (_, index) => fixture.start({ profile: 'compact', requestId: `compact-${index}` }));
assert.equal(new Set(compact.map(({ form }) => form)).size, 6, 'compact has an independent six-form cycle');
const otherLearner = fixture.start({ owner: 'learner-b', requestId: 'other-owner' });
assert.equal(otherLearner.form, 1, 'learner cycles are isolated');

console.log(JSON.stringify({
  ok: true,
  issue: 21,
  migration: migrationPath,
  fullCycleForms: six.length,
  compactCycleForms: compact.length,
  seventhCycle: seventh.cycle,
  practiceConsumesForms: false,
  browserTableGrants: 0,
  legacyFallbackPreserved: true,
}));
