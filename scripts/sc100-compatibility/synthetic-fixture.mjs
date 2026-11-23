import {sha256Canonical} from '../backend-exam-publication/canonical-json.mjs';
// Synthetic disposable fixtures only. No private-vault imports or authored bank.
export function syntheticSc100(){
 const questions=[],forms=[];
 for(let f=0;f<6;f++){
  const ids=[];
  for(let i=0;i<50;i++){
   const id=`synthetic-${f}-${i}`,multi=i>=((f%2)?37:38),required=multi?2:1;
   const domainKey=i<11?'d1':i<25?'d2':i<39?'d3':'d4';ids.push(id);
   questions.push({id,type:multi?'multi-select':'single-choice',domainKey,sectionKey:'selected-response',scored:true,group:null,
    presentation:{prompt:'Synthetic selected-response fixture',options:['a','b','c'].map(id=>({id,text:'Synthetic option'})),requiredSelections:required,officialSkillGroup:domainKey,officialObjectiveKey:`objective-${i%14}`,difficulty:i<5?'easy':i<((f%2)?32:33)?'medium':'advanced',cognitiveStyle:i<10?'knowledge':'scenario',coverageTags:[i<10?'knowledge':'scenario']},
    privateScoring:{model:'per-correct-option-no-negative-v1',correctAnswers:multi?['a','b']:['a'],maximumRawPoints:required,selectionCap:required},privateReview:{explanation:'Synthetic fixture review'}});
  }
  forms.push({formKey:`synthetic-form-${f+1}`,ordinal:f+1,questionIds:ids,membershipHash:sha256Canonical(ids)});
 }
 const canonicalForms={contractVersion:'certsim-canonical-forms-v2',profileKey:'sc100-full',questionCount:50,cycleLength:6,reservePolicy:'practice-only-until-versioned-rebalance',reserveQuestionIds:[],skillGroupTargets:{d1:11,d2:14,d3:14,d4:11},requiredObjectiveKeys:Array.from({length:14},(_,i)=>`objective-${i}`),minimumCoverageTagCounts:{knowledge:10,scenario:40},difficultyRequirements:{minimumMedium:27,minimumHardOrAdvanced:17,minimumAdvanced:17},forms};
 const releasePolicy={review:'after_submission',answers:'after_submission'};
 return {packageSchemaVersion:'certsim-protected-package-v2',validationContractVersion:'certsim-protected-multi-exam-validation-v1',exam:{examKey:'sc100',packageVersion:'1.0.0',capabilities:['single-choice','multi-select'],domains:['d1','d2','d3','d4'].map(key=>({key,name:key}))},source:{sourceHash:sha256Canonical(questions),validationHash:'a'.repeat(64)},runtime:{generatorVersion:'certsim-sc200-canonical-forms-v1',scorerVersion:'certsim-selected-response-partial-v1'},profiles:[{profileKey:'sc100-full',displayName:'Synthetic full',questionCount:50,timeLimitMinutes:100,selection:{preserveRequiredGroups:true,canonicalForms,formalReleasePolicy:releasePolicy,scoringContract:{model:'per-correct-option-no-negative-v1',normalization:'form-raw-maximum-v1'}}}],releasePolicy,supportedReleasePolicies:['after_submission'],questions};
}
export function legacySyntheticSc100(){
 const p=syntheticSc100();p.runtime.generatorVersion='certsim-sc100-canonical-forms-v1';const c=p.profiles[0].selection.canonicalForms;
 for(const k of ['skillGroupTargets','requiredObjectiveKeys','minimumCoverageTagCounts','difficultyRequirements'])delete c[k];
 c.reservePolicy='none-disjoint-full-bank';delete p.profiles[0].selection.formalReleasePolicy;
 c.forms.forEach((f,i)=>f.rawMaximum=i%2?63:62);
 p.questions.forEach(q=>{delete q.presentation.officialSkillGroup;delete q.presentation.coverageTags;q.presentation.difficulty=q.presentation.difficulty==='easy'?'foundational':q.presentation.difficulty==='medium'?'applied':q.presentation.difficulty;});
 return p;
}

export function syntheticSc100Compact(){
 const p=syntheticSc100(),full=p.profiles[0];p.exam.packageVersion='1.1.0';
 const first=[0,2,4,6,8,10,12,13,15,17,19,21,23,25,27,29,31,33,35,38,39,41,43,45,47];
 const forms=full.selection.canonicalForms.forms.map((f,i)=>{
  const questionIds=first.map(n=>f.questionIds[n]);
  return {formKey:`synthetic-compact-${i+1}`,ordinal:i+1,questionIds,membershipHash:sha256Canonical(questionIds)};
 });
 const canonical={...structuredClone(full.selection.canonicalForms),profileKey:'sc100-compact',questionCount:25,
  skillGroupTargets:{d1:6,d2:7,d3:7,d4:5},
  minimumCoverageTagCounts:{knowledge:5,scenario:20},difficultyRequirements:{minimumMedium:14,minimumHardOrAdvanced:8,minimumAdvanced:8},forms};
 p.profiles.push({...structuredClone(full),profileKey:'sc100-compact',displayName:'Synthetic Compact',questionCount:25,timeLimitMinutes:50,selection:{...structuredClone(full.selection),canonicalForms:canonical}});
 return p;
}
