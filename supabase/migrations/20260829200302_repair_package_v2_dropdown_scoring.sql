-- Repair package-v2 dropdown scoring without changing published package data.
-- Presentation owns blank identifiers; protected scoring owns correct values.

create function exam_delivery.score_package_v2_response_with_presentation(
  p_question_type text,
  p_presentation jsonb,
  p_scoring jsonb,
  p_response jsonb,
  p_scored boolean
)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  v_expected jsonb;
begin
  if p_question_type not in ('dropdown-code', 'dropdown-command') then
    return exam_delivery.score_package_v2_response(
      p_question_type,
      p_scoring,
      p_response,
      p_scored
    );
  end if;

  if not p_scored then
    return jsonb_build_object(
      'earned', 0,
      'maximum', 0,
      'status', 'Informational'
    );
  end if;

  if jsonb_typeof(p_presentation -> 'blanks') <> 'array'
     or jsonb_typeof(p_scoring -> 'blanks') <> 'array'
     or jsonb_array_length(p_presentation -> 'blanks')
        <> jsonb_array_length(p_scoring -> 'blanks')
     or exists (
       select 1
       from jsonb_array_elements(p_presentation -> 'blanks')
         with ordinality as presented(blank, position)
       full join jsonb_array_elements(p_scoring -> 'blanks')
         with ordinality as protected(blank, position)
         using (position)
       where nullif(presented.blank ->> 'id', '') is null
          or nullif(protected.blank ->> 'correctAnswer', '') is null
     ) then
    raise exception 'scoring_contract_invalid' using errcode = '22023';
  end if;

  select coalesce(
    jsonb_object_agg(
      presented.blank ->> 'id',
      to_jsonb(protected.blank ->> 'correctAnswer')
      order by presented.position
    ),
    '{}'::jsonb
  )
  into v_expected
  from jsonb_array_elements(p_presentation -> 'blanks')
    with ordinality as presented(blank, position)
  join jsonb_array_elements(p_scoring -> 'blanks')
    with ordinality as protected(blank, position)
    using (position);

  return jsonb_build_object(
    'earned', case when coalesce(p_response -> 'selectedAnswers', p_response -> 'answer') = v_expected then 1 else 0 end,
    'maximum', 1,
    'status', case
      when p_response is null or p_response = '{}'::jsonb then 'Incomplete'
      when coalesce(p_response -> 'selectedAnswers', p_response -> 'answer') = v_expected then 'Correct'
      else 'Incorrect'
    end
  );
end;
$$;

revoke execute on function exam_delivery.score_package_v2_response_with_presentation(
  text, jsonb, jsonb, jsonb, boolean
) from public, anon, authenticated, service_role;

