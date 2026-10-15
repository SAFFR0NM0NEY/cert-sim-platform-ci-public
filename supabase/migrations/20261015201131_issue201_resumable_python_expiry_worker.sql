-- Source-only v1 Python worker. No enrolment, activation, schedule or provider.
begin;
create table exam_delivery.python_worker_control (
 singleton boolean primary key default true check(singleton),
 enabled boolean not null default false,
 cursor_deadline timestamptz not null default '-infinity',
 cursor_attempt uuid not null default '00000000-0000-0000-0000-000000000000',
 cycle_until timestamptz not null default clock_timestamp(),
 active_run uuid references exam_delivery.python_execution_runs(id)
);
insert into exam_delivery.python_worker_control(singleton) values(true);
create table exam_delivery.python_worker_jobs (
 attempt_id uuid primary key references exam_delivery.python_expiry_capabilities(attempt_id),
 version integer not null default 1 check(version=1), epoch bigint not null default 0 check(epoch>=0),
 token uuid, lease_until timestamptz, horizon timestamptz,
 failures integer not null default 0 check(failures between 0 and 5),
 next_after timestamptz not null default '-infinity', blocked boolean not null default false,
 block_reason text not null default 'none' check(block_reason in ('none','uncertain','permanent','completed')),
 check((token is null)=(lease_until is null))
);
create table exam_delivery.python_worker_dispatches (
 run_id uuid primary key references exam_delivery.python_execution_runs(id),
 attempt_id uuid not null references exam_delivery.python_worker_jobs(attempt_id),
 original_token uuid not null, epoch bigint not null,
 transport_settled boolean not null default false, cleanup_confirmed boolean not null default false,
 created_at timestamptz not null default clock_timestamp()
);
create index python_worker_dispatch_attempt on exam_delivery.python_worker_dispatches(attempt_id,run_id);
create table exam_delivery.python_worker_replacements (
 attempt_item_id uuid primary key references exam_delivery.python_expiry_inventory(attempt_item_id),
 previous_run uuid not null unique references exam_delivery.python_worker_dispatches(run_id),
 new_run uuid not null unique references exam_delivery.python_execution_runs(id),
 created_at timestamptz not null default clock_timestamp()
);
create table exam_delivery.python_worker_receipts (
 run_id uuid primary key references exam_delivery.python_worker_dispatches(run_id),
 evidence jsonb not null, result jsonb not null,
 created_at timestamptz not null default clock_timestamp(),
 check(octet_length(evidence::text)<=1048576 and octet_length(result::text)<=8388608)
);
create index python_worker_jobs_discovery on exam_delivery.python_worker_jobs(next_after,attempt_id) where not blocked and failures<5;

create function exam_delivery.set_python_worker_dispatch(p_enabled boolean) returns void
language sql security definer set search_path='' as $$update exam_delivery.python_worker_control set enabled=p_enabled where singleton$$;

-- Preserve the complete migration-93 authority check. Only v1 live Python lease
-- recognition is inserted before its unchanged foundation-processing fallback.
alter function exam_delivery.check_python_expiry_lease(uuid,uuid) rename to check_python_expiry_lease_before_worker;
do $build$
declare source text; anchor text:='select * into s from exam_delivery.expiry_processing where attempt_id=a.id for update;';
begin
 source:=pg_get_functiondef('exam_delivery.check_python_expiry_lease_before_worker(uuid,uuid)'::regprocedure);
 if position(anchor in source)=0 then raise exception 'python_worker_authority_source_mismatch';end if;
 source:=replace(source,'exam_delivery.check_python_expiry_lease_before_worker(', 'exam_delivery.check_python_expiry_lease(');
 source:=replace(source,anchor,$code$
  if p_token is not null and exists(select 1 from exam_delivery.python_worker_jobs j
    where j.attempt_id=a.id and j.version=1 and j.token=p_token
      and j.lease_until>clock_timestamp() and j.horizon>=j.lease_until) then return null;end if;
  $code$||anchor);
 execute source;
end $build$;

