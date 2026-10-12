-- Issue #201 database foundation. Inert: no schedule, enrolment or backfill.
begin;

create table exam_delivery.expiry_activation (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false
);
insert into exam_delivery.expiry_activation values (true,false);

create table exam_delivery.expiry_authority (
  attempt_id uuid primary key references exam_delivery.attempts(id) on delete restrict,
  version integer not null default 1 check (version=1),
  owner_id uuid not null,
  deadline timestamptz not null,
  identity jsonb not null,
  continuation jsonb not null,
  selection_config jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);
create table exam_delivery.expiry_bindings (
  attempt_id uuid primary key references exam_delivery.expiry_authority(attempt_id),
  submission_id uuid not null unique,
  reason text not null check (reason in ('manual','time_limit_expiry')),
  effective_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp()
);
create table exam_delivery.expiry_processing (
  attempt_id uuid primary key references exam_delivery.expiry_authority(attempt_id),
  state text not null default 'pending' check (state in ('pending','claimed','retry','unsupported','completed')),
  generation integer not null default 0 check (generation between 0 and 5),
  lease_token uuid,
  lease_until timestamptz,
  completed_at timestamptz,
  check ((state='claimed')=(lease_token is not null and lease_until is not null)),
  check ((state='completed')=(completed_at is not null))
);
create table exam_delivery.expiry_events (
  id bigint generated always as identity primary key,
  attempt_id uuid not null references exam_delivery.expiry_authority(attempt_id),
  event text not null check (event in ('enrolled','bound','claimed','retry','unsupported','completed')),
  generation integer not null default 0,
  occurred_at timestamptz not null default clock_timestamp()
);
create index expiry_processing_pending on exam_delivery.expiry_processing(state,attempt_id)
  where state in ('pending','claimed','retry');

create trigger expiry_authority_immutable before update or delete on exam_delivery.expiry_authority
  for each row execute function exam_delivery.examops_guard_append_only();
create trigger expiry_bindings_immutable before update or delete on exam_delivery.expiry_bindings
  for each row execute function exam_delivery.examops_guard_append_only();
create trigger expiry_events_append_only before update or delete on exam_delivery.expiry_events
  for each row execute function exam_delivery.examops_guard_append_only();

-- Activation is DBA-only, future inserts only. No existing-attempt enrol RPC.
create function exam_delivery.set_expiry_enrolment(p_enabled boolean) returns void
language sql security definer set search_path='' as $$
  update exam_delivery.expiry_activation set enabled=p_enabled where singleton
$$;

create function exam_delivery.expiry_identity(p_attempt exam_delivery.attempts) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('owner',p_attempt.owner_id,'purpose',p_attempt.purpose,
    'deadline',p_attempt.expires_at,'package',p_attempt.package_version_id,
    'profile',p_attempt.package_profile_id,'form',p_attempt.canonical_form_id,
    'cycle',p_attempt.canonical_form_cycle,'runtime',p_attempt.generator_version,
    'scorer',p_attempt.scorer_version,'assignment',p_attempt.source_assignment_id,
    'protectedAssignment',p_attempt.protected_assignment_id,'attribution',p_attempt.attribution_source,
    'organisation',p_attempt.source_organisation_id,'campus',p_attempt.source_campus_id,
    'group',p_attempt.source_group_id,
    'assignmentReview',p_attempt.assignment_review_release_policy,
    'assignmentAnswers',p_attempt.assignment_answer_release_policy,
    'language',p_attempt.language_preference,'practice',p_attempt.practice_configuration)
$$;