create or replace function exam_delivery.submit_attempt_v2(
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
  select encode(extensions.digest(convert_to(coalesce(jsonb_agg(jsonb_build_object('itemId',i.id,'response',r.response_payload) order by i.id)::text,'[]'),'UTF8'),'sha256'),'hex') into v_response_hash
    from exam_delivery.attempt_items i left join exam_delivery.attempt_responses r on r.attempt_id=i.attempt_id and r.attempt_item_id=i.id where i.attempt_id=p_attempt_id;
  with scored as (
    select q.domain_key,coalesce(r.response_payload,'{}'::jsonb) response,
      exam_delivery.score_package_v2_response_with_presentation(q.question_type,i.presentation_snapshot,pc.scoring_snapshot,coalesce(r.response_payload,'{}'::jsonb),coalesce((meta.authoring_metadata->>'scored')::boolean,true)) score
    from exam_delivery.attempt_items i join exam_delivery.package_questions q on q.id=i.package_question_id
    join exam_delivery.package_question_protected_content meta on meta.question_id=q.id
    join exam_delivery.attempt_item_protected_content pc on pc.attempt_item_id=i.id
    left join exam_delivery.attempt_responses r on r.attempt_item_id=i.id where i.attempt_id=p_attempt_id
  ) select coalesce(sum((score->>'earned')::numeric),0),coalesce(sum((score->>'maximum')::numeric),0) into v_raw,v_max from scored;
  if v_max<=0 then raise exception 'scoring_contract_invalid' using errcode='22023'; end if;
  with scored as (
    select q.domain_key,exam_delivery.score_package_v2_response_with_presentation(q.question_type,i.presentation_snapshot,pc.scoring_snapshot,coalesce(r.response_payload,'{}'::jsonb),coalesce((meta.authoring_metadata->>'scored')::boolean,true)) score
    from exam_delivery.attempt_items i join exam_delivery.package_questions q on q.id=i.package_question_id join exam_delivery.package_question_protected_content meta on meta.question_id=q.id join exam_delivery.attempt_item_protected_content pc on pc.attempt_item_id=i.id left join exam_delivery.attempt_responses r on r.attempt_item_id=i.id where i.attempt_id=p_attempt_id
  ), domains as (
    select domain_key,jsonb_build_object('domain',domain_key,'correct',count(*) filter(where score->>'status'='Correct'),'total',count(*) filter(where (score->>'maximum')::numeric>0),'earnedPoints',sum((score->>'earned')::numeric),'maxPoints',sum((score->>'maximum')::numeric),'percentage',case when sum((score->>'maximum')::numeric)>0 then round(100*sum((score->>'earned')::numeric)/sum((score->>'maximum')::numeric),2) else 0 end) value from scored group by domain_key
  ) select coalesce(jsonb_object_agg(domain_key,value),'{}'::jsonb) into v_domain from domains;
  select jsonb_build_object('questionCount',count(*) filter(where coalesce((meta.authoring_metadata->>'scored')::boolean,true)),'presentedCount',count(*),'answeredCount',count(r.id)) into v_summary
    from exam_delivery.attempt_items i join exam_delivery.package_question_protected_content meta on meta.question_id=i.package_question_id left join exam_delivery.attempt_responses r on r.attempt_item_id=i.id where i.attempt_id=p_attempt_id;
  select jsonb_build_object('items',jsonb_agg(jsonb_build_object('itemId',i.id,'questionNumber',i.presented_question_number,'questionId',q.question_id,'questionType',q.question_type,'domain',q.domain_key,'section',q.section_key,'presentation',i.presentation_snapshot,'response',coalesce(r.response_payload,'{}'::jsonb),'status',score.value->>'status','earnedPoints',(score.value->>'earned')::numeric,'maxPoints',(score.value->>'maximum')::numeric,'correctAnswer',pc.scoring_snapshot,'explanation',pc.review_snapshot->>'explanation','remediation',pc.review_snapshot->>'remediation') order by i.presented_question_number)) into v_review
    from exam_delivery.attempt_items i join exam_delivery.package_questions q on q.id=i.package_question_id join exam_delivery.package_question_protected_content meta on meta.question_id=q.id join exam_delivery.attempt_item_protected_content pc on pc.attempt_item_id=i.id left join exam_delivery.attempt_responses r on r.attempt_item_id=i.id cross join lateral (select exam_delivery.score_package_v2_response_with_presentation(q.question_type,i.presentation_snapshot,pc.scoring_snapshot,coalesce(r.response_payload,'{}'::jsonb),coalesce((meta.authoring_metadata->>'scored')::boolean,true)) value) score where i.attempt_id=p_attempt_id;
  v_percentage:=round(100*v_raw/v_max,4); v_pass_mark:=coalesce((v_attempt.selection_config#>>'{scoringContract,scoreScale,pass}')::integer,700); v_scaled:=round(v_percentage*10); v_passed:=v_scaled>=v_pass_mark;
  v_summary:=v_summary||jsonb_build_object('rawScore',v_raw,'maxScore',v_max,'rawPercentage',v_percentage,'scaledScore',v_scaled,'passed',v_passed,'passMark',v_pass_mark);
  insert into exam_delivery.attempt_results(attempt_id,submission_id,response_hash,scorer_version,raw_score,max_score,raw_percentage,passed,domain_summary,result_summary,server_authoritative,submitted_at,completed_at,created_at) values(p_attempt_id,p_submission_id,v_response_hash,v_attempt.scorer_version,v_raw,v_max,v_percentage,v_passed,v_domain,v_summary,true,v_now,v_now,v_now);
  insert into exam_delivery.review_snapshots(attempt_id,release_status,review_payload,review_hash,created_at) values(p_attempt_id,'withheld',v_review,encode(extensions.digest(convert_to(v_review::text,'UTF8'),'sha256'),'hex'),v_now);
  update exam_delivery.attempts set status='completed',submitted_at=v_now,completed_at=v_now where id=p_attempt_id;
  select id into v_catalog_id from public.exam_catalog where exam_delivery.normalize_exam_key(exam_key)=exam_delivery.normalize_exam_key(v_attempt.exam_key) and status='active' limit 1;
  insert into public.exam_attempts(id,user_id,exam_catalog_id,exam_key,exam_version,profile_id,mode_label,status,started_at,submitted_at,duration_seconds,time_limit_minutes,selected_question_ids,presented_order_snapshot,attempt_snapshot,client_app_version,created_at,updated_at)
  select p_attempt_id,p_actor_id,v_catalog_id,v_attempt.exam_key,v_attempt.package_version,v_attempt.profile_key,'Protected Exam','submitted',v_attempt.started_at,v_now,greatest(0,extract(epoch from v_now-v_attempt.started_at)::integer),v_attempt.time_limit_minutes,jsonb_agg(q.question_id order by i.presented_question_number),jsonb_build_object('questionIds',jsonb_agg(q.question_id order by i.presented_question_number),'itemTypes',jsonb_agg(jsonb_build_object('id',q.question_id,'type',q.question_type,'domain',q.domain_key,'isScored',coalesce((meta.authoring_metadata->>'scored')::boolean,true)) order by i.presented_question_number)),jsonb_build_object('attemptId',p_attempt_id,'sourceFlow','protected-exam-delivery','serverAuthoritative',true),'protected-server-v2',v_attempt.created_at,v_now from exam_delivery.attempt_items i join exam_delivery.package_questions q on q.id=i.package_question_id join exam_delivery.package_question_protected_content meta on meta.question_id=q.id where i.attempt_id=p_attempt_id;
  insert into public.exam_responses(attempt_id,question_id,question_type,response_snapshot,presented_snapshot,is_answered,is_scored,created_at) select p_attempt_id,q.question_id,q.question_type,coalesce(r.response_payload,'{}'::jsonb),i.presentation_snapshot,r.id is not null,coalesce((meta.authoring_metadata->>'scored')::boolean,true),v_now from exam_delivery.attempt_items i join exam_delivery.package_questions q on q.id=i.package_question_id join exam_delivery.package_question_protected_content meta on meta.question_id=q.id left join exam_delivery.attempt_responses r on r.attempt_item_id=i.id where i.attempt_id=p_attempt_id;
  insert into public.exam_results(attempt_id,user_id,exam_key,profile_id,scoring_engine_version,raw_score,raw_percentage,scaled_score,passed,pass_mark,domain_breakdown,pbq_breakdown,case_study_breakdown,weak_areas,result_snapshot,created_at) values(p_attempt_id,p_actor_id,v_attempt.exam_key,v_attempt.profile_key,v_attempt.scorer_version,v_raw,v_percentage,v_scaled,v_passed,v_pass_mark,v_domain,'{}','{}','[]',v_summary,v_now);
  insert into public.exam_reports(attempt_id,user_id,report_type,report_title,report_snapshot,pdf_generated,created_at) values(p_attempt_id,p_actor_id,'study_report_snapshot','Protected Exam Study Report',jsonb_build_object('result',v_summary,'domainBreakdown',v_domain,'reviewStatus','withheld','serverAuthoritative',true),false,v_now);
  return exam_delivery.get_result(p_actor_id,p_attempt_id);
end;
$$;

revoke execute on function exam_delivery.score_package_v2_response_with_presentation(
  text, jsonb, jsonb, jsonb, boolean
) from public, anon, authenticated, service_role;
revoke execute on function exam_delivery.submit_attempt_v2(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
