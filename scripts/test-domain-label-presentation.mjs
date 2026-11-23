import assert from 'node:assert/strict';
import test from 'node:test';
import { getDomainDisplayLabel as label, getDisplayDomainItems, agreeDomainLabels, DOMAIN_LABEL_UNAVAILABLE as unknown } from '../src/lib/domainLabelPresentation.js';
import { getNormalizedDomainItems } from '../src/lib/resultStorageMappers.js';
import { getTrainerAnalyticsSnapshot } from '../src/lib/trainerAnalyticsService.js';
import { buildAuthoritativeAssignmentProgress } from '../src/lib/examAssignmentService.js';
import { applyAuthoritativeAnalytics } from '../src/hooks/useTrainerAnalytics.js';
import { buildStudentProgressSnapshot, applyHistorySummaries } from '../src/lib/studentProgressService.js';
import { getSavedResultDomainRows, getSavedResultWeakAreaRows } from '../src/lib/savedResultFormatters.js';
const azure = 'develop-azure-compute-solutions';
test('immutable authored snapshot labels take precedence over catalogue metadata', () => {
  assert.equal(label({ domainId: azure, domainLabel: 'Historical compute label' }, { examKey:'az204',packageVersion:'1.0.0' }), 'Historical compute label');
});
test('exact package identity maps verified named domains, never ordinal Python domains', () => {
  assert.equal(label({ domainId:azure }, { examKey:'az204',packageVersion:'1.0.0' }), 'Develop Azure compute solutions');
  assert.equal(label({ domainId:'ai-agents' }, { examKey:'ai901',packageVersion:'3.0.0' }), 'AI Agents');
  assert.equal(label({ domainId:'information-extraction' }, { examKey:'ai901',packageVersion:'3.0.0' }), 'AI-powered information extraction');
  for (const examKey of ['inf303','pythonnextgeneration']) for (const packageVersion of ['1.0.0','1.1.0','1.3.0']) {
    assert.equal(label({ domainId:'domain-1', domainLabel:'Domain 1' }, { examKey,packageVersion }), unknown);
  }
});
test('unsupported versions, unknown keys, positional IDs and opaque composite labels stay neutral', () => {
  for(const row of [{domainId:'domain-1'},{domainId:'legacyCode'},{domainId:'ai-agents',domainLabel:'ai901: ai-agents'}]) assert.equal(label(row, {examKey:'ai901',packageVersion:'1.0.0'}),unknown);
  assert.equal(label({domainId:azure},{examKey:'az204',packageVersion:'0.9.0'}),unknown);
  assert.equal(label({domainId:azure},{examKey:'unknown',packageVersion:'1.0.0'}),unknown);
});
test('missing versions permit only unambiguous canonical spelling, never renamed aliases', () => {
  assert.equal(label({domainId:azure},{examKey:'az204'}),'Develop Azure compute solutions');
  assert.equal(label({domainId:'information-extraction'},{examKey:'ai901'}),unknown);
  const metadata={az204:{'1':{[azure]:'Develop Azure compute solutions'},'2':{[azure]:'Changed domain meaning'}}};
  assert.equal(label({domainId:azure},{examKey:'az204'},metadata),unknown);
  assert.equal(agreeDomainLabels('Original','Renamed'),unknown);
});
test('display projection preserves source IDs, scores and input objects across supported shapes', () => {
  for(const input of [[{domainId:azure,domainLabel:azure,percentage:63,correct:5,total:8}],{items:[{domainId:azure,domainLabel:azure,percentage:63,correct:5,total:8}]}]) {
    const before=JSON.stringify(input);
    const old=getNormalizedDomainItems(input), next=getDisplayDomainItems(input,{examKey:'az204',packageVersion:'1.0.0'});
    assert.deepEqual(next.map(({domainLabel,...row})=>row),old.map(({domainLabel,...row})=>row));
    assert.equal(next[0].domainLabel,'Develop Azure compute solutions');
    assert.equal(JSON.stringify(input),before);
  }
});
const result={attemptId:'synthetic-history',examKey:'az204',packageVersion:'1.0.0',purpose:'self_directed_exam',profileKey:'az204-full-profile',rawPercentage:63,scaledScore:680,passed:false,submittedAt:'2026-01-02T12:00:00Z',domainBreakdown:{items:[{domainId:azure,domainLabel:azure,percentage:63,earnedPoints:5,maxPoints:8}]}};
test('learner progress metrics and domain identities equal the same friendly-snapshot baseline', () => {
  const raw=structuredClone(result), friendly=structuredClone(result);friendly.domainBreakdown.items[0].domainLabel='Develop Azure compute solutions';
  const before=JSON.stringify(raw);
  const a=buildStudentProgressSnapshot({rawResults:[raw]}),b=buildStudentProgressSnapshot({rawResults:[friendly]});
  const metrics = rows => rows.map(({ latestResult, attemptsByExam, ...row }) => row);
  assert.deepEqual(metrics(a.examProgress),metrics(b.examProgress));assert.deepEqual(a.progress,b.progress);
  assert.equal(a.examProgress[0].domainAverages[0].domainId,azure);
  assert.equal(JSON.stringify(raw),before);
});
test('staff saved result and weak-area display retain numeric evidence and original snapshots', () => {
  const before=JSON.stringify(result);
  assert.deepEqual(getSavedResultDomainRows(result),[{domain:'Develop Azure compute solutions',percentage:'63%',score:'5/8'}]);
  assert.deepEqual(getSavedResultWeakAreaRows({...result,weakAreas:[{domainId:azure,domainLabel:azure,percentage:63}]}),[{label:'Develop Azure compute solutions',detail:'63%'}]);
  assert.equal(getSavedResultDomainRows({...result,packageVersion:'unknown'})[0].domain,unknown);
  assert.equal(JSON.stringify(result),before);
});