create function exam_delivery.check_python_worker_owner(p_attempt_id uuid,p_token uuid) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 if not exam_delivery.lock_expiry_attempt(p_attempt_id,null) then return false;end if;
 perform 1 from exam_delivery.python_worker_jobs where attempt_id=p_attempt_id and token=p_token
  and p_token is not null and lease_until>clock_timestamp() and horizon>=lease_until for update;
 return found;
end $$;

create function exam_delivery.claim_python_worker() returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='3s' set lock_timeout='1s' as $$
declare ctl exam_delivery.python_worker_control%rowtype; c record; a exam_delivery.attempts%rowtype;
 j exam_delivery.python_worker_jobs%rowtype; t timestamptz; tok uuid; seen boolean:=false;
begin
 select * into ctl from exam_delivery.python_worker_control where singleton;
 if not ctl.enabled and ctl.active_run is null then return jsonb_build_object('outcome','disabled');end if;
 for c in select cap.attempt_id,auth.deadline from exam_delivery.python_expiry_capabilities cap
  join exam_delivery.expiry_authority auth using(attempt_id)
  where auth.deadline<=least(clock_timestamp(),ctl.cycle_until) and (auth.deadline,cap.attempt_id)>(ctl.cursor_deadline,ctl.cursor_attempt)
  order by auth.deadline,cap.attempt_id limit 64
 loop
  seen:=true;
  select * into a from exam_delivery.attempts where id=c.attempt_id for update skip locked;
  if found then
   select * into ctl from exam_delivery.python_worker_control where singleton for update;
   t:=clock_timestamp();
   if (ctl.enabled or exists(select 1 from exam_delivery.python_worker_dispatches d where d.run_id=ctl.active_run and d.attempt_id=a.id))
    and a.status in ('in_progress','completed') and a.purpose in ('assigned_assessment','self_directed_exam')
    and a.expires_at<=t and exists(select 1 from exam_delivery.expiry_authority x
     where x.attempt_id=a.id and x.identity=exam_delivery.expiry_identity(a)
      and x.continuation=(select to_jsonb(cc) from exam_delivery.attempt_continuation_contracts cc where cc.attempt_id=a.id))
    and not exists(select 1 from exam_delivery.expiry_processing p where p.attempt_id=a.id and p.state='claimed' and p.lease_until>t)
   then
    insert into exam_delivery.python_worker_jobs(attempt_id) values(a.id) on conflict do nothing;
    select * into j from exam_delivery.python_worker_jobs where attempt_id=a.id for update;
    if (j.token is null or j.lease_until<=t) and j.next_after<=t
     and j.failures<5 and (not j.blocked or (j.block_reason='uncertain' and exists(select 1 from exam_delivery.python_worker_dispatches d
       join exam_delivery.python_worker_receipts e on e.run_id=d.run_id where d.run_id=ctl.active_run and d.attempt_id=a.id)))
     and not (a.status='completed' and j.blocked)
    then
     -- Compatible completion is reconciled; incompatible completion is skipped.
     if a.status='completed' and not exists(select 1 from exam_delivery.attempt_results r
       join exam_delivery.expiry_bindings b on b.attempt_id=r.attempt_id and b.submission_id=r.submission_id
       where r.attempt_id=a.id and r.server_authoritative) then
       update exam_delivery.python_worker_control set cursor_deadline=c.deadline,cursor_attempt=c.attempt_id where singleton;
       continue;end if;
     tok:=gen_random_uuid();
     update exam_delivery.python_worker_jobs set epoch=epoch+1,token=tok,lease_until=t+interval '30 seconds',horizon=t+interval '150 seconds',
      blocked=false,block_reason='none' where attempt_id=a.id;
     update exam_delivery.python_worker_control set cursor_deadline=c.deadline,cursor_attempt=a.id where singleton;
     return jsonb_build_object('outcome','claimed','attemptId',a.id,'token',tok,'epoch',j.epoch+1,'dispatchAllowed',ctl.enabled);
    end if;
   end if;
  end if;
  update exam_delivery.python_worker_control set cursor_deadline=c.deadline,cursor_attempt=c.attempt_id where singleton;
 end loop;
 if not seen then update exam_delivery.python_worker_control set cursor_deadline='-infinity',cursor_attempt='00000000-0000-0000-0000-000000000000',cycle_until=clock_timestamp() where singleton;end if;
 return jsonb_build_object('outcome',case when ctl.enabled then 'idle' else 'disabled' end);
