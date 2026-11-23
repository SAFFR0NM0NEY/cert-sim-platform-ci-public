-- Issue #201: owner-scoped read-only learner completion status. No activation.
begin;

create index expiry_authority_owner_status_page
  on exam_delivery.expiry_authority(owner_id,deadline desc,attempt_id desc);

-- This helper reads fixed private records only. It deliberately does not call
-- continuation, reconciliation, result preparation, lease or lifecycle helpers.
create function exam_delivery.learner_completion_status_dto(
  p_actor_id uuid,p_attempt_id uuid,p_observed_at timestamptz
) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
  'contractVersion',1,'attemptId',a.id,'examKey',pv.exam_key,
  'packageVersion',pv.package_version,'profileKey',pp.profile_key,
  'profileName',pp.display_name,'purpose',a.purpose::text,
  'assignmentId',a.source_assignment_id,'deadline',case when x.attempt_id is not null then x.deadline else a.expires_at end,
  'observedAt',p_observed_at,'expiryManaged',x.attempt_id is not null,
  'closureReason',case when x.attempt_id is null then null
   when a.status not in ('in_progress','completed') then 'closed'
   when b.reason='manual' then 'manual_submission'
   when x.deadline<=p_observed_at then 'time_limit_expiry'
   when a.status='completed' then 'closed' else null end,
  'answeringAllowed',x.attempt_id is not null and a.status='in_progress' and x.deadline>p_observed_at and b.attempt_id is null,
  'state',case
   when a.status='completed' and a.completed_at is not null
    and r.server_authoritative and r.completed_at is not null and rs.attempt_id is not null then 'completed'
   when a.status not in ('in_progress','completed') then 'closed'
   when x.attempt_id is null then 'unmanaged'
   when a.status='completed' then 'needs_attention'
   when x.deadline>p_observed_at and b.attempt_id is null then 'active'
   when coalesce(j.blocked,false) or coalesce(j.failures,0)>=5
    or s.state='completed'
    or (s.state='unsupported' and cap.attempt_id is null) then 'needs_attention'
   when (s.state='claimed' and s.lease_until>p_observed_at)
    or (j.token is not null and j.lease_until>p_observed_at and j.horizon>=j.lease_until
     and not j.blocked and j.failures<5) then 'processing'
   when s.generation>=5 then 'needs_attention'
   when x.deadline<=p_observed_at and cap.attempt_id is null and exists(
    select 1 from exam_delivery.attempt_items i
    join exam_delivery.package_questions q on q.id=i.package_question_id
    where i.attempt_id=a.id and q.question_type='executable-python-lab-v1') then 'needs_attention'
   else 'awaiting_processing' end,
  'resultAvailable',a.status='completed' and a.completed_at is not null
    and coalesce(r.server_authoritative,false) and r.completed_at is not null and rs.attempt_id is not null,
  'completedAt',case when a.status='completed' and a.completed_at is not null and r.server_authoritative
    and r.completed_at is not null and rs.attempt_id is not null then r.completed_at else null end)
 from exam_delivery.attempts a
 join exam_delivery.package_versions pv on pv.id=a.package_version_id
 join exam_delivery.package_profiles pp on pp.id=a.package_profile_id
 left join exam_delivery.expiry_authority x on x.attempt_id=a.id and x.owner_id=a.owner_id
 left join exam_delivery.expiry_bindings b on b.attempt_id=a.id
 left join exam_delivery.expiry_processing s on s.attempt_id=a.id
 left join exam_delivery.python_expiry_capabilities cap on cap.attempt_id=a.id
 left join exam_delivery.python_worker_jobs j on j.attempt_id=a.id
 left join exam_delivery.attempt_results r on r.attempt_id=a.id
 left join exam_delivery.review_snapshots rs on rs.attempt_id=a.id
 where a.id=p_attempt_id and a.owner_id=p_actor_id
$$;

create function exam_delivery.get_learner_completion_status(p_actor_id uuid,p_attempt_id uuid)
returns jsonb language plpgsql stable security definer
set search_path='' set statement_timeout='3s' as $$
declare v_status jsonb;
begin
 if p_actor_id is null or p_attempt_id is null then return jsonb_build_object('ok',false,'code','invalid_request');end if;
 if not exists(select 1 from public.profiles where id=p_actor_id and status='active') then
  return jsonb_build_object('ok',false,'code','inactive_account');end if;
 v_status:=exam_delivery.learner_completion_status_dto(p_actor_id,p_attempt_id,statement_timestamp());
 if v_status is null then return jsonb_build_object('ok',false,'code','attempt_not_found');end if;
 return jsonb_build_object('ok',true,'status',v_status);
end $$;

create function exam_delivery.list_learner_pending_completions(
 p_actor_id uuid,p_exam_key text default null,p_profile_key text default null,
 p_purpose text default null,p_assignment_id uuid default null,
 p_cursor text default null,p_page_size integer default 20,
 p_watch_attempt_ids uuid[] default '{}'::uuid[]
) returns jsonb language plpgsql stable security definer
set search_path='' set statement_timeout='3s' as $$
declare v_time timestamptz:=statement_timestamp();v_deadline timestamptz;v_id uuid;
 v_items jsonb;v_watched jsonb;v_next text;v_returned integer;
