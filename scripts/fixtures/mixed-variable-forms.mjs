import {variablePythonCandidate} from './variable-python-forms.mjs';
import {MIXED_PYTHON_FORMS,MIXED_COUNT_DELIVERY} from '../backend-exam-publication/variable-python-forms.mjs';
export function mixedVariableCandidate(){
 const c=variablePythonCandidate();c.runtime.generatorVersion=MIXED_PYTHON_FORMS;
 c.exam.capabilities.unshift('single-choice');
 const f=c.profiles[0].selection.canonicalForms;f.contractVersion=MIXED_PYTHON_FORMS;f.deliveryContract=MIXED_COUNT_DELIVERY;
 for(const i of [0,3,8])c.questions[i]={...c.questions[i],type:'single-choice',
  presentation:{prompt:'Synthetic native choice.',interactionVersion:'selected-response-v1',difficulty:'medium',coverageTags:['synthetic-coverage'],options:[{id:'yes',text:'Synthetic correct choice'},{id:'no',text:'Synthetic incorrect choice'}]},
  privateScoring:{model:'exact-single-v1',correctOptionId:'yes',maximumRawPoints:1},privateReview:{explanation:'Synthetic choice review.'}};
 f.forms[0].rawMaximum=5;f.forms[1].rawMaximum=9;return c;
}
export const MIXED_INVALID_CASES=[
 ['empty options',q=>q.presentation.options=[]],['duplicate options',q=>q.presentation.options[1].id='yes'],
 ['null options',q=>q.presentation.options=null],['blank option identity',q=>q.presentation.options[0].id=''],
 ['option identity type',q=>q.presentation.options[0].id=1],['blank option text',q=>q.presentation.options[0].text=''],
 ['missing key',q=>delete q.privateScoring.correctOptionId],['unknown key',q=>q.privateScoring.correctOptionId='unknown'],
 ['key type',q=>q.privateScoring.correctOptionId=['yes']],['conflicting legacy key',q=>q.privateScoring.correctAnswer='no'],
 ['wrong model',q=>q.privateScoring.model='unknown'],['wrong raw maximum',q=>q.privateScoring.maximumRawPoints=2],
 ['raw maximum type',q=>q.privateScoring.maximumRawPoints='1'],['interaction mismatch',q=>q.presentation.interactionVersion='single-choice'],
 ['scored false',q=>q.scored=false],['scored string',q=>q.scored='true'],
];
export function syntheticMixedAnswer(item,wrong=false){
 switch(item.questionType??item.type){
  case 'single-choice':return {answer:wrong?'no':'yes'};
  case 'true-false-single-v1':return {answer:true};
  case 'true-false-composite-v1':return {answer:{a:true,b:false}};
  case 'matching-v1':return {answer:{a:'x',b:'y'}};
  case 'code-dropdown-completion-v1':return {answer:{a:'x',b:'x'}};
  default:throw Error('SYNTHETIC_TYPE_REQUIRED');
 }
}

