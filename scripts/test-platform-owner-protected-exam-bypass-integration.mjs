import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const databaseUrl = required('SUPABASE_DB_URL');
const psql = process.env.PSQL_PATH?.trim() || 'psql';
const host = new URL(databaseUrl).hostname;
if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
  throw new Error('DISPOSABLE_LOCAL_DATABASE_REQUIRED');
}

const ids = Object.freeze({
  owner: '86700000-0000-4000-8000-000000000001',
  developer: '86700000-0000-4000-8000-000000000002',
  collegeAdmin: '86700000-0000-4000-8000-000000000003',
  campusAdmin: '86700000-0000-4000-8000-000000000004',
  trainer: '86700000-0000-4000-8000-000000000005',
  reception: '86700000-0000-4000-8000-000000000006',
  unassignedStudent: '86700000-0000-4000-8000-000000000007',
  assignedStudent: '86700000-0000-4000-8000-000000000008',
  purchaser: '86700000-0000-4000-8000-000000000009',
  organisation: '86700000-0000-4000-8000-000000000010',
  campus: '86700000-0000-4000-8000-000000000011',
  group: '86700000-0000-4000-8000-000000000012',
  pythonPackage: '86700000-0000-4000-8000-000000000020',
  pythonNoLab: '86700000-0000-4000-8000-000000000021',
  pythonLab: '86700000-0000-4000-8000-000000000022',
  currentPackage: '86700000-0000-4000-8000-000000000030',
  currentProfile: '86700000-0000-4000-8000-000000000031',
});

