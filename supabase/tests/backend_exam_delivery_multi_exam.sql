begin;

select plan(20);

select has_table('exam_delivery', 'exam_access_policies', 'generic policy table exists');
select has_table('exam_delivery', 'exam_access_organisations', 'organisation scope table exists');
select has_table('exam_delivery', 'exam_access_learners', 'learner scope table exists');
select ok((select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='exam_delivery' and c.relname='exam_access_policies'), 'policy table has RLS');
select ok((select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='exam_delivery' and c.relname='exam_access_organisations'), 'organisation scope table has RLS');
select ok((select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='exam_delivery' and c.relname='exam_access_learners'), 'learner scope table has RLS');
select has_function('exam_delivery', 'normalize_exam_key', array['text']);
select has_function('exam_delivery', 'evaluate_access_policy', array['text', 'text']);
select has_function('public', 'certsim_protected_evaluate_access_policy', array['text', 'text']);

select is(exam_delivery.normalize_exam_key(' AI-901 '), 'ai901', 'AI-901 aliases normalize');
select is(exam_delivery.normalize_exam_key('AZ_204'), 'az204', 'underscores normalize');
select is(exam_delivery.normalize_exam_key('Security+ SY0-701'), 'securitysy0701', 'symbols normalize');

select function_privs_are(
  'public', 'certsim_protected_evaluate_access_policy', array['text', 'text'],
  'anon', array[]::text[]
);
select function_privs_are(
  'public', 'certsim_protected_evaluate_access_policy', array['text', 'text'],
  'service_role', array[]::text[]
);
select function_privs_are(
  'public', 'certsim_protected_evaluate_access_policy', array['text', 'text'],
  'authenticated', array['EXECUTE']
);

select is(
  (select prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='exam_delivery' and p.proname='evaluate_access_policy'),
  true,
  'internal policy evaluator is security definer'
);
select is(
  (select prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='certsim_protected_evaluate_access_policy'),
  false,
  'public policy wrapper is security invoker'
);
select is(
  (select proconfig[1] from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='exam_delivery' and p.proname='evaluate_access_policy'),
  'search_path=""',
  'internal evaluator has an empty search path'
);
select is(
  (select count(*)::integer from exam_delivery.exam_access_policies),
  0,
  'migration enables no exam policy'
);
select lives_ok(
  $$ select public.certsim_protected_evaluate_access_policy('sample-100','practice') $$,
  'unauthenticated eligibility fails closed'
);

select * from finish();
rollback;
