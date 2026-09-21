begin;
select plan(26);

select has_function('exam_delivery','weak_area_options',array['uuid','text','text']);
select has_function('public','certsim_protected_weak_area_options',array['uuid','text','text']);
select is((select prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='weak_area_options'),true,'private discovery is a definer boundary');
select is((select proconfig @> array['search_path=""','statement_timeout=8s'] from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='weak_area_options'),true,'private discovery has an empty path and bounded timeout');
select is((select prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='certsim_protected_weak_area_options'),false,'public RPC wrapper remains invoker');
select function_privs_are('exam_delivery','weak_area_options',array['uuid','text','text'],'authenticated',array[]::text[],'browser cannot invoke private discovery');
select function_privs_are('public','certsim_protected_weak_area_options',array['uuid','text','text'],'authenticated',array[]::text[],'browser cannot invoke discovery RPC');
select function_privs_are('exam_delivery','weak_area_options',array['uuid','text','text'],'service_role',array['EXECUTE'],'Edge may invoke private discovery through its wrapper');
select function_privs_are('public','certsim_protected_weak_area_options',array['uuid','text','text'],'service_role',array['EXECUTE'],'Edge may invoke the narrow discovery RPC');
select ok((select pg_get_functiondef(p.oid) ~ 'resolve_package_profile_default' and pg_get_functiondef(p.oid) ~ 'weak_domain_evidence_for_practice' and pg_get_functiondef(p.oid) ~ 'package_questions' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='weak_area_options'),'discovery reuses explicit defaults, practice evidence, and current package domains');
select ok((select pg_get_functiondef(p.oid) !~* '(insert into|update |delete from|merge into).*exam_delivery\.(attempts|attempt_results|exam_entitlements|exam_profile_activations|package_versions|package_questions)' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='weak_area_options'),'discovery contains no protected state or release writes');

