-- Source-only forward extension. No release/configuration/learner rows are changed.
begin;

-- A filtered enabled-state snapshot cannot establish first-release eligibility.
create function exam_delivery.examops_initial_configuration_is_empty(p_exam_key text)
returns boolean language sql stable security definer set search_path='' set statement_timeout='10s'
as $$
 select exam_delivery.normalize_exam_key(p_exam_key) is not null
 and not exists(select 1 from public.exam_catalog c where exam_delivery.normalize_exam_key(c.exam_key)=exam_delivery.normalize_exam_key(p_exam_key))
 and not exists(select 1 from exam_delivery.package_profile_defaults d where exam_delivery.normalize_exam_key(d.canonical_exam_key)=exam_delivery.normalize_exam_key(p_exam_key))
 and not exists(select 1 from exam_delivery.practice_policies p where exam_delivery.normalize_exam_key(p.canonical_exam_key)=exam_delivery.normalize_exam_key(p_exam_key))
 and not exists(select 1 from exam_delivery.exam_profile_activations a join exam_delivery.package_versions v on v.id=a.package_version_id where exam_delivery.normalize_exam_key(v.exam_key)=exam_delivery.normalize_exam_key(p_exam_key))
 and not exists(select 1 from exam_delivery.exam_entitlements e join exam_delivery.package_versions v on v.id=e.package_version_id where exam_delivery.normalize_exam_key(v.exam_key)=exam_delivery.normalize_exam_key(p_exam_key))
 and not exists(select 1 from exam_delivery.exam_preview_authorizations e join exam_delivery.package_versions v on v.id=e.package_version_id where exam_delivery.normalize_exam_key(v.exam_key)=exam_delivery.normalize_exam_key(p_exam_key))
 and not exists(select 1 from exam_delivery.attempts a join exam_delivery.package_versions v on v.id=a.package_version_id where exam_delivery.normalize_exam_key(v.exam_key)=exam_delivery.normalize_exam_key(p_exam_key))
 and not exists(select 1 from public.exam_attempts a where exam_delivery.normalize_exam_key(a.exam_key)=exam_delivery.normalize_exam_key(p_exam_key))
 and not exists(select 1 from public.exam_assignments a where exam_delivery.normalize_exam_key(a.exam_key)=exam_delivery.normalize_exam_key(p_exam_key))
 and not exists(select 1 from exam_delivery.protected_assignments a join exam_delivery.package_versions v on v.id=a.package_version_id where exam_delivery.normalize_exam_key(v.exam_key)=exam_delivery.normalize_exam_key(p_exam_key))
 and not exists(select 1 from exam_delivery.exam_access_policies a where exam_delivery.normalize_exam_key(a.canonical_exam_key)=exam_delivery.normalize_exam_key(p_exam_key))

 and not exists(select 1 from exam_delivery.exam_release_operations o where o.canonical_exam_key=exam_delivery.normalize_exam_key(p_exam_key) and o.operation_type in ('ACTIVATE','ROLLBACK') and o.result_state='succeeded')
$$;
alter function exam_delivery.examops_initial_configuration_is_empty(text) owner to postgres;
revoke all on function exam_delivery.examops_initial_configuration_is_empty(text) from public,anon,authenticated,service_role;


