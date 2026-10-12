begin;

create or replace function exam_delivery.prepare_python_submission_grading(
  p_actor_id uuid,
  p_attempt_id uuid,
  p_submission_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '15s'
as $$
declare
  v_attempt exam_delivery.attempts%rowtype;
  v_existing_submission uuid;
  v_session exam_delivery.python_submission_grading_sessions%rowtype;
  v_authorization jsonb;
  v_item record;
  v_latest record;
  v_attempt_number integer;
  v_run_id uuid;
  v_client_request_id uuid;
  v_execution_request_id uuid;
  v_materialization_id uuid;
  v_grading_session_id uuid;
  v_items jsonb;
  v_ready boolean;
begin
  if p_actor_id is null or p_attempt_id is null or p_submission_id is null then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('issue86-submission:' || p_attempt_id::text, 0));
  select * into v_attempt from exam_delivery.attempts attempt
  where attempt.id = p_attempt_id and attempt.owner_id = p_actor_id
  for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'attempt_not_found'); end if;
  select result.submission_id into v_existing_submission
  from exam_delivery.attempt_results result where result.attempt_id = p_attempt_id;
  if found then
    if v_existing_submission = p_submission_id then
      return jsonb_build_object('ok', true, 'required', false, 'ready', true, 'completed', true, 'items', '[]'::jsonb);
    end if;
    return jsonb_build_object('ok', false, 'code', 'submission_conflict');
  end if;
  v_authorization := exam_delivery.authorize_attempt_continuation(p_attempt_id, 'submit');
  if not coalesce((v_authorization->>'ok')::boolean, false) then return v_authorization; end if;
  if (v_authorization->>'ownerId')::uuid <> p_actor_id then
    return jsonb_build_object('ok', false, 'code', 'attempt_not_found');
  end if;
  if not exists (
    select 1 from exam_delivery.attempt_items item
    join exam_delivery.package_questions question on question.id = item.package_question_id
    where item.attempt_id = p_attempt_id
      and question.question_type = 'executable-python-lab-v1'
  ) then
    return jsonb_build_object('ok', true, 'required', false, 'ready', true, 'completed', false, 'items', '[]'::jsonb);
  end if;
  if exists (
    select 1
    from exam_delivery.attempt_items item
    join exam_delivery.package_questions question on question.id = item.package_question_id
    join exam_delivery.attempt_item_protected_content protected on protected.attempt_item_id = item.id
    left join exam_delivery.python_lab_workspaces workspace
      on workspace.attempt_id = item.attempt_id and workspace.attempt_item_id = item.id
    where item.attempt_id = p_attempt_id
      and question.question_type = 'executable-python-lab-v1'
      and (
        jsonb_typeof(protected.scoring_snapshot) <> 'object'
        or not (protected.scoring_snapshot ? 'maximumRawPoints')
        or jsonb_typeof(protected.scoring_snapshot->'maximumRawPoints') <> 'number'
        or protected.scoring_snapshot->>'maximumRawPoints' !~ '^[1-9][0-9]*$'
        or (
          workspace.attempt_item_id is not null
          and (
            not exam_delivery.json_has_exact_keys(
              protected.scoring_snapshot, array['maximumRawPoints','trustedGrading']
            )
            or jsonb_typeof(protected.scoring_snapshot->'trustedGrading') <> 'object'
            or not exam_delivery.json_has_exact_keys(
              protected.scoring_snapshot->'trustedGrading',
              array['status','materialDigest','gradingMaterial']
            )
            or protected.scoring_snapshot#>>'{trustedGrading,status}' <> 'compiled'
            or protected.scoring_snapshot#>>'{trustedGrading,materialDigest}' !~ '^[0-9a-f]{64}$'
            or jsonb_typeof(protected.scoring_snapshot#>'{trustedGrading,gradingMaterial}') <> 'object'
            or not exam_delivery.json_has_exact_keys(
              protected.scoring_snapshot#>'{trustedGrading,gradingMaterial}',
              array['contractVersion','taskId','maximumRawPoints','rules']
            )
            or protected.scoring_snapshot#>>'{trustedGrading,gradingMaterial,contractVersion}'
              <> 'certsim-python-trusted-grading-v1'
            or protected.scoring_snapshot#>>'{trustedGrading,gradingMaterial,taskId}' <> question.question_id
            or protected.scoring_snapshot#>>'{trustedGrading,gradingMaterial,maximumRawPoints}'
              <> protected.scoring_snapshot->>'maximumRawPoints'
            or jsonb_typeof(protected.scoring_snapshot#>'{trustedGrading,gradingMaterial,rules}') <> 'array'
            or jsonb_array_length(protected.scoring_snapshot#>'{trustedGrading,gradingMaterial,rules}') not between 1 and 128
          )
        )
      )
  ) then
    return jsonb_build_object('ok', false, 'code', 'grading_material_invalid');
  end if;

  select * into v_session
  from exam_delivery.python_submission_grading_sessions session
  where session.attempt_id = p_attempt_id;
  if found and v_session.submission_id <> p_submission_id then
    return jsonb_build_object('ok', false, 'code', 'submission_conflict');
  end if;
  if not found then
    insert into exam_delivery.python_submission_grading_sessions(attempt_id, submission_id)
    values (p_attempt_id, p_submission_id)
    returning * into v_session;
  end if;

  for v_item in
    select item.id item_id, workspace.current_revision, workspace.workspace_hash,
      (protected.scoring_snapshot->>'maximumRawPoints')::integer maximum_raw_points,
      protected.scoring_snapshot#>>'{trustedGrading,materialDigest}' material_digest,
      protected.scoring_snapshot#>>'{trustedGrading,gradingMaterial,contractVersion}' grading_contract_version
    from exam_delivery.attempt_items item
    join exam_delivery.package_questions question on question.id = item.package_question_id
    join exam_delivery.attempt_item_protected_content protected on protected.attempt_item_id = item.id
    join exam_delivery.python_lab_workspaces workspace
      on workspace.attempt_id = item.attempt_id and workspace.attempt_item_id = item.id
    where item.attempt_id = p_attempt_id
      and question.question_type = 'executable-python-lab-v1'
    order by item.presented_question_number, item.id
  loop
    if exists (
      select 1
      from exam_delivery.python_submission_grading_runs submission_run
      join exam_delivery.python_grading_evidence evidence on evidence.run_id = submission_run.run_id
      where submission_run.attempt_id = p_attempt_id
        and submission_run.submission_id = p_submission_id
        and submission_run.attempt_item_id = v_item.item_id
    ) then continue; end if;

    select submission_run.*, run.state into v_latest
    from exam_delivery.python_submission_grading_runs submission_run
    join exam_delivery.python_execution_runs run on run.id = submission_run.run_id
    where submission_run.attempt_id = p_attempt_id
      and submission_run.submission_id = p_submission_id
      and submission_run.attempt_item_id = v_item.item_id
    order by submission_run.attempt_number desc limit 1;
    if not found or v_latest.state in ('completed','failed','cancelled') then
      v_attempt_number := coalesce(v_latest.attempt_number, 0) + 1;
      v_run_id := gen_random_uuid();
      v_client_request_id := gen_random_uuid();
      v_execution_request_id := gen_random_uuid();
      v_materialization_id := gen_random_uuid();
      v_grading_session_id := gen_random_uuid();
      insert into exam_delivery.python_execution_runs(
        id, attempt_id, attempt_item_id, workspace_revision, workspace_hash,
        client_request_id, execution_request_id, orchestration_request_digest,
        state, wall_time_ms, memory_bytes, output_bytes
      ) values (
        v_run_id, p_attempt_id, v_item.item_id, v_item.current_revision,
        v_item.workspace_hash, v_client_request_id, v_execution_request_id,
        exam_delivery.python_orchestration_request_digest(
          p_attempt_id, v_item.item_id, v_item.current_revision,
          v_item.workspace_hash, v_execution_request_id
        ), 'authorized', 20000, 134217728, 1048576
      );
      insert into exam_delivery.python_submission_grading_runs(
        attempt_id, submission_id, attempt_item_id, attempt_number, run_id,
        materialization_id, grading_session_id, workspace_revision, workspace_hash,
        material_digest, grading_contract_version, maximum_raw_points
      ) values (
        p_attempt_id, p_submission_id, v_item.item_id, v_attempt_number, v_run_id,
        v_materialization_id, v_grading_session_id, v_item.current_revision,
        v_item.workspace_hash, v_item.material_digest,
        v_item.grading_contract_version, v_item.maximum_raw_points
      );
    end if;
  end loop;

  with executable as (
    select item.id item_id, item.presented_question_number,
      workspace.workspace,
      protected.scoring_snapshot#>'{trustedGrading,gradingMaterial}' grading_material
    from exam_delivery.attempt_items item
    join exam_delivery.package_questions question on question.id = item.package_question_id
    join exam_delivery.attempt_item_protected_content protected on protected.attempt_item_id = item.id
    join exam_delivery.python_lab_workspaces workspace
      on workspace.attempt_id = item.attempt_id and workspace.attempt_item_id = item.id
    where item.attempt_id = p_attempt_id
      and question.question_type = 'executable-python-lab-v1'
  ), selected as (
    select executable.*, submission_run.*, run.execution_request_id,
      run.execution_request_digest, run.state, run.created_at run_created_at,
      evidence.evidence_id is not null graded
    from executable
    cross join lateral (
      select candidate.*
      from exam_delivery.python_submission_grading_runs candidate
      left join exam_delivery.python_grading_evidence candidate_evidence
        on candidate_evidence.run_id = candidate.run_id
      where candidate.attempt_id = p_attempt_id
        and candidate.submission_id = p_submission_id
        and candidate.attempt_item_id = executable.item_id
      order by (candidate_evidence.evidence_id is not null) desc,
        candidate.attempt_number desc
      limit 1
    ) submission_run
    join exam_delivery.python_execution_runs run on run.id = submission_run.run_id
    left join exam_delivery.python_grading_evidence evidence on evidence.run_id = run.id
  )
  select jsonb_agg(jsonb_build_object(
    'itemId', item_id,
    'runId', run_id,
    'state', case when graded then 'graded' else state end,
    'attemptNumber', attempt_number,
    'executionRequestId', execution_request_id,
    'executionRequestDigest', execution_request_digest,
    'workspaceRevision', workspace_revision,
    'workspaceHash', workspace_hash,
    'workspace', workspace,
    'materializationId', materialization_id,
    'gradingSessionId', grading_session_id,
    'materialDigest', material_digest,
    'gradingContractVersion', grading_contract_version,
    'maximumRawPoints', maximum_raw_points,
    'gradingMaterial', grading_material,
    'createdAt', run_created_at
  ) order by presented_question_number, item_id), bool_and(graded)
  into v_items, v_ready from selected;

  return jsonb_build_object(
    'ok', true, 'required', true, 'ready', coalesce(v_ready, true),
    'completed', false, 'items', coalesce(v_items, '[]'::jsonb)
  );
end
$$;

create or replace function exam_delivery.score_attempt_item_with_trusted_grading(
  p_attempt_id uuid,
  p_submission_id uuid,
  p_item_id uuid,
  p_scorer_version text,
  p_question_type text,
  p_presentation jsonb,
  p_scoring jsonb,
  p_response jsonb,
  p_scored boolean
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_evidence exam_delivery.python_grading_evidence%rowtype;
  v_maximum integer;
begin
  if p_question_type <> 'executable-python-lab-v1' then
    return exam_delivery.score_package_v2_response_for_scorer(
      p_scorer_version, p_question_type, p_presentation, p_scoring,
      p_response, p_scored
    );
  end if;
  if not p_scored then return jsonb_build_object('earned',0,'maximum',0,'status','Informational'); end if;
  if jsonb_typeof(p_scoring) <> 'object'
    or jsonb_typeof(p_scoring->'maximumRawPoints') <> 'number'
    or p_scoring->>'maximumRawPoints' !~ '^[1-9][0-9]*$' then
    raise exception 'scoring_contract_invalid' using errcode = '22023';
  end if;
  v_maximum := (p_scoring->>'maximumRawPoints')::integer;
  if not exists (
    select 1 from exam_delivery.python_lab_workspaces workspace
    where workspace.attempt_id = p_attempt_id and workspace.attempt_item_id = p_item_id
  ) then
    return jsonb_build_object('earned',0,'maximum',v_maximum,'status','Unanswered');
  end if;
  select evidence.* into v_evidence
  from exam_delivery.python_submission_grading_runs submission_run
  join exam_delivery.python_grading_evidence evidence on evidence.run_id = submission_run.run_id
  where submission_run.attempt_id = p_attempt_id
    and submission_run.submission_id = p_submission_id
    and submission_run.attempt_item_id = p_item_id;
  if not found then raise exception 'grading_incomplete' using errcode = '55000'; end if;
  return jsonb_build_object(
    'earned', v_evidence.earned_raw_points,
    'maximum', v_evidence.maximum_raw_points,
    'status', case
      when v_evidence.earned_raw_points = v_evidence.maximum_raw_points then 'Correct'
      when v_evidence.earned_raw_points > 0 then 'Partial'
      else 'Incorrect'
    end
  );
end
$$;

create or replace function exam_delivery.submit_attempt_v2_with_trusted_grading(
  p_actor_id uuid,
  p_attempt_id uuid,
  p_submission_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '15s'
as $$
declare
  v_attempt record; v_existing exam_delivery.attempt_results%rowtype; v_now timestamptz:=statement_timestamp();
  v_response_hash text; v_raw numeric; v_max numeric; v_percentage numeric; v_scaled integer; v_pass_mark integer; v_passed boolean;
  v_domain jsonb; v_summary jsonb; v_review jsonb; v_catalog_id uuid;
begin
  if p_actor_id is null or p_submission_id is null then return jsonb_build_object('ok',false,'code','invalid_request'); end if;
  select a.*,pv.exam_key,pv.package_version,pv.package_schema_version,pp.profile_key,pp.time_limit_minutes,pp.selection_config
    into v_attempt from exam_delivery.attempts a join exam_delivery.package_versions pv on pv.id=a.package_version_id join exam_delivery.package_profiles pp on pp.id=a.package_profile_id
    where a.id=p_attempt_id and a.owner_id=p_actor_id for update of a;
  if not found then return jsonb_build_object('ok',false,'code','attempt_not_found'); end if;
  select * into v_existing from exam_delivery.attempt_results where attempt_id=p_attempt_id;
  if found then if v_existing.submission_id=p_submission_id then return exam_delivery.get_result(p_actor_id,p_attempt_id); end if; return jsonb_build_object('ok',false,'code','submission_conflict'); end if;
  if v_attempt.status<>'in_progress' then return jsonb_build_object('ok',false,'code','invalid_lifecycle_transition'); end if;
  if not coalesce((exam_delivery.check_eligibility_v2(p_actor_id,v_attempt.exam_key,v_attempt.profile_key)->>'eligible')::boolean,false) then return jsonb_build_object('ok',false,'code','exam_unavailable'); end if;
  if not exists (
    select 1 from exam_delivery.python_submission_grading_sessions session
    where session.attempt_id=p_attempt_id and session.submission_id=p_submission_id
  ) or exists (
    select 1 from exam_delivery.attempt_items item
    join exam_delivery.package_questions question on question.id=item.package_question_id
    join exam_delivery.python_lab_workspaces workspace
      on workspace.attempt_id=item.attempt_id and workspace.attempt_item_id=item.id
    where item.attempt_id=p_attempt_id and question.question_type='executable-python-lab-v1'
      and not exists (
        select 1 from exam_delivery.python_submission_grading_runs submission_run
        join exam_delivery.python_grading_evidence evidence on evidence.run_id=submission_run.run_id
        where submission_run.attempt_id=p_attempt_id
          and submission_run.submission_id=p_submission_id
          and submission_run.attempt_item_id=item.id
      )
  ) then return jsonb_build_object('ok',false,'code','grading_incomplete'); end if;

  select encode(extensions.digest(convert_to(coalesce(jsonb_agg(jsonb_build_object(
    'itemId',i.id,'response',r.response_payload,
    'workspaceRevision',case when q.question_type='executable-python-lab-v1' then w.current_revision end,
    'workspaceHash',case when q.question_type='executable-python-lab-v1' then w.workspace_hash end
  ) order by i.id)::text,'[]'),'UTF8'),'sha256'),'hex') into v_response_hash
    from exam_delivery.attempt_items i
    join exam_delivery.package_questions q on q.id=i.package_question_id
    left join exam_delivery.attempt_responses r on r.attempt_id=i.attempt_id and r.attempt_item_id=i.id
    left join exam_delivery.python_lab_workspaces w on w.attempt_id=i.attempt_id and w.attempt_item_id=i.id
    where i.attempt_id=p_attempt_id;
  with scored as (
    select q.domain_key,coalesce(r.response_payload,'{}'::jsonb) response,
      exam_delivery.score_attempt_item_with_trusted_grading(
        p_attempt_id,p_submission_id,i.id,v_attempt.scorer_version,q.question_type,
        i.presentation_snapshot,pc.scoring_snapshot,coalesce(r.response_payload,'{}'::jsonb),
        coalesce((meta.authoring_metadata->>'scored')::boolean,true)
      ) score
    from exam_delivery.attempt_items i join exam_delivery.package_questions q on q.id=i.package_question_id
    join exam_delivery.package_question_protected_content meta on meta.question_id=q.id
    join exam_delivery.attempt_item_protected_content pc on pc.attempt_item_id=i.id
    left join exam_delivery.attempt_responses r on r.attempt_item_id=i.id where i.attempt_id=p_attempt_id
  ) select coalesce(sum((score->>'earned')::numeric),0),coalesce(sum((score->>'maximum')::numeric),0) into v_raw,v_max from scored;
  if v_max<=0 then raise exception 'scoring_contract_invalid' using errcode='22023'; end if;
  with scored as (
    select q.domain_key,exam_delivery.score_attempt_item_with_trusted_grading(
      p_attempt_id,p_submission_id,i.id,v_attempt.scorer_version,q.question_type,
      i.presentation_snapshot,pc.scoring_snapshot,coalesce(r.response_payload,'{}'::jsonb),
      coalesce((meta.authoring_metadata->>'scored')::boolean,true)
    ) score
    from exam_delivery.attempt_items i join exam_delivery.package_questions q on q.id=i.package_question_id join exam_delivery.package_question_protected_content meta on meta.question_id=q.id join exam_delivery.attempt_item_protected_content pc on pc.attempt_item_id=i.id left join exam_delivery.attempt_responses r on r.attempt_item_id=i.id where i.attempt_id=p_attempt_id
  ), domains as (
    select domain_key,jsonb_build_object('domain',domain_key,'correct',count(*) filter(where score->>'status'='Correct'),'total',count(*) filter(where (score->>'maximum')::numeric>0),'earnedPoints',sum((score->>'earned')::numeric),'maxPoints',sum((score->>'maximum')::numeric),'percentage',case when sum((score->>'maximum')::numeric)>0 then round(100*sum((score->>'earned')::numeric)/sum((score->>'maximum')::numeric),2) else 0 end) value from scored group by domain_key
  ) select coalesce(jsonb_object_agg(domain_key,value),'{}'::jsonb) into v_domain from domains;
  select jsonb_build_object(
    'questionCount',count(*) filter(where coalesce((meta.authoring_metadata->>'scored')::boolean,true)),
    'presentedCount',count(*),
    'answeredCount',count(*) filter(where r.id is not null or (q.question_type='executable-python-lab-v1' and w.attempt_item_id is not null))
  ) into v_summary
    from exam_delivery.attempt_items i
    join exam_delivery.package_questions q on q.id=i.package_question_id
    join exam_delivery.package_question_protected_content meta on meta.question_id=i.package_question_id
    left join exam_delivery.attempt_responses r on r.attempt_item_id=i.id
    left join exam_delivery.python_lab_workspaces w on w.attempt_item_id=i.id
    where i.attempt_id=p_attempt_id;
  select jsonb_build_object('items',jsonb_agg(
    jsonb_build_object(
      'itemId',i.id,'questionNumber',i.presented_question_number,'questionId',q.question_id,
      'questionType',q.question_type,'domain',q.domain_key,'section',q.section_key,
      'presentation',i.presentation_snapshot,'response',coalesce(r.response_payload,'{}'::jsonb),
      'status',score.value->>'status','earnedPoints',(score.value->>'earned')::numeric,
      'maxPoints',(score.value->>'maximum')::numeric
    ) || case when q.question_type='executable-python-lab-v1' then '{}'::jsonb else jsonb_build_object(
      'correctAnswer',pc.scoring_snapshot,'explanation',pc.review_snapshot->>'explanation',
      'remediation',pc.review_snapshot->>'remediation'
    ) end order by i.presented_question_number
  )) into v_review
    from exam_delivery.attempt_items i join exam_delivery.package_questions q on q.id=i.package_question_id join exam_delivery.package_question_protected_content meta on meta.question_id=q.id join exam_delivery.attempt_item_protected_content pc on pc.attempt_item_id=i.id left join exam_delivery.attempt_responses r on r.attempt_item_id=i.id cross join lateral (select exam_delivery.score_attempt_item_with_trusted_grading(p_attempt_id,p_submission_id,i.id,v_attempt.scorer_version,q.question_type,i.presentation_snapshot,pc.scoring_snapshot,coalesce(r.response_payload,'{}'::jsonb),coalesce((meta.authoring_metadata->>'scored')::boolean,true)) value) score where i.attempt_id=p_attempt_id;
  v_percentage:=round(100*v_raw/v_max,4); v_pass_mark:=coalesce((v_attempt.selection_config#>>'{scoringContract,scoreScale,pass}')::integer,700); v_scaled:=round(v_percentage*10); v_passed:=v_scaled>=v_pass_mark;
  v_summary:=v_summary||jsonb_build_object('rawScore',v_raw,'maxScore',v_max,'rawPercentage',v_percentage,'scaledScore',v_scaled,'passed',v_passed,'passMark',v_pass_mark);
  insert into exam_delivery.attempt_results(attempt_id,submission_id,response_hash,scorer_version,raw_score,max_score,raw_percentage,passed,domain_summary,result_summary,server_authoritative,submitted_at,completed_at,created_at) values(p_attempt_id,p_submission_id,v_response_hash,v_attempt.scorer_version,v_raw,v_max,v_percentage,v_passed,v_domain,v_summary,true,v_now,v_now,v_now);
  insert into exam_delivery.review_snapshots(attempt_id,release_status,review_payload,review_hash,created_at) values(p_attempt_id,'withheld',v_review,encode(extensions.digest(convert_to(v_review::text,'UTF8'),'sha256'),'hex'),v_now);
  update exam_delivery.attempts set status='completed',submitted_at=v_now,completed_at=v_now where id=p_attempt_id;
  select id into v_catalog_id from public.exam_catalog where exam_delivery.normalize_exam_key(exam_key)=exam_delivery.normalize_exam_key(v_attempt.exam_key) and status='active' limit 1;
  insert into public.exam_attempts(id,user_id,exam_catalog_id,exam_key,exam_version,profile_id,mode_label,status,started_at,submitted_at,duration_seconds,time_limit_minutes,selected_question_ids,presented_order_snapshot,attempt_snapshot,client_app_version,created_at,updated_at)
  select p_attempt_id,p_actor_id,v_catalog_id,v_attempt.exam_key,v_attempt.package_version,v_attempt.profile_key,'Protected Exam','submitted',v_attempt.started_at,v_now,greatest(0,extract(epoch from v_now-v_attempt.started_at)::integer),v_attempt.time_limit_minutes,jsonb_agg(q.question_id order by i.presented_question_number),jsonb_build_object('questionIds',jsonb_agg(q.question_id order by i.presented_question_number),'itemTypes',jsonb_agg(jsonb_build_object('id',q.question_id,'type',q.question_type,'domain',q.domain_key,'isScored',coalesce((meta.authoring_metadata->>'scored')::boolean,true)) order by i.presented_question_number)),jsonb_build_object('attemptId',p_attempt_id,'sourceFlow','protected-exam-delivery','serverAuthoritative',true),'protected-server-v2',v_attempt.created_at,v_now from exam_delivery.attempt_items i join exam_delivery.package_questions q on q.id=i.package_question_id join exam_delivery.package_question_protected_content meta on meta.question_id=q.id where i.attempt_id=p_attempt_id;
  insert into public.exam_responses(attempt_id,question_id,question_type,response_snapshot,presented_snapshot,is_answered,is_scored,created_at)
  select p_attempt_id,q.question_id,q.question_type,coalesce(r.response_payload,'{}'::jsonb),i.presentation_snapshot,(r.id is not null or (q.question_type='executable-python-lab-v1' and w.attempt_item_id is not null)),coalesce((meta.authoring_metadata->>'scored')::boolean,true),v_now
  from exam_delivery.attempt_items i join exam_delivery.package_questions q on q.id=i.package_question_id join exam_delivery.package_question_protected_content meta on meta.question_id=q.id left join exam_delivery.attempt_responses r on r.attempt_item_id=i.id left join exam_delivery.python_lab_workspaces w on w.attempt_item_id=i.id where i.attempt_id=p_attempt_id;
  insert into public.exam_results(attempt_id,user_id,exam_key,profile_id,scoring_engine_version,raw_score,raw_percentage,scaled_score,passed,pass_mark,domain_breakdown,pbq_breakdown,case_study_breakdown,weak_areas,result_snapshot,created_at) values(p_attempt_id,p_actor_id,v_attempt.exam_key,v_attempt.profile_key,v_attempt.scorer_version,v_raw,v_percentage,v_scaled,v_passed,v_pass_mark,v_domain,'{}','{}','[]',v_summary,v_now);
  insert into public.exam_reports(attempt_id,user_id,report_type,report_title,report_snapshot,pdf_generated,created_at) values(p_attempt_id,p_actor_id,'study_report_snapshot','Protected Exam Study Report',jsonb_build_object('result',v_summary,'domainBreakdown',v_domain,'reviewStatus','withheld','serverAuthoritative',true),false,v_now);
  return exam_delivery.get_result(p_actor_id,p_attempt_id);
end
$$;

create or replace function exam_delivery.submit_attempt_v2(p_actor_id uuid,p_attempt_id uuid,p_submission_id uuid)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='15s' as $$
declare v_authorization jsonb; v_result jsonb; v_existing uuid; v_release boolean:=false; v_trusted boolean:=false;
begin
  select r.submission_id into v_existing from exam_delivery.attempt_results r join exam_delivery.attempts a on a.id=r.attempt_id
    where r.attempt_id=p_attempt_id and a.owner_id=p_actor_id;
  if found then
    if v_existing=p_submission_id then return exam_delivery.get_result(p_actor_id,p_attempt_id); end if;
    return jsonb_build_object('ok',false,'code','submission_conflict'); end if;
  select exists(
    select 1 from exam_delivery.python_submission_grading_sessions session
    join exam_delivery.attempts attempt on attempt.id=session.attempt_id
    where session.attempt_id=p_attempt_id and session.submission_id=p_submission_id
      and attempt.owner_id=p_actor_id
  ) into v_trusted;
  if v_trusted then
    if exists (
      select 1 from exam_delivery.attempt_items item
      join exam_delivery.package_questions question on question.id=item.package_question_id
      join exam_delivery.python_lab_workspaces workspace
        on workspace.attempt_id=item.attempt_id and workspace.attempt_item_id=item.id
      where item.attempt_id=p_attempt_id and question.question_type='executable-python-lab-v1'
        and not exists (
          select 1 from exam_delivery.python_submission_grading_runs submission_run
          join exam_delivery.python_grading_evidence evidence on evidence.run_id=submission_run.run_id
          where submission_run.attempt_id=p_attempt_id
            and submission_run.submission_id=p_submission_id
            and submission_run.attempt_item_id=item.id
        )
    ) then return jsonb_build_object('ok',false,'code','grading_incomplete'); end if;
  else
    v_authorization:=exam_delivery.authorize_attempt_continuation(p_attempt_id,'submit');
    if not coalesce((v_authorization->>'ok')::boolean,false) then return v_authorization; end if;
    if (v_authorization->>'ownerId')::uuid<>p_actor_id then return jsonb_build_object('ok',false,'code','attempt_not_found'); end if;
  end if;
  perform set_config('certsim.attempt_continuation_id',p_attempt_id::text,true);
  perform set_config('certsim.attempt_continuation_operation','submit',true);
  v_result:=case when v_trusted
    then exam_delivery.submit_attempt_v2_with_trusted_grading(p_actor_id,p_attempt_id,p_submission_id)
    else exam_delivery.submit_attempt_v2_with_assessment_gate(p_actor_id,p_attempt_id,p_submission_id)
  end;
  perform set_config('certsim.attempt_continuation_id','',true);
  perform set_config('certsim.attempt_continuation_operation','',true);
  if coalesce((v_result->>'ok')::boolean,false) then
    select case when a.source_assignment_id is not null then
      a.assignment_review_release_policy='after_submission'
      else p.review_release_policy<>'never' and p.answer_release_policy<>'never' end into v_release
    from exam_delivery.attempts a join exam_delivery.package_versions pv on pv.id=a.package_version_id
    join exam_delivery.package_profiles pp on pp.id=a.package_profile_id
    left join exam_delivery.practice_policies p on p.canonical_exam_key=exam_delivery.normalize_exam_key(pv.exam_key)
      and p.package_version=pv.package_version and p.profile_key=pp.profile_key and p.purpose=a.purpose
    where a.id=p_attempt_id;
    if coalesce(v_release,false) then
      update exam_delivery.review_snapshots set release_status='released',released_at=statement_timestamp()
        where attempt_id=p_attempt_id and release_status='withheld';
      update public.exam_reports set report_snapshot=jsonb_set(report_snapshot,'{reviewStatus}','"released"'::jsonb,true)
        where attempt_id=p_attempt_id and report_type='study_report_snapshot';
    end if;
    return exam_delivery.get_result(p_actor_id,p_attempt_id);
  end if;
  return v_result;
end
$$;

create function exam_delivery.get_latest_python_run(
  p_actor_id uuid,
  p_attempt_id uuid,
  p_item_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  v_authorization jsonb;
  v_workspace exam_delivery.python_lab_workspaces%rowtype;
  v_run exam_delivery.python_execution_runs%rowtype;
begin
  v_authorization := exam_delivery.authorize_python_lab_item(
    p_actor_id, p_attempt_id, p_item_id, 'run_status'
  );
  if not coalesce((v_authorization->>'ok')::boolean, false) then
    return v_authorization;
  end if;
  select workspace.* into v_workspace
  from exam_delivery.python_lab_workspaces workspace
  where workspace.attempt_id = p_attempt_id and workspace.attempt_item_id = p_item_id;
  if not found then
    return jsonb_build_object(
      'ok', true, 'itemId', p_item_id, 'workspaceRevision', 0, 'run', null
    );
  end if;
  select run.* into v_run
  from exam_delivery.python_execution_runs run
  where run.attempt_id = p_attempt_id
    and run.attempt_item_id = p_item_id
    and run.workspace_revision = v_workspace.current_revision
    and run.workspace_hash = v_workspace.workspace_hash
    and not exists (
      select 1 from exam_delivery.python_submission_grading_runs submission_run
      where submission_run.run_id = run.id
    )
  order by run.created_at desc, run.id desc
  limit 1;
  return jsonb_build_object(
    'ok', true,
    'itemId', p_item_id,
    'workspaceRevision', v_workspace.current_revision,
    'run', case when found then jsonb_build_object(
      'runId', v_run.id, 'state', v_run.state,
      'terminalOutcome', v_run.terminal_outcome,
      'stdout', v_run.learner_stdout, 'stderr', v_run.learner_stderr,
      'exitCode', v_run.learner_exit_code,
      'cancellationRequestedAt', v_run.cancellation_requested_at,
      'disposalState', v_run.disposal_state,
      'createdAt', v_run.created_at, 'updatedAt', v_run.updated_at
    ) else null end
  );
end
$$;

create function public.certsim_protected_get_latest_python_run(
  p_actor_id uuid,
  p_attempt_id uuid,
  p_item_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select exam_delivery.get_latest_python_run(p_actor_id, p_attempt_id, p_item_id)
$$;

alter function exam_delivery.get_latest_python_run(uuid, uuid, uuid) owner to postgres;
alter function public.certsim_protected_get_latest_python_run(uuid, uuid, uuid) owner to postgres;

revoke all on function exam_delivery.get_latest_python_run(uuid, uuid, uuid)
from public, anon, authenticated;
revoke all on function public.certsim_protected_get_latest_python_run(uuid, uuid, uuid)
from public, anon, authenticated;
grant execute on function exam_delivery.get_latest_python_run(uuid, uuid, uuid)
to service_role;
grant execute on function public.certsim_protected_get_latest_python_run(uuid, uuid, uuid)
to service_role;

comment on function exam_delivery.prepare_python_submission_grading(uuid, uuid, uuid) is
  'Freezes trusted grading only for workspace-backed executable tasks; absent workspaces remain unanswered.';
comment on function exam_delivery.score_attempt_item_with_trusted_grading(uuid, uuid, uuid, text, text, jsonb, jsonb, jsonb, boolean) is
  'Scores absent executable workspaces as Unanswered with the authoritative maximum; workspace-backed tasks require trusted evidence.';
comment on function exam_delivery.get_latest_python_run(uuid, uuid, uuid) is
  'Returns the newest learner-requested run bound to the current saved workspace revision after item authorization.';
comment on function public.certsim_protected_get_latest_python_run(uuid, uuid, uuid) is
  'Service-role wrapper for the current-revision learner run read contract.';

notify pgrst, 'reload schema';

commit;
