-- Issue #83: authoritative versioned live assignments.
-- Legacy rows remain v1 (null contract_version) and are not rewritten.

do $$
begin
  if exists(select 1 from information_schema.columns where table_schema='public' and table_name='exam_assignments' and column_name='contract_version') then
    raise exception 'live_assignment_v2_already_present';
  end if;
end $$;

alter table public.exam_assignments
  add column contract_version text,
  add column package_version_id uuid,
  add column package_profile_id uuid,
  add column maximum_attempts integer,
  add column review_release_policy text,
  add column answer_release_policy text,
  add column creation_request_id uuid;

alter table public.exam_assignments
  add constraint exam_assignments_v2_package_profile_fk foreign key(package_version_id,package_profile_id)
    references exam_delivery.package_profiles(package_version_id,id) on delete restrict,
  add constraint exam_assignments_v2_shape_check check(
    (contract_version is null and package_version_id is null and package_profile_id is null
      and maximum_attempts is null and review_release_policy is null
      and answer_release_policy is null and creation_request_id is null)
    or (contract_version='live-v2' and package_version_id is not null and package_profile_id is not null
      and maximum_attempts between 1 and 100
      and review_release_policy in ('never','after_submission')
      and answer_release_policy in ('never','after_submission')
      and creation_request_id is not null and student_user_id is not null and group_id is null)
  );
create unique index exam_assignments_v2_request_idx on public.exam_assignments(assigned_by,creation_request_id)
  where contract_version='live-v2';
create unique index exam_assignments_v2_active_target_idx
  on public.exam_assignments(student_user_id,package_version_id,package_profile_id)
  where contract_version='live-v2' and status='active';

-- Legacy browser management remains byte-compatible, while v2 creation and
-- mutation are available only through the audited security-definer boundary.
drop policy if exists exam_assignments_insert_scoped on public.exam_assignments;
create policy exam_assignments_insert_scoped on public.exam_assignments for insert to authenticated
with check(contract_version is null and assigned_by=auth.uid() and public.can_manage_exam_assignment_scope(
  organisation_id,campus_id,group_id,student_user_id));
drop policy if exists exam_assignments_update_scoped on public.exam_assignments;
create policy exam_assignments_update_scoped on public.exam_assignments for update to authenticated
using(contract_version is null and public.can_manage_exam_assignment(id))
with check(contract_version is null and public.can_manage_exam_assignment_scope(
  organisation_id,campus_id,group_id,student_user_id));
drop policy if exists exam_assignments_platform_owner_manage on public.exam_assignments;
create policy exam_assignments_platform_owner_manage on public.exam_assignments for all to authenticated
using(contract_version is null and public.is_platform_owner())
with check(contract_version is null and public.is_platform_owner());

alter table exam_delivery.attempts
  add column assignment_review_release_policy text,
  add column assignment_answer_release_policy text;
alter table exam_delivery.attempts add constraint attempts_assignment_release_snapshot_check check(
  (assignment_review_release_policy is null and assignment_answer_release_policy is null)
  or (source_assignment_id is not null and assignment_review_release_policy in ('never','after_submission')
    and assignment_answer_release_policy in ('never','after_submission'))
);

create function exam_delivery.guard_live_assignment_v2_immutability()
returns trigger language plpgsql security definer set search_path='' set statement_timeout='3s' as $$
begin
  if old.contract_version='live-v2' and row(old.contract_version,old.package_version_id,old.package_profile_id,
    old.maximum_attempts,old.review_release_policy,old.answer_release_policy,old.creation_request_id,
    old.student_user_id,old.organisation_id,old.exam_key,old.profile_id)
    is distinct from row(new.contract_version,new.package_version_id,new.package_profile_id,
    new.maximum_attempts,new.review_release_policy,new.answer_release_policy,new.creation_request_id,
    new.student_user_id,new.organisation_id,new.exam_key,new.profile_id)
  then raise exception 'live_assignment_binding_is_immutable' using errcode='55000'; end if;
  return new;
end $$;
create trigger guard_live_assignment_v2_mutation before update on public.exam_assignments
  for each row execute function exam_delivery.guard_live_assignment_v2_immutability();

create function exam_delivery.create_live_assignment_v2(p_request jsonb)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='10s' as $$
declare v_actor uuid:=auth.uid(); v_target uuid; v_org uuid; v_request uuid; v_version uuid; v_profile uuid;
  v_exam text; v_package_version text; v_profile_key text; v_review text; v_answer text; v_max integer;
  v_package record; v_existing public.exam_assignments%rowtype; v_created public.exam_assignments%rowtype; v_catalog uuid;