const preservedBefore = preservedEvidence();
const output = run(`
begin;

insert into auth.users(
  instance_id,id,aud,role,email,encrypted_password,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) values
  ('00000000-0000-0000-0000-000000000000','${ids.owner}','authenticated','authenticated','owner-access@example.invalid','','{}','{}',now(),now()),
  ('00000000-0000-0000-0000-000000000000','${ids.developer}','authenticated','authenticated','developer-access@example.invalid','','{}','{}',now(),now()),
  ('00000000-0000-0000-0000-000000000000','${ids.collegeAdmin}','authenticated','authenticated','college-access@example.invalid','','{}','{}',now(),now()),
  ('00000000-0000-0000-0000-000000000000','${ids.campusAdmin}','authenticated','authenticated','campus-access@example.invalid','','{}','{}',now(),now()),
  ('00000000-0000-0000-0000-000000000000','${ids.trainer}','authenticated','authenticated','trainer-access@example.invalid','','{}','{}',now(),now()),
  ('00000000-0000-0000-0000-000000000000','${ids.reception}','authenticated','authenticated','reception-access@example.invalid','','{}','{}',now(),now()),
  ('00000000-0000-0000-0000-000000000000','${ids.unassignedStudent}','authenticated','authenticated','unassigned-access@example.invalid','','{}','{}',now(),now()),
  ('00000000-0000-0000-0000-000000000000','${ids.assignedStudent}','authenticated','authenticated','assigned-access@example.invalid','','{}','{}',now(),now()),
  ('00000000-0000-0000-0000-000000000000','${ids.purchaser}','authenticated','authenticated','purchaser-access@example.invalid','','{}','{}',now(),now());

update public.profiles
set status='active',
    default_role=case when id='${ids.purchaser}' then 'individual_user' else default_role end
where id in (
  '${ids.owner}','${ids.developer}','${ids.collegeAdmin}','${ids.campusAdmin}',
  '${ids.trainer}','${ids.reception}','${ids.unassignedStudent}',
  '${ids.assignedStudent}','${ids.purchaser}'
);

insert into public.organisations(id,name,organisation_type,status)
values('${ids.organisation}','Platform Owner bypass fixture','internal','active');
insert into public.campuses(id,organisation_id,name,code,status)
values('${ids.campus}','${ids.organisation}','Bypass fixture campus','BYPASS','active');
insert into public."groups"(id,organisation_id,campus_id,name,status)
values('${ids.group}','${ids.organisation}','${ids.campus}','Bypass fixture group','active');

insert into public.memberships(user_id,organisation_id,campus_id,group_id,role,status) values
  ('${ids.owner}','${ids.organisation}',null,null,'platform_owner','active'),
  ('${ids.developer}','${ids.organisation}',null,null,'developer','active'),
  ('${ids.collegeAdmin}','${ids.organisation}',null,null,'college_admin','active'),
  ('${ids.campusAdmin}','${ids.organisation}','${ids.campus}',null,'campus_admin','active'),
  ('${ids.trainer}','${ids.organisation}','${ids.campus}','${ids.group}','trainer','active'),
  ('${ids.reception}','${ids.organisation}','${ids.campus}',null,'reception','active'),
  ('${ids.unassignedStudent}','${ids.organisation}','${ids.campus}','${ids.group}','student','active'),
  ('${ids.assignedStudent}','${ids.organisation}','${ids.campus}','${ids.group}','student','active');

insert into exam_delivery.package_versions(
  id,exam_key,package_version,source_commit_sha,validation_hash,package_hash,
  package_schema_version,generator_version,scorer_version,
  declared_review_release_policy,declared_answer_release_policy
) values
  ('${ids.pythonPackage}','pythonnextgeneration','1.0.0',repeat('1',40),repeat('2',64),repeat('3',64),
    'certsim-protected-package-v2','certsim-python-next-generation-canonical-forms-v1',
    'certsim-python-trusted-grading-v1','after_submission','after_submission'),
  ('${ids.currentPackage}','ai901','2.0.0',repeat('4',40),repeat('5',64),repeat('6',64),
    'certsim-protected-package-v2','certsim-ai901-weighted-generator-v2',
    'certsim-ai901-exact-scorer-v2','never','never');

insert into exam_delivery.package_profiles(
  id,package_version_id,profile_key,display_name,question_count,time_limit_minutes,selection_config
) values
  ('${ids.pythonNoLab}','${ids.pythonPackage}','pythonnextgeneration-no-lab','Python Next Generation No-Lab',35,50,'{}'),
  ('${ids.pythonLab}','${ids.pythonPackage}','pythonnextgeneration-lab','Python Next Generation Lab',31,50,'{}'),
  ('${ids.currentProfile}','${ids.currentPackage}','ai901-controlled-beta-compact','AI-901 compact',25,25,'{}');

update exam_delivery.package_versions
set status='published',published_at=statement_timestamp()
where id in ('${ids.pythonPackage}','${ids.currentPackage}');

insert into exam_delivery.exam_profile_activations(
  package_version_id,package_profile_id,enabled,activation_kind,enabled_at,created_by
) values('${ids.currentPackage}','${ids.currentProfile}',true,'production',statement_timestamp(),'${ids.owner}');

insert into exam_delivery.exam_entitlements(
  package_version_id,package_profile_id,target_type,learner_id,enabled,valid_from,
  reason_code,created_by,entitlement_source,purchase_reference
) values
  ('${ids.pythonPackage}','${ids.pythonNoLab}','learner','${ids.assignedStudent}',true,statement_timestamp()-interval '1 minute',
    'assignment_fixture','${ids.owner}','assignment',null),
  ('${ids.pythonPackage}','${ids.pythonLab}','learner','${ids.assignedStudent}',true,statement_timestamp()-interval '1 minute',
    'assignment_fixture','${ids.owner}','assignment',null),
  ('${ids.currentPackage}','${ids.currentProfile}','learner','${ids.assignedStudent}',true,statement_timestamp()-interval '1 minute',
    'assignment_fixture','${ids.owner}','assignment',null),
  ('${ids.pythonPackage}','${ids.pythonNoLab}','learner','${ids.purchaser}',true,statement_timestamp()-interval '1 minute',
    'purchase_fixture','${ids.owner}','direct_exam_purchase','purchase:python:no-lab'),
  ('${ids.pythonPackage}','${ids.pythonLab}','learner','${ids.purchaser}',true,statement_timestamp()-interval '1 minute',
    'purchase_fixture','${ids.owner}','package_purchase','purchase:python:lab');

create temporary table access_fix_responses(label text primary key,response jsonb) on commit drop;
insert into access_fix_responses values
  ('noLabAcceptance',exam_delivery.configure_exam_release_stage(
    '${ids.owner}',
    '{"examKey":"pythonnextgeneration","packageVersion":"1.0.0","profileKey":"pythonnextgeneration-no-lab","releaseStage":"acceptance","requestId":"86710000-0000-4000-8000-000000000001"}'::jsonb
  )),
  ('labAcceptance',exam_delivery.configure_exam_release_stage(
    '${ids.owner}',
    '{"examKey":"pythonnextgeneration","packageVersion":"1.0.0","profileKey":"pythonnextgeneration-lab","releaseStage":"acceptance","requestId":"86710000-0000-4000-8000-000000000002"}'::jsonb
  ));

insert into access_fix_responses values
  ('noLabActive',exam_delivery.configure_exam_release_stage(
    '${ids.owner}',
    '{"examKey":"pythonnextgeneration","packageVersion":"1.0.0","profileKey":"pythonnextgeneration-no-lab","releaseStage":"standard_active_exam_v1","requestId":"86710000-0000-4000-8000-000000000003"}'::jsonb
  )),
  ('labActive',exam_delivery.configure_exam_release_stage(
    '${ids.owner}',
    '{"examKey":"pythonnextgeneration","packageVersion":"1.0.0","profileKey":"pythonnextgeneration-lab","releaseStage":"standard_active_exam_v1","requestId":"86710000-0000-4000-8000-000000000004"}'::jsonb
  ));

select 'PLATFORM_OWNER_BYPASS_EVIDENCE:' || json_build_object(
  'responses',(select jsonb_object_agg(label,response) from access_fix_responses),
  'pythonOwnerProfiles',(select count(*) from exam_delivery.package_profiles profile
    where profile.package_version_id='${ids.pythonPackage}'
      and exam_delivery.can_use_profile('${ids.owner}','${ids.pythonPackage}',profile.id,'self_directed_exam')),
  'pythonDeveloperProfiles',(select count(*) from exam_delivery.package_profiles profile
    where profile.package_version_id='${ids.pythonPackage}'
      and exam_delivery.can_use_profile('${ids.developer}','${ids.pythonPackage}',profile.id,'self_directed_exam')),
  'pythonCollegeAdminProfiles',(select count(*) from exam_delivery.package_profiles profile
    where profile.package_version_id='${ids.pythonPackage}'
      and exam_delivery.can_use_profile('${ids.collegeAdmin}','${ids.pythonPackage}',profile.id,'self_directed_exam')),
  'pythonCampusAdminProfiles',(select count(*) from exam_delivery.package_profiles profile
    where profile.package_version_id='${ids.pythonPackage}'
      and exam_delivery.can_use_profile('${ids.campusAdmin}','${ids.pythonPackage}',profile.id,'self_directed_exam')),
  'pythonTrainerProfiles',(select count(*) from exam_delivery.package_profiles profile
    where profile.package_version_id='${ids.pythonPackage}'
      and exam_delivery.can_use_profile('${ids.trainer}','${ids.pythonPackage}',profile.id,'self_directed_exam')),
  'pythonReceptionProfiles',(select count(*) from exam_delivery.package_profiles profile
    where profile.package_version_id='${ids.pythonPackage}'
      and exam_delivery.can_use_profile('${ids.reception}','${ids.pythonPackage}',profile.id,'self_directed_exam')),
  'pythonUnassignedProfiles',(select count(*) from exam_delivery.package_profiles profile
    where profile.package_version_id='${ids.pythonPackage}'
      and exam_delivery.can_use_profile('${ids.unassignedStudent}','${ids.pythonPackage}',profile.id,'self_directed_exam')),
  'pythonAssignedProfiles',(select count(*) from exam_delivery.package_profiles profile
    where profile.package_version_id='${ids.pythonPackage}'
      and exam_delivery.can_use_profile('${ids.assignedStudent}','${ids.pythonPackage}',profile.id,'self_directed_exam')),
  'pythonPurchasedProfiles',(select count(*) from exam_delivery.package_profiles profile
    where profile.package_version_id='${ids.pythonPackage}'
      and exam_delivery.can_use_profile('${ids.purchaser}','${ids.pythonPackage}',profile.id,'self_directed_exam')),
  'ownerAvailability',(select count(*) from exam_delivery.package_profiles profile
    where profile.package_version_id='${ids.pythonPackage}' and
      (public.certsim_protected_check_profile_eligibility(
        '${ids.owner}','pythonnextgeneration','1.0.0',profile.profile_key,'self_directed_exam'
      )->>'eligible')::boolean),
  'unassignedDenied',(select count(*) from exam_delivery.package_profiles profile
    where profile.package_version_id='${ids.pythonPackage}' and
      public.certsim_protected_check_profile_eligibility(
        '${ids.unassignedStudent}','pythonnextgeneration','1.0.0',profile.profile_key,'self_directed_exam'
      )->>'reasonCode'='access_not_granted'),
  'assignedAvailability',(select count(*) from exam_delivery.package_profiles profile
    where profile.package_version_id='${ids.pythonPackage}' and
      (public.certsim_protected_check_profile_eligibility(
        '${ids.assignedStudent}','pythonnextgeneration','1.0.0',profile.profile_key,'self_directed_exam'
      )->>'eligible')::boolean),
  'authoritativeStaffUnchanged',(select count(*) from unnest(array[
      '${ids.owner}'::uuid,'${ids.developer}'::uuid,'${ids.collegeAdmin}'::uuid,
      '${ids.campusAdmin}'::uuid,'${ids.trainer}'::uuid,'${ids.reception}'::uuid
    ]) actor(id) where exam_delivery.is_authoritative_staff(actor.id)),
  'adminScopePreserved',(
    exam_delivery.staff_can_view_learner('${ids.owner}','${ids.assignedStudent}')
    and exam_delivery.staff_can_view_learner('${ids.developer}','${ids.assignedStudent}')
    and exam_delivery.staff_can_view_learner('${ids.collegeAdmin}','${ids.assignedStudent}')
    and exam_delivery.staff_can_view_learner('${ids.campusAdmin}','${ids.assignedStudent}')
    and exam_delivery.staff_can_view_learner('${ids.trainer}','${ids.assignedStudent}')
    and not exam_delivery.staff_can_view_learner('${ids.reception}','${ids.assignedStudent}')
  ),
  'currentExamOwner',exam_delivery.can_use_profile(
    '${ids.owner}','${ids.currentPackage}','${ids.currentProfile}','self_directed_exam'),
  'currentExamNonOwnerStaffDenied',(select count(*)=0 from unnest(array[
      '${ids.developer}'::uuid,'${ids.collegeAdmin}'::uuid,'${ids.campusAdmin}'::uuid,
      '${ids.trainer}'::uuid,'${ids.reception}'::uuid
    ]) actor(id) where exam_delivery.can_use_profile(
      actor.id,'${ids.currentPackage}','${ids.currentProfile}','self_directed_exam')),
  'currentExamUnassignedDenied',not exam_delivery.can_use_profile(
    '${ids.unassignedStudent}','${ids.currentPackage}','${ids.currentProfile}','self_directed_exam'),
  'currentExamAssigned',exam_delivery.can_use_profile(
    '${ids.assignedStudent}','${ids.currentPackage}','${ids.currentProfile}','self_directed_exam'),
  'activations',(select count(*) from exam_delivery.exam_profile_activations activation
    where activation.package_version_id='${ids.pythonPackage}' and activation.enabled
      and activation.activation_kind='production'),
  'assignedDefaults',(select count(*) from exam_delivery.package_profile_defaults
    where canonical_exam_key='pythonnextgeneration' and purpose='assigned_assessment' and enabled),
  'selfDirectedPolicies',(select count(*) from exam_delivery.practice_policies
    where canonical_exam_key='pythonnextgeneration' and purpose='self_directed_exam' and enabled),
  'studySandboxPolicies',(select count(*) from exam_delivery.practice_policies
    where canonical_exam_key='pythonnextgeneration' and purpose='study_sandbox' and enabled),
  'targetedDomainPolicies',(select count(*) from exam_delivery.practice_policies
    where canonical_exam_key='pythonnextgeneration' and purpose='targeted_domain' and enabled),
  'weakAreaPolicies',(select count(*) from exam_delivery.practice_policies
    where canonical_exam_key='pythonnextgeneration' and purpose='weak_area' and enabled),
  'pbqPolicies',(select count(*) from exam_delivery.practice_policies
    where canonical_exam_key='pythonnextgeneration' and purpose='pbq_practice'),
  'policyAttemptLimitDrift',(select count(*) from exam_delivery.practice_policies
    where canonical_exam_key='pythonnextgeneration' and maximum_completed_attempts is not null),
  'resolvableProfiles',(select count(*) from unnest(array[
      'pythonnextgeneration-no-lab','pythonnextgeneration-lab'
    ]) requested(profile_key) where 1=(select count(*) from exam_delivery.resolve_package_profile_default(
      'pythonnextgeneration',requested.profile_key,'self_directed_exam'))),
  'catalogueRows',(select count(*) from public.exam_catalog where exam_key='pythonnextgeneration'),
  'releaseRequests',(select count(*) from exam_delivery.exam_release_configuration_requests request
    where request.package_version_id='${ids.pythonPackage}'),
  'attempts',(select count(*) from exam_delivery.attempts),
  'results',(select count(*) from exam_delivery.attempt_results),
  'publicAttempts',(select count(*) from public.exam_attempts)
)::text;

rollback;
`);

