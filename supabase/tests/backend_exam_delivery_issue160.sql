begin;
select plan(49);

select has_function('exam_delivery','weak_domain_evidence_for_practice',array['uuid','uuid']);
select is((select pg_get_userbyid(proowner) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='weak_domain_evidence_for_practice'),'postgres','practice evidence helper is postgres-owned');
select is((select provolatile from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='weak_domain_evidence_for_practice'),'s','practice evidence helper is stable');
select is((select prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='weak_domain_evidence_for_practice'),true,'practice evidence helper is a definer boundary');
select is((select proconfig @> array['search_path=""','statement_timeout=8s'] from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='weak_domain_evidence_for_practice'),true,'practice evidence helper has an empty path and bounded timeout');
select function_privs_are('exam_delivery','weak_domain_evidence_for_practice',array['uuid','uuid'],'public',array[]::text[],'PUBLIC cannot invoke private practice evidence');
select function_privs_are('exam_delivery','weak_domain_evidence_for_practice',array['uuid','uuid'],'anon',array[]::text[],'anonymous cannot invoke private practice evidence');
select function_privs_are('exam_delivery','weak_domain_evidence_for_practice',array['uuid','uuid'],'authenticated',array[]::text[],'browser cannot invoke private practice evidence');
select function_privs_are('exam_delivery','weak_domain_evidence_for_practice',array['uuid','uuid'],'service_role',array[]::text[],'Edge cannot invoke the helper directly');
select ok((select pg_get_functiondef(p.oid) ~ 'weak_domain_evidence_for_practice' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='weak_area_options'),'Weak Area discovery uses unified practice evidence');
select ok((select pg_get_functiondef(p.oid) ~ 'weak_domain_evidence_for_practice' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='practice_availability'),'Weak Area availability uses unified practice evidence');
select ok((select pg_get_functiondef(p.oid) !~ 'learner_weak_domain_evidence\(' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='practice_availability'),'availability has no stale learner-only evidence call');
select ok((select pg_get_functiondef(p.oid) ~ 'weak_domain_evidence_for_practice' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='materialize_attempt_items_issue21_unrotated_base'),'Weak Area materializer uses unified practice evidence');
select ok((select pg_get_functiondef(p.oid) !~ 'learner_weak_domain_evidence\(' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='materialize_attempt_items_issue21_unrotated_base'),'materializer has no stale learner-only evidence call');
select ok((select pg_get_functiondef(p.oid) ~ 'analytics_eligible is true' and pg_get_functiondef(p.oid) ~ 'assigned_assessment.*self_directed_exam' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='learner_weak_domain_evidence'),'learner evidence authority remains analytics-eligible and formal-only');

