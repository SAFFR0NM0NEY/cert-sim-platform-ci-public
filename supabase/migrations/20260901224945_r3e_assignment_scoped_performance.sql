-- Issue #23: immutable assignment attribution and server-authoritative staff scope.

alter table exam_delivery.attempts
  add column source_assignment_id uuid references public.exam_assignments(id) on delete restrict,
  add column source_organisation_id uuid references public.organisations(id) on delete restrict,
  add column source_campus_id uuid references public.campuses(id) on delete restrict,
  add column source_group_id uuid references public.groups(id) on delete restrict,
  add column attribution_source text;

alter table exam_delivery.attempts
  add constraint attempts_attribution_source_check check (
    attribution_source is null or attribution_source in (
      'assignment','personal_self_directed','direct_purchase','package_purchase','staff_personal'
    )
  ),
  add constraint attempts_assignment_attribution_shape_check check (
    (attribution_source='assignment' and source_assignment_id is not null and source_organisation_id is not null)
    or (coalesce(attribution_source,'')<>'assignment' and source_assignment_id is null
      and source_organisation_id is null and source_campus_id is null and source_group_id is null)
  );

create index attempts_source_assignment_history_idx
  on exam_delivery.attempts(source_assignment_id,completed_at desc,id desc)
  where source_assignment_id is not null;

create function exam_delivery.classify_attempt_attribution()
returns trigger language plpgsql security definer set search_path='' set statement_timeout='3s' as $$
begin
  if new.source_assignment_id is not null then
    new.attribution_source:='assignment';
    return new;
  end if;
  if exam_delivery.is_authoritative_staff(new.owner_id) then
    new.attribution_source:='staff_personal';
  elsif exists(select 1 from exam_delivery.exam_entitlements e
      where e.learner_id=new.owner_id and e.package_version_id=new.package_version_id
        and e.package_profile_id=new.package_profile_id and e.entitlement_source='direct_exam_purchase'
        and e.enabled and e.revoked_at is null
        and (e.valid_from is null or e.valid_from<=statement_timestamp())
        and (e.valid_until is null or e.valid_until>statement_timestamp())) then
    new.attribution_source:='direct_purchase';
  elsif exists(select 1 from exam_delivery.exam_entitlements e
      where e.learner_id=new.owner_id and e.package_version_id=new.package_version_id
        and e.package_profile_id=new.package_profile_id and e.entitlement_source='package_purchase'
        and e.enabled and e.revoked_at is null
        and (e.valid_from is null or e.valid_from<=statement_timestamp())
        and (e.valid_until is null or e.valid_until>statement_timestamp())) then
    new.attribution_source:='package_purchase';
  else
    new.attribution_source:='personal_self_directed';
  end if;
  return new;
end $$;

create trigger classify_attempt_attribution_before_insert
before insert on exam_delivery.attempts for each row
execute function exam_delivery.classify_attempt_attribution();

create function exam_delivery.guard_attempt_attribution_immutability()
returns trigger language plpgsql security definer set search_path='' set statement_timeout='3s' as $$
begin
  if row(old.source_assignment_id,old.source_organisation_id,old.source_campus_id,old.source_group_id,old.attribution_source)
    is distinct from row(new.source_assignment_id,new.source_organisation_id,new.source_campus_id,new.source_group_id,new.attribution_source)
  then raise exception 'attempt_attribution_is_immutable' using errcode='55000'; end if;
  return new;
end $$;

create trigger guard_attempt_attribution_mutation
before update on exam_delivery.attempts for each row
execute function exam_delivery.guard_attempt_attribution_immutability();

create function exam_delivery.start_assignment_attempt(
  p_actor_id uuid,p_exam_key text,p_profile_key text,p_request_id uuid,p_assignment_id uuid
) returns jsonb language plpgsql security definer set search_path='' set statement_timeout='15s' as $$
declare v_key text:=exam_delivery.normalize_exam_key(p_exam_key); v_now timestamptz:=statement_timestamp();
  v_existing exam_delivery.attempts%rowtype; v_package record; v_assignment public.exam_assignments%rowtype;
  v_attempt exam_delivery.attempts%rowtype;
