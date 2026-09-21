begin;
select plan(43);

select has_function('exam_delivery','staff_learner_detail',array['uuid','jsonb']);
select function_returns('exam_delivery','staff_learner_detail',array['uuid','jsonb'],'jsonb');
select has_function('public','certsim_protected_staff_learner_detail',array['uuid','jsonb']);
select is((select pg_get_userbyid(proowner) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='exam_delivery' and p.proname='staff_learner_detail'),'postgres','detail helper is postgres-owned');
select is((select prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='exam_delivery' and p.proname='staff_learner_detail'),true,'detail helper is security definer');
select is((select proconfig @> array['search_path=""','statement_timeout=15s'] from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='exam_delivery' and p.proname='staff_learner_detail'),true,'detail helper has empty path and bounded timeout');
select function_privs_are('exam_delivery','staff_learner_detail',array['uuid','jsonb'],'authenticated',array[]::text[],'browser cannot invoke private detail helper');
select function_privs_are('public','certsim_protected_staff_learner_detail',array['uuid','jsonb'],'authenticated',array[]::text[],'browser cannot invoke service wrapper');
select ok((select pg_get_functiondef('exam_delivery.staff_dashboard_query_issue59_base(uuid,jsonb)'::regprocedure)
  like '%exactLearnerId%'),'shared staff history accepts the private exact-learner selector');
select ok((select pg_get_functiondef('exam_delivery.staff_dashboard_query_issue59_base(uuid,jsonb)'::regprocedure)
  like '%a.source_organisation_id=v_org%'),'shared staff history binds assignment attribution to selected scope');
select ok((select pg_get_functiondef('exam_delivery.staff_dashboard_aggregates_issue101_base(uuid,jsonb)'::regprocedure)
  like '%attempt.source_organisation_id=v_org%'),'Issue 101 analytics bind assignment attribution to selected scope');

