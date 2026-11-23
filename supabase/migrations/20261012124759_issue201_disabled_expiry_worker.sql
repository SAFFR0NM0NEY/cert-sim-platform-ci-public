-- Source-only worker controls. No activation, backfill, schedule or provider.
begin;
create table exam_delivery.expiry_worker_control (
 singleton boolean primary key default true check(singleton),
 enabled boolean not null default false,
 cursor_deadline timestamptz not null default '-infinity',
 cursor_attempt uuid not null default '00000000-0000-0000-0000-000000000000'
);
insert into exam_delivery.expiry_worker_control(singleton) values(true);
alter table exam_delivery.expiry_processing add column retry_after timestamptz not null default '-infinity';
-- Add backoff in the existing claimed->retry update itself. The foundation's
-- processing guard remains unchanged; no otherwise-forbidden metadata update.
create function exam_delivery.expiry_worker_backoff() returns trigger
language plpgsql set search_path='' as $$begin
 if old.state='claimed' and new.state='retry' then
  new.retry_after:=clock_timestamp()+make_interval(secs=>least(300,30*(2^(old.generation-1))::integer));
 end if;
 return new;
end $$;
create trigger expiry_worker_backoff before update on exam_delivery.expiry_processing
 for each row execute function exam_delivery.expiry_worker_backoff();
create index expiry_authority_discovery on exam_delivery.expiry_authority(deadline,attempt_id);
create index expiry_processing_discovery on exam_delivery.expiry_processing(state,retry_after,attempt_id)
 where generation<5 and state in ('pending','retry','claimed');

create function exam_delivery.set_expiry_worker(p_enabled boolean) returns void
language sql security definer set search_path='' as $$
 update exam_delivery.expiry_worker_control set enabled=p_enabled where singleton
$$;

-- At most 64 authority records inspected per call; cursor advances even when
-- locked/ineligible rows are skipped. A wrap consumes an empty bounded call.
create function exam_delivery.claim_next_expiry() returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='5s' set lock_timeout='1s' as $$
declare ctl exam_delivery.expiry_worker_control%rowtype; candidate record;
 a exam_delivery.attempts%rowtype; p exam_delivery.expiry_processing%rowtype;
 v_now timestamptz; v_claim jsonb; v_seen boolean:=false;
begin
 select * into ctl from exam_delivery.expiry_worker_control where singleton;
 if not coalesce(ctl.enabled,false) then return jsonb_build_object('outcome','disabled'); end if;
 v_now:=clock_timestamp();
 for candidate in
  select c.attempt_id,c.deadline from exam_delivery.expiry_authority c
  where c.deadline<=v_now
   and (c.deadline,c.attempt_id)>(ctl.cursor_deadline,ctl.cursor_attempt)
  order by c.deadline,c.attempt_id limit 64
 loop
  v_seen:=true;
  -- Do not take processing locks before this attempt lock.
  select * into a from exam_delivery.attempts where id=candidate.attempt_id for update skip locked;
  if found then
   v_now:=clock_timestamp();
   select * into p from exam_delivery.expiry_processing where attempt_id=a.id;
   if a.status='in_progress' and a.purpose in ('assigned_assessment','self_directed_exam')
    and candidate.deadline<=v_now and a.expires_at=candidate.deadline
    and p.state in ('pending','retry','claimed') and p.generation<5 and p.retry_after<=v_now
    and (p.state<>'claimed' or p.lease_until<=v_now)
    and not exists(select 1 from exam_delivery.attempt_results where attempt_id=a.id)
    and not exists(select 1 from exam_delivery.attempt_items i join exam_delivery.package_questions q
      on q.id=i.package_question_id where i.attempt_id=a.id and q.question_type='executable-python-lab-v1')
    and exists(select 1 from exam_delivery.expiry_authority c where c.attempt_id=a.id
      and c.continuation->>'expiry_mode'='timed') then
     -- Recheck the execution gate after acquiring the attempt lock.
     if not (select enabled from exam_delivery.expiry_worker_control where singleton) then
      return jsonb_build_object('outcome','disabled');
     end if;
     v_claim:=exam_delivery.claim_expiry(a.id);
     if coalesce((v_claim->>'ok')::boolean,false) and v_claim ? 'leaseToken' then
      update exam_delivery.expiry_worker_control set cursor_deadline=candidate.deadline,cursor_attempt=a.id where singleton;
      return jsonb_build_object('outcome','claimed','attemptId',a.id,'leaseToken',v_claim->>'leaseToken');
     end if;
   end if;
  end if;
  update exam_delivery.expiry_worker_control set cursor_deadline=candidate.deadline,cursor_attempt=candidate.attempt_id where singleton;
 end loop;
 if not v_seen then
  update exam_delivery.expiry_worker_control set cursor_deadline='-infinity',cursor_attempt='00000000-0000-0000-0000-000000000000' where singleton;
 end if;
 return jsonb_build_object('outcome','empty');
