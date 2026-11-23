import test from 'node:test';import assert from 'node:assert/strict';
import {mixedVariableCandidate,MIXED_INVALID_CASES} from './fixtures/mixed-variable-forms.mjs';
import {validateExamOperationsCandidate} from './backend-exam-publication/exam-operations-candidate.mjs';
import {variableQuestionMaximum,MIXED_PYTHON_FORMS} from './backend-exam-publication/variable-python-forms.mjs';
import {mapAttempt} from '../supabase/functions/certsim-protected-exam/responses.ts';
import {assertVariableFormInventory} from '../src/lib/protectedAttemptInventory.js';
test('mixed native package uses distinct capability and independent5/9 maxima',()=>{
 const c=mixedVariableCandidate(),v=validateExamOperationsCandidate(c);assert.equal(v.ok,true);
 assert.equal(v.manifest.compatibility.requiredDeliveryContract,'certsim-authorised-form-count-v2');
 assert.equal(variableQuestionMaximum(c.questions[0],MIXED_PYTHON_FORMS),1);
 assert.throws(()=>variableQuestionMaximum(c.questions[0]));
});
for(const [name,change] of MIXED_INVALID_CASES)for(const index of [0,8])test('normal mixed preflight '+name+' '+(index?'reserve':'selected'),()=>{
 const c=mixedVariableCandidate();change(c.questions[index]);assert.equal(validateExamOperationsCandidate(c).ok,false);
});
test('v2 cannot silently inherit native choice',()=>{
 const c=mixedVariableCandidate();c.runtime.generatorVersion=c.profiles[0].selection.canonicalForms.contractVersion='certsim-python-standard-variable-forms-v2';
 c.profiles[0].selection.canonicalForms.deliveryContract='certsim-authorised-form-count-v1';assert.equal(validateExamOperationsCandidate(c).ok,false);
});
function dto(){const items=Array.from({length:3},(_,i)=>({itemId:'item-'+i,questionId:'question-'+i,questionType:'single-choice',questionNumber:i+1,presentation:{prompt:'Synthetic',interactionVersion:'selected-response-v1',options:[{id:'yes',text:'Synthetic'}]}}));
 return {attempt:{attemptId:'attempt',itemCount:3,countContract:{version:'certsim-authorised-form-count-v2',mode:'variable',exactCount:3,allowedCounts:[3,5],composition:{standardQuestionCount:3,caseStudyCount:0,caseStudyQuestionCount:0,pbqCount:0,executableCount:0},bindings:items.map(({itemId,questionId,questionType,questionNumber})=>({itemId,questionId,questionType,questionNumber}))}},items};}
test('exact mixed native bindings pass Edge and actual client inventory',()=>{
 const d=dto(),mapped=mapAttempt(d);assertVariableFormInventory(mapped.attempt.countContract,mapped.items.map(i=>({id:i.itemId,sourceQuestionId:i.questionId,type:i.questionType,questionNumber:i.questionNumber})));
 d.attempt.countContract.version='certsim-authorised-form-count-v1';assert.throws(()=>mapAttempt(d));
});
for(const [name,mutate] of Object.entries({missing:d=>d.items.pop(),extra:d=>d.items.push(d.items[0]),wrongMember:d=>d.items[0].questionId='wrong',order:d=>d.items.reverse(),type:d=>d.items[0].questionType='matching-v1'}))test('mixed DTO rejects '+name,()=>{
 const d=dto();mutate(d);assert.throws(()=>mapAttempt(d));
});

import {handleProtectedExam} from '../supabase/functions/certsim-protected-exam/handler.ts';
async function transport(responses,header='certsim-authorised-form-count-v2'){
 const calls=[],id='21400000-0000-4000-8000-000000000002';
 const request=new Request('http://localhost/functions/v1/certsim-protected-exam/attempts',{method:'POST',headers:{authorization:'Bearer synthetic','content-type':'application/json','x-client-info':header},body:JSON.stringify({examKey:'inf303',profileId:'inf303-standard',clientRequestId:id})});
 const r=await handleProtectedExam(request,{userClient:{auth:{getUser:async()=>({data:{user:{id}},error:null})}},createAdmin:()=>({rpc:async(name,args)=>{calls.push({name,args});return responses.shift();}}),log:()=>{}});
 return {status:r.status,body:await r.json(),calls};
}
test('mixed shim absence falls back through explicit old shim then fixed RPC',async()=>{
 const r=await transport([{error:{code:'PGRST202'},data:null},{error:{code:'PGRST202'},data:null},{error:null,data:{attempt:{attemptId:'synthetic'},items:[]}}]);
 assert.equal(r.status,201);assert.deepEqual(r.calls.map(c=>c.name),['certsim_protected_mixed_count_contract','certsim_protected_count_contract','certsim_protected_start_attempt']);
 assert.equal(r.calls[1].args.p_count_contract,'certsim-authorised-form-count-v1');
});
for(const code of ['42501','PGRST301','08006'])test('mixed '+code+' cannot downgrade',async()=>{
 const r=await transport([{error:{code},data:null}]);assert.equal(r.status,500);assert.equal(r.calls.length,1);
});
test('old v1 client gets controlled mixed-contract denial without second Start',async()=>{
 const r=await transport([{error:{message:'count_contract_required'},data:null}],'certsim-authorised-form-count-v1');assert.equal(r.status,409);assert.equal(r.calls.length,1);
});
for(const [name,mutate] of Object.entries({missing:a=>a.pop(),extra:a=>a.push(a[0]),wrongMember:a=>a[0].sourceQuestionId='wrong',wrongType:a=>a[0].type='matching-v1',order:a=>a.reverse()}))test('actual mixed client inventory rejects '+name,()=>{
 const d=dto(),a=d.items.map(i=>({id:i.itemId,sourceQuestionId:i.questionId,type:i.questionType,questionNumber:i.questionNumber}));mutate(a);assert.throws(()=>assertVariableFormInventory(d.attempt.countContract,a));
});

