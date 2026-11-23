import assert from 'node:assert/strict';
import test from 'node:test';
import { mapAttempt, mapAttemptItemPage, mapEligibility, mapPracticeAvailability } from '../supabase/functions/certsim-protected-exam/responses.ts';
function fixture() {
  const items=Array.from({length:3},(_,i)=>({itemId:`item-${i}`,questionId:`question-${i}`,questionType:'true-false-composite-v1',questionNumber:i+1,
    presentation:{interactionVersion:'true-false-composite-v1',statements:[{id:'a',text:'Synthetic'}]},revision:0,response:null}));
  return {attempt:{attemptId:'synthetic-attempt',itemCount:3,countContract:{version:'certsim-authorised-form-count-v1',mode:'variable',exactCount:3,allowedCounts:[3,5],
    composition:{standardQuestionCount:3,caseStudyCount:0,caseStudyQuestionCount:0,pbqCount:0,executableCount:0},
    bindings:items.map(i=>({itemId:i.itemId,questionId:i.questionId,questionType:i.questionType,questionNumber:i.questionNumber}))}},items};
}
test('Edge carries only safe exact selected-form metadata',()=>{
  const f=fixture(); f.attempt.countContract.otherProtectedField='omitted';
  assert.equal(mapAttempt(f).attempt.countContract.exactCount,3);
  assert.equal('otherProtectedField' in mapAttempt(f).attempt.countContract,false);
});
for(const [label,mutate] of Object.entries({
  'wrong same-count member':f=>{f.items[0].questionId='other';},
  'missing raw position':f=>{delete f.items[0].questionNumber;},
  'wrong raw position':f=>{f.items[0].questionNumber=2;},
  'wrong response binding':f=>{f.items[0].questionType='matching-v1';},
  'missing exact count':f=>{delete f.attempt.countContract.exactCount;},
  'unknown delivery':f=>{f.attempt.countContract.version='unknown';},
  'wrong count summary':f=>{f.attempt.itemCount=5;},
  'duplicate binding':f=>{f.attempt.countContract.bindings[1]=f.attempt.countContract.bindings[0];},
})) test(`Edge rejects ${label}`,()=>{const f=fixture();mutate(f);assert.throws(()=>mapAttempt(f),{code:'internal_failure'});});
test('eligibility and availability preserve safe policy and reject contradictions',()=>{
  const policy={version:'certsim-authorised-form-count-v1',mode:'authorised-form-counts-v1',allowedCounts:[3,5],minimum:3,maximum:5};
  assert.deepEqual(mapEligibility({countPolicy:policy}).countPolicy,policy);
  assert.deepEqual(mapPracticeAvailability({countPolicy:policy}).countPolicy,policy);
  assert.throws(()=>mapEligibility({countPolicy:{...policy,maximum:4}}),{code:'internal_failure'});
});
for (const policy of [undefined, false, true, 'false', null, 1, {}]) test(`new matching DTO policy ${JSON.stringify(policy)}`,()=>{
  const f=fixture(), item=f.items[0];
  item.questionType='matching-v1';
  item.presentation={interactionVersion:'matching-v1',sources:[{id:'a',text:'Synthetic source'}],targets:[{id:'x',text:'Synthetic target'}]};
  f.attempt.countContract.bindings[0].questionType=item.questionType;
  f.presentationPolicy={version:'certsim-attempt-presentation-v1',attemptId:f.attempt.attemptId,matchingReuse:'strict-boolean-default-false'};
  if(policy!==undefined)item.presentation.allowTargetReuse=policy;
  if(policy!==undefined && typeof policy!=='boolean')assert.throws(()=>mapAttempt(f),{code:'internal_failure'});
  else assert.equal(mapAttempt(f).items[0].presentation.allowTargetReuse,policy===true);
  if(policy===undefined){delete f.attempt.countContract;delete f.presentationPolicy;assert.equal(Object.hasOwn(mapAttempt(f).items[0].presentation,'allowTargetReuse'),false);}
});

