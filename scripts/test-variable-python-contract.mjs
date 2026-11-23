import assert from 'node:assert/strict';
import test from 'node:test';
import { variablePythonCandidate } from './fixtures/variable-python-forms.mjs';
import { validateExamOperationsCandidate } from './backend-exam-publication/exam-operations-candidate.mjs';
import { sha256Canonical } from './backend-exam-publication/canonical-json.mjs';
import { variableQuestionMaximum } from './backend-exam-publication/variable-python-forms.mjs';
import { createExamOperationsReleaseDiff, createCandidateQuestionFingerprintIndex } from './backend-exam-publication/exam-operations-release-diff.mjs';
import { CURRENT_PACKAGE_RESOLUTION } from './backend-exam-publication/exam-operations-current-state.mjs';

test('normal validator accepts one synthetic profile with independently validated 3/5 forms', () => {
  const result = validateExamOperationsCandidate(variablePythonCandidate());
  assert.equal(result.ok, true, JSON.stringify(result.validation.errors));
  const forms = result.manifest.profiles[0].forms;
  assert.deepEqual(forms.countPolicy.allowedCounts, [3, 5]);
  assert.deepEqual(forms.perForm.map(f => f.itemCount), [3, 5]);
  assert.deepEqual(forms.perForm.map(f => f.rawMaximum), [6, 10]);
  assert.equal(JSON.stringify(result.manifest).includes('synthetic-variable-1'), false);
});

