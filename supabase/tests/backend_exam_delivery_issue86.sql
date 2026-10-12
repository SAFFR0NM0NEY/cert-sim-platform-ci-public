begin;
select plan(123);

select has_table('exam_delivery','python_lab_workspaces','current workspace authority exists');
select has_table('exam_delivery','python_lab_workspace_revisions','workspace revision history exists');
select has_table('exam_delivery','python_execution_runs','durable run authority exists');
select has_table('exam_delivery','python_grading_materializations','grading materialization bindings exist');
select has_table('exam_delivery','python_grading_evidence','verified grading evidence exists');
select has_table('exam_delivery','python_submission_grading_sessions','immutable final-submission claims exist');
select has_table('exam_delivery','python_submission_grading_runs','submission grading generations exist');

select ok((select relrowsecurity from pg_class where oid='exam_delivery.python_lab_workspaces'::regclass),'workspace authority has RLS');
select ok((select relrowsecurity from pg_class where oid='exam_delivery.python_lab_workspace_revisions'::regclass),'workspace revisions have RLS');
select ok((select relrowsecurity from pg_class where oid='exam_delivery.python_execution_runs'::regclass),'execution runs have RLS');
select ok((select relrowsecurity from pg_class where oid='exam_delivery.python_grading_materializations'::regclass),'materializations have RLS');
select ok((select relrowsecurity from pg_class where oid='exam_delivery.python_grading_evidence'::regclass),'grading evidence has RLS');
select ok((select relrowsecurity from pg_class where oid='exam_delivery.python_submission_grading_sessions'::regclass),'submission claims have RLS');
select ok((select relrowsecurity from pg_class where oid='exam_delivery.python_submission_grading_runs'::regclass),'submission grading generations have RLS');
select is((select count(*)::integer from pg_policy where polrelid in (
  'exam_delivery.python_lab_workspaces'::regclass,
  'exam_delivery.python_lab_workspace_revisions'::regclass,
  'exam_delivery.python_execution_runs'::regclass,
  'exam_delivery.python_grading_materializations'::regclass,
  'exam_delivery.python_grading_evidence'::regclass,
  'exam_delivery.python_submission_grading_sessions'::regclass,
  'exam_delivery.python_submission_grading_runs'::regclass
)),0,'Python orchestration tables have no Data API policies');

select ok(not has_table_privilege('anon','exam_delivery.python_lab_workspaces','SELECT'),'anonymous cannot read workspace state');
select ok(not has_table_privilege('authenticated','exam_delivery.python_lab_workspaces','INSERT'),'browser cannot insert workspace state');
select ok(not has_table_privilege('service_role','exam_delivery.python_lab_workspaces','SELECT'),'service role cannot bypass workspace RPC');
select ok(not has_table_privilege('service_role','exam_delivery.python_execution_runs','INSERT'),'service role cannot fabricate a run');
select ok(not has_table_privilege('service_role','exam_delivery.python_grading_evidence','INSERT'),'service role cannot ingest grading evidence');
select ok(not has_table_privilege('service_role','exam_delivery.python_submission_grading_sessions','SELECT'),'service role cannot bypass final-submission RPC authority');
select ok(not has_table_privilege('service_role','exam_delivery.python_submission_grading_runs','INSERT'),'service role cannot fabricate a grading generation');

