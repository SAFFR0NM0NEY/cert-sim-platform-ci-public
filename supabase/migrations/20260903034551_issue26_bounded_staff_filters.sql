create or replace function exam_delivery.staff_scope_options(p_actor_id uuid,p_request jsonb)
returns jsonb language plpgsql stable security definer set search_path='' set statement_timeout='5s' as $$
declare v_role text; v_org uuid; v_global boolean:=false;
begin
  if p_actor_id is null then return jsonb_build_object('ok',false,'code','invalid_request'); end if;
  select case
    when exists(select 1 from public.memberships where user_id=p_actor_id and status='active' and role='platform_owner') then 'platform_owner'
    when exists(select 1 from public.memberships where user_id=p_actor_id and status='active' and role='developer') then 'developer'
    when exists(select 1 from public.memberships where user_id=p_actor_id and status='active' and role='college_admin') then 'college_admin'
    when exists(select 1 from public.memberships where user_id=p_actor_id and status='active' and role='campus_admin') then 'campus_admin'
    when exists(select 1 from public.memberships where user_id=p_actor_id and status='active' and role='trainer') then 'trainer' end into v_role;
  if v_role is null then return jsonb_build_object('ok',false,'code','access_not_granted'); end if;
  v_global:=v_role in ('platform_owner','developer');
  begin v_org:=nullif(p_request->>'organisationId','')::uuid;
  exception when others then return jsonb_build_object('ok',false,'code','invalid_request'); end;
  if not v_global then
    select organisation_id into v_org from public.memberships
    where user_id=p_actor_id and status='active' and role=v_role order by created_at limit 1;
  elsif v_org is not null and not exists(select 1 from public.organisations where id=v_org and status='active') then
    return jsonb_build_object('ok',false,'code','scope_forbidden');
  end if;
  return jsonb_build_object('ok',true,'role',v_role,
    'locks',jsonb_build_object('organisation',not v_global,'campus',v_role='campus_admin' and
      (select count(distinct m.campus_id) from public.memberships m where m.user_id=p_actor_id and m.status='active' and m.role='campus_admin')=1),
    'selection',jsonb_build_object('organisationId',v_org,'campusId',case when v_role='campus_admin' and
      (select count(distinct m.campus_id) from public.memberships m where m.user_id=p_actor_id and m.status='active' and m.role='campus_admin')=1 then
      (select min(m.campus_id) from public.memberships m where m.user_id=p_actor_id and m.status='active' and m.role='campus_admin') end),
    'organisations',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'name',o.name) order by o.name,o.id)
      from public.organisations o where o.status='active' and (v_global or o.id=v_org)),'[]'::jsonb),
    'campuses',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name) order by c.name,c.id)
      from public.campuses c where c.status='active' and c.organisation_id=v_org
        and (v_role<>'campus_admin' or exists(select 1 from public.memberships m where m.user_id=p_actor_id and m.status='active' and m.role='campus_admin' and m.campus_id=c.id))),'[]'::jsonb),
    'groups',coalesce((select jsonb_agg(jsonb_build_object('id',g.id,'name',g.name,'campusId',g.campus_id) order by g.name,g.id)
      from public.groups g where g.status='active' and g.organisation_id=v_org
        and (v_role<>'trainer' or exists(select 1 from public.memberships m where m.user_id=p_actor_id and m.status='active' and m.role='trainer' and m.group_id=g.id))),'[]'::jsonb),
    'assignments',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'name',a.title,'organisationId',a.organisation_id,
      'campusId',a.campus_id,'groupId',a.group_id,'examKey',exam_delivery.normalize_exam_key(a.exam_key),'status',a.status) order by a.title,a.id)
      from public.exam_assignments a where a.status<>'archived' and a.organisation_id=v_org
        and (v_role<>'campus_admin' or exists(select 1 from public.memberships m where m.user_id=p_actor_id and m.status='active' and m.role='campus_admin' and m.campus_id=a.campus_id))
        and (v_role<>'trainer' or exists(select 1 from public.memberships m where m.user_id=p_actor_id and m.status='active' and m.role='trainer' and m.group_id=a.group_id))),'[]'::jsonb),
    'exams',coalesce((select jsonb_agg(jsonb_build_object('id',exam_key,'name',exam_key) order by exam_key) from
      (select distinct exam_delivery.normalize_exam_key(a.exam_key) exam_key from public.exam_assignments a where a.status<>'archived' and a.organisation_id=v_org
        and (v_role<>'campus_admin' or exists(select 1 from public.memberships m where m.user_id=p_actor_id and m.status='active' and m.role='campus_admin' and m.campus_id=a.campus_id))
        and (v_role<>'trainer' or exists(select 1 from public.memberships m where m.user_id=p_actor_id and m.status='active' and m.role='trainer' and m.group_id=a.group_id))) e),'[]'::jsonb)
  );
