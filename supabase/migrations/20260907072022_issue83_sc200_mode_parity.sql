-- Issue #83: SC-200 1.1 Compact canonical forms, objective-scoped practice,
-- multi-profile release candidates, and an audited assignment transition.

-- Canonical-form v2 remains backward compatible. A successor may optionally
-- declare stricter per-form skill-group targets when a balanced cycle cannot
-- use one identical integer distribution for every form.
do $issue83_forms$
declare
  v_definition text;
  v_updated text;
begin
  v_definition := pg_get_functiondef('exam_delivery.prepare_canonical_forms_on_publish()'::regprocedure);
  v_updated := replace(v_definition,
    $$if not exam_delivery.json_has_exact_keys(v_contract,array['contractVersion','profileKey','questionCount','cycleLength','reservePolicy','reserveQuestionIds','skillGroupTargets','requiredObjectiveKeys','minimumCoverageTagCounts','difficultyRequirements','forms'])$$,
    $$if not (exam_delivery.json_has_exact_keys(v_contract,array['contractVersion','profileKey','questionCount','cycleLength','reservePolicy','reserveQuestionIds','skillGroupTargets','requiredObjectiveKeys','minimumCoverageTagCounts','difficultyRequirements','forms']) or exam_delivery.json_has_exact_keys(v_contract,array['contractVersion','profileKey','questionCount','cycleLength','reservePolicy','reserveQuestionIds','skillGroupTargets','skillGroupTargetsByForm','requiredObjectiveKeys','minimumCoverageTagCounts','difficultyRequirements','forms']))$$);
  v_updated := replace(v_updated,
    $$or jsonb_typeof(v_contract->'requiredObjectiveKeys') is distinct from 'array'$$,
    $$or (v_contract ? 'skillGroupTargetsByForm' and jsonb_typeof(v_contract->'skillGroupTargetsByForm') is distinct from 'object') or jsonb_typeof(v_contract->'requiredObjectiveKeys') is distinct from 'array'$$);
  v_updated := replace(v_updated,
    $$or (select coalesce(sum((value#>>'{}')::integer),0) from jsonb_each(v_contract->'skillGroupTargets')) <> v_profile.question_count$$,
    $$or (select coalesce(sum((value#>>'{}')::integer),0) from jsonb_each(v_contract->'skillGroupTargets')) <> v_profile.question_count
      or exists(select 1 from jsonb_each(coalesce(v_contract->'skillGroupTargetsByForm','{}'::jsonb)) override(form_key,targets)
        where jsonb_typeof(override.targets) is distinct from 'object'
          or not exists(select 1 from jsonb_array_elements(v_contract->'forms') form where form->>'formKey'=override.form_key)
          or exists(select 1 from jsonb_each(override.targets) target(key,value)
            where nullif(btrim(target.key),'') is null or jsonb_typeof(target.value) is distinct from 'number' or not (target.value#>>'{}' ~ '^\d+$'))
          or (select coalesce(sum((value#>>'{}')::integer),0) from jsonb_each(override.targets))<>v_profile.question_count
          or (select array_agg(key order by key) from jsonb_object_keys(override.targets) key)
            is distinct from (select array_agg(key order by key) from jsonb_object_keys(v_contract->'skillGroupTargets') key))$$);
  v_updated := replace(v_updated,
    $$from jsonb_each_text(v_contract->'skillGroupTargets') required(skill_group, target)$$,
    $$FROM jsonb_each_text(coalesce(v_contract #> array['skillGroupTargetsByForm',v_form->>'formKey'],v_contract -> 'skillGroupTargets'::text)) required(skill_group, target)$$);
  v_updated := replace(v_updated,
    $$v_contract - 'forms' - 'reserveQuestionIds'$$,
    $$(v_contract - 'forms'::text - 'reserveQuestionIds'::text - 'skillGroupTargetsByForm'::text) || jsonb_build_object('skillGroupTargets',coalesce(v_contract #> array['skillGroupTargetsByForm',v_form->>'formKey'],v_contract -> 'skillGroupTargets'::text))$$);
  if v_updated = v_definition
    or position('skillGroupTargetsByForm' in v_updated) = 0
    or position($$coalesce(v_contract #> array['skillGroupTargetsByForm',v_form->>'formKey']$$ in v_updated) = 0
  then raise exception 'issue83_canonical_form_contract_drift'; end if;
  execute v_updated;
end $issue83_forms$;

-- A release candidate identifies one immutable package profile. Preserve the
-- existing SC-200 1.0 candidate while allowing Full and Compact 1.1 candidates.
alter table exam_delivery.exam_release_candidates
  drop constraint exam_release_candidates_pkey;
alter table exam_delivery.exam_release_candidates
  drop constraint exam_release_candidates_catalogue_slug_key;
alter table exam_delivery.exam_release_candidates
  add primary key(canonical_exam_key,package_version,profile_key);
alter table exam_delivery.exam_release_candidates
  add unique(catalogue_slug,package_version,profile_key);

insert into exam_delivery.exam_release_candidates(
  canonical_exam_key,package_version,profile_key,release_template,
  catalogue_slug,catalogue_title,catalogue_vendor,catalogue_exam_type,catalogue_source_type
) values
  ('sc200','1.1.0','sc200-full','standard_active_exam_v1','sc200',
    'SC-200: Microsoft Security Operations Analyst','Microsoft','certification','official_source'),
  ('sc200','1.1.0','sc200-compact','standard_active_exam_v1','sc200',
    'SC-200: Microsoft Security Operations Analyst','Microsoft','certification','official_source');

-- Extend the reviewed availability/materialization functions through guarded
-- definition transforms. Browser values are never authoritative: the package
-- catalogue confirms both the domain/objective relationship and eligible count.
do $issue83_practice$
declare
  v_definition text;
  v_updated text;
begin
  v_definition := pg_get_functiondef('exam_delivery.practice_availability(uuid,jsonb)'::regprocedure);
  v_updated := replace(v_definition,
    $$v_domains jsonb:='{}'::jsonb;$$,
    $$v_domains jsonb := '{}'::jsonb; v_objectives jsonb := '{}'::jsonb;$$);
  v_updated := replace(v_updated,
    $$if v_purpose='targeted_domain' and (nullif(p_request->>'domain','') is null or not (v_domains ? (p_request->>'domain'))) then$$,
    $$select coalesce(jsonb_object_agg(domain_key,objective_counts),'{}'::jsonb) into v_objectives from (select domain_key,jsonb_object_agg(section_key,total) objective_counts from (select q.domain_key,q.section_key,count(*) filter(where coalesce((pc.authoring_metadata->>'scored')::boolean,true))::integer total from exam_delivery.package_questions q join exam_delivery.package_question_protected_content pc on pc.question_id=q.id where q.package_version_id=v_package_id group by q.domain_key,q.section_key) objective_rows group by domain_key) objective_domains; if v_purpose='targeted_domain' and (nullif(p_request->>'domain','') is null or not (v_domains ? (p_request->>'domain')) or (nullif(p_request->>'objective','') is not null and not (coalesce(v_objectives->(p_request->>'domain'),'{}'::jsonb) ? (p_request->>'objective')))) then$$);
  v_updated := replace(v_updated,
    $$and (v_purpose<>'targeted_domain' or q.domain_key=p_request->>'domain')$$,
    $$and (v_purpose<>'targeted_domain' or (q.domain_key=p_request->>'domain' and (nullif(p_request->>'objective','') is null or q.section_key=p_request->>'objective')))$$);
  v_updated := replace(v_updated,
    $$'domainCounts',v_domains,'missedCount'$$,
    $$'domainCounts',v_domains,'objectiveCounts',v_objectives,'confirmedDomain',case when v_purpose='targeted_domain' then p_request->>'domain' else null end,'confirmedObjective',case when v_purpose='targeted_domain' then nullif(p_request->>'objective','') else null end,'missedCount'$$);
  if v_updated = v_definition or position('v_objectives' in v_updated)=0
    or position($needle$q.section_key=p_request->>'objective'$needle$ in v_updated)=0
  then raise exception 'issue83_practice_availability_contract_drift'; end if;
  execute v_updated;

  v_definition := pg_get_functiondef('exam_delivery.materialize_attempt_items_issue21_unrotated_base(uuid,uuid,integer)'::regprocedure);
  v_updated := replace(v_definition,
    $$bool_or(domain_key=v_attempt.practice_configuration->>'domain') target_domain,$$,
    $$bool_or(domain_key=v_attempt.practice_configuration->>'domain') target_domain, bool_or(section_key=v_attempt.practice_configuration->>'objective') target_objective,$$);
  v_updated := replace(v_updated,
    $$(v_attempt.purpose='targeted_domain' and target_domain)$$,
    $$(v_attempt.purpose='targeted_domain' and target_domain and (nullif(v_attempt.practice_configuration->>'objective','') is null or target_objective))$$);
  if v_updated = v_definition or position('target_objective' in v_updated)=0
  then raise exception 'issue83_materializer_contract_drift'; end if;
  execute v_updated;
end $issue83_practice$;

create function exam_delivery.transition_live_assignment_v2(p_actor_id uuid,p_request jsonb)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='10s' as $$
declare
  v_old_id uuid;
  v_old public.exam_assignments%rowtype;
  v_new_request jsonb;
  v_created jsonb;
begin
  if p_actor_id is null or jsonb_typeof(p_request)<>'object'
    or not exam_delivery.json_has_exact_keys(p_request,array['oldAssignmentId','targetUserId','organisationId','examKey','packageVersion','profileKey','maximumAttempts','reviewReleasePolicy','answerReleasePolicy','requestId'])
  then raise exception 'assignment_transition_invalid_request' using errcode='22023'; end if;
  begin v_old_id := (p_request->>'oldAssignmentId')::uuid;
  exception when others then raise exception 'assignment_transition_invalid_request' using errcode='22023'; end;
  select * into strict v_old from public.exam_assignments where id=v_old_id for update;
  if v_old.assigned_by<>p_actor_id or v_old.contract_version<>'live-v2' or v_old.status<>'active'
    or exam_delivery.normalize_exam_key(v_old.exam_key)<>'sc200' or v_old.profile_id<>'sc200-full'
    or p_request->>'examKey'<>'sc200' or p_request->>'packageVersion'<>'1.1.0'
    or p_request->>'profileKey'<>'sc200-full' or p_request->>'maximumAttempts'<>'1'
    or p_request->>'reviewReleasePolicy'<>'after_submission' or p_request->>'answerReleasePolicy'<>'after_submission'
    or (p_request->>'targetUserId')::uuid<>v_old.student_user_id
    or (p_request->>'organisationId')::uuid<>v_old.organisation_id
    or not exists(select 1 from exam_delivery.package_versions pv where pv.id=v_old.package_version_id and pv.package_version='1.0.0')
    or exists(select 1 from exam_delivery.attempts a where a.source_assignment_id=v_old.id or a.protected_assignment_id=v_old.id)
  then raise exception 'assignment_transition_conflict' using errcode='22023'; end if;
  update public.exam_assignments set status='archived',updated_at=statement_timestamp() where id=v_old.id;
  update exam_delivery.exam_entitlements set enabled=false,revoked_at=statement_timestamp(),revoked_by=p_actor_id,updated_at=statement_timestamp()
    where source_assignment_id=v_old.id and enabled;
  v_new_request := p_request-'oldAssignmentId';
  v_created := exam_delivery.create_live_assignment_v2(v_new_request);
  return jsonb_build_object('ok',true,'oldStatus','archived','replacementCreated',coalesce((v_created->>'created')::boolean,false),
    'examKey','sc200','packageVersion','1.1.0','profileKey','sc200-full');
exception when no_data_found or too_many_rows then
  raise exception 'assignment_transition_conflict' using errcode='22023';
end $$;

create function public.certsim_transition_live_assignment_v2(p_request jsonb)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='10s' as $$
declare v_actor uuid:=auth.uid(); v_org uuid;
begin
  begin v_org:=(p_request->>'organisationId')::uuid;
  exception when others then raise exception 'assignment_transition_invalid_request' using errcode='22023'; end;
  if v_actor is null or not exists(select 1 from public.memberships m where m.user_id=v_actor
    and m.organisation_id=v_org and m.role='platform_owner' and m.status='active')
  then raise exception 'assignment_transition_forbidden' using errcode='42501'; end if;
  return exam_delivery.transition_live_assignment_v2(v_actor,p_request);
end $$;

alter function exam_delivery.transition_live_assignment_v2(uuid,jsonb) owner to postgres;
alter function public.certsim_transition_live_assignment_v2(jsonb) owner to postgres;
revoke execute on function exam_delivery.transition_live_assignment_v2(uuid,jsonb),
  public.certsim_transition_live_assignment_v2(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.certsim_transition_live_assignment_v2(jsonb) to authenticated;