insert into auth.users(instance_id,id,aud,role,email,encrypted_password,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values
('00000000-0000-0000-0000-000000000000','16000000-0000-0000-0000-000000000001','authenticated','authenticated','owner-a-160@example.invalid','','{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','16000000-0000-0000-0000-000000000002','authenticated','authenticated','owner-b-160@example.invalid','','{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','16000000-0000-0000-0000-000000000003','authenticated','authenticated','student-160@example.invalid','','{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','16000000-0000-0000-0000-000000000004','authenticated','authenticated','student-practice-160@example.invalid','','{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','16000000-0000-0000-0000-000000000005','authenticated','authenticated','developer-160@example.invalid','','{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','16000000-0000-0000-0000-000000000006','authenticated','authenticated','trainer-160@example.invalid','','{}','{}',now(),now());
update public.profiles set status='active' where id::text like '16000000-%';

insert into public.organisations(id,name,organisation_type,status)
values('16000000-0000-0000-0000-000000000010','Issue 160 isolation fixture','internal','active');
insert into public.campuses(id,organisation_id,name,code,status)
values('16000000-0000-0000-0000-000000000011','16000000-0000-0000-0000-000000000010','Issue 160 campus','I160','active');
insert into public."groups"(id,organisation_id,campus_id,name,status)
values('16000000-0000-0000-0000-000000000012','16000000-0000-0000-0000-000000000010','16000000-0000-0000-0000-000000000011','Issue 160 group','active');
insert into public.memberships(user_id,organisation_id,campus_id,group_id,role,status) values
('16000000-0000-0000-0000-000000000001','16000000-0000-0000-0000-000000000010',null,null,'platform_owner','active'),
('16000000-0000-0000-0000-000000000002','16000000-0000-0000-0000-000000000010',null,null,'platform_owner','active'),
('16000000-0000-0000-0000-000000000003','16000000-0000-0000-0000-000000000010','16000000-0000-0000-0000-000000000011','16000000-0000-0000-0000-000000000012','student','active'),
('16000000-0000-0000-0000-000000000004','16000000-0000-0000-0000-000000000010','16000000-0000-0000-0000-000000000011','16000000-0000-0000-0000-000000000012','student','active'),
('16000000-0000-0000-0000-000000000005','16000000-0000-0000-0000-000000000010',null,null,'developer','active'),
('16000000-0000-0000-0000-000000000006','16000000-0000-0000-0000-000000000010','16000000-0000-0000-0000-000000000011','16000000-0000-0000-0000-000000000012','trainer','active');

insert into exam_delivery.package_versions(
  id,exam_key,package_version,source_commit_sha,validation_hash,package_hash,
  package_schema_version,generator_version,scorer_version,created_at
) values
('16000000-0000-0000-0000-000000000100','az204','1.0.0',repeat('1',40),repeat('2',64),repeat('3',64),'certsim-protected-package-v2','issue160','issue160','2026-08-01 00:00Z'),
('16000000-0000-0000-0000-000000000110','az204','1.1.0',repeat('4',40),repeat('5',64),repeat('6',64),'certsim-protected-package-v2','issue160','issue160','2026-08-01 00:00Z');
insert into exam_delivery.package_profiles(id,package_version_id,profile_key,display_name,question_count,time_limit_minutes,selection_config) values
('16000000-0000-0000-0000-000000000101','16000000-0000-0000-0000-000000000100','standard-profile','Issue 160 predecessor',2,60,'{}'),
('16000000-0000-0000-0000-000000000111','16000000-0000-0000-0000-000000000110','standard-profile','Issue 160 target',3,60,'{"standardQuestionCount":3,"caseStudyCount":0,"pbqCount":0}');
insert into exam_delivery.package_questions(id,package_version_id,question_id,question_type,domain_key,section_key,source_ordinal,presentation_payload,content_hash) values
('16000000-0000-0000-0000-000000000201','16000000-0000-0000-0000-000000000100','issue160-old-mapped','single-choice','old-mapped','objective-old-mapped',1,'{"stem":"predecessor mapped"}',repeat('7',64)),
('16000000-0000-0000-0000-000000000202','16000000-0000-0000-0000-000000000100','issue160-old-unmapped','single-choice','old-unmapped','objective-old-unmapped',2,'{"stem":"predecessor unmapped"}',repeat('8',64)),
('16000000-0000-0000-0000-000000000211','16000000-0000-0000-0000-000000000110','issue160-owner-current','single-choice','owner-current','objective-owner-current',1,'{"stem":"owner current"}',repeat('9',64)),
('16000000-0000-0000-0000-000000000212','16000000-0000-0000-0000-000000000110','issue160-owner-mapped','single-choice','owner-mapped','objective-owner-mapped',2,'{"stem":"owner mapped"}',repeat('a',64)),
('16000000-0000-0000-0000-000000000213','16000000-0000-0000-0000-000000000110','issue160-student-current','single-choice','student-current','objective-student-current',3,'{"stem":"student current"}',repeat('b',64));
insert into exam_delivery.package_question_protected_content(
  question_id,package_version_id,scoring_payload,review_payload,authoring_metadata
) select question.id,question.package_version_id,
  '{"correctOptionId":"a"}'::jsonb,
  '{"explanation":"synthetic"}'::jsonb,
  '{"scored":true,"group":{"languageVariants":{"csharp":{"language":"csharp"},"python":{"language":"python"}}}}'::jsonb
from exam_delivery.package_questions question
where question.package_version_id='16000000-0000-0000-0000-000000000110';
update exam_delivery.package_versions set status='published',published_at=case id
  when '16000000-0000-0000-0000-000000000100' then '2026-09-01 00:00Z'::timestamptz
  else '2026-09-02 00:00Z'::timestamptz end
where id in ('16000000-0000-0000-0000-000000000100','16000000-0000-0000-0000-000000000110');

insert into exam_delivery.exam_profile_activations(package_version_id,package_profile_id,enabled,activation_kind,enabled_at,created_by)
values('16000000-0000-0000-0000-000000000110','16000000-0000-0000-0000-000000000111',true,'production',now(),'16000000-0000-0000-0000-000000000001');
insert into exam_delivery.practice_policies(
  canonical_exam_key,package_version,profile_key,purpose,access_mode,enabled,
  maximum_completed_attempts,maximum_session_items,immediate_feedback,
  review_release_policy,answer_release_policy
) values(
  'az204','1.1.0','standard-profile','weak_area','production_authorized',true,
  null,40,false,'after_submission','after_submission'
);
insert into exam_delivery.practice_policies(
  canonical_exam_key,package_version,profile_key,purpose,access_mode,enabled,
  maximum_completed_attempts,maximum_session_items,immediate_feedback,
  review_release_policy,answer_release_policy
)
select 'az204','1.1.0','standard-profile',purpose::exam_delivery.attempt_purpose,
  'production_authorized',true,null,40,purpose='study_sandbox',
  case when purpose='study_sandbox' then 'immediate_study_feedback' else 'after_submission' end,
  case when purpose='study_sandbox' then 'immediate_study_feedback' else 'after_submission' end
from unnest(array[
  'self_directed_exam','study_sandbox','targeted_domain','pbq_practice'
]) purpose;
insert into exam_delivery.package_profile_defaults(
  canonical_exam_key,profile_key,purpose,package_version_id,package_profile_id,enabled,configured_by
) values(
  'az204','standard-profile','weak_area','16000000-0000-0000-0000-000000000110','16000000-0000-0000-0000-000000000111',true,'16000000-0000-0000-0000-000000000001'
);
insert into exam_delivery.package_domain_compatibility(
  source_package_version_id,target_package_version_id,source_domain_key,target_domain_key,configured_by
) values(
  '16000000-0000-0000-0000-000000000100','16000000-0000-0000-0000-000000000110','old-mapped','owner-mapped','16000000-0000-0000-0000-000000000001'
);
insert into exam_delivery.exam_entitlements(
  package_version_id,package_profile_id,target_type,organisation_id,enabled,reason_code,created_by
) values(
  '16000000-0000-0000-0000-000000000110','16000000-0000-0000-0000-000000000111','organisation','16000000-0000-0000-0000-000000000010',true,'issue160_fixture','16000000-0000-0000-0000-000000000001'
);

insert into exam_delivery.attempts(
  id,owner_id,package_version_id,package_profile_id,client_request_id,status,
  generator_version,scorer_version,created_at,started_at,expires_at,submitted_at,completed_at,purpose
) values
('16000000-0000-0000-0000-000000000301','16000000-0000-0000-0000-000000000001','16000000-0000-0000-0000-000000000110','16000000-0000-0000-0000-000000000111','16000000-0000-0000-0000-000000000401','completed','issue160','issue160','2026-09-03 00:00Z','2026-09-03 00:00Z','2026-09-03 01:00Z','2026-09-03 00:30Z','2026-09-03 00:30Z','self_directed_exam'),
('16000000-0000-0000-0000-000000000302','16000000-0000-0000-0000-000000000001','16000000-0000-0000-0000-000000000100','16000000-0000-0000-0000-000000000101','16000000-0000-0000-0000-000000000402','completed','issue160','issue160','2026-09-03 02:00Z','2026-09-03 02:00Z','2026-09-03 03:00Z','2026-09-03 02:30Z','2026-09-03 02:30Z','assigned_assessment'),
('16000000-0000-0000-0000-000000000303','16000000-0000-0000-0000-000000000003','16000000-0000-0000-0000-000000000110','16000000-0000-0000-0000-000000000111','16000000-0000-0000-0000-000000000403','completed','issue160','issue160','2026-09-04 00:00Z','2026-09-04 00:00Z','2026-09-04 01:00Z','2026-09-04 00:30Z','2026-09-04 00:30Z','self_directed_exam'),
('16000000-0000-0000-0000-000000000304','16000000-0000-0000-0000-000000000005','16000000-0000-0000-0000-000000000110','16000000-0000-0000-0000-000000000111','16000000-0000-0000-0000-000000000404','completed','issue160','issue160','2026-09-05 00:00Z','2026-09-05 00:00Z','2026-09-05 01:00Z','2026-09-05 00:30Z','2026-09-05 00:30Z','self_directed_exam'),
('16000000-0000-0000-0000-000000000305','16000000-0000-0000-0000-000000000006','16000000-0000-0000-0000-000000000110','16000000-0000-0000-0000-000000000111','16000000-0000-0000-0000-000000000405','completed','issue160','issue160','2026-09-06 00:00Z','2026-09-06 00:00Z','2026-09-06 01:00Z','2026-09-06 00:30Z','2026-09-06 00:30Z','self_directed_exam'),
('16000000-0000-0000-0000-000000000311','16000000-0000-0000-0000-000000000002','16000000-0000-0000-0000-000000000110','16000000-0000-0000-0000-000000000111','16000000-0000-0000-0000-000000000411','completed','issue160','issue160','2026-09-07 00:00Z','2026-09-07 00:00Z','2026-09-07 01:00Z','2026-09-07 00:30Z','2026-09-07 00:30Z','study_sandbox'),
('16000000-0000-0000-0000-000000000312','16000000-0000-0000-0000-000000000002','16000000-0000-0000-0000-000000000110','16000000-0000-0000-0000-000000000111','16000000-0000-0000-0000-000000000412','completed','issue160','issue160','2026-09-07 02:00Z','2026-09-07 02:00Z','2026-09-07 03:00Z','2026-09-07 02:30Z','2026-09-07 02:30Z','targeted_domain'),
('16000000-0000-0000-0000-000000000313','16000000-0000-0000-0000-000000000002','16000000-0000-0000-0000-000000000110','16000000-0000-0000-0000-000000000111','16000000-0000-0000-0000-000000000413','completed','issue160','issue160','2026-09-07 04:00Z','2026-09-07 04:00Z','2026-09-07 05:00Z','2026-09-07 04:30Z','2026-09-07 04:30Z','weak_area'),
('16000000-0000-0000-0000-000000000314','16000000-0000-0000-0000-000000000002','16000000-0000-0000-0000-000000000110','16000000-0000-0000-0000-000000000111','16000000-0000-0000-0000-000000000414','completed','issue160','issue160','2026-09-07 06:00Z','2026-09-07 06:00Z','2026-09-07 07:00Z','2026-09-07 06:30Z','2026-09-07 06:30Z','pbq_practice'),
('16000000-0000-0000-0000-000000000315','16000000-0000-0000-0000-000000000004','16000000-0000-0000-0000-000000000110','16000000-0000-0000-0000-000000000111','16000000-0000-0000-0000-000000000415','completed','issue160','issue160','2026-09-08 00:00Z','2026-09-08 00:00Z','2026-09-08 01:00Z','2026-09-08 00:30Z','2026-09-08 00:30Z','weak_area');

insert into exam_delivery.attempt_results(
  attempt_id,submission_id,response_hash,scorer_version,raw_score,max_score,raw_percentage,passed,domain_summary,submitted_at,completed_at
) values
('16000000-0000-0000-0000-000000000301','16000000-0000-0000-0000-000000000501',repeat('c',64),'issue160',0,100,0,false,'{"owner-current":{"domain":"Owner Current","earnedPoints":0,"maxPoints":100,"percentage":0}}','2026-09-03 00:30Z','2026-09-03 00:30Z'),
('16000000-0000-0000-0000-000000000302','16000000-0000-0000-0000-000000000502',repeat('d',64),'issue160',10,100,10,false,'{"old-mapped":{"domain":"Old Mapped","earnedPoints":40,"maxPoints":100,"percentage":40},"old-unmapped":{"domain":"Old Unmapped","earnedPoints":10,"maxPoints":100,"percentage":10}}','2026-09-03 02:30Z','2026-09-03 02:30Z'),
('16000000-0000-0000-0000-000000000303','16000000-0000-0000-0000-000000000503',repeat('e',64),'issue160',50,100,50,false,'{"student-current":{"domain":"Student Current","earnedPoints":50,"maxPoints":100,"percentage":50}}','2026-09-04 00:30Z','2026-09-04 00:30Z'),
('16000000-0000-0000-0000-000000000304','16000000-0000-0000-0000-000000000504',repeat('f',64),'issue160',20,100,20,false,'{"owner-current":{"domain":"Owner Current","earnedPoints":20,"maxPoints":100,"percentage":20}}','2026-09-05 00:30Z','2026-09-05 00:30Z'),
('16000000-0000-0000-0000-000000000305','16000000-0000-0000-0000-000000000505',repeat('0',64),'issue160',30,100,30,false,'{"owner-current":{"domain":"Owner Current","earnedPoints":30,"maxPoints":100,"percentage":30}}','2026-09-06 00:30Z','2026-09-06 00:30Z'),
('16000000-0000-0000-0000-000000000311','16000000-0000-0000-0000-000000000511',repeat('1',64),'issue160',0,100,0,false,'{"owner-current":{"domain":"Owner Current","earnedPoints":0,"maxPoints":100,"percentage":0}}','2026-09-07 00:30Z','2026-09-07 00:30Z'),
('16000000-0000-0000-0000-000000000312','16000000-0000-0000-0000-000000000512',repeat('2',64),'issue160',0,100,0,false,'{"owner-current":{"domain":"Owner Current","earnedPoints":0,"maxPoints":100,"percentage":0}}','2026-09-07 02:30Z','2026-09-07 02:30Z'),
('16000000-0000-0000-0000-000000000313','16000000-0000-0000-0000-000000000513',repeat('3',64),'issue160',0,100,0,false,'{"owner-current":{"domain":"Owner Current","earnedPoints":0,"maxPoints":100,"percentage":0}}','2026-09-07 04:30Z','2026-09-07 04:30Z'),
('16000000-0000-0000-0000-000000000314','16000000-0000-0000-0000-000000000514',repeat('4',64),'issue160',0,100,0,false,'{"owner-current":{"domain":"Owner Current","earnedPoints":0,"maxPoints":100,"percentage":0}}','2026-09-07 06:30Z','2026-09-07 06:30Z'),
('16000000-0000-0000-0000-000000000315','16000000-0000-0000-0000-000000000515',repeat('5',64),'issue160',0,100,0,false,'{"student-current":{"domain":"Student Current","earnedPoints":0,"maxPoints":100,"percentage":0}}','2026-09-08 00:30Z','2026-09-08 00:30Z');

select is((select actor_classification from exam_delivery.attempts where id='16000000-0000-0000-0000-000000000301'),'staff','Platform Owner formal attempt remains staff');
select is((select analytics_eligible from exam_delivery.attempts where id='16000000-0000-0000-0000-000000000301'),false,'Platform Owner formal attempt remains analytics-ineligible');
select is((select count(*)::integer from exam_delivery.learner_weak_domain_evidence('16000000-0000-0000-0000-000000000001','16000000-0000-0000-0000-000000000110')),0,'owner-only evidence does not weaken learner evidence');
select is((select count(*)::integer from jsonb_array_elements(exam_delivery.weak_area_options('16000000-0000-0000-0000-000000000001','az204','standard-profile')->'domains') domain where domain->>'domainKey'='owner-current'),1,'Platform Owner current-package evidence is returned');
select is((select (domain->>'evidenceCount')::integer from jsonb_array_elements(exam_delivery.weak_area_options('16000000-0000-0000-0000-000000000001','az204','standard-profile')->'domains') domain where domain->>'domainKey'='owner-current'),1,'owner current-package evidence count is exact');
select is((select count(*)::integer from jsonb_array_elements(exam_delivery.weak_area_options('16000000-0000-0000-0000-000000000001','az204','standard-profile')->'domains') domain where domain->>'domainKey'='owner-mapped'),1,'mapped predecessor owner evidence uses the target domain');
select is((select (domain->>'evidenceCount')::integer from jsonb_array_elements(exam_delivery.weak_area_options('16000000-0000-0000-0000-000000000001','az204','standard-profile')->'domains') domain where domain->>'domainKey'='owner-mapped'),1,'assigned assessment predecessor evidence count is exact');
select is((select count(*)::integer from jsonb_array_elements(exam_delivery.weak_area_options('16000000-0000-0000-0000-000000000001','az204','standard-profile')->'domains') domain where domain->>'domainKey'='old-mapped'),0,'mapped predecessor source identity is absent');
select is((select count(*)::integer from jsonb_array_elements(exam_delivery.weak_area_options('16000000-0000-0000-0000-000000000001','az204','standard-profile')->'domains') domain where domain->>'domainKey'='old-unmapped'),0,'unmapped predecessor owner evidence is absent');
select is(
  (select jsonb_agg(to_jsonb(evidence) order by evidence.domain_key) from exam_delivery.weak_domain_evidence_for_practice('16000000-0000-0000-0000-000000000003','16000000-0000-0000-0000-000000000110') evidence),
  (select jsonb_agg(to_jsonb(evidence) order by evidence.domain_key) from exam_delivery.learner_weak_domain_evidence('16000000-0000-0000-0000-000000000003','16000000-0000-0000-0000-000000000110') evidence),
  'student learner evidence remains unchanged'
);
select is((exam_delivery.weak_area_options('16000000-0000-0000-0000-000000000003','az204','standard-profile')#>>'{domains,0,domainKey}'),'student-current','student formal evidence remains discoverable');
select is((exam_delivery.weak_area_options('16000000-0000-0000-0000-000000000004','az204','standard-profile')->'domains'),'[]'::jsonb,'student practice activity creates no learner evidence');
select is((select actor_classification from exam_delivery.attempts where id='16000000-0000-0000-0000-000000000304'),'staff','developer attempt is classified as staff');
select is(exam_delivery.weak_area_options('16000000-0000-0000-0000-000000000005','az204','standard-profile'),'{"ok": false, "code": "access_not_granted"}'::jsonb,'developer staff evidence is excluded by the profile-access boundary');
select is((select actor_classification from exam_delivery.attempts where id='16000000-0000-0000-0000-000000000305'),'staff','trainer attempt is classified as staff');
select is(exam_delivery.weak_area_options('16000000-0000-0000-0000-000000000006','az204','standard-profile'),'{"ok": false, "code": "access_not_granted"}'::jsonb,'trainer staff evidence is excluded by the profile-access boundary');
select is((select count(*)::integer from exam_delivery.weak_domain_evidence_for_practice('16000000-0000-0000-0000-000000000002','16000000-0000-0000-0000-000000000110')),0,'all practice purposes are excluded from owner evidence');
select is((exam_delivery.weak_area_options('16000000-0000-0000-0000-000000000002','az204','standard-profile')->'domains'),'[]'::jsonb,'owner evidence is isolated across users');

select is((exam_delivery.practice_availability('16000000-0000-0000-0000-000000000001','{"examKey":"az204","profileId":"standard-profile","purpose":"weak_area","domain":"owner-current","count":"10","includePbqs":true,"mixStrategy":"balanced","language":"csharp"}')#>>'{ok}'),'true','AZ-204 C# Weak Area availability succeeds');
select is((exam_delivery.practice_availability('16000000-0000-0000-0000-000000000001','{"examKey":"az204","profileId":"standard-profile","purpose":"weak_area","domain":"owner-current","count":"10","includePbqs":true,"mixStrategy":"balanced","language":"python"}')#>>'{ok}'),'true','AZ-204 Python Weak Area availability succeeds');
select is((exam_delivery.practice_availability('16000000-0000-0000-0000-000000000001','{"examKey":"az204","profileId":"standard-profile","purpose":"weak_area","domain":"owner-current","count":"10","includePbqs":true,"mixStrategy":"balanced","language":"mixed"}')#>>'{ok}'),'true','AZ-204 Mixed Weak Area availability succeeds');

create temp table issue160_discovery_counts as
select (select count(*) from exam_delivery.attempts) attempt_count,
  (select count(*) from exam_delivery.attempt_results) result_count;
select lives_ok($$select exam_delivery.weak_area_options('16000000-0000-0000-0000-000000000001','az204','standard-profile')$$,'discovery executes without side effects');
select is(
  (select jsonb_build_array((select count(*) from exam_delivery.attempts),(select count(*) from exam_delivery.attempt_results))),
  (select jsonb_build_array(attempt_count,result_count) from issue160_discovery_counts),
  'discovery is read-only'
);

create temp table issue160_start_result as
select exam_delivery.start_practice(
  '16000000-0000-0000-0000-000000000001',
  '{"examKey":"az204","profileId":"standard-profile","purpose":"weak_area","domain":"owner-current","count":"10","includePbqs":true,"mixStrategy":"balanced","language":"mixed","clientRequestId":"16000000-0000-0000-0000-000000000901"}'
) value;
select is((select value->>'ok' from issue160_start_result),'true','Platform Owner Weak Area start succeeds');
select is((select purpose::text from exam_delivery.attempts where id=(select (value#>>'{attempt,attemptId}')::uuid from issue160_start_result)),'weak_area','started attempt purpose is Weak Area');
select is((select actor_classification from exam_delivery.attempts where id=(select (value#>>'{attempt,attemptId}')::uuid from issue160_start_result)),'staff','started Platform Owner attempt remains staff');
select is((select analytics_eligible from exam_delivery.attempts where id=(select (value#>>'{attempt,attemptId}')::uuid from issue160_start_result)),false,'started Platform Owner attempt remains analytics-ineligible');
select is((select count(*)::integer from exam_delivery.attempt_items item join exam_delivery.package_questions question on question.id=item.package_question_id where item.attempt_id=(select (value#>>'{attempt,attemptId}')::uuid from issue160_start_result) and question.domain_key='owner-current'),1,'owner formal result supports existing Weak Area materialization');

select is((exam_delivery.learner_domain_history_summary('16000000-0000-0000-0000-000000000001','az204')->>'evidenceResultCount')::integer,0,'learner domain history excludes owner-only evidence');
select is((exam_delivery.history_summary('16000000-0000-0000-0000-000000000001','az204')->>'completedCount')::integer,0,'learner readiness summary excludes owner-only evidence');

create temp table issue160_org_analytics as
select exam_delivery.staff_dashboard_aggregates(
  '16000000-0000-0000-0000-000000000001',
  '{"organisationId":"16000000-0000-0000-0000-000000000010"}'
) value;
create temp table issue160_campus_analytics as
select exam_delivery.staff_dashboard_aggregates(
  '16000000-0000-0000-0000-000000000001',
  '{"organisationId":"16000000-0000-0000-0000-000000000010","campusId":"16000000-0000-0000-0000-000000000011"}'
) value;
create temp table issue160_group_analytics as
select exam_delivery.staff_dashboard_aggregates(
  '16000000-0000-0000-0000-000000000001',
  '{"organisationId":"16000000-0000-0000-0000-000000000010","campusId":"16000000-0000-0000-0000-000000000011","groupId":"16000000-0000-0000-0000-000000000012"}'
) value;
select is((select value->>'ok' from issue160_org_analytics),'true','staff learner aggregates execute for the owner');
select is((select (value#>>'{totals,protectedAssessments}')::integer from issue160_org_analytics),1,'staff learner aggregates exclude owner-only evidence');
select is((select (value#>>'{totals,protectedAssessments}')::integer from issue160_campus_analytics),1,'campus learner aggregate excludes owner-only evidence');
select is((select (value#>>'{totals,protectedAssessments}')::integer from issue160_group_analytics),1,'group learner aggregate excludes owner-only evidence');

select * from finish();
rollback;