const marker = output.split(/\r?\n/).find((line) => line.startsWith('PLATFORM_OWNER_BYPASS_EVIDENCE:'));
assert.ok(marker, 'access correction evidence marker is missing');
const evidence = JSON.parse(marker.slice('PLATFORM_OWNER_BYPASS_EVIDENCE:'.length));

for (const [label, profileKey, releaseStage] of [
  ['noLabAcceptance', 'pythonnextgeneration-no-lab', 'acceptance'],
  ['labAcceptance', 'pythonnextgeneration-lab', 'acceptance'],
  ['noLabActive', 'pythonnextgeneration-no-lab', 'standard_active_exam_v1'],
  ['labActive', 'pythonnextgeneration-lab', 'standard_active_exam_v1'],
]) {
  assert.deepEqual(evidence.responses[label], {
    ok: true,
    configured: true,
    replayed: false,
    examKey: 'pythonnextgeneration',
    packageVersion: '1.0.0',
    profileKey,
    releaseStage,
  });
}

assert.deepEqual({
  owner: evidence.pythonOwnerProfiles,
  developer: evidence.pythonDeveloperProfiles,
  collegeAdmin: evidence.pythonCollegeAdminProfiles,
  campusAdmin: evidence.pythonCampusAdminProfiles,
  trainer: evidence.pythonTrainerProfiles,
  reception: evidence.pythonReceptionProfiles,
  unassignedStudent: evidence.pythonUnassignedProfiles,
  assignedStudent: evidence.pythonAssignedProfiles,
  purchaser: evidence.pythonPurchasedProfiles,
}, {
  owner: 2,
  developer: 0,
  collegeAdmin: 0,
  campusAdmin: 0,
  trainer: 0,
  reception: 0,
  unassignedStudent: 0,
  assignedStudent: 2,
  purchaser: 2,
});

