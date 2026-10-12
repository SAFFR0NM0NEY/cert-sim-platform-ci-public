begin;
create extension if not exists pgtap with schema extensions;
select plan(54);

select has_table('exam_delivery','sc200_successor_cutover_requests','private cutover audit exists');
select ok((select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='exam_delivery' and c.relname='sc200_successor_cutover_requests'),'cutover audit has RLS defense in depth');
select is((select count(*)::integer from pg_policies where schemaname='exam_delivery' and tablename='sc200_successor_cutover_requests'),0,'cutover audit has no browser policy');
select ok(not has_table_privilege('authenticated','exam_delivery.sc200_successor_cutover_requests','SELECT,INSERT,UPDATE,DELETE'),'authenticated cannot access cutover audit');
select ok(not has_table_privilege('service_role','exam_delivery.sc200_successor_cutover_requests','SELECT,INSERT,UPDATE,DELETE'),'service role cannot access cutover audit');
select has_function('exam_delivery','cutover_sc200_successor_release',array['uuid','jsonb'],'private cutover exists');
select has_function('public','certsim_cutover_sc200_successor_release',array['jsonb'],'checked cutover wrapper exists');
select ok(not (select prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='cutover_sc200_successor_release'),'private cutover is invoker under checked wrapper');
select ok((select prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='certsim_cutover_sc200_successor_release'),'public checked boundary is definer');
select ok((select proconfig @> array['search_path=""','statement_timeout=10s'] from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='cutover_sc200_successor_release'),'private cutover has empty path and timeout');
select ok((select proconfig @> array['search_path=""','statement_timeout=10s'] from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='certsim_cutover_sc200_successor_release'),'wrapper has empty path and timeout');
select ok(has_function_privilege('authenticated','public.certsim_cutover_sc200_successor_release(jsonb)','EXECUTE'),'authenticated can reach checked wrapper');
select ok(not has_function_privilege('anon','public.certsim_cutover_sc200_successor_release(jsonb)','EXECUTE'),'anon denied cutover wrapper');
select ok(not has_function_privilege('service_role','public.certsim_cutover_sc200_successor_release(jsonb)','EXECUTE'),'service role denied cutover wrapper');
select ok(not has_function_privilege('authenticated','exam_delivery.cutover_sc200_successor_release(uuid,jsonb)','EXECUTE'),'browser cannot bypass wrapper');
select ok((select pg_get_functiondef(p.oid) ~ 'auth.uid\(\)' and pg_get_functiondef(p.oid) ~ 'platform_owner' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='certsim_cutover_sc200_successor_release'),'actor derives from auth and requires active Platform Owner');
select ok((select pg_get_functiondef(p.oid) ~ 'json_has_exact_keys' and pg_get_functiondef(p.oid) ~ 'predecessorPackageVersion' and pg_get_functiondef(p.oid) ~ 'compactProfileKey' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='cutover_sc200_successor_release'),'request keys are allowlisted');
select ok((select pg_get_functiondef(p.oid) ~ '''sc200''' and pg_get_functiondef(p.oid) ~ '''1.0.0''' and pg_get_functiondef(p.oid) ~ '''1.1.0''' and pg_get_functiondef(p.oid) ~ '''sc200-full''' and pg_get_functiondef(p.oid) ~ '''sc200-compact''' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='cutover_sc200_successor_release'),'transition identity is pinned');
select ok((select pg_get_functiondef(p.oid) ~ '305085dea2431a978941c3d13b3dfddc9cd3a1706d16ee2869157094fb20782d' and pg_get_functiondef(p.oid) ~ '2a2cd94e7d2dc491bea3e414263e61819f92ae5de77e634e3bbd9c2288d9abdb' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='cutover_sc200_successor_release'),'both immutable package hashes are pinned');
select ok((select pg_get_functiondef(p.oid) ~ 'package_v2_runtime_supported' and pg_get_functiondef(p.oid) ~ 'package_form_questions' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='cutover_sc200_successor_release'),'successor runtime and form structure are checked');
select ok((select pg_get_functiondef(p.oid) ~ 'sc200_successor_cutover_active_attempt' and pg_get_functiondef(p.oid) ~ 'expires_at[[:space:]]*>[[:space:]]*v_now' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='cutover_sc200_successor_release'),'server-time lifecycle guard is present');
select ok((select pg_get_functiondef(p.oid) ~ 'sc200_successor_cutover_state_conflict' and pg_get_functiondef(p.oid) ~ 'for update' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='cutover_sc200_successor_release'),'predecessor state is locked and fail-closed');
select ok((select pg_get_functiondef(p.oid) ~ 'enabled[[:space:]]*=[[:space:]]*false' and pg_get_functiondef(p.oid) ~ 'disabled_at[[:space:]]*=[[:space:]]*v_now' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='cutover_sc200_successor_release'),'predecessor activation is retained disabled');
select ok((select pg_get_functiondef(p.oid) ~ 'access_mode[[:space:]]*=[[:space:]]*''disabled''' and pg_get_functiondef(p.oid) ~ 'package_version[[:space:]]*=[[:space:]]*''1.0.0''' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='cutover_sc200_successor_release'),'predecessor policies are retained disabled');
select ok((select pg_get_functiondef(p.oid) ~ 'production_authorized' and pg_get_functiondef(p.oid) ~ 'immediate_study_feedback' and pg_get_functiondef(p.oid) ~ 'after_submission' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='cutover_sc200_successor_release'),'successor policy template is fixed');
select ok((select pg_get_functiondef(p.oid) ~ 'sc200_successor_cutover_request_conflict' and pg_get_functiondef(p.oid) ~ 'sc200_successor_cutover_replay_conflict' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='cutover_sc200_successor_release'),'idempotent replay is exact and drift-safe');
select ok((select pg_get_functiondef(p.oid) !~* 'insert into exam_delivery\.(attempts|exam_entitlements|protected_assignments)' and pg_get_functiondef(p.oid) !~* 'delete[[:space:]]+from|truncate' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='cutover_sc200_successor_release'),'cutover creates no learner lifecycle/access rows and deletes nothing');
select ok((select pg_get_functiondef(p.oid) ~ 'package_profile_defaults' and pg_get_functiondef(p.oid) ~ 'current_version[[:space:]]*=[[:space:]]*''1.1.0''' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='cutover_sc200_successor_release'),'defaults and catalogue move to successor');

