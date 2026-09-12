import { createClient } from '@supabase/supabase-js';
import { spawnSync } from 'node:child_process';

const url = required('SUPABASE_URL');
const serviceKey = required('SUPABASE_SERVICE_ROLE_KEY');
const databaseUrl = required('SUPABASE_DB_URL');
const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

const actors = Object.fromEntries(await Promise.all(
  ['developer', 'owner', 'administrator', 'campus-administrator', 'trainer', 'reception', 'student-granted', 'student-ungranted', 'student-other', 'basic', 'purchaser', 'expired-purchaser']
    .map(async (label) => [label, await createUser(label)]),
));
const organisationId = crypto.randomUUID();
const otherOrganisationId = crypto.randomUUID();
const campusId = crypto.randomUUID();
const groupId = crypto.randomUUID();
const aiV1PackageId = crypto.randomUUID();
const aiV1CompactProfileId = crypto.randomUUID();
const aiV1FullProfileId = crypto.randomUUID();
const aiV2PackageId = crypto.randomUUID();
const aiV2CompactProfileId = crypto.randomUUID();
const aiV2FullProfileId = crypto.randomUUID();

sql(`
  insert into public.organisations(id,name,organisation_type,status) values
    ('${organisationId}','Access fixture organisation','internal','active'),
    ('${otherOrganisationId}','Cross-scope fixture organisation','internal','active');
  insert into public.campuses(id,organisation_id,name,code,status) values
    ('${campusId}','${organisationId}','Access fixture campus','ACCESS','active');
  insert into public."groups"(id,organisation_id,campus_id,name,status) values
    ('${groupId}','${organisationId}','${campusId}','Access fixture group','active');
  insert into public.memberships(user_id,organisation_id,campus_id,group_id,role,status) values
    ('${actors.owner.id}','${organisationId}',null,null,'platform_owner','active'),
    ('${actors.developer.id}','${organisationId}',null,null,'developer','active'),
    ('${actors.administrator.id}','${organisationId}',null,null,'college_admin','active'),
    ('${actors['campus-administrator'].id}','${organisationId}','${campusId}',null,'campus_admin','active'),
    ('${actors.trainer.id}','${organisationId}','${campusId}','${groupId}','trainer','active'),
    ('${actors.reception.id}','${organisationId}','${campusId}',null,'reception','active'),
    ('${actors['student-granted'].id}','${organisationId}','${campusId}','${groupId}','student','active'),
    ('${actors['student-ungranted'].id}','${organisationId}','${campusId}','${groupId}','student','active'),
    ('${actors['student-other'].id}','${otherOrganisationId}',null,null,'student','active');

  -- Content-free structural fixture for the immutable v1 compatibility
  -- boundary. Commercial presentation and protected payloads are unnecessary
  -- for these authorization/history assertions and remain outside this repo.
  insert into exam_delivery.package_versions(
    id,exam_key,package_version,source_commit_sha,validation_hash,package_hash,
    package_schema_version,generator_version,scorer_version
  ) values (
    '${aiV1PackageId}','ai901','1.0.0','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    'certsim-protected-package-v1','integration-generator','integration-scorer'
  );
  insert into exam_delivery.package_profiles(
    id,package_version_id,profile_key,display_name,question_count,time_limit_minutes
  ) values
    ('${aiV1CompactProfileId}','${aiV1PackageId}','ai901-controlled-beta-compact','AI fixture compact',25,25),
    ('${aiV1FullProfileId}','${aiV1PackageId}','ai901-controlled-beta-full','AI fixture full',50,50);
  update exam_delivery.package_versions set status='published',published_at=now()
    where id='${aiV1PackageId}';

  insert into exam_delivery.package_versions(
    id,exam_key,package_version,source_commit_sha,validation_hash,package_hash,
    package_schema_version,generator_version,scorer_version
  ) values (
    '${aiV2PackageId}','ai901','2.0.0','dddddddddddddddddddddddddddddddddddddddd',
    'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    'certsim-protected-package-v2','integration-generator','integration-scorer'
  );
  insert into exam_delivery.package_profiles(
    id,package_version_id,profile_key,display_name,question_count,time_limit_minutes
  ) values
    ('${aiV2CompactProfileId}','${aiV2PackageId}','ai901-controlled-beta-compact','AI fixture compact',25,25),
    ('${aiV2FullProfileId}','${aiV2PackageId}','ai901-controlled-beta-full','AI fixture full',50,50);
  update exam_delivery.package_versions set status='published',published_at=now()
    where id='${aiV2PackageId}';
  update exam_delivery.pilot_gates set enabled=true,enabled_at=now(),disabled_at=null where exam_key='ai-901';
  insert into exam_delivery.pilot_access(user_id,exam_key,enabled,access_starts_at)
    values ('${actors['student-granted'].id}','ai-901',true,now()-interval '1 minute');
  insert into exam_delivery.exam_profile_activations(
    package_version_id,package_profile_id,enabled,activation_kind,enabled_at,created_by
  ) values
    ('${aiV2PackageId}','${aiV2CompactProfileId}',true,'production',now(),'${actors.owner.id}'),
    ('${aiV2PackageId}','${aiV2FullProfileId}',true,'production',now(),'${actors.owner.id}');
  insert into exam_delivery.exam_entitlements(
    package_version_id,package_profile_id,target_type,learner_id,enabled,valid_from,reason_code,created_by
  ) values (
    '${aiV2PackageId}','${aiV2CompactProfileId}','learner','${actors['student-granted'].id}',
    true,now()-interval '1 minute','integration_fixture','${actors.owner.id}'
  );

  -- The historical dispatcher still recognizes the exact AI-901 v1 pilot
  -- and reaches its unchanged assignment boundary.
  select 1/((exam_delivery.check_eligibility(
    '${actors['student-granted'].id}','ai-901','ai901-controlled-beta-full'
  )->>'reasonCode'='not_assigned')::integer);
  select 1/((public.certsim_protected_check_profile_eligibility(
    '${actors['student-granted'].id}','ai-901','1.0.0','ai901-controlled-beta-full','assigned_assessment'
  )->>'reasonCode'='not_assigned')::integer);

  -- That same legacy row cannot authorize v2: exact activation plus exact
  -- package/profile entitlement is required for a student.
  select 1/((public.certsim_protected_check_profile_eligibility(
    '${actors['student-granted'].id}','ai-901','2.0.0','ai901-controlled-beta-compact','self_directed_exam'
  )->>'eligible')::boolean::integer);
  select 1/((not (public.certsim_protected_check_profile_eligibility(
    '${actors['student-granted'].id}','ai-901','2.0.0','ai901-controlled-beta-full','self_directed_exam'
  )->>'eligible')::boolean)::integer);
  select 1/((not (public.certsim_protected_check_profile_eligibility(
    '${actors['student-ungranted'].id}','ai-901','2.0.0','ai901-controlled-beta-compact','self_directed_exam'
  )->>'eligible')::boolean)::integer);
  select 1/((public.certsim_protected_check_profile_eligibility(
    '${actors.owner.id}','ai-901','2.0.0','ai901-controlled-beta-full','self_directed_exam'
  )->>'eligible')::boolean::integer);
  select 1/((not (public.certsim_protected_check_profile_eligibility(
    '${actors['student-granted'].id}','ai-901','9.9.9','ai901-controlled-beta-compact','self_directed_exam'
  )->>'eligible')::boolean)::integer);
  select 1/((not (public.certsim_protected_check_profile_eligibility(
    '${actors['student-granted'].id}','az204','2.0.0','ai901-controlled-beta-compact','self_directed_exam'
  )->>'eligible')::boolean)::integer);
  select 1/((count(*)=0)::integer) from exam_delivery.attempts
    where owner_id in ('${actors['student-granted'].id}','${actors['student-ungranted'].id}','${actors.owner.id}');

  select 1/((not exam_delivery.can_use_profile('${actors.owner.id}',pv.id,pp.id,'self_directed_exam'))::integer)
    from exam_delivery.package_versions pv join exam_delivery.package_profiles pp on pp.package_version_id=pv.id
    where pv.exam_key='ai901' and pv.package_version='1.0.0' limit 1;

  insert into exam_delivery.exam_profile_activations(package_version_id,package_profile_id,enabled,activation_kind,enabled_at,created_by)
  select pv.id,pp.id,true,'production',now(),'${actors.owner.id}'
  from exam_delivery.package_versions pv join exam_delivery.package_profiles pp on pp.package_version_id=pv.id
  where pv.exam_key='ai901' and pv.package_version='1.0.0';

  select 1/(bool_and(exam_delivery.can_use_profile('${actors.owner.id}',pv.id,pp.id,'self_directed_exam'))::integer)
    from exam_delivery.package_versions pv join exam_delivery.package_profiles pp on pp.package_version_id=pv.id
    where pv.exam_key='ai901' and pv.package_version='1.0.0';
  select 1/(bool_and(exam_delivery.can_use_profile('${actors.developer.id}',pv.id,pp.id,'self_directed_exam'))::integer)
    from exam_delivery.package_versions pv join exam_delivery.package_profiles pp on pp.package_version_id=pv.id
    where pv.exam_key='ai901' and pv.package_version='1.0.0';
  select 1/(bool_and(exam_delivery.can_use_profile('${actors.administrator.id}',pv.id,pp.id,'self_directed_exam'))::integer)
    from exam_delivery.package_versions pv join exam_delivery.package_profiles pp on pp.package_version_id=pv.id
    where pv.exam_key='ai901' and pv.package_version='1.0.0';
  select 1/(bool_and(exam_delivery.can_use_profile('${actors.trainer.id}',pv.id,pp.id,'self_directed_exam'))::integer)
    from exam_delivery.package_versions pv join exam_delivery.package_profiles pp on pp.package_version_id=pv.id
    where pv.exam_key='ai901' and pv.package_version='1.0.0';
  select 1/(bool_and(exam_delivery.can_use_profile('${actors['campus-administrator'].id}',pv.id,pp.id,'self_directed_exam'))::integer)
    from exam_delivery.package_versions pv join exam_delivery.package_profiles pp on pp.package_version_id=pv.id
    where pv.exam_key='ai901' and pv.package_version='1.0.0';
  select 1/(bool_and(exam_delivery.can_use_profile('${actors.reception.id}',pv.id,pp.id,'self_directed_exam'))::integer)
    from exam_delivery.package_versions pv join exam_delivery.package_profiles pp on pp.package_version_id=pv.id
    where pv.exam_key='ai901' and pv.package_version='1.0.0';
  select 1/((not exists(select 1 from exam_delivery.package_versions pv join exam_delivery.package_profiles pp on pp.package_version_id=pv.id
    where pv.exam_key='ai901' and pv.package_version='1.0.0' and exam_delivery.can_use_profile('${actors['student-ungranted'].id}',pv.id,pp.id,'self_directed_exam')))::integer);
  select 1/((not exists(select 1 from exam_delivery.package_versions pv join exam_delivery.package_profiles pp on pp.package_version_id=pv.id
    where pv.exam_key='ai901' and pv.package_version='1.0.0' and exam_delivery.can_use_profile('${actors.basic.id}',pv.id,pp.id,'self_directed_exam')))::integer);
  select 1/((not exists(select 1 from exam_delivery.package_versions pv join exam_delivery.package_profiles pp on pp.package_version_id=pv.id
    where pv.exam_key='ai901' and pv.package_version='1.0.0' and exam_delivery.can_use_profile(null,pv.id,pp.id,'self_directed_exam')))::integer);

  insert into exam_delivery.exam_entitlements(package_version_id,package_profile_id,target_type,organisation_id,enabled,valid_from,reason_code,created_by)
  select pv.id,pp.id,'organisation','${organisationId}',true,now()-interval '1 minute','integration_fixture','${actors.owner.id}'
  from exam_delivery.package_versions pv join exam_delivery.package_profiles pp on pp.package_version_id=pv.id
  where pv.exam_key='ai901' and pv.package_version='1.0.0';
  select 1/(bool_and(exam_delivery.can_use_profile('${actors['student-granted'].id}',pv.id,pp.id,'self_directed_exam'))::integer)
    from exam_delivery.package_versions pv join exam_delivery.package_profiles pp on pp.package_version_id=pv.id
    where pv.exam_key='ai901' and pv.package_version='1.0.0';
  select 1/((not exists(select 1 from exam_delivery.package_versions pv join exam_delivery.package_profiles pp on pp.package_version_id=pv.id
    where pv.exam_key='ai901' and pv.package_version='1.0.0' and exam_delivery.can_use_profile('${actors['student-other'].id}',pv.id,pp.id,'self_directed_exam')))::integer);

  insert into exam_delivery.exam_entitlements(
    package_version_id,package_profile_id,target_type,learner_id,enabled,valid_from,valid_until,
    reason_code,created_by,entitlement_source,purchase_reference
  ) values
    ('${aiV2PackageId}','${aiV2CompactProfileId}','learner','${actors.purchaser.id}',true,now()-interval '1 minute',null,
      'purchase_fixture','${actors.owner.id}','direct_exam_purchase','purchase:direct:fixture'),
    ('${aiV2PackageId}','${aiV2CompactProfileId}','learner','${actors['expired-purchaser'].id}',true,now()-interval '2 days',now()-interval '1 day',
      'purchase_fixture','${actors.owner.id}','package_purchase','purchase:expired:fixture');
  select 1/((exam_delivery.can_use_profile('${actors.purchaser.id}','${aiV2PackageId}','${aiV2CompactProfileId}','self_directed_exam'))::integer);
  select 1/((not exam_delivery.can_use_profile('${actors.purchaser.id}','${aiV2PackageId}','${aiV2FullProfileId}','self_directed_exam'))::integer);
  select 1/((not exam_delivery.can_use_profile('${actors['expired-purchaser'].id}','${aiV2PackageId}','${aiV2CompactProfileId}','self_directed_exam'))::integer);

  select 1/((exam_delivery.classify_actor('${actors.owner.id}')='staff')::integer);
  select 1/((exam_delivery.classify_actor('${actors.developer.id}')='staff')::integer);
  select 1/((exam_delivery.classify_actor('${actors.administrator.id}')='staff')::integer);
  select 1/((exam_delivery.classify_actor('${actors.trainer.id}')='staff')::integer);
  select 1/((exam_delivery.classify_actor('${actors.reception.id}')='staff')::integer);
  select 1/((exam_delivery.classify_actor('${actors['student-granted'].id}')='student')::integer);
  select 1/((exam_delivery.classify_actor('${actors.basic.id}')='basic')::integer);
  select 1/((exam_delivery.classify_actor(null)='unclassified')::integer);
  select 1/((exam_delivery.staff_can_view_learner('${actors.trainer.id}','${actors['student-granted'].id}'))::integer);
  select 1/((not exam_delivery.staff_can_view_learner('${actors.trainer.id}','${actors['student-other'].id}'))::integer);
  select 1/((exam_delivery.staff_can_view_learner('${actors.developer.id}','${actors['student-other'].id}'))::integer);
  select 1/((exam_delivery.staff_can_view_learner('${actors.administrator.id}','${actors['student-granted'].id}'))::integer);
  select 1/((not exam_delivery.staff_can_view_learner('${actors.administrator.id}','${actors['student-other'].id}'))::integer);
  select 1/((exam_delivery.staff_can_view_learner('${actors['campus-administrator'].id}','${actors['student-granted'].id}'))::integer);
  select 1/((not exam_delivery.staff_can_view_learner('${actors.reception.id}','${actors['student-granted'].id}'))::integer);
  select 1/((count(*)=0)::integer) from exam_delivery.exam_preview_authorizations;
`);

console.log(JSON.stringify({ ok: true, rolesChecked: 12, purchaseSourcesChecked: 2, crossOrganisationDenied: true, seededProductionAccess: false }));

async function createUser(label) {
  const response = await admin.auth.admin.createUser({
    email: `${label}-${crypto.randomUUID()}@example.test`,
    password: `Synthetic-${crypto.randomUUID()}!`,
    email_confirm: true,
  });
  if (response.error || !response.data.user) throw new Error('FIXTURE_USER_CREATION_FAILED');
  return response.data.user;
}

function sql(statement) {
  const result = spawnSync('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-Atc', statement], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`DATABASE_ASSERTION_FAILED:${result.stderr.trim()}`);
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`MISSING_${name}`);
  return value;
}