begin
  if v_actor is null or jsonb_typeof(p_request)<>'object' then raise exception 'live_assignment_auth_required' using errcode='42501'; end if;
  if not exam_delivery.json_has_exact_keys(p_request,array['targetUserId','organisationId','examKey','packageVersion','profileKey','maximumAttempts','reviewReleasePolicy','answerReleasePolicy','requestId']) then
    raise exception 'live_assignment_invalid_request' using errcode='22023'; end if;
  begin
    v_target:=(p_request->>'targetUserId')::uuid; v_org:=(p_request->>'organisationId')::uuid;
    v_request:=(p_request->>'requestId')::uuid; v_max:=(p_request->>'maximumAttempts')::integer;
  exception when others then raise exception 'live_assignment_invalid_request' using errcode='22023'; end;
  v_exam:=exam_delivery.normalize_exam_key(p_request->>'examKey'); v_package_version:=p_request->>'packageVersion';
  v_profile_key:=p_request->>'profileKey'; v_review:=p_request->>'reviewReleasePolicy'; v_answer:=p_request->>'answerReleasePolicy';
  if v_max not between 1 and 100 or v_review not in ('never','after_submission') or v_answer not in ('never','after_submission') then
    raise exception 'live_assignment_invalid_policy' using errcode='22023'; end if;
  if not exists(select 1 from public.memberships where user_id=v_actor and organisation_id=v_org and role='platform_owner' and status='active')
    or not exists(select 1 from public.profiles where id=v_target and status='active') then
    raise exception 'live_assignment_forbidden' using errcode='42501'; end if;
  select pv.id version_id,pp.id profile_id,pv.exam_key,pv.package_version,pv.declared_review_release_policy,
    pv.declared_answer_release_policy,pv.generator_version,pv.scorer_version into strict v_package
  from exam_delivery.package_versions pv join exam_delivery.package_profiles pp on pp.package_version_id=pv.id
  where exam_delivery.normalize_exam_key(pv.exam_key)=v_exam and pv.package_version=v_package_version
    and pp.profile_key=v_profile_key and pv.status='published' and pv.package_schema_version='certsim-protected-package-v2'
    and exam_delivery.package_v2_runtime_supported(pv.generator_version,pv.scorer_version) for share of pv,pp;
  if (v_review='after_submission' and v_package.declared_review_release_policy<>'after_submission')
    or (v_answer='after_submission' and v_package.declared_answer_release_policy<>'after_submission') then
    raise exception 'live_assignment_exceeds_package_policy' using errcode='22023'; end if;
  select * into v_existing from public.exam_assignments where assigned_by=v_actor and creation_request_id=v_request and contract_version='live-v2';
  if found then
    if row(v_existing.student_user_id,v_existing.organisation_id,v_existing.package_version_id,v_existing.package_profile_id,
      v_existing.maximum_attempts,v_existing.review_release_policy,v_existing.answer_release_policy)
      is distinct from row(v_target,v_org,v_package.version_id,v_package.profile_id,v_max,v_review,v_answer) then
      raise exception 'live_assignment_request_conflict' using errcode='23505'; end if;
    return jsonb_build_object('ok',true,'created',false,'assignmentId',v_existing.id,'examKey',v_exam,
      'packageVersion',v_package_version,'profileKey',v_profile_key,'maximumAttempts',v_max,
      'reviewReleasePolicy',v_review,'answerReleasePolicy',v_answer);
  end if;
  select id into v_catalog from public.exam_catalog where exam_delivery.normalize_exam_key(exam_key)=v_exam and status='active' order by created_at limit 1;
  insert into public.exam_assignments(organisation_id,student_user_id,exam_catalog_id,exam_key,profile_id,title,
    assigned_by,assignment_type,status,available_from,due_at,contract_version,package_version_id,package_profile_id,
    maximum_attempts,review_release_policy,answer_release_policy,creation_request_id)
  values(v_org,v_target,v_catalog,v_exam,v_profile_key,upper(v_exam)||' assigned assessment',v_actor,'assessment','active',statement_timestamp(),null,
    'live-v2',v_package.version_id,v_package.profile_id,v_max,v_review,v_answer,v_request) returning * into v_created;
  insert into exam_delivery.exam_entitlements(package_version_id,package_profile_id,target_type,learner_id,enabled,
    valid_from,valid_until,reason_code,created_by,entitlement_source,source_assignment_id)
  values(v_package.version_id,v_package.profile_id,'learner',v_target,true,v_created.available_from,null,'assignment_sync',v_actor,'assignment',v_created.id)
  on conflict(source_assignment_id,package_version_id,package_profile_id) where source_assignment_id is not null
  do update set enabled=true,learner_id=excluded.learner_id,valid_from=excluded.valid_from,valid_until=null,
    revoked_at=null,revoked_by=null,updated_at=statement_timestamp();
  return jsonb_build_object('ok',true,'created',true,'assignmentId',v_created.id,'examKey',v_exam,
    'packageVersion',v_package_version,'profileKey',v_profile_key,'maximumAttempts',v_max,
    'reviewReleasePolicy',v_review,'answerReleasePolicy',v_answer);
