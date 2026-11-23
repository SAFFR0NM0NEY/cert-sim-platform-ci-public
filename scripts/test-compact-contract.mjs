import assert from 'node:assert/strict';
import test from 'node:test';
import {combinedProfileCandidate} from './fixtures/compact-multiline.mjs';
import {validateExamOperationsCandidate} from './backend-exam-publication/exam-operations-candidate.mjs';
const before=process.argv.includes('--before');
if(before){const r=validateExamOperationsCandidate(combinedProfileCandidate());assert.equal(r.ok,false);assert(r.validation.errors.some(e=>e.code==='VARIABLE_FORM_CONTRACT_REQUIRED'));console.log(JSON.stringify({suite:'combined-before98',combinedPreflightRejected:true,code:'VARIABLE_FORM_CONTRACT_REQUIRED',syntheticOnly:true}));}
else {
 test('v3 variable and explicit fixed Python contracts coexist without changing fixed members/timer',()=>{const c=combinedProfileCandidate(),fixed=structuredClone(c.profiles[1]);const r=validateExamOperationsCandidate(c);assert.equal(r.ok,true);assert.deepEqual(c.profiles[1],fixed);assert.equal(r.manifest.profiles.length,2);});
 for(const mode of ['v2','fixed-only','rich-mixture','missing-contract','invalid-fixed-count','overlapping-fixed-forms','bad-fixed-raw','extra-fixed-field','extra-fixed-form-field','invalid-release','nonstring-fixed-key','null-fixed-form'])test('unsupported combined declaration rejects '+mode,()=>{
  const c=combinedProfileCandidate(),p=c.profiles[1];
  if(mode==='v2'){c.runtime.generatorVersion='certsim-python-standard-variable-forms-v2';c.profiles[0].selection.canonicalForms.contractVersion='certsim-python-standard-variable-forms-v2';}
  if(mode==='fixed-only'){c.profiles=[p];}
  if(mode==='rich-mixture')p.selection.canonicalForms.contractVersion='certsim-canonical-forms-v2';
  if(mode==='missing-contract')delete p.selection.canonicalForms;
  if(mode==='invalid-fixed-count')p.questionCount=3;
  if(mode==='overlapping-fixed-forms')p.selection.canonicalForms.forms[1]=structuredClone(p.selection.canonicalForms.forms[0]);
  if(mode==='nonstring-fixed-key')p.selection.canonicalForms.forms[0].formKey=1;
  if(mode==='null-fixed-form')p.selection.canonicalForms.forms[0]=null;
  if(mode==='extra-fixed-field')p.selection.canonicalForms.deliveryContract='unsupported';
  if(mode==='extra-fixed-form-field')p.selection.canonicalForms.forms[0].questionCount=2;
  if(mode==='invalid-release')p.selection.formalReleasePolicy={review:'never',answers:'never'};
  if(mode==='bad-fixed-raw')p.selection.canonicalForms.forms[0].rawMaximum++;
  assert.equal(validateExamOperationsCandidate(c).ok,false);
 });
}
