begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(22);

select is((select count(*)::integer from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p')), 18, 'baseline has 18 public tables');
select is((select count(*)::integer from information_schema.columns where table_schema = 'public'), 241, 'baseline has 241 public columns');
select is((select count(*)::integer from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname = 'public'), 114, 'baseline has 114 public constraints');
select is((select count(*)::integer from pg_indexes where schemaname = 'public'), 80, 'baseline has 80 public indexes');
select is((select count(*)::integer from pg_policies where schemaname = 'public'), 67, 'baseline has 67 public RLS policies');
select is((select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname <> 'rls_auto_enable'), 51, 'baseline has 51 application functions');
select is((select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosecdef and p.proname <> 'rls_auto_enable'), 49, 'baseline has 49 SECURITY DEFINER application functions');
select is((select count(*)::integer from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and not t.tgisinternal), 14, 'baseline has 14 public table triggers');
select is((select count(*)::integer from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'auth' and c.relname = 'users' and not t.tgisinternal), 1, 'baseline has one Auth signup trigger');
select is((select count(*)::integer from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public' and t.typtype = 'e'), 0, 'baseline has no public enum types');
select is((select count(*)::integer from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'S'), 0, 'baseline has no public sequences');
select is((select count(*)::integer from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relrowsecurity), 18, 'RLS is enabled on every public table');
select is((select count(*)::integer from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relforcerowsecurity), 0, 'forced RLS is disabled on public tables');
select hasnt_schema('exam_delivery', 'baseline does not contain exam_delivery schema');

with expected(table_name, columns, constraints, indexes, policies) as (
  values
    ('account_deletion_requests',11,5,3,3), ('bulk_onboarding_batches',11,6,2,1),
    ('campuses',7,3,3,4), ('exam_assignments',17,10,9,4), ('exam_attempts',18,6,5,6),
    ('exam_catalog',13,6,3,2), ('exam_reports',8,4,2,6), ('exam_responses',9,3,3,3),
    ('exam_results',17,5,4,6), ('group_access_codes',14,10,5,1), ('groups',9,5,3,5),
    ('memberships',9,7,7,5), ('onboarding_invites',16,10,8,1), ('organisations',8,3,1,4),
    ('placement_assessment_results',20,7,6,2), ('platform_issue_reports',21,9,7,3),
    ('profiles',10,5,3,5), ('question_reports',23,10,6,6)
), actual as (
  select e.table_name,
    (select count(*)::integer from information_schema.columns c where c.table_schema='public' and c.table_name=e.table_name) columns,
    (select count(*)::integer from pg_constraint c join pg_class r on r.oid=c.conrelid join pg_namespace n on n.oid=r.relnamespace where n.nspname='public' and r.relname=e.table_name) constraints,
    (select count(*)::integer from pg_indexes i where i.schemaname='public' and i.tablename=e.table_name) indexes,
    (select count(*)::integer from pg_policies p where p.schemaname='public' and p.tablename=e.table_name) policies
  from expected e
)
select is((select count(*)::integer from expected e join actual a using(table_name) where (a.columns,a.constraints,a.indexes,a.policies)=(e.columns,e.constraints,e.indexes,e.policies)), 18, 'all baseline table-level catalogue counts match');

select fk_ok('public', 'profiles', 'id', 'auth', 'users', 'id', 'profiles retain Auth identity linkage');
select fk_ok('public', 'exam_results', 'attempt_id', 'public', 'exam_attempts', 'id', 'results retain attempt linkage');
select policies_are('public', 'exam_assignments', array['exam_assignments_insert_scoped','exam_assignments_platform_owner_manage','exam_assignments_select_scoped','exam_assignments_update_scoped'], 'assignment policy set is intact');
select has_function('public', 'accept_onboarding_invite', 'onboarding acceptance function exists');
select has_function('public', 'save_placement_assessment_result', 'placement-result function exists');
select ok(has_function_privilege('authenticated', 'public.accept_onboarding_invite(text)', 'EXECUTE'), 'authenticated users can execute onboarding acceptance');
select ok(has_function_privilege('authenticated', 'public.save_placement_assessment_result(text,text,text,text,text,text,text,jsonb,jsonb,jsonb)', 'EXECUTE'), 'authenticated users can save placement results');

select * from finish();
rollback;