select has_function('public','certsim_protected_get_python_workspace',array['uuid','uuid','uuid']);
select has_function('public','certsim_protected_save_python_workspace',array['uuid','uuid','uuid','jsonb','integer','uuid']);
select has_function('public','certsim_protected_request_python_run',array['uuid','uuid','uuid','integer','uuid']);
select has_function('public','certsim_protected_get_python_run',array['uuid','uuid','uuid','uuid']);
select has_function('public','certsim_protected_cancel_python_run',array['uuid','uuid','uuid','uuid','uuid']);
select has_function('exam_delivery','python_workspace_hash',array['jsonb']);
select has_function('exam_delivery','python_orchestration_request_digest',array['uuid','uuid','integer','text','uuid']);
select has_function('exam_delivery','persist_verified_python_grading_evidence',array['uuid','uuid','uuid','uuid','text','text','text','text','integer','integer','jsonb']);
select has_function('exam_delivery','prepare_python_submission_grading',array['uuid','uuid','uuid']);
select has_function('exam_delivery','materialize_python_submission_grading',array['uuid','uuid','uuid','uuid','uuid','text']);
select has_function('exam_delivery','score_attempt_item_with_trusted_grading',array['uuid','uuid','uuid','text','text','jsonb','jsonb','jsonb','boolean']);
select has_function('exam_delivery','submit_attempt_v2_with_trusted_grading',array['uuid','uuid','uuid']);
select has_function('public','certsim_service_prepare_python_submission_grading',array['uuid','uuid','uuid']);
select has_function('public','certsim_service_materialize_python_submission_grading',array['uuid','uuid','uuid','uuid','uuid','text']);
select has_function('public','certsim_service_persist_verified_python_grading_evidence',array['uuid','uuid','uuid','uuid','text','text','text','text','integer','integer','jsonb']);

select ok(exists(select 1 from pg_constraint where conrelid='exam_delivery.python_submission_grading_sessions'::regclass and conname='python_submission_grading_sessions_binding_unique' and contype='u'),'one submission identity binds each final grading claim');
select ok(exists(select 1 from pg_constraint where conrelid='exam_delivery.python_submission_grading_runs'::regclass and conname='python_submission_grading_runs_attempt_unique' and contype='u'),'grading generations are unique per attempt item and generation');

select ok(exists(select 1 from information_schema.columns where table_schema='exam_delivery' and table_name='python_execution_runs' and column_name='orchestration_request_digest' and is_nullable='NO'),'runs require the orchestration request digest');
select ok(exists(select 1 from information_schema.columns where table_schema='exam_delivery' and table_name='python_execution_runs' and column_name='execution_request_digest' and is_nullable='YES'),'run execution request digest remains nullable before trusted request materialization');
select ok(exists(select 1 from information_schema.columns where table_schema='exam_delivery' and table_name='python_grading_materializations' and column_name='execution_request_digest' and is_nullable='NO'),'materializations require the canonical R4 execution request digest');
select ok(exists(select 1 from information_schema.columns where table_schema='exam_delivery' and table_name='python_grading_evidence' and column_name='execution_request_digest' and is_nullable='NO'),'grading evidence requires the canonical R4 execution request digest');
select is((select count(*)::integer from information_schema.columns where table_schema='exam_delivery' and table_name in ('python_execution_runs','python_grading_materializations','python_grading_evidence') and column_name='request_digest'),0,'generic request_digest columns are absent');
select is((select count(*)::integer from information_schema.columns where table_schema='exam_delivery' and table_name in ('python_grading_materializations','python_grading_evidence') and column_name='orchestration_request_digest'),0,'orchestration digest cannot enter protected grading bindings');
select ok(exists(select 1 from pg_constraint where conrelid='exam_delivery.python_execution_runs'::regclass and conname='python_execution_runs_execution_request_digest_unique' and contype='u'),'run execution request digest is a foreign-key reference key');
select ok(exists(select 1 from pg_constraint where conrelid='exam_delivery.python_execution_runs'::regclass and conname='python_execution_runs_execution_request_ready_check' and pg_get_constraintdef(oid) ~ 'state.*authorized.*execution_request_digest IS NOT NULL'),'only authorized runs may await execution request materialization');
select ok(exists(select 1 from pg_constraint where conrelid='exam_delivery.python_grading_materializations'::regclass and conname='python_grading_materializations_run_fk' and pg_get_constraintdef(oid) ~ 'FOREIGN KEY \(run_id, execution_request_digest\).*python_execution_runs\(id, execution_request_digest\)'),'materializations bind the exact run execution request digest');
select ok(exists(select 1 from pg_constraint where conrelid='exam_delivery.python_grading_evidence'::regclass and conname='python_grading_evidence_run_fk' and pg_get_constraintdef(oid) ~ 'FOREIGN KEY \(run_id, execution_request_digest, execution_result_digest\).*python_execution_runs\(id, execution_request_digest, execution_result_digest\)'),'evidence binds the exact run request and result digests');
select ok(exists(select 1 from pg_constraint where conrelid='exam_delivery.python_grading_evidence'::regclass and conname='python_grading_evidence_materialization_fk' and pg_get_constraintdef(oid) ~ 'execution_request_digest.*python_grading_materializations.*execution_request_digest'),'evidence binds the exact materialization execution request digest');
select ok(to_regprocedure('exam_delivery.python_run_request_digest(uuid,uuid,integer,text,uuid)') is null,'ambiguous legacy request-digest helper is absent');