assert.deepEqual({
  ownerAvailability: evidence.ownerAvailability,
  unassignedDenied: evidence.unassignedDenied,
  assignedAvailability: evidence.assignedAvailability,
  authoritativeStaffUnchanged: evidence.authoritativeStaffUnchanged,
  adminScopePreserved: evidence.adminScopePreserved,
  currentExamOwner: evidence.currentExamOwner,
  currentExamNonOwnerStaffDenied: evidence.currentExamNonOwnerStaffDenied,
  currentExamUnassignedDenied: evidence.currentExamUnassignedDenied,
  currentExamAssigned: evidence.currentExamAssigned,
}, {
  ownerAvailability: 2,
  unassignedDenied: 2,
  assignedAvailability: 2,
  authoritativeStaffUnchanged: 6,
  adminScopePreserved: true,
  currentExamOwner: true,
  currentExamNonOwnerStaffDenied: true,
  currentExamUnassignedDenied: true,
  currentExamAssigned: true,
});

assert.deepEqual({
  activations: evidence.activations,
  assignedDefaults: evidence.assignedDefaults,
  selfDirectedPolicies: evidence.selfDirectedPolicies,
  studySandboxPolicies: evidence.studySandboxPolicies,
  targetedDomainPolicies: evidence.targetedDomainPolicies,
  weakAreaPolicies: evidence.weakAreaPolicies,
  pbqPolicies: evidence.pbqPolicies,
  policyAttemptLimitDrift: evidence.policyAttemptLimitDrift,
  resolvableProfiles: evidence.resolvableProfiles,
  catalogueRows: evidence.catalogueRows,
  releaseRequests: evidence.releaseRequests,
}, {
  activations: 2,
  assignedDefaults: 2,
  selfDirectedPolicies: 2,
  studySandboxPolicies: 2,
  targetedDomainPolicies: 2,
  weakAreaPolicies: 2,
  pbqPolicies: 0,
  policyAttemptLimitDrift: 0,
  resolvableProfiles: 2,
  catalogueRows: 1,
  releaseRequests: 4,
});

