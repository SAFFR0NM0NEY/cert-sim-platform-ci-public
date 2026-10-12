-- Issue #133 Phase 5A: the browser receives only bounded, sanitized,
-- Platform-Owner-gated Exam Operations health. This migration adds no data
-- changes and no release mutation capability.

create function exam_delivery.get_exam_operations_health(
  p_actor_id uuid,
  p_exam_key text
) returns jsonb
language plpgsql
stable
security definer
set search_path=''
set statement_timeout='10s'
as $$
declare
  v_exam text:=exam_delivery.normalize_exam_key(p_exam_key);
  v_validation jsonb;
  v_package exam_delivery.package_versions%rowtype;
  v_catalogue public.exam_catalog%rowtype;
  v_enabled_profiles integer:=0;
  v_continuable integer:=0;
  v_contracts integer:=0;
  v_missing integer:=0;
  v_timed integer:=0;
  v_practice integer:=0;
  v_older integer:=0;
  v_frozen integer:=0;
  v_operation record;
  v_successful_operation record;
  v_evidence record;
  v_publication record;
  v_health_status text;
begin
  if not exam_delivery.examops_actor_is_platform_owner(p_actor_id) then
    raise exception 'examops_forbidden' using errcode='42501';
  end if;
  if v_exam is null or not exists(
    select 1 from exam_delivery.package_versions package
    where exam_delivery.normalize_exam_key(package.exam_key)=v_exam
    union all
    select 1 from public.exam_catalog catalogue
    where exam_delivery.normalize_exam_key(catalogue.exam_key)=v_exam
  ) then
    return jsonb_build_object('ok',false,'code','EXAM_NOT_FOUND');
  end if;

  v_validation:=exam_delivery.validate_current_exam_release_configuration(v_exam);

  select package.* into v_package
  from exam_delivery.package_versions package
  where exam_delivery.normalize_exam_key(package.exam_key)=v_exam
    and package.package_version=v_validation->>'currentPackageVersion'
  limit 1;

  select count(distinct binding.profile_key)::integer into v_enabled_profiles
  from exam_delivery.package_profile_defaults binding
  where binding.canonical_exam_key=v_exam and binding.enabled;

  select catalogue.* into v_catalogue
  from public.exam_catalog catalogue
  where exam_delivery.normalize_exam_key(catalogue.exam_key)=v_exam
  limit 1;

  with current_attempts as (
    select attempt.package_version_id,attempt.purpose,
      contract.attempt_id is not null and contract.purpose=attempt.purpose
        as has_contract,
      coalesce(contract.frozen_submit_after_expiry,false) as frozen_submit
    from exam_delivery.attempts attempt
    join exam_delivery.package_versions package
      on package.id=attempt.package_version_id
    left join exam_delivery.attempt_continuation_contracts contract
      on contract.attempt_id=attempt.id
    where exam_delivery.normalize_exam_key(package.exam_key)=v_exam
      and attempt.status='in_progress'
      and (
        (attempt.purpose in ('assigned_assessment','self_directed_exam')
          and attempt.expires_at is not null
          and attempt.expires_at>statement_timestamp())
        or (attempt.purpose in ('study_sandbox','targeted_domain','weak_area','pbq_practice')
          and attempt.practice_idle_expires_at is not null
          and attempt.practice_idle_expires_at>statement_timestamp())
        or (attempt.purpose in ('assigned_assessment','self_directed_exam')
          and exists(
            select 1
            from exam_delivery.python_submission_grading_sessions session
            where session.attempt_id=attempt.id
              and session.created_at<attempt.expires_at
          ))
      )
  )
  select count(*)::integer,
    count(*) filter(where has_contract)::integer,
    count(*) filter(where not has_contract)::integer,
    count(*) filter(where purpose in ('assigned_assessment','self_directed_exam'))::integer,
    count(*) filter(where purpose in ('study_sandbox','targeted_domain','weak_area','pbq_practice'))::integer,
    count(*) filter(where v_package.id is not null and package_version_id<>v_package.id)::integer,
    count(*) filter(where frozen_submit)::integer
  into v_continuable,v_contracts,v_missing,v_timed,v_practice,v_older,v_frozen
  from current_attempts;

  select operation.operation_type,operation.result_state,
    coalesce(operation.completed_at,operation.created_at) occurred_at,
    target.package_version target_version,operation.error_code
  into v_operation
  from exam_delivery.exam_release_operations operation
  left join exam_delivery.package_versions target
    on target.id=operation.target_package_id
  where operation.canonical_exam_key=v_exam
  order by operation.created_at desc,operation.id desc
  limit 1;

  select operation.operation_type,
    coalesce(operation.completed_at,operation.created_at) occurred_at,
    target.package_version target_version
  into v_successful_operation
  from exam_delivery.exam_release_operations operation
  left join exam_delivery.package_versions target
    on target.id=operation.target_package_id
  where operation.canonical_exam_key=v_exam
    and operation.result_state='succeeded'
    and operation.operation_type in ('ACTIVATE','ROLLBACK')
  order by coalesce(operation.completed_at,operation.created_at) desc,operation.id desc
  limit 1;

  if found then
    select 'generic-exam-operations'::text source,
      v_successful_operation.operation_type::text release_stage,
      v_successful_operation.occurred_at configured_at,
      v_successful_operation.target_version::text package_version,
      null::text profile_key
    into v_evidence;
  else
    select 'legacy-release-configuration'::text source,
      request.release_stage,request.configured_at,package.package_version,
      profile.profile_key
    into v_evidence
    from exam_delivery.exam_release_configuration_requests request
    join exam_delivery.package_versions package
      on package.id=request.package_version_id
    join exam_delivery.package_profiles profile
      on profile.id=request.package_profile_id
    where request.canonical_exam_key=v_exam
    order by request.configured_at desc
    limit 1;
  end if;

  select run.status,run.error_code,
    coalesce(run.completed_at,run.created_at) occurred_at,
    package.package_version
  into v_publication
  from exam_delivery.publication_runs run
  join exam_delivery.package_versions package on package.id=run.package_version_id
  where exam_delivery.normalize_exam_key(package.exam_key)=v_exam
  order by run.created_at desc
  limit 1;

  v_health_status:=case
    when v_validation->>'outcome'<>'CURRENT_STATE_VALID' or v_missing>0
      then 'BLOCKED'
    when v_older>0 then 'WARNING'
    else 'VALID'
  end;

  return jsonb_build_object(
    'ok',true,
    'healthSchema','certsim-exam-operations-health-v1',
    'examKey',v_exam,
    'observedAt',statement_timestamp(),
    'healthStatus',v_health_status,
    'currentPackageVersion',v_package.package_version,
    'packageStatus',v_package.status,
    'packageSchemaVersion',v_package.package_schema_version,
    'generatorVersion',v_package.generator_version,
    'scorerVersion',v_package.scorer_version,
    'sourceCommitSha',v_package.source_commit_sha,
    'validationHash',v_package.validation_hash,
    'packageHash',v_package.package_hash,
    'currentStateStatus',v_validation->>'outcome',
    'currentStateFindings',coalesce(v_validation->'findingCodes','[]'::jsonb),
    'enabledDefaultCount',coalesce((v_validation->>'defaultCount')::integer,0),
    'enabledProfileCount',v_enabled_profiles,
    'productionActivationCount',coalesce((v_validation->>'activationCount')::integer,0),
    'usablePracticePolicyCount',coalesce((v_validation->>'policyCount')::integer,0),
    'currentContinuableAttempts',v_continuable,
    'currentContinuationContracts',v_contracts,
    'currentMissingContinuationContracts',v_missing,
    'currentTimedAttempts',v_timed,
    'currentPracticeAttempts',v_practice,
    'olderPackageContinuableAttempts',v_older,
    'frozenSubmitCount',v_frozen,
    'latestOperationType',v_operation.operation_type,
    'latestOperationStatus',v_operation.result_state,
    'latestOperationTimestamp',v_operation.occurred_at,
    'latestOperationTargetVersion',v_operation.target_version,
    'latestOperationErrorCode',v_operation.error_code,
    'configurationHash',exam_delivery.release_configuration_hash(v_exam),
    'catalogueVersion',v_catalogue.current_version,
    'catalogueStatus',v_catalogue.status,
    'catalogueLifecycle',v_catalogue.lifecycle,
    'releaseEvidenceSource',v_evidence.source,
    'releaseEvidenceStage',v_evidence.release_stage,
    'releaseEvidenceTimestamp',v_evidence.configured_at,
    'releaseEvidencePackageVersion',v_evidence.package_version,
    'releaseEvidenceProfileKey',v_evidence.profile_key,
    'latestPublicationStatus',v_publication.status,
    'latestPublicationErrorCode',v_publication.error_code,
    'latestPublicationTimestamp',v_publication.occurred_at,
    'latestPublicationPackageVersion',v_publication.package_version,
    'telemetry',jsonb_build_object(
      'SAVE_FAILURE_TELEMETRY','NOT_AVAILABLE',
      'SUBMIT_FAILURE_TELEMETRY','NOT_AVAILABLE',
      'DEPLOYMENT_CORRELATION','NOT_AVAILABLE',
      'POST_RELEASE_HEALTH_EVENT','NOT_AVAILABLE'
    )
  );
end $$;

create function public.certsim_examops_get_health(p_exam_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
set statement_timeout='10s'
as $$
declare v_actor uuid:=auth.uid();
begin
  if not exam_delivery.examops_actor_is_platform_owner(v_actor) then
    raise exception 'examops_forbidden' using errcode='42501';
  end if;
  return exam_delivery.get_exam_operations_health(v_actor,p_exam_key);
end $$;

alter function exam_delivery.get_exam_operations_health(uuid,text) owner to postgres;
alter function public.certsim_examops_get_health(text) owner to postgres;

revoke execute on function exam_delivery.get_exam_operations_health(uuid,text)
from public,anon,authenticated,service_role;
revoke execute on function public.certsim_examops_get_health(text)
from public,anon,authenticated,service_role;
grant execute on function public.certsim_examops_get_health(text)
to authenticated;

comment on function exam_delivery.get_exam_operations_health(uuid,text) is
  'Sanitized read-only Issue #133 Exam Operations health for an active Platform Owner; excludes identities, protected content, and release mutation.';
comment on function public.certsim_examops_get_health(text) is
  'Checked browser RPC deriving auth.uid() and returning only sanitized read-only Exam Operations health.';
