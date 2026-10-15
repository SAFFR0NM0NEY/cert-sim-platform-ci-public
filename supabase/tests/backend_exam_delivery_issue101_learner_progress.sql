begin;
select plan(18);

select has_function('exam_delivery','learner_domain_history_summary',array['uuid','text']);
select function_returns('exam_delivery','learner_domain_history_summary',array['uuid','text'],'jsonb');
select is((select pg_get_userbyid(proowner) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='learner_domain_history_summary'),'postgres','domain helper is postgres-owned');
select is((select provolatile from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='learner_domain_history_summary'),'s','domain helper is stable');
select is((select prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='learner_domain_history_summary'),true,'domain helper is security definer');
select is((select proconfig @> array['search_path=""','statement_timeout=5s'] from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='learner_domain_history_summary'),true,'domain helper has empty path and bounded timeout');
select function_privs_are('exam_delivery','learner_domain_history_summary',array['uuid','text'],'authenticated',array[]::text[],'browser cannot invoke private domain helper');
select function_privs_are('exam_delivery','learner_domain_history_summary',array['uuid','text'],'anon',array[]::text[],'anonymous cannot invoke private domain helper');

insert into auth.users(instance_id,id,aud,role,email,encrypted_password,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values('00000000-0000-0000-0000-000000000000','10110000-0000-0000-0000-000000000001','authenticated','authenticated','learner-progress-101@example.invalid','','{}','{}',now(),now());
insert into public.organisations(id,name,organisation_type,status)
values('10110000-0000-0000-0000-000000000100','Issue 101 learner progress fixture','internal','active');
insert into public.memberships(user_id,organisation_id,role,status)
values('10110000-0000-0000-0000-000000000001','10110000-0000-0000-0000-000000000100','student','active');

insert into exam_delivery.package_versions(id,exam_key,package_version,source_commit_sha,validation_hash,package_hash,package_schema_version,generator_version,scorer_version)
values('10110000-0000-0000-0000-000000000200','issue101fixture','1.0.0',repeat('1',40),repeat('2',64),repeat('3',64),'fixture','fixture','fixture');
insert into exam_delivery.package_profiles(id,package_version_id,profile_key,display_name,question_count,time_limit_minutes)
values('10110000-0000-0000-0000-000000000201','10110000-0000-0000-0000-000000000200','full','Full',1,60);
insert into exam_delivery.package_profile_defaults(canonical_exam_key,profile_key,purpose,package_version_id,package_profile_id)
values('issue101fixture','full','self_directed_exam','10110000-0000-0000-0000-000000000200','10110000-0000-0000-0000-000000000201');
insert into exam_delivery.practice_policies(
  canonical_exam_key,package_version,profile_key,purpose,access_mode,enabled,
  maximum_completed_attempts,maximum_session_items,immediate_feedback,
  review_release_policy,answer_release_policy
)
select 'issue101fixture','1.0.0','full',purpose::exam_delivery.attempt_purpose,
  'production_authorized',true,null,40,purpose='weak_area',
  case when purpose='weak_area' then 'immediate_study_feedback' else 'after_submission' end,
  case when purpose='weak_area' then 'immediate_study_feedback' else 'after_submission' end
from unnest(array['self_directed_exam','weak_area']) purpose;

create temp table issue101_attempts(n integer primary key,id uuid not null default gen_random_uuid());
insert into issue101_attempts(n) select generate_series(1,22);
insert into exam_delivery.attempts(id,owner_id,package_version_id,package_profile_id,client_request_id,status,generator_version,scorer_version,created_at,started_at,expires_at,submitted_at,completed_at,purpose,actor_classification,analytics_eligible)
select id,'10110000-0000-0000-0000-000000000001','10110000-0000-0000-0000-000000000200','10110000-0000-0000-0000-000000000201',gen_random_uuid(),'completed','fixture','fixture',
  '2026-01-01'::timestamptz+n*interval '1 day','2026-01-01'::timestamptz+n*interval '1 day','2026-01-01'::timestamptz+n*interval '1 day 1 hour',
  '2026-01-01'::timestamptz+n*interval '1 day 30 minutes','2026-01-01'::timestamptz+n*interval '1 day 30 minutes','self_directed_exam','student',true
from issue101_attempts;
insert into exam_delivery.attempt_results(attempt_id,submission_id,response_hash,scorer_version,raw_score,max_score,raw_percentage,passed,domain_summary,submitted_at,completed_at)
select a.id,gen_random_uuid(),repeat('4',64),'fixture',case when a.n=22 then .5 else 1 end,1,case when a.n=22 then 50 else 100 end,true,
  jsonb_build_object('domain-x',jsonb_build_object('domain','Domain X','earnedPoints',case when a.n=22 then .5 else 1 end,'maxPoints',1,'percentage',case when a.n=22 then 50 else 100 end)),
  '2026-01-01'::timestamptz+a.n*interval '1 day 30 minutes','2026-01-01'::timestamptz+a.n*interval '1 day 30 minutes'
from issue101_attempts a;

-- Completed practice is retained but excluded from formal learner analytics.
insert into exam_delivery.attempts(id,owner_id,package_version_id,package_profile_id,client_request_id,status,generator_version,scorer_version,created_at,started_at,expires_at,submitted_at,completed_at,purpose,actor_classification,analytics_eligible)
values('10110000-0000-0000-0000-000000000299','10110000-0000-0000-0000-000000000001','10110000-0000-0000-0000-000000000200','10110000-0000-0000-0000-000000000201',gen_random_uuid(),'completed','fixture','fixture','2026-03-01','2026-03-01','2026-03-01 01:00Z','2026-03-01 00:30Z','2026-03-01 00:30Z','weak_area','student',false);
insert into exam_delivery.attempt_results(attempt_id,submission_id,response_hash,scorer_version,raw_score,max_score,raw_percentage,passed,domain_summary,submitted_at,completed_at)
values('10110000-0000-0000-0000-000000000299',gen_random_uuid(),repeat('5',64),'fixture',0,100,0,false,'{"domain-x":{"domain":"Domain X","earnedPoints":0,"maxPoints":100,"percentage":0}}','2026-03-01 00:30Z','2026-03-01 00:30Z');

-- Genuine legacy percentage-only evidence exercises the explicit fallback.
insert into public.exam_attempts(id,user_id,exam_key,exam_version,profile_id,mode_label,status,started_at,submitted_at)
values
('10110000-0000-0000-0000-000000000301','10110000-0000-0000-0000-000000000001','issue101fixture','legacy','full','Full exam','submitted','2025-01-01','2025-01-01 01:00Z'),
('10110000-0000-0000-0000-000000000302','10110000-0000-0000-0000-000000000001','issue101fixture','legacy','full','Full exam','submitted','2025-01-02','2025-01-02 01:00Z');
insert into public.exam_results(attempt_id,user_id,exam_key,profile_id,scoring_engine_version,raw_score,raw_percentage,passed,domain_breakdown)
values
('10110000-0000-0000-0000-000000000301','10110000-0000-0000-0000-000000000001','issue101fixture','full','legacy',8,80,true,'{"legacy-domain":{"domain":"Legacy Domain","percentage":80}}'),
('10110000-0000-0000-0000-000000000302','10110000-0000-0000-0000-000000000001','issue101fixture','full','legacy',6,60,false,'{"legacy-domain":{"domain":"Legacy Domain","percentage":60}}');

create temp table issue101_domain_result as
select exam_delivery.learner_domain_history_summary('10110000-0000-0000-0000-000000000001','issue101fixture') value;

select is((select (item->>'percentage')::numeric from issue101_domain_result cross join lateral jsonb_array_elements(value->'items') item where item->>'domainId'='domain-x'),97.73::numeric,'all 22 formal attempts are raw-point weighted rather than latest-only or page-bounded');
select is((select (item->>'earnedPoints')::numeric from issue101_domain_result cross join lateral jsonb_array_elements(value->'items') item where item->>'domainId'='domain-x'),21.5::numeric,'fractional raw earned points are preserved');
select is((select (item->>'maxPoints')::numeric from issue101_domain_result cross join lateral jsonb_array_elements(value->'items') item where item->>'domainId'='domain-x'),22::numeric,'raw maximum points cover every eligible attempt');
select is((select (item->>'samples')::integer from issue101_domain_result cross join lateral jsonb_array_elements(value->'items') item where item->>'domainId'='domain-x'),22,'domain evidence count is exact');
select is((select item->>'aggregationMode' from issue101_domain_result cross join lateral jsonb_array_elements(value->'items') item where item->>'domainId'='domain-x'),'raw_points','raw evidence has explicit aggregation mode');
select is((select (item->>'percentage')::numeric from issue101_domain_result cross join lateral jsonb_array_elements(value->'items') item where item->>'domainId'='legacy-domain'),70::numeric,'legacy percentage-only fallback is deterministic');
select is((select item->>'aggregationMode' from issue101_domain_result cross join lateral jsonb_array_elements(value->'items') item where item->>'domainId'='legacy-domain'),'legacy_percentage_fallback','legacy fallback is disclosed');
select is((select (value->>'evidenceResultCount')::integer from issue101_domain_result),24,'top-level evidence count includes only contributing formal results');

create temp table issue101_history_result as
select exam_delivery.history_summary('10110000-0000-0000-0000-000000000001','issue101fixture') value;
select is((select value->'domainSummary' from issue101_history_result),(select value->'weakDomains' from issue101_history_result),'compatibility field and explicit domain summary share one authoritative value');
select is((select value#>>'{domainSummary,source}' from issue101_history_result),'full_eligible_assessment_history','history summary exposes explicit full-history semantics');

select * from finish();
rollback;
