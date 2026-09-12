begin;
select plan(56);

select has_table('exam_delivery', 'attempt_abandonment_events', 'abandonment evidence table exists');
select has_table('exam_delivery', 'attempt_recovery_events', 'recovery evidence table exists');
select ok((select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='exam_delivery' and c.relname='attempt_abandonment_events'), 'abandonment evidence has RLS');
select ok((select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='exam_delivery' and c.relname='attempt_recovery_events'), 'recovery evidence has RLS');
select ok(exists(select 1 from pg_trigger t where t.tgrelid='exam_delivery.attempt_abandonment_events'::regclass and t.tgname='guard_attempt_abandonment_events_mutation' and not t.tgisinternal), 'abandonment evidence is immutable');
select ok(exists(select 1 from pg_trigger t where t.tgrelid='exam_delivery.attempt_recovery_events'::regclass and t.tgname='guard_attempt_recovery_events_mutation' and not t.tgisinternal), 'recovery evidence is immutable');
select ok(to_regclass('exam_delivery.attempts_owner_profile_abandoned_sandbox_recovery_idx') is not null, 'bounded recovery lookup index exists');
select ok((select indisunique from pg_index where indexrelid='exam_delivery.attempt_abandonment_events_attempt_id_key'::regclass), 'one abandonment event per attempt');
select ok(exists(select 1 from pg_constraint where conrelid='exam_delivery.attempt_abandonment_events'::regclass and conname='attempt_abandonment_events_actor_request_unique' and contype='u'), 'abandonment actor/request is unique');
select ok((select indisunique from pg_index where indexrelid='exam_delivery.attempt_recovery_events_attempt_id_key'::regclass), 'one recovery event per attempt');
select ok(exists(select 1 from pg_constraint where conrelid='exam_delivery.attempt_recovery_events'::regclass and conname='attempt_recovery_events_actor_request_unique' and contype='u'), 'recovery actor/request is unique');
select ok(exists(select 1 from pg_constraint where conrelid='exam_delivery.attempt_abandonment_events'::regclass and conname='attempt_abandonment_events_owner_fk' and contype='f' and confrelid='exam_delivery.attempts'::regclass), 'abandonment owner composite FK exists');
select ok(exists(select 1 from pg_constraint where conrelid='exam_delivery.attempt_recovery_events'::regclass and conname='attempt_recovery_events_owner_fk' and contype='f' and confrelid='exam_delivery.attempts'::regclass), 'recovery owner composite FK exists');
select ok(exists(select 1 from pg_constraint where conrelid='exam_delivery.attempt_abandonment_events'::regclass and conname='attempt_abandonment_events_package_profile_fk' and contype='f' and confrelid='exam_delivery.package_profiles'::regclass), 'abandonment package/profile composite FK exists');
select ok(exists(select 1 from pg_constraint where conrelid='exam_delivery.attempt_recovery_events'::regclass and conname='attempt_recovery_events_package_profile_fk' and contype='f' and confrelid='exam_delivery.package_profiles'::regclass), 'recovery package/profile composite FK exists');

select has_function('exam_delivery', 'abandon_attempt', array['uuid','uuid','uuid']);
select has_function('exam_delivery', 'recover_study_sandbox', array['uuid','uuid','uuid']);
select has_function('exam_delivery', 'list_recoverable_study_sandboxes', array['uuid','text','text','integer']);
select has_function('exam_delivery', 'get_attempt_lifecycle_summary', array['uuid','uuid']);
select has_function('public', 'certsim_protected_abandon_attempt', array['uuid','uuid','uuid']);
select has_function('public', 'certsim_protected_recover_study_sandbox', array['uuid','uuid','uuid']);
select has_function('public', 'certsim_protected_list_recoverable_study_sandboxes', array['uuid','text','text','integer']);
select has_function('public', 'certsim_protected_get_attempt_lifecycle_summary', array['uuid','uuid']);