test('staff result normalization retains exact package versions for renamed aliases', () => {
  const input={...result,userId:'fixture',examKey:'ai901',packageVersion:'3.0.0',domainBreakdown:{items:[{domainId:'information-extraction',domainLabel:'information-extraction',percentage:63}]}};
  const output=getTrainerAnalyticsSnapshot({results:[input],students:[{userId:'fixture'}]});
  assert.equal(output.studentReadiness[0].domainAverages[0].domainLabel,'AI-powered information extraction');
  assert.equal(output.weakAreaAnalytics.domainPerformance[0].domain,'AI-powered information extraction');
  assert.equal(output.studentReadiness[0].domainAverages[0].averagePercentage,63);
  assert.equal(output.studentReadiness[0].domainAverages[0].domainId,'information-extraction');
});
test('full-history, authoritative staff and assignment aggregates do not borrow latest/current version', () => {
  const domain={domainKey:'domain-1',domainId:'domain-1',domainLabel:'domain-1',percentage:63,averagePercentage:63,sampleCount:4};
  const summary={completedCount:4,passedCount:2,needsReviewCount:2,averagePercentage:63,domainSummary:{items:[domain],evidenceResultCount:4}};
  const rows=applyHistorySummaries([{examScopeKey:'inf303',packageVersion:'1.3.0'}],{inf303:summary});
  assert.equal(rows[0].domainAverages[0].domainLabel,unknown);assert.equal(rows[0].scopedAttemptCount,4);assert.equal(rows[0].passRate,50);assert.equal(rows[0].domainSampleCount,4);
  const learners=[{learnerId:'fixture',examKey:'inf303',domains:[domain],averagePercentage:63}];
  const assignment={id:'fixture-assignment',examKey:'inf303',packageVersion:'1.3.0'};
  const output=buildAuthoritativeAssignmentProgress(assignment,[{userId:'fixture'}],{learners});
  assert.equal(output.studentRows[0].domainAverages[0].domainLabel,unknown);
  assert.equal(output.studentRows[0].domainAverages[0].domainId,'domain-1');
  const staff=applyAuthoritativeAnalytics({readinessSummary:[],totals:{}}, {learners,domains:[],assignments:[]}, [], [], [],{items:[{learnerId:'fixture',examKey:'inf303',analytics:learners[0]}]});
  assert.equal(staff.studentReadiness[0].domainAverages[0].domainLabel,unknown);
  assert.equal(staff.studentReadiness[0].domainAverages[0].sampleCount,4);
});

test('unknown prototype-like historical IDs and versions remain neutral strings', () => {
  for(const domainId of ['__proto__','constructor','toString']) for(const packageVersion of ['1.0.0','__proto__','constructor']) {
    assert.equal(label({domainId},{examKey:'az204',packageVersion}),unknown);
  }
});