create function exam_delivery.enrol_new_expiry_attempt() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if not (select enabled from exam_delivery.expiry_activation where singleton)
    or new.purpose not in ('assigned_assessment','self_directed_exam') then return new; end if;
  -- Legacy packages retain their established lifecycle even after future activation.
  if not exists(select 1 from exam_delivery.package_versions where id=new.package_version_id
    and package_schema_version='certsim-protected-package-v2') then return new; end if;
  if new.status<>'in_progress' or new.expires_at<=clock_timestamp() then
    raise exception 'expiry_new_attempt_required';
  end if;
  insert into exam_delivery.expiry_authority(attempt_id,owner_id,deadline,identity,continuation,selection_config)
  select new.id,new.owner_id,new.expires_at,exam_delivery.expiry_identity(new),to_jsonb(c),pp.selection_config
  from exam_delivery.attempt_continuation_contracts c
  join exam_delivery.package_profiles pp on pp.id=new.package_profile_id
  join exam_delivery.package_versions pv on pv.id=new.package_version_id
  where c.attempt_id=new.id and c.expiry_mode='timed'
    and pv.package_schema_version='certsim-protected-package-v2';
  if not found then raise exception 'expiry_frozen_authority_required'; end if;
  insert into exam_delivery.expiry_processing(attempt_id) values(new.id);
  insert into exam_delivery.expiry_events(attempt_id,event) values(new.id,'enrolled');
  return new;
end $$;
-- Alphabetically after create_attempt_continuation_contract_after_insert.
create trigger z_enrol_new_expiry_attempt after insert on exam_delivery.attempts
  for each row execute function exam_delivery.enrol_new_expiry_attempt();

create function exam_delivery.guard_expiry_attempt() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if exists(select 1 from exam_delivery.expiry_authority c where c.attempt_id=old.id) then
    if exam_delivery.expiry_identity(new) is distinct from exam_delivery.expiry_identity(old) then
      raise exception 'expiry_authority_immutable' using errcode='42501';
    end if;
    -- Lazy reconciliation cannot strand an enrolled formal attempt.
    if old.status='in_progress' and new.status='expired' then return null; end if;
  end if;
  return new;
end $$;
create trigger guard_expiry_attempt before update on exam_delivery.attempts
  for each row execute function exam_delivery.guard_expiry_attempt();

-- Row lock first, then legacy per-submission/item locks, then processing rows.
create function exam_delivery.lock_expiry_attempt(p_attempt_id uuid,p_actor_id uuid) returns boolean
language plpgsql security definer set search_path='' as $$
begin
  if not exists(select 1 from exam_delivery.expiry_authority where attempt_id=p_attempt_id) then return false; end if;
  perform 1 from exam_delivery.attempts where id=p_attempt_id
    and (p_actor_id is null or owner_id=p_actor_id) for update;
  if not found then raise exception 'attempt_not_found' using errcode='42501'; end if;
  return true;
end $$;

create function exam_delivery.bind_expiry_submission(p_attempt_id uuid,p_submission_id uuid,p_reason text,p_effective_at timestamptz)
returns void language plpgsql security definer set search_path='' as $$
declare v exam_delivery.expiry_bindings%rowtype;
begin
  select * into v from exam_delivery.expiry_bindings where attempt_id=p_attempt_id;
  if found then
    if v.submission_id<>p_submission_id then raise exception 'submission_conflict' using errcode='23505'; end if;
    return;
  end if;
  insert into exam_delivery.expiry_bindings values(p_attempt_id,p_submission_id,p_reason,p_effective_at,clock_timestamp());
  insert into exam_delivery.expiry_events(attempt_id,event) values(p_attempt_id,'bound');
end $$;

