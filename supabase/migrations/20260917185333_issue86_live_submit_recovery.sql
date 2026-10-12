begin;

-- A submission grading session freezes the authoritative attempt inputs before
-- any provider work starts. Once that freeze exists, natural timer expiry must
-- not strand the immutable submission while trusted grading is reconciled.
create or replace function exam_delivery.authorize_attempt_continuation(
  p_attempt_id uuid,
  p_operation text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  v record;
  v_assessment jsonb;
  v_assignment_continuation boolean;
  v_frozen_submission boolean;
begin
  if p_attempt_id is null
    or p_operation not in ('resume','save_response','check_item','submit') then
    return jsonb_build_object('ok',false,'code','invalid_request');
  end if;

  select
    a.owner_id,a.status,a.expires_at,a.purpose,a.practice_configuration,
    a.language_preference,a.package_version_id,a.package_profile_id,
    a.protected_assignment_id,a.source_assignment_id,a.attribution_source,
    pv.exam_key,pv.package_version,pv.package_schema_version,pp.profile_key,
    policy.access_mode,policy.enabled
  into v
  from exam_delivery.attempts a
  join exam_delivery.package_versions pv on pv.id=a.package_version_id
  join exam_delivery.package_profiles pp on pp.id=a.package_profile_id
  left join exam_delivery.practice_policies policy
    on policy.canonical_exam_key=exam_delivery.normalize_exam_key(pv.exam_key)
    and policy.package_version=pv.package_version
    and policy.profile_key=pp.profile_key
    and policy.purpose=a.purpose
  where a.id=p_attempt_id;

  if not found then
    return jsonb_build_object('ok',false,'code','attempt_not_found');
  end if;

  select exists(
    select 1
    from exam_delivery.python_submission_grading_sessions session
    where session.attempt_id=p_attempt_id
      and session.created_at < v.expires_at
  ) into v_frozen_submission;

  if v.status<>'in_progress'
    or (
      statement_timestamp()>=v.expires_at
      and not (p_operation='submit' and v_frozen_submission)
    ) then
    return jsonb_build_object('ok',false,'code','invalid_lifecycle_transition');
  end if;
  if not exists(
    select 1 from public.profiles profile
    where profile.id=v.owner_id and profile.status='active'
  ) then
    return jsonb_build_object('ok',false,'code','inactive_account');
  end if;

  v_assignment_continuation:=v.purpose='self_directed_exam'
    and v.source_assignment_id is not null
    and v.attribution_source='assignment';
  if v.purpose='assigned_assessment' then
    if v.protected_assignment_id is null or not exists(
      select 1
      from exam_delivery.protected_assignments assignment
      where assignment.id=v.protected_assignment_id
        and assignment.learner_id=v.owner_id
        and assignment.package_version_id=v.package_version_id
        and assignment.package_profile_id=v.package_profile_id
        and assignment.status='active'
        and assignment.available_from<=statement_timestamp()
        and (assignment.expires_at is null or assignment.expires_at>statement_timestamp())
    ) then
      v_assessment:=exam_delivery.check_assessment_eligibility_v2(
        v.owner_id,v.exam_key,v.profile_key
      );
      if not coalesce((v_assessment->>'eligible')::boolean,false) then
        return jsonb_build_object('ok',false,'code','exam_unavailable');
      end if;
    end if;
  else
    if not coalesce(v.enabled,false)
      or v.access_mode='disabled'
      or not exists(
        select 1
        from exam_delivery.exam_profile_activations activation
        where activation.package_version_id=v.package_version_id
          and activation.package_profile_id=v.package_profile_id
          and activation.activation_kind='production'
          and activation.enabled
      ) then
      return jsonb_build_object('ok',false,'code','practice_unavailable');
    end if;
    if not v_assignment_continuation
      and not exam_delivery.can_use_profile(
        v.owner_id,v.package_version_id,v.package_profile_id,v.purpose
      ) then
      return jsonb_build_object('ok',false,'code','access_not_granted');
    end if;
  end if;

  return jsonb_build_object(
    'ok',true,
    'ownerId',v.owner_id,
    'examKey',exam_delivery.normalize_exam_key(v.exam_key),
    'profileKey',v.profile_key,
    'purpose',v.purpose,
    'operation',p_operation
  );
end
$$;

create function exam_delivery.request_python_submission_grading_cancellation(
  p_actor_id uuid,
  p_attempt_id uuid,
  p_submission_id uuid,
  p_item_id uuid,
  p_run_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '8s'
as $$
declare
  v_run exam_delivery.python_execution_runs%rowtype;
  v_now timestamptz := statement_timestamp();
begin
  if p_actor_id is null or p_attempt_id is null or p_submission_id is null
    or p_item_id is null or p_run_id is null or p_request_id is null then
    return jsonb_build_object('ok',false,'code','invalid_request');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('issue86-grading-cancel:' || p_run_id::text, 0)
  );
  select run.* into v_run
  from exam_delivery.python_execution_runs run
  join exam_delivery.python_submission_grading_runs submission_run
    on submission_run.run_id=run.id
    and submission_run.attempt_id=run.attempt_id
    and submission_run.attempt_item_id=run.attempt_item_id
  join exam_delivery.python_submission_grading_sessions session
    on session.attempt_id=submission_run.attempt_id
    and session.submission_id=submission_run.submission_id
  join exam_delivery.python_grading_materializations materialization
    on materialization.id=submission_run.materialization_id
    and materialization.run_id=submission_run.run_id
    and materialization.execution_request_digest=run.execution_request_digest
  join exam_delivery.attempts attempt on attempt.id=run.attempt_id
  where attempt.owner_id=p_actor_id
    and run.id=p_run_id
    and run.attempt_id=p_attempt_id
    and run.attempt_item_id=p_item_id
    and submission_run.submission_id=p_submission_id
  for update of run;

  if not found then
    return jsonb_build_object('ok',false,'code','grading_binding_mismatch');
  end if;
  if v_run.state in ('completed','failed') then
    return jsonb_build_object('ok',false,'code','invalid_lifecycle_transition');
  end if;
  if v_run.state in ('cancel_requested','cancelled') then
    if v_run.cancellation_request_id is distinct from p_request_id then
      return jsonb_build_object('ok',false,'code','grading_reconciliation_required');
    end if;
  else
    if v_run.state not in ('queued','running') then
      return jsonb_build_object('ok',false,'code','grading_reconciliation_required');
    end if;
    update exam_delivery.python_execution_runs set
      state='cancel_requested',
      cancellation_request_id=p_request_id,
      cancellation_requested_at=v_now,
      disposal_state='pending',
      updated_at=v_now
    where id=p_run_id
    returning * into v_run;
  end if;

  return jsonb_build_object(
    'ok',true,
    'state',v_run.state,
    'disposalState',v_run.disposal_state
  );
end
$$;

create function public.certsim_service_request_python_submission_grading_cancellation(
  p_actor_id uuid,
  p_attempt_id uuid,
  p_submission_id uuid,
  p_item_id uuid,
  p_run_id uuid,
  p_request_id uuid
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select exam_delivery.request_python_submission_grading_cancellation(
    p_actor_id,p_attempt_id,p_submission_id,p_item_id,p_run_id,p_request_id
  )
$$;

alter function exam_delivery.request_python_submission_grading_cancellation(
  uuid,uuid,uuid,uuid,uuid,uuid
) owner to postgres;
alter function public.certsim_service_request_python_submission_grading_cancellation(
  uuid,uuid,uuid,uuid,uuid,uuid
) owner to postgres;

revoke all on function exam_delivery.request_python_submission_grading_cancellation(
  uuid,uuid,uuid,uuid,uuid,uuid
) from public,anon,authenticated,service_role;
revoke all on function public.certsim_service_request_python_submission_grading_cancellation(
  uuid,uuid,uuid,uuid,uuid,uuid
) from public,anon,authenticated,service_role;
grant execute on function exam_delivery.request_python_submission_grading_cancellation(
  uuid,uuid,uuid,uuid,uuid,uuid
) to service_role;
grant execute on function public.certsim_service_request_python_submission_grading_cancellation(
  uuid,uuid,uuid,uuid,uuid,uuid
) to service_role;

comment on function exam_delivery.authorize_attempt_continuation(uuid,text) is
  'Authorizes active attempt operations and permits only a pre-expiry frozen Python submission to finish trusted grading after natural expiry.';
comment on function exam_delivery.request_python_submission_grading_cancellation(
  uuid,uuid,uuid,uuid,uuid,uuid
) is 'Records the durable cancellation-requested transition for one materialized frozen-submission grading generation before provider reconciliation.';
comment on function public.certsim_service_request_python_submission_grading_cancellation(
  uuid,uuid,uuid,uuid,uuid,uuid
) is 'Service-only wrapper for submission-bound Python grading cancellation reconciliation.';

commit;