select ok((select not prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid='public.certsim_protected_get_python_workspace(uuid,uuid,uuid)'::regprocedure),'workspace GET wrapper is fixed and invoker-rights');
select ok((select not prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid='public.certsim_protected_save_python_workspace(uuid,uuid,uuid,jsonb,integer,uuid)'::regprocedure),'workspace SAVE wrapper is fixed and invoker-rights');
select ok((select not prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid='public.certsim_protected_request_python_run(uuid,uuid,uuid,integer,uuid)'::regprocedure),'run request wrapper is fixed and invoker-rights');
select ok((select not prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid='public.certsim_protected_get_python_run(uuid,uuid,uuid,uuid)'::regprocedure),'run status wrapper is fixed and invoker-rights');
select ok((select not prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid='public.certsim_protected_cancel_python_run(uuid,uuid,uuid,uuid,uuid)'::regprocedure),'run cancel wrapper is fixed and invoker-rights');

select ok(has_function_privilege('service_role','public.certsim_protected_get_python_workspace(uuid,uuid,uuid)','EXECUTE'),'service role can call workspace GET wrapper');
select ok(has_function_privilege('service_role','public.certsim_protected_save_python_workspace(uuid,uuid,uuid,jsonb,integer,uuid)','EXECUTE'),'service role can call workspace SAVE wrapper');
select ok(has_function_privilege('service_role','public.certsim_protected_request_python_run(uuid,uuid,uuid,integer,uuid)','EXECUTE'),'service role can call run request wrapper');
select ok(has_function_privilege('service_role','public.certsim_protected_get_python_run(uuid,uuid,uuid,uuid)','EXECUTE'),'service role can call run status wrapper');
select ok(has_function_privilege('service_role','public.certsim_protected_cancel_python_run(uuid,uuid,uuid,uuid,uuid)','EXECUTE'),'service role can call run cancel wrapper');
select ok(not has_function_privilege('authenticated','public.certsim_protected_save_python_workspace(uuid,uuid,uuid,jsonb,integer,uuid)','EXECUTE'),'browser cannot call workspace wrapper directly');
select ok(not has_function_privilege('anon','public.certsim_protected_request_python_run(uuid,uuid,uuid,integer,uuid)','EXECUTE'),'anonymous cannot call run wrapper');

select ok((select prosecdef and proconfig @> array['search_path=""','statement_timeout=8s'] from pg_proc where oid='exam_delivery.save_python_workspace(uuid,uuid,uuid,jsonb,integer,uuid)'::regprocedure),'workspace save has bounded definer authority');
select ok((select prosecdef and proconfig @> array['search_path=""','statement_timeout=5s'] from pg_proc where oid='exam_delivery.request_python_run(uuid,uuid,uuid,integer,uuid)'::regprocedure),'run request has bounded definer authority');
select ok((select prosecdef and proconfig @> array['search_path=""','statement_timeout=5s'] from pg_proc where oid='exam_delivery.get_python_run(uuid,uuid,uuid,uuid)'::regprocedure),'run status has bounded definer authority');
select ok((select prosecdef and proconfig @> array['search_path=""','statement_timeout=8s'] from pg_proc where oid='exam_delivery.cancel_python_run(uuid,uuid,uuid,uuid,uuid)'::regprocedure),'run cancel has bounded definer authority');
select ok((select prosecdef and proconfig @> array['search_path=""','statement_timeout=8s'] from pg_proc where oid='exam_delivery.persist_verified_python_grading_evidence(uuid,uuid,uuid,uuid,text,text,text,text,integer,integer,jsonb)'::regprocedure),'evidence hook has bounded definer authority');
select ok(has_function_privilege('service_role','exam_delivery.persist_verified_python_grading_evidence(uuid,uuid,uuid,uuid,text,text,text,text,integer,integer,jsonb)','EXECUTE'),'enabled evidence hook is restricted to service authority');
select ok(not has_function_privilege('authenticated','exam_delivery.persist_verified_python_grading_evidence(uuid,uuid,uuid,uuid,text,text,text,text,integer,integer,jsonb)','EXECUTE'),'browser cannot invoke evidence hook');

