-- CertSim protected exam-delivery student runtime operations.
--
-- This migration exposes seven fixed server-only RPC wrappers. Browser roles
-- retain no access to the private schema or these wrappers. Publication and
-- administrative review release are intentionally out of scope.

alter table exam_delivery.attempt_responses
  add column last_request_id uuid not null;

alter table exam_delivery.attempt_responses
  add constraint attempt_responses_request_unique unique (attempt_id, last_request_id);

create unique index attempts_one_active_profile_idx
  on exam_delivery.attempts (owner_id, package_profile_id)
  where status = 'in_progress';

create index exam_assignments_student_runtime_idx
  on public.exam_assignments (student_user_id, exam_key, profile_id, status, available_from, due_at)
  where status = 'active';

create index exam_assignments_group_runtime_idx
  on public.exam_assignments (group_id, exam_key, profile_id, status, available_from, due_at)
  where status = 'active';

create index memberships_student_runtime_idx
  on public.memberships (user_id, role, status, group_id, organisation_id, campus_id)
  where role = 'student' and status = 'active';

create function exam_delivery.check_eligibility(
  p_actor_id uuid,
  p_exam_key text,
  p_profile_key text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := statement_timestamp();
  v_profile_count integer;
  v_profile record;
begin
  if p_actor_id is null or p_exam_key <> 'ai-901' or nullif(btrim(p_profile_key), '') is null then
    return jsonb_build_object('eligible', false, 'reasonCode', 'invalid_request');
  end if;

  if not exists (
    select 1 from public.profiles p
    where p.id = p_actor_id and p.status = 'active'
  ) then
    return jsonb_build_object('eligible', false, 'reasonCode', 'inactive_account');
  end if;

  if not exists (
    select 1
    from public.memberships m
    join public.organisations o on o.id = m.organisation_id and o.status = 'active'
    left join public.campuses c on c.id = m.campus_id
    left join public."groups" g on g.id = m.group_id
    where m.user_id = p_actor_id
      and m.role = 'student'
      and m.status = 'active'
      and (m.campus_id is null or c.status = 'active')
      and (m.group_id is null or g.status = 'active')
  ) then
    return jsonb_build_object('eligible', false, 'reasonCode', 'inactive_membership');
  end if;

  if not exists (
    select 1 from exam_delivery.pilot_gates gate
    where gate.exam_key = p_exam_key and gate.enabled
  ) then
    return jsonb_build_object('eligible', false, 'reasonCode', 'pilot_disabled');
  end if;

  if not exists (
    select 1 from exam_delivery.pilot_access access
    where access.user_id = p_actor_id
      and access.exam_key = p_exam_key
      and access.enabled
      and (access.access_starts_at is null or access.access_starts_at <= v_now)
      and (access.access_ends_at is null or access.access_ends_at > v_now)
  ) then
    return jsonb_build_object('eligible', false, 'reasonCode', 'not_allowlisted');
  end if;

  if not exists (
    select 1
    from public.exam_assignments a
    where a.exam_key = p_exam_key
      and a.profile_id = p_profile_key
      and a.status = 'active'
      and (a.available_from is null or a.available_from <= v_now)
      and (a.due_at is null or a.due_at >= v_now)
      and (
        a.student_user_id = p_actor_id
        or exists (
          select 1
          from public.memberships m
          join public.organisations o on o.id = m.organisation_id and o.status = 'active'
          left join public.campuses c on c.id = m.campus_id
          join public."groups" g on g.id = m.group_id and g.status = 'active'
          where m.user_id = p_actor_id
            and m.role = 'student'
            and m.status = 'active'
            and m.group_id = a.group_id
            and m.organisation_id = a.organisation_id
            and (a.campus_id is null or (m.campus_id = a.campus_id and c.status = 'active'))
        )
      )
  ) then
    return jsonb_build_object('eligible', false, 'reasonCode', 'not_assigned');
  end if;

  select count(*)::integer
    into v_profile_count
    from exam_delivery.package_versions pv
    join exam_delivery.package_profiles pp on pp.package_version_id = pv.id
   where pv.exam_key = p_exam_key
     and pv.status = 'published'
     and pp.profile_key = p_profile_key;

  if v_profile_count = 0 then
    return jsonb_build_object('eligible', false, 'reasonCode', 'no_published_package');
  end if;
  if v_profile_count <> 1 then
    return jsonb_build_object('eligible', false, 'reasonCode', 'ambiguous_publication');
  end if;

  select pp.profile_key, pp.display_name, pp.question_count, pp.time_limit_minutes
    into v_profile
    from exam_delivery.package_versions pv
    join exam_delivery.package_profiles pp on pp.package_version_id = pv.id
   where pv.exam_key = p_exam_key
     and pv.status = 'published'
     and pp.profile_key = p_profile_key;

  return jsonb_build_object(
    'eligible', true,
    'reasonCode', 'eligible',
    'profileKey', v_profile.profile_key,
    'profileName', v_profile.display_name,
    'questionCount', v_profile.question_count,
    'timeLimitMinutes', v_profile.time_limit_minutes
  );
end;
$$;

create function exam_delivery.start_attempt(
  p_actor_id uuid,
  p_exam_key text,
  p_profile_key text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_eligibility jsonb;
  v_existing exam_delivery.attempts%rowtype;
  v_package record;
  v_attempt exam_delivery.attempts%rowtype;
  v_now timestamptz := statement_timestamp();
  v_inserted integer;
begin
  perform set_config('statement_timeout', '10s', true);
  if p_request_id is null then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_actor_id::text || ':' || p_exam_key || ':' || p_profile_key, 0));

  select a.* into v_existing
  from exam_delivery.attempts a
  where a.owner_id = p_actor_id and a.client_request_id = p_request_id;

  if found then
    if exists (
      select 1 from exam_delivery.package_profiles pp
      join exam_delivery.package_versions pv on pv.id = pp.package_version_id
      where pp.id = v_existing.package_profile_id
        and pp.profile_key = p_profile_key and pv.exam_key = p_exam_key
    ) then
      return exam_delivery.resume_attempt(p_actor_id, v_existing.id);
    end if;
    return jsonb_build_object('ok', false, 'code', 'attempt_conflict');
  end if;

  v_eligibility := exam_delivery.check_eligibility(p_actor_id, p_exam_key, p_profile_key);
  if not coalesce((v_eligibility->>'eligible')::boolean, false) then
    return jsonb_build_object('ok', false, 'code', v_eligibility->>'reasonCode');
  end if;

  select pv.id package_version_id, pv.generator_version, pv.scorer_version,
         pp.id package_profile_id, pp.question_count, pp.time_limit_minutes,
         pp.selection_config, pp.profile_key, pp.display_name
    into strict v_package
    from exam_delivery.package_versions pv
    join exam_delivery.package_profiles pp on pp.package_version_id = pv.id
   where pv.exam_key = p_exam_key and pv.status = 'published' and pp.profile_key = p_profile_key
   for share of pv, pp;

  if exists (
    select 1 from exam_delivery.attempts a
    where a.owner_id = p_actor_id and a.package_profile_id = v_package.package_profile_id
      and a.status = 'in_progress'
  ) then
    return jsonb_build_object('ok', false, 'code', 'active_attempt_exists');
  end if;

  insert into exam_delivery.attempts (
    owner_id, package_version_id, package_profile_id, client_request_id,
    status, generator_version, scorer_version, created_at, started_at, expires_at
  ) values (
    p_actor_id, v_package.package_version_id, v_package.package_profile_id, p_request_id,
    'in_progress', v_package.generator_version, v_package.scorer_version,
    v_now, v_now, v_now + make_interval(mins => v_package.time_limit_minutes)
  ) returning * into v_attempt;

  with ranked as (
    select q.*,
      row_number() over (
        partition by q.domain_key
        order by md5(p_request_id::text || ':' || q.question_id), q.source_ordinal
      ) domain_rank,
      coalesce((v_package.selection_config->'domainDistribution'->>q.domain_key)::integer, 0) domain_target
    from exam_delivery.package_questions q
    where q.package_version_id = v_package.package_version_id
  ), selected as (
    select * from ranked where domain_rank <= domain_target
    order by md5(p_request_id::text || ':' || question_id), source_ordinal
    limit v_package.question_count
  ), inserted as (
    insert into exam_delivery.attempt_items (
      attempt_id, package_version_id, package_question_id, presented_question_number,
      section_ordinal, option_order, presentation_snapshot, presentation_hash
    )
    select v_attempt.id, v_package.package_version_id, s.id,
      row_number() over (order by md5(p_request_id::text || ':' || s.question_id), s.source_ordinal),
      null,
      coalesce((select jsonb_agg(option->>'id') from jsonb_array_elements(coalesce(s.presentation_payload->'options', '[]'::jsonb)) option), '[]'::jsonb),
      s.presentation_payload,
      encode(extensions.digest(convert_to(s.presentation_payload::text, 'UTF8'), 'sha256'), 'hex')
    from selected s
    returning id, package_question_id
  )
  insert into exam_delivery.attempt_item_protected_content (
    attempt_item_id, attempt_id, scoring_snapshot, review_snapshot, protected_snapshot_hash
  )
  select i.id, v_attempt.id, pc.scoring_payload, pc.review_payload,
    encode(extensions.digest(convert_to((pc.scoring_payload || pc.review_payload)::text, 'UTF8'), 'sha256'), 'hex')
  from inserted i
  join exam_delivery.package_question_protected_content pc on pc.question_id = i.package_question_id;

  get diagnostics v_inserted = row_count;
  if v_inserted <> v_package.question_count then
    raise exception using errcode = 'P0001', message = 'selection_incomplete';
  end if;

  return exam_delivery.resume_attempt(p_actor_id, v_attempt.id);
