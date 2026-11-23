-- Issue #24 R3G: server-owned review flags and content-free question issue reports.

create function exam_delivery.randomize_presentation_arrays(p_value jsonb,p_seed text,p_path text default '$')
returns jsonb language plpgsql immutable security invoker set search_path='' as $$
declare v_type text:=jsonb_typeof(p_value); v_result jsonb; v_key text; v_entry jsonb;
begin
  if v_type='object' then
    v_result:='{}'::jsonb;
    for v_key,v_entry in select key,value from jsonb_each(p_value) loop
      if jsonb_typeof(v_entry)='array' and lower(v_key)=any(array['options','items','choices','availableoptions','commands']) then
        select coalesce(jsonb_agg(exam_delivery.randomize_presentation_arrays(e.value,p_seed,p_path||'.'||v_key||'['||e.n||']') order by md5(p_seed||':'||p_path||':'||v_key||':'||coalesce(e.value->>'id',e.n::text))),'[]'::jsonb)
          into v_entry from jsonb_array_elements(v_entry) with ordinality e(value,n);
      else
        v_entry:=exam_delivery.randomize_presentation_arrays(v_entry,p_seed,p_path||'.'||v_key);
      end if;
      v_result:=v_result||jsonb_build_object(v_key,v_entry);
    end loop;
    return v_result;
  elsif v_type='array' then
    select coalesce(jsonb_agg(exam_delivery.randomize_presentation_arrays(e.value,p_seed,p_path||'['||e.n||']') order by e.n),'[]'::jsonb)
      into v_result from jsonb_array_elements(p_value) with ordinality e(value,n);
    return v_result;
  end if;
  return p_value;
end $$;

create function exam_delivery.randomize_attempt_item_presentation() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  new.presentation_snapshot:=exam_delivery.randomize_presentation_arrays(new.presentation_snapshot,new.attempt_id::text||':'||new.package_question_id::text);
  select coalesce(jsonb_agg(e.value->>'id' order by e.n) filter(where e.value?'id'),'[]'::jsonb) into new.option_order
    from jsonb_array_elements(coalesce(new.presentation_snapshot->'options',new.presentation_snapshot->'items','[]'::jsonb)) with ordinality e(value,n);
  new.presentation_hash:=encode(extensions.digest(convert_to(new.presentation_snapshot::text,'UTF8'),'sha256'),'hex');
  return new;
end $$;

create trigger randomize_attempt_item_presentation before insert on exam_delivery.attempt_items
for each row execute function exam_delivery.randomize_attempt_item_presentation();

create table exam_delivery.attempt_item_flags (
  attempt_id uuid not null references exam_delivery.attempts(id) on delete cascade,
  attempt_item_id uuid not null references exam_delivery.attempt_items(id) on delete cascade,
  flagged boolean not null default true,
  last_request_id uuid not null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  primary key (attempt_id,attempt_item_id)
);

create table exam_delivery.question_issue_reports (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references exam_delivery.attempts(id),
  attempt_item_id uuid not null references exam_delivery.attempt_items(id),
  owner_id uuid not null references auth.users(id),
  message text not null check(length(btrim(message)) between 1 and 2000),
  request_id uuid not null,
  status text not null default 'open' check(status in ('open','in_review','resolved','dismissed')),
  created_at timestamptz not null default statement_timestamp(),
  unique(owner_id,request_id),
  unique(attempt_id,attempt_item_id,request_id)
);

create index question_issue_reports_attempt_idx on exam_delivery.question_issue_reports(attempt_id,created_at);
alter table exam_delivery.attempt_item_flags enable row level security;
alter table exam_delivery.question_issue_reports enable row level security;
revoke all on table exam_delivery.attempt_item_flags,exam_delivery.question_issue_reports from public,anon,authenticated,service_role;

create function exam_delivery.list_flags(p_actor_id uuid,p_attempt_id uuid)
returns jsonb language sql stable security definer set search_path='' set statement_timeout='5s' as $$
  select case when exists(select 1 from exam_delivery.attempts a where a.id=p_attempt_id and a.owner_id=p_actor_id)
    then jsonb_build_object('ok',true,'itemIds',coalesce((select jsonb_agg(f.attempt_item_id order by i.presented_question_number) from exam_delivery.attempt_item_flags f join exam_delivery.attempt_items i on i.id=f.attempt_item_id where f.attempt_id=p_attempt_id and f.flagged),'[]'::jsonb))
    else jsonb_build_object('ok',false,'code','attempt_not_found') end
$$;