assert.deepEqual({
  attempts: evidence.attempts,
  results: evidence.results,
  publicAttempts: evidence.publicAttempts,
}, preservedBefore);
assert.deepEqual(preservedEvidence(), preservedBefore);

console.log(JSON.stringify({
  ok: true,
  platformOwnerProfiles: evidence.pythonOwnerProfiles,
  deniedNonOwnerStaffRoles: 5,
  assignedStudentProfiles: evidence.pythonAssignedProfiles,
  purchaseEntitlementProfiles: evidence.pythonPurchasedProfiles,
  representativeCurrentExam: 'PASS',
  administrativeAccess: 'UNCHANGED',
  standardActiveSimulation: 'PASS',
  practicePolicies: 8,
  pbqPracticePolicies: 0,
  logicalCatalogueRows: evidence.catalogueRows,
  transactionRolledBack: true,
  productionMutations: 0,
}, null, 2));

function preservedEvidence() {
  return JSON.parse(scalar(`select json_build_object(
    'attempts',(select count(*) from exam_delivery.attempts),
    'results',(select count(*) from exam_delivery.attempt_results),
    'publicAttempts',(select count(*) from public.exam_attempts)
  )::text`));
}

function execute(sql) {
  return spawnSync(psql, ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-d', databaseUrl], {
    input: `${sql.trim()}\n`,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function run(sql) {
  const result = execute(sql);
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'psql failed');
  return result.stdout.trim();
}

function scalar(sql) {
  return run(sql).split(/\r?\n/).filter(Boolean).at(-1)?.trim() ?? '';
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}
