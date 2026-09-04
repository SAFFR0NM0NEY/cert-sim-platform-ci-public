import { createClient } from '@supabase/supabase-js';
import { spawnSync } from 'node:child_process';

import { sha256Canonical } from './backend-exam-publication/canonical-json.mjs';

const url=required('SUPABASE_URL'),anon=required('SUPABASE_ANON_KEY'),service=required('SUPABASE_SERVICE_ROLE_KEY'),database=required('SUPABASE_DB_URL');
const admin=client(service),owner=await createUser('owner'),learner=await createUser('learner'),assignedLearner=await createUser('assigned'),purchaseLearner=await createUser('purchase'),legacyWeakLearner=await createUser('legacy-weak'),activationLearner=await createUser('activation'),other=await createUser('other');
const org=crypto.randomUUID();
sql(`insert into public.organisations(id,name,organisation_type,status) values ('${org}','Generic lifecycle fixture','internal','active'); insert into public.memberships(user_id,organisation_id,role,status) values ('${owner.id}','${org}','platform_owner','active'),('${learner.id}','${org}','student','active'),('${assignedLearner.id}','${org}','student','active'),('${purchaseLearner.id}','${org}','student','active'),('${legacyWeakLearner.id}','${org}','student','active'),('${activationLearner.id}','${org}','student','active'); insert into public.exam_catalog(exam_key,slug,title,lifecycle,exam_type) values ('sample400','sample400','Synthetic Sample','test','certification');`);

const payload={
  packageSchemaVersion:'certsim-protected-package-v2',validationContractVersion:'certsim-protected-multi-exam-validation-v1',
  exam:{examKey:'sample-400',packageVersion:'1.0.0',capabilities:['single-choice','dropdown-code','case-study-context','pbq-config-panel'],domains:[{key:'d1',name:'Synthetic'}],groupedSelection:true},
  source:{sourceHash:'a'.repeat(64),validationHash:'b'.repeat(64)},
  runtime:{generatorVersion:'certsim-az400-case-workspace-generator-v1',scorerVersion:'certsim-az400-authoritative-scorer-v1',pbqRuntimeVersion:'certsim-protected-pbq-runtime-v1'},
  profiles:[
    {profileKey:'sectioned',displayName:'Synthetic sectioned',questionCount:10,timeLimitMinutes:30,selection:{caseStudyCount:1,caseStudyQuestionCount:1,standardQuestionCount:8,pbqCount:1,sectionOrder:['case','standard','pbq'],preserveRequiredGroups:true}},
    {profileKey:'preview-profile',displayName:'Synthetic preview',questionCount:10,timeLimitMinutes:30,selection:{caseStudyCount:1,caseStudyQuestionCount:1,standardQuestionCount:8,pbqCount:1,sectionOrder:['case','standard','pbq'],preserveRequiredGroups:true}},
  ],
  releasePolicy:{review:'after_submission',answers:'after_submission'},supportedReleasePolicies:['never','after_submission','immediate_study_feedback'],
  questions:[
    {id:'case-context',type:'case-study-context',domainKey:'d1',sectionKey:'case',scored:false,group:{groupKey:'case-a',role:'context',order:0},presentation:{heading:'Synthetic context'},privateReview:{}},
    {id:'case-child',type:'single-choice',domainKey:'d1',sectionKey:'case',scored:true,group:{groupKey:'case-a',role:'question',order:1},presentation:{prompt:'Synthetic case item',options:[{id:'a',text:'A'},{id:'b',text:'B'}]},privateScoring:{correctAnswer:'a'},privateReview:{explanation:'Synthetic',remediation:'Synthetic'}},
    {id:'standard',type:'single-choice',domainKey:'d1',sectionKey:'standard',scored:true,presentation:{prompt:'Synthetic item',options:[{id:'a',text:'A'},{id:'b',text:'B'}]},privateScoring:{correctAnswer:'a'},privateReview:{explanation:'Synthetic',remediation:'Synthetic'}},
    {id:'dropdown',type:'dropdown-code',domainKey:'d1',sectionKey:'standard',scored:true,presentation:{prompt:'Synthetic dropdown',blanks:[{id:'first',options:['alpha','beta']},{id:'second',options:['alpha','beta']}]},privateScoring:{blanks:[{correctAnswer:'alpha'},{correctAnswer:'beta'}]},privateReview:{explanation:'Synthetic',remediation:'Synthetic'}},
    ...Array.from({length:36},(_,index)=>({id:`standard-${index+1}`,type:'single-choice',domainKey:'d1',sectionKey:'standard',scored:true,presentation:{prompt:`Synthetic item ${index+1}`,options:[{id:'a',text:'A'},{id:'b',text:'B'}]},privateScoring:{correctAnswer:'a'},privateReview:{explanation:'Synthetic',remediation:'Synthetic'}})),
    {id:'workspace',type:'pbq-config-panel',domainKey:'d1',sectionKey:'pbq',scored:true,group:{groupKey:'pbq-a',role:'atomic-pbq',order:0},presentation:{responseAllowlist:{targetIds:['x'],answerIdsByTarget:{x:['a']}}},privateScoring:{strategy:'per-component-map',expectedMap:{x:'a'},requiredCommandIds:[]},privateReview:{explanation:'Synthetic',remediation:'Synthetic'}},
  ],
};
const request={publicationRequestId:crypto.randomUUID(),sourceCommitSha:'c'.repeat(40),packagePayload:payload,packageHash:sha256Canonical(payload)};
const ownerClient=await signedIn(owner);
const published=await ownerClient.rpc('certsim_protected_publish_package',{p_request:request});
if(published.error||published.data?.classification!=='new_candidate'||published.data?.questionCount!==41) fail('GENERIC_PUBLICATION_FAILED');
const neverPayload=structuredClone(payload);
neverPayload.exam.examKey='sample-never';
neverPayload.releasePolicy={review:'never',answers:'never'};
const neverRequest={publicationRequestId:crypto.randomUUID(),sourceCommitSha:'c'.repeat(40),packagePayload:neverPayload,packageHash:sha256Canonical(neverPayload)};
const neverPublished=await ownerClient.rpc('certsim_protected_publish_package',{p_request:neverRequest});
if(neverPublished.error||neverPublished.data?.classification!=='new_candidate') fail('NEVER_PUBLICATION_FAILED');
for(const [label,releasePolicy] of [
  ['MIXED',{review:'after_submission',answers:'never'}],
  ['UNKNOWN',{review:'after_submission',answers:'immediate'}],
  ['MALFORMED',{review:'after_submission'}],
]){
  const invalidPayload=structuredClone(payload);
  invalidPayload.exam.examKey=`invalid-${label.toLowerCase()}`;
  invalidPayload.releasePolicy=releasePolicy;
  const invalidRequest={publicationRequestId:crypto.randomUUID(),sourceCommitSha:'c'.repeat(40),packagePayload:invalidPayload,packageHash:sha256Canonical(invalidPayload)};
  if(!(await ownerClient.rpc('certsim_protected_publish_package',{p_request:invalidRequest})).error) fail(`${label}_RELEASE_POLICY_ALLOWED`);
}
const replay=await ownerClient.rpc('certsim_protected_publish_package',{p_request:request});
if(replay.error||replay.data?.classification!=='idempotent_replay') fail('PUBLICATION_REPLAY_FAILED');
const conflict=structuredClone(request); conflict.packageHash='d'.repeat(64);
if(!(await ownerClient.rpc('certsim_protected_publish_package',{p_request:conflict})).error) fail('PUBLICATION_CONFLICT_NOT_REJECTED');
if(!(await signedIn(other)).rpc) fail('CLIENT_INVALID');
const unauthorized=await (await signedIn(other)).rpc('certsim_protected_publish_package',{p_request:{...request,publicationRequestId:crypto.randomUUID()}});
if(!unauthorized.error) fail('NON_OWNER_PUBLICATION_ALLOWED');
sql(`select 1/((count(*)=2)::integer) from exam_delivery.package_versions where exam_key in ('sample400','samplenever'); select 1/((count(*)=0)::integer) from exam_delivery.package_versions where exam_key like 'invalid%'; select 1/((count(*)=0)::integer) from exam_delivery.exam_access_policies where canonical_exam_key in ('sample400','samplenever'); select 1/((count(*)=0)::integer) from exam_delivery.exam_access_learners where canonical_exam_key in ('sample400','samplenever'); select 1/((count(*)=0)::integer) from exam_delivery.protected_assignments where package_version_id in (select id from exam_delivery.package_versions where exam_key in ('sample400','samplenever')); select 1/((count(*)=0)::integer) from exam_delivery.attempts where package_version_id in (select id from exam_delivery.package_versions where exam_key in ('sample400','samplenever')); select 1/((count(*)=0)::integer) from exam_delivery.attempt_results where attempt_id in (select id from exam_delivery.attempts where package_version_id in (select id from exam_delivery.package_versions where exam_key in ('sample400','samplenever'))); select 1/((count(*)=0)::integer) from exam_delivery.review_snapshots where attempt_id in (select id from exam_delivery.attempts where package_version_id in (select id from exam_delivery.package_versions where exam_key in ('sample400','samplenever')));`);