alter function exam_delivery.save_response(uuid,uuid,uuid,jsonb,integer,uuid) rename to save_response_before_expiry_foundation;
create function exam_delivery.save_response(p_actor_id uuid,p_attempt_id uuid,p_item_id uuid,p_response jsonb,p_expected_revision integer,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='10s' as $$
declare v_time timestamptz;
begin
  if exam_delivery.lock_expiry_attempt(p_attempt_id,p_actor_id) then
    v_time:=clock_timestamp();
    if exists(select 1 from exam_delivery.expiry_authority where attempt_id=p_attempt_id and deadline<=v_time)
      or exists(select 1 from exam_delivery.expiry_bindings where attempt_id=p_attempt_id) then
      return jsonb_build_object('ok',false,'code','invalid_lifecycle_transition');
    end if;
  end if;
  return exam_delivery.save_response_before_expiry_foundation(p_actor_id,p_attempt_id,p_item_id,p_response,p_expected_revision,p_request_id);
end $$;

alter function exam_delivery.save_python_workspace(uuid,uuid,uuid,jsonb,integer,uuid) rename to save_python_workspace_before_expiry_foundation;
create function exam_delivery.save_python_workspace(p_actor_id uuid,p_attempt_id uuid,p_item_id uuid,p_workspace jsonb,p_expected_revision integer,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='10s' as $$
begin
  if exam_delivery.lock_expiry_attempt(p_attempt_id,p_actor_id) and (
    exists(select 1 from exam_delivery.expiry_authority where attempt_id=p_attempt_id and deadline<=clock_timestamp())
    or exists(select 1 from exam_delivery.expiry_bindings where attempt_id=p_attempt_id)
  ) then return jsonb_build_object('ok',false,'code','invalid_lifecycle_transition'); end if;
  return exam_delivery.save_python_workspace_before_expiry_foundation(p_actor_id,p_attempt_id,p_item_id,p_workspace,p_expected_revision,p_request_id);
end $$;

create function exam_delivery.claim_expiry(p_attempt_id uuid) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='10s' as $$
declare a exam_delivery.attempts%rowtype; s exam_delivery.expiry_processing%rowtype; v_time timestamptz; v_token uuid;
begin
  if not exam_delivery.lock_expiry_attempt(p_attempt_id,null) then return jsonb_build_object('ok',false,'code','not_enrolled'); end if;
  v_time:=clock_timestamp();
  select * into a from exam_delivery.attempts where id=p_attempt_id;
  if exists(select 1 from exam_delivery.attempt_results where attempt_id=p_attempt_id) then
    return jsonb_build_object('ok',true,'completed',true);
  end if;
  if a.status<>'in_progress' or a.expires_at>v_time then return jsonb_build_object('ok',false,'code','not_due'); end if;
  select * into s from exam_delivery.expiry_processing where attempt_id=p_attempt_id for update;
  if s.state in ('unsupported','completed') or s.generation>=5 then return jsonb_build_object('ok',false,'code','claim_exhausted'); end if;
  if s.state='claimed' and s.lease_until>v_time then return jsonb_build_object('ok',false,'code','lease_active'); end if;
  v_token:=gen_random_uuid();
  update exam_delivery.expiry_processing set state='claimed',generation=generation+1,lease_token=v_token,lease_until=v_time+interval '30 seconds' where attempt_id=p_attempt_id;
  insert into exam_delivery.expiry_events(attempt_id,event,generation) values(p_attempt_id,'claimed',s.generation+1);
  return jsonb_build_object('ok',true,'leaseToken',v_token,'generation',s.generation+1);
end $$;

create function exam_delivery.retry_expiry(p_attempt_id uuid,p_lease_token uuid) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='10s' as $$
begin
  if not exam_delivery.lock_expiry_attempt(p_attempt_id,null) then return jsonb_build_object('ok',false,'code','not_enrolled'); end if;
  update exam_delivery.expiry_processing set state='retry',lease_token=null,lease_until=null
  where attempt_id=p_attempt_id and state='claimed' and lease_token=p_lease_token and lease_until>clock_timestamp();
  if not found then return jsonb_build_object('ok',false,'code','stale_lease'); end if;
  insert into exam_delivery.expiry_events(attempt_id,event,generation) select attempt_id,'retry',generation from exam_delivery.expiry_processing where attempt_id=p_attempt_id;
  return jsonb_build_object('ok',true);
end $$;

create function exam_delivery.guard_expiry_processing() returns trigger
language plpgsql set search_path='' as $$
begin
  if tg_op='DELETE' or new.attempt_id<>old.attempt_id or old.state='completed'
    or not ((new.state='claimed' and old.state in ('pending','retry','claimed') and new.generation=old.generation+1)
      or (old.state='claimed' and new.state in ('retry','unsupported','completed') and new.generation=old.generation)
      or (new.state='completed' and old.state in ('pending','retry','unsupported') and new.generation=old.generation)) then
    raise exception 'expiry_processing_transition_denied' using errcode='42501';
  end if;
  return new;
end $$;
create trigger guard_expiry_processing before update or delete on exam_delivery.expiry_processing
  for each row execute function exam_delivery.guard_expiry_processing();

-- Reuses migration-61 scoring/projection rules; frozen selection replaces current defaults.
create function exam_delivery.score_expiry_non_executable(
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
  v_attempt record; v_existing exam_delivery.attempt_results%rowtype; v_now timestamptz:=clock_timestamp();
  v_response_hash text; v_raw numeric; v_max numeric; v_percentage numeric; v_scaled integer; v_pass_mark integer; v_passed boolean;
  v_domain jsonb; v_summary jsonb; v_review jsonb; v_catalog_id uuid;
begin
  if p_actor_id is null or p_submission_id is null then return jsonb_build_object('ok',false,'code','invalid_request'); end if;
  select a.*,pv.exam_key,pv.package_version,pv.package_schema_version,pp.profile_key,pp.time_limit_minutes,authority.selection_config
    into v_attempt from exam_delivery.attempts a join exam_delivery.package_versions pv on pv.id=a.package_version_id join exam_delivery.package_profiles pp on pp.id=a.package_profile_id join exam_delivery.expiry_authority authority on authority.attempt_id=a.id
    where a.id=p_attempt_id and a.owner_id=p_actor_id for update of a;
  if not found then return jsonb_build_object('ok',false,'code','attempt_not_found'); end if;
  select * into v_existing from exam_delivery.attempt_results where attempt_id=p_attempt_id;
  if found then if v_existing.submission_id=p_submission_id then return exam_delivery.get_result(p_actor_id,p_attempt_id); end if; return jsonb_build_object('ok',false,'code','submission_conflict'); end if;
  if v_attempt.status<>'in_progress' then return jsonb_build_object('ok',false,'code','invalid_lifecycle_transition'); end if;
  if not exists(select 1 from exam_delivery.expiry_bindings where attempt_id=p_attempt_id and submission_id=p_submission_id)
    or exists(select 1 from exam_delivery.attempt_items i join exam_delivery.package_questions q on q.id=i.package_question_id where i.attempt_id=p_attempt_id and q.question_type='executable-python-lab-v1') then
    return jsonb_build_object('ok',false,'code','executable_finalization_unsupported');
  end if;
  select encode(extensions.digest(convert_to(coalesce(jsonb_agg(jsonb_build_object('itemId',i.id,'response',r.response_payload) order by i.id)::text,'[]'),'UTF8'),'sha256'),'hex') into v_response_hash
    from exam_delivery.attempt_items i left join exam_delivery.attempt_responses r on r.attempt_id=i.attempt_id and r.attempt_item_id=i.id where i.attempt_id=p_attempt_id;
  with scored as (
    select q.domain_key,coalesce(r.response_payload,'{}'::jsonb) response,
      exam_delivery.score_package_v2_response_for_scorer(v_attempt.scorer_version,q.question_type,i.presentation_snapshot,pc.scoring_snapshot,coalesce(r.response_payload,'{}'::jsonb),coalesce((meta.authoring_metadata->>'scored')::boolean,true)) score
    from exam_delivery.attempt_items i join exam_delivery.package_questions q on q.id=i.package_question_id
    join exam_delivery.package_question_protected_content meta on meta.question_id=q.id
    join exam_delivery.attempt_item_protected_content pc on pc.attempt_item_id=i.id
    left join exam_delivery.attempt_responses r on r.attempt_item_id=i.id where i.attempt_id=p_attempt_id
  ) select coalesce(sum((score->>'earned')::numeric),0),coalesce(sum((score->>'maximum')::numeric),0) into v_raw,v_max from scored;
  if v_max<=0 then raise exception 'scoring_contract_invalid' using errcode='22023'; end if;
  with scored as (
    select q.domain_key,exam_delivery.score_package_v2_response_for_scorer(v_attempt.scorer_version,q.question_type,i.presentation_snapshot,pc.scoring_snapshot,coalesce(r.response_payload,'{}'::jsonb),coalesce((meta.authoring_metadata->>'scored')::boolean,true)) score
    from exam_delivery.attempt_items i join exam_delivery.package_questions q on q.id=i.package_question_id join exam_delivery.package_question_protected_content meta on meta.question_id=q.id join exam_delivery.attempt_item_protected_content pc on pc.attempt_item_id=i.id left join exam_delivery.attempt_responses r on r.attempt_item_id=i.id where i.attempt_id=p_attempt_id
  ), domains as (
    select domain_key,jsonb_build_object('domain',domain_key,'correct',count(*) filter(where score->>'status'='Correct'),'total',count(*) filter(where (score->>'maximum')::numeric>0),'earnedPoints',sum((score->>'earned')::numeric),'maxPoints',sum((score->>'maximum')::numeric),'percentage',case when sum((score->>'maximum')::numeric)>0 then round(100*sum((score->>'earned')::numeric)/sum((score->>'maximum')::numeric),2) else 0 end) value from scored group by domain_key
  ) select coalesce(jsonb_object_agg(domain_key,value),'{}'::jsonb) into v_domain from domains;
  select jsonb_build_object('questionCount',count(*) filter(where coalesce((meta.authoring_metadata->>'scored')::boolean,true)),'presentedCount',count(*),'answeredCount',count(r.id)) into v_summary
    from exam_delivery.attempt_items i join exam_delivery.package_question_protected_content meta on meta.question_id=i.package_question_id left join exam_delivery.attempt_responses r on r.attempt_item_id=i.id where i.attempt_id=p_attempt_id;
  select jsonb_build_object('items',jsonb_agg(jsonb_build_object('itemId',i.id,'questionNumber',i.presented_question_number,'questionId',q.question_id,'questionType',q.question_type,'domain',q.domain_key,'section',q.section_key,'presentation',i.presentation_snapshot,'response',coalesce(r.response_payload,'{}'::jsonb),'status',score.value->>'status','earnedPoints',(score.value->>'earned')::numeric,'maxPoints',(score.value->>'maximum')::numeric,'correctAnswer',pc.scoring_snapshot,'explanation',pc.review_snapshot->>'explanation','remediation',pc.review_snapshot->>'remediation') order by i.presented_question_number)) into v_review
    from exam_delivery.attempt_items i join exam_delivery.package_questions q on q.id=i.package_question_id join exam_delivery.package_question_protected_content meta on meta.question_id=q.id join exam_delivery.attempt_item_protected_content pc on pc.attempt_item_id=i.id left join exam_delivery.attempt_responses r on r.attempt_item_id=i.id cross join lateral (select exam_delivery.score_package_v2_response_for_scorer(v_attempt.scorer_version,q.question_type,i.presentation_snapshot,pc.scoring_snapshot,coalesce(r.response_payload,'{}'::jsonb),coalesce((meta.authoring_metadata->>'scored')::boolean,true)) value) score where i.attempt_id=p_attempt_id;
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


create function exam_delivery.complete_expiry_record(p_attempt_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare v_release boolean;
begin
  if not exists(select 1 from exam_delivery.attempt_results r join exam_delivery.expiry_bindings b on b.attempt_id=r.attempt_id and b.submission_id=r.submission_id where r.attempt_id=p_attempt_id and r.server_authoritative) then
    raise exception 'expiry_result_binding_required';
  end if;
  select continuation->>'review_release_policy' in ('after_submission','immediate_study_feedback') into v_release from exam_delivery.expiry_authority where attempt_id=p_attempt_id;
  if v_release then
    update exam_delivery.review_snapshots set release_status='released',released_at=clock_timestamp() where attempt_id=p_attempt_id and release_status='withheld';
    update public.exam_reports set report_snapshot=jsonb_set(report_snapshot,'{reviewStatus}','"released"'::jsonb,true) where attempt_id=p_attempt_id and report_type='study_report_snapshot';
  end if;
  update exam_delivery.expiry_processing set state='completed',lease_token=null,lease_until=null,completed_at=clock_timestamp() where attempt_id=p_attempt_id and state<>'completed';
  if found then insert into exam_delivery.expiry_events(attempt_id,event,generation) select attempt_id,'completed',generation from exam_delivery.expiry_processing where attempt_id=p_attempt_id; end if;
end $$;

create function exam_delivery.finalize_expiry(p_attempt_id uuid,p_lease_token uuid) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='15s' as $$
declare a exam_delivery.attempts%rowtype; s exam_delivery.expiry_processing%rowtype; v_time timestamptz; v_submission uuid; v_result jsonb; v_session record;
begin
  if not exam_delivery.lock_expiry_attempt(p_attempt_id,null) then return jsonb_build_object('ok',false,'code','not_enrolled'); end if;
  select * into a from exam_delivery.attempts where id=p_attempt_id;
  -- Ambiguous-commit retry returns only an already compatible authoritative result.
  if exists(select 1 from exam_delivery.attempt_results r join exam_delivery.expiry_bindings b on b.attempt_id=r.attempt_id and b.submission_id=r.submission_id where r.attempt_id=p_attempt_id and r.server_authoritative) then return exam_delivery.get_result(a.owner_id,p_attempt_id); end if;
  v_time:=clock_timestamp();
  select * into s from exam_delivery.expiry_processing where attempt_id=p_attempt_id for update;
  if s.state<>'claimed' or s.lease_token is distinct from p_lease_token or s.lease_until<=v_time then return jsonb_build_object('ok',false,'code','stale_lease'); end if;
  if a.status<>'in_progress' or a.expires_at>v_time then return jsonb_build_object('ok',false,'code','not_due'); end if;
  if exists(select 1 from exam_delivery.attempt_items i join exam_delivery.package_questions q on q.id=i.package_question_id where i.attempt_id=p_attempt_id and q.question_type='executable-python-lab-v1') then
    -- Preserve any pre-existing immutable manual session; never create one here.
    select * into v_session from exam_delivery.python_submission_grading_sessions where attempt_id=p_attempt_id;
    if found and v_session.created_at<a.expires_at then
      perform exam_delivery.bind_expiry_submission(p_attempt_id,v_session.submission_id,'manual',v_session.created_at);
    end if;
    update exam_delivery.expiry_processing set state='unsupported',lease_token=null,lease_until=null where attempt_id=p_attempt_id;
    insert into exam_delivery.expiry_events(attempt_id,event,generation) values(p_attempt_id,'unsupported',s.generation);
    return jsonb_build_object('ok',false,'code','executable_finalization_unsupported','pending',true);
  end if;
  select submission_id into v_submission from exam_delivery.expiry_bindings where attempt_id=p_attempt_id;
  if not found then
    v_submission:=gen_random_uuid();
    perform exam_delivery.bind_expiry_submission(p_attempt_id,v_submission,'time_limit_expiry',a.expires_at);
  end if;
  v_result:=exam_delivery.score_expiry_non_executable(a.owner_id,p_attempt_id,v_submission);
  if not coalesce((v_result->>'ok')::boolean,false) then raise exception 'expiry_scoring_failed'; end if;
  perform exam_delivery.complete_expiry_record(p_attempt_id);
  return exam_delivery.get_result(a.owner_id,p_attempt_id);
end $$;

alter function exam_delivery.prepare_python_submission_grading(uuid,uuid,uuid) rename to prepare_python_submission_before_expiry_foundation;
create function exam_delivery.prepare_python_submission_grading(p_actor_id uuid,p_attempt_id uuid,p_submission_id uuid) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='15s' as $$
declare v_enrolled boolean; v_time timestamptz; v_result jsonb; v_binding uuid;
begin
  v_enrolled:=exam_delivery.lock_expiry_attempt(p_attempt_id,p_actor_id);
  if not v_enrolled then return exam_delivery.prepare_python_submission_before_expiry_foundation(p_actor_id,p_attempt_id,p_submission_id); end if;
  if p_actor_id is null or p_submission_id is null then return jsonb_build_object('ok',false,'code','invalid_request'); end if;
  if exists(select 1 from exam_delivery.attempts where id=p_attempt_id and status not in ('in_progress','completed')) then
    return jsonb_build_object('ok',false,'code','invalid_lifecycle_transition');
  end if;
  v_time:=clock_timestamp();
  select submission_id into v_binding from exam_delivery.expiry_bindings where attempt_id=p_attempt_id;
  if found and v_binding is distinct from p_submission_id then return jsonb_build_object('ok',false,'code','submission_conflict'); end if;
  if not found and exists(select 1 from exam_delivery.expiry_authority where attempt_id=p_attempt_id and deadline<=v_time) then return jsonb_build_object('ok',false,'code','invalid_lifecycle_transition'); end if;
  if v_binding=p_submission_id and not exists(select 1 from exam_delivery.attempt_items i join exam_delivery.package_questions q on q.id=i.package_question_id where i.attempt_id=p_attempt_id and q.question_type='executable-python-lab-v1') then
    return jsonb_build_object('ok',true,'required',false,'ready',true,'completed',exists(select 1 from exam_delivery.attempt_results where attempt_id=p_attempt_id),'items','[]'::jsonb);
  end if;
  v_result:=exam_delivery.prepare_python_submission_before_expiry_foundation(p_actor_id,p_attempt_id,p_submission_id);
  if coalesce((v_result->>'ok')::boolean,false) then perform exam_delivery.bind_expiry_submission(p_attempt_id,p_submission_id,'manual',v_time); end if;
  return v_result;
end $$;

alter function exam_delivery.submit_attempt_v2(uuid,uuid,uuid) rename to submit_attempt_v2_before_expiry_foundation;
create function exam_delivery.submit_attempt_v2(p_actor_id uuid,p_attempt_id uuid,p_submission_id uuid) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='15s' as $$
declare v_time timestamptz; v_binding uuid; v_result jsonb;
begin
  if not exam_delivery.lock_expiry_attempt(p_attempt_id,p_actor_id) then return exam_delivery.submit_attempt_v2_before_expiry_foundation(p_actor_id,p_attempt_id,p_submission_id); end if;
  if p_actor_id is null or p_submission_id is null then return jsonb_build_object('ok',false,'code','invalid_request'); end if;
  v_time:=clock_timestamp();
  select submission_id into v_binding from exam_delivery.expiry_bindings where attempt_id=p_attempt_id;
  if found and v_binding<>p_submission_id then return jsonb_build_object('ok',false,'code','submission_conflict'); end if;
  if exists(select 1 from exam_delivery.attempt_results where attempt_id=p_attempt_id and submission_id=p_submission_id) then return exam_delivery.get_result(p_actor_id,p_attempt_id); end if;
  if exists(select 1 from exam_delivery.attempts where id=p_attempt_id and status<>'in_progress') then return jsonb_build_object('ok',false,'code','invalid_lifecycle_transition'); end if;
  if v_binding is null and exists(select 1 from exam_delivery.expiry_authority where attempt_id=p_attempt_id and deadline<=v_time) then return jsonb_build_object('ok',false,'code','invalid_lifecycle_transition'); end if;
  if exists(select 1 from exam_delivery.attempt_items i join exam_delivery.package_questions q on q.id=i.package_question_id where i.attempt_id=p_attempt_id and q.question_type='executable-python-lab-v1') then
    if not exists(select 1 from exam_delivery.python_submission_grading_sessions where attempt_id=p_attempt_id and submission_id=p_submission_id)
      or exists(select 1 from exam_delivery.attempt_items i join exam_delivery.package_questions q on q.id=i.package_question_id
        where i.attempt_id=p_attempt_id and q.question_type='executable-python-lab-v1'
        and not exists(select 1 from exam_delivery.python_submission_grading_runs r join exam_delivery.python_grading_evidence e on e.run_id=r.run_id
          where r.attempt_id=p_attempt_id and r.attempt_item_id=i.id and r.submission_id=p_submission_id)) then
      return jsonb_build_object('ok',false,'code','grading_incomplete');
    end if;
    v_result:=exam_delivery.submit_attempt_v2_before_expiry_foundation(p_actor_id,p_attempt_id,p_submission_id);
    if coalesce((v_result->>'ok')::boolean,false) then
      perform exam_delivery.bind_expiry_submission(p_attempt_id,p_submission_id,'manual',coalesce((select created_at from exam_delivery.python_submission_grading_sessions where attempt_id=p_attempt_id),v_time));
      perform exam_delivery.complete_expiry_record(p_attempt_id);
    end if;
    return v_result;
  end if;
  if v_binding is null then
    v_result:=exam_delivery.authorize_attempt_continuation(p_attempt_id,'submit');
    if not coalesce((v_result->>'ok')::boolean,false) then return v_result; end if;
    perform exam_delivery.bind_expiry_submission(p_attempt_id,p_submission_id,'manual',v_time);
  end if;
  v_result:=exam_delivery.score_expiry_non_executable(p_actor_id,p_attempt_id,p_submission_id);
  if not coalesce((v_result->>'ok')::boolean,false) then raise exception 'expiry_scoring_failed'; end if;
  perform exam_delivery.complete_expiry_record(p_attempt_id);
  return exam_delivery.get_result(p_actor_id,p_attempt_id);
end $$;

-- No public RPC. Service can only claim/retry/finalize a fixed enrolled attempt.
do $$
declare t text; f record;
begin
  foreach t in array array['expiry_activation','expiry_authority','expiry_bindings','expiry_processing','expiry_events'] loop
    execute format('alter table exam_delivery.%I enable row level security',t);
    execute format('revoke all on exam_delivery.%I from public,anon,authenticated,service_role',t);
  end loop;
  for f in select oid::regprocedure signature from pg_proc where pronamespace='exam_delivery'::regnamespace and (
    proname like '%expiry%' or proname like '%before_expiry_foundation'
    or proname in ('save_response','save_python_workspace','prepare_python_submission_grading','submit_attempt_v2')
  ) loop
    execute format('alter function %s owner to postgres',f.signature);
    execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
  end loop;
end $$;
revoke all on sequence exam_delivery.expiry_events_id_seq from public,anon,authenticated,service_role;
grant execute on function exam_delivery.claim_expiry(uuid),exam_delivery.retry_expiry(uuid,uuid),exam_delivery.finalize_expiry(uuid,uuid),
  exam_delivery.save_response(uuid,uuid,uuid,jsonb,integer,uuid),exam_delivery.save_python_workspace(uuid,uuid,uuid,jsonb,integer,uuid),
  exam_delivery.prepare_python_submission_grading(uuid,uuid,uuid) to service_role;
commit;