begin
  if p_actor_id is null or p_request_id is null or p_assignment_id is null then
    return jsonb_build_object('ok',false,'code','invalid_request'); end if;
  select * into v_existing from exam_delivery.attempts where owner_id=p_actor_id and client_request_id=p_request_id;
  if found then
    if v_existing.source_assignment_id=p_assignment_id then return exam_delivery.resume_attempt(p_actor_id,v_existing.id); end if;
    return jsonb_build_object('ok',false,'code','attempt_conflict');
  end if;
  select * into v_assignment from public.exam_assignments a where a.id=p_assignment_id and a.status='active'
    and (a.available_from is null or a.available_from<=v_now) and (a.due_at is null or a.due_at>v_now) for share;
  if not found or exam_delivery.normalize_exam_key(v_assignment.exam_key)<>v_key
    or nullif(v_assignment.profile_id,'') is null or v_assignment.profile_id<>p_profile_key then
    return jsonb_build_object('ok',false,'code','assignment_conflict'); end if;
  if not ((v_assignment.student_user_id=p_actor_id) or (v_assignment.student_user_id is null
    and v_assignment.group_id is not null and exists(select 1 from public.memberships m
      where m.user_id=p_actor_id and m.status='active' and m.role='student'
        and m.organisation_id=v_assignment.organisation_id and m.group_id=v_assignment.group_id
        and (v_assignment.campus_id is null or m.campus_id=v_assignment.campus_id)))) then
    return jsonb_build_object('ok',false,'code','not_assigned'); end if;
  if not coalesce((exam_delivery.check_eligibility_v2(p_actor_id,p_exam_key,p_profile_key)->>'eligible')::boolean,false) then
    return jsonb_build_object('ok',false,'code',exam_delivery.check_eligibility_v2(p_actor_id,p_exam_key,p_profile_key)->>'reasonCode'); end if;
  select pv.id package_version_id,pv.generator_version,pv.scorer_version,pp.id package_profile_id,pp.time_limit_minutes
    into strict v_package from exam_delivery.package_versions pv join exam_delivery.package_profiles pp on pp.package_version_id=pv.id
    where exam_delivery.normalize_exam_key(pv.exam_key)=v_key and pp.profile_key=p_profile_key
      and pv.package_schema_version='certsim-protected-package-v2' and pv.status='published'
    order by pv.published_at desc limit 1 for share of pv,pp;
  insert into exam_delivery.attempts(owner_id,package_version_id,package_profile_id,protected_assignment_id,
    client_request_id,status,generator_version,scorer_version,created_at,started_at,expires_at,purpose,
    source_assignment_id,source_organisation_id,source_campus_id,source_group_id,attribution_source)
  values(p_actor_id,v_package.package_version_id,v_package.package_profile_id,null,p_request_id,'in_progress',
    v_package.generator_version,v_package.scorer_version,v_now,v_now,v_now+make_interval(mins=>v_package.time_limit_minutes),
    'assigned_assessment',v_assignment.id,v_assignment.organisation_id,v_assignment.campus_id,v_assignment.group_id,'assignment')
  returning * into v_attempt;
  perform exam_delivery.materialize_attempt_items(v_attempt.id,p_request_id,null);
  return exam_delivery.resume_attempt(p_actor_id,v_attempt.id);
exception when no_data_found or too_many_rows then return jsonb_build_object('ok',false,'code','package_unavailable');
when unique_violation then return jsonb_build_object('ok',false,'code','attempt_conflict');
end $$;

create function public.certsim_protected_start_attempt(
  p_actor_id uuid,p_exam_key text,p_profile_key text,p_request_id uuid,p_assignment_id uuid
) returns jsonb language sql security invoker set search_path='' as $$
  select case when p_assignment_id is null
    then exam_delivery.start_attempt(p_actor_id,p_exam_key,p_profile_key,p_request_id)
    else exam_delivery.start_assignment_attempt(p_actor_id,p_exam_key,p_profile_key,p_request_id,p_assignment_id) end
