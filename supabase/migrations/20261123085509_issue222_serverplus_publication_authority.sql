-- Source-only migration 102. No package, release, access or learner row is created.
begin;

create table exam_delivery.serverplus_publication_intents (
  id uuid primary key default gen_random_uuid(),
  publication_request_id uuid not null unique default gen_random_uuid(),
  actor_id uuid not null references auth.users(id),
  project_ref text not null check (project_ref='qngnoctsdhzcpagesvxz'),
  approval_reference text not null unique,
  application_source_sha text not null check (application_source_sha ~ '^[0-9a-f]{40}$'),
  protected_source_sha text not null check (protected_source_sha ~ '^[0-9a-f]{40}$'),
  identity jsonb not null,
  state_hash text not null,
  release_diff_hash text not null,
  status text not null default 'issued' check (status in ('issued','consumed','failed','revoked')),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  finished_at timestamptz,
  package_version_id uuid references exam_delivery.package_versions(id),
  publication_run_id uuid references exam_delivery.publication_runs(id),
  result_receipt jsonb,
  check (expires_at>created_at and expires_at<=created_at+interval '5 minutes'),
  check ((status='issued')=(finished_at is null)),
  check (status<>'consumed' or (package_version_id is not null and publication_run_id is not null and result_receipt is not null))
);
create unique index serverplus_one_issued_intent on exam_delivery.serverplus_publication_intents(project_ref) where status='issued';
create table exam_delivery.serverplus_publication_intent_events (
  id bigint generated always as identity primary key,
  intent_id uuid not null references exam_delivery.serverplus_publication_intents(id),
  actor_id uuid not null references auth.users(id),
  event_type text not null check (event_type in ('issued','consumed','failed','revoked')),
  occurred_at timestamptz not null default clock_timestamp()
);
alter table exam_delivery.serverplus_publication_intents enable row level security;
alter table exam_delivery.serverplus_publication_intent_events enable row level security;
revoke all on exam_delivery.serverplus_publication_intents,exam_delivery.serverplus_publication_intent_events from public,anon,authenticated,service_role;
revoke all on sequence exam_delivery.serverplus_publication_intent_events_id_seq from public,anon,authenticated,service_role;

create function exam_delivery.serverplus_intent_guard() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if TG_TABLE_NAME='serverplus_publication_intent_events' or TG_OP='DELETE' then
  raise exception 'serverplus_intent_immutable' using errcode='42501';
 end if;
 if OLD.status<>'issued' or NEW.status not in ('consumed','failed','revoked')
  or (to_jsonb(NEW)-array['status','finished_at','package_version_id','publication_run_id','result_receipt'])
   is distinct from (to_jsonb(OLD)-array['status','finished_at','package_version_id','publication_run_id','result_receipt']) then
  raise exception 'serverplus_intent_immutable' using errcode='42501';
 end if;
 return NEW;
end $$;
create trigger serverplus_intent_immutable before update or delete on exam_delivery.serverplus_publication_intents for each row execute function exam_delivery.serverplus_intent_guard();
create trigger serverplus_intent_events_immutable before update or delete on exam_delivery.serverplus_publication_intent_events for each row execute function exam_delivery.serverplus_intent_guard();

create function exam_delivery.serverplus_publication_identity() returns jsonb
language sql immutable security invoker set search_path='' as $$
 select jsonb_build_object('examKey','serverplussk0005','packageVersion','1.0.0',
 'packageHash','26e2caf5a3a838ea274f09938076a734aa734e14cb5535ff11a4203c05fdfefe',
 'validationHash','6f0dfbf16d620b1fee9b9d30a16f9283902bbf88a6e26bbf94d945895cbb36cf',
 'sourceHash','b2d0ea7681ab8b40ba54060cf081b514c2096d82c6b2bb7a9dd1de6932b5cb92',
 'exerciseHash','bd0ae42ecca21dd8e2ae8f5490fdc3bce6ee65ce4ffe70c0e5aaee7e987c10ed',
 'reviewedSourceCommit','8f717cfa8e4d17cee0a580a6e5ea7b0c9df1e206',
 'manifestHash','87f25694f695b6d1839f17268c8fb3bce1c08cdf2138644a04a6a3aabf4da6d9',
 'inventoryIdentityHash','428277cdd850122c6d1e69d000a82566c1e9977602565614a1ecc84ffc084108',
 'projectRef','qngnoctsdhzcpagesvxz')