-- Disposable SC-200 successor fixture. No production identifiers or content are used.
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values
('00000000-0000-0000-0000-000000000000','83000000-0000-0000-0000-000000000001','authenticated','authenticated','owner83@example.invalid','','{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','83000000-0000-0000-0000-000000000002','authenticated','authenticated','learner83@example.invalid','','{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','83000000-0000-0000-0000-000000000003','authenticated','authenticated','other83@example.invalid','','{}','{}',now(),now());
update public.profiles set status='active' where id::text like '83000000-%';
insert into public.organisations(id,name,organisation_type,status) values
('83000000-0000-0000-0000-000000000010','Issue 83 successor fixture','internal','active');
insert into public.memberships(user_id,organisation_id,role,status) values
('83000000-0000-0000-0000-000000000001','83000000-0000-0000-0000-000000000010','platform_owner','active'),
('83000000-0000-0000-0000-000000000002','83000000-0000-0000-0000-000000000010','student','active');

insert into exam_delivery.package_versions(id,exam_key,package_version,source_commit_sha,validation_hash,package_hash,
  package_schema_version,generator_version,scorer_version,status,published_at,declared_review_release_policy,declared_answer_release_policy) values
('83000000-0000-0000-0000-000000000100','sc200','1.0.0',repeat('1',40),repeat('2',64),'305085dea2431a978941c3d13b3dfddc9cd3a1706d16ee2869157094fb20782d','certsim-protected-package-v2','certsim-sc200-canonical-forms-v1','certsim-selected-response-partial-v1','draft',null,'after_submission','after_submission'),
('83000000-0000-0000-0000-000000000110','sc200','1.1.0',repeat('3',40),repeat('4',64),'2a2cd94e7d2dc491bea3e414263e61819f92ae5de77e634e3bbd9c2288d9abdb','certsim-protected-package-v2','certsim-sc200-canonical-forms-v1','certsim-selected-response-partial-v1','draft',null,'after_submission','after_submission');
insert into exam_delivery.package_profiles(id,package_version_id,profile_key,display_name,question_count,time_limit_minutes) values
('83000000-0000-0000-0000-000000000101','83000000-0000-0000-0000-000000000100','sc200-full','SC-200 Full',50,100),
('83000000-0000-0000-0000-000000000111','83000000-0000-0000-0000-000000000110','sc200-full','SC-200 Full',50,100),
('83000000-0000-0000-0000-000000000112','83000000-0000-0000-0000-000000000110','sc200-compact','SC-200 Compact',25,50);
insert into exam_delivery.package_questions(id,package_version_id,question_id,question_type,domain_key,section_key,source_ordinal,presentation_payload,content_hash)
select gen_random_uuid(),'83000000-0000-0000-0000-000000000110','issue83-q-'||n,'single-choice','domain-'||((n-1)%3+1),'objective-'||((n-1)%9+1),n,'{}',md5(n::text)||md5(n::text)
from generate_series(1,300) n;
insert into exam_delivery.package_question_protected_content(question_id,package_version_id,scoring_payload,review_payload,authoring_metadata)
select id,package_version_id,'{}','{}','{}' from exam_delivery.package_questions where package_version_id='83000000-0000-0000-0000-000000000110';
insert into exam_delivery.package_forms(id,package_version_id,package_profile_id,form_key,form_ordinal,question_count,membership_hash,blueprint_contract)
select gen_random_uuid(),'83000000-0000-0000-0000-000000000110','83000000-0000-0000-0000-000000000111','full-'||n,n,50,repeat(to_hex(n),64)::text,'{}' from generate_series(1,6) n;
insert into exam_delivery.package_forms(id,package_version_id,package_profile_id,form_key,form_ordinal,question_count,membership_hash,blueprint_contract)
select gen_random_uuid(),'83000000-0000-0000-0000-000000000110','83000000-0000-0000-0000-000000000112','compact-'||n,n,25,repeat(to_hex(n+6),64)::text,'{}' from generate_series(1,6) n;
insert into exam_delivery.package_form_questions(form_id,package_profile_id,package_version_id,package_question_id,presentation_ordinal)
select f.id,f.package_profile_id,f.package_version_id,q.id,q.source_ordinal-(f.form_ordinal-1)*50
from exam_delivery.package_forms f join exam_delivery.package_questions q on q.package_version_id=f.package_version_id
  and q.source_ordinal between (f.form_ordinal-1)*50+1 and f.form_ordinal*50