let eligibility=await admin.rpc('certsim_protected_check_eligibility',{p_actor_id:learner.id,p_exam_key:'sample-400',p_profile_key:'sectioned'});
expectReason(eligibility,'exam_disabled');
sql(`insert into exam_delivery.exam_access_policies(canonical_exam_key,access_mode,enabled,enabled_at) values ('sample400','controlled_beta',true,now())`);
eligibility=await admin.rpc('certsim_protected_check_eligibility',{p_actor_id:learner.id,p_exam_key:'sample-400',p_profile_key:'sectioned'});
expectReason(eligibility,'access_not_granted');
sql(`insert into exam_delivery.exam_access_learners(canonical_exam_key,learner_id,enabled,access_starts_at) values ('sample400','${learner.id}',true,now()-interval '1 minute')`);
eligibility=await admin.rpc('certsim_protected_check_eligibility',{p_actor_id:learner.id,p_exam_key:'sample-400',p_profile_key:'sectioned'});
if(eligibility.error||eligibility.data?.eligible!==true) fail('CONTROLLED_ELIGIBILITY_FAILED');

sql(`update exam_delivery.exam_access_policies set require_assignment=true where canonical_exam_key='sample400'; insert into exam_delivery.practice_policies(canonical_exam_key,package_version,profile_key,purpose,access_mode,enabled,maximum_completed_attempts,maximum_session_items) values ('sample400','1.0.0','sectioned','self_directed_exam','controlled_beta',true,null,10);
insert into exam_delivery.exam_profile_activations(package_version_id,package_profile_id,enabled,activation_kind,enabled_at,created_by)
select pv.id,pp.id,true,'production',now(),'${owner.id}' from exam_delivery.package_versions pv join exam_delivery.package_profiles pp on pp.package_version_id=pv.id where pv.exam_key='sample400' and pv.package_version='1.0.0' and pp.profile_key='sectioned';
insert into exam_delivery.exam_entitlements(package_version_id,package_profile_id,target_type,learner_id,enabled,valid_from,reason_code,created_by)
select pv.id,pp.id,'learner','${learner.id}',true,now()-interval '1 minute','integration_fixture','${owner.id}' from exam_delivery.package_versions pv join exam_delivery.package_profiles pp on pp.package_version_id=pv.id where pv.exam_key='sample400' and pv.package_version='1.0.0' and pp.profile_key='sectioned';`);

const activationAssignmentId=crypto.randomUUID();
sql(`insert into public.exam_assignments(id,organisation_id,student_user_id,exam_key,profile_id,title,status,available_from,due_at,assigned_by)
  values ('${activationAssignmentId}','${org}','${activationLearner.id}','sample400',null,'Activation transition fixture','active',now()-interval '1 minute',now()+interval '1 day','${owner.id}');
insert into exam_delivery.exam_profile_activations(package_version_id,package_profile_id,enabled,activation_kind,enabled_at,created_by)
select pv.id,pp.id,true,'preview',now(),'${owner.id}' from exam_delivery.package_versions pv join exam_delivery.package_profiles pp on pp.package_version_id=pv.id
where pv.exam_key='sample400' and pv.package_version='1.0.0' and pp.profile_key='preview-profile';
update exam_delivery.exam_profile_activations activation set activation_kind='production'
from exam_delivery.package_profiles pp where pp.id=activation.package_profile_id and pp.profile_key='preview-profile';
select 1/((count(*)=1 and bool_and(enabled) and bool_and(source_assignment_id='${activationAssignmentId}'::uuid))::integer)
from exam_delivery.exam_entitlements entitlement join exam_delivery.package_profiles profile on profile.id=entitlement.package_profile_id
where entitlement.learner_id='${activationLearner.id}'::uuid and profile.profile_key='preview-profile';`);