select is((select pg_get_userbyid(proowner) from pg_proc where oid='exam_delivery.abandon_attempt(uuid,uuid,uuid)'::regprocedure), 'postgres', 'abandon is postgres-owned');
select is((select pg_get_userbyid(proowner) from pg_proc where oid='exam_delivery.recover_study_sandbox(uuid,uuid,uuid)'::regprocedure), 'postgres', 'recovery is postgres-owned');
select is((select pg_get_userbyid(proowner) from pg_proc where oid='exam_delivery.list_recoverable_study_sandboxes(uuid,text,text,integer)'::regprocedure), 'postgres', 'recovery discovery is postgres-owned');
select is((select pg_get_userbyid(proowner) from pg_proc where oid='exam_delivery.get_attempt_lifecycle_summary(uuid,uuid)'::regprocedure), 'postgres', 'lifecycle summary is postgres-owned');
select is((select pg_get_userbyid(proowner) from pg_proc where oid='exam_delivery.guard_attempt_identity_and_lifecycle()'::regprocedure), 'postgres', 'lifecycle guard is postgres-owned');
select ok((select prosecdef and proconfig @> array['search_path=""','statement_timeout=5s'] from pg_proc where oid='exam_delivery.abandon_attempt(uuid,uuid,uuid)'::regprocedure), 'abandon is a bounded definer boundary');
select ok((select prosecdef and proconfig @> array['search_path=""','statement_timeout=8s'] from pg_proc where oid='exam_delivery.recover_study_sandbox(uuid,uuid,uuid)'::regprocedure), 'recovery is a bounded definer boundary');
select ok((select prosecdef and provolatile='s' and proconfig @> array['search_path=""','statement_timeout=5s'] from pg_proc where oid='exam_delivery.list_recoverable_study_sandboxes(uuid,text,text,integer)'::regprocedure), 'discovery is a bounded stable definer boundary');
select ok((select prosecdef and provolatile='s' and proconfig @> array['search_path=""','statement_timeout=5s'] from pg_proc where oid='exam_delivery.get_attempt_lifecycle_summary(uuid,uuid)'::regprocedure), 'summary is a bounded stable definer boundary');

select ok(not has_function_privilege('anon', 'exam_delivery.recover_study_sandbox(uuid,uuid,uuid)', 'EXECUTE'), 'anonymous cannot invoke private recovery');
select ok(not has_function_privilege('authenticated', 'exam_delivery.recover_study_sandbox(uuid,uuid,uuid)', 'EXECUTE'), 'browser cannot invoke private recovery');
select ok(not has_function_privilege('service_role', 'exam_delivery.recover_study_sandbox(uuid,uuid,uuid)', 'EXECUTE'), 'service role cannot bypass the fixed recovery wrapper');
select ok(not has_function_privilege('service_role', 'exam_delivery.list_recoverable_study_sandboxes(uuid,text,text,integer)', 'EXECUTE'), 'service role cannot bypass the fixed discovery wrapper');
select ok(not has_function_privilege('service_role', 'exam_delivery.get_attempt_lifecycle_summary(uuid,uuid)', 'EXECUTE'), 'service role cannot bypass the fixed summary wrapper');
select ok(not has_function_privilege('anon', 'public.certsim_protected_recover_study_sandbox(uuid,uuid,uuid)', 'EXECUTE'), 'anonymous cannot invoke recovery wrapper');
select ok(not has_function_privilege('authenticated', 'public.certsim_protected_recover_study_sandbox(uuid,uuid,uuid)', 'EXECUTE'), 'browser cannot invoke recovery wrapper');
select ok(has_function_privilege('service_role', 'public.certsim_protected_recover_study_sandbox(uuid,uuid,uuid)', 'EXECUTE'), 'protected service can invoke recovery wrapper');
select ok(has_function_privilege('service_role', 'public.certsim_protected_list_recoverable_study_sandboxes(uuid,text,text,integer)', 'EXECUTE'), 'protected service can invoke discovery wrapper');
select ok(has_function_privilege('service_role', 'public.certsim_protected_get_attempt_lifecycle_summary(uuid,uuid)', 'EXECUTE'), 'protected service can invoke summary wrapper');
select ok((select prosecdef and proconfig @> array['search_path=""','statement_timeout=8s'] from pg_proc where oid='public.certsim_protected_recover_study_sandbox(uuid,uuid,uuid)'::regprocedure), 'recovery wrapper is a fixed bounded definer boundary');
select ok((select prosecdef and proconfig @> array['search_path=""','statement_timeout=5s'] from pg_proc where oid='public.certsim_protected_list_recoverable_study_sandboxes(uuid,text,text,integer)'::regprocedure), 'discovery wrapper is a fixed bounded definer boundary');
select ok((select prosecdef and proconfig @> array['search_path=""','statement_timeout=5s'] from pg_proc where oid='public.certsim_protected_get_attempt_lifecycle_summary(uuid,uuid)'::regprocedure), 'summary wrapper is a fixed bounded definer boundary');
select ok(not has_table_privilege('service_role', 'exam_delivery.attempt_abandonment_events', 'SELECT'), 'service role has no direct abandonment evidence access');
select ok(not has_table_privilege('service_role', 'exam_delivery.attempt_recovery_events', 'SELECT'), 'service role has no direct recovery evidence access');
select ok(not has_function_privilege('service_role', 'exam_delivery.start_practice_issue59_attribution_base(uuid,jsonb)', 'EXECUTE'), 'service role cannot bypass canonical Study Sandbox start lock');

