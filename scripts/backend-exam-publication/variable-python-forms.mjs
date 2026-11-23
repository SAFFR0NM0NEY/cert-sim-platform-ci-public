import { sha256Canonical } from './canonical-json.mjs';
export const VARIABLE_PYTHON_FORMS = 'certsim-python-standard-variable-forms-v2';
export const MIXED_PYTHON_FORMS = 'certsim-python-standard-variable-forms-v3';
export const MIXED_COUNT_DELIVERY = 'certsim-authorised-form-count-v2';
export const isVariablePythonForms = version => [VARIABLE_PYTHON_FORMS, MIXED_PYTHON_FORMS].includes(version);
export const FORM_COUNT_DELIVERY = 'certsim-authorised-form-count-v1';
export const VARIABLE_PYTHON_SCORER = 'certsim-versioned-structured-partial-v1';
export const VARIABLE_ITEM_LIMIT = 50; // technical delivery bound, not exam policy
export const VARIABLE_INTERACTIONS = Object.freeze(['true-false-single-v1','true-false-composite-v1','matching-v1','code-dropdown-completion-v1']);
export const MIXED_INTERACTIONS = Object.freeze(['single-choice', ...VARIABLE_INTERACTIONS]);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const integer = n => Number.isSafeInteger(n) && n > 0 && n <= VARIABLE_ITEM_LIMIT;
const exact = (v, keys) => object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v,k));
const unique = a => Array.isArray(a) && new Set(a).size === a.length;
const text = s => typeof s === 'string' && s.trim().length > 0;
const nonnegative = n => Number.isSafeInteger(n) && n >= 0;
export function variableQuestionMaximum(q, version = VARIABLE_PYTHON_FORMS) {
  const p=q?.presentation,s=q?.privateScoring;
  const mixed = version === MIXED_PYTHON_FORMS;
  if (!(mixed ? MIXED_INTERACTIONS : VARIABLE_INTERACTIONS).includes(q?.type) || (q.group != null && (!object(q.group) || Object.keys(q.group).length > 0)) || !object(p) || !object(s) || p.interactionVersion!==(q.type==='single-choice'?'selected-response-v1':q.type) || (Object.hasOwn(q,'scored') && q.scored!==true)) throw Error('VARIABLE_FORM_RESPONSE_INVALID');
  let maximum=1;
  if(q.type==='single-choice') {
    if(!text(p.prompt)||!Array.isArray(p.options)||!p.options.length||!unique(p.options.map(o=>o?.id))||p.options.some(o=>!text(o?.id)||!text(o?.text))||s.model!=='exact-single-v1'||!text(s.correctOptionId)||Object.hasOwn(s,'correctAnswer')||!p.options.some(o=>o.id===s.correctOptionId))throw Error('VARIABLE_FORM_SCORING_INVALID');
  }
  else if(q.type==='true-false-single-v1') { if(!text(p.statementId)||typeof s.correctValue!=='boolean')throw Error('VARIABLE_FORM_SCORING_INVALID'); }
  else {
    const field=q.type==='true-false-composite-v1'?'statements':q.type==='matching-v1'?'sources':'blanks';
    const key=q.type==='true-false-composite-v1'?'correctValuesByStatement':q.type==='matching-v1'?'correctTargetIdsBySource':'correctOptionIdsByBlank';
    const parts=p[field],expected=s[key];
    if(!Array.isArray(parts)||!parts.length||parts.length>100||!unique(parts.map(x=>x?.id))||parts.some(x=>!text(x?.id))||!object(expected)||Object.keys(expected).length!==parts.length||parts.some(x=>!Object.hasOwn(expected,x.id)))throw Error('VARIABLE_FORM_SCORING_INVALID');
    if(q.type==='matching-v1') {
      if(Object.hasOwn(p,'allowTargetReuse') && typeof p.allowTargetReuse!=='boolean')throw Error('VARIABLE_FORM_RESPONSE_INVALID');
      if(p.allowTargetReuse!==true && new Set(Object.values(expected)).size!==parts.length)throw Error('VARIABLE_FORM_SCORING_INVALID');
    }
    maximum=0;
    if(q.type==='code-dropdown-completion-v1') {
      const placeholders=typeof p.codeTemplate==='string'?[...p.codeTemplate.matchAll(/\[\[([^\]]+)\]\]/g)].map(m=>m[1]):[];
      if(!text(p.codeTemplate)||!object(s.pointsByBlank)||!unique(placeholders)||placeholders.length!==parts.length||parts.some(x=>!placeholders.includes(x.id)))throw Error('VARIABLE_FORM_RESPONSE_INVALID');
    }
    for(const part of parts) {
      if(q.type!=='code-dropdown-completion-v1'&&!text(part.text))throw Error('VARIABLE_FORM_RESPONSE_INVALID');
      const correct=expected[part.id];
      if(q.type==='true-false-composite-v1' && typeof correct!=='boolean')throw Error('VARIABLE_FORM_SCORING_INVALID');
      if(q.type!=='true-false-composite-v1') {
        const choices=q.type==='matching-v1'?p.targets:part.options;
        if(!text(correct)||!Array.isArray(choices)||!unique(choices.map(x=>x?.id))||choices.some(x=>!text(x?.id)||!text(x?.text))||!choices.some(x=>x.id===correct))throw Error('VARIABLE_FORM_SCORING_INVALID');
      }
      const points=q.type==='code-dropdown-completion-v1'?(s.pointsByBlank?.[part.id]??1):1;
      if(!Number.isSafeInteger(points)||points<=0||points>1000)throw Error('VARIABLE_FORM_SCORING_INVALID');
      maximum+=points;
    }
    if(s.pointsByBlank!==undefined && (q.type!=='code-dropdown-completion-v1'||!exact(s.pointsByBlank,parts.map(x=>x.id))))throw Error('VARIABLE_FORM_SCORING_INVALID');
  }
  if(s.maximumRawPoints!==maximum)throw Error('VARIABLE_FORM_RAW_MAXIMUM_INVALID');
  return maximum;
}
export function inspectVariablePythonForms(c,profileKey,summary,inventory,runtime) {
  const fail=code=>{throw Error(code);};
  const version=c?.contractVersion, delivery=version===MIXED_PYTHON_FORMS?MIXED_COUNT_DELIVERY:FORM_COUNT_DELIVERY;
  if(!exact(c,['contractVersion','cycleLength','reservePolicy','reserveQuestionIds','deliveryContract','countPolicy','forms'])|| !isVariablePythonForms(version)||c.deliveryContract!==delivery||runtime?.generatorVersion!==version||runtime?.scorerVersion!==VARIABLE_PYTHON_SCORER)fail('VARIABLE_FORM_CONTRACT_INVALID');
  if(c.reservePolicy!=='profile-specific-reserve')fail('CANONICAL_FORM_RESERVE_POLICY_INVALID');
  // Reserves remain eligible for ordinary practice, so their response/scoring
  // family must also be supported even though they are not formal members.
  for(const question of inventory.questions) variableQuestionMaximum(question,version);
  const policy=c.countPolicy;
  if(!exact(policy,['mode','allowedCounts','minimum','maximum'])||policy.mode!=='authorised-form-counts-v1'||!unique(policy.allowedCounts)||policy.allowedCounts.length<2||policy.allowedCounts.some(n=>!integer(n))||policy.allowedCounts.some((n,i,a)=>i>0&&n<=a[i-1])||policy.minimum!==policy.allowedCounts[0]||policy.maximum!==policy.allowedCounts.at(-1)||summary!==policy.maximum)fail('VARIABLE_FORM_COUNT_POLICY_INVALID');
  if(!Number.isInteger(c.cycleLength)||c.cycleLength<2||c.cycleLength>20||!Array.isArray(c.forms)||c.forms.length!==c.cycleLength)fail('CANONICAL_FORM_CONTRACT_INVALID');
  if(!unique(c.reserveQuestionIds)||c.reserveQuestionIds.some(id=>!text(id)||!inventory.questionById.has(id)))fail('CANONICAL_FORM_RESERVE_INVALID');
  const reserveSet=new Set(c.reserveQuestionIds),allMembers=new Set(),keys=new Set(),memberQuestions=[],counts=new Set(),perForm=[];
  for(const [index,f] of c.forms.entries()) {
    if(!exact(f,['formKey','ordinal','questionCount','questionIds','membershipHash','rawMaximum','blueprint'])||!text(f.formKey)||keys.has(f.formKey)||f.ordinal!==index+1||!integer(f.questionCount)||!policy.allowedCounts.includes(f.questionCount)||!unique(f.questionIds)||f.questionIds.length!==f.questionCount||f.membershipHash!==sha256Canonical(f.questionIds))fail('CANONICAL_FORM_DEFINITION_INVALID');
    keys.add(f.formKey);counts.add(f.questionCount);
    const questions=f.questionIds.map(id=>{
      const q=inventory.questionById.get(id);
      if(!text(id)||!q||reserveSet.has(id)||allMembers.has(id))fail('CANONICAL_FORM_MEMBERSHIP_INVALID');
      allMembers.add(id);return q;
    });
    const maximum=questions.reduce((total,q)=>total+variableQuestionMaximum(q,version),0);
    if(f.rawMaximum!==maximum)fail('CANONICAL_FORM_RAW_MAXIMUM_INVALID');
    const b=f.blueprint;
    if(!exact(b,['composition','domainCounts','requiredObjectiveKeys','minimumCoverageTagCounts','difficultyRequirements'])||!exact(b.composition,['standardQuestionCount','caseStudyCount','caseStudyQuestionCount','pbqCount','executableCount'])||b.composition.standardQuestionCount!==f.questionCount||Object.entries(b.composition).some(([k,v])=>k!=='standardQuestionCount'&&v!==0)||!object(b.domainCounts)||Object.values(b.domainCounts).some(v=>!nonnegative(v))||Object.values(b.domainCounts).reduce((a,v)=>a+v,0)!==f.questionCount||!unique(b.requiredObjectiveKeys)||!b.requiredObjectiveKeys.length||!object(b.minimumCoverageTagCounts)||!exact(b.difficultyRequirements,['minimumMedium','minimumHardOrAdvanced','minimumAdvanced']))fail('VARIABLE_FORM_BLUEPRINT_INVALID');
    if(Object.entries(b.domainCounts).some(([key,n])=>!text(key)||questions.filter(q=>q.domainKey===key).length!==n)||b.requiredObjectiveKeys.some(key=>!text(key)||!questions.some(q=>(q.sectionKey??q.presentation?.officialObjectiveKey)===key)))fail('VARIABLE_FORM_BLUEPRINT_INVALID');
    if(questions.some(q=>!['easy','medium','hard','advanced'].includes(q.presentation?.difficulty)||!unique(q.presentation?.coverageTags)||q.presentation.coverageTags.some(tag=>!text(tag))))fail('VARIABLE_FORM_BLUEPRINT_INVALID');
    for(const [tag,n] of Object.entries(b.minimumCoverageTagCounts))if(!text(tag)||!nonnegative(n)||questions.filter(q=>q.presentation.coverageTags.includes(tag)).length<n)fail('VARIABLE_FORM_BLUEPRINT_INVALID');
    const d=b.difficultyRequirements;
    if(Object.values(d).some(n=>!nonnegative(n)||n>f.questionCount)||questions.filter(q=>q.presentation.difficulty==='medium').length<d.minimumMedium||questions.filter(q=>['hard','advanced'].includes(q.presentation.difficulty)).length<d.minimumHardOrAdvanced||questions.filter(q=>q.presentation.difficulty==='advanced').length<d.minimumAdvanced)fail('VARIABLE_FORM_BLUEPRINT_INVALID');
    memberQuestions.push(questions);perForm.push({ordinal:f.ordinal,itemCount:f.questionCount,rawMaximum:maximum,composition:b.composition,blueprintHash:sha256Canonical(b),membershipHash:f.membershipHash});
  }
  if(sha256Canonical([...counts].sort((a,b)=>a-b))!==sha256Canonical(policy.allowedCounts))fail('VARIABLE_FORM_COUNT_POLICY_INVALID');
  if(new Set([...allMembers,...reserveSet]).size!==inventory.questionById.size)fail('CANONICAL_FORM_RESERVE_INSUFFICIENT');
  return {classification:'fixed',valid:true,countMode:'variable',memberQuestions,reserveSet,allMembers,reserveSignature:sha256Canonical([...reserveSet].sort()),manifest:{contractVersion:version,countMode:'variable',reservePolicy:c.reservePolicy,countPolicy:structuredClone(policy),formCount:c.forms.length,itemCount:summary,scoredItemCount:summary,membershipHashes:perForm.map(f=>f.membershipHash),reserveItemCount:reserveSet.size,perForm}};
}
