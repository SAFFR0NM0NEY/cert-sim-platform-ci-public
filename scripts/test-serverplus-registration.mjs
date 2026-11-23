import test from 'node:test';import assert from 'node:assert/strict';
import {examRegistry,liveVisibleExamConfigs,draftExamConfigs} from '../src/exams/examRegistry.protected.js';
import {getExamDisplayMetadata,getExamDisplayLabel} from '../src/exams/examDisplayMetadata.js';
import {getProtectedDashboardMetadata,getProtectedProfileMetadata,getDraftProtectedProfileMetadata} from '../src/exams/protectedProfileMetadata.js';
import {isStartableLifecycle} from '../src/exams/examLifecycle.js';
import {getProtectedExamKey,getProtectedProfileKey} from '../src/lib/protectedExamContract.js';
import {getDomainDisplayLabel,DOMAIN_LABEL_UNAVAILABLE} from '../src/lib/domainLabelPresentation.js';
import {getAssignedExamLaunchRoute} from '../src/lib/assignedExamLaunch.js';
import {getProfilePresentation} from '../src/lib/examProfilePresentation.js';
import {normalizeProtectedHistoryResult} from '../src/lib/protectedHistory.js';
import {filterAndSortExamLibrary,EXAM_LIBRARY_DEFAULTS} from '../src/components/exam/examLibraryHelpers.js';
const e=examRegistry.find(e=>e.id==='serverplussk0005');
test('canonical aliases are collision free and draft search does not change live catalogue',()=>{
 for(const alias of ['Server+','Server Plus','CompTIA Server+','SK0-005','server-plus'])assert.equal(getExamDisplayMetadata(alias).canonicalId,e.id);
 assert.notEqual(getExamDisplayMetadata('Security+').canonicalId,e.id);assert.equal(getExamDisplayLabel('unknown'), 'Exam');
 assert.equal(liveVisibleExamConfigs.length,9);assert(!liveVisibleExamConfigs.includes(e));assert(draftExamConfigs.includes(e));
 for(const query of ['Server+','CompTIA','SK0-005'])assert(filterAndSortExamLibrary([e],{...EXAM_LIBRARY_DEFAULTS,query}).includes(e));
});
test('unpublished provisional metadata never passes as published dashboard semver',()=>{
 assert.equal(getProtectedProfileMetadata(e.id),null);assert.equal(getProtectedDashboardMetadata(e.id),null);assert.equal(e.protectedPackageVersion,null);
 assert.equal(e.draftPackageVersion,'1.0.0');assert.equal(getDraftProtectedProfileMetadata(e.id).candidateVersion,e.draftPackageVersion);
 assert.equal(getProtectedDashboardMetadata(e.id,{[e.id]:{packageVersion:'1.0.0-serverplus-provisional',inventoryCount:180}}),null);
 assert.equal(e.questionCount,180);assert.equal(e.pbqCount,0);assert.equal(e.sourcePreviewOnly,true);assert.equal(isStartableLifecycle(e.lifecycle),false);
 assert.deepEqual(e.strictBetaProfiles.map(p=>[p.id,p.routeAction,p.totalScoredQuestions,p.timeLimitMinutes,p.canonicalFormCount,p.availabilityStatus]),[['serverplussk0005-full','full',60,90,2,'unavailable'],['serverplussk0005-compact','compact',25,40,2,'unavailable']]);
 assert.match(e.disclaimers.join(' '),/700\/1000.*not CompTIA.*750/);assert.match(e.disclaimers.join(' '),/Interactive PBQs are not currently included/);
});
test('safe allowlists, neutral unsupported domains and non-startable assignment routes',()=>{
 assert.equal(getProtectedExamKey(e.id),e.id);
 for(const p of e.strictBetaProfiles){assert.equal(getProtectedProfileKey(e.id,p.id),p.id);assert.equal(getProfilePresentation({examKey:e.id,profileKey:p.id}).name,p.name);assert.equal(getAssignedExamLaunchRoute({contractVersion:'live-v2',id:'00000000-0000-4000-8000-000000000001',examKey:e.id,profileId:p.id}), '');}
 assert.equal(getProtectedProfileKey(e.id,'sc100-full'),'');assert.equal(getProtectedProfileKey(e.id,'unknown'),'');
 for(const domain of ['server-hardware','server-administration','security-disaster-recovery','troubleshooting']){
  for(const packageVersion of ['1.0.0','1.0.0-serverplus-provisional'])assert.notEqual(getDomainDisplayLabel({domainId:domain},{examKey:e.id,packageVersion}),DOMAIN_LABEL_UNAVAILABLE);
  assert.equal(getDomainDisplayLabel({domainId:domain},{examKey:e.id,packageVersion:'1.1.0'}),DOMAIN_LABEL_UNAVAILABLE);
 }
 assert.equal(getDomainDisplayLabel({domainId:'unknown'},{examKey:e.id,packageVersion:e.draftPackageVersion}),DOMAIN_LABEL_UNAVAILABLE);
});
test('history keeps authoritative values and content-free stable profile labels',()=>{
 const r=normalizeProtectedHistoryResult({attemptId:'synthetic-serverplus',examKey:e.id,profileKey:'serverplussk0005-compact',packageVersion:e.draftPackageVersion,purpose:'self_directed_exam',completedAt:'2026-11-16T00:00:00Z',percentage:81.5,score:22,rawMaximum:27,source:'protected',serverAuthoritative:true});
 assert.match(r.examTitle,/Server\+/);assert.equal(r.rawPercentage,81.5);assert.deepEqual(e.questionBank,[]);
 for(const p of e.strictBetaProfiles)for(const field of ['questionIds','questions','privateScoring','correctAnswers'])assert.equal(Object.hasOwn(p,field),false);
});