sql(`insert into exam_delivery.practice_policies(canonical_exam_key,package_version,profile_key,purpose,access_mode,enabled,maximum_completed_attempts,maximum_session_items)
values ('sample400','1.0.0','sectioned','weak_area','production_authorized',true,null,40);
insert into exam_delivery.exam_entitlements(package_version_id,package_profile_id,target_type,learner_id,enabled,valid_from,reason_code,created_by)
select pv.id,pp.id,'learner','${legacyWeakLearner.id}',true,now()-interval '1 minute','legacy_weak_fixture','${owner.id}'
from exam_delivery.package_versions pv join exam_delivery.package_profiles pp on pp.package_version_id=pv.id
where pv.exam_key='sample400' and pv.package_version='1.0.0' and pp.profile_key='sectioned';
with inserted_attempt as (
  insert into public.exam_attempts(user_id,exam_key,exam_version,profile_id,mode_label,status,submitted_at,attempt_snapshot)
  values ('${legacyWeakLearner.id}','sample-400','legacy','retired-profile','Full Exam','submitted',now()-interval '1 day','{"metadata":{"purpose":"self_directed_exam"}}') returning id
)
insert into public.exam_results(attempt_id,user_id,exam_key,profile_id,scoring_engine_version,raw_score,raw_percentage,passed,domain_breakdown)
select id,'${legacyWeakLearner.id}','sample-400','retired-profile','legacy',55,55,false,'{"d1":{"label":"Synthetic","earnedPoints":55,"maxPoints":100,"percentage":55}}' from inserted_attempt;
select 1/((count(*)=1 and bool_and(domain_key='d1') and min(lowest_percentage)=55)::integer)
from exam_delivery.learner_weak_domain_evidence('${legacyWeakLearner.id}',(select id from exam_delivery.package_versions where exam_key='sample400' and package_version='1.0.0'));
select 1/((count(*)=0)::integer) from exam_delivery.learner_weak_domain_evidence('${legacyWeakLearner.id}',(select id from exam_delivery.package_versions where exam_key='samplenever' and package_version='1.0.0'));`);
const legacyWeakRequest={examKey:'sample-400',profileId:'sectioned',purpose:'weak_area',domain:'d1',count:10,language:'not_applicable',includePbqs:true,mixStrategy:'balanced',clientRequestId:crypto.randomUUID()};
const legacyWeakAvailability=await admin.rpc('certsim_protected_practice_availability',{p_actor_id:legacyWeakLearner.id,p_request:legacyWeakRequest});
if(legacyWeakAvailability.error||legacyWeakAvailability.data?.ok!==true||legacyWeakAvailability.data?.selectedCount!==10) fail('LEGACY_WEAK_AVAILABILITY_FAILED');
const legacyWeakStarted=await admin.rpc('certsim_protected_start_practice',{p_actor_id:legacyWeakLearner.id,p_request:legacyWeakRequest});
if(legacyWeakStarted.error||legacyWeakStarted.data?.ok!==true||legacyWeakStarted.data?.items?.length<10) fail('LEGACY_WEAK_START_FAILED');
if(legacyWeakStarted.data.items.some((item)=>item.domain!=='d1'||String(item.questionId).startsWith('legacy'))) fail('LEGACY_WEAK_CONTENT_BOUNDARY_FAILED');
const samplePackageId=sqlValue("select id from exam_delivery.package_versions where exam_key='sample400' and package_version='1.0.0'");
const sampleProfileId=sqlValue(`select id from exam_delivery.package_profiles where package_version_id='${samplePackageId}'::uuid and profile_key='sectioned'`);
const purchaseArgs={p_learner_id:purchaseLearner.id,p_package_version_id:samplePackageId,p_package_profile_ids:[sampleProfileId],p_entitlement_source:'direct_exam_purchase',p_purchase_reference:`fixture:${crypto.randomUUID()}`};
const deniedPurchase=await (await signedIn(purchaseLearner)).rpc('certsim_grant_purchase_entitlement',purchaseArgs);
if(!deniedPurchase.error) fail('STUDENT_PURCHASE_FULFILMENT_ALLOWED');
const grantedPurchase=await ownerClient.rpc('certsim_grant_purchase_entitlement',purchaseArgs);
if(grantedPurchase.error||grantedPurchase.data?.ok!==true||grantedPurchase.data?.entitlementsCreated!==1) fail('OWNER_PURCHASE_FULFILMENT_FAILED');
sql(`select 1/((count(*)=1 and bool_and(valid_until between now()+interval '364 days' and now()+interval '366 days'))::integer)
  from exam_delivery.exam_entitlements where learner_id='${purchaseLearner.id}'::uuid and purchase_reference='${purchaseArgs.p_purchase_reference}'`);
const assignmentId=crypto.randomUUID();
sql(`insert into public.exam_assignments(id,organisation_id,student_user_id,exam_key,profile_id,title,status,available_from,due_at,assigned_by)
  values ('${assignmentId}','${org}','${assignedLearner.id}','sample400','sectioned','Protected assignment','active',now()-interval '1 minute',now()+interval '1 day','${owner.id}')`);
const assignedRequest={examKey:'sample-400',profileId:'sectioned',purpose:'self_directed_exam',language:'not_applicable',includePbqs:true,mixStrategy:'balanced',assignmentId,clientRequestId:crypto.randomUUID()};
const assignedStarted=await admin.rpc('certsim_protected_start_practice',{p_actor_id:assignedLearner.id,p_request:assignedRequest});
if(assignedStarted.error||assignedStarted.data?.ok!==true) fail(`ASSIGNMENT_PRACTICE_START_FAILED_${safeCode(assignedStarted.data?.code)}`);
sql(`select 1/((count(*)=1 and bool_and(source_assignment_id='${assignmentId}'::uuid) and bool_and(attribution_source='assignment'))::integer)
  from exam_delivery.attempts where owner_id='${assignedLearner.id}'::uuid and status='in_progress'`);
const assignedReplacementRequest={...assignedRequest,clientRequestId:crypto.randomUUID()};
const assignedReplacement=await admin.rpc('certsim_protected_replace_current_practice_attempt',{p_actor_id:assignedLearner.id,p_request:assignedReplacementRequest});
if(assignedReplacement.error||assignedReplacement.data?.ok!==true||assignedReplacement.data?.attempt?.attemptId===assignedStarted.data.attempt.attemptId) fail('ASSIGNMENT_REPLACEMENT_FAILED');
sql(`select 1/((status='voided' and source_assignment_id='${assignmentId}'::uuid and attribution_source='assignment')::integer)
  from exam_delivery.attempts where id='${assignedStarted.data.attempt.attemptId}'::uuid;
select 1/((status='in_progress' and source_assignment_id='${assignmentId}'::uuid and attribution_source='assignment')::integer)
  from exam_delivery.attempts where id='${assignedReplacement.data.attempt.attemptId}'::uuid`);