select ok((select prosecdef and proconfig @> array['search_path=""','statement_timeout=15s'] from pg_proc where oid='exam_delivery.prepare_python_submission_grading(uuid,uuid,uuid)'::regprocedure),'submission preparation has bounded definer authority');
select ok((select prosecdef and proconfig @> array['search_path=""','statement_timeout=8s'] from pg_proc where oid='exam_delivery.materialize_python_submission_grading(uuid,uuid,uuid,uuid,uuid,text)'::regprocedure),'grading materialization has bounded definer authority');
select ok((select prosecdef and proconfig @> array['search_path=""','statement_timeout=15s'] from pg_proc where oid='exam_delivery.submit_attempt_v2_with_trusted_grading(uuid,uuid,uuid)'::regprocedure),'trusted generic submission has bounded definer authority');

select ok(has_function_privilege('service_role','public.certsim_service_prepare_python_submission_grading(uuid,uuid,uuid)','EXECUTE'),'service role can prepare final grading');
select ok(has_function_privilege('service_role','public.certsim_service_materialize_python_submission_grading(uuid,uuid,uuid,uuid,uuid,text)','EXECUTE'),'service role can claim final grading materialization');
select ok(has_function_privilege('service_role','public.certsim_service_persist_verified_python_grading_evidence(uuid,uuid,uuid,uuid,text,text,text,text,integer,integer,jsonb)','EXECUTE'),'service role can persist verified R5 evidence');
select ok(not has_function_privilege('authenticated','public.certsim_service_prepare_python_submission_grading(uuid,uuid,uuid)','EXECUTE'),'browser cannot prepare protected grading');
select ok(not has_function_privilege('authenticated','public.certsim_service_materialize_python_submission_grading(uuid,uuid,uuid,uuid,uuid,text)','EXECUTE'),'browser cannot claim protected grading');
select ok(not has_function_privilege('authenticated','public.certsim_service_persist_verified_python_grading_evidence(uuid,uuid,uuid,uuid,text,text,text,text,integer,integer,jsonb)','EXECUTE'),'browser cannot persist verified grading evidence');

select ok(exists(select 1 from pg_constraint where conrelid='exam_delivery.python_lab_workspace_revisions'::regclass and conname='python_lab_workspace_revisions_request_unique' and contype='u'),'workspace request IDs are globally unique');
select ok(exists(select 1 from pg_constraint where conrelid='exam_delivery.python_execution_runs'::regclass and conname='python_execution_runs_request_unique' and contype='u'),'execution request IDs are globally unique');
select ok(exists(select 1 from pg_constraint where conrelid='exam_delivery.python_grading_evidence'::regclass and conname='python_grading_evidence_run_id_key' and contype='u'),'one evidence row may bind a run');
select ok(exists(select 1 from pg_constraint where conrelid='exam_delivery.python_grading_evidence'::regclass and conname='python_grading_evidence_materialization_id_key' and contype='u'),'one evidence row may bind a materialization');
select ok(exists(select 1 from pg_constraint where conrelid='exam_delivery.python_grading_evidence'::regclass and conname='python_grading_evidence_grading_session_id_key' and contype='u'),'one evidence row may bind a grading session');
select ok(to_regclass('exam_delivery.python_execution_runs_one_active_item_idx') is not null,'active-run uniqueness index exists');

