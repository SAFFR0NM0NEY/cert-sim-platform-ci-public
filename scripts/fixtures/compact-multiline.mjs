import {mixedVariableCandidate} from './mixed-variable-forms.mjs';
import {sha256Canonical} from '../backend-exam-publication/canonical-json.mjs';
import {multilineMatchingQuestion} from './multiline-matching.mjs';

export function combinedProfileCandidate() {
  const c=mixedVariableCandidate();
  const labels=multilineMatchingQuestion().targets;
  c.questions[6].presentation.targets=c.questions[6].presentation.targets.map((t,i)=>({...t,text:labels[i].text}));
  const members=[[c.questions[0],c.questions[1]],[c.questions[6],c.questions[5]]];
  const selected=new Set(members.flat().map(q=>q.id));
  c.profiles.push({profileKey:'inf303-compact',displayName:'Synthetic fixed compact',questionCount:2,timeLimitMinutes:60,
    selection:{preserveRequiredGroups:true,scoringContract:{model:'versioned-structured-partial-v1',normalization:'form-raw-maximum-v1'},
      canonicalForms:{contractVersion:'certsim-python-standard-forms-v1',cycleLength:2,reservePolicy:'profile-specific-reserve',reserveQuestionIds:c.questions.filter(q=>!selected.has(q.id)).map(q=>q.id),
        forms:members.map((qs,i)=>({formKey:'synthetic-compact-'+(i+1),ordinal:i+1,questionIds:qs.map(q=>q.id),membershipHash:sha256Canonical(qs.map(q=>q.id)),rawMaximum:qs.reduce((n,q)=>n+q.privateScoring.maximumRawPoints,0)}))}}});
  return c;
}

