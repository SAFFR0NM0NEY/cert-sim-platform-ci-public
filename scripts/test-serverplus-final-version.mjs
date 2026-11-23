import test from 'node:test';import assert from 'node:assert/strict';
import {mapPracticeAvailability,mapCurrentAttemptBindings,mapRecoverableStudySandboxes} from '../supabase/functions/certsim-protected-exam/responses.ts';
import {examRegistry}from'../src/exams/examRegistry.protected.js';
import {getDomainDisplayLabel,DOMAIN_LABEL_UNAVAILABLE}from'../src/lib/domainLabelPresentation.js';
const examKey='serverplussk0005',id='10000000-0000-4000-8000-000000000001',at='2026-11-17T00:00:00Z';
const composition={standardQuestionCount:60,caseStudyCount:0,caseStudyQuestionCount:0,pbqCount:0,executableCount:0};
const binding={attemptId:id,examKey,packageVersion:'1.0.0',profileKey:'serverplussk0005-full',profileName:'Full Simulation',purpose:'self_directed_exam',startedAt:at,expiresAt:'2026-11-17T01:30:00Z',timed:true,selectedCount:60,fixedProfileSize:true,profileComposition:composition,replacementPermitted:false,languagePreference:null};
test('actual Edge DTOs retain final identity and separate version-pinned continuation',()=>{
 const available=mapPracticeAvailability({...binding,available:true,timeLimitMinutes:90,untrustedField:'discard'});assert.equal(available.packageVersion,'1.0.0');assert.equal(available.untrustedField,undefined);
 const historical={...binding,attemptId:'10000000-0000-4000-8000-000000000002',examKey:'inf303',packageVersion:'1.3.0',profileKey:'inf303-standard',selectedCount:34};
 const results=mapCurrentAttemptBindings({candidates:[binding,historical]}).candidates;assert.equal(results[0].packageVersion,'1.0.0');assert.equal(results[1].packageVersion,'1.3.0');assert.equal(results[1].selectedCount,34);
 assert.equal(examRegistry.find(e=>e.id===examKey).protectedPackageVersion,null);
});
test('actual recovery validator admits final semver and does not reinterpret provisional as hosted history',()=>{
 const candidate={attemptId:id,examKey,packageVersion:'1.0.0',profileKey:'serverplussk0005-full',profileName:'Full Simulation',purpose:'study_sandbox',recoverable:true,languagePreference:null,startedAt:at,lastActivityAt:at,itemCount:60,savedResponseCount:1};
 assert.equal(mapRecoverableStudySandboxes({candidates:[candidate]}).candidates[0].packageVersion,'1.0.0');
 for(const packageVersion of ['1.0.0-serverplus-provisional','1.0','v1.0.0'])assert.throws(()=>mapRecoverableStudySandboxes({candidates:[{...candidate,packageVersion}]}),e=>e.code==='internal_failure');
});
test('draft final and development-version domain semantics stay separate and unknown versions neutral',()=>{
 for(const packageVersion of ['1.0.0','1.0.0-serverplus-provisional'])assert.equal(getDomainDisplayLabel({domainId:'server-hardware'},{examKey,packageVersion}),'Server Hardware Installation and Management');
 assert.equal(getDomainDisplayLabel({domainId:'server-hardware'},{examKey,packageVersion:'1.1.0'}),DOMAIN_LABEL_UNAVAILABLE);
});
