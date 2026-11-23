import { sha256Canonical } from '../backend-exam-publication/canonical-json.mjs';

// Entirely synthetic. Shared with the actual public-publisher integration test.
export function reserveCandidate() {
  const profile = (key, count, groups, reserves, minutes) => ({
    profileKey: key, displayName: key, questionCount: count, timeLimitMinutes: minutes,
    selection: { canonicalForms: {
      contractVersion: 'certsim-python-standard-forms-v1', cycleLength: 2,
      reservePolicy: 'profile-specific-reserve', reserveQuestionIds: reserves,
      forms: groups.map((questionIds, i) => ({ formKey: `${key}-${i + 1}`, ordinal: i + 1,
        questionIds, membershipHash: sha256Canonical(questionIds), rawMaximum: count })),
    } },
  });
  return {
    packageSchemaVersion: 'certsim-protected-package-v2',
    validationContractVersion: 'certsim-protected-multi-exam-validation-v1',
    exam: { examKey: 'fixture214', packageVersion: '1.0.0', capabilities: ['single-choice'], domains: [{ key: 'synthetic', name: 'Synthetic' }] },
    source: { sourceHash: 'a'.repeat(64), validationHash: 'b'.repeat(64) },
    runtime: { generatorVersion: 'certsim-python-standard-canonical-forms-v1', scorerVersion: 'certsim-versioned-structured-partial-v1' },
    profiles: [profile('full', 3, [['q1','q2','q3'],['q4','q5','q6']], ['q7','q8'], 45),
      profile('compact', 2, [['q1','q2'],['q4','q5']], ['q3','q6','q7','q8'], 60)],
    questions: Array.from({ length: 8 }, (_, i) => ({ id: `q${i+1}`, type: 'single-choice', domainKey: 'synthetic', scored: true,
      presentation: { prompt: 'Synthetic fixture', options: [{ id: 'a', text: 'Synthetic A' }, { id: 'b', text: 'Synthetic B' }] },
      privateScoring: { correctOptionIds: ['a'], maximumRawPoints: 1 }, privateReview: {} })),
    releasePolicy: { review: 'after_submission', answers: 'after_submission' },
  };
}

// Publisher-valid rich shared-pool contract. q8 is deliberately neither
// selected nor reserved; this family does not require Python's full partition.
export function richReserveCandidate() {
  const c = reserveCandidate();
  c.exam.examKey = 'fixture214rich';
  c.runtime = { generatorVersion: 'certsim-ai901-weighted-generator-v2', scorerVersion: 'certsim-ai901-exact-scorer-v2' };
  c.profiles = [c.profiles[0], structuredClone(c.profiles[0])];
  c.profiles[1].profileKey = 'other';
  for (const p of c.profiles) {
    p.selection.formalReleasePolicy = { review: 'after_submission', answers: 'after_submission' };
    Object.assign(p.selection.canonicalForms, {
      contractVersion: 'certsim-canonical-forms-v2', profileKey: p.profileKey, questionCount: p.questionCount,
      reservePolicy: 'practice-only-until-versioned-rebalance', reserveQuestionIds: ['q7'],
      skillGroupTargets: { synthetic: 3 }, requiredObjectiveKeys: ['synthetic'],
      minimumCoverageTagCounts: { synthetic: 1 },
      difficultyRequirements: { minimumMedium: 0, minimumHardOrAdvanced: 0, minimumAdvanced: 0 },
    });
    for (const f of p.selection.canonicalForms.forms) { delete f.rawMaximum; f.formKey = `${p.profileKey}-${f.ordinal}`; }
  }
  for (const q of c.questions) {
    Object.assign(q.presentation, { officialSkillGroup: 'synthetic', officialObjectiveKey: 'synthetic', difficulty: 'medium', coverageTags: ['synthetic'] });
    q.privateScoring = { correctAnswer: 'a', maximumRawPoints: 1 };
  }
  return c;
}