for(const item of assignedReplacement.data.items.filter((entry)=>entry.questionType!=='case-study-context')){
  const saved=await admin.rpc('certsim_protected_save_response',{p_actor_id:assignedLearner.id,p_attempt_id:assignedReplacement.data.attempt.attemptId,p_item_id:item.itemId,p_response:responseFor(item),p_expected_revision:0,p_request_id:crypto.randomUUID()});
  if(saved.error||saved.data?.revision!==1) fail('ASSIGNMENT_RESPONSE_SAVE_FAILED');
}
const assignedSubmitted=await admin.rpc('certsim_protected_submit_attempt',{p_actor_id:assignedLearner.id,p_attempt_id:assignedReplacement.data.attempt.attemptId,p_submission_id:crypto.randomUUID()});
if(assignedSubmitted.error||assignedSubmitted.data?.ok!==true) fail('ASSIGNMENT_SUBMIT_FAILED');
const assignmentHistory=await admin.rpc('certsim_protected_list_history',{p_actor_id:assignedLearner.id,p_exam_key:'sample-400',p_cursor:null,p_page_size:50});
if(assignmentHistory.error||assignmentHistory.data?.items?.[0]?.assignmentId!==assignmentId) fail('ASSIGNMENT_HISTORY_CORRELATION_FAILED');
const deniedAssessment=await admin.rpc('certsim_protected_start_attempt',{p_actor_id:learner.id,p_exam_key:'sample-400',p_profile_key:'sectioned',p_request_id:crypto.randomUUID()});
expectReason(deniedAssessment,'assignment_required');
sql(`update exam_delivery.exam_access_learners set enabled=false where canonical_exam_key='sample400' and learner_id='${learner.id}';`);
const wrongLanguage=await admin.rpc('certsim_protected_start_practice',{p_actor_id:learner.id,p_request:{examKey:'sample-400',profileId:'sectioned',purpose:'self_directed_exam',count:10,language:'python',includePbqs:true,mixStrategy:'balanced',clientRequestId:crypto.randomUUID()}});
expectReason(wrongLanguage,'invalid_request');
const deniedOther=await admin.rpc('certsim_protected_start_practice',{p_actor_id:other.id,p_request:{examKey:'sample-400',profileId:'sectioned',purpose:'self_directed_exam',count:10,language:'not_applicable',includePbqs:true,mixStrategy:'balanced',clientRequestId:crypto.randomUUID()}});
expectReason(deniedOther,'access_not_granted');
sql(`select 1/((count(*)=0)::integer) from exam_delivery.attempts a join exam_delivery.package_versions pv on pv.id=a.package_version_id join exam_delivery.package_profiles pp on pp.id=a.package_profile_id where a.owner_id='${other.id}' and exam_delivery.normalize_exam_key(pv.exam_key)='sample400' and pv.package_version='1.0.0' and pp.profile_key='sectioned' and a.purpose='self_directed_exam';`);
const wrongFixedCount=await admin.rpc('certsim_protected_start_practice',{p_actor_id:learner.id,p_request:{examKey:'sample-400',profileId:'sectioned',purpose:'self_directed_exam',count:20,language:'not_applicable',includePbqs:true,mixStrategy:'balanced',clientRequestId:crypto.randomUUID()}});
if(wrongFixedCount.error||wrongFixedCount.data?.ok!==false||wrongFixedCount.data?.code!=='invalid_request') fail('FIXED_PROFILE_COUNT_NOT_FAIL_CLOSED');
const practiceRequest={examKey:'sample-400',profileId:'sectioned',purpose:'self_directed_exam',language:'not_applicable',includePbqs:true,mixStrategy:'balanced',clientRequestId:crypto.randomUUID()};
const practiceStarted=await admin.rpc('certsim_protected_start_practice',{p_actor_id:learner.id,p_request:practiceRequest});
if(practiceStarted.error||practiceStarted.data?.ok!==true||practiceStarted.data?.attempt?.purpose!=='self_directed_exam') fail(`PRACTICE_WITHOUT_ASSIGNMENT_FAILED_${safeCode(practiceStarted.error?.code)}_${safeDatabaseIdentifier(practiceStarted.error?.message)}_${safeCode(practiceStarted.data?.code)}`);
if(practiceStarted.data.items.filter((item)=>item.questionType!=='case-study-context').length!==10) fail('PRACTICE_PROFILE_ITEM_COUNTS_FAILED');
const practicePhysicalItemCount=practiceStarted.data.items.length;
sql(`select 1/((count(*)=1)::integer) from exam_delivery.attempts a join exam_delivery.package_versions pv on pv.id=a.package_version_id join exam_delivery.package_profiles pp on pp.id=a.package_profile_id where a.owner_id='${learner.id}' and exam_delivery.normalize_exam_key(pv.exam_key)='sample400' and pv.package_version='1.0.0' and pp.profile_key='sectioned' and a.purpose='self_directed_exam'; select 1/((count(*)=${practicePhysicalItemCount})::integer) from exam_delivery.attempt_items where attempt_id='${practiceStarted.data.attempt.attemptId}'; select 1/((count(*)=${practicePhysicalItemCount})::integer) from exam_delivery.attempt_item_protected_content pc join exam_delivery.attempt_items i on i.id=pc.attempt_item_id where i.attempt_id='${practiceStarted.data.attempt.attemptId}';`);
const practiceReplay=await admin.rpc('certsim_protected_start_practice',{p_actor_id:learner.id,p_request:practiceRequest});
if(practiceReplay.error||practiceReplay.data?.attempt?.attemptId!==practiceStarted.data?.attempt?.attemptId) fail('PRACTICE_IDEMPOTENCY_FAILED');
const practiceAttemptId=practiceStarted.data.attempt.attemptId;
const currentPracticeArgs={p_actor_id:learner.id,p_exam_key:'sample-400',p_package_version:'1.0.0',p_profile_key:'sectioned',p_purpose:'self_directed_exam',p_language:'not_applicable'};
const discoveredPractice=await admin.rpc('certsim_protected_discover_current_attempt',currentPracticeArgs);
if(discoveredPractice.error||discoveredPractice.data?.attempt?.attemptId!==practiceAttemptId) fail('PRACTICE_CURRENT_DISCOVERY_FAILED');
const hiddenCrossUser=await admin.rpc('certsim_protected_discover_current_attempt',{...currentPracticeArgs,p_actor_id:other.id});
expectReason(hiddenCrossUser,'attempt_not_found');
const wrongPurposeDiscovery=await admin.rpc('certsim_protected_discover_current_attempt',{...currentPracticeArgs,p_purpose:'study_sandbox'});
expectReason(wrongPurposeDiscovery,'attempt_not_found');
const practiceScoredItems=practiceStarted.data.items.filter((item)=>item.questionType!=='case-study-context');
const weakSeedItem=practiceScoredItems.find((item)=>item.questionType==='single-choice');
if(!weakSeedItem) fail('PRACTICE_WEAK_SEED_MISSING');
const practiceItems=[weakSeedItem,...practiceScoredItems.filter((item)=>item.itemId!==weakSeedItem.itemId)];
const resumedPractice=await admin.rpc('certsim_protected_resume_attempt',{p_actor_id:learner.id,p_attempt_id:practiceAttemptId});
if(resumedPractice.error||resumedPractice.data?.attempt?.attemptId!==practiceAttemptId) fail('PRACTICE_RESUME_FAILED');
const firstPracticeRequest=crypto.randomUUID();
const firstPracticeSave={p_actor_id:learner.id,p_attempt_id:practiceAttemptId,p_item_id:practiceItems[0].itemId,p_response:practiceItems[0].questionType==='single-choice'?{answer:'b'}:responseFor(practiceItems[0]),p_expected_revision:0,p_request_id:firstPracticeRequest};
const firstSaved=await admin.rpc('certsim_protected_save_response',firstPracticeSave);
if(firstSaved.error||firstSaved.data?.revision!==1) fail('PRACTICE_SAVE_FAILED');
const replayedSave=await admin.rpc('certsim_protected_save_response',firstPracticeSave);
if(replayedSave.error||replayedSave.data?.revision!==1) fail('PRACTICE_SAVE_REPLAY_FAILED');
const crossPractice=await admin.rpc('certsim_protected_resume_attempt',{p_actor_id:other.id,p_attempt_id:practiceAttemptId});
expectReason(crossPractice,'attempt_not_found');
sql(`update exam_delivery.practice_policies set enabled=false,access_mode='disabled' where canonical_exam_key='sample400' and purpose='self_directed_exam';`);
const blockedDiscovery=await admin.rpc('certsim_protected_discover_current_attempt',currentPracticeArgs);
expectReason(blockedDiscovery,'practice_unavailable');
const blockedContinuation=await admin.rpc('certsim_protected_save_response',{p_actor_id:learner.id,p_attempt_id:practiceAttemptId,p_item_id:practiceItems[1].itemId,p_response:responseFor(practiceItems[1]),p_expected_revision:0,p_request_id:crypto.randomUUID()});
expectReason(blockedContinuation,'practice_unavailable');
sql(`update exam_delivery.practice_policies set enabled=true,access_mode='controlled_beta' where canonical_exam_key='sample400' and purpose='self_directed_exam';`);
const rediscoveredPractice=await admin.rpc('certsim_protected_discover_current_attempt',currentPracticeArgs);
if(rediscoveredPractice.error||rediscoveredPractice.data?.attempt?.attemptId!==practiceAttemptId) fail('PRACTICE_CURRENT_REENABLE_FAILED');
for(const item of practiceItems.slice(1)){
  const weakSeedResponse=item.questionType==='single-choice'?{answer:'b'}:responseFor(item);
  const saved=await admin.rpc('certsim_protected_save_response',{p_actor_id:learner.id,p_attempt_id:practiceAttemptId,p_item_id:item.itemId,p_response:weakSeedResponse,p_expected_revision:0,p_request_id:crypto.randomUUID()});
  if(saved.error||saved.data?.revision!==1) fail('PRACTICE_CONTINUATION_SAVE_FAILED');
}
const practiceSubmissionId=crypto.randomUUID();
const practiceSubmitted=await admin.rpc('certsim_protected_submit_attempt',{p_actor_id:learner.id,p_attempt_id:practiceAttemptId,p_submission_id:practiceSubmissionId});
if(practiceSubmitted.error||practiceSubmitted.data?.result?.attemptId!==practiceAttemptId||practiceSubmitted.data?.result?.serverAuthoritative!==true) fail('PRACTICE_SUBMISSION_FAILED');
const practiceSubmitReplay=await admin.rpc('certsim_protected_submit_attempt',{p_actor_id:learner.id,p_attempt_id:practiceAttemptId,p_submission_id:practiceSubmissionId});
if(practiceSubmitReplay.error||practiceSubmitReplay.data?.result?.attemptId!==practiceAttemptId) fail('PRACTICE_SUBMISSION_REPLAY_FAILED');
const practiceResult=await admin.rpc('certsim_protected_get_result',{p_actor_id:learner.id,p_attempt_id:practiceAttemptId});
if(practiceResult.error||practiceResult.data?.result?.attemptId!==practiceAttemptId||practiceResult.data?.result?.serverAuthoritative!==true) fail('PRACTICE_RESULT_FAILED');
const practicePrint=await admin.rpc('certsim_protected_print_summary',{p_actor_id:learner.id,p_attempt_id:practiceAttemptId});
if(practicePrint.error||practicePrint.data?.purpose!=='self_directed_exam'||/question|answer|explanation|scoring|snapshot/i.test(JSON.stringify(practicePrint.data))) fail('PRACTICE_PRINT_FAILED');
const completedNotCurrent=await admin.rpc('certsim_protected_discover_current_attempt',currentPracticeArgs);
expectReason(completedNotCurrent,'attempt_not_found');

