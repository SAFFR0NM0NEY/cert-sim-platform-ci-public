import { MIXED_PYTHON_FORMS, MIXED_COUNT_DELIVERY } from '../backend-exam-publication/variable-python-forms.mjs';
import { variablePythonCandidate } from './variable-python-forms.mjs';
import { sha256Canonical } from '../backend-exam-publication/canonical-json.mjs';
export const PRACTICE_POLICIES = ['omitted','false','true'];
export function practiceMatchingCandidate(policy='omitted', legacy=false, version=`sandbox-${policy}.1`) {
  const c=variablePythonCandidate(), template=c.questions.find(q=>q.type==='matching-v1');
  c.exam.packageVersion=version;c.exam.capabilities=['matching-v1'];
  c.questions=Array.from({length:30},(_,i)=>{
    const q=structuredClone(template);q.id=`synthetic-sandbox-${policy}-${i+1}`;
    q.privateReview={explanation:'Synthetic matching feedback.',remediation:'Synthetic matching feedback.'};
    if(policy!=='omitted')q.presentation.allowTargetReuse=policy==='true';
    if(policy==='true')q.privateScoring.correctTargetIdsBySource.b='x';
    return q;
  });
  const p=c.profiles[0], contract=p.selection.canonicalForms;
  contract.forms=[c.questions.slice(0,3),c.questions.slice(3,8)].map((qs,i)=>({
    ...structuredClone(contract.forms[i]),questionCount:qs.length,questionIds:qs.map(q=>q.id),
    membershipHash:sha256Canonical(qs.map(q=>q.id)),rawMaximum:qs.length*2,
  }));
  contract.reserveQuestionIds=c.questions.slice(8).map(q=>q.id);
  if(legacy){
    c.exam.packageVersion=`legacy-${policy}.1`;c.runtime.generatorVersion='certsim-python-standard-canonical-forms-v1';p.questionCount=3;p.selection.standardQuestionCount=3;
    contract.contractVersion='certsim-python-standard-forms-v1';delete contract.countPolicy;delete contract.deliveryContract;
    contract.forms= [c.questions.slice(0,3),c.questions.slice(3,6)].map((qs,i)=>({formKey:`legacy-${i}`,ordinal:i+1,questionIds:qs.map(q=>q.id),membershipHash:sha256Canonical(qs.map(q=>q.id)),rawMaximum:6}));
    contract.reserveQuestionIds=c.questions.slice(6).map(q=>q.id);
  }
  if(!legacy && process.env.MIXED_PRACTICE_CONTRACT==='true'){c.runtime.generatorVersion=MIXED_PYTHON_FORMS;contract.contractVersion=MIXED_PYTHON_FORMS;contract.deliveryContract=MIXED_COUNT_DELIVERY;}
  return c;
}