$$;

create function exam_delivery.discover_assignment_attempt(
  p_actor_id uuid,p_exam_key text,p_package_version text,p_profile_key text,p_purpose text,p_language text,p_assignment_id uuid
) returns jsonb language plpgsql stable security definer set search_path='' set statement_timeout='5s' as $$
declare v_attempt_id uuid; v_count integer;
begin
  if p_actor_id is null or p_assignment_id is null or p_purpose<>'assigned_assessment' then
    return jsonb_build_object('ok',false,'code','attempt_not_found'); end if;
  select count(*),min(a.id) into v_count,v_attempt_id from exam_delivery.attempts a
    join exam_delivery.package_versions pv on pv.id=a.package_version_id
    join exam_delivery.package_profiles pp on pp.id=a.package_profile_id
    where a.owner_id=p_actor_id and a.source_assignment_id=p_assignment_id and a.attribution_source='assignment'
      and a.status='in_progress' and exam_delivery.normalize_exam_key(pv.exam_key)=exam_delivery.normalize_exam_key(p_exam_key)
      and pv.package_version=p_package_version and pp.profile_key=p_profile_key and a.purpose::text=p_purpose
      and a.language_preference=p_language;
  if v_count<>1 then return jsonb_build_object('ok',false,'code',case when v_count=0 then 'attempt_not_found' else 'attempt_conflict' end); end if;
  return exam_delivery.resume_attempt(p_actor_id,v_attempt_id);
end $$;

create function public.certsim_protected_discover_current_attempt(
  p_actor_id uuid,p_exam_key text,p_package_version text,p_profile_key text,p_purpose text,p_language text,p_assignment_id uuid
) returns jsonb language sql stable security invoker set search_path='' as $$
  select case when p_assignment_id is null then exam_delivery.discover_current_attempt(
    p_actor_id,p_exam_key,p_package_version,p_profile_key,p_purpose,p_language)
  else exam_delivery.discover_assignment_attempt(
    p_actor_id,p_exam_key,p_package_version,p_profile_key,p_purpose,p_language,p_assignment_id) end
$$;

create function exam_delivery.staff_dashboard_scope(p_actor_id uuid,p_request jsonb)
returns jsonb language plpgsql stable security definer set search_path='' set statement_timeout='12s' as $$
declare v_role text; v_org uuid; v_campus uuid; v_group uuid; v_assignment uuid; v_cursor_created timestamptz; v_cursor_id uuid;
  v_size integer:=coalesce((p_request->>'pageSize')::integer,50); v_global boolean:=false;