// Natural practice expiry is learner-owned and assignment-free. A zero-response
// stale attempt is preserved, terminalized once, and replaced atomically.
const staleRequest={...practiceRequest,clientRequestId:crypto.randomUUID()};
const staleStarted=await admin.rpc('certsim_protected_start_practice',{p_actor_id:learner.id,p_request:staleRequest});
if(staleStarted.error||staleStarted.data?.ok!==true) fail('EXPIRY_FIXTURE_START_FAILED');
const staleId=staleStarted.data.attempt.attemptId;
const staleItemCount=staleStarted.data.items.length;
sql(`alter table exam_delivery.attempts disable trigger guard_attempt_identity_and_lifecycle; update exam_delivery.attempts set created_at=statement_timestamp()-interval '3 hours',started_at=statement_timestamp()-interval '2 hours',expires_at=statement_timestamp()-interval '1 minute' where id='${staleId}'::uuid; alter table exam_delivery.attempts enable trigger guard_attempt_identity_and_lifecycle;`);
const staleNotCurrent=await admin.rpc('certsim_protected_discover_current_attempt',currentPracticeArgs);
expectReason(staleNotCurrent,'attempt_not_found');
sql(`update exam_delivery.practice_policies set enabled=false,access_mode='disabled' where canonical_exam_key='sample400' and purpose='self_directed_exam';`);
const disabledReplacement=await admin.rpc('certsim_protected_start_practice',{p_actor_id:learner.id,p_request:{...practiceRequest,clientRequestId:crypto.randomUUID()}});
expectReason(disabledReplacement,'practice_unavailable');
sql(`select 1/((status='in_progress')::integer) from exam_delivery.attempts where id='${staleId}'::uuid; update exam_delivery.practice_policies set enabled=true,access_mode='controlled_beta' where canonical_exam_key='sample400' and purpose='self_directed_exam';`);
const replacementRequests=[
  {...practiceRequest,clientRequestId:crypto.randomUUID()},
  {...practiceRequest,clientRequestId:crypto.randomUUID()},
];
const concurrentReplacements=await Promise.all(replacementRequests.map((p_request)=>admin.rpc('certsim_protected_start_practice',{p_actor_id:learner.id,p_request})));
if(concurrentReplacements.some((value)=>value.error||value.data?.ok!==true)) fail('EXPIRY_CONCURRENT_REPLACEMENT_FAILED');
const replacementIds=new Set(concurrentReplacements.map((value)=>value.data.attempt.attemptId));
if(replacementIds.size!==1) fail('EXPIRY_DUPLICATE_REPLACEMENT_CREATED');
const replacementId=[...replacementIds][0];
const replacementReplay=await admin.rpc('certsim_protected_start_practice',{p_actor_id:learner.id,p_request:replacementRequests[0]});
if(replacementReplay.error||replacementReplay.data?.attempt?.attemptId!==replacementId) fail('EXPIRY_REPLACEMENT_REPLAY_FAILED');
const replacementCurrent=await admin.rpc('certsim_protected_discover_current_attempt',currentPracticeArgs);
if(replacementCurrent.error||replacementCurrent.data?.attempt?.attemptId!==replacementId) fail('EXPIRY_REPLACEMENT_CURRENT_FAILED');
const replacementItems=concurrentReplacements[0].data.items.filter((item)=>item.questionType!=='case-study-context');
for(const item of replacementItems){
  const saved=await admin.rpc('certsim_protected_save_response',{p_actor_id:learner.id,p_attempt_id:replacementId,p_item_id:item.itemId,p_response:responseFor(item),p_expected_revision:0,p_request_id:crypto.randomUUID()});
  if(saved.error||saved.data?.revision!==1) fail('EXPIRY_REPLACEMENT_SAVE_FAILED');
}
const replacementSubmitted=await admin.rpc('certsim_protected_submit_attempt',{p_actor_id:learner.id,p_attempt_id:replacementId,p_submission_id:crypto.randomUUID()});
if(replacementSubmitted.error||replacementSubmitted.data?.result?.attemptId!==replacementId) fail('EXPIRY_REPLACEMENT_SUBMIT_FAILED');
const replacementResult=await admin.rpc('certsim_protected_get_result',{p_actor_id:learner.id,p_attempt_id:replacementId});
if(replacementResult.error||replacementResult.data?.result?.attemptId!==replacementId) fail('EXPIRY_REPLACEMENT_RESULT_FAILED');
sql(`select 1/((count(*)=1 and bool_and(reason_code='practice_window_expired') and bool_and(response_count=0) and bool_and(expired_at is not null) and bool_and(replacement_started_at is not null))::integer) from exam_delivery.practice_attempt_expirations where expired_attempt_id='${staleId}'::uuid and replacement_attempt_id='${replacementId}'::uuid; select 1/((status='expired' and (select count(*) from exam_delivery.attempt_items where attempt_id='${staleId}'::uuid)=${staleItemCount} and (select count(*) from exam_delivery.attempt_item_protected_content where attempt_id='${staleId}'::uuid)=${staleItemCount} and not exists(select 1 from exam_delivery.attempt_responses where attempt_id='${staleId}'::uuid) and not exists(select 1 from exam_delivery.attempt_results where attempt_id='${staleId}'::uuid) and not exists(select 1 from exam_delivery.review_snapshots where attempt_id='${staleId}'::uuid))::integer) from exam_delivery.attempts where id='${staleId}'::uuid;`);
for(const operation of [
  admin.rpc('certsim_protected_resume_attempt',{p_actor_id:learner.id,p_attempt_id:staleId}),
  admin.rpc('certsim_protected_submit_attempt',{p_actor_id:learner.id,p_attempt_id:staleId,p_submission_id:crypto.randomUUID()}),
]) expectReason(await operation,'invalid_lifecycle_transition');

