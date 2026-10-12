begin;
select no_plan();

select has_table('exam_delivery','exam_release_operations','release operation ledger exists');
select has_table('exam_delivery','exam_release_operation_events','release event ledger exists');
select has_table('exam_delivery','attempt_continuation_contracts','continuation contracts exist');
select ok((select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='exam_delivery' and c.relname='exam_release_operations'),'operation ledger has RLS');
select ok((select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='exam_delivery' and c.relname='exam_release_operation_events'),'event ledger has RLS');
select ok((select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='exam_delivery' and c.relname='attempt_continuation_contracts'),'continuation contracts have RLS');
select is((select count(*)::integer from pg_policy where polrelid in (
  'exam_delivery.exam_release_operations'::regclass,
  'exam_delivery.exam_release_operation_events'::regclass,
  'exam_delivery.attempt_continuation_contracts'::regclass
)),0,'private tables have no client policies');

select ok(exists(select 1 from pg_constraint where conrelid='exam_delivery.exam_release_operations'::regclass and conname='exam_release_operations_request_id_key' and contype='u'),'request id is unique');
select ok(exists(select 1 from pg_constraint where conrelid='exam_delivery.exam_release_operation_events'::regclass and conname='exam_release_operation_events_order_unique' and contype='u'),'event sequence is unique per operation');
select ok(exists(select 1 from pg_constraint where conrelid='exam_delivery.attempt_continuation_contracts'::regclass and conname='attempt_continuation_contracts_pkey' and contype='p'),'one continuation contract exists per attempt');
select ok(exists(select 1 from pg_trigger where tgrelid='exam_delivery.exam_release_operations'::regclass and tgname='guard_exam_release_operation_update' and not tgisinternal),'operation ledger has monotonic guard');
select ok(exists(select 1 from pg_trigger where tgrelid='exam_delivery.exam_release_operation_events'::regclass and tgname='guard_exam_release_operation_events_append_only' and not tgisinternal),'event ledger is append-only');
select ok(exists(select 1 from pg_trigger where tgrelid='exam_delivery.attempt_continuation_contracts'::regclass and tgname='guard_attempt_continuation_contracts_immutable' and not tgisinternal),'continuation contracts are immutable');
select ok(exists(select 1 from pg_trigger where tgrelid='exam_delivery.attempts'::regclass and tgname='create_attempt_continuation_contract_after_insert' and not tgisinternal),'every attempt insert creates its contract transactionally');

select has_function('exam_delivery','build_attempt_continuation_contract',array['uuid']);
select has_function('exam_delivery','authorize_attempt_continuation',array['uuid','text']);
select has_function('exam_delivery','release_configuration_snapshot',array['text']);
select has_function('exam_delivery','release_configuration_hash',array['text']);
select has_function('exam_delivery','validate_current_exam_release_configuration',array['text']);
select has_function('exam_delivery','preflight_exam_release',array['uuid','jsonb']);
select has_function('exam_delivery','stage_exam_release',array['uuid','jsonb']);
select has_function('exam_delivery','activate_exam_release',array['uuid','jsonb']);
select has_function('exam_delivery','rollback_exam_release',array['uuid','jsonb']);
select has_function('exam_delivery','list_exam_release_operations',array['uuid','text','text','integer']);
select has_function('public','certsim_examops_preflight_exam_release',array['jsonb']);
select has_function('public','certsim_examops_stage_exam_release',array['jsonb']);
select has_function('public','certsim_examops_activate_exam_release',array['jsonb']);
select has_function('public','certsim_examops_rollback_exam_release',array['jsonb']);
select has_function('public','certsim_examops_list_release_operations',array['text','text','integer']);