const mutations = {
  'membership length': c => { c.forms[0].questionCount = 5; },
  'membership hash': c => { c.forms[0].membershipHash = '0'.repeat(64); },
  'raw maximum': c => { c.forms[0].rawMaximum = 3; },
  'composition': c => { c.forms[0].blueprint.composition.pbqCount = 1; },
  'domain coverage': c => { c.forms[0].blueprint.domainCounts = { 'other-domain': 3 }; },
  'objective coverage': c => { c.forms[0].blueprint.requiredObjectiveKeys = ['missing']; },
  'tag coverage': c => { c.forms[0].blueprint.minimumCoverageTagCounts = { absent: 1 }; },
  'difficulty coverage': c => { c.forms[0].blueprint.difficultyRequirements.minimumAdvanced = 1; },
  'duplicate membership': c => { c.forms[0].questionIds[1] = c.forms[0].questionIds[0]; },
  'cross form membership': c => { c.forms[1].questionIds[0] = c.forms[0].questionIds[0]; c.forms[1].membershipHash = sha256Canonical(c.forms[1].questionIds); },
  'unknown membership': c => { c.forms[0].questionIds[0] = 'unknown'; c.forms[0].membershipHash = sha256Canonical(c.forms[0].questionIds); },
  'reserve overlap': c => { c.reserveQuestionIds.push(c.forms[0].questionIds[0]); },
  'missing partition': c => { c.reserveQuestionIds = []; },
  'unknown version': c => { c.contractVersion = 'unknown'; },
  'unknown delivery': c => { c.deliveryContract = 'unknown'; },
  'unknown count policy': c => { c.countPolicy.mode = 'unknown'; },
  'empty counts': c => { c.countPolicy.allowedCounts = []; },
  'duplicate counts': c => { c.countPolicy.allowedCounts = [3, 3, 5]; },
  'range invents authorised count': c => { c.countPolicy.allowedCounts = [3, 4, 5]; },
  'zero': c => { c.countPolicy.minimum = 0; },
  'negative': c => { c.countPolicy.minimum = -1; },
  'unsafe': c => { c.countPolicy.maximum = Number.MAX_SAFE_INTEGER + 1; },
  'null nested': c => { c.forms[0].blueprint = null; },
  'scalar nested': c => { c.forms[0].questionIds = 3; },
  'unknown field': c => { c.forms[0].extra = true; },
};
for (const [name, mutate] of Object.entries(mutations)) test(`rejects ${name} through normal validator`, () => {
  const fixture = variablePythonCandidate();
  mutate(fixture.profiles[0].selection.canonicalForms);
  assert.equal(validateExamOperationsCandidate(fixture).ok, false);
});
test('rejects dishonest profile summary and missing version declaration', () => {
  const fixture = variablePythonCandidate();
  fixture.profiles[0].questionCount = 4;
  assert.equal(validateExamOperationsCandidate(fixture).ok, false);
  delete fixture.profiles[0].selection.canonicalForms;
  assert.equal(validateExamOperationsCandidate(fixture).ok, false);
});
test('raw scoring maxima derive from independently scored subparts', () => {
  const fixture = variablePythonCandidate();
  fixture.questions[0].privateScoring.maximumRawPoints = 1;
  assert.equal(validateExamOperationsCandidate(fixture).ok, false);
});
test('single boolean, matching and weighted dropdown maxima are independently derived', () => {
  const single={type:'true-false-single-v1',presentation:{interactionVersion:'true-false-single-v1',statementId:'single'},privateScoring:{correctValue:true,maximumRawPoints:1}};
  assert.equal(variableQuestionMaximum(single),1);
  const matching={type:'matching-v1',presentation:{interactionVersion:'matching-v1',sources:[{id:'a',text:'A'},{id:'b',text:'B'}],targets:[{id:'x',text:'X'},{id:'y',text:'Y'}]},privateScoring:{correctTargetIdsBySource:{a:'x',b:'y'},maximumRawPoints:2}};
  assert.equal(variableQuestionMaximum(matching),2);
  const dropdown={type:'code-dropdown-completion-v1',presentation:{interactionVersion:'code-dropdown-completion-v1',codeTemplate:'[[a]] [[b]]',blanks:[{id:'a',options:[{id:'x',text:'X'}]},{id:'b',options:[{id:'y',text:'Y'}]}]},privateScoring:{correctOptionIdsByBlank:{a:'x',b:'y'},pointsByBlank:{a:1,b:3},maximumRawPoints:4}};
  assert.equal(variableQuestionMaximum(dropdown),4);
  dropdown.privateScoring.pointsByBlank.a=0.1;
  assert.throws(()=>variableQuestionMaximum(dropdown),/VARIABLE_FORM_SCORING_INVALID/);
  matching.presentation.targets.push({id:'x'});
  assert.throws(()=>variableQuestionMaximum(matching),/VARIABLE_FORM_SCORING_INVALID/);
});
function compare(candidate,before) {
  return createExamOperationsReleaseDiff({currentState:{resolution:{status:CURRENT_PACKAGE_RESOLUTION.resolved},currentPackage:{...validateExamOperationsCandidate(before).manifest,packageVersion:before.exam.packageVersion}},
    candidateValidation:validateExamOperationsCandidate(candidate),currentFingerprintIndex:createCandidateQuestionFingerprintIndex(before),candidateContract:candidate});
}
test('unchanged per-form metadata remains unchanged in sanitized diff',()=>{
  const candidate=variablePythonCandidate();assert.equal(compare(candidate,candidate).overallChangeClassification,'NO_CHANGE');
});
test('three top-level items may have seven raw subpoints without changing profile maximum',()=>{
  const before=variablePythonCandidate(),candidate=structuredClone(before);
  candidate.questions[0].presentation.statements.push({id:'c',text:'Synthetic statement C.'});
  candidate.questions[0].privateScoring.correctValuesByStatement.c=true;
  candidate.questions[0].privateScoring.maximumRawPoints=3;
  candidate.profiles[0].selection.canonicalForms.forms[0].rawMaximum=7;
  const validation=validateExamOperationsCandidate(candidate);assert.equal(validation.ok,true);
  assert.deepEqual(validation.manifest.profiles[0].forms.perForm.map(f=>[f.itemCount,f.rawMaximum]),[[3,7],[5,10]]);
  assert.equal(compare(candidate,before).forms.profiles[0].perFormMetadataChanged,true);
});
test('blueprint-only change is visible when count, membership and profile maximum are unchanged',()=>{
  const before=variablePythonCandidate(),candidate=structuredClone(before);
  candidate.profiles[0].selection.canonicalForms.forms[0].blueprint.minimumCoverageTagCounts['synthetic-coverage']=2;
  assert.equal(validateExamOperationsCandidate(candidate).ok,true);
  const diff=compare(candidate,before);assert.equal(diff.overallChangeClassification,'FORM_CHANGE');assert.equal(diff.forms.profiles[0].perFormMetadataChanged,true);
});
test('variable profiles retain independent reserve partitions and package-global complement',()=>{
  const candidate=variablePythonCandidate(),second=structuredClone(candidate.profiles[0]);
  second.profileKey='synthetic-second-profile';
  const groups=[[1,3,5],[0,2,4,6,8]];
  second.selection.canonicalForms.forms.forEach((form,i)=>{
    const members=groups[i].map(index=>candidate.questions[index]);
    form.questionIds=members.map(q=>q.id);form.membershipHash=sha256Canonical(form.questionIds);
    form.rawMaximum=members.reduce((sum,q)=>sum+variableQuestionMaximum(q),0);
  });
  second.selection.canonicalForms.reserveQuestionIds=[candidate.questions[7].id];
  candidate.profiles.push(second);
  const result=validateExamOperationsCandidate(candidate);assert.equal(result.ok,true);
  assert.equal(result.manifest.inventory.globalReserveItemCount,0);
  assert.deepEqual(result.manifest.profiles.map(p=>p.forms.reserveItemCount),[1,1]);
  assert.deepEqual(result.manifest.profiles[1].forms.perForm.map(f=>f.rawMaximum),[7,9]);
});
test('reserve scoring is validated for noncanonical practice eligibility',()=>{
  const candidate=variablePythonCandidate();candidate.questions[8].privateScoring.maximumRawPoints=1;
  assert.equal(validateExamOperationsCandidate(candidate).ok,false);
});
