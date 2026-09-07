begin;
select plan(44);

select has_function('exam_delivery','staff_dashboard_aggregates',array['uuid','jsonb']);
select function_returns('exam_delivery','staff_dashboard_aggregates',array['uuid','jsonb'],'jsonb');
select is((select prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_aggregates'),true,'analytics helper remains security definer');
select is((select proconfig @> array['search_path=""'] from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_aggregates'),true,'analytics helper has empty search path');
select is((select proconfig @> array['statement_timeout=12s'] from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_aggregates'),true,'analytics helper remains bounded');
select function_privs_are('exam_delivery','staff_dashboard_aggregates',array['uuid','jsonb'],'authenticated',array[]::text[],'browser cannot invoke private analytics helper');
select function_privs_are('exam_delivery','staff_dashboard_aggregates',array['uuid','jsonb'],'anon',array[]::text[],'anonymous cannot invoke private analytics helper');
select ok((select pg_get_functiondef(p.oid) ~ 'attempt\.status = ''completed''.*attempt\.analytics_eligible.*assigned_assessment.*self_directed_exam' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_aggregates_issue101_base'),'only completed assessment purposes enter protected analytics');
select ok((select pg_get_functiondef(p.oid) ~ 'classified\.purpose in \(''assigned_assessment'',''self_directed_exam''\)' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_aggregates_issue101_base'),'legacy analytics uses authoritative classifier');
select ok((select pg_get_functiondef(p.oid) ~* 'earnedPoints.*::numeric' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_aggregates_issue101_base'),'domain analytics preserve fractional earned points as numeric');
select ok((select pg_get_functiondef(p.oid) ~* 'maxPoints.*::numeric' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_aggregates_issue101_base'),'domain analytics preserve maximum points as numeric');
select ok((select pg_get_functiondef(p.oid) ~* 'raw_score.*100\.0.*max_score' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_aggregates_issue101_base'),'scope averages are derived from raw earned and maximum points');

select has_function('exam_delivery','staff_dashboard_learner_page',array['uuid','jsonb','jsonb']);
select has_function('exam_delivery','staff_dashboard_summary',array['uuid','jsonb','jsonb']);
select has_function('exam_delivery','staff_learner_readiness_status',array['jsonb']);
select is((select prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_learner_page'),true,'learner page is security definer');
select is((select proconfig @> array['search_path=""'] from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_learner_page'),true,'learner page has empty search path');
select is((select proconfig @> array['statement_timeout=12s'] from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_learner_page'),true,'learner page remains bounded');
select function_privs_are('exam_delivery','staff_dashboard_learner_page',array['uuid','jsonb','jsonb'],'authenticated',array[]::text[],'browser cannot invoke private learner page');
select function_privs_are('exam_delivery','staff_dashboard_summary',array['uuid','jsonb','jsonb'],'authenticated',array[]::text[],'browser cannot invoke private summary');
select ok((select pg_get_functiondef(p.oid) ~ 'v_size < 1 or v_size > 50' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_learner_page'),'learner page size is bounded');
select ok((select pg_get_functiondef(p.oid) ~ 'lower\(display_name\),\s*learner_id,\s*exam_key' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_learner_page'),'learner cursor uses deterministic identity order');
select ok((select pg_get_functiondef(p.oid) ~ 'decode\([^)]*learnerCursor[^)]*base64[^)]*\)' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_learner_page'),'learner cursor is decoded and validated');
select ok((select pg_get_functiondef(p.oid) ~ 'v_search.*display_name.*email.*group_name.*exam_key' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_learner_page'),'search is applied in the authorized server scope');
select ok((select pg_get_functiondef(p.oid) ~ 'v_readiness.*readiness_status' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_learner_page'),'readiness filter is server-side');
select ok((select pg_get_functiondef(p.oid) ~ 'p_full - ''learners'' - ''assignmentLearners''' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_summary'),'unbounded learner arrays are removed from public analytics');
select ok((select pg_get_functiondef(p.oid) ~ '''readinessSummary''.*''activitySummary''' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_summary'),'full-scope readiness and activity summaries remain server-side');
select ok((select pg_get_functiondef(p.oid) ~ 'v_page - ''learnerIds''' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_query'),'unbounded learner id allowlist is removed');
select ok((select pg_get_functiondef(p.oid) ~ '''learnerPage''' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_query'),'checked dashboard query emits bounded learner page');

select is((select pg_get_userbyid(proowner) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_summary'),'postgres','summary helper remains postgres-owned');
select is((select provolatile from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_summary'),'s','summary helper remains stable');
select is((select prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_summary'),true,'summary helper remains security definer');
select is((select proconfig @> array['search_path=""','statement_timeout=12s'] from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_summary'),true,'summary helper retains empty path and timeout');
select function_privs_are('exam_delivery','staff_dashboard_summary',array['uuid','jsonb','jsonb'],'public',array[]::text[],'PUBLIC cannot invoke private summary');
select function_privs_are('exam_delivery','staff_dashboard_summary',array['uuid','jsonb','jsonb'],'anon',array[]::text[],'anon cannot invoke private summary');
select function_privs_are('exam_delivery','staff_dashboard_summary',array['uuid','jsonb','jsonb'],'service_role',array[]::text[],'service role cannot invoke private summary directly');

-- Execution fixture: positive activity, unequal ranks, and an ID-ordered tie.
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values
('00000000-0000-0000-0000-000000000000','10100000-0000-0000-0000-000000000001','authenticated','authenticated','owner101@example.invalid','','{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','10100000-0000-0000-0000-000000000010','authenticated','authenticated','alpha101@example.invalid','','{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','10100000-0000-0000-0000-000000000020','authenticated','authenticated','beta101@example.invalid','','{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','10100000-0000-0000-0000-000000000030','authenticated','authenticated','gamma101@example.invalid','','{}','{}',now(),now());
update public.profiles set display_name=case id::text
  when '10100000-0000-0000-0000-000000000010' then 'Alpha'
  when '10100000-0000-0000-0000-000000000020' then 'Beta'
  when '10100000-0000-0000-0000-000000000030' then 'Gamma'
  else display_name end where id::text like '10100000-%';
insert into public.organisations(id,name,organisation_type,status) values
('10100000-0000-0000-0000-000000000100','Issue 101 activity fixture','internal','active');
insert into public.memberships(user_id,organisation_id,role,status) values
('10100000-0000-0000-0000-000000000001','10100000-0000-0000-0000-000000000100','platform_owner','active');

select lives_ok($$
  select exam_delivery.staff_dashboard_summary(
    '10100000-0000-0000-0000-000000000001',
    '{"organisationId":"10100000-0000-0000-0000-000000000100"}',
    '{"ok":true,"totals":{"visibleLearners":3},"groups":[],"assignments":[],"assignmentLearners":[],"learners":[
      {"learnerId":"10100000-0000-0000-0000-000000000030","activityCount":5,"latestActivity":"2026-09-07T12:00:00Z"},
      {"learnerId":"10100000-0000-0000-0000-000000000020","activityCount":2,"latestActivity":"2026-09-06T12:00:00Z"},
      {"learnerId":"10100000-0000-0000-0000-000000000010","activityCount":2,"latestActivity":"2026-09-05T12:00:00Z"}
    ]}'::jsonb)
$$,'summary executes with multiple positive-activity learners');

create temp table issue101_summary_result as
select exam_delivery.staff_dashboard_summary(
  '10100000-0000-0000-0000-000000000001',
  '{"organisationId":"10100000-0000-0000-0000-000000000100"}',
  '{"ok":true,"totals":{"visibleLearners":3},"groups":[],"assignments":[],"assignmentLearners":[],"learners":[
    {"learnerId":"10100000-0000-0000-0000-000000000030","activityCount":5,"latestActivity":"2026-09-07T12:00:00Z"},
    {"learnerId":"10100000-0000-0000-0000-000000000020","activityCount":2,"latestActivity":"2026-09-06T12:00:00Z"},
    {"learnerId":"10100000-0000-0000-0000-000000000010","activityCount":2,"latestActivity":"2026-09-05T12:00:00Z"}
  ]}'::jsonb) value;

select ok((value#>'{activitySummary,mostActive}') is not null,'most-active list exists') from issue101_summary_result;
select ok((value#>'{activitySummary,leastActive}') is not null,'least-active list exists') from issue101_summary_result;
select is((value#>>'{activitySummary,mostActive,0,totalAttempts}')::integer,5,'most-active ranks descending') from issue101_summary_result;
select is((value#>>'{activitySummary,leastActive,0,totalAttempts}')::integer,2,'least-active ranks ascending') from issue101_summary_result;
select is(value#>>'{activitySummary,mostActive,1,learner_id}','10100000-0000-0000-0000-000000000010','most-active ties use learner ID') from issue101_summary_result;
select is(value#>>'{activitySummary,leastActive,0,learner_id}','10100000-0000-0000-0000-000000000010','least-active ties use learner ID') from issue101_summary_result;
select ok(not ((value#>'{activitySummary,mostActive,0}') ? 'activity_count'),'internal activity_count is not returned') from issue101_summary_result;

select * from finish();
rollback;