begin
  if p_actor_id is null or v_size<1 or v_size>50 then return jsonb_build_object('ok',false,'code','invalid_request'); end if;
  select case when exists(select 1 from public.memberships m where m.user_id=p_actor_id and m.status='active' and m.role='platform_owner') then 'platform_owner'
    when exists(select 1 from public.memberships m where m.user_id=p_actor_id and m.status='active' and m.role='developer') then 'developer'
    when exists(select 1 from public.memberships m where m.user_id=p_actor_id and m.status='active' and m.role='college_admin') then 'college_admin'
    when exists(select 1 from public.memberships m where m.user_id=p_actor_id and m.status='active' and m.role='campus_admin') then 'campus_admin'
    when exists(select 1 from public.memberships m where m.user_id=p_actor_id and m.status='active' and m.role='trainer') then 'trainer' end into v_role;
  if v_role is null then return jsonb_build_object('ok',false,'code','access_not_granted'); end if;
  v_global:=v_role in ('platform_owner','developer');
  begin
    v_org:=nullif(p_request->>'organisationId','')::uuid; v_campus:=nullif(p_request->>'campusId','')::uuid;
    v_group:=nullif(p_request->>'groupId','')::uuid; v_assignment:=nullif(p_request->>'assignmentId','')::uuid;
    if nullif(p_request->>'cursor','') is not null then
      v_cursor_created:=split_part(p_request->>'cursor','|',1)::timestamptz;
      v_cursor_id:=split_part(p_request->>'cursor','|',2)::uuid;
    end if;
  exception when others then return jsonb_build_object('ok',false,'code','invalid_cursor'); end;
  if not v_global then
    select m.organisation_id,case when v_role='campus_admin' then m.campus_id end
      into v_org,v_campus from public.memberships m where m.user_id=p_actor_id and m.status='active' and m.role=v_role
      order by m.created_at limit 1;
  end if;
  if v_global and v_org is not null and not exists(select 1 from public.organisations o where o.id=v_org and o.status='active') then
    return jsonb_build_object('ok',false,'code','scope_forbidden'); end if;
  if v_org is not null and v_campus is not null and not exists(select 1 from public.campuses c where c.id=v_campus and c.organisation_id=v_org and c.status='active') then
    return jsonb_build_object('ok',false,'code','scope_forbidden'); end if;
  if v_group is not null and not exists(select 1 from public.groups g where g.id=v_group and g.organisation_id=v_org
    and (v_campus is null or g.campus_id=v_campus) and g.status='active'
    and (v_role<>'trainer' or exists(select 1 from public.memberships m where m.user_id=p_actor_id and m.status='active' and m.role='trainer' and m.group_id=g.id))) then
    return jsonb_build_object('ok',false,'code','scope_forbidden'); end if;
  if v_assignment is not null and not exists(select 1 from public.exam_assignments a where a.id=v_assignment
    and a.organisation_id=v_org and (v_campus is null or a.campus_id=v_campus)
    and (v_group is null or a.group_id=v_group or (a.student_user_id is not null and exists(select 1 from public.memberships m
      where m.user_id=a.student_user_id and m.status='active' and m.role='student' and m.group_id=v_group)))
    and a.status<>'archived') then return jsonb_build_object('ok',false,'code','scope_forbidden'); end if;
  return jsonb_build_object('ok',true,'role',v_role,
    'locks',jsonb_build_object('organisation',not v_global,'campus',v_role='campus_admin'),
    'selection',jsonb_build_object('organisationId',v_org,'campusId',v_campus,'groupId',v_group,'assignmentId',v_assignment),
    'organisations',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'name',o.name) order by o.name,o.id)
      from public.organisations o where o.status='active' and (v_global or o.id=v_org)),'[]'::jsonb),
    'campuses',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name) order by c.name,c.id)
      from public.campuses c where c.status='active' and v_org is not null and c.organisation_id=v_org
        and (v_role<>'campus_admin' or c.id=v_campus)),'[]'::jsonb),
    'groups',coalesce((select jsonb_agg(jsonb_build_object('id',g.id,'name',g.name,'campusId',g.campus_id) order by g.name,g.id)
      from public.groups g where g.status='active' and v_org is not null and g.organisation_id=v_org
        and (v_campus is null or g.campus_id=v_campus)
        and (v_role<>'trainer' or exists(select 1 from public.memberships m where m.user_id=p_actor_id and m.status='active' and m.role='trainer' and m.group_id=g.id))),'[]'::jsonb),
    'assignmentPage',(with eligible as (select a.* from public.exam_assignments a where a.status<>'archived' and v_group is not null
        and a.organisation_id=v_org and (a.group_id=v_group or (a.student_user_id is not null and exists(select 1 from public.memberships m
          where m.user_id=a.student_user_id and m.status='active' and m.role='student' and m.group_id=v_group)))
        and (v_campus is null or a.campus_id=v_campus)
        and (v_cursor_created is null or (a.created_at,a.id)<(v_cursor_created,v_cursor_id)) order by a.created_at desc,a.id desc),
      bounded as(select * from eligible limit v_size+1), page as(select * from bounded limit v_size)
      select jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',title) order by created_at desc,id desc) from page),'[]'::jsonb),
        'nextCursor',case when (select count(*) from bounded)>v_size then (select created_at::text||'|'||id::text from page order by created_at,id limit 1) end,
        'complete',(select count(*) from bounded)<=v_size,'returnedCount',(select count(*) from page))),
    'learnerIds',coalesce((select jsonb_agg(distinct m.user_id) from public.exam_assignments a
      join public.memberships m on m.status='active' and m.role='student' and
        ((a.student_user_id is not null and m.user_id=a.student_user_id) or
         (a.student_user_id is null and a.group_id is not null and m.group_id=a.group_id))
      where a.id=v_assignment and m.organisation_id=a.organisation_id
        and (a.campus_id is null or m.campus_id=a.campus_id)),'[]'::jsonb),
    'history',(with rows as (select a.id,a.owner_id,a.completed_at,r.raw_percentage,r.passed,r.domain_summary
        from exam_delivery.attempts a join exam_delivery.attempt_results r on r.attempt_id=a.id
        where v_assignment is not null and a.source_assignment_id=v_assignment and a.attribution_source='assignment' and a.status='completed')
      select jsonb_build_object('items',coalesce(jsonb_agg(jsonb_build_object('attemptId',id,'learnerId',owner_id,'completedAt',completed_at,
        'percentage',raw_percentage,'passed',passed,'domainSummary',domain_summary) order by completed_at desc,id desc),'[]'::jsonb),
        'totalCount',count(*),'completedCount',count(*),'averagePercentage',round(avg(raw_percentage),2),
        'passRate',round(100.0*count(*) filter(where passed)/nullif(count(*),0),2)) from rows));
