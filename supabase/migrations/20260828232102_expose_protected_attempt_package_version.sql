-- Issue #20 Phase G1: expose the immutable package binding already held by the
-- attempt. This changes projection only; ownership and lifecycle checks remain
-- identical to the canonical resume operation.

create or replace function exam_delivery.resume_attempt(
  p_actor_id uuid,
  p_attempt_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '10s'
as $$
declare
  v_attempt record;
begin
  select a.*, pv.exam_key, pv.package_version, pp.profile_key,
         pp.display_name, pp.time_limit_minutes
    into v_attempt
    from exam_delivery.attempts a
    join exam_delivery.package_versions pv on pv.id = a.package_version_id
    join exam_delivery.package_profiles pp on pp.id = a.package_profile_id
   where a.id = p_attempt_id and a.owner_id = p_actor_id;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'attempt_not_found');
  end if;
  if v_attempt.status <> 'in_progress' then
    return jsonb_build_object('ok', false, 'code', 'invalid_lifecycle_transition');
  end if;
  if not (exam_delivery.check_eligibility(
    p_actor_id,
    v_attempt.exam_key,
    v_attempt.profile_key
  )->>'eligible')::boolean then
    return jsonb_build_object('ok', false, 'code', 'pilot_unavailable');
  end if;

  return jsonb_build_object(
    'ok', true,
    'attempt', jsonb_build_object(
      'attemptId', v_attempt.id,
      'examKey', v_attempt.exam_key,
      'packageVersion', v_attempt.package_version,
      'profileKey', v_attempt.profile_key,
      'profileName', v_attempt.display_name,
      'status', v_attempt.status,
      'startedAt', v_attempt.started_at,
      'expiresAt', v_attempt.expires_at,
      'timeLimitMinutes', v_attempt.time_limit_minutes
    ),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'itemId', i.id,
        'questionNumber', i.presented_question_number,
        'questionId', q.question_id,
        'questionType', q.question_type,
        'domain', q.domain_key,
        'section', q.section_key,
        'presentation', i.presentation_snapshot,
        'response', r.response_payload,
        'revision', coalesce(r.revision, 0)
      ) order by i.presented_question_number)
      from exam_delivery.attempt_items i
      join exam_delivery.package_questions q on q.id = i.package_question_id
      left join exam_delivery.attempt_responses r
        on r.attempt_id = i.attempt_id
       and r.attempt_item_id = i.id
      where i.attempt_id = v_attempt.id
    ), '[]'::jsonb)
  );
end;
$$;

revoke execute on function exam_delivery.resume_attempt(uuid, uuid)
  from public, anon, authenticated;
grant execute on function exam_delivery.resume_attempt(uuid, uuid)
  to service_role;