create function exam_delivery.set_flag(p_actor_id uuid,p_attempt_id uuid,p_item_id uuid,p_flagged boolean,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='5s' as $$
declare v_auth jsonb; v_now timestamptz:=statement_timestamp();
begin
  if p_request_id is null or p_flagged is null then return jsonb_build_object('ok',false,'code','invalid_request'); end if;
  v_auth:=exam_delivery.authorize_attempt_continuation(p_attempt_id,'save_response');
  if not coalesce((v_auth->>'ok')::boolean,false) or (v_auth->>'ownerId')::uuid<>p_actor_id then return jsonb_build_object('ok',false,'code','attempt_not_found'); end if;
  if not exists(select 1 from exam_delivery.attempt_items where id=p_item_id and attempt_id=p_attempt_id) then return jsonb_build_object('ok',false,'code','attempt_not_found'); end if;
  insert into exam_delivery.attempt_item_flags(attempt_id,attempt_item_id,flagged,last_request_id,created_at,updated_at)
  values(p_attempt_id,p_item_id,p_flagged,p_request_id,v_now,v_now)
  on conflict(attempt_id,attempt_item_id) do update set flagged=excluded.flagged,last_request_id=excluded.last_request_id,updated_at=excluded.updated_at;
  return jsonb_build_object('ok',true,'itemId',p_item_id,'flagged',p_flagged,'updatedAt',v_now);
end $$;

create function exam_delivery.report_question_issue(p_actor_id uuid,p_attempt_id uuid,p_item_id uuid,p_message text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='5s' as $$
begin
  if p_request_id is null or length(btrim(coalesce(p_message,''))) not between 1 and 2000 then return jsonb_build_object('ok',false,'code','invalid_request'); end if;
  if not exists(select 1 from exam_delivery.attempts a join exam_delivery.attempt_items i on i.attempt_id=a.id where a.id=p_attempt_id and a.owner_id=p_actor_id and i.id=p_item_id) then return jsonb_build_object('ok',false,'code','attempt_not_found'); end if;
  insert into exam_delivery.question_issue_reports(attempt_id,attempt_item_id,owner_id,message,request_id)
  values(p_attempt_id,p_item_id,p_actor_id,btrim(p_message),p_request_id)
  on conflict(owner_id,request_id) do nothing;
  return jsonb_build_object('ok',true,'received',true);
end $$;

create function public.certsim_protected_list_flags(p_actor_id uuid,p_attempt_id uuid) returns jsonb language sql security invoker set search_path='' as $$ select exam_delivery.list_flags(p_actor_id,p_attempt_id) $$;
create function public.certsim_protected_set_flag(p_actor_id uuid,p_attempt_id uuid,p_item_id uuid,p_flagged boolean,p_request_id uuid) returns jsonb language sql security invoker set search_path='' as $$ select exam_delivery.set_flag(p_actor_id,p_attempt_id,p_item_id,p_flagged,p_request_id) $$;
create function public.certsim_protected_report_question_issue(p_actor_id uuid,p_attempt_id uuid,p_item_id uuid,p_message text,p_request_id uuid) returns jsonb language sql security invoker set search_path='' as $$ select exam_delivery.report_question_issue(p_actor_id,p_attempt_id,p_item_id,p_message,p_request_id) $$;

alter function exam_delivery.list_flags(uuid,uuid) owner to postgres;
alter function exam_delivery.randomize_presentation_arrays(jsonb,text,text) owner to postgres;
alter function exam_delivery.randomize_attempt_item_presentation() owner to postgres;
alter function exam_delivery.set_flag(uuid,uuid,uuid,boolean,uuid) owner to postgres;
alter function exam_delivery.report_question_issue(uuid,uuid,uuid,text,uuid) owner to postgres;
alter function public.certsim_protected_list_flags(uuid,uuid) owner to postgres;
alter function public.certsim_protected_set_flag(uuid,uuid,uuid,boolean,uuid) owner to postgres;
alter function public.certsim_protected_report_question_issue(uuid,uuid,uuid,text,uuid) owner to postgres;
revoke all on function exam_delivery.list_flags(uuid,uuid),exam_delivery.set_flag(uuid,uuid,uuid,boolean,uuid),exam_delivery.report_question_issue(uuid,uuid,uuid,text,uuid) from public,anon,authenticated,service_role;
revoke all on function exam_delivery.randomize_presentation_arrays(jsonb,text,text),exam_delivery.randomize_attempt_item_presentation() from public,anon,authenticated,service_role;
revoke all on function public.certsim_protected_list_flags(uuid,uuid),public.certsim_protected_set_flag(uuid,uuid,uuid,boolean,uuid),public.certsim_protected_report_question_issue(uuid,uuid,uuid,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.certsim_protected_list_flags(uuid,uuid),public.certsim_protected_set_flag(uuid,uuid,uuid,boolean,uuid),public.certsim_protected_report_question_issue(uuid,uuid,uuid,text,uuid) to service_role;
