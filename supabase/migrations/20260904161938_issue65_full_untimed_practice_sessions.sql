-- Issue #65: full, untimed protected practice with bounded presentation delivery.
-- Formal assessments retain their existing fixed size and deadline contract.

alter table exam_delivery.attempts
  add column practice_last_activity_at timestamptz,
  add column practice_idle_expires_at timestamptz;

alter table exam_delivery.attempts alter column expires_at drop not null;
alter table exam_delivery.attempts drop constraint attempts_expiry_order_check;

-- Preserve any active practice session across deployment while converting it
-- from an exam deadline to the bounded inactivity-recovery contract.
update exam_delivery.attempts
set expires_at=null,
    practice_last_activity_at=statement_timestamp(),
    practice_idle_expires_at=statement_timestamp()+interval '30 days'
where status='in_progress'
  and purpose in ('study_sandbox','targeted_domain','weak_area','pbq_practice');

alter table exam_delivery.attempts add constraint attempts_expiry_order_check check (
  (purpose in ('assigned_assessment','self_directed_exam') and expires_at is not null and expires_at > started_at)
  or
  (purpose in ('study_sandbox','targeted_domain','weak_area','pbq_practice') and (status<>'in_progress' or expires_at is null))
);

create index attempts_practice_idle_expiry_idx
  on exam_delivery.attempts(practice_idle_expires_at)
  where status='in_progress' and purpose in ('study_sandbox','targeted_domain','weak_area','pbq_practice');

create function exam_delivery.touch_practice_activity()
returns trigger language plpgsql security definer set search_path='' set statement_timeout='5s' as $$
begin
  update exam_delivery.attempts
  set practice_last_activity_at=statement_timestamp(),
      practice_idle_expires_at=statement_timestamp()+interval '30 days'
  where id=new.attempt_id and status='in_progress'
    and purpose in ('study_sandbox','targeted_domain','weak_area','pbq_practice');
  return new;
end $$;
create trigger touch_practice_activity_after_response
after insert or update on exam_delivery.attempt_responses
for each row execute function exam_delivery.touch_practice_activity();

-- Full modes intentionally omit count. Weak Area remains bounded and keeps its
-- existing mix contract. Counts are scored records; atomic context records are
-- included with their child questions during materialization.
create or replace function exam_delivery.practice_availability(p_actor_id uuid,p_request jsonb)
returns jsonb language plpgsql stable security definer
set search_path='' set statement_timeout='8s' as $$
declare v_exam text:=exam_delivery.normalize_exam_key(p_request->>'examKey'); v_profile text:=p_request->>'profileId';
  v_purpose text:=p_request->>'purpose'; v_version text; v_policy exam_delivery.practice_policies%rowtype;
  v_available integer:=0; v_eligible integer:=0; v_pbq integer:=0; v_missed integer:=0; v_new integer:=0;
  v_domains jsonb:='{}'::jsonb; v_requested integer; v_profile_count integer; v_time_limit integer;
  v_package_id uuid; v_profile_id uuid; v_fixed boolean; v_full boolean; v_selection_config jsonb;
  v_weak_count integer:=0; v_weak_available integer:=0;