end $$;

create function public.certsim_protected_staff_dashboard_scope(p_actor_id uuid,p_request jsonb)
returns jsonb language sql stable security invoker set search_path='' as $$
  select exam_delivery.staff_dashboard_scope(p_actor_id,p_request)
$$;

alter function exam_delivery.classify_attempt_attribution() owner to postgres;
alter function exam_delivery.guard_attempt_attribution_immutability() owner to postgres;
alter function exam_delivery.start_assignment_attempt(uuid,text,text,uuid,uuid) owner to postgres;
alter function exam_delivery.discover_assignment_attempt(uuid,text,text,text,text,text,uuid) owner to postgres;
alter function exam_delivery.staff_dashboard_scope(uuid,jsonb) owner to postgres;
alter function public.certsim_protected_start_attempt(uuid,text,text,uuid,uuid) owner to postgres;
alter function public.certsim_protected_discover_current_attempt(uuid,text,text,text,text,text,uuid) owner to postgres;
alter function public.certsim_protected_staff_dashboard_scope(uuid,jsonb) owner to postgres;

revoke execute on function exam_delivery.classify_attempt_attribution(),exam_delivery.guard_attempt_attribution_immutability(),
  exam_delivery.start_assignment_attempt(uuid,text,text,uuid,uuid),exam_delivery.staff_dashboard_scope(uuid,jsonb),
  exam_delivery.discover_assignment_attempt(uuid,text,text,text,text,text,uuid),
  public.certsim_protected_start_attempt(uuid,text,text,uuid,uuid),public.certsim_protected_discover_current_attempt(uuid,text,text,text,text,text,uuid),
  public.certsim_protected_staff_dashboard_scope(uuid,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function exam_delivery.start_assignment_attempt(uuid,text,text,uuid,uuid),
  exam_delivery.staff_dashboard_scope(uuid,jsonb),public.certsim_protected_start_attempt(uuid,text,text,uuid,uuid),
  exam_delivery.discover_assignment_attempt(uuid,text,text,text,text,text,uuid),
  public.certsim_protected_discover_current_attempt(uuid,text,text,text,text,text,uuid),
  public.certsim_protected_staff_dashboard_scope(uuid,jsonb) to service_role;
