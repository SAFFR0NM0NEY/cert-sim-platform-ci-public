-- Issue #201 fence v1. Future dispatches only. Default disabled; no backfill.
begin;
create table exam_delivery.python_fence_control(singleton boolean primary key default true check(singleton),enabled boolean not null default false);
insert into exam_delivery.python_fence_control values(true,false);
create table exam_delivery.python_fences(
 run_id uuid primary key references exam_delivery.python_worker_dispatches(run_id),
 epoch bigint not null check(epoch>0), binding jsonb not null check(octet_length(binding::text)<4096),
 phase text not null default 'open' check(phase in ('open','revoked','quiescent')),
 runner uuid, recovery_token uuid,recovery_until timestamptz,
 recovery_count integer not null default 0 check(recovery_count between 0 and 1000000),
 next_after timestamptz not null default '-infinity',
 released_at timestamptz,created_at timestamptz not null default clock_timestamp()
);
create table exam_delivery.python_fence_legs(
 run_id uuid references exam_delivery.python_fences(run_id),leg text check(leg in ('primary','probe')),
 request_id uuid not null unique,phase text not null default 'ready' check(phase in ('ready','intent','created','disposed','never')),
 sandbox_id text unique check(sandbox_id ~ '^sb-[A-Za-z0-9_-]{1,125}$'),
 request_digest text check(request_digest ~ '^[0-9a-f]{64}$'),
 primary key(run_id,leg),check((phase in ('created','disposed'))=(sandbox_id is not null))
);
-- Private authenticated receipts, not execution inputs or recovery metadata.
-- At most two distinct bounded receipts per dispatch; the second preserves conflict.
create table exam_delivery.python_fence_receipts(
 run_id uuid references exam_delivery.python_fences(run_id),digest text check(digest ~ '^[0-9a-f]{64}$'),
 body jsonb not null check(octet_length(body::text)<=8388608),created_at timestamptz not null default clock_timestamp(),
 primary key(run_id,digest)
);
create table exam_delivery.python_fence_events(
 id bigint generated always as identity primary key,run_id uuid not null references exam_delivery.python_fences(run_id),
 event text not null check(event in ('issued','admitted','intent','created','disposed','never','receipt','revoked','quiescent','released')),
 leg text check(leg in ('primary','probe')),created_at timestamptz not null default clock_timestamp()
);
create function exam_delivery.guard_python_fence() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' then raise exception 'fence_history_immutable';end if;
 if tg_table_name='python_fences' then
  if new.run_id<>old.run_id or new.epoch<>old.epoch or new.binding<>old.binding or new.created_at<>old.created_at
   or (old.runner is not null and new.runner is distinct from old.runner)
   or new.recovery_count<old.recovery_count
   or (old.released_at is not null and new.released_at is distinct from old.released_at)
   or (old.phase='revoked' and new.phase='open') or (old.phase='quiescent' and new.phase<>'quiescent')
  then raise exception 'fence_transition_prohibited';end if;
 else
  if new.run_id<>old.run_id or new.leg<>old.leg or new.request_id<>old.request_id
   or (old.request_digest is not null and new.request_digest is distinct from old.request_digest)
   or (old.sandbox_id is not null and new.sandbox_id is distinct from old.sandbox_id)
   or not (new.phase=old.phase or (old.phase='ready' and new.phase in ('intent','never'))
    or (old.phase='intent' and new.phase in ('created','disposed','never')) or (old.phase='created' and new.phase='disposed'))
  then raise exception 'fence_transition_prohibited';end if;
 end if;return new;
end $$;
create trigger monotonic before update or delete on exam_delivery.python_fences for each row execute function exam_delivery.guard_python_fence();
create trigger monotonic before update or delete on exam_delivery.python_fence_legs for each row execute function exam_delivery.guard_python_fence();
create function exam_delivery.set_python_fencing(p_enabled boolean) returns void language sql security definer set search_path='' as $$update exam_delivery.python_fence_control set enabled=p_enabled where singleton$$;

