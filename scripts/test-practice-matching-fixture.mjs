import assert from 'node:assert/strict';
import test from 'node:test';
import {practiceMatchingCandidate} from './fixtures/practice-matching.mjs';
import {validateExamOperationsCandidate} from './backend-exam-publication/exam-operations-candidate.mjs';
for(const legacy of [false,true])for(const policy of ['omitted','false','true'])test(`normal preflight sandbox fixture ${legacy?'legacy':'new'} ${policy}`,()=>{
 const c=practiceMatchingCandidate(policy,legacy),r=validateExamOperationsCandidate(c);assert.equal(r.ok,true);assert.equal(c.questions.length,30);
 const f=c.profiles[0].selection.canonicalForms;assert.equal(f.reserveQuestionIds.length,legacy?24:22);
 assert.deepEqual(f.forms.map(x=>x.rawMaximum),legacy?[6,6]:[6,10]);
 assert.equal(c.questions.every(q=>q.type==='matching-v1'),true);
});