$$;

create function exam_delivery.serverplus_assert_owner() returns uuid
language plpgsql stable security definer set search_path='' set statement_timeout='5s' as $$
declare actor uuid:=auth.uid();
begin
 -- iss is a signed claim only after the Supabase gateway validates the JWT.
 -- It is not physical-database attestation and is combined with coordinator target checks.
 if auth.jwt()->>'iss' is distinct from 'https://qngnoctsdhzcpagesvxz.supabase.co/auth/v1'
  or auth.jwt()->>'role' is distinct from 'authenticated' then
  raise exception 'serverplus_project_context_invalid' using errcode='42501';
 end if;
 if not coalesce(exam_delivery.examops_actor_is_platform_owner(actor),false) then
  raise exception 'serverplus_owner_required' using errcode='42501';
 end if;
 return actor;
end $$;

-- Recognize the complete reviewed bank independently of names/source metadata.
-- This is a fixed inventory boundary, not a general content-copy detection service.
create function exam_delivery.serverplus_payload_is_guarded(p_payload jsonb) returns boolean
language sql immutable security invoker set search_path='' as $$
 select coalesce(
  exam_delivery.normalize_exam_key(p_payload#>>'{exam,examKey}') in
   ('serverplussk0005','serverplus','sk0005','comptiaserver','comptiaserversk0005','serversk0005','comptiaserverplus','comptiaserverplussk0005','server')
  or p_payload#>>'{source,sourceHash}'='b2d0ea7681ab8b40ba54060cf081b514c2096d82c6b2bb7a9dd1de6932b5cb92'
  or p_payload#>>'{source,validationHash}' in ('6f0dfbf16d620b1fee9b9d30a16f9283902bbf88a6e26bbf94d945895cbb36cf','11c9ab734b3e44330d6b2c60fc79f7a04859536cf9e3ab309cc331848d1efabc')
  or case when jsonb_typeof(p_payload->'questions')='array' then
   (select exam_delivery.canonical_sha256(jsonb_agg(q.value->>'id' order by (q.value->>'id') collate "C")) from jsonb_array_elements(p_payload->'questions') q(value))='428277cdd850122c6d1e69d000a82566c1e9977602565614a1ecc84ffc084108'
   else false end,false)
$$;

-- Preserve the complete effective 101-migration engine, not an obsolete copied body.
alter function exam_delivery.publish_package_v2(jsonb) rename to publish_package_v2_before_serverplus_authority;
revoke all on function exam_delivery.publish_package_v2_before_serverplus_authority(jsonb) from public,anon,authenticated,service_role;
create function exam_delivery.publish_package_v2(p_request jsonb) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='15s' as $$
begin
 -- Preserve the old core's authorization/errors before inspecting a large inventory.
 if auth.uid() is null then raise exception 'publication_auth_required' using errcode='42501'; end if;
 if not exists(select 1 from public.memberships m where m.user_id=auth.uid() and m.role='platform_owner' and m.status='active') then raise exception 'publication_forbidden' using errcode='42501'; end if;
 if pg_column_size(p_request)>16777216 then raise exception 'publication_invalid_request' using errcode='22023'; end if;
 if exam_delivery.serverplus_payload_is_guarded(p_request->'packagePayload') then
  raise exception 'serverplus_publication_intent_required' using errcode='42501';
 end if;
 return exam_delivery.publish_package_v2_before_serverplus_authority(p_request);
end $$;
-- Recompile both dispatchers so a warmed pre-rename SQL plan is not an alternate core path.
create or replace function exam_delivery.publish_package(p_request jsonb) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='15s' as $$
begin
 if p_request#>>'{packagePayload,packageSchemaVersion}'='certsim-protected-package-v2' then
  return exam_delivery.publish_package_v2(p_request);
 end if;
 return exam_delivery.publish_package_ai901_v1(p_request);
end $$;
create or replace function public.certsim_protected_publish_package(p_request jsonb) returns jsonb
language sql security invoker set search_path='' as $$ select exam_delivery.publish_package(p_request) $$;
revoke all on function exam_delivery.publish_package_v2(jsonb) from public,anon,service_role;
grant execute on function exam_delivery.publish_package_v2(jsonb) to authenticated;

create function exam_delivery.serverplus_publication_state() returns jsonb
language plpgsql stable security definer set search_path='' set statement_timeout='10s' as $$
declare state jsonb; migration_hash text; migration_count integer; capabilities boolean; ready boolean;
begin
 select count(*),md5(string_agg(version,',' order by version)) into migration_count,migration_hash from supabase_migrations.schema_migrations;
 -- 6809c575e666a8476673e0a7b2c60d85 is filled from the complete immutable source version inventory.
 capabilities:=migration_count=102 and migration_hash='6809c575e666a8476673e0a7b2c60d85'
  and coalesce(exam_delivery.package_v2_runtime_supported('certsim-sc200-canonical-forms-v1','certsim-selected-response-partial-v1',null),false)
  and not has_function_privilege('authenticated','exam_delivery.publish_package_v2_before_serverplus_authority(jsonb)','EXECUTE');
 with guarded_packages as (
  select p.id from exam_delivery.package_versions p where
   exam_delivery.normalize_exam_key(p.exam_key) in ('serverplussk0005','serverplus','sk0005','comptiaserver','comptiaserversk0005','serversk0005','comptiaserverplus','comptiaserverplussk0005','server')
   or p.validation_hash in ('6f0dfbf16d620b1fee9b9d30a16f9283902bbf88a6e26bbf94d945895cbb36cf','11c9ab734b3e44330d6b2c60fc79f7a04859536cf9e3ab309cc331848d1efabc')
   or p.package_hash in ('26e2caf5a3a838ea274f09938076a734aa734e14cb5535ff11a4203c05fdfefe','2c70dc26f719586645ce9a8c87db8d982be85f87d695d90c4e7a003ef958eb8a')
   or (select exam_delivery.canonical_sha256(jsonb_agg(q.question_id order by q.question_id collate "C")) from exam_delivery.package_questions q where q.package_version_id=p.id)='428277cdd850122c6d1e69d000a82566c1e9977602565614a1ecc84ffc084108'
 ) select jsonb_build_object(
  'packages',(select count(*) from guarded_packages),
  'pristine',exam_delivery.examops_initial_configuration_is_empty('serverplussk0005'),
  'aliasConfiguration',(
   (select count(*) from public.exam_catalog where exam_delivery.normalize_exam_key(exam_key) in ('serverplussk0005','serverplus','sk0005','comptiaserver','comptiaserversk0005','serversk0005','comptiaserverplus','comptiaserverplussk0005','server'))+
   (select count(*) from exam_delivery.package_profile_defaults where exam_delivery.normalize_exam_key(canonical_exam_key) in ('serverplussk0005','serverplus','sk0005','comptiaserver','comptiaserversk0005','serversk0005','comptiaserverplus','comptiaserverplussk0005','server'))+
   (select count(*) from exam_delivery.practice_policies where exam_delivery.normalize_exam_key(canonical_exam_key) in ('serverplussk0005','serverplus','sk0005','comptiaserver','comptiaserversk0005','serversk0005','comptiaserverplus','comptiaserverplussk0005','server'))+
   (select count(*) from public.exam_assignments where exam_delivery.normalize_exam_key(exam_key) in ('serverplussk0005','serverplus','sk0005','comptiaserver','comptiaserversk0005','serversk0005','comptiaserverplus','comptiaserverplussk0005','server'))+
   (select count(*) from public.exam_attempts where exam_delivery.normalize_exam_key(exam_key) in ('serverplussk0005','serverplus','sk0005','comptiaserver','comptiaserversk0005','serversk0005','comptiaserverplus','comptiaserverplussk0005','server'))),
  'accessLearners',(select count(*) from exam_delivery.exam_access_learners where exam_delivery.normalize_exam_key(canonical_exam_key) in ('serverplussk0005','serverplus','sk0005','comptiaserver','comptiaserversk0005','serversk0005','comptiaserverplus','comptiaserverplussk0005','server')),
  'accessOrganisations',(select count(*) from exam_delivery.exam_access_organisations where exam_delivery.normalize_exam_key(canonical_exam_key) in ('serverplussk0005','serverplus','sk0005','comptiaserver','comptiaserversk0005','serversk0005','comptiaserverplus','comptiaserverplussk0005','server')),
  'pilot',(select count(*) from exam_delivery.pilot_access where exam_delivery.normalize_exam_key(exam_key) in ('serverplussk0005','serverplus','sk0005','comptiaserver','comptiaserversk0005','serversk0005','comptiaserverplus','comptiaserverplussk0005','server')),
  'operations',(select count(*) from exam_delivery.exam_release_operations where exam_delivery.normalize_exam_key(canonical_exam_key) in ('serverplussk0005','serverplus','sk0005','comptiaserver','comptiaserversk0005','serversk0005','comptiaserverplus','comptiaserverplussk0005','server')),
  'publicationRuns',(select count(*) from exam_delivery.publication_runs where status='pending' or package_version_id in (select id from guarded_packages) or expected_package_hash in ('26e2caf5a3a838ea274f09938076a734aa734e14cb5535ff11a4203c05fdfefe','2c70dc26f719586645ce9a8c87db8d982be85f87d695d90c4e7a003ef958eb8a') or expected_validation_hash in ('6f0dfbf16d620b1fee9b9d30a16f9283902bbf88a6e26bbf94d945895cbb36cf','11c9ab734b3e44330d6b2c60fc79f7a04859536cf9e3ab309cc331848d1efabc')),
  'migrationHash',migration_hash,'migrationCount',migration_count,
  'runtimeHash',(select md5(string_agg(pg_get_functiondef(p.oid)||coalesce(p.proacl::text,''),',' order by p.oid)) from pg_proc p where p.oid in (
   'exam_delivery.package_v2_runtime_supported(text,text,text)'::regprocedure,
   'exam_delivery.score_selected_response_partial(text,jsonb,jsonb,jsonb,boolean)'::regprocedure,
   'exam_delivery.examops_initial_configuration_is_empty(text)'::regprocedure,
   'exam_delivery.materialize_attempt_items_issue21_unrotated_base(uuid,uuid,integer)'::regprocedure,
   'exam_delivery.publish_package_v2_before_serverplus_authority(jsonb)'::regprocedure,
   'exam_delivery.publish_package_v2(jsonb)'::regprocedure,
   'exam_delivery.serverplus_payload_is_guarded(jsonb)'::regprocedure,
   'exam_delivery.serverplus_publication_identity()'::regprocedure))
 ) into state;
 ready:=coalesce((state->>'pristine')::boolean,false) and capabilities
  and not exists(select 1 from jsonb_each(state) pair where pair.key in ('packages','aliasConfiguration','accessLearners','accessOrganisations','pilot','operations','publicationRuns') and pair.value<>'0'::jsonb);
 return jsonb_build_object('ready',ready,'stateHash',exam_delivery.canonical_sha256(state),
  'migrationCount',migration_count,'capabilitiesReady',capabilities,'identity',exam_delivery.serverplus_publication_identity(),
  'releaseDiffHash',exam_delivery.canonical_sha256(jsonb_build_object('contractVersion','serverplus-publication-diff-v1','state',state,'identity',exam_delivery.serverplus_publication_identity(),'action','PUBLISH_ONLY')));
end $$;

create function public.certsim_serverplus_publication_preflight(p_request jsonb) returns jsonb
language plpgsql stable security definer set search_path='' set statement_timeout='10s' as $$
begin
 perform exam_delivery.serverplus_assert_owner();
 if p_request is distinct from jsonb_build_object('contractVersion','serverplus-publication-authority-v1') then
  raise exception 'serverplus_request_invalid' using errcode='22023';
 end if;
 return exam_delivery.serverplus_publication_state();
end $$;

create function public.certsim_serverplus_issue_publication_intent(p_request jsonb) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='15s' set lock_timeout='2s' as $$
declare actor uuid:=exam_delivery.serverplus_assert_owner(); state jsonb; intent exam_delivery.serverplus_publication_intents%rowtype; created timestamptz;
begin
 if not exam_delivery.json_has_exact_keys(p_request,array['contractVersion','identity','expectedStateHash','releaseDiffHash','approvalReference','confirmation','applicationSourceSha','protectedSourceSha'])
  or p_request->>'contractVersion' is distinct from 'serverplus-publication-authority-v1'
  or p_request->'identity' is distinct from exam_delivery.serverplus_publication_identity()
  or p_request->>'confirmation' is distinct from 'ISSUE_SERVERPLUS_1_0_0_ONCE'
  or coalesce(p_request->>'approvalReference','') !~ '^https://github[.]com/SAFFR0NM0NEY/cert-sim-platform/issues/222#issuecomment-[0-9]+$'
  or coalesce(p_request->>'applicationSourceSha','') !~ '^[0-9a-f]{40}$'
  or coalesce(p_request->>'protectedSourceSha','') !~ '^[0-9a-f]{40}$' then
  raise exception 'serverplus_intent_request_invalid' using errcode='22023';
 end if;
 if not pg_try_advisory_xact_lock(hashtextextended('certsim-exam-release:serverplussk0005',0)) then
  raise exception 'serverplus_publication_busy' using errcode='55P03';
 end if;
 state:=exam_delivery.serverplus_publication_state();
 if (state->>'ready')::boolean is distinct from true or state->>'stateHash' is distinct from p_request->>'expectedStateHash'
  or state->>'releaseDiffHash' is distinct from p_request->>'releaseDiffHash' then
  raise exception 'serverplus_state_changed' using errcode='40001';
 end if;
 if exists(select 1 from exam_delivery.serverplus_publication_intents where status='issued' or approval_reference=p_request->>'approvalReference') then
  raise exception 'serverplus_intent_conflict' using errcode='23505';
 end if;
 created:=clock_timestamp();
 insert into exam_delivery.serverplus_publication_intents(actor_id,project_ref,approval_reference,application_source_sha,protected_source_sha,identity,state_hash,release_diff_hash,created_at,expires_at)
 values(actor,'qngnoctsdhzcpagesvxz',p_request->>'approvalReference',p_request->>'applicationSourceSha',p_request->>'protectedSourceSha',p_request->'identity',state->>'stateHash',state->>'releaseDiffHash',created,created+interval '5 minutes') returning * into intent;
 insert into exam_delivery.serverplus_publication_intent_events(intent_id,actor_id,event_type) values(intent.id,actor,'issued');
 return jsonb_build_object('contractVersion','serverplus-publication-authority-v1','intentId',intent.id,'publicationRequestId',intent.publication_request_id,'status',intent.status,'expiresAt',intent.expires_at,'identity',intent.identity,'stateHash',intent.state_hash,'releaseDiffHash',intent.release_diff_hash,'applicationSourceSha',intent.application_source_sha,'protectedSourceSha',intent.protected_source_sha);
end $$;

create function public.certsim_serverplus_get_publication_intent(p_intent_id uuid default null,p_approval_reference text default null) returns jsonb
language plpgsql stable security definer set search_path='' set statement_timeout='10s' as $$
declare actor uuid:=exam_delivery.serverplus_assert_owner(); intent exam_delivery.serverplus_publication_intents%rowtype;
begin
 if (p_intent_id is null)=(p_approval_reference is null) then raise exception 'serverplus_request_invalid' using errcode='22023'; end if;
 select * into intent from exam_delivery.serverplus_publication_intents where actor_id=actor and (id=p_intent_id or approval_reference=p_approval_reference);
 if not found then raise exception 'serverplus_intent_not_found' using errcode='42501'; end if;
 return jsonb_build_object('contractVersion','serverplus-publication-authority-v1','intentId',intent.id,'publicationRequestId',intent.publication_request_id,'status',intent.status,'expiresAt',intent.expires_at,'identity',intent.identity,'stateHash',intent.state_hash,'releaseDiffHash',intent.release_diff_hash,'applicationSourceSha',intent.application_source_sha,'protectedSourceSha',intent.protected_source_sha,'result',intent.result_receipt);
end $$;

create function public.certsim_serverplus_revoke_publication_intent(p_intent_id uuid) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='10s' set lock_timeout='2s' as $$
declare actor uuid:=exam_delivery.serverplus_assert_owner(); intent exam_delivery.serverplus_publication_intents%rowtype;
begin
 if not pg_try_advisory_xact_lock(hashtextextended('certsim-exam-release:serverplussk0005',0)) then raise exception 'serverplus_publication_busy' using errcode='55P03'; end if;
 select * into intent from exam_delivery.serverplus_publication_intents where id=p_intent_id and actor_id=actor for update;
 if not found then raise exception 'serverplus_intent_not_found' using errcode='42501'; end if;
 if intent.status<>'issued' then raise exception 'serverplus_intent_terminal' using errcode='42501'; end if;
 update exam_delivery.serverplus_publication_intents set status='revoked',finished_at=clock_timestamp() where id=intent.id;
 insert into exam_delivery.serverplus_publication_intent_events(intent_id,actor_id,event_type) values(intent.id,actor,'revoked');
 return jsonb_build_object('intentId',intent.id,'status','revoked');
end $$;

create function public.certsim_serverplus_publish_with_intent(p_request jsonb) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='30s' set lock_timeout='2s' as $$
declare actor uuid:=exam_delivery.serverplus_assert_owner(); intent exam_delivery.serverplus_publication_intents%rowtype; state jsonb; request jsonb; payload jsonb; result jsonb; package_id uuid; run_id uuid;
begin
 if not exam_delivery.json_has_exact_keys(p_request,array['contractVersion','intentId','request']) or p_request->>'contractVersion' is distinct from 'serverplus-publication-authority-v1' then raise exception 'serverplus_request_invalid' using errcode='22023'; end if;
 if not pg_try_advisory_xact_lock(hashtextextended('certsim-exam-release:serverplussk0005',0)) then raise exception 'serverplus_publication_busy' using errcode='55P03'; end if;
 select * into intent from exam_delivery.serverplus_publication_intents where id=(p_request->>'intentId')::uuid and actor_id=actor for update;
 if not found then raise exception 'serverplus_intent_not_found' using errcode='42501'; end if;
 if intent.status<>'issued' then raise exception 'serverplus_intent_terminal' using errcode='42501'; end if;
 if intent.expires_at<=clock_timestamp() then raise exception 'serverplus_intent_expired' using errcode='42501'; end if;
 if intent.project_ref<>'qngnoctsdhzcpagesvxz' or intent.identity is distinct from exam_delivery.serverplus_publication_identity() then raise exception 'serverplus_intent_invalid' using errcode='42501'; end if;
 state:=exam_delivery.serverplus_publication_state();
 if (state->>'ready')::boolean is distinct from true or state->>'stateHash' is distinct from intent.state_hash or state->>'releaseDiffHash' is distinct from intent.release_diff_hash then raise exception 'serverplus_state_changed' using errcode='40001'; end if;
 request:=p_request->'request'; payload:=request->'packagePayload';
 if not exam_delivery.json_has_exact_keys(request,array['publicationRequestId','sourceCommitSha','packagePayload','packageHash'])
  or request->>'publicationRequestId' is distinct from intent.publication_request_id::text
  or request->>'sourceCommitSha' is distinct from intent.application_source_sha
  or request->>'packageHash' is distinct from intent.identity->>'packageHash'
  or payload#>>'{exam,examKey}' is distinct from 'serverplussk0005'
  or payload#>>'{exam,packageVersion}' is distinct from '1.0.0'
  or payload#>>'{source,validationHash}' is distinct from intent.identity->>'validationHash'
  or payload#>>'{source,sourceHash}' is distinct from intent.identity->>'sourceHash'
  or payload#>>'{source,reviewedSourceCommit}' is distinct from intent.identity->>'reviewedSourceCommit'
  or exam_delivery.canonical_sha256(payload) is distinct from intent.identity->>'packageHash' then raise exception 'serverplus_payload_identity_invalid' using errcode='22023'; end if;
 begin
  result:=exam_delivery.publish_package_v2_before_serverplus_authority(request);
  if result->>'classification' is distinct from 'new_candidate' or coalesce((result->>'replayed')::boolean,false) then raise exception 'serverplus_unexpected_replay' using errcode='23505'; end if;
  select id into strict package_id from exam_delivery.package_versions where exam_key='serverplussk0005' and package_version='1.0.0';
  select id into strict run_id from exam_delivery.publication_runs where publication_request_id=intent.publication_request_id and status='succeeded';
 exception when others then
  -- The subtransaction rolls back publication/materialization. This intent is terminal.
  update exam_delivery.serverplus_publication_intents set status='failed',finished_at=clock_timestamp(),result_receipt=jsonb_build_object('ok',false,'code','SERVERPLUS_PUBLICATION_FAILED_NO_RETRY','sqlState',SQLSTATE) where id=intent.id;
  insert into exam_delivery.serverplus_publication_intent_events(intent_id,actor_id,event_type) values(intent.id,actor,'failed');
  return jsonb_build_object('ok',false,'intentId',intent.id,'status','failed','code','SERVERPLUS_PUBLICATION_FAILED_NO_RETRY');
 end;
 update exam_delivery.serverplus_publication_intents set status='consumed',finished_at=clock_timestamp(),package_version_id=package_id,publication_run_id=run_id,result_receipt=result where id=intent.id;
 insert into exam_delivery.serverplus_publication_intent_events(intent_id,actor_id,event_type) values(intent.id,actor,'consumed');
 return jsonb_build_object('ok',true,'intentId',intent.id,'status','consumed','publication',result);
end $$;

-- All privileged helpers default-deny; only the fixed public contracts are exposed.
revoke all on function exam_delivery.serverplus_payload_is_guarded(jsonb),exam_delivery.serverplus_intent_guard(),exam_delivery.serverplus_publication_identity(),exam_delivery.serverplus_assert_owner(),exam_delivery.serverplus_publication_state() from public,anon,authenticated,service_role;
revoke all on function public.certsim_serverplus_publication_preflight(jsonb),public.certsim_serverplus_issue_publication_intent(jsonb),public.certsim_serverplus_get_publication_intent(uuid,text),public.certsim_serverplus_revoke_publication_intent(uuid),public.certsim_serverplus_publish_with_intent(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.certsim_serverplus_publication_preflight(jsonb),public.certsim_serverplus_issue_publication_intent(jsonb),public.certsim_serverplus_get_publication_intent(uuid,text),public.certsim_serverplus_revoke_publication_intent(uuid),public.certsim_serverplus_publish_with_intent(jsonb) to authenticated;

commit;