sql(`insert into exam_delivery.practice_policies(canonical_exam_key,package_version,profile_key,purpose,access_mode,enabled,maximum_completed_attempts,maximum_session_items,immediate_feedback,review_release_policy,answer_release_policy) values
 ('sample400','1.0.0','sectioned','study_sandbox','controlled_beta',true,2,10,true,'immediate_study_feedback','immediate_study_feedback'),
 ('sample400','1.0.0','sectioned','targeted_domain','controlled_beta',true,2,10,false,'after_submission','after_submission'),
 ('sample400','1.0.0','sectioned','weak_area','controlled_beta',true,2,10,false,'after_submission','after_submission'),
 ('sample400','1.0.0','sectioned','pbq_practice','controlled_beta',true,2,10,false,'after_submission','after_submission')
on conflict (canonical_exam_key,package_version,profile_key,purpose) do update set
 access_mode=excluded.access_mode,
 enabled=excluded.enabled,
 maximum_completed_attempts=excluded.maximum_completed_attempts,
 maximum_session_items=excluded.maximum_session_items,
 immediate_feedback=excluded.immediate_feedback,
 review_release_policy=excluded.review_release_policy,
 answer_release_policy=excluded.answer_release_policy;
update exam_delivery.exam_access_learners set enabled=true
where canonical_exam_key='sample400' and learner_id='${learner.id}';`);

const weakBase={examKey:'sample-400',profileId:'sectioned',purpose:'weak_area',domain:'d1',count:10,language:'not_applicable',includePbqs:true,mixStrategy:'balanced'};
const weakStale=await admin.rpc('certsim_protected_start_practice',{p_actor_id:learner.id,p_request:{...weakBase,clientRequestId:crypto.randomUUID()}});
if(weakStale.error||weakStale.data?.ok!==true) fail(`RESPONSE_EXPIRY_FIXTURE_START_FAILED_${safeCode(weakStale.error?.code)}_${safeCode(weakStale.data?.code)}`);
const weakStaleId=weakStale.data.attempt.attemptId;
const weakStaleItem=weakStale.data.items.find((item)=>item.questionType!=='case-study-context');
const weakStaleSave=await admin.rpc('certsim_protected_save_response',{p_actor_id:learner.id,p_attempt_id:weakStaleId,p_item_id:weakStaleItem.itemId,p_response:responseFor(weakStaleItem),p_expected_revision:0,p_request_id:crypto.randomUUID()});
if(weakStaleSave.error||weakStaleSave.data?.revision!==1) fail('RESPONSE_EXPIRY_FIXTURE_SAVE_FAILED');
sql(`alter table exam_delivery.attempts disable trigger guard_attempt_identity_and_lifecycle; update exam_delivery.attempts set created_at=statement_timestamp()-interval '3 hours',started_at=statement_timestamp()-interval '2 hours',expires_at=statement_timestamp()-interval '1 minute' where id='${weakStaleId}'::uuid; alter table exam_delivery.attempts enable trigger guard_attempt_identity_and_lifecycle;`);
const weakReplacement=await admin.rpc('certsim_protected_start_practice',{p_actor_id:learner.id,p_request:{...weakBase,clientRequestId:crypto.randomUUID()}});
if(weakReplacement.error||weakReplacement.data?.ok!==true) fail('RESPONSE_EXPIRY_REPLACEMENT_FAILED');
const weakReplacementId=weakReplacement.data.attempt.attemptId;
for(const item of weakReplacement.data.items.filter((entry)=>entry.questionType!=='case-study-context')){
  const saved=await admin.rpc('certsim_protected_save_response',{p_actor_id:learner.id,p_attempt_id:weakReplacementId,p_item_id:item.itemId,p_response:responseFor(item),p_expected_revision:0,p_request_id:crypto.randomUUID()});
  if(saved.error||saved.data?.revision!==1) fail('RESPONSE_EXPIRY_REPLACEMENT_SAVE_FAILED');
}
const weakSubmitted=await admin.rpc('certsim_protected_submit_attempt',{p_actor_id:learner.id,p_attempt_id:weakReplacementId,p_submission_id:crypto.randomUUID()});
if(weakSubmitted.error||weakSubmitted.data?.result?.attemptId!==weakReplacementId) fail('RESPONSE_EXPIRY_REPLACEMENT_SUBMIT_FAILED');
const weakLimit=await admin.rpc('certsim_protected_start_practice',{p_actor_id:learner.id,p_request:{...weakBase,clientRequestId:crypto.randomUUID()}});
expectReason(weakLimit,'attempt_limit_reached');
sql(`select 1/((count(*)=1 and bool_and(response_count=1) and bool_and(reason_code='practice_window_expired'))::integer) from exam_delivery.practice_attempt_expirations where expired_attempt_id='${weakStaleId}'::uuid and replacement_attempt_id='${weakReplacementId}'::uuid;`);