where f.package_profile_id='83000000-0000-0000-0000-000000000111';
insert into exam_delivery.package_form_questions(form_id,package_profile_id,package_version_id,package_question_id,presentation_ordinal)
select f.id,f.package_profile_id,f.package_version_id,q.id,q.source_ordinal-(f.form_ordinal-1)*25
from exam_delivery.package_forms f join exam_delivery.package_questions q on q.package_version_id=f.package_version_id
  and q.source_ordinal between (f.form_ordinal-1)*25+1 and f.form_ordinal*25
where f.package_profile_id='83000000-0000-0000-0000-000000000112';
update exam_delivery.package_versions set status='published',published_at=now() where id in ('83000000-0000-0000-0000-000000000100','83000000-0000-0000-0000-000000000110');

insert into exam_delivery.exam_profile_activations(package_version_id,package_profile_id,enabled,activation_kind,enabled_at,created_by)
values('83000000-0000-0000-0000-000000000100','83000000-0000-0000-0000-000000000101',true,'production',now(),'83000000-0000-0000-0000-000000000001');
insert into exam_delivery.practice_policies(canonical_exam_key,package_version,profile_key,purpose,access_mode,enabled,maximum_completed_attempts,maximum_session_items,immediate_feedback,review_release_policy,answer_release_policy)
select 'sc200','1.0.0','sc200-full',purpose::exam_delivery.attempt_purpose,'production_authorized',true,null,50,purpose='study_sandbox',case when purpose='study_sandbox' then 'immediate_study_feedback' else 'after_submission' end,case when purpose='study_sandbox' then 'immediate_study_feedback' else 'after_submission' end
from unnest(array['self_directed_exam','study_sandbox','targeted_domain','weak_area','pbq_practice']) purpose;
insert into exam_delivery.package_profile_defaults(canonical_exam_key,profile_key,purpose,package_version_id,package_profile_id,enabled,configured_by)
select 'sc200','sc200-full',purpose::exam_delivery.attempt_purpose,'83000000-0000-0000-0000-000000000100','83000000-0000-0000-0000-000000000101',true,'83000000-0000-0000-0000-000000000001'
from unnest(array['assigned_assessment','self_directed_exam','study_sandbox','targeted_domain','weak_area','pbq_practice']) purpose;
insert into public.exam_catalog(exam_key,slug,title,vendor,lifecycle,exam_type,source_type,current_version,status)
values('sc200','sc200','SC-200: Microsoft Security Operations Analyst','Microsoft','production_ready','certification','official_source','1.0.0','active');
insert into public.exam_assignments(id,organisation_id,student_user_id,exam_catalog_id,exam_key,profile_id,title,assigned_by,assignment_type,status,available_from,contract_version,package_version_id,package_profile_id,maximum_attempts,review_release_policy,answer_release_policy,creation_request_id)
select '83000000-0000-0000-0000-000000000200','83000000-0000-0000-0000-000000000010','83000000-0000-0000-0000-000000000002',c.id,'sc200','sc200-full','SC-200 fixture','83000000-0000-0000-0000-000000000001','assessment','active',now(),'live-v2','83000000-0000-0000-0000-000000000100','83000000-0000-0000-0000-000000000101',1,'after_submission','after_submission','83000000-0000-0000-0000-000000000201'
from public.exam_catalog c where c.exam_key='sc200';
select throws_ok($$select exam_delivery.cutover_sc200_successor_release('83000000-0000-0000-0000-000000000001','{"examKey":"sc200","predecessorPackageVersion":"1.0.0","successorPackageVersion":"9.9.9","fullProfileKey":"sc200-full","compactProfileKey":"sc200-compact","requestId":"83000000-0000-0000-0000-000000000300"}')$$,'22023','sc200_successor_cutover_unsupported','wrong successor version is rejected');
insert into exam_delivery.attempts(id,owner_id,package_version_id,package_profile_id,client_request_id,status,generator_version,scorer_version,started_at,expires_at,purpose)
values('83000000-0000-0000-0000-000000000400','83000000-0000-0000-0000-000000000002','83000000-0000-0000-0000-000000000100','83000000-0000-0000-0000-000000000101','83000000-0000-0000-0000-000000000401','in_progress','fixture','fixture',now(),now()+interval '1 hour','self_directed_exam');
select throws_ok($$select exam_delivery.cutover_sc200_successor_release('83000000-0000-0000-0000-000000000001','{"examKey":"sc200","predecessorPackageVersion":"1.0.0","successorPackageVersion":"1.1.0","fullProfileKey":"sc200-full","compactProfileKey":"sc200-compact","requestId":"83000000-0000-0000-0000-000000000300"}')$$,'55000','sc200_successor_cutover_active_attempt','active attempt blocks cutover');
update exam_delivery.attempts set status='abandoned' where id='83000000-0000-0000-0000-000000000400';
update exam_delivery.practice_policies set enabled=false,access_mode='disabled' where canonical_exam_key='sc200' and package_version='1.0.0' and purpose='weak_area';
select throws_ok($$select exam_delivery.cutover_sc200_successor_release('83000000-0000-0000-0000-000000000001','{"examKey":"sc200","predecessorPackageVersion":"1.0.0","successorPackageVersion":"1.1.0","fullProfileKey":"sc200-full","compactProfileKey":"sc200-compact","requestId":"83000000-0000-0000-0000-000000000300"}')$$,'55000','sc200_successor_cutover_state_conflict','predecessor drift blocks cutover');
update exam_delivery.practice_policies set enabled=true,access_mode='production_authorized' where canonical_exam_key='sc200' and package_version='1.0.0' and purpose='weak_area';
create function exam_delivery.issue83_reject_catalogue_cutover() returns trigger language plpgsql set search_path='' as $$begin if new.current_version='1.1.0' then raise exception 'issue83_forced_failure'; end if; return new; end$$;
create trigger issue83_reject_catalogue_cutover before update on public.exam_catalog for each row execute function exam_delivery.issue83_reject_catalogue_cutover();
select throws_ok($$select exam_delivery.cutover_sc200_successor_release('83000000-0000-0000-0000-000000000001','{"examKey":"sc200","predecessorPackageVersion":"1.0.0","successorPackageVersion":"1.1.0","fullProfileKey":"sc200-full","compactProfileKey":"sc200-compact","requestId":"83000000-0000-0000-0000-000000000300"}')$$,'P0001','issue83_forced_failure','forced mid-cutover failure propagates');
select is((select count(*)::integer from exam_delivery.exam_profile_activations where package_version_id='83000000-0000-0000-0000-000000000100' and enabled),1,'forced failure preserves predecessor activation');
select is((select count(*)::integer from exam_delivery.practice_policies where package_version='1.0.0' and enabled),5,'forced failure preserves predecessor policies');
select is((select count(*)::integer from exam_delivery.exam_profile_activations where package_version_id='83000000-0000-0000-0000-000000000110'),0,'forced failure rolls back target activations');
select is((select count(*)::integer from exam_delivery.sc200_successor_cutover_requests),0,'forced failure records no success audit');
drop trigger issue83_reject_catalogue_cutover on public.exam_catalog;
drop function exam_delivery.issue83_reject_catalogue_cutover();