exception
  when no_data_found or too_many_rows then
    raise exception 'live_assignment_package_invalid' using errcode='22023';
  when unique_violation then
    select * into v_existing from public.exam_assignments
      where assigned_by=v_actor and creation_request_id=v_request and contract_version='live-v2';
    if found and row(v_existing.student_user_id,v_existing.organisation_id,v_existing.package_version_id,
      v_existing.package_profile_id,v_existing.maximum_attempts,v_existing.review_release_policy,
      v_existing.answer_release_policy)
      is not distinct from row(v_target,v_org,v_package.version_id,v_package.profile_id,v_max,v_review,v_answer) then
      return jsonb_build_object('ok',true,'created',false,'assignmentId',v_existing.id,'examKey',v_exam,
        'packageVersion',v_package_version,'profileKey',v_profile_key,'maximumAttempts',v_max,
        'reviewReleasePolicy',v_review,'answerReleasePolicy',v_answer);
    end if;
    raise exception 'live_assignment_active_conflict' using errcode='23505';
end $$;

create or replace function exam_delivery.check_practice_item(p_actor_id uuid,p_attempt_id uuid,p_item_id uuid,p_expected_revision integer,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='5s' as $$
declare v record; v_score jsonb; v_release exam_delivery.practice_feedback_releases%rowtype; v_authorization jsonb;
begin
  v_authorization:=exam_delivery.authorize_attempt_continuation(p_attempt_id,'check_item');
  if not coalesce((v_authorization->>'ok')::boolean,false) then return v_authorization; end if;
  if (v_authorization->>'ownerId')::uuid<>p_actor_id then return jsonb_build_object('ok',false,'code','attempt_not_found'); end if;
  select a.purpose,a.status,a.scorer_version,r.revision,r.response_payload,q.question_type,i.presentation_snapshot,
    pc.scoring_snapshot,pc.review_snapshot,p.immediate_feedback into v
  from exam_delivery.attempts a join exam_delivery.attempt_items i on i.attempt_id=a.id
  join exam_delivery.attempt_responses r on r.attempt_id=a.id and r.attempt_item_id=i.id
  join exam_delivery.package_questions q on q.id=i.package_question_id
  join exam_delivery.attempt_item_protected_content pc on pc.attempt_item_id=i.id
  join exam_delivery.package_versions pv on pv.id=a.package_version_id
  join exam_delivery.package_profiles pp on pp.id=a.package_profile_id
  join exam_delivery.practice_policies p on p.canonical_exam_key=exam_delivery.normalize_exam_key(pv.exam_key)
    and p.package_version=pv.package_version and p.profile_key=pp.profile_key and p.purpose=a.purpose
  where a.id=p_attempt_id and a.source_assignment_id is null and i.id=p_item_id for update of a;
  if not found then return jsonb_build_object('ok',false,'code','review_unavailable'); end if;
  if v.status<>'in_progress' or not v.immediate_feedback then return jsonb_build_object('ok',false,'code','review_unavailable'); end if;
  if v.revision<>p_expected_revision then return jsonb_build_object('ok',false,'code','stale_response'); end if;
  insert into exam_delivery.practice_feedback_releases(attempt_id,attempt_item_id,response_revision,request_id)
    values(p_attempt_id,p_item_id,p_expected_revision,p_request_id)
    on conflict(attempt_id,attempt_item_id,response_revision) do update
      set request_id=exam_delivery.practice_feedback_releases.request_id returning * into v_release;
  v_score:=exam_delivery.score_package_v2_response_for_scorer(v.scorer_version,v.question_type,
    v.presentation_snapshot,v.scoring_snapshot,v.response_payload,true);
  return jsonb_build_object('ok',true,'itemId',p_item_id,'revision',p_expected_revision,'status',v_score->>'status',
    'earnedPoints',(v_score->>'earned')::numeric,'maxPoints',(v_score->>'maximum')::numeric,
    'review',v.review_snapshot,'releasedAt',v_release.released_at);
end $$;

create function public.certsim_create_live_assignment_v2(p_request jsonb)
returns jsonb language sql security invoker set search_path='' as $$
  select exam_delivery.create_live_assignment_v2(p_request)
$$;

create or replace function exam_delivery.start_assignment_attempt(
  p_actor_id uuid,p_exam_key text,p_profile_key text,p_request_id uuid,p_assignment_id uuid
) returns jsonb language plpgsql security definer set search_path='' set statement_timeout='15s' as $$
declare v_key text:=exam_delivery.normalize_exam_key(p_exam_key); v_now timestamptz:=statement_timestamp();
  v_existing exam_delivery.attempts%rowtype; v_assignment public.exam_assignments%rowtype; v_package record;
  v_attempt exam_delivery.attempts%rowtype; v_count integer;
begin
  if p_actor_id is null or p_request_id is null or p_assignment_id is null then return jsonb_build_object('ok',false,'code','invalid_request'); end if;
  select * into v_existing from exam_delivery.attempts where owner_id=p_actor_id and client_request_id=p_request_id;
  if found then
    if v_existing.source_assignment_id=p_assignment_id then return exam_delivery.resume_attempt(p_actor_id,v_existing.id); end if;
    return jsonb_build_object('ok',false,'code','attempt_conflict');
  end if;
  select * into v_assignment from public.exam_assignments a where a.id=p_assignment_id and a.status='active'
    and (a.available_from is null or a.available_from<=v_now) and (a.due_at is null or a.due_at>v_now) for update;
  if not found or exam_delivery.normalize_exam_key(v_assignment.exam_key)<>v_key
    or nullif(v_assignment.profile_id,'') is null or v_assignment.profile_id<>p_profile_key then
    return jsonb_build_object('ok',false,'code','assignment_conflict'); end if;
  if v_assignment.student_user_id<>p_actor_id then return jsonb_build_object('ok',false,'code','not_assigned'); end if;
  if not coalesce((exam_delivery.check_eligibility_v2(p_actor_id,p_exam_key,p_profile_key)->>'eligible')::boolean,false) then
    return jsonb_build_object('ok',false,'code',exam_delivery.check_eligibility_v2(p_actor_id,p_exam_key,p_profile_key)->>'reasonCode'); end if;
  if v_assignment.contract_version='live-v2' then
    select pv.id package_version_id,pv.generator_version,pv.scorer_version,pp.id package_profile_id,pp.time_limit_minutes
      into strict v_package from exam_delivery.package_versions pv join exam_delivery.package_profiles pp
      on pp.package_version_id=pv.id and pp.id=v_assignment.package_profile_id
      where pv.id=v_assignment.package_version_id and pv.status='published' for share of pv,pp;
    select count(*) into v_count from exam_delivery.attempts where source_assignment_id=v_assignment.id and status<>'voided';
    if v_count>=v_assignment.maximum_attempts then return jsonb_build_object('ok',false,'code','assignment_attempt_limit_reached'); end if;
  else
    select pv.id package_version_id,pv.generator_version,pv.scorer_version,pp.id package_profile_id,pp.time_limit_minutes
      into strict v_package from exam_delivery.resolve_package_profile_default(v_key,p_profile_key,'assigned_assessment') d
      join exam_delivery.package_versions pv on pv.id=d.package_version_id
      join exam_delivery.package_profiles pp on pp.id=d.package_profile_id for share of pv,pp;
  end if;
  insert into exam_delivery.attempts(owner_id,package_version_id,package_profile_id,protected_assignment_id,client_request_id,
    status,generator_version,scorer_version,created_at,started_at,expires_at,purpose,source_assignment_id,
    source_organisation_id,source_campus_id,source_group_id,attribution_source,
    assignment_review_release_policy,assignment_answer_release_policy)
  values(p_actor_id,v_package.package_version_id,v_package.package_profile_id,null,p_request_id,'in_progress',
    v_package.generator_version,v_package.scorer_version,v_now,v_now,v_now+make_interval(mins=>v_package.time_limit_minutes),
    'assigned_assessment',v_assignment.id,v_assignment.organisation_id,v_assignment.campus_id,v_assignment.group_id,'assignment',
    case when v_assignment.contract_version='live-v2' then v_assignment.review_release_policy end,
    case when v_assignment.contract_version='live-v2' then v_assignment.answer_release_policy end) returning * into v_attempt;
  perform exam_delivery.materialize_attempt_items(v_attempt.id,p_request_id,null);
  return exam_delivery.resume_attempt(p_actor_id,v_attempt.id);
exception when no_data_found or too_many_rows then return jsonb_build_object('ok',false,'code','package_unavailable');
when unique_violation then
  select * into v_existing from exam_delivery.attempts where owner_id=p_actor_id and client_request_id=p_request_id;
  if found and v_existing.source_assignment_id=p_assignment_id then return exam_delivery.resume_attempt(p_actor_id,v_existing.id); end if;
  return jsonb_build_object('ok',false,'code','attempt_conflict');
end $$;

create or replace function exam_delivery.submit_attempt_v2(p_actor_id uuid,p_attempt_id uuid,p_submission_id uuid)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='15s' as $$
declare v_authorization jsonb; v_result jsonb; v_existing uuid; v_release boolean:=false;
begin
  select r.submission_id into v_existing from exam_delivery.attempt_results r join exam_delivery.attempts a on a.id=r.attempt_id
    where r.attempt_id=p_attempt_id and a.owner_id=p_actor_id;
  if found then
    if v_existing=p_submission_id then return exam_delivery.get_result(p_actor_id,p_attempt_id); end if;
    return jsonb_build_object('ok',false,'code','submission_conflict'); end if;
  v_authorization:=exam_delivery.authorize_attempt_continuation(p_attempt_id,'submit');
  if not coalesce((v_authorization->>'ok')::boolean,false) then return v_authorization; end if;
  if (v_authorization->>'ownerId')::uuid<>p_actor_id then return jsonb_build_object('ok',false,'code','attempt_not_found'); end if;
  perform set_config('certsim.attempt_continuation_id',p_attempt_id::text,true);
  perform set_config('certsim.attempt_continuation_operation','submit',true);
  v_result:=exam_delivery.submit_attempt_v2_with_assessment_gate(p_actor_id,p_attempt_id,p_submission_id);
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
end $$;

create or replace function exam_delivery.get_review(p_actor_id uuid,p_attempt_id uuid)
returns jsonb language sql stable security definer set search_path='' set statement_timeout='5s' as $$
  select case
    when not exists(select 1 from exam_delivery.attempts a where a.id=p_attempt_id and a.owner_id=p_actor_id and a.status='completed')
      then jsonb_build_object('ok',false,'code','attempt_not_found')
    when not exists(select 1 from exam_delivery.review_snapshots r join exam_delivery.attempts a on a.id=r.attempt_id
      where r.attempt_id=p_attempt_id and a.owner_id=p_actor_id and r.release_status='released'
        and ((a.source_assignment_id is not null and a.assignment_review_release_policy='after_submission')
          or a.source_assignment_id is null))
      then jsonb_build_object('ok',false,'code','review_unavailable')
    else (select jsonb_build_object('ok',true,'review',
      case when a.source_assignment_id is not null and a.assignment_answer_release_policy='never'
        then jsonb_set(r.review_payload,'{items}',coalesce((select jsonb_agg(item.value-'correctAnswer')
          from jsonb_array_elements(coalesce(r.review_payload->'items','[]'::jsonb)) item),'[]'::jsonb),false)
        else r.review_payload end)
      from exam_delivery.review_snapshots r join exam_delivery.attempts a on a.id=r.attempt_id
      where r.attempt_id=p_attempt_id)
  end
$$;

alter function exam_delivery.guard_live_assignment_v2_immutability() owner to postgres;
alter function exam_delivery.create_live_assignment_v2(jsonb) owner to postgres;
alter function public.certsim_create_live_assignment_v2(jsonb) owner to postgres;
alter function exam_delivery.start_assignment_attempt(uuid,text,text,uuid,uuid) owner to postgres;
alter function exam_delivery.check_practice_item(uuid,uuid,uuid,integer,uuid) owner to postgres;
alter function exam_delivery.submit_attempt_v2(uuid,uuid,uuid) owner to postgres;
alter function exam_delivery.get_review(uuid,uuid) owner to postgres;

revoke execute on function exam_delivery.guard_live_assignment_v2_immutability(),exam_delivery.create_live_assignment_v2(jsonb),
  public.certsim_create_live_assignment_v2(jsonb),exam_delivery.start_assignment_attempt(uuid,text,text,uuid,uuid),
  exam_delivery.check_practice_item(uuid,uuid,uuid,integer,uuid),exam_delivery.submit_attempt_v2(uuid,uuid,uuid),
  exam_delivery.get_review(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.certsim_create_live_assignment_v2(jsonb) to authenticated;
grant execute on function exam_delivery.start_assignment_attempt(uuid,text,text,uuid,uuid),
  exam_delivery.check_practice_item(uuid,uuid,uuid,integer,uuid),
  exam_delivery.get_review(uuid,uuid) to service_role;