end $$;

create function exam_delivery.renew_python_worker(p_attempt_id uuid,p_token uuid) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='3s' set lock_timeout='1s' as $$
begin
 if not exam_delivery.check_python_worker_owner(p_attempt_id,p_token) then return jsonb_build_object('ok',false,'code','stale_lease');end if;
 update exam_delivery.python_worker_jobs set lease_until=least(horizon,clock_timestamp()+interval '30 seconds')
  where attempt_id=p_attempt_id and horizon>clock_timestamp();
 if not found then return jsonb_build_object('ok',false,'code','stale_lease');end if;
 return jsonb_build_object('ok',true,'dispatchAllowed',(select enabled from exam_delivery.python_worker_control where singleton));
end $$;

create function exam_delivery.yield_python_worker(p_attempt_id uuid,p_token uuid,p_outcome text) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='3s' set lock_timeout='1s' as $$
begin
 if p_outcome is null or p_outcome not in ('progress','deferred','failure','uncertain','blocked','completed') then return jsonb_build_object('ok',false,'code','invalid_request');end if;
 if not exam_delivery.check_python_worker_owner(p_attempt_id,p_token) then return jsonb_build_object('ok',false,'code','stale_lease');end if;
 -- Admission survives uncertainty. Only verified evidence or safe replacement
 -- can release a provider slot, never an expired lease or failure alone.
 update exam_delivery.python_worker_control c set active_run=null where singleton and exists(
  select 1 from exam_delivery.python_worker_dispatches d join exam_delivery.python_grading_evidence e on e.run_id=d.run_id
   where d.run_id=c.active_run and d.attempt_id=p_attempt_id);
 update exam_delivery.python_worker_jobs set token=null,lease_until=null,
  failures=least(5,failures+case when p_outcome in ('failure','uncertain') then 1 else 0 end),
  blocked=blocked or p_outcome in ('uncertain','blocked','completed'),
  block_reason=case when p_outcome='uncertain' then 'uncertain' when p_outcome='blocked' then 'permanent' when p_outcome='completed' then 'completed' else block_reason end,
  next_after=case when p_outcome in ('deferred','failure') then clock_timestamp()+make_interval(secs=>least(300,30*(2^failures)::integer)) else '-infinity' end
  where attempt_id=p_attempt_id;
 return jsonb_build_object('ok',true,'outcome',p_outcome);
end $$;

create function exam_delivery.plan_python_worker(p_attempt_id uuid,p_token uuid) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='3s' set lock_timeout='1s' as $$
declare progress jsonb; item jsonb; dispatch exam_delivery.python_worker_dispatches%rowtype;
begin
 if not exam_delivery.check_python_worker_owner(p_attempt_id,p_token) then return jsonb_build_object('ok',false,'code','stale_lease');end if;
 progress:=exam_delivery.prepare_python_expiry(p_attempt_id,p_token);
 if not coalesce((progress->>'ok')::boolean,false) then return progress;end if;
 if coalesce((progress->>'completed')::boolean,false) or coalesce((progress->>'ready')::boolean,false) then
  return jsonb_build_object('ok',true,'action','complete');end if;
 select v into item from jsonb_array_elements(progress->'items') v where v->>'state' not in ('graded','unanswered')
  order by exists(select 1 from exam_delivery.python_worker_dispatches d where d.run_id=(v->>'runId')::uuid) desc,v->>'itemId' limit 1;
 if item is null then return jsonb_build_object('ok',false,'code','grading_incomplete');end if;
 select * into dispatch from exam_delivery.python_worker_dispatches where run_id=(item->>'runId')::uuid;
 if progress->>'reason'='manual' and not found then return jsonb_build_object('ok',true,'action','manual_pending');end if;
 return jsonb_build_object('ok',true,'action',case when exists(select 1 from exam_delivery.python_worker_receipts where run_id=(item->>'runId')::uuid) then 'receipt_replay'
  when item->>'state'='authorized' then 'dispatch'
  when dispatch.cleanup_confirmed and dispatch.transport_settled then 'replace' else 'reconcile' end,
  'itemId',item->>'itemId','runId',item->>'runId','transportSettled',coalesce(dispatch.transport_settled,false));