select lives_ok($$select exam_delivery.cutover_sc200_successor_release('83000000-0000-0000-0000-000000000001','{"examKey":"sc200","predecessorPackageVersion":"1.0.0","successorPackageVersion":"1.1.0","fullProfileKey":"sc200-full","compactProfileKey":"sc200-compact","requestId":"83000000-0000-0000-0000-000000000300"}')$$,'exact successor cutover succeeds');
select is((select count(*)::integer from exam_delivery.exam_profile_activations where package_version_id='83000000-0000-0000-0000-000000000110' and enabled),2,'Full and Compact activations enabled');
select is((select count(*)::integer from exam_delivery.exam_profile_activations where package_version_id='83000000-0000-0000-0000-000000000100' and not enabled and disabled_at is not null),1,'predecessor activation retained disabled');
select is((select count(*)::integer from exam_delivery.practice_policies where package_version='1.0.0' and not enabled and access_mode='disabled'),5,'predecessor policies retained disabled');
select is((select count(*)::integer from exam_delivery.practice_policies where package_version='1.1.0' and profile_key in ('sc200-full','sc200-compact') and enabled and access_mode='production_authorized'),10,'successor policies enabled for both profiles');
select is((select count(*)::integer from exam_delivery.package_profile_defaults where canonical_exam_key='sc200' and package_version_id='83000000-0000-0000-0000-000000000110' and enabled),12,'all successor defaults moved');
select is((select count(*)::integer from public.exam_catalog where exam_key='sc200' and current_version='1.1.0' and status='active' and lifecycle='production_ready'),1,'catalogue moved to successor');
select is((select count(*)::integer from exam_delivery.package_versions where id='83000000-0000-0000-0000-000000000100' and status='published'),1,'historical package remains published');
select is((select count(*)::integer from exam_delivery.attempts where id='83000000-0000-0000-0000-000000000400' and package_version_id='83000000-0000-0000-0000-000000000100' and status='abandoned'),1,'historical attempt retains predecessor identity');
select is((select count(*)::integer from exam_delivery.sc200_successor_cutover_requests where request_id='83000000-0000-0000-0000-000000000300' and status='succeeded'),1,'one cutover audit recorded');
select lives_ok($$select exam_delivery.cutover_sc200_successor_release('83000000-0000-0000-0000-000000000001','{"examKey":"sc200","predecessorPackageVersion":"1.0.0","successorPackageVersion":"1.1.0","fullProfileKey":"sc200-full","compactProfileKey":"sc200-compact","requestId":"83000000-0000-0000-0000-000000000300"}')$$,'same request safely replays');
select is((select count(*)::integer from exam_delivery.sc200_successor_cutover_requests),1,'replay creates no duplicate audit');
select throws_ok($$select exam_delivery.cutover_sc200_successor_release('83000000-0000-0000-0000-000000000003','{"examKey":"sc200","predecessorPackageVersion":"1.0.0","successorPackageVersion":"1.1.0","fullProfileKey":"sc200-full","compactProfileKey":"sc200-compact","requestId":"83000000-0000-0000-0000-000000000300"}')$$,'23505','sc200_successor_cutover_request_conflict','same request with another actor conflicts');
set local request.jwt.claim.sub='83000000-0000-0000-0000-000000000001';
select lives_ok($$select public.certsim_transition_live_assignment_v2('{"oldAssignmentId":"83000000-0000-0000-0000-000000000200","targetUserId":"83000000-0000-0000-0000-000000000002","organisationId":"83000000-0000-0000-0000-000000000010","examKey":"sc200","packageVersion":"1.1.0","profileKey":"sc200-full","maximumAttempts":"1","reviewReleasePolicy":"after_submission","answerReleasePolicy":"after_submission","requestId":"83000000-0000-0000-0000-000000000500"}')$$,'assignment transition works after cutover');
select is((select count(*)::integer from public.exam_assignments where id='83000000-0000-0000-0000-000000000200' and status='archived'),1,'old assignment archived');
select is((select count(*)::integer from public.exam_assignments where contract_version='live-v2' and status='active' and package_version_id='83000000-0000-0000-0000-000000000110' and package_profile_id='83000000-0000-0000-0000-000000000111' and maximum_attempts=1 and review_release_policy='after_submission' and answer_release_policy='after_submission'),1,'one exact successor assignment is active');
select is((select count(*)::integer from exam_delivery.exam_entitlements where learner_id='83000000-0000-0000-0000-000000000002' and enabled and revoked_at is null and package_version_id='83000000-0000-0000-0000-000000000110' and package_profile_id='83000000-0000-0000-0000-000000000111'),1,'learner retains one successor assignment entitlement');
select is((select count(*)::integer from exam_delivery.attempts where id<>'83000000-0000-0000-0000-000000000400'),0,'release and assignment transition create no learner attempt');

select * from finish();
rollback;