for(const config of [
  {purpose:'study_sandbox',count:10,language:'not_applicable',check:true},
  {purpose:'targeted_domain',count:10,language:'not_applicable',domain:'d1'},
  {purpose:'pbq_practice',count:10,language:'not_applicable'},
]){
  const request={examKey:'sample-400',profileId:'sectioned',includePbqs:true,mixStrategy:'balanced',clientRequestId:crypto.randomUUID(),...config};
  delete request.check;
  const startedPurpose=await admin.rpc('certsim_protected_start_practice',{p_actor_id:learner.id,p_request:request});
  if(startedPurpose.error||startedPurpose.data?.attempt?.purpose!==config.purpose) fail(`PRACTICE_${config.purpose.toUpperCase()}_START_FAILED`);
  const purposeId=startedPurpose.data.attempt.attemptId;
  const discoveredPurpose=await admin.rpc('certsim_protected_discover_current_attempt',{p_actor_id:learner.id,p_exam_key:'sample-400',p_package_version:'1.0.0',p_profile_key:'sectioned',p_purpose:config.purpose,p_language:'not_applicable'});
  if(discoveredPurpose.error||discoveredPurpose.data?.attempt?.attemptId!==purposeId) fail(`PRACTICE_${config.purpose.toUpperCase()}_DISCOVERY_FAILED`);
  const scoredPurposeItems=startedPurpose.data.items.filter((item)=>item.questionType!=='case-study-context');
  for(const item of scoredPurposeItems){
    const saved=await admin.rpc('certsim_protected_save_response',{p_actor_id:learner.id,p_attempt_id:purposeId,p_item_id:item.itemId,p_response:responseFor(item),p_expected_revision:0,p_request_id:crypto.randomUUID()});
    if(saved.error||saved.data?.revision!==1) fail(`PRACTICE_${config.purpose.toUpperCase()}_SAVE_FAILED`);
  }
  if(config.check){
    const checked=await admin.rpc('certsim_protected_check_practice_item',{p_actor_id:learner.id,p_attempt_id:purposeId,p_item_id:scoredPurposeItems[0].itemId,p_expected_revision:1,p_request_id:crypto.randomUUID()});
    if(checked.error||checked.data?.ok!==true||!checked.data?.releasedAt) fail('PRACTICE_SANDBOX_CHECK_FAILED');
  }
  const submittedPurpose=await admin.rpc('certsim_protected_submit_attempt',{p_actor_id:learner.id,p_attempt_id:purposeId,p_submission_id:crypto.randomUUID()});
  if(submittedPurpose.error||submittedPurpose.data?.result?.attemptId!==purposeId) fail(`PRACTICE_${config.purpose.toUpperCase()}_SUBMIT_FAILED`);
  const reviewPurpose=await admin.rpc('certsim_protected_get_review',{p_actor_id:learner.id,p_attempt_id:purposeId});
  if(reviewPurpose.error||reviewPurpose.data?.ok!==true) fail(`PRACTICE_${config.purpose.toUpperCase()}_REVIEW_FAILED`);
}
const practiceHistory=await admin.rpc('certsim_protected_list_history',{p_actor_id:learner.id,p_exam_key:'sample-400',p_cursor:null,p_page_size:20});
const practiceHistoryItems=Array.isArray(practiceHistory.data?.items)?practiceHistory.data.items:[];
const practiceHistoryPurposes=new Set(practiceHistoryItems.map((item)=>item.purpose));
if(practiceHistory.error||practiceHistoryItems.length!==6||practiceHistoryPurposes.size!==5) fail(`PRACTICE_HISTORY_CLASSIFICATION_FAILED_${safeCode(practiceHistory.error?.code)}_${practiceHistoryItems.length}_${practiceHistoryPurposes.size}`);
const practiceSummary=await admin.rpc('certsim_protected_history_summary',{p_actor_id:learner.id,p_exam_key:'sample-400'});
if(practiceSummary.error||practiceSummary.data?.completedCount!==2) fail('PRACTICE_SUMMARY_FILTER_FAILED');
sql(`select 1/((count(*)=3 and bool_and(protected_assignment_id is null) and bool_and(purpose='self_directed_exam') and count(*) filter(where status='expired')=1)::integer) from exam_delivery.attempts where owner_id='${learner.id}'::uuid and purpose='self_directed_exam'; update exam_delivery.practice_policies set enabled=false,access_mode='disabled' where canonical_exam_key='sample400'; update exam_delivery.exam_access_policies set require_assignment=false where canonical_exam_key='sample400'; update exam_delivery.exam_access_learners set enabled=true where canonical_exam_key='sample400' and learner_id='${learner.id}';`);

const startArgs={p_actor_id:learner.id,p_exam_key:'sample-400',p_profile_key:'sectioned',p_request_id:crypto.randomUUID()};
const started=await admin.rpc('certsim_protected_start_attempt',startArgs);
const attemptId=started.data?.attempt?.attemptId,items=started.data?.items;
if(started.error) fail(`ATOMIC_GENERATION_RPC_${safeCode(started.error.code)}_${safeDatabaseIdentifier(started.error.message)}`);
if(started.data?.ok!==true) fail(`ATOMIC_GENERATION_${safeCode(started.data?.code)}`);
if(!attemptId) fail('ATOMIC_GENERATION_ATTEMPT_MISSING');
if(!Array.isArray(items)||items.length!==11) fail('ATOMIC_GENERATION_ITEM_COUNT');
if(items.filter((i)=>i.questionType==='case-study-context').length!==1) fail('ATOMIC_GENERATION_CASE_CONTEXT_COUNT');
if(items.filter((i)=>i.questionType==='pbq-config-panel').length!==1) fail('ATOMIC_GENERATION_PBQ_COUNT');
const discoveredAssessment=await admin.rpc('certsim_protected_discover_current_attempt',{p_actor_id:learner.id,p_exam_key:'sample-400',p_package_version:'1.0.0',p_profile_key:'sectioned',p_purpose:'assigned_assessment',p_language:'not_applicable'});
if(discoveredAssessment.error||discoveredAssessment.data?.attempt?.attemptId!==attemptId) fail('ASSESSMENT_CURRENT_DISCOVERY_FAILED');
for(const item of items.filter((i)=>i.questionType!=='case-study-context')){
  const response=item.questionType==='pbq-config-panel'
    ? {selectedAnswers:{x:'a'}}
    : item.questionType==='dropdown-code'
      ? {answer:{first:'alpha',second:'beta'}}
      : {answer:'a'};
  const saved=await admin.rpc('certsim_protected_save_response',{p_actor_id:learner.id,p_attempt_id:attemptId,p_item_id:item.itemId,p_response:response,p_expected_revision:0,p_request_id:crypto.randomUUID()});
  if(saved.error||saved.data?.revision!==1) fail('GENERIC_RESPONSE_SAVE_FAILED');
}
const submissionId=crypto.randomUUID();
const submitted=await admin.rpc('certsim_protected_submit_attempt',{p_actor_id:learner.id,p_attempt_id:attemptId,p_submission_id:submissionId});
if(submitted.error||submitted.data?.result?.questionCount!==10||submitted.data?.result?.maxScore!==10||submitted.data?.result?.reviewStatus!=='withheld') fail('GENERIC_SUBMISSION_FAILED');
const submitReplay=await admin.rpc('certsim_protected_submit_attempt',{p_actor_id:learner.id,p_attempt_id:attemptId,p_submission_id:submissionId});
if(submitReplay.error||submitReplay.data?.result?.attemptId!==attemptId) fail('SUBMISSION_REPLAY_FAILED');
const review=await admin.rpc('certsim_protected_get_review',{p_actor_id:learner.id,p_attempt_id:attemptId}); expectReason(review,'review_unavailable');
const cross=await admin.rpc('certsim_protected_get_result',{p_actor_id:other.id,p_attempt_id:attemptId}); expectReason(cross,'attempt_not_found');
sql(`select 1/((count(*)=1 and bool_and(server_authoritative))::integer) from exam_delivery.attempt_results where attempt_id='${attemptId}'::uuid; select 1/((count(*)=1 and bool_and(release_status='withheld'))::integer) from exam_delivery.review_snapshots where attempt_id='${attemptId}'::uuid; select 1/((count(*)=10)::integer) from public.exam_responses where attempt_id='${attemptId}'::uuid and is_scored; select 1/((count(*)=1)::integer) from public.exam_responses where attempt_id='${attemptId}'::uuid and not is_scored;`);