select ok((select prosecdef and proconfig @> array['search_path=""','statement_timeout=10s'] from pg_proc where oid='exam_delivery.build_attempt_continuation_contract(uuid)'::regprocedure),'contract builder is a bounded fixed-search-path definer');
select ok((select prosecdef and provolatile='s' and proconfig @> array['search_path=""','statement_timeout=5s'] from pg_proc where oid='exam_delivery.authorize_attempt_continuation(uuid,text)'::regprocedure),'continuation authorization is a bounded stable definer');
select ok((select prosecdef and provolatile='s' and proconfig @> array['search_path=""','statement_timeout=10s'] from pg_proc where oid='exam_delivery.validate_current_exam_release_configuration(text)'::regprocedure),'current release validation is a bounded stable definer');
select ok((select prosecdef and provolatile='s' and proconfig @> array['search_path=""','statement_timeout=15s'] from pg_proc where oid='exam_delivery.preflight_exam_release(uuid,jsonb)'::regprocedure),'preflight is bounded and stable');
select ok((select prosecdef and proconfig @> array['search_path=""','statement_timeout=20s'] from pg_proc where oid='exam_delivery.stage_exam_release(uuid,jsonb)'::regprocedure),'stage is bounded');
select ok((select prosecdef and proconfig @> array['search_path=""','statement_timeout=30s'] from pg_proc where oid='exam_delivery.activate_exam_release(uuid,jsonb)'::regprocedure),'activate is bounded');
select ok((select prosecdef and proconfig @> array['search_path=""','statement_timeout=30s'] from pg_proc where oid='exam_delivery.rollback_exam_release(uuid,jsonb)'::regprocedure),'rollback is bounded');

select ok(not has_table_privilege('anon','exam_delivery.exam_release_operations','SELECT'),'anonymous cannot read operations');
select ok(not has_table_privilege('authenticated','exam_delivery.exam_release_operations','SELECT'),'authenticated cannot read operations directly');
select ok(not has_table_privilege('service_role','exam_delivery.exam_release_operations','SELECT'),'service role cannot read operations directly');
select ok(not has_table_privilege('anon','exam_delivery.exam_release_operation_events','SELECT'),'anonymous cannot read events');
select ok(not has_table_privilege('authenticated','exam_delivery.exam_release_operation_events','SELECT'),'authenticated cannot read events directly');
select ok(not has_table_privilege('service_role','exam_delivery.exam_release_operation_events','SELECT'),'service role cannot read events directly');
select ok(not has_table_privilege('anon','exam_delivery.attempt_continuation_contracts','SELECT'),'anonymous cannot read continuation contracts');
select ok(not has_table_privilege('authenticated','exam_delivery.attempt_continuation_contracts','SELECT'),'authenticated cannot read continuation contracts directly');
select ok(not has_table_privilege('service_role','exam_delivery.attempt_continuation_contracts','SELECT'),'service role cannot read continuation contracts directly');
select ok(not has_function_privilege('authenticated','exam_delivery.activate_exam_release(uuid,jsonb)','EXECUTE'),'authenticated cannot bypass activate wrapper');
select ok(not has_function_privilege('service_role','exam_delivery.activate_exam_release(uuid,jsonb)','EXECUTE'),'service role cannot bypass activate wrapper');
select ok(not has_function_privilege('authenticated','exam_delivery.validate_current_exam_release_configuration(text)','EXECUTE'),'authenticated cannot bypass private current release validation');
select ok(not has_function_privilege('service_role','exam_delivery.validate_current_exam_release_configuration(text)','EXECUTE'),'service role cannot bypass private current release validation');
select ok(has_function_privilege('authenticated','public.certsim_examops_activate_exam_release(jsonb)','EXECUTE'),'authenticated can reach checked activate wrapper');
select ok(not has_function_privilege('anon','public.certsim_examops_activate_exam_release(jsonb)','EXECUTE'),'anonymous cannot reach activate wrapper');
select ok(has_function_privilege('authenticated','public.certsim_examops_list_release_operations(text,text,integer)','EXECUTE'),'authenticated can reach checked history wrapper');

