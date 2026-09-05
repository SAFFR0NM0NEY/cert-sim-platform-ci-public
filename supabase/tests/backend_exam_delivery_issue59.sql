begin;
select plan(64);

select has_column('exam_delivery','exam_entitlements','source_assignment_id','assignment provenance exists');
select has_function('exam_delivery','reconcile_assignment_entitlements',array['uuid']);
select has_function('exam_delivery','abandon_attempt',array['uuid','uuid','uuid']);
select has_function('public','certsim_protected_abandon_attempt',array['uuid','uuid','uuid']);
select has_function('exam_delivery','staff_dashboard_aggregates',array['uuid','jsonb']);
select has_function('exam_delivery','validate_practice_assignment',array['uuid','text','text','uuid']);
select has_function('exam_delivery','apply_practice_assignment_attribution',array[]::text[]);
select is(exam_delivery.normalize_exam_key('security-plus'),'securityplussy0701','catalog Security+ alias is canonical');
select is(exam_delivery.normalize_exam_key('security-plus-sy0-701'),'securityplussy0701','full Security+ identity remains canonical');
select is(exam_delivery.normalize_exam_key('az204'),'az204','AZ-204 identity is unchanged');
select is(exam_delivery.normalize_exam_key('az400'),'az400','AZ-400 identity is unchanged');
select is(exam_delivery.normalize_exam_key('ai901'),'ai901','AI-901 identity is unchanged');
select ok((select prosecdef and proconfig @> array['search_path=""','statement_timeout=8s'] from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='reconcile_assignment_entitlements'),'reconciliation is bounded and search-path safe');
select ok((select prosecdef and proconfig @> array['search_path=""','statement_timeout=5s'] from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='abandon_attempt'),'abandon is bounded and search-path safe');
select ok(not has_function_privilege('authenticated','exam_delivery.reconcile_assignment_entitlements(uuid)','EXECUTE'),'browser cannot invoke reconciliation');
select ok(not has_function_privilege('authenticated','exam_delivery.abandon_attempt(uuid,uuid,uuid)','EXECUTE'),'browser cannot invoke private abandon');
select ok(has_function_privilege('service_role','public.certsim_protected_abandon_attempt(uuid,uuid,uuid)','EXECUTE'),'fixed Edge runtime can invoke abandon wrapper');
select ok(not has_function_privilege('authenticated','public.certsim_protected_abandon_attempt(uuid,uuid,uuid)','EXECUTE'),'browser cannot bypass Edge abandon boundary');
select ok(has_function_privilege('authenticated','public.certsim_grant_purchase_entitlement(uuid,uuid,uuid[],text,text,timestamptz)','EXECUTE'),'role-checked owner purchase fulfilment contract is callable');
select ok(not has_function_privilege('service_role','public.certsim_grant_purchase_entitlement(uuid,uuid,uuid[],text,text,timestamptz)','EXECUTE'),'service role cannot bypass purchase actor attribution');
select ok(not has_function_privilege('anon','public.certsim_grant_purchase_entitlement(uuid,uuid,uuid[],text,text,timestamptz)','EXECUTE'),'anonymous purchase fulfilment remains denied');
select has_function('exam_delivery','reconcile_expired_formal_attempts',array['uuid','uuid']);
select ok((select prosecdef and proconfig @> array['search_path=""','statement_timeout=5s'] from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='reconcile_expired_formal_attempts'),'stale formal reconciliation is bounded and search-path safe');
select ok(not has_function_privilege('authenticated','exam_delivery.reconcile_expired_formal_attempts(uuid,uuid)','EXECUTE'),'browser cannot invoke stale formal reconciliation');
select ok((select pg_get_functiondef(p.oid) ~ 'expires_at <= statement_timestamp\(\)' and pg_get_functiondef(p.oid) ~ 'attempt_results' and pg_get_functiondef(p.oid) ~ 'review_snapshots' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='reconcile_expired_formal_attempts'),'reconciliation expires only elapsed formal rows and fails closed on terminal state');
select ok((select pg_get_functiondef(p.oid) ~ 'reconcile_expired_formal_attempts' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='start_practice_issue59_attribution_base'),'shared start boundary reconciles stale formal rows');
select ok((select pg_get_indexdef(indexrelid) ~ 'purpose.*assigned_assessment.*self_directed_exam' from pg_index where indexrelid='exam_delivery.attempts_one_active_profile_idx'::regclass),'profile-wide uniqueness is restricted to formal attempts');
select ok((select count(*)=2 from pg_indexes where schemaname='exam_delivery' and indexname in ('attempts_one_active_profile_idx','attempts_one_active_purpose_idx')),'formal and purpose-aware active-attempt indexes coexist');
select ok((select pg_get_functiondef(p.oid) ~ 'source_assignment_id is null' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_aggregates'),'assignment analytics includes guarded historical fallback');
select ok((select pg_get_functiondef(p.oid) ~ 'assigned_assessment.*self_directed_exam' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='materialize_attempt_items'),'both timed purposes use fixed composition');
select ok((select pg_get_functiondef(p.oid) ~ 'groupSize.*long' and pg_get_functiondef(p.oid) ~ 'groupSize.*short' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='fixed_profile_case_keys'),'materializer selects long and short case groups independently');
select ok((select pg_get_functiondef(p.oid) ~ 'v_case_target[[:space:]]*/[[:space:]]*v_case_count' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='fixed_profile_case_keys'),'materializer fixes generic case scored size');
select ok(
  (select pg_get_functiondef(p.oid) ~ 'learner_weak_domain_evidence'
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='exam_delivery' and p.proname='practice_availability_issue59_enriched')
  and
  (select pg_get_functiondef(p.oid) ~ 'attempt.package_version_id = p_package_version_id'
     and pg_get_functiondef(p.oid) !~ 'attempt.package_profile_id'
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='exam_delivery' and p.proname='learner_weak_domain_evidence'),
  'weak-area availability delegates same-package cross-profile evidence to private helper'
);
select ok((select pg_get_functiondef(p.oid) ~ 'source_assignment_id assignment_id' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='list_history'),'learner history exposes safe assignment provenance');
select ok((select pg_get_functiondef(p.oid) ~ '''groups''' and pg_get_functiondef(p.oid) ~ '''assignments''' and pg_get_functiondef(p.oid) ~ '''domains''' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_aggregates'),'staff analytics includes complete aggregate dimensions');
select ok(not has_function_privilege('authenticated','exam_delivery.validate_practice_assignment(uuid,text,text,uuid)','EXECUTE'),'assignment validator remains private');
select ok((select pg_get_functiondef(p.oid) ~ 'owner_id = p_actor_id' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='abandon_attempt'),'abandon enforces ownership');
select ok((select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='exam_delivery' and c.relname='exam_entitlements'),'entitlement RLS remains enabled');
select ok((select pg_get_functiondef(p.oid) ~ 'prior.package_version_id=v_attempt.package_version_id' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='materialize_attempt_items'),'materializer uses same-package evidence across profiles');
select ok((select pg_get_functiondef(p.oid) ~ 'v_assignment_continuation' and pg_get_functiondef(p.oid) ~ 'source_assignment_id' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='authorize_attempt_continuation'),'validated assignment attempt continuation survives source deadline');
select ok((select pg_get_functiondef(p.oid) ~ 'replacementPermitted' and pg_get_functiondef(p.oid) ~ 'assignment.due_at>statement_timestamp' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='list_current_attempt_bindings'),'replacement permission reflects current assignment deadline');
select ok((select pg_get_functiondef(p.oid) ~ '''assignment_conflict''' and pg_get_functiondef(p.oid) ~ 'sqlstate ''42501''' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='practice_availability'),'known assignment denial is a safe business result');
select ok((select pg_get_functiondef(p.oid) ~ 'selected_assignment' and pg_get_functiondef(p.oid) ~ 'candidate.organisation_id' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_query_issue59_base'),'raw selected-assignment history has guarded compatibility fallback');
select ok((select pg_get_functiondef(p.oid) ~ 'learner_scopes' and pg_get_functiondef(p.oid) ~ 'assignment_targets' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_aggregates'),'assigned no-activity learner scopes are retained');
select ok((select pg_get_functiondef(p.oid) ~ '''assignmentLearners''' and pg_get_functiondef(p.oid) ~ 'assignment_attempt_count' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_aggregates'),'assignment learner outcomes are aggregated independently');
select ok((select pg_get_functiondef(p.oid) ~ '''latestAttemptId''' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_aggregates'),'latest attempt metadata is available without content');
select ok((select pg_get_functiondef(p.oid) ~ 'passed is false or raw_percentage < 75' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_aggregates'),'passing scores below 75 percent remain analytics needs-review');
select has_function('exam_delivery','sync_profile_activation_assignments',array[]::text[]);
select has_function('exam_delivery','learner_weak_domain_evidence',array['uuid','uuid']);
select ok(not has_function_privilege('authenticated','exam_delivery.learner_weak_domain_evidence(uuid,uuid)','EXECUTE'),'browser cannot invoke private weak-domain evidence');
select ok((select prosecdef and proconfig @> array['search_path=""','statement_timeout=8s'] from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='learner_weak_domain_evidence'),'weak-domain evidence is bounded and search-path safe');
select ok((select pg_get_functiondef(p.oid) ~ 'classify_legacy_result' and pg_get_functiondef(p.oid) ~ 'normalize_exam_key' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='learner_weak_domain_evidence'),'legacy evidence is classified and same-exam scoped');
select ok((select pg_get_functiondef(p.oid) ~ 'target_domain and \(missed or weak_domain\)' and pg_get_functiondef(p.oid) ~ 'learner_weak_domain_evidence' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='materialize_attempt_items'),'weak-area materialization uses selected current-package domain evidence');
select ok((select prosecdef and proconfig @> array['search_path=""','statement_timeout=8s'] from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='sync_profile_activation_assignments'),'activation reconciliation trigger is bounded and definer safe');
select ok(exists(select 1 from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='exam_delivery' and c.relname='exam_profile_activations' and t.tgname='sync_profile_activation_assignments' and not t.tgisinternal),'production activation changes trigger assignment reconciliation');
select ok((select pg_get_functiondef(p.oid) ~ '''assignmentId'',v.source_assignment_id' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='resume_attempt'),'resume DTO preserves assignment provenance');
select ok((select pg_get_functiondef(p.oid) ~ 'v_existing.source_assignment_id=v_assignment_id' and pg_get_functiondef(p.oid) ~ 'v_existing.source_assignment_id is null' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='start_practice'),'start reuse requires exact assignment context');
select ok((select pg_get_functiondef(p.oid) ~ 'activity_count > 0' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_aggregates'),'learners with activity exclude zero-activity learner rows');
select ok((select pg_get_functiondef(p.oid) ~ 'passed_count\*100.0/decided_count' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='staff_dashboard_aggregates'),'pass rate excludes undecided attempts from its denominator');

insert into exam_delivery.package_versions(id,exam_key,package_version,source_commit_sha,validation_hash,package_hash,package_schema_version,generator_version,scorer_version)
values
('59000000-0000-4000-8000-000000000001','fixture-204','1','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',repeat('a',64),repeat('b',64),'fixture','fixture','fixture'),
('59000000-0000-4000-8000-000000000002','fixture-400','1','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',repeat('c',64),repeat('d',64),'fixture','fixture','fixture');

with groups as (
  select 'long-'||g group_key,7 size from generate_series(1,4) g
  union all select 'short-'||g,3 from generate_series(1,4) g
), records as (
  select group_key,0 member,'context' role,size from groups
  union all select group_key,member,'question',size from groups cross join lateral generate_series(1,size) member
), inserted as (
  insert into exam_delivery.package_questions(package_version_id,question_id,question_type,domain_key,section_key,source_ordinal,presentation_payload,content_hash)
  select '59000000-0000-4000-8000-000000000001',group_key||'-'||member,
    case when role='context' then 'case-study-context' else 'single-choice' end,'d','case',
    row_number() over(order by group_key,member),'{}',repeat('e',64) from records returning *
)
insert into exam_delivery.package_question_protected_content(question_id,package_version_id,scoring_payload,review_payload,authoring_metadata)
select id,package_version_id,'{}','{}',jsonb_build_object('scored',question_type<>'case-study-context','group',jsonb_build_object(
  'groupKey',regexp_replace(question_id,'-[0-9]+$',''),'role',case when question_type='case-study-context' then 'context' else 'question' end,
  'groupSize',case when question_id like 'long-%' then 'long' else 'short' end)) from inserted;

with groups as (
  select 'six-'||g group_key,6 size from generate_series(1,4) g
  union all select 'five-'||g,5 from generate_series(1,4) g
), records as (
  select group_key,0 member,'context' role,size from groups
  union all select group_key,member,'question',size from groups cross join lateral generate_series(1,size) member
), inserted as (
  insert into exam_delivery.package_questions(package_version_id,question_id,question_type,domain_key,section_key,source_ordinal,presentation_payload,content_hash)
  select '59000000-0000-4000-8000-000000000002',group_key||'-'||member,
    case when role='context' then 'case-study-context' else 'single-choice' end,'d','case',
    row_number() over(order by group_key,member),'{}',repeat('f',64) from records returning *
)
insert into exam_delivery.package_question_protected_content(question_id,package_version_id,scoring_payload,review_payload,authoring_metadata)
select id,package_version_id,'{}','{}',jsonb_build_object('scored',question_type<>'case-study-context','group',jsonb_build_object(
  'groupKey',regexp_replace(question_id,'-[0-9]+$',''),'role',case when question_type='case-study-context' then 'context' else 'question' end)) from inserted;

select ok((select cardinality(keys)=1 and keys[1] like 'long-%' from (select exam_delivery.fixed_profile_case_keys('59000000-0000-4000-8000-000000000001','59000000-0000-4000-8000-000000000011',50,
  '{"longCaseStudyCount":1,"shortCaseStudyCount":0,"normalScoredQuestionCount":43,"pbqCount":0}'::jsonb) keys) selected),'AZ-204 standard selects one seven-question long case');
select is(cardinality(exam_delivery.fixed_profile_case_keys('59000000-0000-4000-8000-000000000001','59000000-0000-4000-8000-000000000012',40,
  '{"longCaseStudyCount":0,"shortCaseStudyCount":1,"normalScoredQuestionCount":37,"pbqCount":0}'::jsonb)),1,'AZ-204 compact selects one three-question short case');
select is(cardinality(exam_delivery.fixed_profile_case_keys('59000000-0000-4000-8000-000000000001','59000000-0000-4000-8000-000000000013',60,
  '{"longCaseStudyCount":1,"shortCaseStudyCount":1,"normalScoredQuestionCount":50,"pbqCount":0}'::jsonb)),2,'AZ-204 full selects one long and one short case');
select is(cardinality(exam_delivery.fixed_profile_case_keys('59000000-0000-4000-8000-000000000001','59000000-0000-4000-8000-000000000014',50,
  '{"longCaseStudyCount":1,"shortCaseStudyCount":1,"normalScoredQuestionCount":40,"pbqCount":0}'::jsonb)),2,'AZ-204 case-heavy selects one long and one short case');
select is(cardinality(exam_delivery.fixed_profile_case_keys('59000000-0000-4000-8000-000000000002','59000000-0000-4000-8000-000000000015',80,
  '{"caseStudyCount":2,"standardQuestionCount":66,"pbqCount":2}'::jsonb)),2,'AZ-400 Sectioned selects two six-question case groups for exact 66/12/2 composition');

select * from finish();
rollback;