create or replace function exam_delivery.examops_validate_release_set(p_request jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
set statement_timeout='10s'
as $$
declare
  v_exam text;
  v_target_id uuid;
  v_release_set jsonb;
  v_release_hash text;
  v_current_hash text;
  v_package exam_delivery.package_versions%rowtype;
  v_profile jsonb;
  v_profile_id uuid;
  v_profile_count integer;
  v_binding_count integer;
  v_policy_count integer;
begin
  if jsonb_typeof(p_request)<>'object' then
    return jsonb_build_object('ok',false,'outcome','BLOCKED_TARGET_INVALID',
      'code','RELEASE_REQUEST_INVALID');
  end if;
  begin
    v_exam:=exam_delivery.normalize_exam_key(p_request->>'examKey');
    v_target_id:=(p_request->>'targetPackageId')::uuid;
  exception when others then
    return jsonb_build_object('ok',false,'outcome','BLOCKED_TARGET_INVALID',
      'code','RELEASE_REQUEST_INVALID');
  end;
  v_release_set:=p_request->'releaseSet';
  if v_exam is null or v_target_id is null or jsonb_typeof(v_release_set)<>'object'
    or v_release_set->>'schemaVersion'<>'certsim-exam-release-set-v1'
    or exam_delivery.normalize_exam_key(v_release_set->>'examKey')<>v_exam
    or v_release_set->>'targetPackageId'<>v_target_id::text
    or not (v_release_set ?& array[
      'schemaVersion','examKey','targetPackageId','profiles','catalogue'
    ])
    or jsonb_typeof(v_release_set->'profiles')<>'array'
    or jsonb_array_length(v_release_set->'profiles')=0
    or jsonb_typeof(v_release_set->'catalogue')<>'object'
    or not ((v_release_set->'catalogue') ?& array['currentVersion','status']) then
    return jsonb_build_object('ok',false,'outcome','BLOCKED_TARGET_INVALID',
      'code','RELEASE_SET_INVALID');
  end if;

  v_release_hash:=exam_delivery.examops_json_hash(v_release_set);
  if p_request->>'releaseSetHash'<>v_release_hash
    or coalesce(p_request->>'manifestHash','') !~ '^[0-9a-f]{64}$'
    or coalesce(p_request->>'packageHash','') !~ '^[0-9a-f]{64}$'
    or coalesce(p_request->>'validationHash','') !~ '^[0-9a-f]{64}$'
    or coalesce(p_request->>'releaseDiffHash','') !~ '^[0-9a-f]{64}$'
    or coalesce(p_request->>'expectedCurrentStateHash','') !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok',false,'outcome','BLOCKED_TARGET_INVALID',
      'code','CANDIDATE_EVIDENCE_MISMATCH');
  end if;

  select * into v_package
  from exam_delivery.package_versions package
  where package.id=v_target_id
    and exam_delivery.normalize_exam_key(package.exam_key)=v_exam
    and package.status='published'
    and package.package_schema_version='certsim-protected-package-v2'
    and exam_delivery.package_v2_runtime_supported(
      package.generator_version,package.scorer_version
    );
  if not found or v_package.package_hash<>p_request->>'packageHash'
    or v_package.validation_hash<>p_request->>'validationHash'
    or v_release_set#>>'{catalogue,currentVersion}'<>v_package.package_version
    or v_release_set#>>'{catalogue,status}'<>'active' then
    return jsonb_build_object('ok',false,'outcome','BLOCKED_TARGET_INVALID',
      'code','CANDIDATE_EVIDENCE_MISMATCH');
  end if;

  select count(*)::integer,count(distinct profile->>'profileKey')::integer
  into v_profile_count,v_binding_count
  from jsonb_array_elements(v_release_set->'profiles') profile;
  if v_profile_count<>v_binding_count then
    return jsonb_build_object('ok',false,'outcome','BLOCKED_TARGET_INVALID',
      'code','RELEASE_SET_INVALID');
  end if;

  for v_profile in
    select profile.value
    from jsonb_array_elements(v_release_set->'profiles') profile(value)
    order by profile.value->>'profileKey'
  loop
    begin
      v_profile_id:=(v_profile->>'targetProfileId')::uuid;
    exception when others then
      return jsonb_build_object('ok',false,'outcome','BLOCKED_TARGET_INVALID',
        'code','RELEASE_SET_INVALID');
    end;
    if jsonb_typeof(v_profile)<>'object'
      or not (v_profile ?& array[
        'profileKey','targetProfileId','bindings','practicePolicies'
      ])
      or nullif(btrim(v_profile->>'profileKey'),'') is null
      or jsonb_typeof(v_profile->'bindings')<>'array'
      or jsonb_typeof(v_profile->'practicePolicies')<>'array'
      or not exists(
        select 1 from exam_delivery.package_profiles profile
        where profile.id=v_profile_id
          and profile.package_version_id=v_target_id
          and profile.profile_key=v_profile->>'profileKey'
      ) then
      return jsonb_build_object('ok',false,'outcome','BLOCKED_TARGET_INVALID',
        'code','RELEASE_SET_INVALID');
    end if;

    select count(*)::integer,count(distinct binding->>'purpose')::integer
    into v_binding_count,v_policy_count
    from jsonb_array_elements(v_profile->'bindings') binding;
    if v_binding_count<>6 or v_policy_count<>6 or exists(
      select 1 from jsonb_array_elements(v_profile->'bindings') binding
      where jsonb_typeof(binding)<>'object'
        or not (binding ?& array['purpose','action'])
        or binding->>'purpose' not in (
        'assigned_assessment','self_directed_exam','study_sandbox',
        'targeted_domain','weak_area','pbq_practice'
      ) or binding->>'action'<>'MOVE'
    ) then
      return jsonb_build_object('ok',false,'outcome','BLOCKED_TARGET_INVALID',
        'code','RELEASE_SET_INVALID');
    end if;

    select count(*)::integer,count(distinct policy->>'purpose')::integer
    into v_policy_count,v_binding_count
    from jsonb_array_elements(v_profile->'practicePolicies') policy;
    if v_policy_count<>5 or v_binding_count<>5 or exists(
      select 1 from jsonb_array_elements(v_profile->'practicePolicies') policy
      where jsonb_typeof(policy)<>'object'
        or not (policy ?& array[
          'purpose','accessMode','enabled','maximumCompletedAttempts',
          'cooldownSeconds','maximumConcurrentSessions','maximumSessionItems',
          'immediateFeedback','reviewReleasePolicy','answerReleasePolicy'
        ])
        or jsonb_typeof(policy->'enabled')<>'boolean'
        or jsonb_typeof(policy->'immediateFeedback')<>'boolean'
        or policy->>'purpose' not in (
        'self_directed_exam','study_sandbox','targeted_domain',
        'weak_area','pbq_practice'
      )
        or policy->>'accessMode' not in (
          'open_authenticated','organisation_scoped','assignment_required',
          'controlled_beta','production_authorized'
        )
        or coalesce((policy->>'enabled')::boolean,false) is not true
        or (policy->>'maximumConcurrentSessions')::integer<>1
        or (policy->>'maximumSessionItems')::integer not between 10 and 100
        or (policy->>'cooldownSeconds')::integer not between 0 and 2592000
        or policy->>'reviewReleasePolicy' not in (
          'never','after_submission','immediate_study_feedback'
        )
        or policy->>'answerReleasePolicy' not in (
          'never','after_submission','immediate_study_feedback'
        )
    ) then
      return jsonb_build_object('ok',false,'outcome','BLOCKED_TARGET_INVALID',
        'code','RELEASE_SET_INVALID');
    end if;
  end loop;

  if v_release_set ? 'releaseKind' and coalesce(v_release_set->>'releaseKind','') not in ('INITIAL','SUCCESSOR') then
    return jsonb_build_object('ok',false,'outcome','BLOCKED_TARGET_INVALID','code','RELEASE_KIND_INVALID');
  end if;
  if v_release_set->>'releaseKind'='INITIAL' then
    if not exam_delivery.examops_initial_configuration_is_empty(v_exam) then
      return jsonb_build_object('ok',false,'outcome','BLOCKED_CURRENT_STATE_INVALID','code','INITIAL_CONFIGURATION_NOT_EMPTY');
    end if;
    if v_release_set->>'schemaVersion' is distinct from 'certsim-exam-release-set-v1'
      or exam_delivery.normalize_exam_key(v_release_set->>'examKey') is distinct from v_exam
      or v_release_set->>'targetPackageId' is distinct from v_target_id::text
      or p_request->>'releaseSetHash' is distinct from v_release_hash
      or v_profile_count<>(select count(*) from exam_delivery.package_profiles where package_version_id=v_target_id)
      or exists(select 1 from jsonb_array_elements(v_release_set->'profiles') p, jsonb_array_elements(p->'bindings') b where b->>'action' is distinct from 'MOVE')
      or exists(select 1 from jsonb_array_elements(v_release_set->'profiles') p, jsonb_array_elements(p->'practicePolicies') policy where coalesce(jsonb_typeof(policy->'accessMode'),'null')<>'string' or coalesce(jsonb_typeof(policy->'reviewReleasePolicy'),'null')<>'string' or coalesce(jsonb_typeof(policy->'answerReleasePolicy'),'null')<>'string')
      or exists(select 1 from jsonb_array_elements(v_release_set->'profiles') p, jsonb_array_elements(p->'practicePolicies') policy, unnest(array['maximumConcurrentSessions','maximumSessionItems','cooldownSeconds']) k where coalesce(jsonb_typeof(policy->k),'null')<>'number')
      or exists(select 1 from jsonb_array_elements(v_release_set->'profiles') p, jsonb_array_elements(p->'practicePolicies') policy where case when jsonb_typeof(policy->'maximumCompletedAttempts')='null' then false when coalesce(jsonb_typeof(policy->'maximumCompletedAttempts'),'null')<>'number' then true else (policy->>'maximumCompletedAttempts') !~ '^[0-9]+$' or (policy->>'maximumCompletedAttempts')::numeric not between 1 and 1000 end)
      or not ((v_release_set->'catalogue') ?& array['slug','title','vendor','examType','sourceType','lifecycle'])
      or exists(select 1 from unnest(array['currentVersion','status','slug','title','vendor','examType','sourceType','lifecycle']) k where coalesce(jsonb_typeof(v_release_set->'catalogue'->k),'null')<>'string')
      or coalesce(v_release_set#>>'{catalogue,slug}','') !~ '^[a-z0-9][a-z0-9-]{0,79}$'
      or length(btrim(coalesce(v_release_set#>>'{catalogue,title}',''))) not between 1 and 512
      or length(btrim(coalesce(v_release_set#>>'{catalogue,vendor}',''))) not between 1 and 160
      or coalesce(v_release_set#>>'{catalogue,examType}','') not in ('certification','placement','custom')
      or coalesce(v_release_set#>>'{catalogue,sourceType}','') not in ('official_source','custom_database','imported')
      or coalesce(v_release_set#>>'{catalogue,lifecycle}','')<>'production_ready' then
      return jsonb_build_object('ok',false,'outcome','BLOCKED_TARGET_INVALID','code','INITIAL_RELEASE_SET_INVALID');
    end if;
  elsif not exists(
    select 1 from public.exam_catalog catalogue
    where exam_delivery.normalize_exam_key(catalogue.exam_key)=v_exam
  ) then
    return jsonb_build_object('ok',false,'outcome','BLOCKED_CURRENT_STATE_INVALID','code','CURRENT_CATALOGUE_MISSING');
  end if;

  if exists(
    select 1
    from exam_delivery.package_profile_defaults binding
    where binding.canonical_exam_key=v_exam and binding.enabled
      and not exists(
        select 1
        from jsonb_array_elements(v_release_set->'profiles') profile,
          jsonb_array_elements(profile->'bindings') requested_binding
        where profile->>'profileKey'=binding.profile_key
          and requested_binding->>'purpose'=binding.purpose::text
          and requested_binding->>'action'='MOVE'
      )
  ) then
    return jsonb_build_object('ok',false,'outcome','BLOCKED_CURRENT_STATE_INVALID',
      'code','CURRENT_BINDING_COVERAGE_INCOMPLETE');
  end if;

  v_current_hash:=exam_delivery.release_configuration_hash(v_exam);
  if v_current_hash<>p_request->>'expectedCurrentStateHash' then
    return jsonb_build_object('ok',false,'outcome','BLOCKED_CURRENT_STATE_INVALID',
      'code','RELEASE_STATE_CHANGED','currentStateHash',v_current_hash,
      'releaseSetHash',v_release_hash);
  end if;

  return jsonb_build_object(
    'ok',true,'examKey',v_exam,'targetPackageId',v_target_id,
    'targetPackageVersion',v_package.package_version,
    'releaseSetHash',v_release_hash,'currentStateHash',v_current_hash,
    'profileCount',v_profile_count,'releaseKind',coalesce(v_release_set->>'releaseKind','SUCCESSOR')
  );
exception when invalid_text_representation or invalid_parameter_value
  or numeric_value_out_of_range then
  return jsonb_build_object('ok',false,'outcome','BLOCKED_TARGET_INVALID',
    'code','RELEASE_SET_INVALID');
end $$;

create or replace function exam_delivery.preflight_exam_release(
  p_actor_id uuid,
  p_request jsonb
) returns jsonb
language plpgsql
stable
security definer
set search_path=''
set statement_timeout='15s'
as $$
declare
  v_validation jsonb;
  v_current_validation jsonb;
  v_exam text;
  v_target uuid;
  v_target_active integer:=0;
  v_displaced_timed integer:=0;
  v_displaced_practice integer:=0;
  v_frozen integer:=0;
  v_missing integer:=0;
  v_outcome text;
begin
  if not exam_delivery.examops_actor_is_platform_owner(p_actor_id) then
    raise exception 'examops_forbidden' using errcode='42501';
  end if;
  v_validation:=exam_delivery.examops_validate_release_set(p_request);
  if not coalesce((v_validation->>'ok')::boolean,false) then
    return v_validation;
  end if;
  v_exam:=v_validation->>'examKey';
  v_target:=(v_validation->>'targetPackageId')::uuid;
  v_current_validation:=
    exam_delivery.validate_current_exam_release_configuration(v_exam);
  if v_validation->>'releaseKind'<>'INITIAL' and not coalesce((v_current_validation->>'ok')::boolean,false) then
    return v_validation || v_current_validation || jsonb_build_object(
      'ok',false,'outcome','BLOCKED_CURRENT_STATE_INVALID'
    );
  end if;

  with continuable as (
    select attempt.id,attempt.package_version_id,attempt.purpose,
      contract.attempt_id is not null has_contract,
      exists(
        select 1 from exam_delivery.python_submission_grading_sessions session
        where session.attempt_id=attempt.id
          and session.created_at<attempt.expires_at
      ) frozen
    from exam_delivery.attempts attempt
    join exam_delivery.package_versions package on package.id=attempt.package_version_id
    left join exam_delivery.attempt_continuation_contracts contract
      on contract.attempt_id=attempt.id
    where exam_delivery.normalize_exam_key(package.exam_key)=v_exam
      and attempt.status='in_progress'
      and (
        (attempt.purpose in ('assigned_assessment','self_directed_exam')
          and attempt.expires_at>statement_timestamp())
        or (attempt.purpose in ('study_sandbox','targeted_domain','weak_area','pbq_practice')
          and attempt.practice_idle_expires_at>statement_timestamp())
        or exists(
          select 1 from exam_delivery.python_submission_grading_sessions session
          where session.attempt_id=attempt.id
            and session.created_at<attempt.expires_at
        )
      )
  )
  select
    count(*) filter(where package_version_id=v_target),
    count(*) filter(where package_version_id<>v_target
      and purpose in ('assigned_assessment','self_directed_exam')),
    count(*) filter(where package_version_id<>v_target
      and purpose in ('study_sandbox','targeted_domain','weak_area','pbq_practice')),
    count(*) filter(where package_version_id<>v_target and frozen),
    count(*) filter(where package_version_id<>v_target and not has_contract)
  into v_target_active,v_displaced_timed,v_displaced_practice,v_frozen,v_missing
  from continuable;

  v_outcome:=case
    when v_missing>0 then 'BLOCKED_CONTINUATION_RISK'
    when v_displaced_timed+v_displaced_practice>0
      then 'SAFE_WITH_PREDECESSOR_PRESERVATION'
    else 'SAFE_TO_ACTIVATE'
  end;
  return v_validation || jsonb_build_object(
    'ok',v_missing=0,'outcome',v_outcome,
    'activeAttempts',jsonb_build_object(
      'target',v_target_active,
      'displacedTimed',v_displaced_timed,
      'displacedPractice',v_displaced_practice,
      'qualifyingFrozenSubmissions',v_frozen,
      'missingContinuationContracts',v_missing
    )
  );
end $$;

create or replace function exam_delivery.activate_exam_release(
  p_actor_id uuid,
  p_request jsonb
) returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='30s'
as $$
declare
  v_request_id uuid;
  v_stage_id uuid;
  v_target uuid;
  v_exam text;
  v_request_hash text;
  v_release_hash text;
  v_existing exam_delivery.exam_release_operations%rowtype;
  v_stage exam_delivery.exam_release_operations%rowtype;
  v_operation exam_delivery.exam_release_operations%rowtype;
  v_preflight jsonb;
  v_previous jsonb;
  v_previous_hash text;
  v_profile jsonb;
  v_policy jsonb;
  v_profile_id uuid;
  v_package_version text;
  v_expected_profiles integer;
  v_count integer;
  v_post_validation jsonb;
  v_post jsonb;
  v_failed boolean:=false;
  v_now timestamptz:=statement_timestamp();
begin
  if not exam_delivery.examops_actor_is_platform_owner(p_actor_id) then
    raise exception 'examops_forbidden' using errcode='42501';
  end if;
  begin
    v_request_id:=(p_request->>'requestId')::uuid;
    v_stage_id:=(p_request->>'stageOperationId')::uuid;
    v_target:=(p_request->>'targetPackageId')::uuid;
    v_exam:=exam_delivery.normalize_exam_key(p_request->>'examKey');
    v_release_hash:=exam_delivery.examops_json_hash(p_request->'releaseSet');
  exception when others then
    return jsonb_build_object('ok',false,'code','RELEASE_REQUEST_INVALID');
  end;
  v_request_hash:=exam_delivery.examops_json_hash(
    jsonb_build_object('operationType','ACTIVATE','request',p_request)
  );
  select * into v_existing
  from exam_delivery.exam_release_operations operation
  where operation.request_id=v_request_id;
  if found then
    if v_existing.request_hash<>v_request_hash then
      return jsonb_build_object('ok',false,'code','REQUEST_ID_PAYLOAD_CONFLICT');
    end if;
    return exam_delivery.examops_operation_result(v_existing.id,true);
  end if;
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('certsim-exam-release:'||v_exam,0)
  ) then
    return jsonb_build_object('ok',false,'code','RELEASE_OPERATION_BUSY');
  end if;

  select * into v_stage
  from exam_delivery.exam_release_operations operation
  where operation.id=v_stage_id
    and operation.operation_type='STAGE'
    and operation.result_state='succeeded'
  for share;
  if not found
    or v_stage.canonical_exam_key<>v_exam
    or v_stage.target_package_id<>v_target
    or v_stage.release_set is distinct from p_request->'releaseSet'
    or v_stage.release_set_hash<>v_release_hash
    or v_stage.manifest_hash<>p_request->>'manifestHash'
    or v_stage.package_hash<>p_request->>'packageHash'
    or v_stage.validation_hash<>p_request->>'validationHash'
    or v_stage.release_diff_hash<>p_request->>'releaseDiffHash'
    or v_stage.expected_current_state_hash<>p_request->>'expectedCurrentStateHash' then
    return jsonb_build_object('ok',false,'code','STAGE_OPERATION_INVALID');
  end if;

  v_preflight:=exam_delivery.preflight_exam_release(p_actor_id,p_request);
  insert into exam_delivery.exam_release_operations(
    request_id,request_hash,actor_id,canonical_exam_key,operation_type,
    target_package_id,stage_operation_id,release_set,release_set_hash,
    manifest_hash,package_hash,validation_hash,release_diff_hash,
    expected_current_state_hash,result_state
  ) values(
    v_request_id,v_request_hash,p_actor_id,v_exam,'ACTIVATE',v_target,v_stage_id,
    p_request->'releaseSet',v_release_hash,p_request->>'manifestHash',
    p_request->>'packageHash',p_request->>'validationHash',
    p_request->>'releaseDiffHash',p_request->>'expectedCurrentStateHash','requested'
  ) returning * into v_operation;
  perform exam_delivery.examops_append_event(
    v_operation.id,'requested',jsonb_build_object(
      'operationType','ACTIVATE','stageOperationId',v_stage_id
    )
  );
  if not coalesce((v_preflight->>'ok')::boolean,false) then
    update exam_delivery.exam_release_operations
    set result_state='preflighted',preflight_result=v_preflight,started_at=v_now
    where id=v_operation.id;
    perform exam_delivery.examops_append_event(
      v_operation.id,'preflighted',jsonb_build_object(
        'outcome',v_preflight->>'outcome'
      )
    );
    update exam_delivery.exam_release_operations
    set result_state='failed',
      error_code=coalesce(v_preflight->>'code',v_preflight->>'outcome'),
      completed_at=statement_timestamp()
    where id=v_operation.id;
    perform exam_delivery.examops_append_event(
      v_operation.id,'failed',jsonb_build_object(
        'code',coalesce(v_preflight->>'code',v_preflight->>'outcome')
      )
    );
    return exam_delivery.examops_operation_result(v_operation.id,false);
  end if;

  v_previous:=exam_delivery.release_configuration_snapshot(v_exam);
  v_previous_hash:=exam_delivery.examops_json_hash(v_previous);
  update exam_delivery.exam_release_operations
  set result_state='preflighted',preflight_result=v_preflight,started_at=v_now,
    previous_state_snapshot=v_previous,previous_state_hash=v_previous_hash
  where id=v_operation.id;
  perform exam_delivery.examops_append_event(
    v_operation.id,'preflighted',jsonb_build_object(
      'outcome',v_preflight->>'outcome','previousStateHash',v_previous_hash
    )
  );
  update exam_delivery.exam_release_operations
  set result_state='executing' where id=v_operation.id;
  perform exam_delivery.examops_append_event(
    v_operation.id,'executing',jsonb_build_object('configurationMutation',true)
  );

  begin
    select package.package_version into strict v_package_version
    from exam_delivery.package_versions package
    where package.id=v_target and package.status='published'
    for share;

    if p_request#>>'{releaseSet,releaseKind}'='INITIAL' and not exam_delivery.examops_initial_configuration_is_empty(v_exam) then
      raise exception 'INITIAL_CONFIGURATION_NOT_EMPTY' using errcode='P0001';
    end if;

    update exam_delivery.exam_profile_activations activation
    set enabled=false,disabled_at=statement_timestamp(),updated_at=statement_timestamp()
    from exam_delivery.package_versions package
    where package.id=activation.package_version_id
      and exam_delivery.normalize_exam_key(package.exam_key)=v_exam
      and activation.activation_kind='production'
      and activation.enabled;

    update exam_delivery.practice_policies policy
    set enabled=false,access_mode='disabled',updated_at=statement_timestamp()
    where policy.canonical_exam_key=v_exam and policy.enabled;

    for v_profile in
      select profile.value
      from jsonb_array_elements(p_request#>'{releaseSet,profiles}') profile(value)
      order by profile.value->>'profileKey'
    loop
      v_profile_id:=(v_profile->>'targetProfileId')::uuid;
      insert into exam_delivery.exam_profile_activations(
        package_version_id,package_profile_id,enabled,activation_kind,
        enabled_at,disabled_at,created_by
      ) values(
        v_target,v_profile_id,true,'production',statement_timestamp(),null,p_actor_id
      )
      on conflict(package_version_id,package_profile_id,activation_kind) do update
      set enabled=true,enabled_at=statement_timestamp(),disabled_at=null,
        updated_at=statement_timestamp(),created_by=excluded.created_by;

      insert into exam_delivery.package_profile_defaults(
        canonical_exam_key,profile_key,purpose,package_version_id,
        package_profile_id,enabled,configured_at,configured_by
      )
      select v_exam,v_profile->>'profileKey',
        (binding.value->>'purpose')::exam_delivery.attempt_purpose,
        v_target,v_profile_id,true,statement_timestamp(),p_actor_id
      from jsonb_array_elements(v_profile->'bindings') binding(value)
      on conflict(canonical_exam_key,profile_key,purpose) do update
      set package_version_id=excluded.package_version_id,
        package_profile_id=excluded.package_profile_id,enabled=true,
        configured_at=excluded.configured_at,configured_by=excluded.configured_by;

      for v_policy in
        select policy.value
        from jsonb_array_elements(v_profile->'practicePolicies') policy(value)
        order by policy.value->>'purpose'
      loop
        insert into exam_delivery.practice_policies(
          canonical_exam_key,package_version,profile_key,purpose,access_mode,
          enabled,maximum_completed_attempts,cooldown_seconds,
          maximum_concurrent_sessions,maximum_session_items,immediate_feedback,
          review_release_policy,answer_release_policy,updated_at
        ) values(
          v_exam,v_package_version,v_profile->>'profileKey',
          (v_policy->>'purpose')::exam_delivery.attempt_purpose,
          v_policy->>'accessMode',true,
          case when v_policy->'maximumCompletedAttempts'='null'::jsonb
            then null else (v_policy->>'maximumCompletedAttempts')::integer end,
          (v_policy->>'cooldownSeconds')::integer,
          (v_policy->>'maximumConcurrentSessions')::integer,
          (v_policy->>'maximumSessionItems')::integer,
          (v_policy->>'immediateFeedback')::boolean,
          v_policy->>'reviewReleasePolicy',v_policy->>'answerReleasePolicy',
          statement_timestamp()
        )
        on conflict(canonical_exam_key,package_version,profile_key,purpose) do update
        set access_mode=excluded.access_mode,enabled=true,
          maximum_completed_attempts=excluded.maximum_completed_attempts,
          cooldown_seconds=excluded.cooldown_seconds,
          maximum_concurrent_sessions=excluded.maximum_concurrent_sessions,
          maximum_session_items=excluded.maximum_session_items,
          immediate_feedback=excluded.immediate_feedback,
          review_release_policy=excluded.review_release_policy,
          answer_release_policy=excluded.answer_release_policy,
          updated_at=statement_timestamp();
      end loop;
    end loop;

    if p_request#>>'{releaseSet,releaseKind}'='INITIAL' then
      insert into public.exam_catalog(exam_key,slug,title,vendor,lifecycle,exam_type,source_type,current_version,status)
      values(v_exam,p_request#>>'{releaseSet,catalogue,slug}',p_request#>>'{releaseSet,catalogue,title}',
        p_request#>>'{releaseSet,catalogue,vendor}','production_ready',p_request#>>'{releaseSet,catalogue,examType}',
        p_request#>>'{releaseSet,catalogue,sourceType}',v_package_version,'active');
    else
    update public.exam_catalog catalogue
    set current_version=v_package_version,status='active',
      lifecycle='production_ready',updated_at=statement_timestamp()
    where exam_delivery.normalize_exam_key(catalogue.exam_key)=v_exam;
    if not found then
      raise exception 'POSTCONDITION_FAILED' using errcode='P0001';
    end if;
    end if;

    v_expected_profiles:=jsonb_array_length(p_request#>'{releaseSet,profiles}');
    select count(*) into v_count
    from exam_delivery.package_profile_defaults binding
    where binding.canonical_exam_key=v_exam and binding.enabled
      and binding.package_version_id=v_target;
    if v_count<>v_expected_profiles*6 or exists(
      select 1 from exam_delivery.package_profile_defaults binding
      where binding.canonical_exam_key=v_exam and binding.enabled
        and binding.package_version_id<>v_target
    ) then
      raise exception 'POSTCONDITION_FAILED' using errcode='P0001';
    end if;
    select count(*) into v_count
    from exam_delivery.exam_profile_activations activation
    join exam_delivery.package_versions package on package.id=activation.package_version_id
    where exam_delivery.normalize_exam_key(package.exam_key)=v_exam
      and activation.activation_kind='production' and activation.enabled
      and activation.package_version_id=v_target;
    if v_count<>v_expected_profiles or exists(
      select 1 from exam_delivery.exam_profile_activations activation
      join exam_delivery.package_versions package on package.id=activation.package_version_id
      where exam_delivery.normalize_exam_key(package.exam_key)=v_exam
        and activation.activation_kind='production' and activation.enabled
        and activation.package_version_id<>v_target
    ) then
      raise exception 'POSTCONDITION_FAILED' using errcode='P0001';
    end if;
    select count(*) into v_count
    from exam_delivery.practice_policies policy
    where policy.canonical_exam_key=v_exam and policy.enabled
      and policy.package_version=v_package_version;
    if v_count<>v_expected_profiles*5 or exists(
      select 1 from exam_delivery.practice_policies policy
      where policy.canonical_exam_key=v_exam and policy.enabled
        and policy.package_version<>v_package_version
    ) then
      raise exception 'POSTCONDITION_FAILED' using errcode='P0001';
    end if;
    if not exists(
      select 1 from public.exam_catalog catalogue
      where exam_delivery.normalize_exam_key(catalogue.exam_key)=v_exam
        and catalogue.current_version=v_package_version
        and catalogue.status='active'
        and catalogue.lifecycle='production_ready'
    ) then
      raise exception 'POSTCONDITION_FAILED' using errcode='P0001';
    end if;
    v_post_validation:=
      exam_delivery.validate_current_exam_release_configuration(v_exam);
    if not coalesce((v_post_validation->>'ok')::boolean,false)
      or v_post_validation->>'currentPackageVersion'<>v_package_version then
      raise exception 'POSTCONDITION_FAILED' using errcode='P0001';
    end if;
    if p_request#>>'{releaseSet,releaseKind}'='INITIAL' and (
      (select count(*) from exam_delivery.package_profile_defaults where exam_delivery.normalize_exam_key(canonical_exam_key)=v_exam)<>v_expected_profiles*6
      or (select count(*) from exam_delivery.practice_policies where exam_delivery.normalize_exam_key(canonical_exam_key)=v_exam)<>v_expected_profiles*5
      or (select count(*) from exam_delivery.exam_profile_activations a join exam_delivery.package_versions p on p.id=a.package_version_id where exam_delivery.normalize_exam_key(p.exam_key)=v_exam)<>v_expected_profiles
      or not exists(select 1 from public.exam_catalog where exam_key=v_exam
        and slug=p_request#>>'{releaseSet,catalogue,slug}' and title=p_request#>>'{releaseSet,catalogue,title}'
        and vendor=p_request#>>'{releaseSet,catalogue,vendor}' and exam_type=p_request#>>'{releaseSet,catalogue,examType}'
        and source_type=p_request#>>'{releaseSet,catalogue,sourceType}')
    ) then
      raise exception 'POSTCONDITION_FAILED' using errcode='P0001';
    end if;
    v_post:=jsonb_build_object(
      'ok',true,'targetPackageId',v_target,
      'profileCount',v_expected_profiles,'releaseKind',coalesce(p_request#>>'{releaseSet,releaseKind}','SUCCESSOR'),
      'configurationHash',exam_delivery.release_configuration_hash(v_exam)
    );
  exception when others then
    v_failed:=true;
  end;

  if v_failed then
    update exam_delivery.exam_release_operations
    set result_state='failed',error_code='POSTCONDITION_FAILED',
      completed_at=statement_timestamp()
    where id=v_operation.id;
    perform exam_delivery.examops_append_event(
      v_operation.id,'failed',jsonb_build_object('code','POSTCONDITION_FAILED')
    );
  else
    update exam_delivery.exam_release_operations
    set result_state='succeeded',postcondition_result=v_post,
      completed_at=statement_timestamp()
    where id=v_operation.id;
    perform exam_delivery.examops_append_event(
      v_operation.id,'succeeded',v_post
    );
  end if;
  return exam_delivery.examops_operation_result(v_operation.id,false);
exception when unique_violation then
  select * into v_existing
  from exam_delivery.exam_release_operations operation
  where operation.request_id=v_request_id;
  if found and v_existing.request_hash=v_request_hash then
    return exam_delivery.examops_operation_result(v_existing.id,true);
  end if;
  return jsonb_build_object('ok',false,'code','REQUEST_ID_PAYLOAD_CONFLICT');
end $$;

create or replace function exam_delivery.rollback_exam_release(
  p_actor_id uuid,
  p_request jsonb
) returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='30s'
as $$
declare
  v_request_id uuid;
  v_activation_id uuid;
  v_exam text;
  v_request_hash text;
  v_current_hash text;
  v_existing exam_delivery.exam_release_operations%rowtype;
  v_activation exam_delivery.exam_release_operations%rowtype;
  v_operation exam_delivery.exam_release_operations%rowtype;
  v_restored_package_id uuid;
  v_restored_package exam_delivery.package_versions%rowtype;
  v_snapshot jsonb;
  v_item jsonb;
  v_snapshot_default_count integer:=0;
  v_snapshot_package_count integer:=0;
  v_missing integer:=0;
  v_current_validation jsonb;
  v_restored_validation jsonb;
  v_preflight jsonb;
  v_post jsonb;
  v_failed boolean:=false;
  v_now timestamptz:=statement_timestamp();
begin
  if not exam_delivery.examops_actor_is_platform_owner(p_actor_id) then
    raise exception 'examops_forbidden' using errcode='42501';
  end if;
  begin
    v_request_id:=(p_request->>'requestId')::uuid;
    v_activation_id:=(p_request->>'rollbackOfOperationId')::uuid;
    v_exam:=exam_delivery.normalize_exam_key(p_request->>'examKey');
  exception when others then
    return jsonb_build_object('ok',false,'code','RELEASE_REQUEST_INVALID');
  end;
  if coalesce(p_request->>'expectedCurrentStateHash','') !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok',false,'code','RELEASE_REQUEST_INVALID');
  end if;
  v_request_hash:=exam_delivery.examops_json_hash(
    jsonb_build_object('operationType','ROLLBACK','request',p_request)
  );
  select * into v_existing
  from exam_delivery.exam_release_operations operation
  where operation.request_id=v_request_id;
  if found then
    if v_existing.request_hash<>v_request_hash then
      return jsonb_build_object('ok',false,'code','REQUEST_ID_PAYLOAD_CONFLICT');
    end if;
    return exam_delivery.examops_operation_result(v_existing.id,true);
  end if;
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('certsim-exam-release:'||v_exam,0)
  ) then
    return jsonb_build_object('ok',false,'code','RELEASE_OPERATION_BUSY');
  end if;

  select * into v_activation
  from exam_delivery.exam_release_operations operation
  where operation.id=v_activation_id
    and operation.operation_type='ACTIVATE'
    and operation.result_state='succeeded'
    and operation.canonical_exam_key=v_exam
  for share;
  if not found or v_activation.previous_state_snapshot is null
    or v_activation.previous_state_hash is null
    or exam_delivery.examops_json_hash(v_activation.previous_state_snapshot)
      <>v_activation.previous_state_hash then
    return jsonb_build_object('ok',false,'code','STAGE_OPERATION_INVALID');
  end if;
  if v_activation.release_set->>'releaseKind'='INITIAL' then
    return jsonb_build_object('ok',false,'outcome','BLOCKED_TARGET_INVALID','code','INITIAL_RELEASE_ROLLBACK_UNSUPPORTED');
  end if;
  v_snapshot:=v_activation.previous_state_snapshot;
  if v_snapshot->>'schemaVersion'<>'certsim-release-configuration-snapshot-v1'
    or v_snapshot->>'examKey'<>v_exam
    or jsonb_typeof(v_snapshot->'defaults')<>'array'
    or jsonb_typeof(v_snapshot->'activations')<>'array'
    or jsonb_typeof(v_snapshot->'practicePolicies')<>'array'
    or jsonb_typeof(v_snapshot->'catalogue')<>'object' then
    return jsonb_build_object('ok',false,'outcome','BLOCKED_TARGET_INVALID',
      'code','BLOCKED_TARGET_INVALID');
  end if;

  begin
    select count(*)::integer,
      count(distinct nullif(binding->>'packageVersionId',''))::integer
    into v_snapshot_default_count,v_snapshot_package_count
    from jsonb_array_elements(v_snapshot->'defaults') binding;
    if v_snapshot_default_count=0 or v_snapshot_package_count<>1 or exists(
      select 1 from jsonb_array_elements(v_snapshot->'defaults') binding
      where nullif(binding->>'packageVersionId','') is null
        or nullif(binding->>'packageProfileId','') is null
        or nullif(binding->>'profileKey','') is null
        or nullif(binding->>'purpose','') is null
    ) then
      return jsonb_build_object('ok',false,'outcome','BLOCKED_TARGET_INVALID',
        'code','BLOCKED_TARGET_INVALID');
    end if;
    select (binding->>'packageVersionId')::uuid into v_restored_package_id
    from jsonb_array_elements(v_snapshot->'defaults') binding
    limit 1;
    perform (binding->>'packageVersionId')::uuid,
      (binding->>'packageProfileId')::uuid,
      (binding->>'purpose')::exam_delivery.attempt_purpose
    from jsonb_array_elements(v_snapshot->'defaults') binding;
    perform (activation->>'packageVersionId')::uuid,
      (activation->>'packageProfileId')::uuid
    from jsonb_array_elements(v_snapshot->'activations') activation;
    perform (policy->>'purpose')::exam_delivery.attempt_purpose
    from jsonb_array_elements(v_snapshot->'practicePolicies') policy;
  exception when others then
    return jsonb_build_object('ok',false,'outcome','BLOCKED_TARGET_INVALID',
      'code','BLOCKED_TARGET_INVALID');
  end;

  select * into v_restored_package
  from exam_delivery.package_versions package
  where package.id=v_restored_package_id
    and exam_delivery.normalize_exam_key(package.exam_key)=v_exam
    and package.status='published'
    and package.package_schema_version='certsim-protected-package-v2'
    and exam_delivery.package_v2_runtime_supported(
      package.generator_version,package.scorer_version
    );
  if not found or exists(
    select 1 from jsonb_array_elements(v_snapshot->'defaults') binding
    left join exam_delivery.package_profiles profile
      on profile.id=(binding->>'packageProfileId')::uuid
      and profile.package_version_id=v_restored_package_id
    where (binding->>'packageVersionId')::uuid<>v_restored_package_id
      or profile.id is null
      or profile.profile_key<>binding->>'profileKey'
  ) or exists(
    select 1 from jsonb_array_elements(v_snapshot->'defaults') binding
    where not exists(
      select 1 from jsonb_array_elements(v_snapshot->'activations') activation
      where (activation->>'packageVersionId')::uuid=v_restored_package_id
        and (activation->>'packageProfileId')::uuid=
          (binding->>'packageProfileId')::uuid
        and activation->>'profileKey'=binding->>'profileKey'
        and activation->>'activationKind'='production'
    )
  ) or exists(
    select 1 from jsonb_array_elements(v_snapshot->'defaults') binding
    where binding->>'purpose'<>'assigned_assessment'
      and not exists(
        select 1
        from jsonb_array_elements(v_snapshot->'practicePolicies') policy
        where policy->>'packageVersion'=v_restored_package.package_version
          and policy->>'profileKey'=binding->>'profileKey'
          and policy->>'purpose'=binding->>'purpose'
          and policy->>'accessMode'<>'disabled'
      )
  ) or v_snapshot#>>'{catalogue,currentVersion}'<>
      v_restored_package.package_version
    or v_snapshot#>>'{catalogue,status}'<>'active'
    or v_snapshot#>>'{catalogue,lifecycle}'<>'production_ready' then
    return jsonb_build_object('ok',false,'outcome','BLOCKED_TARGET_INVALID',
      'code','BLOCKED_TARGET_INVALID');
  end if;

  v_current_hash:=exam_delivery.release_configuration_hash(v_exam);
  v_current_validation:=
    exam_delivery.validate_current_exam_release_configuration(v_exam);
  select count(*)::integer into v_missing
  from exam_delivery.attempts attempt
  join exam_delivery.package_versions package on package.id=attempt.package_version_id
  left join exam_delivery.attempt_continuation_contracts contract
    on contract.attempt_id=attempt.id
  where exam_delivery.normalize_exam_key(package.exam_key)=v_exam
    and attempt.status='in_progress'
    and contract.attempt_id is null
    and (
      (attempt.purpose in ('assigned_assessment','self_directed_exam')
        and attempt.expires_at>statement_timestamp())
      or (attempt.purpose in ('study_sandbox','targeted_domain','weak_area','pbq_practice')
        and attempt.practice_idle_expires_at>statement_timestamp())
      or exists(
        select 1 from exam_delivery.python_submission_grading_sessions session
        where session.attempt_id=attempt.id
          and session.created_at<attempt.expires_at
      )
    );
  v_preflight:=jsonb_build_object(
    'ok',v_current_hash=p_request->>'expectedCurrentStateHash'
      and coalesce((v_current_validation->>'ok')::boolean,false)
      and v_missing=0,
    'outcome',case
      when v_current_hash<>p_request->>'expectedCurrentStateHash'
        then 'BLOCKED_CURRENT_STATE_INVALID'
      when not coalesce((v_current_validation->>'ok')::boolean,false)
        then 'BLOCKED_CURRENT_STATE_INVALID'
      when v_missing=0 then 'SAFE_WITH_PREDECESSOR_PRESERVATION'
      else 'BLOCKED_CONTINUATION_RISK' end,
    'code',case
      when v_current_hash<>p_request->>'expectedCurrentStateHash'
        then 'RELEASE_STATE_CHANGED'
      when not coalesce((v_current_validation->>'ok')::boolean,false)
        then v_current_validation->>'code'
      else null end,
    'currentStateHash',v_current_hash,
    'currentStateValidation',v_current_validation,
    'missingContinuationContracts',v_missing,
    'rollbackSnapshotHash',v_activation.previous_state_hash
  );

  insert into exam_delivery.exam_release_operations(
    request_id,request_hash,actor_id,canonical_exam_key,operation_type,
    target_package_id,rollback_of_operation_id,release_set,release_set_hash,
    manifest_hash,package_hash,validation_hash,release_diff_hash,
    expected_current_state_hash,result_state
  ) values(
    v_request_id,v_request_hash,p_actor_id,v_exam,'ROLLBACK',
    v_restored_package_id,v_activation_id,v_activation.release_set,
    v_activation.release_set_hash,v_activation.manifest_hash,
    v_activation.package_hash,v_activation.validation_hash,
    v_activation.release_diff_hash,p_request->>'expectedCurrentStateHash','requested'
  ) returning * into v_operation;
  perform exam_delivery.examops_append_event(
    v_operation.id,'requested',jsonb_build_object(
      'operationType','ROLLBACK','rollbackOfOperationId',v_activation_id
    )
  );
  if v_current_hash<>p_request->>'expectedCurrentStateHash' then
    update exam_delivery.exam_release_operations
    set result_state='preflighted',preflight_result=v_preflight,started_at=v_now
    where id=v_operation.id;
    perform exam_delivery.examops_append_event(
      v_operation.id,'preflighted',jsonb_build_object(
        'outcome',v_preflight->>'outcome',
        'currentStateHash',v_current_hash
      )
    );
    update exam_delivery.exam_release_operations
    set result_state='failed',error_code='RELEASE_STATE_CHANGED',
      completed_at=statement_timestamp()
    where id=v_operation.id;
    perform exam_delivery.examops_append_event(
      v_operation.id,'failed',jsonb_build_object('code','RELEASE_STATE_CHANGED')
    );
    return exam_delivery.examops_operation_result(v_operation.id,false);
  end if;
  if not coalesce((v_current_validation->>'ok')::boolean,false) then
    update exam_delivery.exam_release_operations
    set result_state='preflighted',preflight_result=v_preflight,started_at=v_now
    where id=v_operation.id;
    perform exam_delivery.examops_append_event(
      v_operation.id,'preflighted',jsonb_build_object(
        'outcome','BLOCKED_CURRENT_STATE_INVALID',
        'code',v_current_validation->>'code'
      )
    );
    update exam_delivery.exam_release_operations
    set result_state='failed',
      error_code=coalesce(v_current_validation->>'code','BLOCKED_CURRENT_STATE_INVALID'),
      completed_at=statement_timestamp()
    where id=v_operation.id;
    perform exam_delivery.examops_append_event(
      v_operation.id,'failed',jsonb_build_object(
        'code',coalesce(
          v_current_validation->>'code','BLOCKED_CURRENT_STATE_INVALID'
        )
      )
    );
    return exam_delivery.examops_operation_result(v_operation.id,false);
  end if;
  if v_missing>0 then
    update exam_delivery.exam_release_operations
    set result_state='preflighted',preflight_result=v_preflight,started_at=v_now
    where id=v_operation.id;
    perform exam_delivery.examops_append_event(
      v_operation.id,'preflighted',jsonb_build_object(
        'outcome',v_preflight->>'outcome',
        'rollbackSnapshotHash',v_activation.previous_state_hash
      )
    );
    update exam_delivery.exam_release_operations
    set result_state='failed',error_code='BLOCKED_CONTINUATION_RISK',
      completed_at=statement_timestamp()
    where id=v_operation.id;
    perform exam_delivery.examops_append_event(
      v_operation.id,'failed',jsonb_build_object('code','BLOCKED_CONTINUATION_RISK')
    );
    return exam_delivery.examops_operation_result(v_operation.id,false);
  end if;
  update exam_delivery.exam_release_operations
  set result_state='preflighted',preflight_result=v_preflight,started_at=v_now,
    previous_state_snapshot=exam_delivery.release_configuration_snapshot(v_exam),
    previous_state_hash=v_current_hash
  where id=v_operation.id;
  perform exam_delivery.examops_append_event(
    v_operation.id,'preflighted',jsonb_build_object(
      'outcome',v_preflight->>'outcome',
      'rollbackSnapshotHash',v_activation.previous_state_hash
    )
  );
  update exam_delivery.exam_release_operations
  set result_state='executing' where id=v_operation.id;
  perform exam_delivery.examops_append_event(
    v_operation.id,'executing',jsonb_build_object('configurationMutation',true)
  );

  begin
    update exam_delivery.package_profile_defaults binding
    set enabled=false,configured_at=statement_timestamp(),configured_by=p_actor_id
    where binding.canonical_exam_key=v_exam and binding.enabled;
    for v_item in
      select item.value from jsonb_array_elements(v_snapshot->'defaults') item(value)
      order by item.value->>'profileKey',item.value->>'purpose'
    loop
      insert into exam_delivery.package_profile_defaults(
        canonical_exam_key,profile_key,purpose,package_version_id,
        package_profile_id,enabled,configured_at,configured_by
      ) values(
        v_exam,v_item->>'profileKey',
        (v_item->>'purpose')::exam_delivery.attempt_purpose,
        (v_item->>'packageVersionId')::uuid,
        (v_item->>'packageProfileId')::uuid,true,statement_timestamp(),p_actor_id
      )
      on conflict(canonical_exam_key,profile_key,purpose) do update
      set package_version_id=excluded.package_version_id,
        package_profile_id=excluded.package_profile_id,enabled=true,
        configured_at=excluded.configured_at,configured_by=excluded.configured_by;
    end loop;

    update exam_delivery.exam_profile_activations activation
    set enabled=false,disabled_at=statement_timestamp(),updated_at=statement_timestamp()
    from exam_delivery.package_versions package
    where package.id=activation.package_version_id
      and exam_delivery.normalize_exam_key(package.exam_key)=v_exam
      and activation.activation_kind='production' and activation.enabled;
    for v_item in
      select item.value from jsonb_array_elements(v_snapshot->'activations') item(value)
      order by item.value->>'profileKey'
    loop
      insert into exam_delivery.exam_profile_activations(
        package_version_id,package_profile_id,enabled,activation_kind,
        enabled_at,disabled_at,created_by
      ) values(
        (v_item->>'packageVersionId')::uuid,
        (v_item->>'packageProfileId')::uuid,true,
        v_item->>'activationKind',statement_timestamp(),null,p_actor_id
      )
      on conflict(package_version_id,package_profile_id,activation_kind) do update
      set enabled=true,enabled_at=statement_timestamp(),disabled_at=null,
        updated_at=statement_timestamp(),created_by=excluded.created_by;
    end loop;

    update exam_delivery.practice_policies policy
    set enabled=false,access_mode='disabled',updated_at=statement_timestamp()
    where policy.canonical_exam_key=v_exam and policy.enabled;
    for v_item in
      select item.value from jsonb_array_elements(v_snapshot->'practicePolicies') item(value)
      order by item.value->>'packageVersion',item.value->>'profileKey',item.value->>'purpose'
    loop
      insert into exam_delivery.practice_policies(
        canonical_exam_key,package_version,profile_key,purpose,access_mode,
        enabled,maximum_completed_attempts,cooldown_seconds,
        maximum_concurrent_sessions,maximum_session_items,immediate_feedback,
        review_release_policy,answer_release_policy,updated_at
      ) values(
        v_exam,v_item->>'packageVersion',v_item->>'profileKey',
        (v_item->>'purpose')::exam_delivery.attempt_purpose,
        v_item->>'accessMode',true,
        case when v_item->'maximumCompletedAttempts'='null'::jsonb
          then null else (v_item->>'maximumCompletedAttempts')::integer end,
        (v_item->>'cooldownSeconds')::integer,
        (v_item->>'maximumConcurrentSessions')::integer,
        (v_item->>'maximumSessionItems')::integer,
        (v_item->>'immediateFeedback')::boolean,
        v_item->>'reviewReleasePolicy',v_item->>'answerReleasePolicy',
        statement_timestamp()
      )
      on conflict(canonical_exam_key,package_version,profile_key,purpose) do update
      set access_mode=excluded.access_mode,enabled=true,
        maximum_completed_attempts=excluded.maximum_completed_attempts,
        cooldown_seconds=excluded.cooldown_seconds,
        maximum_concurrent_sessions=excluded.maximum_concurrent_sessions,
        maximum_session_items=excluded.maximum_session_items,
        immediate_feedback=excluded.immediate_feedback,
        review_release_policy=excluded.review_release_policy,
        answer_release_policy=excluded.answer_release_policy,
        updated_at=statement_timestamp();
    end loop;

    update public.exam_catalog catalogue
    set current_version=v_snapshot#>>'{catalogue,currentVersion}',
      status=v_snapshot#>>'{catalogue,status}',
      lifecycle=v_snapshot#>>'{catalogue,lifecycle}',
      updated_at=statement_timestamp()
    where exam_delivery.normalize_exam_key(catalogue.exam_key)=v_exam;
    if not found then
      raise exception 'POSTCONDITION_FAILED' using errcode='P0001';
    end if;
    v_restored_validation:=
      exam_delivery.validate_current_exam_release_configuration(v_exam);
    if exam_delivery.release_configuration_snapshot(v_exam) is distinct from v_snapshot
      or not coalesce((v_restored_validation->>'ok')::boolean,false)
      or v_restored_validation->>'currentPackageVersion'<>
        v_restored_package.package_version then
      raise exception 'POSTCONDITION_FAILED' using errcode='P0001';
    end if;
    v_post:=jsonb_build_object(
      'ok',true,'restoredStateHash',v_activation.previous_state_hash,
      'restoredPackageVersion',v_restored_package.package_version,
      'configurationHash',exam_delivery.release_configuration_hash(v_exam)
    );
  exception when others then
    v_failed:=true;
  end;

  if v_failed then
    update exam_delivery.exam_release_operations
    set result_state='failed',error_code='POSTCONDITION_FAILED',
      completed_at=statement_timestamp()
    where id=v_operation.id;
    perform exam_delivery.examops_append_event(
      v_operation.id,'failed',jsonb_build_object('code','POSTCONDITION_FAILED')
    );
  else
    update exam_delivery.exam_release_operations
    set result_state='succeeded',postcondition_result=v_post,
      completed_at=statement_timestamp()
    where id=v_operation.id;
    perform exam_delivery.examops_append_event(v_operation.id,'succeeded',v_post);
  end if;
  return exam_delivery.examops_operation_result(v_operation.id,false);
exception
  when invalid_text_representation then
    return jsonb_build_object('ok',false,'code','STAGE_OPERATION_INVALID');
  when unique_violation then
    select * into v_existing
    from exam_delivery.exam_release_operations operation
    where operation.request_id=v_request_id;
    if found and v_existing.request_hash=v_request_hash then
      return exam_delivery.examops_operation_result(v_existing.id,true);
    end if;
    return jsonb_build_object('ok',false,'code','REQUEST_ID_PAYLOAD_CONFLICT');
end $$;


commit;