end $$;

create or replace function exam_delivery.staff_dashboard_query(p_actor_id uuid,p_request jsonb)
returns jsonb language plpgsql stable security definer set search_path='' set statement_timeout='5s' as $$
declare v_options jsonb; v_role text; v_org uuid; v_campus uuid; v_group uuid; v_assignment uuid;
  v_exam text:=nullif(trim(p_request->>'examKey'),''); v_search text:=lower(nullif(trim(p_request->>'search'),''));
  v_status text:=nullif(p_request->>'resultStatus',''); v_workflow text:=coalesce(nullif(p_request->>'workflow',''),'results');
  v_cursor_at timestamptz; v_cursor_id uuid; v_size integer:=coalesce((p_request->>'pageSize')::integer,25);
  v_history jsonb; v_assignment_page jsonb; v_learner_ids jsonb;
begin
  if v_size<1 or v_size>50 or v_workflow not in ('overview','analytics','assignments','students','results')
    or (v_status is not null and v_status not in ('passed','needs-review','not-recorded')) then
    return jsonb_build_object('ok',false,'code','invalid_request');
  end if;
  v_options:=exam_delivery.staff_scope_options(p_actor_id,jsonb_build_object('organisationId',p_request->>'organisationId'));
  if v_options->>'ok'<>'true' then return v_options; end if;
  v_role:=v_options->>'role'; v_org:=nullif(v_options#>>'{selection,organisationId}','')::uuid;
  begin
    v_campus:=nullif(p_request->>'campusId','')::uuid; v_group:=nullif(p_request->>'groupId','')::uuid;
    v_assignment:=nullif(p_request->>'assignmentId','')::uuid;
    if nullif(p_request->>'cursor','') is not null then
      v_cursor_at:=split_part(p_request->>'cursor','|',1)::timestamptz;
      v_cursor_id:=split_part(p_request->>'cursor','|',2)::uuid;
    end if;
  exception when others then return jsonb_build_object('ok',false,'code','invalid_request'); end;
  if v_role='campus_admin' and v_campus is null then v_campus:=nullif(v_options#>>'{selection,campusId}','')::uuid; end if;
  if v_org is null then return jsonb_build_object('ok',false,'code','scope_required'); end if;
  if v_campus is not null and not exists(select 1 from jsonb_array_elements(v_options->'campuses') c where c->>'id'=v_campus::text) then return jsonb_build_object('ok',false,'code','scope_forbidden'); end if;
  if v_group is not null and not exists(select 1 from jsonb_array_elements(v_options->'groups') g where g->>'id'=v_group::text and (v_campus is null or g->>'campusId'=v_campus::text)) then return jsonb_build_object('ok',false,'code','scope_forbidden'); end if;
  if v_assignment is not null and not exists(select 1 from jsonb_array_elements(v_options->'assignments') a where a->>'id'=v_assignment::text and (v_group is null or a->>'groupId'=v_group::text)) then return jsonb_build_object('ok',false,'code','scope_forbidden'); end if;

  with eligible as materialized (
    select a.* from public.exam_assignments a where a.status<>'archived' and a.organisation_id=v_org
      and v_workflow in ('overview','analytics','assignments')
      and (v_campus is null or a.campus_id=v_campus) and (v_group is null or a.group_id=v_group)
      and (v_assignment is null or a.id=v_assignment) and (v_exam is null or exam_delivery.normalize_exam_key(a.exam_key)=exam_delivery.normalize_exam_key(v_exam))
      and (v_role<>'trainer' or exists(select 1 from public.memberships m where m.user_id=p_actor_id and m.status='active' and m.role='trainer' and m.group_id=a.group_id))
      and (v_role<>'campus_admin' or exists(select 1 from public.memberships m where m.user_id=p_actor_id and m.status='active' and m.role='campus_admin' and m.campus_id=a.campus_id))
      and (v_search is null or lower(coalesce(a.title,'')) like '%'||v_search||'%' or lower(coalesce(a.exam_key,'')) like '%'||v_search||'%')
  ), ordered as (select * from eligible where v_cursor_at is null or (created_at,id)<(v_cursor_at,v_cursor_id) order by created_at desc,id desc),
  bounded as (select * from ordered limit v_size+1), page as (select * from bounded limit v_size)
  select jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',title,'organisationId',organisation_id,
    'campusId',campus_id,'groupId',group_id,'studentUserId',student_user_id,'examKey',exam_delivery.normalize_exam_key(exam_key),
    'profileId',profile_id,'status',status,'dueAt',due_at,'availableFrom',available_from,'createdAt',created_at) order by created_at desc,id desc) from page),'[]'::jsonb),
    'nextCursor',case when (select count(*) from bounded)>v_size then (select created_at::text||'|'||id::text from page order by created_at,id limit 1) end,
    'complete',(select count(*) from bounded)<=v_size,'returnedCount',(select count(*) from page),'totalCount',(select count(*) from eligible)) into v_assignment_page;

  with visible_learners as materialized (
    select distinct m.user_id,m.group_id,m.campus_id,p.display_name,p.full_name,p.email from public.memberships m join public.profiles p on p.id=m.user_id
    where m.status='active' and m.role='student' and m.organisation_id=v_org and (v_campus is null or m.campus_id=v_campus) and (v_group is null or m.group_id=v_group)
      and (v_role<>'campus_admin' or exists(select 1 from public.memberships c where c.user_id=p_actor_id and c.status='active' and c.role='campus_admin' and c.campus_id=m.campus_id))
      and (v_role<>'trainer' or exists(select 1 from public.memberships t where t.user_id=p_actor_id and t.status='active' and t.role='trainer' and t.group_id=m.group_id))
  ), rows as materialized (
    select a.id attempt_id,a.owner_id learner_id,a.source_assignment_id assignment_id,exam_delivery.normalize_exam_key(pv.exam_key) exam_key,
      pv.package_version,pp.profile_key,a.purpose::text purpose,a.completed_at,r.raw_score,r.raw_percentage,r.passed,r.domain_summary,
      true server_authoritative,'protected' source,vl.display_name,vl.full_name,vl.email
    from exam_delivery.attempts a join visible_learners vl on vl.user_id=a.owner_id join exam_delivery.attempt_results r on r.attempt_id=a.id
    join exam_delivery.package_versions pv on pv.id=a.package_version_id join exam_delivery.package_profiles pp on pp.id=a.package_profile_id
    where a.status='completed' and a.analytics_eligible and a.purpose in ('assigned_assessment','self_directed_exam')
      and v_workflow in ('overview','analytics','students','results')
      and (v_assignment is null or a.source_assignment_id=v_assignment) and (v_exam is null or exam_delivery.normalize_exam_key(pv.exam_key)=exam_delivery.normalize_exam_key(v_exam))
    union all
    select a.id,a.user_id,null::uuid,exam_delivery.normalize_exam_key(a.exam_key),coalesce(a.exam_version,'legacy'),a.profile_id,
      classified.purpose,a.submitted_at,r.raw_score,r.raw_percentage,r.passed,coalesce(r.domain_breakdown,'{}'::jsonb),false,'legacy_authoritative',vl.display_name,vl.full_name,vl.email
    from public.exam_attempts a join visible_learners vl on vl.user_id=a.user_id join public.exam_results r on r.attempt_id=a.id and r.user_id=a.user_id
    cross join lateral (select exam_delivery.classify_legacy_result(a.profile_id,a.mode_label,a.attempt_snapshot,r.result_snapshot,a.status,a.submitted_at,r.raw_score,r.raw_percentage) purpose) classified
    where v_workflow in ('overview','analytics','students','results') and v_assignment is null and a.status='submitted' and a.submitted_at is not null and classified.purpose in ('assigned_assessment','self_directed_exam')
      and (v_exam is null or exam_delivery.normalize_exam_key(a.exam_key)=exam_delivery.normalize_exam_key(v_exam))
      and not exists(select 1 from exam_delivery.attempts pa where pa.id=a.id)
  ), filtered as materialized (select * from rows where
    (v_status is null or (v_status='passed' and passed is true) or (v_status='needs-review' and passed is false) or (v_status='not-recorded' and passed is null))
    and (v_search is null or lower(coalesce(display_name,'')) like '%'||v_search||'%' or lower(coalesce(full_name,'')) like '%'||v_search||'%'
      or lower(coalesce(email,'')) like '%'||v_search||'%' or lower(exam_key) like '%'||v_search||'%')),
  ordered as (select * from filtered where v_cursor_at is null or (completed_at,attempt_id)<(v_cursor_at,v_cursor_id) order by completed_at desc,attempt_id desc),
  bounded as (select * from ordered limit v_size+1), page as (select * from bounded limit v_size)
  select jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object('attemptId',attempt_id,'learnerId',learner_id,
    'assignmentId',assignment_id,'examKey',exam_key,'packageVersion',package_version,'profileKey',profile_key,'purpose',purpose,
    'completedAt',completed_at,'score',raw_score,'percentage',raw_percentage,'passed',passed,'domainSummary',domain_summary,
    'analyticsEligible',true,'serverAuthoritative',server_authoritative,'source',source) order by completed_at desc,attempt_id desc) from page),'[]'::jsonb),
    'totalCount',(select count(*) from filtered),'completedCount',(select count(*) from filtered),'returnedCount',(select count(*) from page),
    'nextCursor',case when (select count(*) from bounded)>v_size then (select completed_at::text||'|'||attempt_id::text from page order by completed_at,attempt_id limit 1) end,
    'averagePercentage',(select round(avg(raw_percentage),2) from filtered),'passRate',(select round(100.0*count(*) filter(where passed)/nullif(count(*),0),2) from filtered)) into v_history;
  select coalesce(jsonb_agg(user_id),'[]'::jsonb) into v_learner_ids from (select distinct m.user_id from public.memberships m where v_workflow in ('overview','analytics','students','results') and m.status='active' and m.role='student' and m.organisation_id=v_org and (v_campus is null or m.campus_id=v_campus) and (v_group is null or m.group_id=v_group)
    and (v_role<>'campus_admin' or exists(select 1 from public.memberships c where c.user_id=p_actor_id and c.status='active' and c.role='campus_admin' and c.campus_id=m.campus_id))
    and (v_role<>'trainer' or exists(select 1 from public.memberships t where t.user_id=p_actor_id and t.status='active' and t.role='trainer' and t.group_id=m.group_id))) m;
  return jsonb_build_object('ok',true,'role',v_role,'selection',jsonb_build_object('organisationId',v_org,'campusId',v_campus,'groupId',v_group,'assignmentId',v_assignment),
    'workflow',v_workflow,'assignmentPage',v_assignment_page,'learnerIds',v_learner_ids,'history',v_history);