end $$;

create function exam_delivery.start_python_worker(p_attempt_id uuid,p_token uuid,p_item_id uuid,p_run_id uuid,p_digest text) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='3s' set lock_timeout='1s' as $$
declare c exam_delivery.python_worker_control%rowtype; result jsonb; j exam_delivery.python_worker_jobs%rowtype;
begin
 if not exam_delivery.check_python_worker_owner(p_attempt_id,p_token) then return jsonb_build_object('ok',false,'code','stale_lease');end if;
 select * into c from exam_delivery.python_worker_control where singleton for update;
 if not c.enabled then return jsonb_build_object('ok',false,'code','disabled');end if;
 if c.active_run is not null then return jsonb_build_object('ok',false,'code','admission_busy');end if;
 if exists(select 1 from exam_delivery.expiry_bindings where attempt_id=p_attempt_id and reason='manual') then
  return jsonb_build_object('ok',false,'code','manual_pending');end if;
 result:=exam_delivery.materialize_python_expiry(p_attempt_id,p_token,p_item_id,p_run_id,p_digest);
 if coalesce((result->>'claimed')::boolean,false) then
  select * into j from exam_delivery.python_worker_jobs where attempt_id=p_attempt_id;
  insert into exam_delivery.python_worker_dispatches(run_id,attempt_id,original_token,epoch) values(p_run_id,p_attempt_id,p_token,j.epoch);
  update exam_delivery.python_worker_control set active_run=p_run_id where singleton;
 end if;
 return result;
end $$;

create function exam_delivery.confirm_python_worker_transport(p_attempt_id uuid,p_token uuid,p_run_id uuid,p_settled boolean default false) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='3s' set lock_timeout='1s' as $$
begin
 if p_settled is null then return jsonb_build_object('ok',false,'code','invalid_request');end if;
 if not exam_delivery.check_python_worker_owner(p_attempt_id,p_token) then return jsonb_build_object('ok',false,'code','stale_lease');end if;
 if not p_settled and not (select enabled from exam_delivery.python_worker_control where singleton) then return jsonb_build_object('ok',false,'code','disabled');end if;
 perform 1 from exam_delivery.python_worker_dispatches d join exam_delivery.python_worker_control c on c.active_run=d.run_id
  where d.run_id=p_run_id and d.attempt_id=p_attempt_id and d.original_token=p_token and not d.transport_settled;
 if not found then return jsonb_build_object('ok',false,'code','stale_dispatch');end if;
 if p_settled then update exam_delivery.python_worker_dispatches set transport_settled=true where run_id=p_run_id;end if;
 return jsonb_build_object('ok',true);
end $$;