begin
  if p_actor_id is null or v_purpose not in ('self_directed_exam','study_sandbox','targeted_domain','weak_area','pbq_practice')
     or p_request->>'language' not in ('csharp','python','mixed','not_applicable') then
    return jsonb_build_object('ok',false,'code','invalid_request'); end if;
  if not exists(select 1 from public.profiles where id=p_actor_id and status='active') then
    return jsonb_build_object('ok',false,'code','inactive_account'); end if;
  select pv.package_version,pv.id,pp.id,pp.question_count,pp.time_limit_minutes,pp.selection_config
    into v_version,v_package_id,v_profile_id,v_profile_count,v_time_limit,v_selection_config
  from exam_delivery.package_versions pv join exam_delivery.package_profiles pp on pp.package_version_id=pv.id
  where exam_delivery.normalize_exam_key(pv.exam_key)=v_exam and pv.status='published' and pp.profile_key=v_profile
  order by pv.published_at desc limit 1;
  if not found then return jsonb_build_object('ok',false,'code','package_unavailable'); end if;
  if nullif(p_request->>'assignmentId','') is not null then
    perform exam_delivery.validate_practice_assignment(p_actor_id,v_exam,v_profile,(p_request->>'assignmentId')::uuid);
  end if;
  select * into v_policy from exam_delivery.practice_policies where canonical_exam_key=v_exam and package_version=v_version
    and profile_key=v_profile and purpose=v_purpose::exam_delivery.attempt_purpose;
  if not found or not v_policy.enabled or v_policy.access_mode='disabled' then
    return jsonb_build_object('ok',false,'code','practice_unavailable'); end if;
  if not exam_delivery.can_use_profile(p_actor_id,v_package_id,v_profile_id,v_purpose::exam_delivery.attempt_purpose) then
    return jsonb_build_object('ok',false,'code','access_not_granted'); end if;
  if v_policy.maximum_completed_attempts is not null and (select count(*) from exam_delivery.attempts a
    where a.owner_id=p_actor_id and a.package_version_id=v_package_id and a.package_profile_id=v_profile_id
      and a.purpose=v_policy.purpose and a.status='completed')>=v_policy.maximum_completed_attempts then
    return jsonb_build_object('ok',false,'code','attempt_limit_reached'); end if;
  if v_policy.cooldown_seconds>0 and exists(select 1 from exam_delivery.attempts a
    where a.owner_id=p_actor_id and a.package_version_id=v_package_id and a.package_profile_id=v_profile_id
      and a.purpose=v_policy.purpose and a.completed_at>statement_timestamp()-make_interval(secs=>v_policy.cooldown_seconds)) then
    return jsonb_build_object('ok',false,'code','cooldown_active'); end if;
  select count(*) filter(where coalesce((pc.authoring_metadata->>'scored')::boolean,true))::integer,
    count(*) filter(where coalesce((pc.authoring_metadata->>'scored')::boolean,true)
      and (q.question_type like 'pbq-%' or pc.authoring_metadata#>>'{group,role}'='atomic-pbq'))::integer
    into v_available,v_pbq
  from exam_delivery.package_questions q join exam_delivery.package_question_protected_content pc on pc.question_id=q.id
  where q.package_version_id=v_package_id;
  select coalesce(jsonb_object_agg(domain_key,total),'{}'::jsonb) into v_domains from (
    select q.domain_key,count(*) filter(where coalesce((pc.authoring_metadata->>'scored')::boolean,true))::integer total
    from exam_delivery.package_questions q join exam_delivery.package_question_protected_content pc on pc.question_id=q.id
    where q.package_version_id=v_package_id group by q.domain_key) d;
  if v_purpose='targeted_domain' and (nullif(p_request->>'domain','') is null or not (v_domains ? (p_request->>'domain'))) then
    return jsonb_build_object('ok',false,'code','unknown_domain'); end if;
  select count(distinct item->>'questionId')::integer into v_missed
  from exam_delivery.attempts a join exam_delivery.review_snapshots rs on rs.attempt_id=a.id
  cross join lateral jsonb_array_elements(coalesce(rs.review_payload->'items','[]'::jsonb)) item
  join exam_delivery.package_questions reviewed_question on reviewed_question.package_version_id=v_package_id
    and reviewed_question.question_id=item->>'questionId'
  where a.owner_id=p_actor_id and a.package_version_id=v_package_id and a.status='completed' and a.analytics_eligible is true
    and item->>'status' in ('Incorrect','Incomplete','Partial')
    and (v_purpose<>'weak_area' or reviewed_question.domain_key=p_request->>'domain');
  select count(*)::integer into v_new from exam_delivery.package_questions q where q.package_version_id=v_package_id and not exists(
    select 1 from exam_delivery.attempt_items i join exam_delivery.attempts a on a.id=i.attempt_id
    where a.owner_id=p_actor_id and i.package_question_id=q.id);
  v_fixed:=v_purpose='self_directed_exam';
  v_full:=v_purpose in ('study_sandbox','targeted_domain','pbq_practice');
  if v_fixed then
    if (p_request ? 'count' and p_request->>'count'<>v_profile_count::text)
      or v_profile_count>v_available or v_profile_count>v_policy.maximum_session_items then
      return jsonb_build_object('ok',false,'code','invalid_request'); end if;
    v_requested:=v_profile_count; v_eligible:=v_profile_count;
  elsif v_full then
    if p_request ? 'count' then return jsonb_build_object('ok',false,'code','invalid_request'); end if;
    select count(*) filter(where coalesce((pc.authoring_metadata->>'scored')::boolean,true))::integer into v_eligible
    from exam_delivery.package_questions q join exam_delivery.package_question_protected_content pc on pc.question_id=q.id
    where q.package_version_id=v_package_id
      and (v_purpose<>'targeted_domain' or q.domain_key=p_request->>'domain')
      and (v_purpose<>'pbq_practice' or case when p_request->>'contentKind'='case-study'
        then pc.authoring_metadata#>>'{group,role}' in ('context','question')
        else q.question_type like 'pbq-%' or pc.authoring_metadata#>>'{group,role}'='atomic-pbq' end);
    v_requested:=v_eligible;
  else
    if not (p_request ? 'count') or p_request->>'count' not in ('10','20','30','40','all') then
      return jsonb_build_object('ok',false,'code','invalid_request'); end if;
    v_requested:=case when p_request->>'count'='all' then least(v_available,v_policy.maximum_session_items) else (p_request->>'count')::integer end;
    v_eligible:=least(v_requested,v_available,v_policy.maximum_session_items);
  end if;
  if v_purpose='weak_area' then
    select count(*)::integer into v_weak_count
    from exam_delivery.learner_weak_domain_evidence(p_actor_id,v_package_id) evidence
    where evidence.domain_key=p_request->>'domain';
    select count(*) filter(where coalesce((pc.authoring_metadata->>'scored')::boolean,true))::integer into v_weak_available
    from exam_delivery.package_questions q join exam_delivery.package_question_protected_content pc on pc.question_id=q.id
    where q.package_version_id=v_package_id and q.domain_key=p_request->>'domain'
      and (coalesce((p_request->>'includePbqs')::boolean,false) or q.question_type not like 'pbq-%');
    if v_weak_count=0 and v_missed=0 then return jsonb_build_object('ok',false,'code','no_weak_areas'); end if;
    if v_weak_available=0 then return jsonb_build_object('ok',false,'code','weak_domain_unavailable'); end if;
    v_eligible:=least(v_eligible,v_weak_available);
  end if;
  return jsonb_build_object('ok',true,'examKey',v_exam,'packageVersion',v_version,'profileKey',v_profile,'purpose',v_purpose,
    'available',v_available,'selectedCount',v_eligible,'adjustedCount',not v_fixed and not v_full and v_requested>v_eligible,
    'profileQuestionCount',v_profile_count,'timeLimitMinutes',case when v_fixed then v_time_limit else null end,
    'timed',v_fixed,'deliveryMode',case when v_fixed then 'complete' else 'paged' end,
    'fixedProfileSize',v_fixed,'profileComposition',jsonb_build_object(
      'questionCount',v_profile_count,'timeLimitMinutes',v_time_limit,
      'standardQuestionCount',coalesce((v_selection_config->>'standardQuestionCount')::integer,
        (v_selection_config->>'normalScoredQuestionCount')::integer,v_profile_count-coalesce((v_selection_config->>'pbqCount')::integer,0)),
      'caseStudyCount',coalesce((v_selection_config->>'caseStudyCount')::integer,
        coalesce((v_selection_config->>'longCaseStudyCount')::integer,0)+coalesce((v_selection_config->>'shortCaseStudyCount')::integer,0)),
      'pbqCount',coalesce((v_selection_config->>'pbqCount')::integer,0),'sectionOrder',v_selection_config->>'sectionOrder'),
    'domainCounts',v_domains,'missedCount',v_missed,'newCount',v_new,'pbqCount',v_pbq,
    'languages',case when v_exam='az204' and v_version='1.1.0' then '["csharp","python","mixed"]'::jsonb else '["not_applicable"]'::jsonb end);
exception when sqlstate '42501' then
  if nullif(p_request->>'assignmentId','') is not null then return jsonb_build_object('ok',false,'code','assignment_conflict'); end if;
  raise;
end $$;

-- Preserve the reviewed materializer and change only its practice limit gate:
-- NULL now means every eligible atomic unit, never an unbounded client payload.
do $$ declare v_definition text; v_updated text;
begin
  v_definition:=pg_get_functiondef('exam_delivery.materialize_attempt_items(uuid,uuid,integer)'::regprocedure);
  v_updated:=replace(v_definition,'where preceding<p_practice_limit','where p_practice_limit is null or preceding<p_practice_limit');
  if v_updated=v_definition then raise exception 'issue65_materializer_limit_contract_drift'; end if;
  execute v_updated;
end $$;

-- Adapt the existing atomic start implementation without duplicating its
-- authorization and attribution logic. Practice receives no exam deadline,
-- a 30-day inactivity recovery boundary, and NULL materialization limit for
-- full modes. Formal self-directed exams are untouched.
create or replace function exam_delivery.start_practice_issue59_attribution_base(p_actor_id uuid,p_request jsonb)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='15s' as $$
declare v_availability jsonb; v_attempt exam_delivery.attempts%rowtype; v_existing exam_delivery.attempts%rowtype;
  v_package record; v_policy exam_delivery.practice_policies%rowtype; v_request_id uuid; v_configuration jsonb;
  v_now timestamptz:=statement_timestamp(); v_limit integer; v_response_count integer:=0; v_consumed_count integer:=0; v_has_expired boolean:=false;
begin
  begin v_request_id:=(p_request->>'clientRequestId')::uuid;
  exception when invalid_text_representation then return jsonb_build_object('ok',false,'code','invalid_request'); end;
  if p_actor_id is null or v_request_id is null then return jsonb_build_object('ok',false,'code','invalid_request'); end if;
  v_configuration:=p_request-'clientRequestId';
  v_availability:=exam_delivery.practice_availability(p_actor_id,p_request);
  if not coalesce((v_availability->>'ok')::boolean,false) then return v_availability; end if;
  if exam_delivery.classify_actor(p_actor_id) not in ('student','staff') then return jsonb_build_object('ok',false,'code','access_not_granted'); end if;
  if (v_availability->>'examKey'='az204' and v_availability->>'packageVersion'='1.1.0' and p_request->>'language' not in ('csharp','python','mixed'))
    or (not (v_availability->>'examKey'='az204' and v_availability->>'packageVersion'='1.1.0') and p_request->>'language'<>'not_applicable')
  then return jsonb_build_object('ok',false,'code','invalid_request'); end if;
  select pv.id package_version_id,pv.generator_version,pv.scorer_version,pp.id package_profile_id,pp.time_limit_minutes into strict v_package
  from exam_delivery.package_versions pv join exam_delivery.package_profiles pp on pp.package_version_id=pv.id
  where exam_delivery.normalize_exam_key(pv.exam_key)=v_availability->>'examKey' and pv.package_version=v_availability->>'packageVersion'
    and pp.profile_key=v_availability->>'profileKey' and pv.package_schema_version='certsim-protected-package-v2' and pv.status='published'
  for share of pv,pp;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_actor_id::text||':'||v_package.package_version_id::text||':'||
    v_package.package_profile_id::text||':'||(p_request->>'purpose')||':'||(p_request->>'language'),0));
  select * into v_existing from exam_delivery.attempts where owner_id=p_actor_id and client_request_id=v_request_id for update;
  if found then
    if v_existing.purpose=(p_request->>'purpose')::exam_delivery.attempt_purpose and v_existing.practice_configuration=v_configuration
      and v_existing.language_preference=p_request->>'language' and v_existing.package_version_id=v_package.package_version_id
      and v_existing.package_profile_id=v_package.package_profile_id then return exam_delivery.resume_attempt(p_actor_id,v_existing.id); end if;
    return jsonb_build_object('ok',false,'code','attempt_conflict');
  end if;
  select * into v_policy from exam_delivery.practice_policies p where p.canonical_exam_key=v_availability->>'examKey'
    and p.package_version=v_availability->>'packageVersion' and p.profile_key=v_availability->>'profileKey'
    and p.purpose=(p_request->>'purpose')::exam_delivery.attempt_purpose for update;
  if not found or not v_policy.enabled or v_policy.access_mode='disabled' then return jsonb_build_object('ok',false,'code','practice_unavailable'); end if;
  select a.* into v_existing from exam_delivery.attempts a where a.owner_id=p_actor_id
    and a.package_version_id=v_package.package_version_id and a.package_profile_id=v_package.package_profile_id
    and a.purpose=(p_request->>'purpose')::exam_delivery.attempt_purpose and a.language_preference=p_request->>'language'
    and a.status='in_progress' for update of a;
  if found then
    if (
      v_existing.purpose in ('study_sandbox','targeted_domain','weak_area','pbq_practice')
      and v_existing.practice_idle_expires_at>v_now
    ) or (
      v_existing.purpose in ('assigned_assessment','self_directed_exam')
      and v_existing.expires_at>v_now
    ) then
      return exam_delivery.resume_attempt(p_actor_id,v_existing.id);
    end if;
    if v_existing.protected_assignment_id is not null or exists(select 1 from exam_delivery.attempt_results r where r.attempt_id=v_existing.id)
      or exists(select 1 from exam_delivery.review_snapshots r where r.attempt_id=v_existing.id)
    then return jsonb_build_object('ok',false,'code','invalid_lifecycle_transition'); end if;
    select count(*)::integer into v_response_count from exam_delivery.attempt_responses r where r.attempt_id=v_existing.id;
    v_has_expired:=true;
  end if;
  if v_policy.maximum_completed_attempts is not null then
    select count(*)::integer into v_consumed_count from exam_delivery.attempts a
    where a.owner_id=p_actor_id and a.package_version_id=v_package.package_version_id and a.package_profile_id=v_package.package_profile_id
      and a.purpose=v_policy.purpose and (a.status='completed' or (a.status='expired' and exists(
        select 1 from exam_delivery.attempt_responses r where r.attempt_id=a.id)));
    if v_has_expired and v_response_count>0 then v_consumed_count:=v_consumed_count+1; end if;
    if v_consumed_count>=v_policy.maximum_completed_attempts then return jsonb_build_object('ok',false,'code','attempt_limit_reached'); end if;
  end if;
  v_availability:=exam_delivery.practice_availability(p_actor_id,p_request);
  if not coalesce((v_availability->>'ok')::boolean,false) then return v_availability; end if;
  if v_has_expired then
    update exam_delivery.attempts set status='expired' where id=v_existing.id and status='in_progress'
      and (
        (
          v_existing.purpose in ('study_sandbox','targeted_domain','weak_area','pbq_practice')
          and practice_idle_expires_at<=v_now
        ) or (
          v_existing.purpose in ('assigned_assessment','self_directed_exam')
          and expires_at<=v_now
        )
      );
    if not found then return jsonb_build_object('ok',false,'code','attempt_conflict'); end if;
  end if;
  insert into exam_delivery.attempts(owner_id,package_version_id,package_profile_id,protected_assignment_id,client_request_id,status,
    generator_version,scorer_version,created_at,started_at,expires_at,purpose,practice_configuration,language_preference,
    practice_last_activity_at,practice_idle_expires_at)
  values(p_actor_id,v_package.package_version_id,v_package.package_profile_id,null,v_request_id,'in_progress',v_package.generator_version,
    v_package.scorer_version,v_now,v_now,case when p_request->>'purpose'='self_directed_exam'
      then v_now+make_interval(mins=>v_package.time_limit_minutes) else null end,
    (p_request->>'purpose')::exam_delivery.attempt_purpose,v_configuration,p_request->>'language',
    case when p_request->>'purpose'<>'self_directed_exam' then v_now end,
    case when p_request->>'purpose'<>'self_directed_exam' then v_now+interval '30 days' end) returning * into v_attempt;
  v_limit:=case when p_request->>'purpose' in ('study_sandbox','targeted_domain','pbq_practice')
    then null else (v_availability->>'selectedCount')::integer end;
  perform exam_delivery.materialize_attempt_items(v_attempt.id,v_request_id,v_limit);
  if v_has_expired then insert into exam_delivery.practice_attempt_expirations(expired_attempt_id,replacement_attempt_id,owner_id,reason_code,
    response_count,expired_at,replacement_started_at) values(v_existing.id,v_attempt.id,p_actor_id,'practice_window_expired',
    v_response_count,v_now,v_attempt.started_at); end if;
  return exam_delivery.resume_attempt(p_actor_id,v_attempt.id);
exception when no_data_found or too_many_rows then return jsonb_build_object('ok',false,'code','package_unavailable');
when unique_violation then return jsonb_build_object('ok',false,'code','attempt_conflict');
end $$;

create or replace function exam_delivery.authorize_attempt_continuation(p_attempt_id uuid,p_operation text)
returns jsonb language plpgsql stable security definer set search_path='' set statement_timeout='5s' as $$
declare v record; v_assessment jsonb; v_assignment_continuation boolean;
begin
  if p_attempt_id is null or p_operation not in ('resume','save_response','check_item','submit') then return jsonb_build_object('ok',false,'code','invalid_request'); end if;
  select a.owner_id,a.status,a.expires_at,a.practice_idle_expires_at,a.purpose,a.practice_configuration,
    a.language_preference,a.package_version_id,a.package_profile_id,a.source_assignment_id,a.attribution_source,
    pv.exam_key,pv.package_version,pv.package_schema_version,pp.profile_key,policy.access_mode,policy.enabled
  into v from exam_delivery.attempts a join exam_delivery.package_versions pv on pv.id=a.package_version_id
  join exam_delivery.package_profiles pp on pp.id=a.package_profile_id left join exam_delivery.practice_policies policy
    on policy.canonical_exam_key=exam_delivery.normalize_exam_key(pv.exam_key) and policy.package_version=pv.package_version
   and policy.profile_key=pp.profile_key and policy.purpose=a.purpose where a.id=p_attempt_id;
  if not found then return jsonb_build_object('ok',false,'code','attempt_not_found'); end if;
  if v.status<>'in_progress' or (v.purpose in ('assigned_assessment','self_directed_exam') and statement_timestamp()>=v.expires_at)
    or (v.purpose in ('study_sandbox','targeted_domain','weak_area','pbq_practice') and statement_timestamp()>=v.practice_idle_expires_at) then
    return jsonb_build_object('ok',false,'code','invalid_lifecycle_transition'); end if;
  if not exists(select 1 from public.profiles where id=v.owner_id and status='active') then return jsonb_build_object('ok',false,'code','inactive_account'); end if;
  v_assignment_continuation:=v.purpose='self_directed_exam' and v.source_assignment_id is not null and v.attribution_source='assignment';
  if v.purpose='assigned_assessment' then
    if v.package_schema_version='certsim-protected-package-v2' then v_assessment:=exam_delivery.check_assessment_eligibility_v2(v.owner_id,v.exam_key,v.profile_key);
    else v_assessment:=exam_delivery.check_eligibility(v.owner_id,v.exam_key,v.profile_key); end if;
    if not coalesce((v_assessment->>'eligible')::boolean,false) then return jsonb_build_object('ok',false,'code','exam_unavailable'); end if;
  else
    if not coalesce(v.enabled,false) or v.access_mode='disabled' or not exists(select 1 from exam_delivery.exam_profile_activations activation
      where activation.package_version_id=v.package_version_id and activation.package_profile_id=v.package_profile_id
        and activation.activation_kind='production' and activation.enabled) then return jsonb_build_object('ok',false,'code','practice_unavailable'); end if;
    if not v_assignment_continuation and not exam_delivery.can_use_profile(v.owner_id,v.package_version_id,v.package_profile_id,v.purpose) then
      return jsonb_build_object('ok',false,'code','access_not_granted'); end if;
  end if;
  return jsonb_build_object('ok',true,'ownerId',v.owner_id,'examKey',exam_delivery.normalize_exam_key(v.exam_key),
    'profileKey',v.profile_key,'purpose',v.purpose,'operation',p_operation);
end $$;

create function exam_delivery.list_attempt_item_page(p_actor_id uuid,p_attempt_id uuid,p_after_position integer default 0,p_page_size integer default 20)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='8s' as $$
declare v_auth jsonb; v_purpose exam_delivery.attempt_purpose; v_total integer; v_end integer;
begin
  if p_after_position<0 or p_page_size<1 or p_page_size>50 then return jsonb_build_object('ok',false,'code','invalid_request'); end if;
  v_auth:=exam_delivery.authorize_attempt_continuation(p_attempt_id,'resume');
  if not coalesce((v_auth->>'ok')::boolean,false) or (v_auth->>'ownerId')::uuid<>p_actor_id then return jsonb_build_object('ok',false,'code','attempt_not_found'); end if;
  select purpose into strict v_purpose from exam_delivery.attempts where id=p_attempt_id;
  if v_purpose in ('assigned_assessment','self_directed_exam') then return jsonb_build_object('ok',false,'code','invalid_request'); end if;
  select count(*)::integer into v_total from exam_delivery.attempt_items where attempt_id=p_attempt_id;
  select greatest(p_after_position,coalesce(max(i.presented_question_number),p_after_position)) into v_end
  from exam_delivery.attempt_items i join exam_delivery.package_questions q on q.id=i.package_question_id
  join exam_delivery.package_question_protected_content pc on pc.question_id=q.id
  where i.attempt_id=p_attempt_id and i.presented_question_number<=least(v_total,p_after_position+p_page_size)
     or (i.attempt_id=p_attempt_id and pc.authoring_metadata#>>'{group,groupKey}' in (
       select pc2.authoring_metadata#>>'{group,groupKey}' from exam_delivery.attempt_items i2
       join exam_delivery.package_questions q2 on q2.id=i2.package_question_id
       join exam_delivery.package_question_protected_content pc2 on pc2.question_id=q2.id
       where i2.attempt_id=p_attempt_id and i2.presented_question_number between p_after_position+1 and least(v_total,p_after_position+p_page_size)
         and nullif(pc2.authoring_metadata#>>'{group,groupKey}','') is not null));
  update exam_delivery.attempts set practice_last_activity_at=statement_timestamp(),practice_idle_expires_at=statement_timestamp()+interval '30 days'
    where id=p_attempt_id;
  return jsonb_build_object('ok',true,'afterPosition',p_after_position,'returnedThrough',v_end,'totalCount',v_total,
    'hasMore',v_end<v_total,'items',coalesce((select jsonb_agg(jsonb_build_object(
      'itemId',i.id,'questionNumber',case when q.question_type in ('case-study-context','case-study-info','informational') then null else
        (select count(*) from exam_delivery.attempt_items numbered
         join exam_delivery.package_questions numbered_question on numbered_question.id=numbered.package_question_id
         where numbered.attempt_id=i.attempt_id and numbered.presented_question_number<=i.presented_question_number
           and numbered_question.question_type not in ('case-study-context','case-study-info','informational')) end,
      'questionId',q.question_id,'questionType',q.question_type,
      'domain',q.domain_key,'section',q.section_key,'presentation',i.presentation_snapshot,'response',r.response_payload,
      'revision',coalesce(r.revision,0)) order by i.presented_question_number)
      from exam_delivery.attempt_items i join exam_delivery.package_questions q on q.id=i.package_question_id
      left join exam_delivery.attempt_responses r on r.attempt_id=i.attempt_id and r.attempt_item_id=i.id
      where i.attempt_id=p_attempt_id and i.presented_question_number>p_after_position and i.presented_question_number<=v_end),'[]'::jsonb));
end $$;

create or replace function exam_delivery.resume_attempt(p_actor_id uuid,p_attempt_id uuid)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='10s' as $$
declare v record; v_authorization jsonb; v_items jsonb; v_total integer;
begin
  v_authorization:=exam_delivery.authorize_attempt_continuation(p_attempt_id,'resume');
  if not coalesce((v_authorization->>'ok')::boolean,false) then return v_authorization; end if;
  if (v_authorization->>'ownerId')::uuid<>p_actor_id then return jsonb_build_object('ok',false,'code','attempt_not_found'); end if;
  select a.*,pv.exam_key,pv.package_version,pp.profile_key,pp.display_name,pp.time_limit_minutes into v
  from exam_delivery.attempts a join exam_delivery.package_versions pv on pv.id=a.package_version_id
  join exam_delivery.package_profiles pp on pp.id=a.package_profile_id where a.id=p_attempt_id;
  select count(*)::integer into v_total from exam_delivery.attempt_items where attempt_id=v.id;
  if v.purpose in ('study_sandbox','targeted_domain','weak_area','pbq_practice') then
    v_items:=exam_delivery.list_attempt_item_page(p_actor_id,p_attempt_id,0,20);
    if not coalesce((v_items->>'ok')::boolean,false) then return v_items; end if;
  end if;
  return jsonb_build_object('ok',true,'attempt',jsonb_build_object(
    'attemptId',v.id,'assignmentId',v.source_assignment_id,'examKey',v.exam_key,'packageVersion',v.package_version,
    'profileKey',v.profile_key,'profileName',v.display_name,'status',v.status,'startedAt',v.started_at,
    'expiresAt',v.expires_at,'timeLimitMinutes',case when v.expires_at is null then null else v.time_limit_minutes end,
    'timed',v.expires_at is not null,'itemCount',v_total,'purpose',v.purpose,'languagePreference',v.language_preference),
    'items',case when v_items is not null then v_items->'items' else coalesce((select jsonb_agg(jsonb_build_object(
      'itemId',i.id,'questionNumber',i.presented_question_number,'questionId',q.question_id,'questionType',q.question_type,
      'domain',q.domain_key,'section',q.section_key,'presentation',i.presentation_snapshot,'response',r.response_payload,
      'revision',coalesce(r.revision,0)) order by i.presented_question_number) from exam_delivery.attempt_items i
      join exam_delivery.package_questions q on q.id=i.package_question_id left join exam_delivery.attempt_responses r
        on r.attempt_id=i.attempt_id and r.attempt_item_id=i.id where i.attempt_id=v.id),'[]'::jsonb) end,
    'page',case when v_items is null then jsonb_build_object('returnedThrough',v_total,'totalCount',v_total,'hasMore',false)
      else v_items- 'ok' - 'items' end);
end $$;

create or replace function exam_delivery.list_current_attempt_bindings(p_actor_id uuid,p_exam_key text,p_purpose text)
returns jsonb language sql stable security definer set search_path='' set statement_timeout='5s' as $$
select jsonb_build_object('ok',true,'candidates',coalesce(jsonb_agg(jsonb_build_object(
  'attemptId',a.id,'assignmentId',a.source_assignment_id,'examKey',exam_delivery.normalize_exam_key(pv.exam_key),
  'packageVersion',pv.package_version,'profileKey',pp.profile_key,'profileName',pp.display_name,'purpose',a.purpose,
  'languagePreference',a.language_preference,'startedAt',a.started_at,'expiresAt',a.expires_at,'timed',a.expires_at is not null,
  'selectedCount',(select count(*) from exam_delivery.attempt_items i where i.attempt_id=a.id),'fixedProfileSize',a.purpose in ('assigned_assessment','self_directed_exam'),
  'profileComposition',jsonb_build_object('questionCount',pp.question_count,'timeLimitMinutes',pp.time_limit_minutes),
  'replacementPermitted',false) order by a.started_at,a.id),'[]'::jsonb))
from exam_delivery.attempts a join exam_delivery.package_versions pv on pv.id=a.package_version_id
join exam_delivery.package_profiles pp on pp.id=a.package_profile_id
cross join lateral (select exam_delivery.authorize_attempt_continuation(a.id,'resume') authorization) auth
where a.owner_id=p_actor_id and a.status='in_progress'
  and ((a.expires_at is not null and a.expires_at>statement_timestamp()) or (a.expires_at is null and a.practice_idle_expires_at>statement_timestamp()))
  and coalesce((auth.authorization->>'ok')::boolean,false) and (auth.authorization->>'ownerId')::uuid=p_actor_id
  and exam_delivery.normalize_exam_key(pv.exam_key)=exam_delivery.normalize_exam_key(p_exam_key) and a.purpose::text=p_purpose
$$;

create function public.certsim_protected_list_attempt_item_page(p_actor_id uuid,p_attempt_id uuid,p_after_position integer,p_page_size integer)
returns jsonb language sql security invoker set search_path='' as $$
  select exam_delivery.list_attempt_item_page(p_actor_id,p_attempt_id,p_after_position,p_page_size)
$$;

alter function exam_delivery.practice_availability(uuid,jsonb) owner to postgres;
alter function exam_delivery.touch_practice_activity() owner to postgres;
alter function exam_delivery.materialize_attempt_items(uuid,uuid,integer) owner to postgres;
alter function exam_delivery.start_practice_issue59_attribution_base(uuid,jsonb) owner to postgres;
alter function exam_delivery.authorize_attempt_continuation(uuid,text) owner to postgres;
alter function exam_delivery.list_attempt_item_page(uuid,uuid,integer,integer) owner to postgres;
alter function exam_delivery.resume_attempt(uuid,uuid) owner to postgres;
alter function exam_delivery.list_current_attempt_bindings(uuid,text,text) owner to postgres;
alter function public.certsim_protected_list_attempt_item_page(uuid,uuid,integer,integer) owner to postgres;
revoke execute on function exam_delivery.practice_availability(uuid,jsonb),exam_delivery.touch_practice_activity(),exam_delivery.materialize_attempt_items(uuid,uuid,integer),
  exam_delivery.start_practice_issue59_attribution_base(uuid,jsonb),exam_delivery.authorize_attempt_continuation(uuid,text),
  exam_delivery.list_attempt_item_page(uuid,uuid,integer,integer),exam_delivery.resume_attempt(uuid,uuid),
  exam_delivery.list_current_attempt_bindings(uuid,text,text),public.certsim_protected_list_attempt_item_page(uuid,uuid,integer,integer)
from public,anon,authenticated,service_role;
grant execute on function exam_delivery.practice_availability(uuid,jsonb),exam_delivery.list_current_attempt_bindings(uuid,text,text),
  exam_delivery.resume_attempt(uuid,uuid),exam_delivery.list_attempt_item_page(uuid,uuid,integer,integer),
  public.certsim_protected_list_attempt_item_page(uuid,uuid,integer,integer) to service_role;