select ok(pg_get_functiondef('exam_delivery.authorize_attempt_continuation(uuid,text)'::regprocedure) !~* 'practice_policies|exam_profile_activations|package_profile_defaults|can_use_profile|check_eligibility','continuation authorization excludes mutable new-start configuration');
select ok(pg_get_functiondef('exam_delivery.authorize_attempt_continuation(uuid,text)'::regprocedure) ~ 'practice_idle_expires_at','continuation authorization enforces practice idle expiry');
select ok(pg_get_functiondef('exam_delivery.authorize_attempt_continuation(uuid,text)'::regprocedure) ~ 'python_submission_grading_sessions','continuation authorization preserves narrow frozen submit');
select ok(pg_get_functiondef('exam_delivery.check_practice_item(uuid,uuid,uuid,integer,uuid)'::regprocedure) ~ 'attempt_continuation_contracts','item feedback uses the frozen contract');
select ok(pg_get_functiondef('exam_delivery.check_practice_item(uuid,uuid,uuid,integer,uuid)'::regprocedure) !~* 'practice_policies','item feedback excludes mutable policy');
select ok(pg_get_functiondef('exam_delivery.submit_attempt_v2(uuid,uuid,uuid)'::regprocedure) ~ 'attempt_continuation_contracts','submit release uses the frozen contract');
select ok(pg_get_functiondef('exam_delivery.get_review(uuid,uuid)'::regprocedure) ~ 'attempt_continuation_contracts','review release uses the frozen contract');
select ok(pg_get_functiondef('exam_delivery.start_assignment_attempt(uuid,text,text,uuid,uuid)'::regprocedure) ~ 'contract_version=''live-v2''[\s\S]+package_version_id','live-v2 start resolves the exact assignment package');
select ok(pg_get_functiondef('exam_delivery.start_assignment_attempt(uuid,text,text,uuid,uuid)'::regprocedure) ~ 'package.status=''published''','historical assignment launch remains bounded to published packages');
select ok(pg_get_functiondef('exam_delivery.discover_current_attempt(uuid,text,text,text,text,text)'::regprocedure) !~* 'package.status=''published''','current attempt discovery is not coupled to publication state');
select ok(pg_get_functiondef('exam_delivery.release_configuration_snapshot(text)'::regprocedure) !~* 'exam_delivery\.attempts|exam_delivery\.attempt_responses|exam_delivery\.attempt_results|exam_delivery\.review_snapshots|public\.exam_assignments','release snapshot excludes learner lifecycle data');
select ok(pg_get_functiondef('exam_delivery.validate_current_exam_release_configuration(text)'::regprocedure) !~* 'exam_delivery\.attempts|exam_delivery\.attempt_responses|exam_delivery\.attempt_results|exam_delivery\.review_snapshots|public\.exam_assignments','current release validation excludes learner lifecycle data');
select ok(pg_get_functiondef('exam_delivery.preflight_exam_release(uuid,jsonb)'::regprocedure) ~ 'validate_current_exam_release_configuration','preflight enforces current release health');
select ok(pg_get_functiondef('exam_delivery.stage_exam_release(uuid,jsonb)'::regprocedure) ~ 'pg_try_advisory_xact_lock','stage uses an exam-scoped transaction lock');
select ok(pg_get_functiondef('exam_delivery.activate_exam_release(uuid,jsonb)'::regprocedure) ~ 'previous_state_snapshot','activate records exact rollback state');
select ok(pg_get_functiondef('exam_delivery.rollback_exam_release(uuid,jsonb)'::regprocedure) ~ 'previous_state_snapshot','rollback restores recorded state');
select ok(pg_get_functiondef('exam_delivery.rollback_exam_release(uuid,jsonb)'::regprocedure) ~ 'v_restored_package_id[\s\S]+target_package_id[\s\S]+v_restored_package_id','rollback operation target is derived from the recorded predecessor snapshot');
select ok(pg_get_functiondef('exam_delivery.rollback_exam_release(uuid,jsonb)'::regprocedure) !~* 'max\(package\.package_version|min\(package\.package_version|order by\s+package\.package_version','rollback does not infer a predecessor by version ordering');
select ok(pg_get_functiondef('exam_delivery.examops_validate_release_set(jsonb)'::regprocedure) ~ 'v_binding_count<>6','release set requires all six purpose bindings');
select ok(pg_get_functiondef('exam_delivery.examops_validate_release_set(jsonb)'::regprocedure) ~ 'v_policy_count<>5','release set requires all five practice policies');

select * from finish();
rollback;