select ok((select pg_get_functiondef('exam_delivery.abandon_attempt(uuid,uuid,uuid)'::regprocedure) ~ 'attempt_abandonment_events[\s\S]+response_count_snapshot[\s\S]+update exam_delivery.attempts'), 'abandon records authoritative evidence before status mutation');
select ok((select pg_get_functiondef('exam_delivery.guard_attempt_identity_and_lifecycle()'::regprocedure) ~ 'issue167_recovery_event_id[\s\S]+attempt_recovery_events'), 'guard requires a matching transaction-local recovery event');
select ok((select pg_get_functiondef('exam_delivery.recover_study_sandbox(uuid,uuid,uuid)'::regprocedure) ~ 'issue167-study-sandbox:[\s\S]+for update of attempt[\s\S]+attempt_recovery_events[\s\S]+set status = ''in_progress'''), 'recovery locks binding and candidate before audited transition');
select ok((select pg_get_functiondef('exam_delivery.recover_study_sandbox(uuid,uuid,uuid)'::regprocedure) !~* 'insert into exam_delivery.attempts'), 'recovery never clones an attempt');
select ok((select pg_get_functiondef('exam_delivery.list_recoverable_study_sandboxes(uuid,text,text,integer)'::regprocedure) !~* 'response_payload|presentation_snapshot|question_id|attempt_item_id'), 'discovery DTO cannot select protected or item-level fields');
select ok((select pg_get_functiondef('exam_delivery.get_attempt_lifecycle_summary(uuid,uuid)'::regprocedure) !~* 'response_payload|presentation_snapshot|question_id|attempt_item_id'), 'summary cannot select protected or item-level fields');
select ok((select pg_get_functiondef('exam_delivery.start_practice(uuid,jsonb)'::regprocedure) ~ 'issue167-study-sandbox:[\s\S]+active.practice_idle_expires_at'), 'new Study Sandbox starts share the canonical recovery lock');
select is((select count(*)::integer from information_schema.columns where table_schema='exam_delivery' and table_name in ('attempt_abandonment_events','attempt_recovery_events') and data_type in ('json','jsonb')), 0, 'lifecycle evidence has no payload columns');

select * from finish();
rollback;