function matchingFixture(policy, mode='strict-boolean-default-false') {
  const f=fixture();delete f.attempt.countContract;f.attempt.purpose='study_sandbox';
  f.presentationPolicy={version:'certsim-attempt-presentation-v1',attemptId:f.attempt.attemptId,matchingReuse:mode};
  f.items=f.items.slice(0,1);f.items[0].questionType='matching-v1';
  f.items[0].presentation={interactionVersion:'matching-v1',sources:[{id:'a',text:'Synthetic A'}],targets:[{id:'x',text:'Synthetic X'}],...(policy===undefined?{}:{allowTargetReuse:policy})};
  return f;
}
const pageOf=f=>({items:f.items,afterPosition:20,returnedThrough:21,totalCount:30,hasMore:true,presentationPolicy:f.presentationPolicy});
for(const mode of ['strict-boolean-default-false','legacy-preserve'])for(const policy of [undefined,false,true])test(`shared initial/page normalization ${mode} ${policy}`,()=>{
  const f=matchingFixture(policy,mode),before=structuredClone(f);
  const initial=mapAttempt(f),paged=mapAttemptItemPage(pageOf(f),f.attempt.attemptId);
  assert.equal(initial.items[0].presentation.allowTargetReuse,mode==='legacy-preserve'?policy:policy===true);
  assert.deepEqual(paged.items[0].presentation,initial.items[0].presentation);
  assert.equal(Object.hasOwn(initial,'presentationPolicy'),false);assert.equal(Object.hasOwn(paged,'presentationPolicy'),false);
  assert.deepEqual(f,before);
});
for(const policy of [null,'true','false','not-a-boolean',0,1,[],{}])test(`shared strict practice corrupt value ${JSON.stringify(policy)}`,()=>{
  const f=matchingFixture(policy);assert.throws(()=>mapAttempt(f),{code:'internal_failure'});assert.throws(()=>mapAttemptItemPage(pageOf(f),f.attempt.attemptId),{code:'internal_failure'});
});
for(const [name,change] of Object.entries({null:f=>{f.presentationPolicy=null;},unknown:f=>{f.presentationPolicy.matchingReuse='unknown';},arrayMode:f=>{f.presentationPolicy.matchingReuse=['strict-boolean-default-false'];},version:f=>{f.presentationPolicy.version='unknown';},wrongAttempt:f=>{f.presentationPolicy.attemptId='other-attempt';},extra:f=>{f.presentationPolicy.extra='blocked';}}))test(`presentation context rejects ${name}`,()=>{
  const f=matchingFixture(undefined);change(f);assert.throws(()=>mapAttempt(f),{code:'internal_failure'});assert.throws(()=>mapAttemptItemPage(pageOf(f),'synthetic-attempt'),{code:'internal_failure'});
});
test('page context must bind expected request and policy normalization does not mutate frozen input',()=>{
  const f=matchingFixture(undefined);assert.throws(()=>mapAttemptItemPage(pageOf(f)),{code:'internal_failure'});assert.throws(()=>mapAttemptItemPage(pageOf(f),'other-attempt'),{code:'internal_failure'});
  const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};freeze(f);assert.equal(mapAttempt(f).items[0].presentation.allowTargetReuse,false);assert.equal(mapAttemptItemPage(pageOf(f),'synthetic-attempt').items[0].presentation.allowTargetReuse,false);
});
test('page binding compares UUID identity independent of route letter case',()=>{
 const f=matchingFixture(undefined);f.attempt.attemptId='abcdefab-1234-4234-8234-abcdefabcdef';f.presentationPolicy.attemptId=f.attempt.attemptId;
 assert.equal(mapAttemptItemPage(pageOf(f),f.attempt.attemptId.toUpperCase()).items[0].presentation.allowTargetReuse,false);
});
