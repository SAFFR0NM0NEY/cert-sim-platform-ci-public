import assert from 'node:assert/strict';
import { reserveCandidate, richReserveCandidate } from './fixtures/issue214-reserves.mjs';
import { sha256Canonical } from './backend-exam-publication/canonical-json.mjs';
import { validateExamOperationsCandidate as validate, formatExamOperationsValidationReport } from './backend-exam-publication/exam-operations-candidate.mjs';
import { createExamOperationsReleaseDiff as compare, createCandidateQuestionFingerprintIndex as fingerprints, formatExamOperationsReleaseDiffReport as formatExamOperationsReleaseDiff } from './backend-exam-publication/exam-operations-release-diff.mjs';
import { buildExamOperationsCurrentState, CURRENT_PACKAGE_RESOLUTION } from './backend-exam-publication/exam-operations-current-state.mjs';
let passed = 0, failed = 0;
function test(name, run) { try { run(); passed++; console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); } }
function current(c) { const m = structuredClone(validate(c).manifest); return { ...m, packageVersion: c.exam.packageVersion }; }
function diff(c, before = current(c), candidateValidation = validate(c), index = fingerprints(c)) {
  return compare({ currentState: { resolution: { status: CURRENT_PACKAGE_RESOLUTION.resolved }, currentPackage: before }, candidateValidation, currentFingerprintIndex: index, candidateContract: c });
}
function controlled(c) {
  const r = validate(c); assert.equal(r.ok, false); assert.equal(r.validation.verdict, 'invalid');
  assert.equal(r.migrationClassification, 'INVALID_CANDIDATE');
  assert.equal(r.manifest.inventory.globalReserveItemCount, null);
  assert.notEqual(r.compatibility.forms, 'valid');
  assert.deepEqual(validate(JSON.parse(JSON.stringify(c))), r);
  assert.ok(formatExamOperationsValidationReport(r).includes('invalid'));
}
// Stable review reproductions: these assertions fail at unchanged b1d9e84.
for (const [name, value] of [['null',null],['array',[]],['number',3],['string','bad'],['empty-object',{}],['partial-object',{contractVersion:'certsim-python-standard-forms-v1'}]]) {
  test(`malformed declaration ${name} beside valid profile`, () => { const c = reserveCandidate(); c.profiles[0].selection.canonicalForms = value; controlled(c); });
}
for (const [name, mutate] of [
  ['null forms', f => f.forms=null], ['non-array forms', f => f.forms={}],
  ['null form', f => f.forms[0]=null], ['scalar form', f => f.forms[0]=3],
  ['null membership', f => f.forms[0].questionIds=null],
  ['null reserves', f => f.reserveQuestionIds=null], ['scalar reserves', f => f.reserveQuestionIds=3],
  ['null reserve identity', f => f.reserveQuestionIds=[null]],
  ['bad raw maximum', f => f.forms[0].rawMaximum='3'],
  ['unknown policy', f => f.reservePolicy='unknown'], ['unknown family', f => f.contractVersion='unknown'],
]) test(name, () => { const c=reserveCandidate(); mutate(c.profiles[0].selection.canonicalForms); controlled(c); });
test('malformed rich blueprint form stays controlled', () => { const c=richReserveCandidate(); c.profiles[0].selection.canonicalForms.forms=[null,null]; controlled(c); });
test('unsupported runtime has no guessed projection', () => { const c=reserveCandidate(); c.runtime.generatorVersion='unknown'; controlled(c); });
test('mixed fixed/dynamic unavailable, not fixed zero', () => { const c=reserveCandidate(); delete c.profiles[0].selection.canonicalForms; controlled(c); });
test('mixed fixed families unavailable', () => { const c=reserveCandidate(); c.profiles[1]=richReserveCandidate().profiles[1]; controlled(c); });
test('dynamic declaration absence remains valid and inapplicable', () => { const c=reserveCandidate(); for(const p of c.profiles) delete p.selection.canonicalForms; const r=validate(c); assert.equal(r.ok,true); assert.equal(r.manifest.inventory.globalReserveItemCount,null); assert.ok(r.manifest.profiles.every(p=>p.selectionClassification==='dynamic')); });
test('genuinely empty Python reserves are known zero', () => {
 const c=reserveCandidate(); c.profiles=[c.profiles[0]];const p=c.profiles[0];p.questionCount=4;const f=p.selection.canonicalForms;f.reserveQuestionIds=[];
 f.forms.forEach((form,i)=>{form.questionIds=c.questions.slice(i*4,i*4+4).map(q=>q.id);form.membershipHash=sha256Canonical(form.questionIds);form.rawMaximum=4;});
 const r=validate(c);assert.equal(r.ok,true);assert.equal(r.manifest.inventory.globalReserveItemCount,0);
});
test('publisher-valid rich unused item is not a reserve', () => { const r=validate(richReserveCandidate()); assert.equal(r.ok,true); assert.equal(r.manifest.inventory.globalReserveItemCount,1); assert.equal(r.manifest.profiles[0].forms.reserveItemCount,1); });
test('rich genuinely empty shared reserve stays zero despite unused inventory', () => { const c=richReserveCandidate();for(const p of c.profiles)p.selection.canonicalForms.reserveQuestionIds=[];const r=validate(c);assert.equal(r.ok,true);assert.equal(r.manifest.inventory.globalReserveItemCount,0); });
test('invalid rich shared mismatch has no projection', () => { const c=richReserveCandidate();c.profiles[1].selection.canonicalForms.reserveQuestionIds=[];controlled(c); });
for(const [name,mutate] of [
 ['missing rich identity',p=>delete p.selection.canonicalForms.profileKey],
 ['missing rich question count',p=>delete p.selection.canonicalForms.questionCount],
 ['missing rich release policy',p=>delete p.selection.formalReleasePolicy],
 ['prohibited rich raw maximum',p=>p.selection.canonicalForms.forms[0].rawMaximum=3],
])test(name,()=>{const c=richReserveCandidate();mutate(c.profiles[0]);controlled(c);});
test('missing rich coverage metadata has no projection',()=>{const c=richReserveCandidate();delete c.questions[0].presentation.coverageTags;controlled(c);});
test('unsupported rich runtime is unavailable without changing existing review-required classification',()=>{const c=richReserveCandidate();c.runtime.generatorVersion='unknown';const r=validate(c);assert.equal(r.ok,false);assert.equal(r.manifest.inventory.globalReserveItemCount,null);assert.equal(r.validation.verdict,'review_required');});
for (const factory of [reserveCandidate,richReserveCandidate]) test(`${factory.name} known identical has complete count comparison`, () => {const r=diff(factory());assert.equal(r.overallChangeClassification,'NO_CHANGE');assert.equal(r.aggregateInventory.globalReserveItemCount.availability,'available');});
const absent=Symbol('absent');
// Matrices mutate copies of public manifests/snapshots, never the validator's data.
function counts(beforeValue,afterValue,change=false,noIndex=false) {
 const c=reserveCandidate(),before=current(c),v={...validate(c),manifest:structuredClone(validate(c).manifest)};
 if(beforeValue===absent) delete before.inventory.globalReserveItemCount;else before.inventory.globalReserveItemCount=beforeValue;
 if(afterValue===absent) delete v.manifest.inventory.globalReserveItemCount;else v.manifest.inventory.globalReserveItemCount=afterValue;
 if(change)v.manifest.profiles[0].timeLimitMinutes+=1;
 return diff(c,before,v,noIndex?null:fingerprints(c));
}
test('review reproduction: older identical snapshot must not invent FORM_CHANGE',()=>{const r=counts(absent,2);assert.equal(r.overallChangeClassification,'NO_CHANGE',JSON.stringify({classification:r.overallChangeClassification,global:r.aggregateInventory.globalReserveItemCount}));assert.ok(r.findings.includes('GLOBAL_RESERVE_COMPARISON_UNAVAILABLE'));});
for(const [a,b] of [[2,2],[0,0],[0,2],[2,0]])test(`known ${a} vs ${b}`,()=>{const r=counts(a,b),g=r.aggregateInventory.globalReserveItemCount;assert.equal(g.availability,'available');assert.equal(g.delta,b-a);assert.equal(r.overallChangeClassification,a===b?'NO_CHANGE':'FORM_CHANGE');});
for(const [label,value] of [['absent',absent],['null',null],['negative',-1],['fraction',1.5],['string','2'],['boolean',false],['object',{}]])for(const known of [0,2])for(const reverse of [false,true])test(`${label} ${reverse?'candidate':'current'} vs known ${known}`,()=>{
 const r=counts(reverse?known:value,reverse?value:known),g=r.aggregateInventory.globalReserveItemCount;
 assert.equal(g.availability,'unavailable');assert.equal(g.delta,null);assert.equal(reverse?g.current:g.candidate,known);assert.equal(reverse?g.candidate:g.current,null);
 assert.equal(r.overallChangeClassification,'NO_CHANGE');assert.ok(r.findings.includes('GLOBAL_RESERVE_COMPARISON_UNAVAILABLE'));
 assert.match(formatExamOperationsReleaseDiff(r),/Global reserves:.*unavailable/);
});
for(const [a,b] of [[absent,absent],[null,null],[absent,null],[null,absent]])test('both unavailable stay qualified',()=>{const r=counts(a,b);assert.equal(r.aggregateInventory.globalReserveItemCount.delta,null);assert.ok(r.findings.includes('GLOBAL_RESERVE_COMPARISON_UNAVAILABLE'));});
test('unknown alongside real profile change retains change plus qualification',()=>{const r=counts(absent,2,true);assert.equal(r.overallChangeClassification,'PROFILE_CHANGE');assert.ok(r.findings.includes('GLOBAL_RESERVE_COMPARISON_UNAVAILABLE'));});
test('unknown aggregate fallback cannot fabricate content change',()=>{const r=counts(null,2,false,true);assert.equal(r.overallChangeClassification,'NO_CHANGE');assert.equal(r.aggregateInventory.changed,false);assert.ok(r.findings.includes('GLOBAL_RESERVE_COMPARISON_UNAVAILABLE'));});
test('unknown does not hide genuine form membership changes',()=>{
 const c=reserveCandidate(),before=current(c);delete before.inventory.globalReserveItemCount;const changed=structuredClone(c);const f=changed.profiles[0].selection.canonicalForms.forms[0];f.questionIds.reverse();f.membershipHash=sha256Canonical(f.questionIds);
 const r=diff(changed,before);assert.equal(r.overallChangeClassification,'FORM_CHANGE');assert.ok(r.findings.includes('GLOBAL_RESERVE_COMPARISON_UNAVAILABLE'));
});
// Real raw-snapshot normalizer, with the pre-existing package reserve statistic
// absent/null/invalid. No candidate-derived value is supplied to fill the gap.
function rawState(c,global) {
 const id='pkg',ps=c.profiles.map((p,i)=>({internalPackageId:id,internalProfileId:`p${i}`,profileKey:p.profileKey,displayName:p.displayName,questionCount:p.questionCount,timeLimitMinutes:p.timeLimitMinutes,formContractVersion:p.selection.canonicalForms.contractVersion,reserveItemCount:p.selection.canonicalForms.reserveQuestionIds.length}));
 return {examKey:c.exam.examKey,packages:[{internalPackageId:id,packageVersion:'1.0.0',status:'published',packageHash:sha256Canonical(c),validationHash:c.source.validationHash,packageSchemaVersion:c.packageSchemaVersion,...c.runtime,declaredReviewReleasePolicy:'after_submission',declaredAnswerReleasePolicy:'after_submission'}],profiles:ps,defaults:ps.map(p=>({...p,purpose:'self_directed_exam',enabled:true})),activations:ps.map(p=>({...p,activationKind:'production',enabled:true})),practicePolicies:[],questionRecords:c.questions.map(q=>({internalPackageId:id,questionIdentity:q.id,contentHash:fingerprints(c).find(f=>f.identity===q.id).contentHash,interactionType:q.type,domainKey:q.domainKey,objectiveKey:q.sectionKey??q.presentation.officialObjectiveKey,scored:true})),forms:ps.flatMap((p,i)=>c.profiles[i].selection.canonicalForms.forms.map(f=>({internalPackageId:id,internalProfileId:p.internalProfileId,formOrdinal:f.ordinal,itemCount:p.questionCount,scoredItemCount:p.questionCount,membershipHash:f.membershipHash}))),packageStats:[{internalPackageId:id,...(global===absent?{}:{reserveItemCount:global})}]};
}
for(const value of [absent,null,-1,'2'])test('older/unknown raw snapshot round-trip',()=>{const c=reserveCandidate(),built=buildExamOperationsCurrentState(rawState(c,value),c.exam.examKey);assert.equal(built.snapshot.currentPackage.inventory.globalReserveItemCount,null);assert.equal(built.snapshot.currentPackage.inventory.globalReserveItemCountState,value===absent?'absent':value===null?'unknown':'invalid');const r=compare({currentState:built.snapshot,candidateValidation:validate(c),currentFingerprintIndex:built.privateComparisonIndex,candidateContract:c});assert.equal(r.aggregateInventory.globalReserveItemCount.delta,null);assert.equal(r.overallChangeClassification,'NO_CHANGE');assert.ok(r.findings.includes('GLOBAL_RESERVE_COMPARISON_UNAVAILABLE'));});
for(const value of [0,2])test('known raw snapshot count round-trip',()=>{const c=reserveCandidate(),built=buildExamOperationsCurrentState(rawState(c,value),c.exam.examKey);assert.equal(built.snapshot.currentPackage.inventory.globalReserveItemCount,value);assert.equal(built.snapshot.currentPackage.inventory.globalReserveItemCountState,'known');});
test('rich older snapshot remains unchanged with explicit unavailable qualification',()=>{const c=richReserveCandidate(),before=current(c);delete before.inventory.globalReserveItemCount;const r=diff(c,before);assert.equal(r.overallChangeClassification,'NO_CHANGE');assert.ok(r.findings.includes('GLOBAL_RESERVE_COMPARISON_UNAVAILABLE'));});
for(const factory of [reserveCandidate,richReserveCandidate])test(`${factory.name} legacy profile fallback only with proven shared equivalence`,()=>{const c=factory(),raw=rawState(c,factory===reserveCandidate?2:1);for(const p of raw.profiles)delete p.reserveItemCount;const built=buildExamOperationsCurrentState(raw,c.exam.examKey),r=compare({currentState:built.snapshot,candidateValidation:validate(c),currentFingerprintIndex:built.privateComparisonIndex,candidateContract:c});assert.equal(r.overallChangeClassification,'NO_CHANGE');for(const p of built.snapshot.currentPackage.profiles)assert.equal(p.forms.reserveItemCount,factory===reserveCandidate?null:1);assert.equal(r.findings.includes('PROFILE_RESERVE_COMPARISON_UNAVAILABLE'),factory===reserveCandidate);});
test('dynamic-to-dynamic count is inapplicable and comparison qualified',()=>{const c=reserveCandidate();for(const p of c.profiles)delete p.selection.canonicalForms;const r=diff(c);assert.equal(r.overallChangeClassification,'NO_CHANGE');assert.equal(r.aggregateInventory.globalReserveItemCount.candidateState,'not_applicable');assert.ok(r.findings.includes('GLOBAL_RESERVE_COMPARISON_UNAVAILABLE'));});
test('invalid candidate remains invalid with no fixed projection',()=>{const original=reserveCandidate(),c=structuredClone(original);c.profiles[0].selection.canonicalForms=null;const r=diff(c,current(original));assert.equal(r.overallChangeClassification,'INVALID_CANDIDATE');assert.equal(r.aggregateInventory.globalReserveItemCount.candidate,null);assert.equal(r.aggregateInventory.globalReserveItemCount.candidateState,'invalid');});
console.log(JSON.stringify({suite:'issue214-review-corrections',passed,failed,syntheticOnly:true}));
if(failed)process.exitCode=1;