end $$;

create or replace function public.certsim_protected_staff_scope_options(p_actor_id uuid,p_request jsonb) returns jsonb
language sql stable security invoker set search_path='' as $$select exam_delivery.staff_scope_options(p_actor_id,p_request)$$;
create or replace function public.certsim_protected_staff_dashboard_query(p_actor_id uuid,p_request jsonb) returns jsonb
language sql stable security invoker set search_path='' as $$select exam_delivery.staff_dashboard_query(p_actor_id,p_request)$$;

alter function exam_delivery.staff_scope_options(uuid,jsonb) owner to postgres;
alter function exam_delivery.staff_dashboard_query(uuid,jsonb) owner to postgres;
alter function public.certsim_protected_staff_scope_options(uuid,jsonb) owner to postgres;
alter function public.certsim_protected_staff_dashboard_query(uuid,jsonb) owner to postgres;
revoke execute on function exam_delivery.staff_scope_options(uuid,jsonb),exam_delivery.staff_dashboard_query(uuid,jsonb),
  public.certsim_protected_staff_scope_options(uuid,jsonb),public.certsim_protected_staff_dashboard_query(uuid,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function exam_delivery.staff_scope_options(uuid,jsonb),exam_delivery.staff_dashboard_query(uuid,jsonb),
  public.certsim_protected_staff_scope_options(uuid,jsonb),public.certsim_protected_staff_dashboard_query(uuid,jsonb) to service_role;
