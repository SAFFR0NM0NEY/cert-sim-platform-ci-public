import { variablePythonCandidate } from './variable-python-forms.mjs';
import { sha256Canonical } from '../backend-exam-publication/canonical-json.mjs';

// One maintained input matrix is consumed by normal preflight and real publication.
// beforeJs/beforePublication record the original1b61 behavior, not desired policy.
const matching = c => c.questions.find(q => q.type === 'matching-v1');
const row = (id, accepted, mutate, beforeJs = true, beforePublication = true) =>
  ({ id, accepted, mutate, beforeJs, beforePublication });
export const RESPONSE_ADMISSIBILITY_CASES = [
  row('matching-distinct-omitted', true, () => {}),
  row('matching-distinct-false', true, c => { matching(c).presentation.allowTargetReuse = false; }),
  row('matching-distinct-true', true, c => { matching(c).presentation.allowTargetReuse = true; }),
  row('matching-shared-omitted', false, c => { matching(c).privateScoring.correctTargetIdsBySource.b = 'x'; }),
  row('matching-shared-false', false, c => { matching(c).presentation.allowTargetReuse = false; matching(c).privateScoring.correctTargetIdsBySource.b = 'x'; }),
  row('matching-shared-true', true, c => { matching(c).presentation.allowTargetReuse = true; matching(c).privateScoring.correctTargetIdsBySource.b = 'x'; }),
  ...['true', 'false', 'not-a-boolean', 0, 1, null, [], {}].map((value, i) =>
    row(`matching-policy-type-${i}`, false, c => { matching(c).presentation.allowTargetReuse = structuredClone(value); })),
  row('matching-missing-map', false, c => { delete matching(c).privateScoring.correctTargetIdsBySource.b; }, false, false),
  row('matching-extra-map', false, c => { matching(c).privateScoring.correctTargetIdsBySource.extra = 'x'; }, false, false),
  row('matching-unknown-target', false, c => { matching(c).privateScoring.correctTargetIdsBySource.b = 'unknown'; }, false, false),
  row('matching-duplicate-source', false, c => { matching(c).presentation.sources[1].id = 'a'; }, false, false),
  row('matching-duplicate-target', false, c => { matching(c).presentation.targets.push({ id: 'x', text: 'Synthetic duplicate' }); }, false, false),
  row('matching-insufficient-targets', false, c => { matching(c).presentation.targets.pop(); matching(c).privateScoring.correctTargetIdsBySource.b = 'x'; }),
  row('matching-invalid-reserve', false, c => { const q = structuredClone(matching(c)); q.id = c.questions[8].id; q.privateScoring.correctTargetIdsBySource.b = 'x'; c.questions[8] = q; }),
  row('scored-omitted', true, c => { delete c.questions[0].scored; }),
  row('scored-true', true, c => { c.questions[0].scored = true; }),
  row('scored-false', false, c => { c.questions[0].scored = false; }, false, false),
  ...[
    ['false', false], ['true', true], ['not-a-boolean', false], [null, true],
    [0, false], [1, true], [2, false], [[], false], [{}, false],
  ].map(([value, published], i) => row(`scored-type-${i}`, false, c => { c.questions[0].scored = structuredClone(value); }, true, published)),
];

export function responseCaseCandidate(entry, examKey = 'inf303') {
  const c = variablePythonCandidate(); c.exam.examKey = examKey; entry.mutate(c); return c;
}

export const MIXED_POLICIES = ['omitted', 'false', 'true'];
export function mixedResponseCandidate() {
  const c = variablePythonCandidate(), originals = c.questions;
  c.exam.packageVersion = 'response.1';
  c.questions = []; c.profiles = [];
  for (const policy of MIXED_POLICIES) {
    const members = [4, 0, 6, 5, 4, 0, 6, 5, 1].map((index, i) => {
      const q = structuredClone(originals[index]); q.id = `synthetic-response-${policy}-${i + 1}`;
      if (q.type === 'matching-v1') {
        if (policy !== 'omitted') q.presentation.allowTargetReuse = policy === 'true';
        if (policy === 'true') q.privateScoring.correctTargetIdsBySource.b = 'x';
      }
      return q;
    });
    c.questions.push(...members);
    const p = structuredClone(variablePythonCandidate().profiles[0]);
    p.profileKey = `response-${policy}`; p.displayName = 'Synthetic response contract';
    const forms = [members.slice(0, 4), members.slice(4)].map((qs, i) => ({
      formKey: `synthetic-${policy}-${i + 1}`, ordinal: i + 1, questionCount: qs.length,
      questionIds: qs.map(q => q.id), membershipHash: sha256Canonical(qs.map(q => q.id)),
      // Independent fixture arithmetic: single1 + composite2 + matching2 + dropdown3 [+ composite2].
      rawMaximum: i === 0 ? 8 : 10,
      blueprint: { composition: { standardQuestionCount: qs.length, caseStudyCount: 0, caseStudyQuestionCount: 0, pbqCount: 0, executableCount: 0 },
        domainCounts: { 'domain-a': qs.length }, requiredObjectiveKeys: ['objective-a'],
        minimumCoverageTagCounts: { 'synthetic-coverage': 1 },
        difficultyRequirements: { minimumMedium: 1, minimumHardOrAdvanced: 0, minimumAdvanced: 0 } },
    }));
    p.selection.canonicalForms.forms = forms;
    p.selection.canonicalForms.countPolicy = { mode: 'authorised-form-counts-v1', allowedCounts: [4, 5], minimum: 4, maximum: 5 };
    c.profiles.push(p);
  }
  for (const p of c.profiles) {
    const own = new Set(p.selection.canonicalForms.forms.flatMap(f => f.questionIds));
    p.selection.canonicalForms.reserveQuestionIds = c.questions.filter(q => !own.has(q.id)).map(q => q.id);
  }
  return c;
}

// Synthetic test-driver keys only. Never imported into the learner bundle or DTO.
export function correctSyntheticResponse(q) {
  const s = q.privateScoring;
  return { answer: structuredClone(q.type === 'true-false-single-v1' ? s.correctValue
    : q.type === 'true-false-composite-v1' ? s.correctValuesByStatement
    : q.type === 'matching-v1' ? s.correctTargetIdsBySource : s.correctOptionIdsByBlank) };
}