insert into auth.users(instance_id,id,aud,role,email,encrypted_password,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values
('00000000-0000-0000-0000-000000000000','14700000-0000-0000-0000-000000000001','authenticated','authenticated','owner147@example.invalid','','{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','14700000-0000-0000-0000-000000000002','authenticated','authenticated','current147@example.invalid','','{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','14700000-0000-0000-0000-000000000003','authenticated','authenticated','mapped147@example.invalid','','{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','14700000-0000-0000-0000-000000000004','authenticated','authenticated','unmapped147@example.invalid','','{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','14700000-0000-0000-0000-000000000005','authenticated','authenticated','legacy147@example.invalid','','{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','14700000-0000-0000-0000-000000000006','authenticated','authenticated','noaccess147@example.invalid','','{}','{}',now(),now());
update public.profiles set status='active' where id::text like '14700000-%';
update public.profiles set default_role='individual_user' where id='14700000-0000-0000-0000-000000000006';

insert into public.organisations(id,name,organisation_type,status)
values('14700000-0000-0000-0000-000000000010','Issue 147 weak-area authority fixture','internal','active');
insert into public.memberships(user_id,organisation_id,role,status) values
('14700000-0000-0000-0000-000000000001','14700000-0000-0000-0000-000000000010','platform_owner','active'),
('14700000-0000-0000-0000-000000000002','14700000-0000-0000-0000-000000000010','student','active'),
('14700000-0000-0000-0000-000000000003','14700000-0000-0000-0000-000000000010','student','active'),
('14700000-0000-0000-0000-000000000004','14700000-0000-0000-0000-000000000010','student','active'),
('14700000-0000-0000-0000-000000000005','14700000-0000-0000-0000-000000000010','student','active');

insert into exam_delivery.package_versions(
  id,exam_key,package_version,source_commit_sha,validation_hash,package_hash,
  package_schema_version,generator_version,scorer_version
) values
('14700000-0000-0000-0000-000000000100','issue147fixture','1.0.0',repeat('1',40),repeat('2',64),repeat('3',64),'fixture','fixture','fixture'),
('14700000-0000-0000-0000-000000000110','issue147fixture','2.0.0',repeat('4',40),repeat('5',64),repeat('6',64),'fixture','fixture','fixture');
insert into exam_delivery.package_profiles(id,package_version_id,profile_key,display_name,question_count,time_limit_minutes) values
('14700000-0000-0000-0000-000000000101','14700000-0000-0000-0000-000000000100','standard-profile','Issue 147 predecessor',2,60),
('14700000-0000-0000-0000-000000000111','14700000-0000-0000-0000-000000000110','standard-profile','Issue 147 current',2,60);
insert into exam_delivery.package_questions(id,package_version_id,question_id,question_type,domain_key,source_ordinal,presentation_payload,content_hash) values
('14700000-0000-0000-0000-000000000201','14700000-0000-0000-0000-000000000100','old-mapped-q','single-choice','old-mapped',1,'{}',repeat('7',64)),
('14700000-0000-0000-0000-000000000202','14700000-0000-0000-0000-000000000100','old-unmapped-q','single-choice','old-unmapped',2,'{}',repeat('8',64)),
('14700000-0000-0000-0000-000000000211','14700000-0000-0000-0000-000000000110','current-direct-q','single-choice','current-direct',1,'{}',repeat('9',64)),
('14700000-0000-0000-0000-000000000212','14700000-0000-0000-0000-000000000110','current-mapped-q','single-choice','current-mapped',2,'{}',repeat('a',64));
update exam_delivery.package_versions
set status='published',published_at=statement_timestamp()
where id in ('14700000-0000-0000-0000-000000000100','14700000-0000-0000-0000-000000000110');

insert into exam_delivery.exam_profile_activations(package_version_id,package_profile_id,enabled,activation_kind,enabled_at,created_by)
values('14700000-0000-0000-0000-000000000110','14700000-0000-0000-0000-000000000111',true,'production',now(),'14700000-0000-0000-0000-000000000001');
insert into exam_delivery.practice_policies(
  canonical_exam_key,package_version,profile_key,purpose,access_mode,enabled,
  maximum_completed_attempts,maximum_session_items,immediate_feedback,
  review_release_policy,answer_release_policy
) values(
  'issue147fixture','2.0.0','standard-profile','weak_area','production_authorized',true,
  null,40,false,'after_submission','after_submission'
);
insert into exam_delivery.practice_policies(
  canonical_exam_key,package_version,profile_key,purpose,access_mode,enabled,
  maximum_completed_attempts,maximum_session_items,immediate_feedback,
  review_release_policy,answer_release_policy
) values
  ('issue147fixture','2.0.0','standard-profile','self_directed_exam','production_authorized',true,
   null,40,false,'after_submission','after_submission'),
  ('issue147fixture','1.0.0','standard-profile','self_directed_exam','production_authorized',true,
   null,40,false,'after_submission','after_submission');
insert into exam_delivery.package_profile_defaults(
  canonical_exam_key,profile_key,purpose,package_version_id,package_profile_id,enabled,configured_by
) values(
  'issue147fixture','standard-profile','weak_area','14700000-0000-0000-0000-000000000110','14700000-0000-0000-0000-000000000111',true,'14700000-0000-0000-0000-000000000001'
);
insert into exam_delivery.package_domain_compatibility(
  source_package_version_id,target_package_version_id,source_domain_key,target_domain_key,configured_by
) values(
  '14700000-0000-0000-0000-000000000100','14700000-0000-0000-0000-000000000110','old-mapped','current-mapped','14700000-0000-0000-0000-000000000001'
);
insert into exam_delivery.exam_entitlements(
  package_version_id,package_profile_id,target_type,organisation_id,enabled,reason_code,created_by
) values(
  '14700000-0000-0000-0000-000000000110','14700000-0000-0000-0000-000000000111','organisation','14700000-0000-0000-0000-000000000010',true,'issue147_fixture','14700000-0000-0000-0000-000000000001'
);

insert into exam_delivery.attempts(
  id,owner_id,package_version_id,package_profile_id,client_request_id,status,
  generator_version,scorer_version,created_at,started_at,expires_at,submitted_at,completed_at,purpose
) values
('14700000-0000-0000-0000-000000000301','14700000-0000-0000-0000-000000000001','14700000-0000-0000-0000-000000000110','14700000-0000-0000-0000-000000000111','14700000-0000-0000-0000-000000000401','completed','fixture','fixture','2026-09-01 00:00Z','2026-09-01 00:00Z','2026-09-01 01:00Z','2026-09-01 00:30Z','2026-09-01 00:30Z','self_directed_exam'),
('14700000-0000-0000-0000-000000000302','14700000-0000-0000-0000-000000000002','14700000-0000-0000-0000-000000000110','14700000-0000-0000-0000-000000000111','14700000-0000-0000-0000-000000000402','completed','fixture','fixture','2026-09-02 00:00Z','2026-09-02 00:00Z','2026-09-02 01:00Z','2026-09-02 00:30Z','2026-09-02 00:30Z','self_directed_exam'),
('14700000-0000-0000-0000-000000000303','14700000-0000-0000-0000-000000000003','14700000-0000-0000-0000-000000000100','14700000-0000-0000-0000-000000000101','14700000-0000-0000-0000-000000000403','completed','fixture','fixture','2026-09-03 00:00Z','2026-09-03 00:00Z','2026-09-03 01:00Z','2026-09-03 00:30Z','2026-09-03 00:30Z','self_directed_exam'),
('14700000-0000-0000-0000-000000000304','14700000-0000-0000-0000-000000000004','14700000-0000-0000-0000-000000000100','14700000-0000-0000-0000-000000000101','14700000-0000-0000-0000-000000000404','completed','fixture','fixture','2026-09-04 00:00Z','2026-09-04 00:00Z','2026-09-04 01:00Z','2026-09-04 00:30Z','2026-09-04 00:30Z','self_directed_exam');
insert into exam_delivery.attempt_results(
  attempt_id,submission_id,response_hash,scorer_version,raw_score,max_score,raw_percentage,passed,domain_summary,submitted_at,completed_at
) values
('14700000-0000-0000-0000-000000000301','14700000-0000-0000-0000-000000000501',repeat('b',64),'fixture',20,100,20,false,'{"current-direct":{"domain":"Current Direct","earnedPoints":20,"maxPoints":100,"percentage":20}}','2026-09-01 00:30Z','2026-09-01 00:30Z'),
('14700000-0000-0000-0000-000000000302','14700000-0000-0000-0000-000000000502',repeat('c',64),'fixture',55,100,55,false,'{"current-direct":{"domain":"Current Direct","earnedPoints":55,"maxPoints":100,"percentage":55}}','2026-09-02 00:30Z','2026-09-02 00:30Z'),
('14700000-0000-0000-0000-000000000303','14700000-0000-0000-0000-000000000503',repeat('d',64),'fixture',40,100,40,false,'{"old-mapped":{"domain":"Old Mapped","earnedPoints":40,"maxPoints":100,"percentage":40}}','2026-09-03 00:30Z','2026-09-03 00:30Z'),
('14700000-0000-0000-0000-000000000304','14700000-0000-0000-0000-000000000504',repeat('e',64),'fixture',10,100,10,false,'{"old-unmapped":{"domain":"Old Unmapped","earnedPoints":10,"maxPoints":100,"percentage":10}}','2026-09-04 00:30Z','2026-09-04 00:30Z');

insert into public.exam_attempts(id,user_id,exam_key,exam_version,profile_id,mode_label,status,started_at,submitted_at)
values('14700000-0000-0000-0000-000000000601','14700000-0000-0000-0000-000000000005','issue147fixture','legacy','mystery','Practice','submitted','2026-08-01 00:00Z','2026-08-01 01:00Z');
insert into public.exam_results(attempt_id,user_id,exam_key,profile_id,scoring_engine_version,raw_score,raw_percentage,passed,domain_breakdown)
values('14700000-0000-0000-0000-000000000601','14700000-0000-0000-0000-000000000005','issue147fixture','mystery','legacy',5,5,false,'{"current-direct":{"domain":"Current Direct","percentage":5}}');

select is((select actor_classification from exam_delivery.attempts where id='14700000-0000-0000-0000-000000000301'),'staff','staff attempt classification is immutable server authority');
select is((select analytics_eligible from exam_delivery.attempts where id='14700000-0000-0000-0000-000000000301'),false,'staff assessment is intentionally analytics-ineligible');
select is((exam_delivery.list_history('14700000-0000-0000-0000-000000000001','issue147fixture',null,20)#>>'{items,0,attemptId}'),'14700000-0000-0000-0000-000000000301','staff result remains visible in Saved Results history');
select is((select count(*)::integer from exam_delivery.learner_weak_domain_evidence('14700000-0000-0000-0000-000000000001','14700000-0000-0000-0000-000000000110')),0,'staff history creates no learner weak-area evidence');
select is((exam_delivery.weak_area_options('14700000-0000-0000-0000-000000000002','issue147fixture','standard-profile')#>>'{domains,0,domainKey}'),'current-direct','eligible current-package learner sees the current domain');
select is((exam_delivery.weak_area_options('14700000-0000-0000-0000-000000000002','issue147fixture','standard-profile')#>>'{domains,0,evidenceCount}')::integer,1,'eligible current-package evidence count is retained');
select is((exam_delivery.weak_area_options('14700000-0000-0000-0000-000000000003','issue147fixture','standard-profile')#>>'{domains,0,domainKey}'),'current-mapped','mapped predecessor evidence resolves to the current domain');
select ok(not ((exam_delivery.weak_area_options('14700000-0000-0000-0000-000000000003','issue147fixture','standard-profile')->'domains') @> '[{"domainKey":"old-mapped"}]'::jsonb),'source package domain is never exposed as a current option');
select is((exam_delivery.weak_area_options('14700000-0000-0000-0000-000000000004','issue147fixture','standard-profile')->'domains'),'[]'::jsonb,'unmapped predecessor evidence invents no domain');
select is((exam_delivery.weak_area_options('14700000-0000-0000-0000-000000000005','issue147fixture','standard-profile')->'domains'),'[]'::jsonb,'unclassified legacy activity creates no weak-area option');
select is((exam_delivery.weak_area_options(null,'issue147fixture','standard-profile')->>'code'),'invalid_request','invalid discovery request has a stable code');
select is((exam_delivery.weak_area_options('14700000-0000-0000-0000-000000000001','missing-exam','standard-profile')->>'code'),'no_published_package','missing explicit default has a stable code');
select is((exam_delivery.weak_area_options('14700000-0000-0000-0000-000000000006','issue147fixture','standard-profile')->>'code'),'access_not_granted','profile access failure has a stable code');
update exam_delivery.practice_policies set enabled=false,access_mode='disabled'
where canonical_exam_key='issue147fixture' and package_version='2.0.0' and profile_key='standard-profile' and purpose='weak_area';
select is((exam_delivery.weak_area_options('14700000-0000-0000-0000-000000000002','issue147fixture','standard-profile')->>'code'),'practice_unavailable','disabled Weak Area policy has a stable code');
select is((select count(*)::integer from exam_delivery.attempts where id::text like '14700000-%'),4,'all discovery calls are read-only for protected attempts');

select * from finish();
rollback;