exception
  when no_data_found or too_many_rows then
    return jsonb_build_object('ok', false, 'code', 'ambiguous_publication');
  when unique_violation then
    return jsonb_build_object('ok', false, 'code', 'attempt_conflict');
  when others then
    return jsonb_build_object('ok', false, 'code', 'internal_failure');
end;
$$;

create function exam_delivery.resume_attempt(p_actor_id uuid, p_attempt_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_attempt record;
begin
  select a.*, pv.exam_key, pp.profile_key, pp.display_name, pp.time_limit_minutes
    into v_attempt
    from exam_delivery.attempts a
    join exam_delivery.package_versions pv on pv.id = a.package_version_id
    join exam_delivery.package_profiles pp on pp.id = a.package_profile_id
   where a.id = p_attempt_id and a.owner_id = p_actor_id;
  if not found then return jsonb_build_object('ok', false, 'code', 'attempt_not_found'); end if;
  if v_attempt.status <> 'in_progress' then return jsonb_build_object('ok', false, 'code', 'invalid_lifecycle_transition'); end if;
  if not (exam_delivery.check_eligibility(p_actor_id, v_attempt.exam_key, v_attempt.profile_key)->>'eligible')::boolean then
    return jsonb_build_object('ok', false, 'code', 'pilot_unavailable');
  end if;
  return jsonb_build_object(
    'ok', true,
    'attempt', jsonb_build_object(
      'attemptId', v_attempt.id, 'examKey', v_attempt.exam_key,
      'profileKey', v_attempt.profile_key, 'profileName', v_attempt.display_name,
      'status', v_attempt.status, 'startedAt', v_attempt.started_at,
      'expiresAt', v_attempt.expires_at, 'timeLimitMinutes', v_attempt.time_limit_minutes
    ),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'itemId', i.id, 'questionNumber', i.presented_question_number,
        'questionId', q.question_id, 'questionType', q.question_type,
        'domain', q.domain_key, 'section', q.section_key,
        'presentation', i.presentation_snapshot,
        'response', r.response_payload, 'revision', coalesce(r.revision, 0)
      ) order by i.presented_question_number)
      from exam_delivery.attempt_items i
      join exam_delivery.package_questions q on q.id = i.package_question_id
      left join exam_delivery.attempt_responses r on r.attempt_id = i.attempt_id and r.attempt_item_id = i.id
      where i.attempt_id = v_attempt.id
    ), '[]'::jsonb)
  );
