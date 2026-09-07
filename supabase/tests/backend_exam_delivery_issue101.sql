begin;
select plan(12);

select has_function('exam_delivery','staff_dashboard_aggregates',array['uuid','jsonb']);
select function_returns('exam_delivery','staff_dashboard_aggregates',array['uuid','jsonb'],'jsonb');
select is((select prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_aggregates'),true,'analytics helper remains security definer');
select is((select proconfig @> array['search_path='] from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_aggregates'),true,'analytics helper has empty search path');
select is((select proconfig @> array['statement_timeout=12s'] from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_aggregates'),true,'analytics helper remains bounded');
select function_privs_are('exam_delivery','staff_dashboard_aggregates',array['uuid','jsonb'],'authenticated',array[]::text[],'browser cannot invoke private analytics helper');
select function_privs_are('exam_delivery','staff_dashboard_aggregates',array['uuid','jsonb'],'anon',array[]::text[],'anonymous cannot invoke private analytics helper');
select ok((select pg_get_functiondef(p.oid) ~ 'attempt\.status = ''completed''.*attempt\.analytics_eligible.*assigned_assessment.*self_directed_exam' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_aggregates'),'only completed assessment purposes enter protected analytics');
select ok((select pg_get_functiondef(p.oid) ~ 'classified\.purpose in \(''assigned_assessment'',''self_directed_exam''\)' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_aggregates'),'legacy analytics uses authoritative classifier');
select ok((select pg_get_functiondef(p.oid) ~ 'sum\(COALESCE\(\(domain\.value ->> ''earnedPoints''::text\)::numeric, 0\)' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_aggregates'),'domain analytics sum fractional earned points');
select ok((select pg_get_functiondef(p.oid) ~ 'sum\(COALESCE\(\(domain\.value ->> ''maxPoints''::text\)::numeric, 0\)' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_aggregates'),'domain analytics sum maximum points');
select ok((select pg_get_functiondef(p.oid) ~ 'sum\(COALESCE\(row\.raw_score, 0\).*100.*sum\(COALESCE\(row\.max_score, 0\)' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_aggregates'),'scope averages are raw-point weighted');

select * from finish();
rollback;
