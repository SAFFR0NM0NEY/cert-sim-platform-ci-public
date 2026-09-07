begin;
select plan(29);

select has_function('exam_delivery','staff_dashboard_aggregates',array['uuid','jsonb']);
select function_returns('exam_delivery','staff_dashboard_aggregates',array['uuid','jsonb'],'jsonb');
select is((select prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_aggregates'),true,'analytics helper remains security definer');
select is((select proconfig @> array['search_path='] from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_aggregates'),true,'analytics helper has empty search path');
select is((select proconfig @> array['statement_timeout=12s'] from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_aggregates'),true,'analytics helper remains bounded');
select function_privs_are('exam_delivery','staff_dashboard_aggregates',array['uuid','jsonb'],'authenticated',array[]::text[],'browser cannot invoke private analytics helper');
select function_privs_are('exam_delivery','staff_dashboard_aggregates',array['uuid','jsonb'],'anon',array[]::text[],'anonymous cannot invoke private analytics helper');
select ok((select pg_get_functiondef(p.oid) ~ 'attempt\.status = ''completed''.*attempt\.analytics_eligible.*assigned_assessment.*self_directed_exam' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_aggregates_issue101_base'),'only completed assessment purposes enter protected analytics');
select ok((select pg_get_functiondef(p.oid) ~ 'classified\.purpose in \(''assigned_assessment'',''self_directed_exam''\)' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_aggregates_issue101_base'),'legacy analytics uses authoritative classifier');
select ok((select pg_get_functiondef(p.oid) ~ 'sum\(COALESCE\(\(domain\.value ->> ''earnedPoints''::text\)::numeric, 0\)' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_aggregates_issue101_base'),'domain analytics sum fractional earned points');
select ok((select pg_get_functiondef(p.oid) ~ 'sum\(COALESCE\(\(domain\.value ->> ''maxPoints''::text\)::numeric, 0\)' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_aggregates_issue101_base'),'domain analytics sum maximum points');
select ok((select pg_get_functiondef(p.oid) ~ 'sum\(COALESCE\(row\.raw_score, 0\).*100.*sum\(COALESCE\(row\.max_score, 0\)' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_aggregates_issue101_base'),'scope averages are raw-point weighted');

select has_function('exam_delivery','staff_dashboard_learner_page',array['uuid','jsonb','jsonb']);
select has_function('exam_delivery','staff_dashboard_summary',array['uuid','jsonb','jsonb']);
select has_function('exam_delivery','staff_learner_readiness_status',array['jsonb']);
select is((select prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_learner_page'),true,'learner page is security definer');
select is((select proconfig @> array['search_path='] from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_learner_page'),true,'learner page has empty search path');
select is((select proconfig @> array['statement_timeout=12s'] from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_learner_page'),true,'learner page remains bounded');
select function_privs_are('exam_delivery','staff_dashboard_learner_page',array['uuid','jsonb','jsonb'],'authenticated',array[]::text[],'browser cannot invoke private learner page');
select function_privs_are('exam_delivery','staff_dashboard_summary',array['uuid','jsonb','jsonb'],'authenticated',array[]::text[],'browser cannot invoke private summary');
select ok((select pg_get_functiondef(p.oid) ~ 'v_size < 1 or v_size > 50' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_learner_page'),'learner page size is bounded');
select ok((select pg_get_functiondef(p.oid) ~ 'lower\(display_name\), learner_id, exam_key' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_learner_page'),'learner cursor uses deterministic identity order');
select ok((select pg_get_functiondef(p.oid) ~ 'decode\(\(p_request ->> ''learnerCursor''::text\), ''base64''::text\)' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_learner_page'),'learner cursor is decoded and validated');
select ok((select pg_get_functiondef(p.oid) ~ 'v_search.*display_name.*email.*group_name.*exam_key' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_learner_page'),'search is applied in the authorized server scope');
select ok((select pg_get_functiondef(p.oid) ~ 'v_readiness.*readiness_status' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_learner_page'),'readiness filter is server-side');
select ok((select pg_get_functiondef(p.oid) ~ 'p_full - ''learners'' - ''assignmentLearners''' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_summary'),'unbounded learner arrays are removed from public analytics');
select ok((select pg_get_functiondef(p.oid) ~ '''readinessSummary''.*''activitySummary''' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_summary'),'full-scope readiness and activity summaries remain server-side');
select ok((select pg_get_functiondef(p.oid) ~ 'v_page - ''learnerIds''' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_query'),'unbounded learner id allowlist is removed');
select ok((select pg_get_functiondef(p.oid) ~ '''learnerPage''' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_query'),'checked dashboard query emits bounded learner page');

select * from finish();
rollback;