select ok(exists(select 1 from pg_trigger where tgrelid='exam_delivery.python_lab_workspace_revisions'::regclass and tgname='guard_python_workspace_revisions_immutable' and not tgisinternal),'workspace revisions are immutable');
select ok(exists(select 1 from pg_trigger where tgrelid='exam_delivery.python_execution_runs'::regclass and tgname='guard_python_execution_run_transition' and not tgisinternal),'run transitions are guarded');
select ok(exists(select 1 from pg_trigger where tgrelid='exam_delivery.python_grading_materializations'::regclass and tgname='guard_python_materializations_immutable' and not tgisinternal),'materialization bindings are immutable');
select ok(exists(select 1 from pg_trigger where tgrelid='exam_delivery.python_grading_evidence'::regclass and tgname='guard_python_evidence_immutable' and not tgisinternal),'grading evidence is immutable');
select ok(exists(select 1 from pg_trigger where tgrelid='exam_delivery.python_submission_grading_sessions'::regclass and tgname='guard_python_submission_grading_sessions_immutable' and not tgisinternal),'final-submission claims are immutable');
select ok(exists(select 1 from pg_trigger where tgrelid='exam_delivery.python_submission_grading_runs'::regclass and tgname='guard_python_submission_grading_runs_immutable' and not tgisinternal),'submission grading generations are immutable');

