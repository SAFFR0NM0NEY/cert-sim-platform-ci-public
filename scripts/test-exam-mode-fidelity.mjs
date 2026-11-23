import assert from 'node:assert/strict';
import test from 'node:test';
import { protectedProfileMetadata } from '../src/exams/protectedProfileMetadata.js';
import { getProfilePresentation, projectProfilePresentation, getAttemptDurationMinutes, formatProfileQuestionCount } from '../src/lib/examProfilePresentation.js';
import { isAssessmentResult, getAttemptKindLabel } from '../src/lib/attemptPurpose.js';
const published = protectedProfileMetadata.inf303;
test('all21 registered profile labels preserve distinct compositions',()=>{
  const expected={
    inf301:['Full Simulation','Compact Simulation'],
    sc100:['Full Simulation','Compact Simulation'],inf303:['Full Simulation','Compact Simulation'],sc200:['Full Simulation','Compact Simulation'],
    az204:['Standard','Compact Simulation','Full Simulation','Case-heavy'],
    'security-plus-sy0-701':['Compact Simulation','Full Simulation'],
    az400:['Compact Simulation','Full Simulation','Sectioned Full Simulation'],
    ai901:['Compact Simulation','Full Simulation'],pythonnextgeneration:['No-Lab','Lab'],
  };
  for(const [examKey,metadata] of Object.entries(protectedProfileMetadata)){
    assert.deepEqual(metadata.profiles.map(p=>getProfilePresentation({examKey,profileKey:p.id,name:p.name}).name),expected[examKey]);
  }
});
test('published catalogue remains1.1.0 Full40/120 and Compact20/60', () => {
  assert.equal(published.packageVersion, '1.1.0');
  assert.deepEqual(published.profiles.map(p => [p.totalScoredQuestions,p.timeLimitMinutes]), [[40,120],[20,60]]);
});
test('server availability supplies future variable label and45-minute setup', () => {
  const p = projectProfilePresentation(published.profiles[0], { examKey:'inf303',profileKey:'inf303-standard',packageVersion:'1.3.0',timeLimitMinutes:45 });
  assert.equal(p.timeLimitMinutes,45); assert.match(p.name,/Full Simulation/);
  assert.match(p.purposeNote,/complete timed examination simulation/);
  assert.equal(formatProfileQuestionCount({ ...p, countPolicy:{allowedCounts:[34,36]} }), '34 or 36');
  assert.equal(getProfilePresentation({examKey:'inf303',profileKey:p.id,packageVersion:'1.1.0',name:'Full Simulation'}).name,'Full Simulation');
});
for (const count of [34,36]) test('selected'+count+' uses pinned deadline, never catalogue or successor timer', () => {
  const a={examKey:'inf303',profileKey:'inf303-standard',packageVersion:'1.3.0',startedAt:'2026-10-29T10:00:00Z',expiresAt:'2026-10-29T10:45:00Z'};
  assert.equal(getAttemptDurationMinutes(a),45);
  const p=projectProfilePresentation({...published.profiles[0],totalScoredQuestions:count},{timeLimitMinutes:120},a);
  assert.equal(formatProfileQuestionCount(p),count); assert.equal(p.timeLimitMinutes,45);
});
test('Compact purpose label does not reclassify formal or practice history/readiness', () => {
  const record={examKey:'inf303',profileKey:'inf303-compact',purpose:'self_directed_exam'};
  assert.equal(getProfilePresentation(record).name,'Compact Simulation');
  assert.equal(isAssessmentResult(record),true); assert.equal(getAttemptKindLabel(record),'Exam attempt');
  for(const purpose of ['study_sandbox','targeted_domain','weak_area','pbq_practice']) {
    assert.equal(isAssessmentResult({...record,purpose}),false);
    assert.deepEqual(getProfilePresentation({...record,purpose}),{name:'',note:''});
  }
});
test('shared simulation names retain all published counts and timers', () => {
  for(const [examKey, metadata] of Object.entries(protectedProfileMetadata)) for(const p of metadata.profiles){
    const projected=projectProfilePresentation(p,{examKey,profileKey:p.id,packageVersion:metadata.packageVersion});
    assert.equal(projected.totalScoredQuestions,p.totalScoredQuestions);assert.equal(projected.timeLimitMinutes,p.timeLimitMinutes);
    if(!/compact|full/i.test(p.id) && examKey!=='inf303') assert.equal(projected.name,p.name);
  }
  assert.equal(getAttemptDurationMinutes({timed:false}),null);
});
test('all Compact profiles use platform naming and candidate timing cannot rewrite old deadlines',()=>{
  for(const [examKey,metadata] of Object.entries(protectedProfileMetadata)) for(const p of metadata.profiles.filter(p=>/compact/i.test(p.id)))
    assert.equal(getProfilePresentation({examKey,profileKey:p.id,name:p.name}).name,'Compact Simulation');
  const current=projectProfilePresentation(published.profiles[1],{examKey:'inf303',profileKey:'inf303-compact',timeLimitMinutes:25});
  assert.equal(current.timeLimitMinutes,25);
  const old={examKey:'inf303',profileKey:'inf303-compact',packageVersion:'1.1.0',startedAt:'2026-10-29T10:00:00Z',expiresAt:'2026-10-29T11:00:00Z'};
  assert.equal(projectProfilePresentation(published.profiles[1],{timeLimitMinutes:25},old).timeLimitMinutes,60);
  assert.equal(projectProfilePresentation(published.profiles[1],{purpose:'study_sandbox',examKey:'inf303',profileKey:'inf303-compact'}).purposeNote,'');
});
