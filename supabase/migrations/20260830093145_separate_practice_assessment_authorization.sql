-- Issue #20 G3B2R: keep assessment entitlement and practice entitlement separate.
-- Authorization remains in the two entry points. This helper only materializes
-- items for an attempt row that an authoritative entry point has already created.

create function exam_delivery.materialize_attempt_items(
  p_attempt_id uuid,
  p_request_id uuid,
  p_practice_limit integer default null
)
returns integer
language plpgsql
security definer
set search_path = ''
set statement_timeout = '15s'
as $$
declare
  v_attempt record;
  v_case_count integer;
  v_pbq_count integer;
  v_case_keys text[] := '{}';
  v_pbq_keys text[] := '{}';
  v_group_scored integer := 0;
  v_standard_count integer;
  v_inserted integer;
begin
  if p_attempt_id is null or p_request_id is null then
    raise exception 'invalid_request' using errcode = '22023';
  end if;

  select a.id, a.owner_id, a.package_version_id, a.package_profile_id, a.purpose,
         a.practice_configuration, a.language_preference, pv.exam_key, pv.package_version,
         pp.question_count, pp.selection_config
    into strict v_attempt
  from exam_delivery.attempts a
  join exam_delivery.package_versions pv on pv.id = a.package_version_id
  join exam_delivery.package_profiles pp on pp.id = a.package_profile_id
  where a.id = p_attempt_id and a.client_request_id = p_request_id
    and a.status = 'in_progress'
  for update of a for share of pv, pp;

  if exists(select 1 from exam_delivery.attempt_items where attempt_id = p_attempt_id) then
    raise exception 'attempt_already_materialized' using errcode = '23505';
  end if;

  v_case_count := coalesce((v_attempt.selection_config->>'caseStudyCount')::integer,
    coalesce((v_attempt.selection_config->>'longCaseStudyCount')::integer, 0)
      + coalesce((v_attempt.selection_config->>'shortCaseStudyCount')::integer, 0), 0);
  v_pbq_count := coalesce((v_attempt.selection_config->>'pbqCount')::integer, 0);

  select coalesce(array_agg(group_key), '{}') into v_case_keys from (
    select pc.authoring_metadata#>>'{group,groupKey}' group_key
    from exam_delivery.package_questions q
    join exam_delivery.package_question_protected_content pc on pc.question_id = q.id
    where q.package_version_id = v_attempt.package_version_id
      and pc.authoring_metadata#>>'{group,role}' = 'context'
    order by md5(p_request_id::text || ':' || (pc.authoring_metadata#>>'{group,groupKey}'))
    limit v_case_count
  ) x;

  select coalesce(array_agg(group_key), '{}') into v_pbq_keys from (
    select pc.authoring_metadata#>>'{group,groupKey}' group_key
    from exam_delivery.package_questions q
    join exam_delivery.package_question_protected_content pc on pc.question_id = q.id
    where q.package_version_id = v_attempt.package_version_id
      and (pc.authoring_metadata#>>'{group,role}' = 'atomic-pbq' or q.question_type like 'pbq-%')
    order by md5(p_request_id::text || ':' || q.question_id)
    limit v_pbq_count
  ) x;

  select count(*)::integer into v_group_scored
  from exam_delivery.package_questions q
  join exam_delivery.package_question_protected_content pc on pc.question_id = q.id
  where q.package_version_id = v_attempt.package_version_id
    and coalesce((pc.authoring_metadata->>'scored')::boolean, true)
    and pc.authoring_metadata#>>'{group,groupKey}' = any(v_case_keys || v_pbq_keys);
  v_standard_count := v_attempt.question_count - v_group_scored;
  if v_standard_count < 0 then raise exception 'selection_incomplete' using errcode = '22023'; end if;

  with candidates as (
    select q.*, pc.scoring_payload, pc.review_payload, pc.authoring_metadata,
      pc.authoring_metadata#>>'{group,groupKey}' group_key,
      pc.authoring_metadata#>>'{group,role}' group_role,
      coalesce((pc.authoring_metadata#>>'{group,order}')::integer, 0) group_order,
      coalesce((pc.authoring_metadata->>'scored')::boolean, true) scored,
      exists(select 1 from exam_delivery.attempts prior
        join exam_delivery.review_snapshots rs on rs.attempt_id=prior.id
        cross join lateral jsonb_array_elements(coalesce(rs.review_payload->'items','[]'::jsonb)) reviewed
        where prior.owner_id=v_attempt.owner_id and prior.id<>p_attempt_id
          and reviewed->>'questionId'=q.question_id
          and reviewed->>'status' in ('Incorrect','Incomplete','Partial')) missed,
      not exists(select 1 from exam_delivery.attempts prior
        join exam_delivery.attempt_items seen on seen.attempt_id=prior.id
        where prior.owner_id=v_attempt.owner_id and prior.id<>p_attempt_id
          and seen.package_question_id=q.id) unseen,
      exists(select 1 from exam_delivery.attempts prior
        join exam_delivery.attempt_results result on result.attempt_id=prior.id
        cross join lateral jsonb_each(result.domain_summary) domain
        where prior.owner_id=v_attempt.owner_id and domain.key=q.domain_key
          and coalesce((domain.value->>'percentage')::numeric,100)<70) weak_domain
    from exam_delivery.package_questions q
    join exam_delivery.package_question_protected_content pc on pc.question_id = q.id
    where q.package_version_id = v_attempt.package_version_id
  ), standard as (
    select * from candidates where scored
      and coalesce(group_role, '') not in ('context', 'question', 'atomic-pbq')
      and question_type not like 'pbq-%'
    order by md5(p_request_id::text || ':' || question_id), source_ordinal
    limit v_standard_count
  ), profile_selected as (
    select * from candidates where group_key = any(v_case_keys || v_pbq_keys)
    union all select * from standard
  ), practice_units as (
    select coalesce(group_key, question_id) unit_key,
      count(*) filter(where scored)::integer scored_size,
      bool_or(question_type like 'pbq-%' or group_role='atomic-pbq') pbq,
      bool_or(group_role in ('context','question')) case_study,
      bool_or(domain_key=v_attempt.practice_configuration->>'domain') target_domain,
      bool_or(missed) missed,
      bool_or(unseen) unseen,
      bool_or(weak_domain) weak_domain
    from candidates
    where v_attempt.purpose<>'assigned_assessment'
    group by coalesce(group_key,question_id)
  ), practice_candidates as (
    select *,case v_attempt.practice_configuration->>'mixStrategy'
      when 'missed-heavy' then case when missed then 0 when weak_domain then 1 when unseen then 2 else 3 end
      when 'new-heavy' then case when unseen then 0 when weak_domain then 1 when missed then 2 else 3 end
      else case when missed then 0 when unseen then 1 when weak_domain then 2 else 3 end end priority
    from practice_units where scored_size>0
      and (coalesce((v_attempt.practice_configuration->>'includePbqs')::boolean,false) or not pbq)
      and (v_attempt.purpose not in ('targeted_domain','weak_area','pbq_practice')
        or (v_attempt.purpose='targeted_domain' and target_domain)
        or (v_attempt.purpose='weak_area' and (missed or weak_domain))
        or (v_attempt.purpose='pbq_practice' and (pbq or case_study)))
  ), practice_ranked as (
    select *,coalesce(sum(scored_size) over(order by priority,
      md5(p_request_id::text||unit_key) rows between unbounded preceding and 1 preceding),0) preceding
    from practice_candidates
  ), practice_chosen as (
    select unit_key from practice_ranked where preceding<p_practice_limit
  ), selected as (
    select * from profile_selected where v_attempt.purpose='assigned_assessment'
    union all
    select c.* from candidates c join practice_chosen k
      on k.unit_key=coalesce(c.group_key,c.question_id)
    where v_attempt.purpose<>'assigned_assessment'
  ), ordered as (
    select s.*, row_number() over(order by
      case when group_key = any(v_case_keys) then 1
        when v_attempt.selection_config->>'pbqPlacement' = 'front-loaded' and group_key = any(v_pbq_keys) then 1
        when group_key is null then 2 else 3 end,
      case when group_key is not null then md5(p_request_id::text || ':' || group_key)
        else md5(p_request_id::text || ':' || question_id) end,
      group_order, source_ordinal) presented_number
    from selected s
  ), inserted as (
    insert into exam_delivery.attempt_items(
      attempt_id, package_version_id, package_question_id, presented_question_number,
      section_ordinal, option_order, presentation_snapshot, presentation_hash
    )
    select p_attempt_id, v_attempt.package_version_id, id, presented_number,
      null, '[]'::jsonb,
      presentation_payload || case
        when exam_delivery.normalize_exam_key(v_attempt.exam_key)='az204'
          and v_attempt.package_version='1.1.0' and v_attempt.purpose<>'assigned_assessment'
        then coalesce(authoring_metadata#>'{group,languageVariants}'->case
          when v_attempt.language_preference='mixed' then case
            when get_byte(extensions.digest(convert_to(p_request_id::text||question_id,'UTF8'),'sha256'),0)%2=0
              then 'csharp' else 'python' end
          else v_attempt.language_preference end,'{}'::jsonb)
        else '{}'::jsonb end,
      encode(extensions.digest(convert_to((presentation_payload || case
        when exam_delivery.normalize_exam_key(v_attempt.exam_key)='az204'
          and v_attempt.package_version='1.1.0' and v_attempt.purpose<>'assigned_assessment'
        then coalesce(authoring_metadata#>'{group,languageVariants}'->case
          when v_attempt.language_preference='mixed' then case
            when get_byte(extensions.digest(convert_to(p_request_id::text||question_id,'UTF8'),'sha256'),0)%2=0
              then 'csharp' else 'python' end
          else v_attempt.language_preference end,'{}'::jsonb)
        else '{}'::jsonb end)::text, 'UTF8'), 'sha256'), 'hex')
    from ordered
    returning id, package_question_id
  )
  insert into exam_delivery.attempt_item_protected_content(
    attempt_item_id, attempt_id, scoring_snapshot, review_snapshot, protected_snapshot_hash
  )
  select i.id, p_attempt_id, pc.scoring_payload, pc.review_payload,
    encode(extensions.digest(convert_to((pc.scoring_payload || pc.review_payload)::text, 'UTF8'), 'sha256'), 'hex')
  from inserted i
  join exam_delivery.package_question_protected_content pc on pc.question_id = i.package_question_id;
  get diagnostics v_inserted = row_count;

  if v_attempt.purpose='assigned_assessment' and (select count(*) from exam_delivery.attempt_items i
      join exam_delivery.package_question_protected_content pc on pc.question_id = i.package_question_id
      where i.attempt_id = p_attempt_id
        and coalesce((pc.authoring_metadata->>'scored')::boolean, true)) <> v_attempt.question_count then
    raise exception 'selection_incomplete' using errcode = 'P0001';
  end if;
  if v_attempt.purpose<>'assigned_assessment' and not exists(
    select 1 from exam_delivery.attempt_items i
    join exam_delivery.package_question_protected_content pc on pc.question_id=i.package_question_id
    where i.attempt_id=p_attempt_id and coalesce((pc.authoring_metadata->>'scored')::boolean,true)
  ) then raise exception 'practice_pool_empty' using errcode='22023'; end if;
  return v_inserted;
exception when no_data_found or too_many_rows then
  raise exception 'attempt_not_materializable' using errcode = '22023';
end;
$$;

create or replace function exam_delivery.start_attempt_v2(
  p_actor_id uuid, p_exam_key text, p_profile_key text, p_request_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' set statement_timeout = '15s' as $$
declare
  v_key text := exam_delivery.normalize_exam_key(p_exam_key);
  v_existing exam_delivery.attempts%rowtype;
  v_package record;
  v_assignment_id uuid;
  v_attempt exam_delivery.attempts%rowtype;
  v_now timestamptz := statement_timestamp();
begin
  if p_actor_id is null or p_request_id is null then return jsonb_build_object('ok',false,'code','invalid_request'); end if;
  select * into v_existing from exam_delivery.attempts where owner_id=p_actor_id and client_request_id=p_request_id;
  if found then
    if v_existing.purpose = 'assigned_assessment' and exists(
      select 1 from exam_delivery.package_profiles pp join exam_delivery.package_versions pv on pv.id=pp.package_version_id
      where pp.id=v_existing.package_profile_id and pp.profile_key=p_profile_key
        and exam_delivery.normalize_exam_key(pv.exam_key)=v_key
    ) then return exam_delivery.resume_attempt(p_actor_id,v_existing.id); end if;
    return jsonb_build_object('ok',false,'code','attempt_conflict');
  end if;
  if not coalesce((exam_delivery.check_eligibility_v2(p_actor_id,p_exam_key,p_profile_key)->>'eligible')::boolean,false) then
    return jsonb_build_object('ok',false,'code',exam_delivery.check_eligibility_v2(p_actor_id,p_exam_key,p_profile_key)->>'reasonCode');
  end if;
  select pv.id package_version_id,pv.generator_version,pv.scorer_version,pp.id package_profile_id,pp.time_limit_minutes
    into strict v_package
  from exam_delivery.package_versions pv join exam_delivery.package_profiles pp on pp.package_version_id=pv.id
  where exam_delivery.normalize_exam_key(pv.exam_key)=v_key and pp.profile_key=p_profile_key
    and pv.package_schema_version='certsim-protected-package-v2' and pv.status='published'
  order by pv.published_at desc limit 1 for share of pv,pp;
  select a.id into v_assignment_id from exam_delivery.protected_assignments a
  where a.learner_id=p_actor_id and a.package_version_id=v_package.package_version_id
    and a.package_profile_id=v_package.package_profile_id and a.status='active'
    and a.available_from<=v_now and (a.expires_at is null or a.expires_at>v_now)
  limit 1 for update;
  insert into exam_delivery.attempts(
    owner_id,package_version_id,package_profile_id,protected_assignment_id,client_request_id,
    status,generator_version,scorer_version,created_at,started_at,expires_at,purpose
  ) values (
    p_actor_id,v_package.package_version_id,v_package.package_profile_id,v_assignment_id,p_request_id,
    'in_progress',v_package.generator_version,v_package.scorer_version,v_now,v_now,
    v_now+make_interval(mins=>v_package.time_limit_minutes),'assigned_assessment'
  ) returning * into v_attempt;
  perform exam_delivery.materialize_attempt_items(v_attempt.id,p_request_id,null);
  return exam_delivery.resume_attempt(p_actor_id,v_attempt.id);
exception when no_data_found or too_many_rows then return jsonb_build_object('ok',false,'code','package_unavailable');
when unique_violation then return jsonb_build_object('ok',false,'code','attempt_conflict');
end $$;

create or replace function exam_delivery.start_practice(p_actor_id uuid,p_request jsonb)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='15s' as $$
declare
  v_availability jsonb; v_started jsonb; v_attempt exam_delivery.attempts%rowtype;
  v_existing exam_delivery.attempts%rowtype; v_package record; v_limit integer;
  v_request_id uuid; v_configuration jsonb; v_now timestamptz:=statement_timestamp();
begin
  begin v_request_id := (p_request->>'clientRequestId')::uuid;
  exception when invalid_text_representation then return jsonb_build_object('ok',false,'code','invalid_request'); end;
  if p_actor_id is null or v_request_id is null then return jsonb_build_object('ok',false,'code','invalid_request'); end if;
  v_configuration := p_request - 'clientRequestId';
  v_availability := exam_delivery.practice_availability(p_actor_id,p_request);
  if not coalesce((v_availability->>'ok')::boolean,false) then return v_availability; end if;
  if not exists(
    select 1 from public.memberships m join public.organisations o on o.id=m.organisation_id and o.status='active'
    where m.user_id=p_actor_id and m.role='student' and m.status='active'
  ) then return jsonb_build_object('ok',false,'code','inactive_membership'); end if;
  if (v_availability->>'examKey'='az204' and v_availability->>'packageVersion'='1.1.0'
      and p_request->>'language' not in ('csharp','python','mixed'))
    or (not (v_availability->>'examKey'='az204' and v_availability->>'packageVersion'='1.1.0')
      and p_request->>'language'<>'not_applicable')
  then return jsonb_build_object('ok',false,'code','invalid_request'); end if;

  select * into v_existing from exam_delivery.attempts where owner_id=p_actor_id and client_request_id=v_request_id;
  if found then
    if v_existing.purpose=(p_request->>'purpose')::exam_delivery.attempt_purpose
      and v_existing.practice_configuration=v_configuration
      and v_existing.language_preference=p_request->>'language'
      and exists(select 1 from exam_delivery.package_versions pv join exam_delivery.package_profiles pp on pp.package_version_id=pv.id
        where pv.id=v_existing.package_version_id and pp.id=v_existing.package_profile_id
          and exam_delivery.normalize_exam_key(pv.exam_key)=v_availability->>'examKey'
          and pv.package_version=v_availability->>'packageVersion' and pp.profile_key=v_availability->>'profileKey')
    then return exam_delivery.resume_attempt(p_actor_id,v_existing.id); end if;
    return jsonb_build_object('ok',false,'code','attempt_conflict');
  end if;

  select a.* into v_existing from exam_delivery.attempts a
  join exam_delivery.package_versions pv on pv.id=a.package_version_id
  join exam_delivery.package_profiles pp on pp.id=a.package_profile_id
  where a.owner_id=p_actor_id and exam_delivery.normalize_exam_key(pv.exam_key)=v_availability->>'examKey'
    and pv.package_version=v_availability->>'packageVersion' and pp.profile_key=v_availability->>'profileKey'
    and a.purpose=(p_request->>'purpose')::exam_delivery.attempt_purpose and a.status='in_progress'
  for update of a;
  if found then return exam_delivery.resume_attempt(p_actor_id,v_existing.id); end if;

  perform 1 from exam_delivery.practice_policies p
  where p.canonical_exam_key=v_availability->>'examKey' and p.package_version=v_availability->>'packageVersion'
    and p.profile_key=v_availability->>'profileKey' and p.purpose=(p_request->>'purpose')::exam_delivery.attempt_purpose
    and p.enabled and p.access_mode<>'disabled' for share;
  if not found then return jsonb_build_object('ok',false,'code','practice_unavailable'); end if;
  v_availability := exam_delivery.practice_availability(p_actor_id,p_request);
  if not coalesce((v_availability->>'ok')::boolean,false) then return v_availability; end if;

  select pv.id package_version_id,pv.generator_version,pv.scorer_version,pp.id package_profile_id,pp.time_limit_minutes
    into strict v_package from exam_delivery.package_versions pv
  join exam_delivery.package_profiles pp on pp.package_version_id=pv.id
  where exam_delivery.normalize_exam_key(pv.exam_key)=v_availability->>'examKey'
    and pv.package_version=v_availability->>'packageVersion' and pp.profile_key=v_availability->>'profileKey'
    and pv.package_schema_version='certsim-protected-package-v2' and pv.status='published'
  for share of pv,pp;

  insert into exam_delivery.attempts(
    owner_id,package_version_id,package_profile_id,protected_assignment_id,client_request_id,status,
    generator_version,scorer_version,created_at,started_at,expires_at,purpose,practice_configuration,language_preference
  ) values (
    p_actor_id,v_package.package_version_id,v_package.package_profile_id,null,v_request_id,'in_progress',
    v_package.generator_version,v_package.scorer_version,v_now,v_now,
    v_now+make_interval(mins=>v_package.time_limit_minutes),(p_request->>'purpose')::exam_delivery.attempt_purpose,
    v_configuration,p_request->>'language'
  ) returning * into v_attempt;
  v_limit := (v_availability->>'selectedCount')::integer;
  perform exam_delivery.materialize_attempt_items(v_attempt.id,v_request_id,v_limit);
  return exam_delivery.resume_attempt(p_actor_id,v_attempt.id);
exception when no_data_found or too_many_rows then return jsonb_build_object('ok',false,'code','package_unavailable');
when unique_violation then return jsonb_build_object('ok',false,'code','attempt_conflict');
end $$;

revoke execute on function exam_delivery.materialize_attempt_items(uuid,uuid,integer)
  from public, anon, authenticated, service_role;
revoke execute on function exam_delivery.start_attempt_v2(uuid,text,text,uuid)
  from public, anon, authenticated, service_role;
revoke execute on function exam_delivery.start_practice(uuid,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function exam_delivery.start_practice(uuid,jsonb) to service_role;
