-- Issue #20 G3C3: practice remains historical activity but cannot feed weak-area
-- assessment sources or formal readiness calculations. Function ownership,
-- privileges, RLS boundaries, search path, and timeout remain unchanged.

create or replace function exam_delivery.practice_availability(p_actor_id uuid,p_request jsonb)
returns jsonb language plpgsql stable security definer set search_path='' set statement_timeout='5s' as $$
declare v_exam text:=exam_delivery.normalize_exam_key(p_request->>'examKey'); v_profile text:=p_request->>'profileId';
  v_purpose text:=p_request->>'purpose'; v_version text; v_policy exam_delivery.practice_policies%rowtype;
  v_available integer:=0; v_pbq integer:=0; v_missed integer:=0; v_new integer:=0; v_domains jsonb:='{}'::jsonb; v_requested integer; v_allowed boolean:=false; v_package_id uuid; v_profile_id uuid;
begin
  if p_actor_id is null or v_purpose not in ('self_directed_exam','study_sandbox','targeted_domain','weak_area','pbq_practice')
     or p_request->>'language' not in ('csharp','python','mixed','not_applicable') then
    return jsonb_build_object('ok',false,'code','invalid_request'); end if;
  if not exists(select 1 from public.profiles where id=p_actor_id and status='active') then return jsonb_build_object('ok',false,'code','inactive_account'); end if;
  select pv.package_version,pv.id,pp.id into v_version,v_package_id,v_profile_id from exam_delivery.package_versions pv join exam_delivery.package_profiles pp on pp.package_version_id=pv.id
   where exam_delivery.normalize_exam_key(pv.exam_key)=v_exam and pv.status='published' and pp.profile_key=v_profile order by pv.published_at desc limit 1;
  if not found then return jsonb_build_object('ok',false,'code','package_unavailable'); end if;
  select * into v_policy from exam_delivery.practice_policies where canonical_exam_key=v_exam and package_version=v_version and profile_key=v_profile and purpose=v_purpose::exam_delivery.attempt_purpose;
  if not found or not v_policy.enabled or v_policy.access_mode='disabled' then return jsonb_build_object('ok',false,'code','practice_unavailable'); end if;
  if v_policy.access_mode='open_authenticated' then v_allowed:=true;
  elsif v_policy.access_mode='organisation_scoped' then v_allowed:=exists(select 1 from public.memberships m join exam_delivery.exam_access_organisations o on o.organisation_id=m.organisation_id and o.canonical_exam_key=v_exam and o.enabled where m.user_id=p_actor_id and m.status='active');
  elsif v_policy.access_mode='controlled_beta' then v_allowed:=exists(select 1 from exam_delivery.exam_access_learners l where l.learner_id=p_actor_id and l.canonical_exam_key=v_exam and l.enabled and (l.access_starts_at is null or l.access_starts_at<=statement_timestamp()) and (l.access_ends_at is null or l.access_ends_at>statement_timestamp()));
  elsif v_policy.access_mode='assignment_required' then v_allowed:=exists(select 1 from exam_delivery.protected_assignments a where a.learner_id=p_actor_id and a.package_version_id=v_package_id and a.package_profile_id=v_profile_id and a.status='active' and a.available_from<=statement_timestamp() and (a.expires_at is null or a.expires_at>statement_timestamp())); end if;
  if not v_allowed then return jsonb_build_object('ok',false,'code','access_not_granted'); end if;
  if v_policy.maximum_completed_attempts is not null and (select count(*) from exam_delivery.attempts a where a.owner_id=p_actor_id and a.package_version_id=v_package_id and a.package_profile_id=v_profile_id and a.purpose=v_policy.purpose and a.status='completed')>=v_policy.maximum_completed_attempts then return jsonb_build_object('ok',false,'code','attempt_limit_reached'); end if;
  if v_policy.cooldown_seconds>0 and exists(select 1 from exam_delivery.attempts a where a.owner_id=p_actor_id and a.package_version_id=v_package_id and a.package_profile_id=v_profile_id and a.purpose=v_policy.purpose and a.completed_at>statement_timestamp()-make_interval(secs=>v_policy.cooldown_seconds)) then return jsonb_build_object('ok',false,'code','cooldown_active'); end if;
  select count(*)::integer,count(*) filter(where q.question_type like 'pbq-%')::integer into v_available,v_pbq
    from exam_delivery.package_questions q join exam_delivery.package_versions pv on pv.id=q.package_version_id
    where exam_delivery.normalize_exam_key(pv.exam_key)=v_exam and pv.package_version=v_version;
  select coalesce(jsonb_object_agg(domain_key,total),'{}'::jsonb) into v_domains from (
    select q.domain_key,count(*)::integer total from exam_delivery.package_questions q join exam_delivery.package_versions pv on pv.id=q.package_version_id
    where exam_delivery.normalize_exam_key(pv.exam_key)=v_exam and pv.package_version=v_version group by q.domain_key
  ) d;
  if v_purpose='targeted_domain' and (nullif(p_request->>'domain','') is null or not (v_domains ? (p_request->>'domain'))) then return jsonb_build_object('ok',false,'code','unknown_domain'); end if;
  select count(distinct item->>'questionId')::integer into v_missed from exam_delivery.attempts a join exam_delivery.review_snapshots rs on rs.attempt_id=a.id
    cross join lateral jsonb_array_elements(coalesce(rs.review_payload->'items','[]'::jsonb)) item
    where a.owner_id=p_actor_id and a.package_version_id=v_package_id
      and a.status='completed'
      and a.purpose in ('assigned_assessment','self_directed_exam')
      and item->>'status' in ('Incorrect','Incomplete','Partial');
  select count(*)::integer into v_new from exam_delivery.package_questions q where q.package_version_id=v_package_id and not exists(
    select 1 from exam_delivery.attempt_items i join exam_delivery.attempts a on a.id=i.attempt_id where a.owner_id=p_actor_id and i.package_question_id=q.id);
  v_requested:=case when p_request->>'count'='all' then least(v_available,v_policy.maximum_session_items) else (p_request->>'count')::integer end;
  return jsonb_build_object('ok',true,'examKey',v_exam,'packageVersion',v_version,'profileKey',v_profile,'purpose',v_purpose,
    'available',v_available,'selectedCount',least(v_requested,v_available,v_policy.maximum_session_items),'adjustedCount',v_requested>least(v_available,v_policy.maximum_session_items),
    'domainCounts',v_domains,'missedCount',v_missed,'newCount',v_new,'pbqCount',v_pbq,'languages',case when v_exam='az204' and v_version='1.1.0' then '["csharp","python","mixed"]'::jsonb else '["not_applicable"]'::jsonb end);
end $$;




create or replace function exam_delivery.materialize_attempt_items(
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
          and prior.status='completed'
          and prior.purpose in ('assigned_assessment','self_directed_exam')
          and reviewed->>'questionId'=q.question_id
          and reviewed->>'status' in ('Incorrect','Incomplete','Partial')) missed,
      not exists(select 1 from exam_delivery.attempts prior
        join exam_delivery.attempt_items seen on seen.attempt_id=prior.id
        where prior.owner_id=v_attempt.owner_id and prior.id<>p_attempt_id
          and seen.package_question_id=q.id) unseen,
      exists(select 1 from exam_delivery.attempts prior
        join exam_delivery.attempt_results result on result.attempt_id=prior.id
        cross join lateral jsonb_each(result.domain_summary) domain
        where prior.owner_id=v_attempt.owner_id
          and prior.status='completed'
          and prior.purpose in ('assigned_assessment','self_directed_exam')
          and domain.key=q.domain_key
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