begin
 if p_actor_id is null or p_page_size is null or p_page_size<1 or p_page_size>20
  or p_watch_attempt_ids is null or cardinality(p_watch_attempt_ids)>20
  or exists(select 1 from unnest(p_watch_attempt_ids) id where id is null)
  or (p_exam_key is not null and (length(p_exam_key)>64 or p_exam_key!~'^[a-zA-Z0-9][a-zA-Z0-9+._-]+$'))
  or (p_profile_key is not null and (length(p_profile_key)>128 or p_profile_key!~'^[a-zA-Z0-9][a-zA-Z0-9._-]*$'))
  or (p_purpose is not null and p_purpose not in ('assigned_assessment','self_directed_exam'))
 then return jsonb_build_object('ok',false,'code','invalid_request');end if;
 if not exists(select 1 from public.profiles where id=p_actor_id and status='active') then
  return jsonb_build_object('ok',false,'code','inactive_account');end if;
 if exists(select 1 from unnest(p_watch_attempt_ids) as watch(attempt_id) where not exists(
  select 1 from exam_delivery.attempts a where a.id=watch.attempt_id and a.owner_id=p_actor_id)) then
  return jsonb_build_object('ok',false,'code','attempt_not_found');end if;
 if p_cursor is not null then
  begin
   if length(p_cursor)>160 or array_length(string_to_array(p_cursor,'|'),1)<>2 then raise invalid_text_representation;end if;
   v_deadline:=split_part(p_cursor,'|',1)::timestamptz;v_id:=split_part(p_cursor,'|',2)::uuid;
   if not isfinite(v_deadline) then raise invalid_text_representation;end if;
  exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
   return jsonb_build_object('ok',false,'code','invalid_request');
  end;
 end if;
 -- A keyset window examines at most64 authority rows plus one indexed lookahead,
 -- even if many completed/other-profile rows precede a pending match.
 with candidates as materialized(
  select x.attempt_id,x.deadline from exam_delivery.expiry_authority x
  where x.owner_id=p_actor_id
   and (v_deadline is null or (x.deadline,x.attempt_id)<(v_deadline,v_id))
  order by x.deadline desc,x.attempt_id desc limit 65
 ), scanned as materialized(select * from candidates order by deadline desc,attempt_id desc limit 64),
 states as materialized(
  select c.*,exam_delivery.learner_completion_status_dto(p_actor_id,c.attempt_id,v_time) dto from scanned c
 ), eligible as materialized(
  select * from states where dto->>'state' in ('awaiting_processing','processing','needs_attention')
   and (p_exam_key is null or exam_delivery.normalize_exam_key(dto->>'examKey')=exam_delivery.normalize_exam_key(p_exam_key))
   and (p_profile_key is null or dto->>'profileKey'=p_profile_key)
   and (p_purpose is null or dto->>'purpose'=p_purpose)
   and (p_assignment_id is null or dto->>'assignmentId'=p_assignment_id::text)
  order by deadline desc,attempt_id desc
 ), page as materialized(select * from eligible order by deadline desc,attempt_id desc limit p_page_size)
 select coalesce((select jsonb_agg(dto order by deadline desc,attempt_id desc) from page),'[]'::jsonb),
  (select count(*)::integer from page),
  case when (select count(*) from eligible)>p_page_size
   then (select deadline::text||'|'||attempt_id::text from page order by deadline,attempt_id limit 1)
   when (select count(*) from candidates)>64
   then (select deadline::text||'|'||attempt_id::text from scanned order by deadline,attempt_id limit 1)
   else null end
 into v_items,v_returned,v_next;
 select coalesce(jsonb_agg(exam_delivery.learner_completion_status_dto(p_actor_id,id,v_time) order by id),'[]'::jsonb)
  into v_watched from (select distinct unnest(p_watch_attempt_ids) id) w;
 return jsonb_build_object('ok',true,'contractVersion',1,'observedAt',v_time,
  'items',v_items,'watched',v_watched,'returnedCount',v_returned,'nextCursor',v_next);
end $$;

create function public.certsim_protected_get_completion_status(p_actor_id uuid,p_attempt_id uuid)
returns jsonb language sql stable security invoker set search_path='' set statement_timeout='3s' as $$
 select exam_delivery.get_learner_completion_status(p_actor_id,p_attempt_id)
$$;
create function public.certsim_protected_list_pending_completions(
 p_actor_id uuid,p_exam_key text default null,p_profile_key text default null,
 p_purpose text default null,p_assignment_id uuid default null,
 p_cursor text default null,p_page_size integer default 20,p_watch_attempt_ids uuid[] default '{}'::uuid[]
) returns jsonb language sql stable security invoker set search_path='' set statement_timeout='3s' as $$
 select exam_delivery.list_learner_pending_completions(p_actor_id,p_exam_key,p_profile_key,p_purpose,p_assignment_id,p_cursor,p_page_size,p_watch_attempt_ids)
$$;

revoke all on function
 exam_delivery.learner_completion_status_dto(uuid,uuid,timestamptz),
 exam_delivery.get_learner_completion_status(uuid,uuid),
 exam_delivery.list_learner_pending_completions(uuid,text,text,text,uuid,text,integer,uuid[]),
 public.certsim_protected_get_completion_status(uuid,uuid),
 public.certsim_protected_list_pending_completions(uuid,text,text,text,uuid,text,integer,uuid[])
 from public,anon,authenticated,service_role;
grant execute on function
 exam_delivery.get_learner_completion_status(uuid,uuid),
 exam_delivery.list_learner_pending_completions(uuid,text,text,text,uuid,text,integer,uuid[]),
 public.certsim_protected_get_completion_status(uuid,uuid),
 public.certsim_protected_list_pending_completions(uuid,text,text,text,uuid,text,integer,uuid[])
 to service_role;
commit;