end $$;

-- A compatible committed result wins over a lost response. Otherwise only the
-- live token holder may release its claim; never revive an abandoned attempt.
create function exam_delivery.defer_expiry_worker(p_attempt_id uuid,p_token uuid,p_permanent boolean default false) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='5s' set lock_timeout='1s' as $$
declare p exam_delivery.expiry_processing%rowtype; v_result jsonb;
begin
 if not exam_delivery.lock_expiry_attempt(p_attempt_id,null) then return jsonb_build_object('outcome','not_enrolled'); end if;
 if exists(select 1 from exam_delivery.attempt_results r join exam_delivery.expiry_bindings b
   on b.attempt_id=r.attempt_id and b.submission_id=r.submission_id where r.attempt_id=p_attempt_id and r.server_authoritative) then
  return jsonb_build_object('outcome','completed');
 end if;
 select * into p from exam_delivery.expiry_processing where attempt_id=p_attempt_id for update;
 if p.state<>'claimed' or p.lease_token is distinct from p_token or p.lease_until<=clock_timestamp() then
  return jsonb_build_object('outcome','stale');
 end if;
 if p_permanent then
  update exam_delivery.expiry_processing set state='unsupported',lease_token=null,lease_until=null where attempt_id=p_attempt_id;
  insert into exam_delivery.expiry_events(attempt_id,event,generation) values(p_attempt_id,'unsupported',p.generation);
  return jsonb_build_object('outcome','blocked');
 end if;
 v_result:=exam_delivery.retry_expiry(p_attempt_id,p_token);
 if coalesce((v_result->>'ok')::boolean,false) then
  return jsonb_build_object('outcome',case when p.generation>=5 then 'exhausted' else 'deferred' end);
 end if;
 return jsonb_build_object('outcome','stale');
end $$;

create function exam_delivery.finish_expiry_worker(p_attempt_id uuid,p_token uuid) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='15s' set lock_timeout='1s' as $$
declare r jsonb;
begin
 begin
  r:=exam_delivery.finalize_expiry(p_attempt_id,p_token);
  if coalesce((r->>'ok')::boolean,false) then return jsonb_build_object('outcome','completed'); end if;
  if r->>'code'='stale_lease' then return jsonb_build_object('outcome','stale'); end if;
  -- Fixed classification, never caller-supplied scores or repair instructions.
  return exam_delivery.defer_expiry_worker(p_attempt_id,p_token,true);
 exception
  when data_exception or integrity_constraint_violation then
   return exam_delivery.defer_expiry_worker(p_attempt_id,p_token,true);
  when others then
   return exam_delivery.defer_expiry_worker(p_attempt_id,p_token,false);
 end;
end $$;

create function public.certsim_service_claim_next_expiry() returns jsonb
language sql security definer set search_path='' set statement_timeout='5s' set lock_timeout='1s' as $$ select exam_delivery.claim_next_expiry() $$;
create function public.certsim_service_finish_expiry(p_attempt_id uuid,p_token uuid) returns jsonb
language sql security definer set search_path='' set statement_timeout='15s' set lock_timeout='1s' as $$ select exam_delivery.finish_expiry_worker(p_attempt_id,p_token) $$;
create function public.certsim_service_reconcile_expiry(p_attempt_id uuid,p_token uuid) returns jsonb
language sql security definer set search_path='' set statement_timeout='5s' set lock_timeout='1s' as $$ select exam_delivery.defer_expiry_worker(p_attempt_id,p_token,false) $$;
alter table exam_delivery.expiry_worker_control enable row level security;
revoke all on exam_delivery.expiry_worker_control from public,anon,authenticated,service_role;
do $$declare f record; begin
 for f in select oid::regprocedure signature from pg_proc where
  (pronamespace='exam_delivery'::regnamespace and proname in ('expiry_worker_backoff','set_expiry_worker','claim_next_expiry','defer_expiry_worker','finish_expiry_worker'))
  or (pronamespace='public'::regnamespace and proname in ('certsim_service_claim_next_expiry','certsim_service_finish_expiry','certsim_service_reconcile_expiry')) loop
  execute format('alter function %s owner to postgres',f.signature);
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
 end loop;
end $$;
grant execute on function public.certsim_service_claim_next_expiry(),public.certsim_service_finish_expiry(uuid,uuid),public.certsim_service_reconcile_expiry(uuid,uuid) to service_role;
commit;