// R3H learner-requested replacement is atomic, owner-bound and idempotent.
sql(`update exam_delivery.practice_policies set enabled=true,access_mode='controlled_beta',maximum_completed_attempts=null,maximum_concurrent_sessions=1 where canonical_exam_key='sample400' and package_version='1.0.0' and profile_key='sectioned' and purpose='self_directed_exam';`);
const r3hInitialRequest={...practiceRequest,clientRequestId:crypto.randomUUID()};
const r3hInitial=await admin.rpc('certsim_protected_start_practice',{p_actor_id:learner.id,p_request:r3hInitialRequest});
if(r3hInitial.error||r3hInitial.data?.ok!==true) fail('R3H_INITIAL_START_FAILED');
const r3hOldId=r3hInitial.data.attempt.attemptId;
const r3hBindings=await admin.rpc('certsim_protected_list_current_attempt_bindings',{p_actor_id:learner.id,p_exam_key:'sample-400',p_purpose:'self_directed_exam'});
if(r3hBindings.error||r3hBindings.data?.candidates?.length!==1||r3hBindings.data.candidates[0].attemptId!==r3hOldId||r3hBindings.data.candidates[0].replacementPermitted!==true) fail('R3H_BINDING_FAILED');

const rollbackRequest={...practiceRequest,clientRequestId:crypto.randomUUID()};
sql(`create function exam_delivery.r3h_test_reject_attempt() returns trigger language plpgsql set search_path='' as $$ begin if new.client_request_id='${rollbackRequest.clientRequestId}'::uuid then raise exception 'synthetic_r3h_insert_failure'; end if; return new; end $$; create trigger r3h_test_reject_attempt before insert on exam_delivery.attempts for each row execute function exam_delivery.r3h_test_reject_attempt();`);
const rolledBack=await admin.rpc('certsim_protected_replace_current_practice_attempt',{p_actor_id:learner.id,p_request:rollbackRequest});
if(rolledBack.error||rolledBack.data?.ok!==false||rolledBack.data?.code!=='replacement_failed') fail(`R3H_ROLLBACK_RESPONSE_FAILED_${safeCode(rolledBack.error?.code)}_${safeDatabaseIdentifier(rolledBack.error?.message)}_${safeCode(rolledBack.data?.code)}`);
sql(`drop trigger r3h_test_reject_attempt on exam_delivery.attempts; drop function exam_delivery.r3h_test_reject_attempt(); select 1/((status='in_progress')::integer) from exam_delivery.attempts where id='${r3hOldId}'::uuid; select 1/((count(*)=0)::integer) from exam_delivery.attempt_replacements where replaced_attempt_id='${r3hOldId}'::uuid;`);

const replacementRequest={...practiceRequest,clientRequestId:crypto.randomUUID()};
const replaced=await admin.rpc('certsim_protected_replace_current_practice_attempt',{p_actor_id:learner.id,p_request:replacementRequest});
if(replaced.error||replaced.data?.ok!==true||replaced.data?.attempt?.attemptId===r3hOldId) fail('R3H_REPLACEMENT_FAILED');
const r3hNewId=replaced.data.attempt.attemptId;
const r3hReplacementReplay=await admin.rpc('certsim_protected_replace_current_practice_attempt',{p_actor_id:learner.id,p_request:replacementRequest});
if(r3hReplacementReplay.error||r3hReplacementReplay.data?.attempt?.attemptId!==r3hNewId) fail('R3H_REPLACEMENT_REPLAY_FAILED');
const replacementCrossUser=await admin.rpc('certsim_protected_replace_current_practice_attempt',{p_actor_id:other.id,p_request:replacementRequest});
if(replacementCrossUser.error||replacementCrossUser.data?.ok!==false) fail('R3H_CROSS_USER_NOT_DENIED');
const r3hCurrent=await admin.rpc('certsim_protected_discover_current_attempt',{...currentPracticeArgs,p_actor_id:learner.id});
if(r3hCurrent.error||r3hCurrent.data?.attempt?.attemptId!==r3hNewId) fail('R3H_REPLACEMENT_DISCOVERY_FAILED');
sql(`select 1/((status='voided')::integer) from exam_delivery.attempts where id='${r3hOldId}'::uuid; select 1/((status='in_progress')::integer) from exam_delivery.attempts where id='${r3hNewId}'::uuid; select 1/((count(*)=1 and bool_and(reason_code='learner_started_new_attempt'))::integer) from exam_delivery.attempt_replacements where replaced_attempt_id='${r3hOldId}'::uuid and replacement_attempt_id='${r3hNewId}'::uuid and owner_id='${learner.id}'::uuid; select 1/((count(*)=1)::integer) from exam_delivery.attempts where owner_id='${learner.id}'::uuid and package_profile_id=(select id from exam_delivery.package_profiles where profile_key='sectioned' and package_version_id=(select id from exam_delivery.package_versions where exam_key='sample400' and package_version='1.0.0')) and purpose='self_directed_exam' and status='in_progress';`);

console.log(JSON.stringify({status:'PASS',publication:'v2-atomic-idempotent',presentedCount:41,scoredCount:40,caseGroups:1,pbqGroups:1,dropdowns:1,review:'withheld',crossUser:'denied',r3hReplacement:'atomic-idempotent-owner-bound'}));

function client(key){return createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}})}
function required(name){const value=process.env[name]?.trim();if(!value)fail(`MISSING_${name}`);return value}
function fail(code){throw new Error(code)}
function sql(statement){const result=spawnSync('psql',[database,'-v','ON_ERROR_STOP=1','-c',statement],{stdio:'ignore'});if(result.status!==0)fail('SQL_FIXTURE_FAILED')}
function sqlValue(statement){const result=spawnSync('psql',[database,'-v','ON_ERROR_STOP=1','-Atc',statement],{encoding:'utf8'});if(result.status!==0)fail('SQL_FIXTURE_FAILED');return result.stdout.trim()}
async function createUser(label){const email=`generic-${label}-${crypto.randomUUID()}@example.invalid`,password=`T!${crypto.randomUUID()}g8`;const result=await admin.auth.admin.createUser({email,password,email_confirm:true});if(result.error)fail('AUTH_FIXTURE_FAILED');return{id:result.data.user.id,email,password}}
async function signedIn(user){const result=client(anon);const auth=await result.auth.signInWithPassword({email:user.email,password:user.password});if(auth.error)fail('SIGN_IN_FAILED');return result}
function expectReason(result,reason){if(result.error||(result.data?.reasonCode!==reason&&result.data?.code!==reason))fail(`EXPECTED_${reason.toUpperCase()}`)}
function responseFor(item){return item.questionType==='pbq-config-panel'?{selectedAnswers:{x:'a'}}:item.questionType==='dropdown-code'?{answer:{first:'alpha',second:'beta'}}:{answer:'a'}}
function safeCode(value){return String(value??'UNKNOWN').replace(/[^A-Za-z0-9_]/g,'_').toUpperCase()}
function safeDatabaseIdentifier(value){
  const message=String(value??'');
  const known=['selection_incomplete','attempt_contract_immutable','practice_pool_empty','attempt_already_materialized','attempt_not_materializable'];
  const invariant=known.find((name)=>message.toLowerCase().includes(name));
  if(invariant)return invariant.toUpperCase();
  const fn=message.match(/function\s+([A-Za-z0-9_.]+)/i)?.[1];
  if(fn)return fn.toUpperCase();
  const operator=message.match(/operator does not exist:\s*([A-Za-z0-9_.]+)\s+([^\s]+)\s+([A-Za-z0-9_.]+)/i);
  return operator?`${operator[1]}_${operator[2]}_${operator[3]}`.replace(/[^A-Za-z0-9_]/g,'_').toUpperCase():'UNKNOWN';
}