select ok((select pg_get_functiondef('exam_delivery.request_python_run(uuid,uuid,uuid,integer,uuid)'::regprocedure) ~ 'no insert and no provider call[\s\S]+executor_disabled'),'run request is explicitly hard-disabled without persistence');
select ok((select pg_get_functiondef('exam_delivery.authorize_python_lab_item(uuid,uuid,uuid,text)'::regprocedure) ~ 'owner_id = p_actor_id[\s\S]+executable-python-lab-v1[\s\S]+authorize_attempt_continuation'),'Python operations reuse owner, item, and continuation authority');
select ok((select pg_get_functiondef('exam_delivery.persist_verified_python_grading_evidence(uuid,uuid,uuid,uuid,text,text,text,text,integer,integer,jsonb)'::regprocedure) !~* 'signature|secret|material_body|hidden'),'evidence persistence contains no fake crypto or protected material body');
select is((select count(*)::integer from information_schema.columns where table_schema='exam_delivery' and table_name like 'python_%' and column_name ~* 'signature|secret|material_body|hidden'),0,'Python persistence has no secret or protected-body columns');
select ok((select pg_get_functiondef('exam_delivery.save_python_workspace(uuid,uuid,uuid,jsonb,integer,uuid)'::regprocedure) ~ 'python_submission_grading_sessions[\s\S]+submission_in_progress'),'workspace mutation is blocked after final-submission freeze');
select ok((select pg_get_functiondef('exam_delivery.prepare_python_submission_grading(uuid,uuid,uuid)'::regprocedure) ~ 'trustedGrading[\s\S]+materialDigest[\s\S]+gradingMaterial[\s\S]+workspace_revision'),'preparation binds protected material and the frozen workspace revision');
select ok((select pg_get_functiondef('exam_delivery.materialize_python_submission_grading(uuid,uuid,uuid,uuid,uuid,text)'::regprocedure) ~ 'execution_request_digest[\s\S]+state = ''running'''),'materialization atomically binds the R2 digest before execution');
select ok((select pg_get_functiondef('exam_delivery.persist_verified_python_grading_evidence(uuid,uuid,uuid,uuid,text,text,text,text,integer,integer,jsonb)'::regprocedure) ~ '''replayed'', true[\s\S]+grading_evidence_replay'),'R5 persistence is exactly idempotent and rejects conflicting replay');
select ok((select pg_get_functiondef('exam_delivery.submit_attempt_v2_with_trusted_grading(uuid,uuid,uuid)'::regprocedure) ~ 'grading_incomplete[\s\S]+workspaceRevision[\s\S]+workspaceHash'),'generic scoring fails closed and hashes the final workspace identity');
select ok((select pg_get_functiondef('exam_delivery.submit_attempt_v2(uuid,uuid,uuid)'::regprocedure) ~ 'python_submission_grading_sessions[\s\S]+submit_attempt_v2_with_trusted_grading'),'generic submit routes claimed executable attempts through trusted grading');
select ok((select pg_get_functiondef('exam_delivery.publish_package_v2(jsonb)'::regprocedure) ~ 'executable-python-lab-v1[\s\S]+privateScoring[\s\S]+trustedGrading'),'publication validates and retains executable protected scoring material');
select ok((select pg_get_functiondef('exam_delivery.package_v2_runtime_supported(text,text,text)'::regprocedure) ~ 'certsim-python-next-generation-canonical-forms-v1[\s\S]+certsim-python-trusted-grading-v1'),'runtime registry contains the Python Next Generation trusted tuple');
select ok((select pg_get_functiondef('exam_delivery.score_attempt_item_with_trusted_grading(uuid,uuid,uuid,text,text,jsonb,jsonb,jsonb,boolean)'::regprocedure) ~ 'python_grading_evidence[\s\S]+earned_raw_points[\s\S]+maximum_raw_points'),'executable scoring consumes only durable verified raw points');

select has_column('exam_delivery','python_execution_runs','client_request_id','runs bind stable browser idempotency separately from server execution identity');
select has_column('exam_delivery','python_execution_runs','wall_time_ms','runs persist the fixed wall-time fact');
select has_column('exam_delivery','python_execution_runs','memory_bytes','runs persist the fixed memory fact');
select has_column('exam_delivery','python_execution_runs','output_bytes','runs persist the fixed output fact');
select has_column('exam_delivery','python_execution_runs','learner_stdout','runs persist bounded learner stdout');
select has_column('exam_delivery','python_execution_runs','learner_stderr','runs persist bounded learner stderr');
select has_column('exam_delivery','python_execution_runs','learner_exit_code','runs persist bounded learner exit status');

select has_function('exam_delivery','begin_python_execution',array['uuid','uuid','uuid','integer','uuid','uuid','text','integer','bigint','integer']);
select has_function('exam_delivery','complete_python_execution',array['uuid','text','text','text','text','text','text','text','integer','boolean']);
select has_function('exam_delivery','get_python_execution_authority',array['uuid','uuid','uuid','uuid']);
select has_function('public','certsim_service_begin_python_execution',array['uuid','uuid','uuid','integer','uuid','uuid','text','integer','bigint','integer']);
select has_function('public','certsim_service_complete_python_execution',array['uuid','text','text','text','text','text','text','text','integer','boolean']);
select has_function('public','certsim_service_get_python_execution_authority',array['uuid','uuid','uuid','uuid']);

select ok(has_function_privilege('service_role','public.certsim_service_begin_python_execution(uuid,uuid,uuid,integer,uuid,uuid,text,integer,bigint,integer)','EXECUTE'),'service role can begin an authenticated execution');
select ok(has_function_privilege('service_role','public.certsim_service_complete_python_execution(uuid,text,text,text,text,text,text,text,integer,boolean)','EXECUTE'),'service role can persist a terminal execution');
select ok(has_function_privilege('service_role','public.certsim_service_get_python_execution_authority(uuid,uuid,uuid,uuid)','EXECUTE'),'service role can recover immutable execution authority');
select ok(not has_function_privilege('authenticated','public.certsim_service_begin_python_execution(uuid,uuid,uuid,integer,uuid,uuid,text,integer,bigint,integer)','EXECUTE'),'browser cannot begin trusted execution directly');
select ok(not has_function_privilege('anon','public.certsim_service_get_python_execution_authority(uuid,uuid,uuid,uuid)','EXECUTE'),'anonymous callers cannot inspect execution authority');
select ok(to_regclass('exam_delivery.python_execution_runs_client_request_unique') is not null,'client execution request IDs are globally idempotent');

select * from finish();
rollback;