end;
$$;

create function exam_delivery.validate_response(p_question_type text, p_response jsonb)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select jsonb_typeof(p_response) = 'object' and p_response ? 'answer' and case
    when p_question_type = 'single-choice' then jsonb_typeof(p_response->'answer') = 'string'
    when p_question_type in ('multi-select', 'reorder') then jsonb_typeof(p_response->'answer') = 'array'
    when p_question_type in ('drag-drop-match', 'dropdown-code', 'dropdown-command') then jsonb_typeof(p_response->'answer') = 'object'
    else false
  end;
$$;

create function exam_delivery.save_response(
  p_actor_id uuid, p_attempt_id uuid, p_item_id uuid, p_response jsonb,
  p_expected_revision integer, p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt record;
  v_type text;
  v_existing exam_delivery.attempt_responses%rowtype;
  v_saved exam_delivery.attempt_responses%rowtype;
  v_now timestamptz := statement_timestamp();
begin
  perform set_config('statement_timeout', '5s', true);
  if p_request_id is null or p_expected_revision < 0 then return jsonb_build_object('ok', false, 'code', 'invalid_request'); end if;
  select a.*, pv.exam_key, pp.profile_key into v_attempt
  from exam_delivery.attempts a
  join exam_delivery.package_versions pv on pv.id = a.package_version_id
  join exam_delivery.package_profiles pp on pp.id = a.package_profile_id
  where a.id = p_attempt_id and a.owner_id = p_actor_id for update of a;
  if not found then return jsonb_build_object('ok', false, 'code', 'attempt_not_found'); end if;
  if not (exam_delivery.check_eligibility(p_actor_id, v_attempt.exam_key, v_attempt.profile_key)->>'eligible')::boolean then
    return jsonb_build_object('ok', false, 'code', 'pilot_unavailable');
  end if;
  if v_attempt.status <> 'in_progress' or v_now >= v_attempt.expires_at then
    return jsonb_build_object('ok', false, 'code', 'invalid_lifecycle_transition');
  end if;
  select q.question_type into v_type
  from exam_delivery.attempt_items i join exam_delivery.package_questions q on q.id = i.package_question_id
  where i.attempt_id = p_attempt_id and i.id = p_item_id;
  if not found then return jsonb_build_object('ok', false, 'code', 'attempt_not_found'); end if;
  if not exam_delivery.validate_response(v_type, p_response) then return jsonb_build_object('ok', false, 'code', 'response_invalid'); end if;

  select r.* into v_existing from exam_delivery.attempt_responses r
  where r.attempt_id = p_attempt_id and r.attempt_item_id = p_item_id for update;
  if found and v_existing.last_request_id = p_request_id then
    if v_existing.response_payload = p_response and v_existing.revision = p_expected_revision + 1 then
      return jsonb_build_object('ok', true, 'itemId', p_item_id, 'revision', v_existing.revision, 'updatedAt', v_existing.updated_at);
    end if;
    return jsonb_build_object('ok', false, 'code', 'response_conflict');
  end if;
  if coalesce(v_existing.revision, 0) <> p_expected_revision then
    return jsonb_build_object('ok', false, 'code', 'stale_response');
  end if;

  insert into exam_delivery.attempt_responses (
    attempt_id, attempt_item_id, response_payload, revision, last_request_id, created_at, updated_at
  ) values (p_attempt_id, p_item_id, p_response, p_expected_revision + 1, p_request_id, v_now, v_now)
  on conflict (attempt_id, attempt_item_id) do update set
    response_payload = excluded.response_payload,
    revision = excluded.revision,
    last_request_id = excluded.last_request_id,
    updated_at = excluded.updated_at
  where exam_delivery.attempt_responses.revision = p_expected_revision
  returning * into v_saved;
  if not found then return jsonb_build_object('ok', false, 'code', 'stale_response'); end if;
  return jsonb_build_object('ok', true, 'itemId', p_item_id, 'revision', v_saved.revision, 'updatedAt', v_saved.updated_at);
exception when unique_violation then
  return jsonb_build_object('ok', false, 'code', 'response_conflict');
when others then
  return jsonb_build_object('ok', false, 'code', 'internal_failure');
end;
$$;

create function exam_delivery.score_response(p_scoring jsonb, p_response jsonb)
returns numeric
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  v_model text := p_scoring->>'model';
  v_answer jsonb := p_response->'answer';
begin
  if v_model = 'exact-single' then
    return case when jsonb_typeof(v_answer) = 'string' and v_answer = to_jsonb(p_scoring->>'correctOptionId') then 1 else 0 end;
  elsif v_model in ('exact-set', 'exact-order') then
    if jsonb_typeof(v_answer) <> 'array' then return 0; end if;
    if v_model = 'exact-order' then
      return case when v_answer = p_scoring->'correctItemIds' then 1 else 0 end;
    end if;
    return case when
      (select coalesce(jsonb_agg(value order by value), '[]'::jsonb) from jsonb_array_elements_text(v_answer)) =
      (select coalesce(jsonb_agg(value order by value), '[]'::jsonb) from jsonb_array_elements_text(p_scoring->'correctOptionIds'))
      and jsonb_array_length(v_answer) = jsonb_array_length(p_scoring->'correctOptionIds')
      then 1 else 0 end;
  elsif v_model in ('exact-pairs', 'exact-dropdowns') then
    return case when jsonb_typeof(v_answer) = 'object' and v_answer =
      case when v_model = 'exact-pairs' then p_scoring->'correctPairs' else p_scoring->'correctOptionIdsByBlank' end
      then 1 else 0 end;
  end if;
  raise exception using errcode = 'P0001', message = 'unsupported_scoring_model';
end;
$$;

create function exam_delivery.submit_attempt(p_actor_id uuid, p_attempt_id uuid, p_submission_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt record;
  v_existing exam_delivery.attempt_results%rowtype;
  v_now timestamptz := statement_timestamp();
  v_response_hash text;
  v_raw numeric(12,4);
  v_max numeric(12,4);
  v_percentage numeric(7,4);
  v_scaled integer;
  v_pass_mark integer;
  v_passed boolean;
  v_domain jsonb;
  v_summary jsonb;
  v_review jsonb;
  v_catalog_id uuid;
begin
  perform set_config('statement_timeout', '15s', true);
  if p_submission_id is null then return jsonb_build_object('ok', false, 'code', 'invalid_request'); end if;
  select a.*, pv.exam_key, pv.package_version, pp.profile_key, pp.time_limit_minutes, pp.selection_config
    into v_attempt
    from exam_delivery.attempts a
    join exam_delivery.package_versions pv on pv.id = a.package_version_id
    join exam_delivery.package_profiles pp on pp.id = a.package_profile_id
   where a.id = p_attempt_id and a.owner_id = p_actor_id for update of a;
  if not found then return jsonb_build_object('ok', false, 'code', 'attempt_not_found'); end if;
  if not (exam_delivery.check_eligibility(p_actor_id, v_attempt.exam_key, v_attempt.profile_key)->>'eligible')::boolean then
    return jsonb_build_object('ok', false, 'code', 'pilot_unavailable');
  end if;

  select ar.* into v_existing from exam_delivery.attempt_results ar where ar.attempt_id = p_attempt_id;
  if found then
    if v_existing.submission_id = p_submission_id then return exam_delivery.get_result(p_actor_id, p_attempt_id); end if;
    return jsonb_build_object('ok', false, 'code', 'submission_conflict');
  end if;
  if v_attempt.status <> 'in_progress' then return jsonb_build_object('ok', false, 'code', 'invalid_lifecycle_transition'); end if;

  select encode(extensions.digest(convert_to(coalesce(jsonb_agg(jsonb_build_object('itemId', i.id, 'response', r.response_payload) order by i.id)::text, '[]'), 'UTF8'), 'sha256'), 'hex')
    into v_response_hash
    from exam_delivery.attempt_items i left join exam_delivery.attempt_responses r on r.attempt_id=i.attempt_id and r.attempt_item_id=i.id
   where i.attempt_id=p_attempt_id;

  select sum(exam_delivery.score_response(pc.scoring_snapshot,coalesce(r.response_payload,'{"answer":null}'::jsonb))),
         sum((pc.scoring_snapshot->>'maxPoints')::numeric)
    into v_raw, v_max
    from exam_delivery.attempt_items i
    join exam_delivery.attempt_item_protected_content pc on pc.attempt_id=i.attempt_id and pc.attempt_item_id=i.id
    left join exam_delivery.attempt_responses r on r.attempt_id=i.attempt_id and r.attempt_item_id=i.id
   where i.attempt_id=p_attempt_id;

  -- Rebuild domain summary independently to guarantee one object entry per domain.
  select coalesce(jsonb_object_agg(domain_key, row_value), '{}'::jsonb) into v_domain from (
    select q.domain_key, jsonb_build_object('domain',q.domain_key,'correct',count(*) filter(where exam_delivery.score_response(pc.scoring_snapshot,coalesce(r.response_payload,'{"answer":null}'::jsonb))=1),'total',count(*),'earnedPoints',sum(exam_delivery.score_response(pc.scoring_snapshot,coalesce(r.response_payload,'{"answer":null}'::jsonb))),'maxPoints',sum((pc.scoring_snapshot->>'maxPoints')::numeric),'percentage',round(100*sum(exam_delivery.score_response(pc.scoring_snapshot,coalesce(r.response_payload,'{"answer":null}'::jsonb)))/count(*),2)) row_value
    from exam_delivery.attempt_items i join exam_delivery.package_questions q on q.id=i.package_question_id join exam_delivery.attempt_item_protected_content pc on pc.attempt_item_id=i.id left join exam_delivery.attempt_responses r on r.attempt_item_id=i.id
    where i.attempt_id=p_attempt_id group by q.domain_key
  ) domains;

  select jsonb_build_object(
    'questionCount', count(*),
    'answeredCount', count(*) filter (where r.response_payload->'answer' is not null and r.response_payload->'answer' <> 'null'::jsonb)
  ) into v_summary
  from exam_delivery.attempt_items i
  left join exam_delivery.attempt_responses r on r.attempt_id=i.attempt_id and r.attempt_item_id=i.id
  where i.attempt_id=p_attempt_id;

  select jsonb_build_object('items', jsonb_agg(jsonb_build_object(
    'itemId', i.id, 'questionNumber', i.presented_question_number, 'questionId', q.question_id,
    'questionType', q.question_type, 'domain', q.domain_key, 'section', q.section_key,
    'presentation', i.presentation_snapshot,
    'response', coalesce(r.response_payload,'{"answer":null}'::jsonb),
    'status', case
      when r.response_payload is null then 'Incomplete'
      when exam_delivery.score_response(pc.scoring_snapshot,r.response_payload)=(pc.scoring_snapshot->>'maxPoints')::numeric then 'Correct'
      else 'Incorrect' end,
    'earnedPoints', exam_delivery.score_response(pc.scoring_snapshot,coalesce(r.response_payload,'{"answer":null}'::jsonb)),
    'maxPoints', (pc.scoring_snapshot->>'maxPoints')::numeric,
    'correctAnswer', pc.scoring_snapshot - 'model' - 'maxPoints' - 'requiredSelectionCount',
    'explanation', pc.review_snapshot->>'explanation',
    'remediation', pc.review_snapshot->>'remediation'
  ) order by i.presented_question_number)) into v_review
  from exam_delivery.attempt_items i
  join exam_delivery.package_questions q on q.id=i.package_question_id
  join exam_delivery.attempt_item_protected_content pc on pc.attempt_id=i.attempt_id and pc.attempt_item_id=i.id
  left join exam_delivery.attempt_responses r on r.attempt_id=i.attempt_id and r.attempt_item_id=i.id
  where i.attempt_id=p_attempt_id;

  v_percentage := round(100 * v_raw / v_max, 4);
  v_pass_mark := coalesce((v_attempt.selection_config->'scoringContract'->'scoreScale'->>'pass')::integer, 700);
  v_scaled := round(coalesce((v_attempt.selection_config->'scoringContract'->'scoreScale'->>'min')::numeric, 0) + (v_percentage/100) * (coalesce((v_attempt.selection_config->'scoringContract'->'scoreScale'->>'max')::numeric,1000)-coalesce((v_attempt.selection_config->'scoringContract'->'scoreScale'->>'min')::numeric,0)));
  v_passed := v_scaled >= v_pass_mark;
  v_summary := v_summary || jsonb_build_object('rawScore',v_raw,'maxScore',v_max,'rawPercentage',v_percentage,'scaledScore',v_scaled,'passed',v_passed,'passMark',v_pass_mark);

  insert into exam_delivery.attempt_results(attempt_id,submission_id,response_hash,scorer_version,raw_score,max_score,raw_percentage,passed,domain_summary,result_summary,server_authoritative,submitted_at,completed_at,created_at)
  values(p_attempt_id,p_submission_id,v_response_hash,v_attempt.scorer_version,v_raw,v_max,v_percentage,v_passed,v_domain,v_summary,true,v_now,v_now,v_now);
  insert into exam_delivery.review_snapshots(attempt_id,release_status,review_payload,review_hash,created_at)
  values(p_attempt_id,'withheld',v_review,encode(extensions.digest(convert_to(v_review::text,'UTF8'),'sha256'),'hex'),v_now);
  update exam_delivery.attempts set status='completed',submitted_at=v_now,completed_at=v_now where id=p_attempt_id;

  select id into v_catalog_id from public.exam_catalog where exam_key=v_attempt.exam_key and status='active' limit 1;
  insert into public.exam_attempts(id,user_id,exam_catalog_id,exam_key,exam_version,profile_id,mode_label,status,started_at,submitted_at,duration_seconds,time_limit_minutes,selected_question_ids,presented_order_snapshot,attempt_snapshot,client_app_version,created_at,updated_at)
  select p_attempt_id,p_actor_id,v_catalog_id,v_attempt.exam_key,v_attempt.package_version,v_attempt.profile_key,'Protected AI-901 Pilot','submitted',v_attempt.started_at,v_now,greatest(0,extract(epoch from v_now-v_attempt.started_at)::integer),v_attempt.time_limit_minutes,
    jsonb_agg(q.question_id order by i.presented_question_number),
    jsonb_build_object('questionIds',jsonb_agg(q.question_id order by i.presented_question_number),'itemTypes',jsonb_agg(jsonb_build_object('id',q.question_id,'type',q.question_type,'domain',q.domain_key,'isScored',true) order by i.presented_question_number)),
    jsonb_build_object('attemptId',p_attempt_id,'sourceFlow','protected-exam-delivery','serverAuthoritative',true),
    'protected-server-v1',v_attempt.created_at,v_now
  from exam_delivery.attempt_items i join exam_delivery.package_questions q on q.id=i.package_question_id where i.attempt_id=p_attempt_id;

  insert into public.exam_responses(attempt_id,question_id,question_type,response_snapshot,presented_snapshot,is_answered,is_scored,created_at)
  select p_attempt_id,q.question_id,q.question_type,coalesce(r.response_payload,'{"answer":null}'::jsonb),i.presentation_snapshot,(r.response_payload->'answer') is not null,true,v_now
  from exam_delivery.attempt_items i join exam_delivery.package_questions q on q.id=i.package_question_id left join exam_delivery.attempt_responses r on r.attempt_item_id=i.id where i.attempt_id=p_attempt_id;
  insert into public.exam_results(attempt_id,user_id,exam_key,profile_id,scoring_engine_version,raw_score,raw_percentage,scaled_score,passed,pass_mark,domain_breakdown,pbq_breakdown,case_study_breakdown,weak_areas,result_snapshot,created_at)
  values(p_attempt_id,p_actor_id,v_attempt.exam_key,v_attempt.profile_key,v_attempt.scorer_version,v_raw,v_percentage,v_scaled,v_passed,v_pass_mark,v_domain,'{}','{}','[]',v_summary,v_now);
  insert into public.exam_reports(attempt_id,user_id,report_type,report_title,report_snapshot,pdf_generated,created_at)
  values(p_attempt_id,p_actor_id,'study_report_snapshot','AI-901 Protected Pilot Study Report',jsonb_build_object('result',v_summary,'domainBreakdown',v_domain,'reviewStatus','withheld','serverAuthoritative',true),false,v_now);

  return exam_delivery.get_result(p_actor_id,p_attempt_id);
exception when unique_violation then return jsonb_build_object('ok',false,'code','submission_conflict');
when others then return jsonb_build_object('ok',false,'code','internal_failure');
end;
$$;

create function exam_delivery.get_result(p_actor_id uuid, p_attempt_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce((select jsonb_build_object('ok',true,'result',ar.result_summary || jsonb_build_object('attemptId',a.id,'examKey',pv.exam_key,'profileKey',pp.profile_key,'completedAt',ar.completed_at,'domainBreakdown',ar.domain_summary,'reviewStatus',rs.release_status))
    from exam_delivery.attempts a join exam_delivery.package_versions pv on pv.id=a.package_version_id join exam_delivery.package_profiles pp on pp.id=a.package_profile_id join exam_delivery.attempt_results ar on ar.attempt_id=a.id join exam_delivery.review_snapshots rs on rs.attempt_id=a.id
    where a.id=p_attempt_id and a.owner_id=p_actor_id and a.status='completed'), jsonb_build_object('ok',false,'code','attempt_not_found'));
$$;

create function exam_delivery.get_review(p_actor_id uuid, p_attempt_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case
    when not exists(select 1 from exam_delivery.attempts a where a.id=p_attempt_id and a.owner_id=p_actor_id and a.status='completed') then jsonb_build_object('ok',false,'code','attempt_not_found')
    when not exists(select 1 from exam_delivery.review_snapshots r join exam_delivery.attempts a on a.id=r.attempt_id where r.attempt_id=p_attempt_id and a.owner_id=p_actor_id and r.release_status='released') then jsonb_build_object('ok',false,'code','review_unavailable')
    else (select jsonb_build_object('ok',true,'review',r.review_payload) from exam_delivery.review_snapshots r where r.attempt_id=p_attempt_id)
  end;
$$;

-- Fixed Data API entry points. They are invokers and can only call the exact
-- private operations granted below; no wrapper is a privileged definer.
create function public.certsim_protected_check_eligibility(p_actor_id uuid,p_exam_key text,p_profile_key text) returns jsonb language sql stable security invoker set search_path='' as $$ select exam_delivery.check_eligibility(p_actor_id,p_exam_key,p_profile_key) $$;
create function public.certsim_protected_start_attempt(p_actor_id uuid,p_exam_key text,p_profile_key text,p_request_id uuid) returns jsonb language sql security invoker set search_path='' as $$ select exam_delivery.start_attempt(p_actor_id,p_exam_key,p_profile_key,p_request_id) $$;
create function public.certsim_protected_resume_attempt(p_actor_id uuid,p_attempt_id uuid) returns jsonb language sql stable security invoker set search_path='' as $$ select exam_delivery.resume_attempt(p_actor_id,p_attempt_id) $$;
create function public.certsim_protected_save_response(p_actor_id uuid,p_attempt_id uuid,p_item_id uuid,p_response jsonb,p_expected_revision integer,p_request_id uuid) returns jsonb language sql security invoker set search_path='' as $$ select exam_delivery.save_response(p_actor_id,p_attempt_id,p_item_id,p_response,p_expected_revision,p_request_id) $$;
create function public.certsim_protected_submit_attempt(p_actor_id uuid,p_attempt_id uuid,p_submission_id uuid) returns jsonb language sql security invoker set search_path='' as $$ select exam_delivery.submit_attempt(p_actor_id,p_attempt_id,p_submission_id) $$;
create function public.certsim_protected_get_result(p_actor_id uuid,p_attempt_id uuid) returns jsonb language sql stable security invoker set search_path='' as $$ select exam_delivery.get_result(p_actor_id,p_attempt_id) $$;
create function public.certsim_protected_get_review(p_actor_id uuid,p_attempt_id uuid) returns jsonb language sql stable security invoker set search_path='' as $$ select exam_delivery.get_review(p_actor_id,p_attempt_id) $$;

revoke execute on all functions in schema exam_delivery from public, anon, authenticated, service_role;
revoke execute on function public.certsim_protected_check_eligibility(uuid,text,text) from public,anon,authenticated,service_role;
revoke execute on function public.certsim_protected_start_attempt(uuid,text,text,uuid) from public,anon,authenticated,service_role;
revoke execute on function public.certsim_protected_resume_attempt(uuid,uuid) from public,anon,authenticated,service_role;
revoke execute on function public.certsim_protected_save_response(uuid,uuid,uuid,jsonb,integer,uuid) from public,anon,authenticated,service_role;
revoke execute on function public.certsim_protected_submit_attempt(uuid,uuid,uuid) from public,anon,authenticated,service_role;
revoke execute on function public.certsim_protected_get_result(uuid,uuid) from public,anon,authenticated,service_role;
revoke execute on function public.certsim_protected_get_review(uuid,uuid) from public,anon,authenticated,service_role;

grant usage on schema exam_delivery to service_role;
grant execute on function exam_delivery.check_eligibility(uuid,text,text) to service_role;
grant execute on function exam_delivery.start_attempt(uuid,text,text,uuid) to service_role;
grant execute on function exam_delivery.resume_attempt(uuid,uuid) to service_role;
grant execute on function exam_delivery.save_response(uuid,uuid,uuid,jsonb,integer,uuid) to service_role;
grant execute on function exam_delivery.submit_attempt(uuid,uuid,uuid) to service_role;
grant execute on function exam_delivery.get_result(uuid,uuid) to service_role;
grant execute on function exam_delivery.get_review(uuid,uuid) to service_role;
grant execute on function public.certsim_protected_check_eligibility(uuid,text,text) to service_role;
grant execute on function public.certsim_protected_start_attempt(uuid,text,text,uuid) to service_role;
grant execute on function public.certsim_protected_resume_attempt(uuid,uuid) to service_role;
grant execute on function public.certsim_protected_save_response(uuid,uuid,uuid,jsonb,integer,uuid) to service_role;
grant execute on function public.certsim_protected_submit_attempt(uuid,uuid,uuid) to service_role;
grant execute on function public.certsim_protected_get_result(uuid,uuid) to service_role;
grant execute on function public.certsim_protected_get_review(uuid,uuid) to service_role;

revoke all on all tables in schema exam_delivery from service_role;