insert into auth.users(instance_id,id,aud,role,email,encrypted_password,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values
('00000000-0000-0000-0000-000000000000','15000000-0000-0000-0000-000000000001','authenticated','authenticated','owner-150@example.invalid','','{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','15000000-0000-0000-0000-000000000002','authenticated','authenticated','trainer-150@example.invalid','','{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','15000000-0000-0000-0000-000000000003','authenticated','authenticated','campus-150@example.invalid','','{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','15000000-0000-0000-0000-000000000004','authenticated','authenticated','college-150@example.invalid','','{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','15000000-0000-0000-0000-000000000010','authenticated','authenticated','learner-a-150@example.invalid','','{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','15000000-0000-0000-0000-000000000011','authenticated','authenticated','learner-b-150@example.invalid','','{}','{}',now(),now());
update public.profiles set status='active',display_name=case when id='15000000-0000-0000-0000-000000000010' then 'Learner A' else display_name end
where id::text like '15000000-%';

insert into public.organisations(id,name,organisation_type,status) values
('15000000-0000-0000-0000-000000000100','Issue 150 Org A','internal','active'),
('15000000-0000-0000-0000-000000000101','Issue 150 Org B','internal','active');
insert into public.campuses(id,organisation_id,name,code,status) values
('15000000-0000-0000-0000-000000000110','15000000-0000-0000-0000-000000000100','Campus A','150A','active'),
('15000000-0000-0000-0000-000000000111','15000000-0000-0000-0000-000000000100','Campus A2','15A2','active'),
('15000000-0000-0000-0000-000000000112','15000000-0000-0000-0000-000000000101','Campus B','150B','active');
insert into public.groups(id,organisation_id,campus_id,name,status) values
('15000000-0000-0000-0000-000000000120','15000000-0000-0000-0000-000000000100','15000000-0000-0000-0000-000000000110','Group A','active'),
('15000000-0000-0000-0000-000000000121','15000000-0000-0000-0000-000000000100','15000000-0000-0000-0000-000000000111','Group A2','active'),
('15000000-0000-0000-0000-000000000122','15000000-0000-0000-0000-000000000101','15000000-0000-0000-0000-000000000112','Group B','active');

insert into public.memberships(id,user_id,organisation_id,campus_id,group_id,role,status) values
('15000000-0000-0000-0000-000000000201','15000000-0000-0000-0000-000000000001','15000000-0000-0000-0000-000000000100',null,null,'platform_owner','active'),
('15000000-0000-0000-0000-000000000202','15000000-0000-0000-0000-000000000002','15000000-0000-0000-0000-000000000100','15000000-0000-0000-0000-000000000110','15000000-0000-0000-0000-000000000120','trainer','active'),
('15000000-0000-0000-0000-000000000203','15000000-0000-0000-0000-000000000003','15000000-0000-0000-0000-000000000100','15000000-0000-0000-0000-000000000110',null,'campus_admin','active'),
('15000000-0000-0000-0000-000000000204','15000000-0000-0000-0000-000000000004','15000000-0000-0000-0000-000000000100',null,null,'college_admin','active'),
('15000000-0000-0000-0000-000000000210','15000000-0000-0000-0000-000000000010','15000000-0000-0000-0000-000000000100','15000000-0000-0000-0000-000000000110','15000000-0000-0000-0000-000000000120','student','active'),
('15000000-0000-0000-0000-000000000211','15000000-0000-0000-0000-000000000010','15000000-0000-0000-0000-000000000101','15000000-0000-0000-0000-000000000112','15000000-0000-0000-0000-000000000122','student','active'),
('15000000-0000-0000-0000-000000000212','15000000-0000-0000-0000-000000000011','15000000-0000-0000-0000-000000000100','15000000-0000-0000-0000-000000000111','15000000-0000-0000-0000-000000000121','student','active'),
('15000000-0000-0000-0000-000000000213','15000000-0000-0000-0000-000000000011','15000000-0000-0000-0000-000000000100','15000000-0000-0000-0000-000000000110','15000000-0000-0000-0000-000000000120','student','suspended');

insert into exam_delivery.package_versions(
  id,exam_key,package_version,source_commit_sha,validation_hash,package_hash,
  package_schema_version,generator_version,scorer_version,created_at
) values (
  '15000000-0000-0000-0000-000000000250','az204','issue150-fixture',repeat('1',40),repeat('2',64),repeat('3',64),
  'certsim-protected-package-v2','issue150','issue150','2026-08-01 00:00Z'
);
insert into exam_delivery.package_profiles(
  id,package_version_id,profile_key,display_name,question_count,time_limit_minutes,selection_config
) values (
  '15000000-0000-0000-0000-000000000251','15000000-0000-0000-0000-000000000250',
  'full','Issue 150 fixture',1,60,'{}'
);
insert into exam_delivery.practice_policies(
  canonical_exam_key,package_version,profile_key,purpose,access_mode,enabled,
  maximum_completed_attempts,maximum_session_items,immediate_feedback,
  review_release_policy,answer_release_policy
)
select 'az204','issue150-fixture','full',purpose::exam_delivery.attempt_purpose,
  'production_authorized',true,null,40,purpose='study_sandbox',
  case when purpose='study_sandbox' then 'immediate_study_feedback' else 'after_submission' end,
  case when purpose='study_sandbox' then 'immediate_study_feedback' else 'after_submission' end
from unnest(array[
  'self_directed_exam','study_sandbox','targeted_domain','weak_area','pbq_practice'
]) purpose;

insert into public.exam_assignments(
  id,organisation_id,campus_id,group_id,exam_key,profile_id,title,assigned_by,
  assignment_type,status,available_from,due_at,created_at
) values
('15000000-0000-0000-0000-000000000230','15000000-0000-0000-0000-000000000100',
 '15000000-0000-0000-0000-000000000110','15000000-0000-0000-0000-000000000120',
 'az204','full','Scope A assessment','15000000-0000-0000-0000-000000000001',
 'assessment','active','2026-09-01 00:00Z','2026-09-30 00:00Z','2026-09-01 00:00Z'),
('15000000-0000-0000-0000-000000000231','15000000-0000-0000-0000-000000000101',
 '15000000-0000-0000-0000-000000000112','15000000-0000-0000-0000-000000000122',
 'az204','full','Scope B assessment','15000000-0000-0000-0000-000000000001',
 'assessment','active','2026-09-01 00:00Z','2026-09-30 00:00Z','2026-09-01 00:00Z');

-- One multi-membership learner owns attributed attempts in both scopes, one
-- personal assessment, and all four practice purposes. Scope A may see only
-- its attributed attempt plus the learner-personal formal evidence.
insert into exam_delivery.attempts(
  id,owner_id,package_version_id,package_profile_id,client_request_id,status,
  generator_version,scorer_version,created_at,started_at,expires_at,submitted_at,completed_at,purpose,
  source_assignment_id,source_organisation_id,source_campus_id,source_group_id
) values
('15000000-0000-0000-0000-000000000301','15000000-0000-0000-0000-000000000010','15000000-0000-0000-0000-000000000250','15000000-0000-0000-0000-000000000251','15000000-0000-0000-0000-000000000401','completed','issue150','issue150','2026-09-02 00:00Z','2026-09-02 00:00Z','2026-09-02 01:00Z','2026-09-02 00:30Z','2026-09-02 00:30Z','assigned_assessment','15000000-0000-0000-0000-000000000230','15000000-0000-0000-0000-000000000100','15000000-0000-0000-0000-000000000110','15000000-0000-0000-0000-000000000120'),
('15000000-0000-0000-0000-000000000302','15000000-0000-0000-0000-000000000010','15000000-0000-0000-0000-000000000250','15000000-0000-0000-0000-000000000251','15000000-0000-0000-0000-000000000402','completed','issue150','issue150','2026-09-04 00:00Z','2026-09-04 00:00Z','2026-09-04 01:00Z','2026-09-04 00:30Z','2026-09-04 00:30Z','assigned_assessment','15000000-0000-0000-0000-000000000231','15000000-0000-0000-0000-000000000101','15000000-0000-0000-0000-000000000112','15000000-0000-0000-0000-000000000122'),
('15000000-0000-0000-0000-000000000303','15000000-0000-0000-0000-000000000010','15000000-0000-0000-0000-000000000250','15000000-0000-0000-0000-000000000251','15000000-0000-0000-0000-000000000403','completed','issue150','issue150','2026-09-03 00:00Z','2026-09-03 00:00Z','2026-09-03 01:00Z','2026-09-03 00:30Z','2026-09-03 00:30Z','self_directed_exam',null,null,null,null),
('15000000-0000-0000-0000-000000000304','15000000-0000-0000-0000-000000000010','15000000-0000-0000-0000-000000000250','15000000-0000-0000-0000-000000000251','15000000-0000-0000-0000-000000000404','completed','issue150','issue150','2026-09-05 00:00Z','2026-09-05 00:00Z','2026-09-05 01:00Z','2026-09-05 00:30Z','2026-09-05 00:30Z','study_sandbox',null,null,null,null),
('15000000-0000-0000-0000-000000000305','15000000-0000-0000-0000-000000000010','15000000-0000-0000-0000-000000000250','15000000-0000-0000-0000-000000000251','15000000-0000-0000-0000-000000000405','completed','issue150','issue150','2026-09-06 00:00Z','2026-09-06 00:00Z','2026-09-06 01:00Z','2026-09-06 00:30Z','2026-09-06 00:30Z','targeted_domain',null,null,null,null),
('15000000-0000-0000-0000-000000000306','15000000-0000-0000-0000-000000000010','15000000-0000-0000-0000-000000000250','15000000-0000-0000-0000-000000000251','15000000-0000-0000-0000-000000000406','completed','issue150','issue150','2026-09-07 00:00Z','2026-09-07 00:00Z','2026-09-07 01:00Z','2026-09-07 00:30Z','2026-09-07 00:30Z','weak_area',null,null,null,null),
('15000000-0000-0000-0000-000000000307','15000000-0000-0000-0000-000000000010','15000000-0000-0000-0000-000000000250','15000000-0000-0000-0000-000000000251','15000000-0000-0000-0000-000000000407','completed','issue150','issue150','2026-09-08 00:00Z','2026-09-08 00:00Z','2026-09-08 01:00Z','2026-09-08 00:30Z','2026-09-08 00:30Z','pbq_practice',null,null,null,null);

insert into exam_delivery.attempt_results(
  attempt_id,submission_id,response_hash,scorer_version,raw_score,max_score,raw_percentage,passed,
  domain_summary,submitted_at,completed_at
) values
('15000000-0000-0000-0000-000000000301','15000000-0000-0000-0000-000000000501',repeat('a',64),'issue150',80,100,80,true,'{"scope-a":{"domain":"Scope A","earnedPoints":80,"maxPoints":100,"percentage":80}}','2026-09-02 00:30Z','2026-09-02 00:30Z'),
('15000000-0000-0000-0000-000000000302','15000000-0000-0000-0000-000000000502',repeat('b',64),'issue150',95,100,95,true,'{"scope-b":{"domain":"Scope B","earnedPoints":95,"maxPoints":100,"percentage":95}}','2026-09-04 00:30Z','2026-09-04 00:30Z'),
('15000000-0000-0000-0000-000000000303','15000000-0000-0000-0000-000000000503',repeat('c',64),'issue150',60,100,60,false,'{"self":{"domain":"Self directed","earnedPoints":60,"maxPoints":100,"percentage":60}}','2026-09-03 00:30Z','2026-09-03 00:30Z'),
('15000000-0000-0000-0000-000000000304','15000000-0000-0000-0000-000000000504',repeat('d',64),'issue150',10,100,10,false,'{}','2026-09-05 00:30Z','2026-09-05 00:30Z'),
('15000000-0000-0000-0000-000000000305','15000000-0000-0000-0000-000000000505',repeat('e',64),'issue150',20,100,20,false,'{}','2026-09-06 00:30Z','2026-09-06 00:30Z'),
('15000000-0000-0000-0000-000000000306','15000000-0000-0000-0000-000000000506',repeat('f',64),'issue150',30,100,30,false,'{}','2026-09-07 00:30Z','2026-09-07 00:30Z'),
('15000000-0000-0000-0000-000000000307','15000000-0000-0000-0000-000000000507',repeat('0',64),'issue150',40,100,40,false,'{}','2026-09-08 00:30Z','2026-09-08 00:30Z');

insert into public.exam_attempts(
  id,user_id,exam_key,exam_version,profile_id,mode_label,status,started_at,submitted_at
) values (
  '15000000-0000-0000-0000-000000000308','15000000-0000-0000-0000-000000000010',
  'az204','legacy','full','Full exam','submitted','2026-09-01 00:00Z','2026-09-01 00:30Z'
);
insert into public.exam_results(
  attempt_id,user_id,exam_key,profile_id,scoring_engine_version,raw_score,raw_percentage,passed,domain_breakdown
) values (
  '15000000-0000-0000-0000-000000000308','15000000-0000-0000-0000-000000000010',
  'az204','full','legacy',70,70,false,'{"legacy":{"domain":"Legacy","percentage":70}}'
);

create temp table issue150_before as select
  (select count(*) from exam_delivery.attempts) attempts,
  (select count(*) from exam_delivery.attempt_responses) responses,
  (select count(*) from exam_delivery.attempt_results) results,
  (select count(*) from exam_delivery.review_snapshots) reviews;

create temp table issue150_owner_a as select exam_delivery.staff_learner_detail(
  '15000000-0000-0000-0000-000000000001','{"membershipId":"15000000-0000-0000-0000-000000000210","organisationId":"15000000-0000-0000-0000-000000000100"}') value;
create temp table issue150_owner_b as select exam_delivery.staff_learner_detail(
  '15000000-0000-0000-0000-000000000001','{"membershipId":"15000000-0000-0000-0000-000000000211","organisationId":"15000000-0000-0000-0000-000000000101"}') value;
create temp table issue150_parent_a as select exam_delivery.staff_dashboard_query(
  '15000000-0000-0000-0000-000000000001','{"organisationId":"15000000-0000-0000-0000-000000000100","campusId":"15000000-0000-0000-0000-000000000110","groupId":"15000000-0000-0000-0000-000000000120","workflow":"results","pageSize":25}') value;
create temp table issue150_page_one as select exam_delivery.staff_learner_detail(
  '15000000-0000-0000-0000-000000000001','{"membershipId":"15000000-0000-0000-0000-000000000210","organisationId":"15000000-0000-0000-0000-000000000100","pageSize":1}') value;
create temp table issue150_page_two as select exam_delivery.staff_learner_detail(
  '15000000-0000-0000-0000-000000000001',jsonb_build_object(
    'membershipId','15000000-0000-0000-0000-000000000210',
    'organisationId','15000000-0000-0000-0000-000000000100',
    'pageSize',1,
    'cursor',(select value#>>'{history,nextCursor}' from issue150_page_one)
  )) value;
select is((select value->>'ok' from issue150_owner_a),'true','Platform Owner opens a visible learner in selected organisation');
select is((select value#>>'{learner,membershipId}' from issue150_owner_a),'15000000-0000-0000-0000-000000000210','detail returns exact selected membership identity');
select is((select value#>>'{selection,groupId}' from issue150_owner_a),'15000000-0000-0000-0000-000000000120','broad owner scope binds detail to exact membership group');
select is((select value->>'code' from (select exam_delivery.staff_learner_detail(
  '15000000-0000-0000-0000-000000000001','{"membershipId":"15000000-0000-0000-0000-000000000211","organisationId":"15000000-0000-0000-0000-000000000100"}') value) denied),'not_visible','Platform Owner cross-organisation route swap is denied');

select is((select value->>'ok' from (select exam_delivery.staff_learner_detail(
  '15000000-0000-0000-0000-000000000002','{"membershipId":"15000000-0000-0000-0000-000000000210"}') value) allowed),'true','Trainer opens learner in assigned group');
select is((select value->>'code' from (select exam_delivery.staff_learner_detail(
  '15000000-0000-0000-0000-000000000002','{"membershipId":"15000000-0000-0000-0000-000000000212"}') value) denied),'not_visible','Trainer cannot open another group membership');
select is((select value->>'ok' from (select exam_delivery.staff_learner_detail(
  '15000000-0000-0000-0000-000000000003','{"membershipId":"15000000-0000-0000-0000-000000000210"}') value) allowed),'true','Campus Admin opens learner in locked campus');
select is((select value->>'code' from (select exam_delivery.staff_learner_detail(
  '15000000-0000-0000-0000-000000000003','{"membershipId":"15000000-0000-0000-0000-000000000212"}') value) denied),'not_visible','Campus Admin cannot open learner outside locked campus');
select is((select value->>'ok' from (select exam_delivery.staff_learner_detail(
  '15000000-0000-0000-0000-000000000004','{"membershipId":"15000000-0000-0000-0000-000000000210"}') value) allowed),'true','College Admin opens learner in locked organisation');
select is((select value->>'code' from (select exam_delivery.staff_learner_detail(
  '15000000-0000-0000-0000-000000000004','{"membershipId":"15000000-0000-0000-0000-000000000211","organisationId":"15000000-0000-0000-0000-000000000101"}') value) denied),'not_visible','College Admin cannot override locked organisation');
select is((select value->>'code' from (select exam_delivery.staff_learner_detail(
  '15000000-0000-0000-0000-000000000001','{"membershipId":"15000000-0000-0000-0000-000000000213","organisationId":"15000000-0000-0000-0000-000000000100"}') value) denied),'not_visible','non-active membership route is safely unavailable');
select is((select value#>>'{learner,membershipId}' from (select exam_delivery.staff_learner_detail(
  '15000000-0000-0000-0000-000000000001','{"membershipId":"15000000-0000-0000-0000-000000000211","organisationId":"15000000-0000-0000-0000-000000000101"}') value) exact),'15000000-0000-0000-0000-000000000211','multi-membership user resolves requested membership rather than first membership');
select is((select value#>>'{learner,groupId}' from (select exam_delivery.staff_learner_detail(
  '15000000-0000-0000-0000-000000000001','{"membershipId":"15000000-0000-0000-0000-000000000211","organisationId":"15000000-0000-0000-0000-000000000101"}') value) exact),'15000000-0000-0000-0000-000000000122','multi-membership detail retains exact group context');
select is((select value->>'code' from (select exam_delivery.staff_learner_detail(
  '15000000-0000-0000-0000-000000000001','{"membershipId":"15000000-0000-0000-0000-000000000211","organisationId":"15000000-0000-0000-0000-000000000101","groupId":"15000000-0000-0000-0000-000000000120"}') value) denied),'not_visible','route identity and group tampering cannot cross scope');
select is((select (value#>>'{learnerPage,returnedCount}')::integer from issue150_owner_a),1,'exact detail is independent of dashboard page-one pagination');
select is((select (value#>>'{history,returnedCount}')::integer from issue150_owner_a),3,'history is non-empty, bounded, and learner-specific');

select is((select jsonb_agg(item->>'attemptId' order by item->>'attemptId') from issue150_owner_a
  cross join lateral jsonb_array_elements(value#>'{history,items}') item),
  '["15000000-0000-0000-0000-000000000301","15000000-0000-0000-0000-000000000303","15000000-0000-0000-0000-000000000308"]'::jsonb,
  'membership A history has the exact A-assigned, self-directed, and classified legacy set');
select is((select count(*)::integer from issue150_owner_a cross join lateral jsonb_array_elements(value#>'{history,items}') item
  where item->>'attemptId'='15000000-0000-0000-0000-000000000302'),0,'membership A never renders the scope B assigned attempt');
select is((select count(*)::integer from issue150_owner_a cross join lateral jsonb_array_elements(value#>'{history,items}') item
  where item->>'attemptId' in ('15000000-0000-0000-0000-000000000304','15000000-0000-0000-0000-000000000305','15000000-0000-0000-0000-000000000306','15000000-0000-0000-0000-000000000307')),0,
  'all four practice-purpose results stay out of staff learner detail');
select ok((select bool_and((item->>'analyticsEligible')::boolean and item->>'purpose' in ('assigned_assessment','self_directed_exam'))
  from issue150_owner_a cross join lateral jsonb_array_elements(value#>'{history,items}') item),
  'every rendered detail result is analytics-eligible formal evidence');
select is((select jsonb_agg(item->>'attemptId' order by item->>'attemptId') from issue150_parent_a
  cross join lateral jsonb_array_elements(value#>'{history,items}') item),
  (select jsonb_agg(item->>'attemptId' order by item->>'attemptId') from issue150_owner_a
    cross join lateral jsonb_array_elements(value#>'{history,items}') item),
  'parent Training Dashboard and learner detail return identical attempt identity sets');
select is((select (value#>>'{learnerPage,items,0,analytics,activityCount}')::integer from issue150_owner_a),3,
  'membership A analytics count excludes scope B and all practice attempts');
select is((select value#>>'{learnerPage,items,0,analytics,latestAttemptId}' from issue150_owner_a),
  '15000000-0000-0000-0000-000000000303','hidden scope B and practice attempts cannot become latest analytics activity');
select is((select jsonb_agg(item->>'attemptId' order by item->>'attemptId') from issue150_owner_b
  cross join lateral jsonb_array_elements(value#>'{history,items}') item),
  '["15000000-0000-0000-0000-000000000302","15000000-0000-0000-0000-000000000303","15000000-0000-0000-0000-000000000308"]'::jsonb,
  'membership B history has its own attributed attempt and excludes scope A');
select is((select (value#>>'{history,returnedCount}')::integer from (select exam_delivery.staff_learner_detail(
  '15000000-0000-0000-0000-000000000001','{"membershipId":"15000000-0000-0000-0000-000000000210","organisationId":"15000000-0000-0000-0000-000000000100","resultStatus":"passed"}') value) filtered),1,
  'result-status filtering is preserved on corrected history');
select is((select (value#>>'{history,returnedCount}')::integer from (select exam_delivery.staff_learner_detail(
  '15000000-0000-0000-0000-000000000001','{"membershipId":"15000000-0000-0000-0000-000000000210","organisationId":"15000000-0000-0000-0000-000000000100","examKey":"ai901"}') value) filtered),0,
  'exam filtering is preserved on corrected history');
select is((select jsonb_build_array(value#>>'{history,items,0,attemptId}',(value#>>'{history,remainingCount}')::integer,value#>>'{history,nextCursor}' is not null) from issue150_page_one),
  '["15000000-0000-0000-0000-000000000303",2,true]'::jsonb,
  'first corrected-history page is deterministic and reports a bounded cursor');
select is((select jsonb_build_array(value#>>'{history,items,0,attemptId}',(value#>>'{history,remainingCount}')::integer) from issue150_page_two),
  '["15000000-0000-0000-0000-000000000301",1]'::jsonb,
  'corrected-history cursor advances without crossing learner or assignment scope');

select is((select count(*) from exam_delivery.attempts),(select attempts from issue150_before),'detail reads do not mutate attempts');
select is((select count(*) from exam_delivery.attempt_responses),(select responses from issue150_before),'detail reads do not mutate responses');
select is((select count(*) from exam_delivery.attempt_results),(select results from issue150_before),'detail reads do not mutate results');
select is((select count(*) from exam_delivery.review_snapshots),(select reviews from issue150_before),'detail reads do not mutate reviews');

select * from finish();
rollback;