create function exam_delivery.start_fenced_python_worker(p_attempt_id uuid,p_token uuid,p_item_id uuid,p_run_id uuid,p_digest text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; b jsonb; d exam_delivery.python_worker_dispatches%rowtype;
begin
 if not exam_delivery.check_python_worker_owner(p_attempt_id,p_token) then return jsonb_build_object('ok',false,'code','stale_lease');end if;
 if not (select enabled from exam_delivery.python_fence_control where singleton) then return jsonb_build_object('ok',false,'code','fence_disabled');end if;
 result:=exam_delivery.start_python_worker(p_attempt_id,p_token,p_item_id,p_run_id,p_digest);
 if not coalesce((result->>'claimed')::boolean,false) then return result;end if;
 select * into strict d from exam_delivery.python_worker_dispatches where run_id=p_run_id;
 select jsonb_build_object('protocol','certsim.python-expiry.fence.v1','dispatchId',d.run_id,'epoch',d.epoch::text,
  'attemptId',r.attempt_id,'submissionId',r.submission_id,'itemId',r.attempt_item_id,'generation',r.attempt_number,
  'requestDigest',p_digest,'materialDigest',r.material_digest,'primaryId',x.execution_request_id,
  'probeId',r.grading_session_id,'materializationId',r.materialization_id,'gradingContractVersion',r.grading_contract_version,
  'maximumRawPoints',r.maximum_raw_points,'operation','grade') into b
 from exam_delivery.python_submission_grading_runs r join exam_delivery.python_execution_runs x on x.id=r.run_id where r.run_id=p_run_id;
 insert into exam_delivery.python_fences(run_id,epoch,binding) values(p_run_id,d.epoch,b);
 insert into exam_delivery.python_fence_legs(run_id,leg,request_id) values(p_run_id,'primary',(b->>'primaryId')::uuid),(p_run_id,'probe',(b->>'probeId')::uuid);
 insert into exam_delivery.python_fence_events(run_id,event) values(p_run_id,'issued');
 return result||jsonb_build_object('fence',b);
end $$;

-- One fixed finite-state operation. It never accepts a table/column, score,
-- lifecycle update, activation or caller-selected replacement.
create function exam_delivery.python_fence_step(p_binding jsonb,p_operation text,p_token uuid default null,p_leg text default null,p_sandbox_id text default null,p_body jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare f exam_delivery.python_fences%rowtype;l exam_delivery.python_fence_legs%rowtype;
 result jsonb; h text; existing jsonb;
begin
 select * into f from exam_delivery.python_fences where run_id=(p_binding->>'dispatchId')::uuid;
 if not found or f.binding is distinct from p_binding then return jsonb_build_object('ok',false,'code','fence_binding');end if;
 -- Same ordering as issuance/release: attempt, control, fence, leg/run.
 perform 1 from exam_delivery.attempts where id=(f.binding->>'attemptId')::uuid for update;
 perform 1 from exam_delivery.python_worker_control where singleton for update;
 select * into strict f from exam_delivery.python_fences where run_id=f.run_id for update;
 if p_operation='admit' then
  if f.phase<>'open' or f.runner is not null or not (select enabled from exam_delivery.python_fence_control where singleton) or not exists(select 1 from exam_delivery.python_worker_control where singleton and enabled and active_run=f.run_id)
   or not exists(select 1 from exam_delivery.attempts where id=(f.binding->>'attemptId')::uuid and status='in_progress')
  then return jsonb_build_object('ok',false,'code','fence_closed_or_admitted');end if;
  update exam_delivery.python_fences set runner=gen_random_uuid() where run_id=f.run_id returning runner into p_token;
  insert into exam_delivery.python_fence_events(run_id,event) values(f.run_id,'admitted');
  return jsonb_build_object('ok',true,'token',p_token);
 end if;
 if p_token is null or not coalesce(p_token=f.runner or (p_token=f.recovery_token and f.recovery_until>clock_timestamp()),false) then
  return jsonb_build_object('ok',false,'code','fence_owner');end if;
 if p_operation in ('intent','created','disposed','never') then
  select * into l from exam_delivery.python_fence_legs where run_id=f.run_id and leg=p_leg for update;
  if not found then return jsonb_build_object('ok',false,'code','fence_leg');end if;
  if p_operation='intent' then
   if p_token is distinct from f.runner or f.phase<>'open' or l.phase<>'ready'
    or not (select enabled from exam_delivery.python_worker_control where singleton)
    or not (select enabled from exam_delivery.python_fence_control where singleton)
    or not exists(select 1 from exam_delivery.attempts where id=(f.binding->>'attemptId')::uuid and status='in_progress')
    or p_body->>'requestDigest' is null or p_body->>'requestDigest' !~ '^[0-9a-f]{64}$'
    or (p_leg='primary' and p_body->>'requestDigest' is distinct from f.binding->>'requestDigest') then return jsonb_build_object('ok',false,'code','fence_closed');end if;
   update exam_delivery.python_fence_legs set phase='intent',request_digest=p_body->>'requestDigest' where run_id=f.run_id and leg=p_leg;
  elsif p_operation='created' then
   if p_token is distinct from f.runner or l.phase not in ('intent','created') or p_sandbox_id is null
    or (l.sandbox_id is not null and l.sandbox_id<>p_sandbox_id) then return jsonb_build_object('ok',false,'code','fence_creation');end if;
   update exam_delivery.python_fence_legs set phase='created',sandbox_id=p_sandbox_id where run_id=f.run_id and leg=p_leg;
  elsif p_operation='never' then
   -- Only the original creator can surrender its outstanding unused permit.
   if p_token is distinct from f.runner or l.phase<>'intent' then return jsonb_build_object('ok',false,'code','fence_creation');end if;
   update exam_delivery.python_fence_legs set phase='never' where run_id=f.run_id and leg=p_leg;
  else
   if p_sandbox_id is null or (l.sandbox_id is not null and l.sandbox_id<>p_sandbox_id)
    or l.phase not in ('intent','created','disposed') or (l.phase='intent' and p_token is distinct from f.runner)
   then return jsonb_build_object('ok',false,'code','fence_disposal');end if;
   update exam_delivery.python_fence_legs set phase='disposed',sandbox_id=p_sandbox_id where run_id=f.run_id and leg=p_leg;
  end if;
  if l.phase is distinct from (select phase from exam_delivery.python_fence_legs where run_id=f.run_id and leg=p_leg) then
   insert into exam_delivery.python_fence_events(run_id,event,leg) values(f.run_id,p_operation,p_leg);end if;
  return jsonb_build_object('ok',true,'allowed',f.phase='open' and exists(select 1 from exam_delivery.attempts where id=(f.binding->>'attemptId')::uuid and status='in_progress') and (select enabled from exam_delivery.python_worker_control where singleton) and (select enabled from exam_delivery.python_fence_control where singleton));
 end if;
 if p_operation='inspect' then
  if p_token is distinct from f.recovery_token then return jsonb_build_object('ok',false,'code','fence_owner');end if;
  return jsonb_build_object('ok',true,'legs',(select jsonb_agg(jsonb_build_object('leg',leg,'phase',phase,'sandboxId',sandbox_id) order by leg) from exam_delivery.python_fence_legs where run_id=f.run_id),
   'receipt',(select body from exam_delivery.python_fence_receipts where run_id=f.run_id order by created_at,digest limit 1));
 end if;
 if p_operation='receipt' then
  if p_token is distinct from f.runner or p_body is null or octet_length(p_body::text)>8388608
   or not exam_delivery.json_has_exact_keys(p_body,array['executionResult','evidence','envelope','disposalConfirmed'])
   or p_body->>'disposalConfirmed'<>'true'
   or p_body#>>'{evidence,requestDigest}' is distinct from f.binding->>'requestDigest'
   or p_body#>>'{evidence,materialDigest}' is distinct from f.binding->>'materialDigest'
   or p_body#>>'{evidence,gradingSessionId}' is distinct from f.binding->>'probeId'
   or p_body#>>'{executionResult,executionId}' is distinct from 'execution.'||(f.binding->>'primaryId')
  then return jsonb_build_object('ok',false,'code','fence_receipt_binding');end if;
  h:=encode(extensions.digest(convert_to(p_body::text,'UTF8'),'sha256'),'hex');
  if not exists(select 1 from exam_delivery.python_fence_receipts where run_id=f.run_id and digest=h) then
   if (select count(*) from exam_delivery.python_fence_receipts where run_id=f.run_id)>=2 then return jsonb_build_object('ok',false,'code','fence_receipt_limit');end if;
   insert into exam_delivery.python_fence_receipts(run_id,digest,body) values(f.run_id,h,p_body);
   insert into exam_delivery.python_fence_events(run_id,event) values(f.run_id,'receipt');
  end if;
  result:=exam_delivery.retain_python_worker_receipt(f.run_id,p_body->'evidence',p_body->'executionResult');
  -- Persist even conflicting authentic evidence, never overwrite legacy state.
  return jsonb_build_object('ok',true,'persisted',coalesce((result->>'ok')::boolean,false));
 elsif p_operation='seal' then
  if p_token is distinct from f.runner then return jsonb_build_object('ok',false,'code','fence_owner');end if;
  if exists(select 1 from exam_delivery.python_fence_legs where run_id=f.run_id and phase in ('intent','created')) then return jsonb_build_object('ok',false,'code','creation_unresolved');end if;
  update exam_delivery.python_fence_legs set phase='never' where run_id=f.run_id and phase='ready';
  if f.phase<>'quiescent' then
   update exam_delivery.python_fences set phase='quiescent' where run_id=f.run_id;
   insert into exam_delivery.python_fence_events(run_id,event) values(f.run_id,'quiescent');
  end if;
  return jsonb_build_object('ok',true);
 elsif p_operation='replay' then
  if p_token is distinct from f.recovery_token then return jsonb_build_object('ok',false,'code','fence_owner');end if;
  select body into existing from exam_delivery.python_fence_receipts where run_id=f.run_id order by created_at,digest limit 1;
  if existing is null then return jsonb_build_object('ok',true,'persisted',false);end if;
  result:=exam_delivery.retain_python_worker_receipt(f.run_id,existing->'evidence',existing->'executionResult');
  return jsonb_build_object('ok',true,'persisted',coalesce((result->>'ok')::boolean,false));
 elsif p_operation='release' then
  if p_token is distinct from f.recovery_token then return jsonb_build_object('ok',false,'code','fence_owner');end if;
  if f.phase='open' or exists(select 1 from exam_delivery.python_fence_legs where run_id=f.run_id and phase in ('intent','created')) then
   return jsonb_build_object('ok',false,'code','creation_unresolved');end if;
  update exam_delivery.python_fence_legs set phase='never' where run_id=f.run_id and phase='ready';
  if f.phase<>'quiescent' then
   update exam_delivery.python_fences set phase='quiescent' where run_id=f.run_id;
   insert into exam_delivery.python_fence_events(run_id,event) values(f.run_id,'quiescent');
  end if;
  -- Exact dispatch/epoch; a stale recovery can never clear a newer slot.
  update exam_delivery.python_worker_control c set active_run=null where singleton and active_run=f.run_id
   and exists(select 1 from exam_delivery.python_worker_dispatches d where d.run_id=f.run_id and d.epoch=f.epoch);
  if found then
   -- Capacity is independent of score/lifecycle/replacement. Never reset failures.
   update exam_delivery.python_worker_jobs j set
    blocked=case when exists(select 1 from exam_delivery.python_grading_evidence where run_id=f.run_id)
      and j.block_reason in ('none','uncertain') and j.failures<5 then false else true end,
    block_reason=case when exists(select 1 from exam_delivery.python_grading_evidence where run_id=f.run_id)
      and j.block_reason in ('none','uncertain') and j.failures<5 then 'none' else 'permanent' end
    where j.attempt_id=(f.binding->>'attemptId')::uuid;
  end if;
  return jsonb_build_object('ok',true,'released',true);
 end if;
 return jsonb_build_object('ok',false,'code','invalid_operation');
end $$;

create function exam_delivery.claim_python_fence_recovery() returns jsonb language plpgsql security definer set search_path='' as $$
declare held uuid;f exam_delivery.python_fences%rowtype;j exam_delivery.python_worker_jobs%rowtype;a exam_delivery.attempts%rowtype;receipt jsonb;
begin
 select active_run into held from exam_delivery.python_worker_control where singleton;
 if held is null then return jsonb_build_object('ok',true,'state','idle');end if;
 select * into f from exam_delivery.python_fences where run_id=held;
 if not found then return jsonb_build_object('ok',true,'state','legacy_unprovable');end if;
 select * into a from exam_delivery.attempts where id=(f.binding->>'attemptId')::uuid for update;
 select * into j from exam_delivery.python_worker_jobs where attempt_id=a.id for update;
 perform 1 from exam_delivery.python_worker_control where singleton and active_run=held for update;
 if not found then return jsonb_build_object('ok',true,'state','idle');end if;
 select * into strict f from exam_delivery.python_fences where run_id=held for update;
 if (a.status='in_progress' and not j.blocked and j.token is not null and j.lease_until>clock_timestamp())
  or f.next_after>clock_timestamp() or f.recovery_until>clock_timestamp()
 then return jsonb_build_object('ok',true,'state','deferred');end if;
 if f.phase='open' then
  update exam_delivery.python_fences set phase='revoked' where run_id=held;
  insert into exam_delivery.python_fence_events(run_id,event) values(held,'revoked');
 end if;
 update exam_delivery.python_fences set recovery_token=gen_random_uuid(),recovery_until=clock_timestamp()+interval '30 seconds',
  recovery_count=least(1000000,recovery_count+1),next_after=clock_timestamp()+make_interval(secs=>least(300,30*(2^least(recovery_count,3))::integer))
  where run_id=held returning * into f;
 select body into receipt from exam_delivery.python_fence_receipts where run_id=held order by created_at,digest limit 1;
 return jsonb_build_object('ok',true,'state','claimed','fence',f.binding,'token',f.recovery_token);
end $$;

-- Legacy cleanup/yield/replacement must never assert fencing retrospectively.
do $patch$
declare s text;anchor text;
begin
 s:=pg_get_functiondef('exam_delivery.yield_python_worker(uuid,uuid,text)'::regprocedure);
 anchor:='where d.run_id=c.active_run and d.attempt_id=p_attempt_id';
 if position(anchor in s)=0 then raise exception 'fence_yield_source_mismatch';end if;
 s:=replace(s,anchor,anchor||' and not exists(select 1 from exam_delivery.python_fences f where f.run_id=d.run_id and f.phase<>''quiescent'')');execute s;
 s:=pg_get_functiondef('exam_delivery.replace_python_worker(uuid,uuid,uuid)'::regprocedure);
 anchor:='if old.id is null or x.state not in';
 if position(anchor in s)=0 then raise exception 'fence_replace_source_mismatch';end if;
 s:=replace(s,anchor,'if exists(select 1 from exam_delivery.python_fences f where f.run_id=p_run_id and f.phase<>''quiescent'') or old.id is null or x.state not in');execute s;
end $patch$;

-- Audit and enforce every release, including the retained normal yield path.
create function exam_delivery.python_fence_release_guard() returns trigger
language plpgsql security definer set search_path='' as $release_guard$
declare f exam_delivery.python_fences%rowtype;
begin
 if old.active_run is not null and new.active_run is distinct from old.active_run then
  select * into f from exam_delivery.python_fences where run_id=old.active_run for update;
  if found then
   if f.phase<>'quiescent' then raise exception 'fence_quiescence_required';end if;
   if f.released_at is null then
    update exam_delivery.python_fences set released_at=clock_timestamp() where run_id=f.run_id;
    insert into exam_delivery.python_fence_events(run_id,event) values(f.run_id,'released');
   end if;
  end if;
 end if;return new;
end $release_guard$;
create trigger fence_release before update of active_run on exam_delivery.python_worker_control
for each row execute function exam_delivery.python_fence_release_guard();

create function public.certsim_service_python_worker_fenced_start(p_attempt_id uuid,p_token uuid,p_item_id uuid,p_run_id uuid,p_digest text) returns jsonb language sql security definer set search_path='' set statement_timeout='3s' as $$select exam_delivery.start_fenced_python_worker(p_attempt_id,p_token,p_item_id,p_run_id,p_digest)$$;
create function public.certsim_service_python_fence_recovery() returns jsonb language sql security definer set search_path='' set statement_timeout='3s' as $$select exam_delivery.claim_python_fence_recovery()$$;
create function public.certsim_service_python_fence_step(p_binding jsonb,p_operation text,p_token uuid default null,p_leg text default null,p_sandbox_id text default null,p_body jsonb default null)
returns jsonb language sql security definer set search_path='' set statement_timeout='3s' as $$select exam_delivery.python_fence_step(p_binding,p_operation,p_token,p_leg,p_sandbox_id,p_body)$$;
-- Expose only a mode annotation, never private receipts or inputs in summaries.
create or replace function public.certsim_service_python_worker_plan(p_attempt_id uuid,p_token uuid) returns jsonb language sql security definer set search_path='' set statement_timeout='3s' as $$
 select p||jsonb_build_object('fenced',exists(select 1 from exam_delivery.python_fences f where f.run_id=(p->>'runId')::uuid))
 from (select exam_delivery.plan_python_worker(p_attempt_id,p_token) p) q
$$;
do $secure$
declare n text;f record;
begin
 foreach n in array array['python_fence_control','python_fences','python_fence_legs','python_fence_receipts','python_fence_events'] loop
  execute format('alter table exam_delivery.%I enable row level security',n);
  execute format('revoke all on exam_delivery.%I from public,anon,authenticated,service_role',n);
 end loop;
 foreach n in array array['python_fence_receipts','python_fence_events'] loop
  execute format('create trigger immutable before update or delete on exam_delivery.%I for each row execute function exam_delivery.examops_guard_append_only()',n);
 end loop;
 for f in select oid::regprocedure signature,proname from pg_proc where pronamespace in ('exam_delivery'::regnamespace,'public'::regnamespace)
  and (proname like '%python_fenc%' or proname='start_fenced_python_worker') loop
  execute format('alter function %s owner to postgres',f.signature);
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
  if f.proname like 'certsim_service_%' then execute format('grant execute on function %s to service_role',f.signature);end if;
 end loop;
 revoke all on function public.certsim_service_python_worker_fenced_start(uuid,uuid,uuid,uuid,text) from public,anon,authenticated;
 grant execute on function public.certsim_service_python_worker_fenced_start(uuid,uuid,uuid,uuid,text) to service_role;
end $secure$;
commit;
