-- Issue #20 G3B2R2: authorize continuation from the immutable attempt purpose.
-- No policy, entitlement, assignment, package, attempt, or access row is created.

alter function exam_delivery.check_eligibility_v2(uuid,text,text)
  rename to check_assessment_eligibility_v2;
alter function exam_delivery.save_response(uuid,uuid,uuid,jsonb,integer,uuid)
  rename to save_response_with_assessment_gate;
alter function exam_delivery.submit_attempt_v2(uuid,uuid,uuid)
  rename to submit_attempt_v2_with_assessment_gate;

create function exam_delivery.authorize_attempt_continuation(
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
  v_allowed boolean := false;
  v_assessment jsonb;
begin
  if p_attempt_id is null
     or p_operation not in ('resume','save_response','check_item','submit') then
    return jsonb_build_object('ok',false,'code','invalid_request');
  end if;

  select a.owner_id,a.status,a.expires_at,a.purpose,a.practice_configuration,
         a.language_preference,pv.exam_key,pv.package_version,pv.package_schema_version,pp.profile_key,
         p.access_mode,p.enabled
    into v
  from exam_delivery.attempts a
  join exam_delivery.package_versions pv on pv.id=a.package_version_id
  join exam_delivery.package_profiles pp on pp.id=a.package_profile_id
  left join exam_delivery.practice_policies p
    on p.canonical_exam_key=exam_delivery.normalize_exam_key(pv.exam_key)
   and p.package_version=pv.package_version
   and p.profile_key=pp.profile_key
   and p.purpose=a.purpose
  where a.id=p_attempt_id;
  if not found then return jsonb_build_object('ok',false,'code','attempt_not_found'); end if;
  if v.status<>'in_progress' or statement_timestamp()>=v.expires_at then
    return jsonb_build_object('ok',false,'code','invalid_lifecycle_transition');
  end if;

  if v.purpose='assigned_assessment' then
    if v.package_schema_version='certsim-protected-package-v2' then
      v_assessment:=exam_delivery.check_assessment_eligibility_v2(v.owner_id,v.exam_key,v.profile_key);
    else
      v_assessment:=exam_delivery.check_eligibility(v.owner_id,v.exam_key,v.profile_key);
    end if;
    if not coalesce((v_assessment->>'eligible')::boolean,false) then
      return jsonb_build_object('ok',false,'code','exam_unavailable');
    end if;
  else
    if not coalesce(v.enabled,false) or v.access_mode='disabled' then
      return jsonb_build_object('ok',false,'code','practice_unavailable');
    end if;
    if v.access_mode='open_authenticated' then
      v_allowed:=exists(select 1 from public.profiles where id=v.owner_id and status='active');
    elsif v.access_mode='organisation_scoped' then
      v_allowed:=exists(
        select 1 from public.memberships m
        join public.organisations o on o.id=m.organisation_id and o.status='active'
        join exam_delivery.exam_access_organisations s
          on s.organisation_id=m.organisation_id
         and s.canonical_exam_key=exam_delivery.normalize_exam_key(v.exam_key)
         and s.enabled
        where m.user_id=v.owner_id and m.status='active'
          and (s.access_starts_at is null or s.access_starts_at<=statement_timestamp())
          and (s.access_ends_at is null or s.access_ends_at>statement_timestamp())
      );
    elsif v.access_mode='controlled_beta' then
      v_allowed:=exists(
        select 1 from exam_delivery.exam_access_learners l
        where l.canonical_exam_key=exam_delivery.normalize_exam_key(v.exam_key)
          and l.learner_id=v.owner_id and l.enabled
          and (l.access_starts_at is null or l.access_starts_at<=statement_timestamp())
          and (l.access_ends_at is null or l.access_ends_at>statement_timestamp())
      );
    elsif v.access_mode='assignment_required' then
      v_allowed:=exists(
        select 1 from exam_delivery.protected_assignments a
        join exam_delivery.attempts current_attempt on current_attempt.id=p_attempt_id
        where a.id=current_attempt.protected_assignment_id
          and a.learner_id=v.owner_id and a.status='active'
          and a.available_from<=statement_timestamp()
          and (a.expires_at is null or a.expires_at>statement_timestamp())
      );
    end if;
    if not v_allowed then return jsonb_build_object('ok',false,'code','access_not_granted'); end if;
  end if;

  return jsonb_build_object(
    'ok',true,'code','authorized','ownerId',v.owner_id,
    'examKey',exam_delivery.normalize_exam_key(v.exam_key),
    'profileKey',v.profile_key,'purpose',v.purpose
  );
end;
$$;

create function exam_delivery.check_eligibility_v2(
  p_actor_id uuid,p_exam_key text,p_profile_key text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '10s'
as $$
declare
  v_attempt_id uuid;
  v_authorization jsonb;
begin
  begin
    v_attempt_id:=nullif(current_setting('certsim.attempt_continuation_id',true),'')::uuid;
  exception when invalid_text_representation then
    v_attempt_id:=null;
  end;
  if v_attempt_id is not null then
    v_authorization:=exam_delivery.authorize_attempt_continuation(
      v_attempt_id,
      nullif(current_setting('certsim.attempt_continuation_operation',true),'')
    );
    if coalesce((v_authorization->>'ok')::boolean,false)
       and (v_authorization->>'ownerId')::uuid=p_actor_id
       and v_authorization->>'examKey'=exam_delivery.normalize_exam_key(p_exam_key)
       and v_authorization->>'profileKey'=p_profile_key then
      return jsonb_build_object('eligible',true,'reasonCode','eligible');
    end if;
    return jsonb_build_object('eligible',false,'reasonCode','exam_unavailable');
  end if;
  return exam_delivery.check_assessment_eligibility_v2(p_actor_id,p_exam_key,p_profile_key);
end;
$$;

create function exam_delivery.save_response(
  p_actor_id uuid,p_attempt_id uuid,p_item_id uuid,p_response jsonb,
  p_expected_revision integer,p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '10s'
as $$
declare v_authorization jsonb; v_result jsonb;
begin
  v_authorization:=exam_delivery.authorize_attempt_continuation(p_attempt_id,'save_response');
  if not coalesce((v_authorization->>'ok')::boolean,false) then return v_authorization; end if;
  if (v_authorization->>'ownerId')::uuid<>p_actor_id then return jsonb_build_object('ok',false,'code','attempt_not_found'); end if;
  perform set_config('certsim.attempt_continuation_id',p_attempt_id::text,true);
  perform set_config('certsim.attempt_continuation_operation','save_response',true);
  v_result:=exam_delivery.save_response_with_assessment_gate(p_actor_id,p_attempt_id,p_item_id,p_response,p_expected_revision,p_request_id);
  perform set_config('certsim.attempt_continuation_id','',true);
  perform set_config('certsim.attempt_continuation_operation','',true);
  return v_result;
end;
$$;

create function exam_delivery.submit_attempt_v2(
  p_actor_id uuid,p_attempt_id uuid,p_submission_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '15s'
as $$
declare v_authorization jsonb; v_result jsonb; v_existing uuid; v_release boolean:=false;
begin
  select r.submission_id into v_existing
  from exam_delivery.attempt_results r join exam_delivery.attempts a on a.id=r.attempt_id
  where r.attempt_id=p_attempt_id and a.owner_id=p_actor_id;
  if found then
    if v_existing=p_submission_id then return exam_delivery.get_result(p_actor_id,p_attempt_id); end if;
    return jsonb_build_object('ok',false,'code','submission_conflict');
  end if;
  v_authorization:=exam_delivery.authorize_attempt_continuation(p_attempt_id,'submit');
  if not coalesce((v_authorization->>'ok')::boolean,false) then return v_authorization; end if;
  if (v_authorization->>'ownerId')::uuid<>p_actor_id then return jsonb_build_object('ok',false,'code','attempt_not_found'); end if;
  perform set_config('certsim.attempt_continuation_id',p_attempt_id::text,true);
  perform set_config('certsim.attempt_continuation_operation','submit',true);
  v_result:=exam_delivery.submit_attempt_v2_with_assessment_gate(p_actor_id,p_attempt_id,p_submission_id);
  perform set_config('certsim.attempt_continuation_id','',true);
  perform set_config('certsim.attempt_continuation_operation','',true);
  if coalesce((v_result->>'ok')::boolean,false) then
    select p.review_release_policy<>'never' and p.answer_release_policy<>'never'
      into v_release
    from exam_delivery.attempts a
    join exam_delivery.package_versions pv on pv.id=a.package_version_id
    join exam_delivery.package_profiles pp on pp.id=a.package_profile_id
    join exam_delivery.practice_policies p
      on p.canonical_exam_key=exam_delivery.normalize_exam_key(pv.exam_key)
     and p.package_version=pv.package_version and p.profile_key=pp.profile_key
     and p.purpose=a.purpose
    where a.id=p_attempt_id and a.purpose<>'assigned_assessment';
    if coalesce(v_release,false) then
      update exam_delivery.review_snapshots
         set release_status='released',released_at=statement_timestamp()
       where attempt_id=p_attempt_id and release_status='withheld';
      update public.exam_reports
         set report_snapshot=jsonb_set(report_snapshot,'{reviewStatus}','"released"'::jsonb,true)
       where attempt_id=p_attempt_id and report_type='study_report_snapshot';
    end if;
    return exam_delivery.get_result(p_actor_id,p_attempt_id);
  end if;
  return v_result;
end;
$$;

create or replace function exam_delivery.resume_attempt(p_actor_id uuid,p_attempt_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' set statement_timeout='10s' as $$
declare v record; v_authorization jsonb;
begin
  v_authorization:=exam_delivery.authorize_attempt_continuation(p_attempt_id,'resume');
  if not coalesce((v_authorization->>'ok')::boolean,false) then return v_authorization; end if;
  if (v_authorization->>'ownerId')::uuid<>p_actor_id then return jsonb_build_object('ok',false,'code','attempt_not_found'); end if;
  select a.*,pv.exam_key,pv.package_version,pp.profile_key,pp.display_name,pp.time_limit_minutes into v
  from exam_delivery.attempts a join exam_delivery.package_versions pv on pv.id=a.package_version_id join exam_delivery.package_profiles pp on pp.id=a.package_profile_id
  where a.id=p_attempt_id;
  return jsonb_build_object('ok',true,'attempt',jsonb_build_object('attemptId',v.id,'examKey',v.exam_key,'packageVersion',v.package_version,'profileKey',v.profile_key,'profileName',v.display_name,'status',v.status,'startedAt',v.started_at,'expiresAt',v.expires_at,'timeLimitMinutes',v.time_limit_minutes,'purpose',v.purpose,'languagePreference',v.language_preference),'items',coalesce((select jsonb_agg(jsonb_build_object('itemId',i.id,'questionNumber',i.presented_question_number,'questionId',q.question_id,'questionType',q.question_type,'domain',q.domain_key,'section',q.section_key,'presentation',i.presentation_snapshot,'response',r.response_payload,'revision',coalesce(r.revision,0)) order by i.presented_question_number) from exam_delivery.attempt_items i join exam_delivery.package_questions q on q.id=i.package_question_id left join exam_delivery.attempt_responses r on r.attempt_id=i.attempt_id and r.attempt_item_id=i.id where i.attempt_id=v.id),'[]'::jsonb));
end $$;

create or replace function exam_delivery.check_practice_item(p_actor_id uuid,p_attempt_id uuid,p_item_id uuid,p_expected_revision integer,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='5s' as $$
declare v record; v_score jsonb; v_release exam_delivery.practice_feedback_releases%rowtype; v_authorization jsonb;
begin
  v_authorization:=exam_delivery.authorize_attempt_continuation(p_attempt_id,'check_item');
  if not coalesce((v_authorization->>'ok')::boolean,false) then return v_authorization; end if;
  if (v_authorization->>'ownerId')::uuid<>p_actor_id then return jsonb_build_object('ok',false,'code','attempt_not_found'); end if;
  select a.purpose,a.status,r.revision,r.response_payload,q.question_type,pc.scoring_snapshot,pc.review_snapshot,p.immediate_feedback into v
  from exam_delivery.attempts a join exam_delivery.attempt_items i on i.attempt_id=a.id join exam_delivery.attempt_responses r on r.attempt_id=a.id and r.attempt_item_id=i.id
  join exam_delivery.package_questions q on q.id=i.package_question_id join exam_delivery.attempt_item_protected_content pc on pc.attempt_item_id=i.id
  join exam_delivery.package_versions pv on pv.id=a.package_version_id join exam_delivery.package_profiles pp on pp.id=a.package_profile_id
  join exam_delivery.practice_policies p on p.canonical_exam_key=exam_delivery.normalize_exam_key(pv.exam_key) and p.package_version=pv.package_version and p.profile_key=pp.profile_key and p.purpose=a.purpose
  where a.id=p_attempt_id and i.id=p_item_id for update of a;
  if not found then return jsonb_build_object('ok',false,'code','attempt_not_found'); end if;
  if v.status<>'in_progress' or not v.immediate_feedback then return jsonb_build_object('ok',false,'code','review_unavailable'); end if;
  if v.revision<>p_expected_revision then return jsonb_build_object('ok',false,'code','stale_response'); end if;
  insert into exam_delivery.practice_feedback_releases(attempt_id,attempt_item_id,response_revision,request_id)
    values(p_attempt_id,p_item_id,p_expected_revision,p_request_id) on conflict(attempt_id,attempt_item_id,response_revision) do update set request_id=exam_delivery.practice_feedback_releases.request_id returning * into v_release;
  v_score:=exam_delivery.score_package_v2_response_with_presentation(v.question_type,(select presentation_snapshot from exam_delivery.attempt_items where id=p_item_id),v.scoring_snapshot,v.response_payload,true);
  return jsonb_build_object('ok',true,'itemId',p_item_id,'revision',p_expected_revision,'status',v_score->>'status','earnedPoints',(v_score->>'earned')::numeric,'maxPoints',(v_score->>'maximum')::numeric,'review',v.review_snapshot,'releasedAt',v_release.released_at);
end $$;

create or replace function exam_delivery.get_review(p_actor_id uuid,p_attempt_id uuid)
returns jsonb language sql stable security definer set search_path='' set statement_timeout='5s' as $$
  select case
    when not exists(select 1 from exam_delivery.attempts a where a.id=p_attempt_id and a.owner_id=p_actor_id and a.status='completed') then jsonb_build_object('ok',false,'code','attempt_not_found')
    when not exists(
      select 1 from exam_delivery.review_snapshots r
      join exam_delivery.attempts a on a.id=r.attempt_id
      left join exam_delivery.protected_assignments pa on pa.id=a.protected_assignment_id
      left join exam_delivery.package_versions pv on pv.id=a.package_version_id
      left join exam_delivery.package_profiles pp on pp.id=a.package_profile_id
      left join exam_delivery.practice_policies p
        on p.canonical_exam_key=exam_delivery.normalize_exam_key(pv.exam_key)
       and p.package_version=pv.package_version and p.profile_key=pp.profile_key
       and p.purpose=a.purpose
      where r.attempt_id=p_attempt_id and a.owner_id=p_actor_id and r.release_status='released'
        and ((a.purpose='assigned_assessment' and pa.review_release_policy<>'never' and pa.answer_release_policy<>'never')
          or (a.purpose<>'assigned_assessment' and p.review_release_policy<>'never' and p.answer_release_policy<>'never'))
    ) then jsonb_build_object('ok',false,'code','review_unavailable')
    else (select jsonb_build_object('ok',true,'review',r.review_payload) from exam_delivery.review_snapshots r where r.attempt_id=p_attempt_id)
  end;
$$;

revoke execute on function exam_delivery.authorize_attempt_continuation(uuid,text),
  exam_delivery.check_assessment_eligibility_v2(uuid,text,text),
  exam_delivery.save_response_with_assessment_gate(uuid,uuid,uuid,jsonb,integer,uuid),
  exam_delivery.submit_attempt_v2_with_assessment_gate(uuid,uuid,uuid)
  from public,anon,authenticated,service_role;
revoke execute on function exam_delivery.check_eligibility_v2(uuid,text,text),
  exam_delivery.save_response(uuid,uuid,uuid,jsonb,integer,uuid),
  exam_delivery.submit_attempt_v2(uuid,uuid,uuid),exam_delivery.resume_attempt(uuid,uuid),
  exam_delivery.check_practice_item(uuid,uuid,uuid,integer,uuid),exam_delivery.get_review(uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function exam_delivery.save_response(uuid,uuid,uuid,jsonb,integer,uuid),
  exam_delivery.resume_attempt(uuid,uuid),
  exam_delivery.check_practice_item(uuid,uuid,uuid,integer,uuid),exam_delivery.get_review(uuid,uuid)
  to service_role;
