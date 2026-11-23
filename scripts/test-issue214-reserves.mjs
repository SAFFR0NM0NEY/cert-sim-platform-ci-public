import assert from 'node:assert/strict';
import { reserveCandidate, richReserveCandidate } from './fixtures/issue214-reserves.mjs';
import { sha256Canonical } from './backend-exam-publication/canonical-json.mjs';
import { validateExamOperationsCandidate as validate, EXAM_OPERATIONS_VALIDATOR_VERSION, MIGRATION_CLASSIFICATIONS } from './backend-exam-publication/exam-operations-candidate.mjs';
let cases = 0;
function test(name, run) { run(); cases++; console.log(`PASS ${name}`); }
const forms = c => c.profiles[0].selection.canonicalForms;
function negative(name, mutate, code, factory = reserveCandidate) {
  test(name, () => { const c = factory(); mutate(c); const r = validate(c); assert.equal(r.ok, false); assert.ok(r.validation.errors.some(e => e.code === code), `${name}: ${JSON.stringify(r.validation.errors)}`); });
}
function rehash(c) { for (const p of c.profiles) for (const f of p.selection.canonicalForms.forms) f.membershipHash = sha256Canonical(f.questionIds); }
function richCandidate() {
  return richReserveCandidate();
}
test('both Python profiles pass together with sanitized scoped counts', () => {
  const r = validate(reserveCandidate()); assert.equal(r.ok, true);
  assert.equal(r.manifest.inventory.globalReserveItemCount, 2);
  assert.deepEqual(r.manifest.profiles.map(p => p.forms.reserveItemCount), [4,2]);
  assert.ok(r.manifest.profiles.every(p => p.forms.reservePolicy === 'profile-specific-reserve'));
  assert.ok(!JSON.stringify(r.manifest).includes('q1'));
});
test('repeat deterministic; profile and reserve ordering immaterial to verdict/projection', () => {
  const c = reserveCandidate(), first = validate(c); assert.deepEqual(validate(c), first);
  c.profiles.reverse(); for (const p of c.profiles) p.selection.canonicalForms.reserveQuestionIds.reverse();
  const r = validate(c); assert.equal(r.ok,true); assert.deepEqual(r.manifest.profiles,first.manifest.profiles); assert.equal(r.manifest.inventory.globalReserveItemCount, first.manifest.inventory.globalReserveItemCount);
});
test('optional authoring global projection accepts intersection', () => { const c = reserveCandidate(); c.canonicalForms = { contractVersion: forms(c).contractVersion, cycleLength: 2, reservePolicy: 'profile-specific-reserve', reserveQuestionIds: ['q8','q7'] }; assert.equal(validate(c).ok,true); });
negative('unknown reserve', c => forms(c).reserveQuestionIds.push('missing'), 'CANONICAL_FORM_RESERVE_INVALID');
negative('duplicate reserve', c => forms(c).reserveQuestionIds.push('q7'), 'CANONICAL_FORM_RESERVE_INVALID');
negative('non-array reserves', c => forms(c).reserveQuestionIds = {}, 'CANONICAL_FORM_RESERVE_INVALID');
negative('own reserve overlap', c => forms(c).reserveQuestionIds.push('q1'), 'CANONICAL_FORM_MEMBERSHIP_INVALID');
negative('missing coverage', c => forms(c).reserveQuestionIds.pop(), 'CANONICAL_FORM_RESERVE_INSUFFICIENT');
negative('duplicate within form, hash independently updated', c => { forms(c).forms[0].questionIds[1]='q1'; rehash(c); }, 'CANONICAL_FORM_DEFINITION_INVALID');
negative('repeat across cycle, hash independently updated', c => { forms(c).forms[1].questionIds[0]='q1'; rehash(c); }, 'CANONICAL_FORM_MEMBERSHIP_INVALID');
negative('unscored member', c => c.questions[0].scored=false, 'CANONICAL_FORM_MEMBERSHIP_INVALID');
negative('wrong length with correct hash', c => { forms(c).forms[0].questionIds.pop(); rehash(c); }, 'CANONICAL_FORM_DEFINITION_INVALID');
negative('wrong ordinal', c => forms(c).forms[0].ordinal=2, 'CANONICAL_FORM_DEFINITION_INVALID');
negative('duplicate key', c => forms(c).forms[1].formKey=forms(c).forms[0].formKey, 'CANONICAL_FORM_DEFINITION_INVALID');
negative('wrong membership hash', c => forms(c).forms[0].membershipHash='0'.repeat(64), 'CANONICAL_FORM_DEFINITION_INVALID');
negative('wrong raw maximum', c => forms(c).forms[0].rawMaximum=4, 'CANONICAL_FORM_RAW_MAXIMUM_INVALID');
negative('invalid composition', c => c.profiles[0].selection.standardQuestionCount=2, 'PROFILE_COMPOSITION_INCONSISTENT');
negative('unknown policy', c => forms(c).reservePolicy='unchecked', 'CANONICAL_FORM_RESERVE_POLICY_INVALID');
negative('missing policy is explicitly invalid, no legacy exception', c => delete forms(c).reservePolicy, 'CANONICAL_FORM_RESERVE_POLICY_INVALID');
negative('Python/shared policy mismatch', c => forms(c).reservePolicy='practice-only-until-versioned-rebalance', 'CANONICAL_FORM_RESERVE_POLICY_INVALID');
negative('unknown version', c => forms(c).contractVersion='unregistered-v1', 'CANONICAL_FORM_CONTRACT_INVALID');
negative('wrong Python runtime', c => c.runtime.generatorVersion='certsim-sc200-canonical-forms-v1', 'CANONICAL_FORM_RUNTIME_INVALID');
negative('mixed fixed and dynamic profiles', c => delete c.profiles[1].selection.canonicalForms, 'CANONICAL_FORM_CONTRACT_INVALID');
negative('mixed supported families', c => c.profiles[1].selection.canonicalForms.contractVersion='certsim-canonical-forms-v2', 'CANONICAL_FORM_CONTRACT_INVALID');
test('valid rich shared-pool family remains valid', () => assert.equal(validate(richCandidate()).ok,true));
negative('genuine rich shared reserve mismatch', c => c.profiles[1].selection.canonicalForms.reserveQuestionIds.pop(), 'CANONICAL_FORM_CROSS_PROFILE_RESERVE_MISMATCH', richCandidate);
negative('rich/profile-specific policy mismatch', c => forms(c).reservePolicy='profile-specific-reserve', 'CANONICAL_FORM_RESERVE_POLICY_INVALID', richCandidate);
negative('rich blueprint invalid', c => forms(c).skillGroupTargets.synthetic=2, 'CANONICAL_FORM_BLUEPRINT_INVALID', richCandidate);
negative('rich objective invalid', c => forms(c).requiredObjectiveKeys=['missing'], 'CANONICAL_FORM_BLUEPRINT_INVALID', richCandidate);
negative('rich difficulty invalid', c => forms(c).difficultyRequirements.minimumAdvanced=1, 'CANONICAL_FORM_BLUEPRINT_INVALID', richCandidate);
negative('global projection uses reserve union instead of intersection', c => c.canonicalForms={ contractVersion: forms(c).contractVersion, cycleLength: 2, reservePolicy:'profile-specific-reserve', reserveQuestionIds:['q3','q6','q7','q8'] }, 'CANONICAL_FORM_GLOBAL_RESERVE_MISMATCH');
negative('incompatible aggregate declaration', c => c.canonicalForms={ contractVersion:'unknown-v1', cycleLength:2, reservePolicy:'profile-specific-reserve', reserveQuestionIds:['q7','q8'] }, 'CANONICAL_FORM_CONTRACT_INVALID');
test('legacy package retains explicit legacy classification', () => assert.equal(validate({ packageSchemaVersion:'certsim-protected-package-v1' }).migrationClassification, MIGRATION_CLASSIFICATIONS.legacy));
console.log(JSON.stringify({suite:'issue214-reserve-contract',cases,validator:EXAM_OPERATIONS_VALIDATOR_VERSION,syntheticOnly:true}));