create function exam_delivery.cleanup_python_worker(p_attempt_id uuid,p_token uuid,p_run_id uuid,p_primary jsonb default null) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='3s' set lock_timeout='1s' as $$
declare actor uuid; sub uuid; item uuid; result jsonb; digest text;
begin
 if not exam_delivery.check_python_worker_owner(p_attempt_id,p_token) then return jsonb_build_object('ok',false,'code','stale_lease');end if;
 select a.owner_id,r.submission_id,r.attempt_item_id,x.execution_request_digest into actor,sub,item,digest
  from exam_delivery.python_worker_dispatches d join exam_delivery.attempts a on a.id=d.attempt_id
  join exam_delivery.python_submission_grading_runs r on r.run_id=d.run_id join exam_delivery.python_execution_runs x on x.id=d.run_id
  where d.run_id=p_run_id and d.attempt_id=p_attempt_id;
 if not found then return jsonb_build_object('ok',false,'code','dispatch_missing');end if;
 if p_primary is null then
  return exam_delivery.request_python_submission_grading_cancellation(actor,p_attempt_id,sub,item,p_run_id,p_run_id);
 end if;
 result:=exam_delivery.complete_python_execution(p_run_id,digest,p_primary#>>'{result,executionId}',
  p_primary->>'digest','cancelled','cancelled',p_primary#>>'{result,stdout}',p_primary#>>'{result,stderr}',null,true);
 if not coalesce((result->>'ok')::boolean,false) then return result;end if;
 update exam_delivery.python_worker_dispatches set cleanup_confirmed=true where run_id=p_run_id;
 return jsonb_build_object('ok',true);
end $$;

-- Verified Edge receipts may survive owner loss; they never confer dispatch or
-- attempt-finalization authority. Fixed legacy persistence remains authoritative.
create function exam_delivery.retain_python_worker_receipt(p_run_id uuid,p_evidence jsonb,p_result jsonb) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='3s' set lock_timeout='1s' as $$
declare d exam_delivery.python_worker_dispatches%rowtype; r exam_delivery.python_submission_grading_runs%rowtype;
 x exam_delivery.python_execution_runs%rowtype; saved exam_delivery.python_worker_receipts%rowtype; result jsonb;
begin
 select * into d from exam_delivery.python_worker_dispatches where run_id=p_run_id;
 if not found then return jsonb_build_object('ok',false,'code','dispatch_missing');end if;
 perform exam_delivery.lock_expiry_attempt(d.attempt_id,null);
 select * into r from exam_delivery.python_submission_grading_runs where run_id=p_run_id;
 select * into x from exam_delivery.python_execution_runs where id=p_run_id;
 if p_evidence->>'gradingSessionId' is distinct from r.grading_session_id::text
  or p_evidence->>'evidenceId' is distinct from r.grading_session_id::text
  or p_evidence->>'evidenceVersion' is distinct from 'certsim.python-grading.evidence.v1'
  or p_evidence->>'materializationId' is distinct from r.materialization_id::text
  or p_evidence->>'requestDigest' is distinct from x.execution_request_digest
  or p_evidence->>'materialDigest' is distinct from r.material_digest
  or p_evidence->>'gradingContractVersion' is distinct from r.grading_contract_version
  or (p_evidence->>'maximumRawPoints')::integer is distinct from r.maximum_raw_points
  or p_evidence->>'requestId' is distinct from 'request.'||x.execution_request_id::text
  or p_evidence->>'executionId' is distinct from p_result->>'executionId'
  or p_result->>'executionId' is distinct from 'execution.'||x.execution_request_id::text
  or p_result->>'contractVersion' is distinct from 'certsim.python-execution.result.v1'
 then return jsonb_build_object('ok',false,'code','grading_binding_mismatch');end if;
 insert into exam_delivery.python_worker_receipts(run_id,evidence,result) values(p_run_id,p_evidence,p_result) on conflict do nothing;
 select * into saved from exam_delivery.python_worker_receipts where run_id=p_run_id;
 if saved.evidence<>p_evidence or saved.result<>p_result then return jsonb_build_object('ok',false,'code','receipt_conflict');end if;
 begin
  result:=exam_delivery.complete_python_execution(p_run_id,x.execution_request_digest,p_result->>'executionId',p_evidence->>'executionResultDigest',
   case when p_result->>'status'='cancelled' then 'cancelled' when p_result->>'outcome'='completed' then 'completed' else 'failed' end,
   p_result->>'outcome',p_result->>'stdout',p_result->>'stderr',(p_result->>'exitCode')::integer,true);
  if not coalesce((result->>'ok')::boolean,false) then raise exception 'receipt_terminal_conflict';end if;
  result:=exam_delivery.persist_verified_python_grading_evidence((p_evidence->>'evidenceId')::uuid,p_run_id,
   r.materialization_id,r.grading_session_id,x.execution_request_digest,p_evidence->>'executionResultDigest',r.material_digest,
   r.grading_contract_version,(p_evidence->>'earnedRawPoints')::integer,r.maximum_raw_points,p_evidence->'rules');
  if not coalesce((result->>'ok')::boolean,false) then raise exception 'receipt_evidence_conflict';end if;
 exception when others then return jsonb_build_object('ok',false,'code','receipt_retained_recovery_blocked');end;
 return jsonb_build_object('ok',true,'outcome','evidenced');
end $$;

create function exam_delivery.replay_python_worker_receipt(p_attempt_id uuid,p_token uuid,p_run_id uuid) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='3s' set lock_timeout='1s' as $$
declare receipt exam_delivery.python_worker_receipts%rowtype;
begin
 if not exam_delivery.check_python_worker_owner(p_attempt_id,p_token) then return jsonb_build_object('ok',false,'code','stale_lease');end if;
 select s.* into receipt from exam_delivery.python_worker_receipts s join exam_delivery.python_worker_dispatches d using(run_id)
  where s.run_id=p_run_id and d.attempt_id=p_attempt_id;
 if not found then return jsonb_build_object('ok',false,'code','receipt_missing');end if;
 return exam_delivery.retain_python_worker_receipt(p_run_id,receipt.evidence,receipt.result);
end $$;

create function exam_delivery.replace_python_worker(p_attempt_id uuid,p_token uuid,p_run_id uuid) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='3s' set lock_timeout='1s' as $$
declare old exam_delivery.python_submission_grading_runs%rowtype; x exam_delivery.python_execution_runs%rowtype;
 run uuid:=gen_random_uuid(); req uuid:=gen_random_uuid();
begin
 if not exam_delivery.check_python_worker_owner(p_attempt_id,p_token) then return jsonb_build_object('ok',false,'code','stale_lease');end if;
 perform 1 from exam_delivery.python_worker_control where singleton and enabled for update;
 if not found then return jsonb_build_object('ok',false,'code','disabled');end if;
 select * into old from exam_delivery.python_submission_grading_runs where attempt_id=p_attempt_id and run_id=p_run_id;
 select * into x from exam_delivery.python_execution_runs where id=p_run_id;
 if old.id is null or x.state not in ('cancelled','failed') or x.disposal_state<>'confirmed'
  or not exists(select 1 from exam_delivery.python_worker_dispatches d where d.run_id=p_run_id and d.transport_settled and d.cleanup_confirmed)
  or exists(select 1 from exam_delivery.python_grading_evidence where run_id=p_run_id)
  or exists(select 1 from exam_delivery.python_worker_receipts where run_id=p_run_id)
  or exists(select 1 from exam_delivery.python_worker_replacements where attempt_item_id=old.attempt_item_id)
  or exists(select 1 from exam_delivery.python_submission_grading_runs newer where newer.submission_id=old.submission_id
    and newer.attempt_item_id=old.attempt_item_id and newer.attempt_number>old.attempt_number)
  or exists(select 1 from exam_delivery.attempts where id=p_attempt_id and status<>'in_progress')
 then return jsonb_build_object('ok',false,'code','recovery_blocked');end if;
 if not coalesce((exam_delivery.read_python_expiry_task(p_attempt_id,p_token,old.attempt_item_id,p_run_id)->>'ok')::boolean,false)
 then return jsonb_build_object('ok',false,'code','recovery_blocked');end if;
 insert into exam_delivery.python_execution_runs(id,attempt_id,attempt_item_id,workspace_revision,workspace_hash,client_request_id,execution_request_id,orchestration_request_digest,state,wall_time_ms,memory_bytes,output_bytes)
 values(run,p_attempt_id,old.attempt_item_id,old.workspace_revision,old.workspace_hash,gen_random_uuid(),req,
  exam_delivery.python_orchestration_request_digest(p_attempt_id,old.attempt_item_id,old.workspace_revision,old.workspace_hash,req),
  'authorized',x.wall_time_ms,x.memory_bytes,x.output_bytes);
 insert into exam_delivery.python_submission_grading_runs(attempt_id,submission_id,attempt_item_id,attempt_number,run_id,materialization_id,grading_session_id,workspace_revision,workspace_hash,material_digest,grading_contract_version,maximum_raw_points)
 values(p_attempt_id,old.submission_id,old.attempt_item_id,old.attempt_number+1,run,gen_random_uuid(),gen_random_uuid(),old.workspace_revision,old.workspace_hash,old.material_digest,old.grading_contract_version,old.maximum_raw_points);
 insert into exam_delivery.python_worker_replacements(attempt_item_id,previous_run,new_run) values(old.attempt_item_id,p_run_id,run);
 update exam_delivery.python_worker_control set active_run=null where singleton and active_run=p_run_id;
 return jsonb_build_object('ok',true,'outcome','replacement_ready');
end $$;

-- Explicit fixed wrappers. No table, activation, impersonation or score RPC.
create function public.certsim_service_python_worker_claim() returns jsonb language sql security definer set search_path='' as $$select exam_delivery.claim_python_worker()$$;
create function public.certsim_service_python_worker_renew(p_attempt_id uuid,p_token uuid) returns jsonb language sql security definer set search_path='' as $$select exam_delivery.renew_python_worker(p_attempt_id,p_token)$$;
create function public.certsim_service_python_worker_yield(p_attempt_id uuid,p_token uuid,p_outcome text) returns jsonb language sql security definer set search_path='' as $$select exam_delivery.yield_python_worker(p_attempt_id,p_token,p_outcome)$$;
create function public.certsim_service_python_worker_plan(p_attempt_id uuid,p_token uuid) returns jsonb language sql security definer set search_path='' as $$select exam_delivery.plan_python_worker(p_attempt_id,p_token)$$;
create function public.certsim_service_python_worker_start(p_attempt_id uuid,p_token uuid,p_item_id uuid,p_run_id uuid,p_digest text) returns jsonb language sql security definer set search_path='' as $$select exam_delivery.start_python_worker(p_attempt_id,p_token,p_item_id,p_run_id,p_digest)$$;
create function public.certsim_service_python_worker_transport(p_attempt_id uuid,p_token uuid,p_run_id uuid,p_settled boolean default false) returns jsonb language sql security definer set search_path='' as $$select exam_delivery.confirm_python_worker_transport(p_attempt_id,p_token,p_run_id,p_settled)$$;
create function public.certsim_service_python_worker_cleanup(p_attempt_id uuid,p_token uuid,p_run_id uuid,p_primary jsonb default null) returns jsonb language sql security definer set search_path='' as $$select exam_delivery.cleanup_python_worker(p_attempt_id,p_token,p_run_id,p_primary)$$;
create function public.certsim_service_python_worker_receipt(p_run_id uuid,p_evidence jsonb,p_result jsonb) returns jsonb language sql security definer set search_path='' as $$select exam_delivery.retain_python_worker_receipt(p_run_id,p_evidence,p_result)$$;
create function public.certsim_service_python_worker_replay(p_attempt_id uuid,p_token uuid,p_run_id uuid) returns jsonb language sql security definer set search_path='' as $$select exam_delivery.replay_python_worker_receipt(p_attempt_id,p_token,p_run_id)$$;
create function public.certsim_service_python_worker_replace(p_attempt_id uuid,p_token uuid,p_run_id uuid) returns jsonb language sql security definer set search_path='' as $$select exam_delivery.replace_python_worker(p_attempt_id,p_token,p_run_id)$$;
do $secure$
declare f record; name text;
begin
 foreach name in array array['python_worker_control','python_worker_jobs','python_worker_dispatches','python_worker_replacements','python_worker_receipts'] loop
  execute format('alter table exam_delivery.%I enable row level security',name);
  execute format('revoke all on exam_delivery.%I from public,anon,authenticated,service_role',name);
 end loop;
 foreach name in array array['python_worker_replacements','python_worker_receipts'] loop
  execute format('create trigger immutable before update or delete on exam_delivery.%I for each row execute function exam_delivery.examops_guard_append_only()',name);
 end loop;
 for f in select oid::regprocedure signature,proname from pg_proc where pronamespace in ('exam_delivery'::regnamespace,'public'::regnamespace)
  and (proname like '%python_worker%' or proname in ('check_python_expiry_lease','check_python_expiry_lease_before_worker')) loop
  execute format('alter function %s owner to postgres',f.signature);
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
  if f.proname like 'certsim_service_python_worker_%' then execute format('grant execute on function %s to service_role',f.signature);end if;
 end loop;
end $secure$;
commit;
