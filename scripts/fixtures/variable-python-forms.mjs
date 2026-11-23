import { sha256Canonical } from '../backend-exam-publication/canonical-json.mjs';
import { VARIABLE_PYTHON_FORMS, FORM_COUNT_DELIVERY, VARIABLE_PYTHON_SCORER } from '../backend-exam-publication/variable-python-forms.mjs';

// Synthetic software fixtures only. These lengths are not certification policy.
export function variablePythonCandidate() {
  const questions = Array.from({ length: 9 }, (_, i) => ({
    id: `synthetic-variable-${i + 1}`, type: 'true-false-composite-v1',
    domainKey: 'domain-a', sectionKey: 'objective-a', scored: true,
    presentation: {
      interactionVersion: 'true-false-composite-v1', prompt: 'Synthetic boolean exercise.',
      statements: [{ id: 'a', text: 'Synthetic statement A.' }, { id: 'b', text: 'Synthetic statement B.' }],
      difficulty: 'medium', coverageTags: ['synthetic-coverage'],
    },
    privateScoring: { correctValuesByStatement: { a: true, b: false }, maximumRawPoints: 2 },
    privateReview: { rationale: 'Synthetic fixture review.' },
  }));
  const changeType=(index,type,presentation,privateScoring)=>{
    questions[index]={...questions[index],type,presentation:{difficulty:'medium',coverageTags:['synthetic-coverage'],interactionVersion:type,...presentation},privateScoring};
  };
  changeType(4,'true-false-single-v1',{statementId:'single',prompt:'Synthetic single boolean.'},{correctValue:true,maximumRawPoints:1});
  changeType(5,'code-dropdown-completion-v1',{codeTemplate:'value = [[a]]\nprint([[b]])',blanks:[
    {id:'a',options:[{id:'x',text:'1'},{id:'y',text:'2'}]},
    {id:'b',options:[{id:'x',text:'value'},{id:'y',text:'0'}]},
  ]},{correctOptionIdsByBlank:{a:'x',b:'x'},pointsByBlank:{a:1,b:2},maximumRawPoints:3});
  changeType(6,'matching-v1',{sources:[{id:'a',text:'Synthetic source A'},{id:'b',text:'Synthetic source B'}],targets:[{id:'x',text:'Synthetic target X'},{id:'y',text:'Synthetic target Y'}]},
    {correctTargetIdsBySource:{a:'x',b:'y'},maximumRawPoints:2});
  const forms = [questions.slice(0, 3), questions.slice(3, 8)].map((members, i) => ({
    formKey: `synthetic-form-${i + 1}`, ordinal: i + 1, questionCount: members.length,
    questionIds: members.map(q => q.id), membershipHash: sha256Canonical(members.map(q => q.id)),
    rawMaximum: members.length * 2,
    blueprint: {
      composition: { standardQuestionCount: members.length, caseStudyCount: 0, caseStudyQuestionCount: 0, pbqCount: 0, executableCount: 0 },
      domainCounts: { 'domain-a': members.length }, requiredObjectiveKeys: ['objective-a'],
      minimumCoverageTagCounts: { 'synthetic-coverage': 1 },
      difficultyRequirements: { minimumMedium: 1, minimumHardOrAdvanced: 0, minimumAdvanced: 0 },
    },
  }));
  return {
    packageSchemaVersion: 'certsim-protected-package-v2',
    validationContractVersion: 'certsim-protected-multi-exam-validation-v1',
    exam: { examKey: 'inf303', packageVersion: '1.0.0', capabilities: ['true-false-single-v1','true-false-composite-v1','matching-v1','code-dropdown-completion-v1'], domains: [{ key: 'domain-a', name: 'Synthetic domain' }] },
    source: { sourceHash: 'a'.repeat(64), validationHash: 'b'.repeat(64) },
    runtime: { generatorVersion: VARIABLE_PYTHON_FORMS, scorerVersion: VARIABLE_PYTHON_SCORER },
    profiles: [{ profileKey: 'inf303-standard', displayName: 'Synthetic variable Standard', questionCount: 5, timeLimitMinutes: 45,
      selection: { standardQuestionCount: 5, sectionOrder: 'standard', formalReleasePolicy: { review: 'after_submission', answers: 'after_submission' }, canonicalForms: {
        contractVersion: VARIABLE_PYTHON_FORMS, deliveryContract: FORM_COUNT_DELIVERY,
        cycleLength: 2, reservePolicy: 'profile-specific-reserve', reserveQuestionIds: [questions[8].id],
        countPolicy: { mode: 'authorised-form-counts-v1', allowedCounts: [3, 5], minimum: 3, maximum: 5 }, forms,
      } },
    }],
    releasePolicy: { review: 'after_submission', answers: 'after_submission' }, questions,
  };
}
