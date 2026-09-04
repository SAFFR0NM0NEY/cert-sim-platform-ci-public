begin;
select plan(36);
select has_table('exam_delivery','attempt_item_flags','protected flag table exists');
select has_table('exam_delivery','question_issue_reports','protected issue table exists');
select row_security_active('exam_delivery.attempt_item_flags');
select row_security_active('exam_delivery.question_issue_reports');
select has_function('exam_delivery','list_flags',array['uuid','uuid']);
select has_function('exam_delivery','set_flag',array['uuid','uuid','uuid','boolean','uuid']);
select has_function('exam_delivery','report_question_issue',array['uuid','uuid','uuid','text','uuid']);
select has_trigger('exam_delivery','attempt_items','randomize_attempt_item_presentation','attempt item randomization trigger exists');
select isnt(
  exam_delivery.randomize_presentation_arrays('{"options":[{"id":"a"},{"id":"b"},{"id":"c"},{"id":"d"}]}'::jsonb,'seed-one')->'options',
  exam_delivery.randomize_presentation_arrays('{"options":[{"id":"a"},{"id":"b"},{"id":"c"},{"id":"d"}]}'::jsonb,'seed-two')->'options',
  'different attempt seeds produce different stable option orders'
);
select is(
  exam_delivery.randomize_presentation_arrays('{"options":[{"id":"a"},{"id":"b"},{"id":"c"},{"id":"d"}]}'::jsonb,'seed-one'),
  exam_delivery.randomize_presentation_arrays('{"options":[{"id":"a"},{"id":"b"},{"id":"c"},{"id":"d"}]}'::jsonb,'seed-one'),
  'same attempt seed is stable'
);
select ok(
  (select count(distinct exam_delivery.randomize_presentation_arrays('{"options":[{"id":"a"},{"id":"b"},{"id":"c"},{"id":"d"}]}'::jsonb,'distribution-'||n)->'options') from generate_series(1,32) n) >= 8,
  'bounded seed sample produces a healthy spread of option orders'
);
select is(
  (select count(distinct value->>'id') from jsonb_array_elements(exam_delivery.randomize_presentation_arrays('{"options":[{"id":"a"},{"id":"b"},{"id":"c"},{"id":"d"}]}'::jsonb,'seed-one')->'options')),
  4::bigint,
  'randomization preserves every option identity exactly once'
);
select has_function('public','certsim_protected_list_flags',array['uuid','uuid']);
select has_function('public','certsim_protected_set_flag',array['uuid','uuid','uuid','boolean','uuid']);
select has_function('public','certsim_protected_report_question_issue',array['uuid','uuid','uuid','text','uuid']);
select function_privs_are('public','certsim_protected_list_flags',array['uuid','uuid'],'service_role',array['EXECUTE']);
select function_privs_are('public','certsim_protected_set_flag',array['uuid','uuid','uuid','boolean','uuid'],'service_role',array['EXECUTE']);
select function_privs_are('public','certsim_protected_report_question_issue',array['uuid','uuid','uuid','text','uuid'],'service_role',array['EXECUTE']);
select ok(has_function_privilege('service_role','exam_delivery.list_flags(uuid,uuid)','EXECUTE'),'service role can complete list-flags invoker chain');
select ok(has_function_privilege('service_role','exam_delivery.set_flag(uuid,uuid,uuid,boolean,uuid)','EXECUTE'),'service role can complete set-flag invoker chain');
select ok(has_function_privilege('service_role','exam_delivery.report_question_issue(uuid,uuid,uuid,text,uuid)','EXECUTE'),'service role can complete issue-report invoker chain');
select ok(not has_function_privilege('authenticated','exam_delivery.list_flags(uuid,uuid)','EXECUTE'),'authenticated cannot call private list-flags function');
select ok(not has_function_privilege('authenticated','exam_delivery.set_flag(uuid,uuid,uuid,boolean,uuid)','EXECUTE'),'authenticated cannot call private set-flag function');
select ok(not has_function_privilege('authenticated','exam_delivery.report_question_issue(uuid,uuid,uuid,text,uuid)','EXECUTE'),'authenticated cannot call private issue-report function');
set local role service_role;
select is((public.certsim_protected_list_flags('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001')->>'code'),'attempt_not_found','service-role list wrapper reaches its owner-safe implementation');
select is((public.certsim_protected_set_flag('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001',true,'40000000-0000-0000-0000-000000000001')->>'code'),'attempt_not_found','service-role flag wrapper reaches its continuation-safe implementation');
select is((public.certsim_protected_report_question_issue('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','synthetic report','40000000-0000-0000-0000-000000000002')->>'code'),'attempt_not_found','service-role report wrapper reaches its owner-safe implementation');
reset role;
select has_table('exam_delivery','attempt_replacements','immutable replacement audit exists');
select row_security_active('exam_delivery.attempt_replacements');
select ok(not has_table_privilege('authenticated','exam_delivery.attempt_replacements','SELECT,INSERT,UPDATE,DELETE'),'browser roles cannot access replacement audits');
select ok(not has_table_privilege('service_role','exam_delivery.attempt_replacements','SELECT,INSERT,UPDATE,DELETE'),'service role cannot mutate replacement audits directly');
select has_function('exam_delivery','replace_current_practice_attempt',array['uuid','jsonb']);
select has_function('public','certsim_protected_replace_current_practice_attempt',array['uuid','jsonb']);
select function_privs_are('public','certsim_protected_replace_current_practice_attempt',array['uuid','jsonb'],'service_role',array['EXECUTE']);
select function_privs_are('exam_delivery','replace_current_practice_attempt',array['uuid','jsonb'],'service_role',array['EXECUTE']);
select ok(not has_function_privilege('authenticated','public.certsim_protected_replace_current_practice_attempt(uuid,jsonb)','EXECUTE'),'browser cannot invoke replacement RPC directly');
select ok((select prosecdef and proconfig @> array['search_path=""','statement_timeout=20s'] from pg_proc p where p.oid='exam_delivery.replace_current_practice_attempt(uuid,jsonb)'::regprocedure),'replacement is bounded definer code with empty search path');
select ok((select pg_get_functiondef('exam_delivery.replace_current_practice_attempt(uuid,jsonb)'::regprocedure) ~ 'pg_advisory_xact_lock' and pg_get_functiondef('exam_delivery.replace_current_practice_attempt(uuid,jsonb)'::regprocedure) ~ 'status=''voided''' and pg_get_functiondef('exam_delivery.replace_current_practice_attempt(uuid,jsonb)'::regprocedure) ~ 'learner_started_new_attempt'),'replacement locks, voids, creates, and audits atomically');
select ok((select pg_get_functiondef('exam_delivery.list_current_attempt_bindings(uuid,text,text)'::regprocedure) ~ 'expires_at>statement_timestamp\(\)' and pg_get_functiondef('exam_delivery.list_current_attempt_bindings(uuid,text,text)'::regprocedure) ~ 'authorize_attempt_continuation'),'advertised bindings are deadline-valid and continuation-authorized');
select * from finish();
rollback;
