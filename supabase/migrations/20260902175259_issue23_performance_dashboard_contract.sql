-- Issue #23: keep the Performance Dashboard on its bounded institutional
-- contract.  The protected DTO now carries the minimum assignment/exam
-- metadata required for analytics, and the separate mixed-history reader
-- materializes visible learners once instead of repeating authorization work
-- for every result and aggregate.

create or replace function exam_delivery.list_staff_history(
  p_actor_id uuid,
  p_cursor text,
  p_page_size integer
) returns jsonb
language sql stable security definer
set search_path=''
set statement_timeout='10s'
as $$
with visible_learners as materialized (
  select distinct learner.user_id learner_id
  from public.memberships staff
  join public.memberships learner on learner.status='active' and learner.role='student'
  where staff.user_id=p_actor_id and staff.status='active'
    and (
      staff.role in ('developer','platform_owner')
      or (staff.role='college_admin' and staff.organisation_id=learner.organisation_id)
      or (staff.role='campus_admin' and staff.organisation_id=learner.organisation_id and staff.campus_id=learner.campus_id)
      or (staff.role='trainer' and staff.organisation_id=learner.organisation_id and staff.group_id is not null and staff.group_id=learner.group_id)
    )
), all_rows as materialized (
  select a.id attempt_id,a.owner_id learner_id,a.completed_at,2 source_order,pv.exam_key,pv.package_version,
    pp.profile_key,a.purpose::text purpose,a.actor_classification,a.analytics_eligible,r.raw_score,r.raw_percentage,r.passed,
    r.domain_summary,coalesce(rs.release_status::text,'withheld') review_status,true server_authoritative,'protected' source
  from exam_delivery.attempts a
  join visible_learners vl on vl.learner_id=a.owner_id
  join exam_delivery.package_versions pv on pv.id=a.package_version_id
  join exam_delivery.package_profiles pp on pp.id=a.package_profile_id
  join exam_delivery.attempt_results r on r.attempt_id=a.id
  left join exam_delivery.review_snapshots rs on rs.attempt_id=a.id
  where a.status='completed'
  union all
  select a.id,a.user_id,a.submitted_at,1,a.exam_key,coalesce(a.exam_version,'legacy'),a.profile_id,
    classified.purpose,null,(classified.purpose in ('assigned_assessment','self_directed_exam')),
    r.raw_score,r.raw_percentage,r.passed,coalesce(r.domain_breakdown,'{}'::jsonb),'withheld',false,'legacy_authoritative'
  from public.exam_attempts a
  join visible_learners vl on vl.learner_id=a.user_id
  join public.exam_results r on r.attempt_id=a.id and r.user_id=a.user_id
  cross join lateral (select exam_delivery.classify_legacy_result(
    a.profile_id,a.mode_label,a.attempt_snapshot,r.result_snapshot,a.status,a.submitted_at,r.raw_score,r.raw_percentage
  ) purpose) classified
  where a.status='submitted' and a.submitted_at is not null
    and not exists(select 1 from exam_delivery.attempts protected_attempt where protected_attempt.id=a.id)
), eligible as (
  select * from all_rows
  where p_cursor is null or (completed_at,attempt_id,source_order)<
    ((split_part(p_cursor,'|',1))::timestamptz,(split_part(p_cursor,'|',2))::uuid,(split_part(p_cursor,'|',3))::integer)
  order by completed_at desc,attempt_id desc,source_order desc
), bounded as (
  select * from eligible limit least(greatest(p_page_size,1),50)+1
), page as (
  select * from bounded limit least(greatest(p_page_size,1),50)
)
select jsonb_build_object(
  'ok',true,
  'items',coalesce((select jsonb_agg(jsonb_build_object(
    'attemptId',attempt_id,'learnerId',learner_id,'examKey',exam_key,'packageVersion',package_version,'profileKey',profile_key,
    'purpose',purpose,'actorClassification',actor_classification,'analyticsEligible',analytics_eligible,'completedAt',completed_at,
    'score',raw_score,'percentage',raw_percentage,'passed',passed,'domainSummary',domain_summary,'serverAuthoritative',server_authoritative,
    'reviewStatus',review_status,'source',source
  ) order by completed_at desc,attempt_id desc,source_order desc) from page),'[]'::jsonb),
  'returnedCount',(select count(*) from page),
  'totalCount',(select count(*) from all_rows),
  'remainingCount',greatest((select count(*) from eligible)-(select count(*) from page),0),
  'nextCursor',case when (select count(*) from bounded)>least(greatest(p_page_size,1),50)
    then (select completed_at::text||'|'||attempt_id::text||'|'||source_order::text from page order by completed_at,attempt_id,source_order limit 1)
    else null end
)
$$;

create or replace function exam_delivery.staff_dashboard_scope(p_actor_id uuid,p_request jsonb)
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
    select m.organisation_id,case when v_role='campus_admin' then m.campus_id end into v_org,v_campus
    from public.memberships m where m.user_id=p_actor_id and m.status='active' and m.role=v_role order by m.created_at limit 1;
  end if;
  if v_global and v_org is not null and not exists(select 1 from public.organisations o where o.id=v_org and o.status='active') then return jsonb_build_object('ok',false,'code','scope_forbidden'); end if;
  if v_org is not null and v_campus is not null and not exists(select 1 from public.campuses c where c.id=v_campus and c.organisation_id=v_org and c.status='active') then return jsonb_build_object('ok',false,'code','scope_forbidden'); end if;
  if v_group is not null and not exists(select 1 from public.groups g where g.id=v_group and g.organisation_id=v_org
    and (v_campus is null or g.campus_id=v_campus) and g.status='active'
    and (v_role<>'trainer' or exists(select 1 from public.memberships m where m.user_id=p_actor_id and m.status='active' and m.role='trainer' and m.group_id=g.id))) then return jsonb_build_object('ok',false,'code','scope_forbidden'); end if;
  if v_assignment is not null and not exists(select 1 from public.exam_assignments a where a.id=v_assignment
    and a.organisation_id=v_org and (v_campus is null or a.campus_id=v_campus)
    and (v_group is null or a.group_id=v_group or (a.student_user_id is not null and exists(select 1 from public.memberships m where m.user_id=a.student_user_id and m.status='active' and m.role='student' and m.group_id=v_group)))
    and a.status<>'archived') then return jsonb_build_object('ok',false,'code','scope_forbidden'); end if;
  return jsonb_build_object('ok',true,'role',v_role,
    'locks',jsonb_build_object('organisation',not v_global,'campus',v_role='campus_admin'),
    'selection',jsonb_build_object('organisationId',v_org,'campusId',v_campus,'groupId',v_group,'assignmentId',v_assignment),
    'organisations',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'name',o.name) order by o.name,o.id) from public.organisations o where o.status='active' and (v_global or o.id=v_org)),'[]'::jsonb),
    'campuses',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name) order by c.name,c.id) from public.campuses c where c.status='active' and v_org is not null and c.organisation_id=v_org and (v_role<>'campus_admin' or c.id=v_campus)),'[]'::jsonb),
    'groups',coalesce((select jsonb_agg(jsonb_build_object('id',g.id,'name',g.name,'campusId',g.campus_id) order by g.name,g.id) from public.groups g where g.status='active' and v_org is not null and g.organisation_id=v_org and (v_campus is null or g.campus_id=v_campus) and (v_role<>'trainer' or exists(select 1 from public.memberships m where m.user_id=p_actor_id and m.status='active' and m.role='trainer' and m.group_id=g.id))),'[]'::jsonb),
    'assignmentPage',(with eligible as (select a.* from public.exam_assignments a where a.status<>'archived' and v_org is not null
        and a.organisation_id=v_org and (v_group is null or a.group_id=v_group or (a.student_user_id is not null and exists(select 1 from public.memberships m where m.user_id=a.student_user_id and m.status='active' and m.role='student' and m.group_id=v_group)))
        and (v_campus is null or a.campus_id=v_campus)
        and (v_role<>'trainer' or exists(select 1 from public.memberships tm where tm.user_id=p_actor_id and tm.status='active' and tm.role='trainer' and tm.group_id=a.group_id))
        and (v_cursor_created is null or (a.created_at,a.id)<(v_cursor_created,v_cursor_id)) order by a.created_at desc,a.id desc),
      bounded as(select * from eligible limit v_size+1), page as(select * from bounded limit v_size)
      select jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object(
          'id',id,'name',title,'organisationId',organisation_id,'campusId',campus_id,'groupId',group_id,'studentUserId',student_user_id,
          'examKey',exam_key,'profileId',profile_id,'status',status,'dueAt',due_at,'availableFrom',available_from,'createdAt',created_at
        ) order by created_at desc,id desc) from page),'[]'::jsonb),
        'nextCursor',case when (select count(*) from bounded)>v_size then (select created_at::text||'|'||id::text from page order by created_at,id limit 1) end,
        'complete',(select count(*) from bounded)<=v_size,'returnedCount',(select count(*) from page))),
    'learnerIds',coalesce((select jsonb_agg(distinct m.user_id) from public.exam_assignments ea
      join public.memberships m on m.status='active' and m.role='student' and ((ea.student_user_id is not null and m.user_id=ea.student_user_id) or (ea.student_user_id is null and ea.group_id is not null and m.group_id=ea.group_id))
      where v_org is not null and ea.status<>'archived' and ea.organisation_id=v_org and (v_campus is null or ea.campus_id=v_campus) and (v_group is null or ea.group_id=v_group)
        and (v_assignment is null or ea.id=v_assignment) and (v_role<>'trainer' or exists(select 1 from public.memberships tm where tm.user_id=p_actor_id and tm.status='active' and tm.role='trainer' and tm.group_id=ea.group_id))),'[]'::jsonb),
    'history',(with rows as (select a.id,a.owner_id,a.completed_at,a.source_assignment_id,pv.exam_key,pv.package_version,pp.profile_key,a.purpose::text,r.raw_score,r.raw_percentage,r.passed,r.domain_summary
      from exam_delivery.attempts a join exam_delivery.attempt_results r on r.attempt_id=a.id
      join exam_delivery.package_versions pv on pv.id=a.package_version_id join exam_delivery.package_profiles pp on pp.id=a.package_profile_id
      join public.exam_assignments ea on ea.id=a.source_assignment_id
      where v_org is not null and a.attribution_source='assignment' and a.status='completed' and a.analytics_eligible is true and a.purpose='assigned_assessment'
        and ea.status<>'archived' and ea.organisation_id=v_org and a.source_organisation_id=v_org
        and (v_campus is null or (ea.campus_id=v_campus and a.source_campus_id=v_campus))
        and (v_group is null or (ea.group_id=v_group and a.source_group_id=v_group)) and (v_assignment is null or ea.id=v_assignment)
        and (v_role<>'trainer' or exists(select 1 from public.memberships tm where tm.user_id=p_actor_id and tm.status='active' and tm.role='trainer' and tm.group_id=ea.group_id)))
      select jsonb_build_object('items',coalesce(jsonb_agg(jsonb_build_object(
        'attemptId',id,'learnerId',owner_id,'assignmentId',source_assignment_id,'examKey',exam_delivery.normalize_exam_key(exam_key),
        'packageVersion',package_version,'profileKey',profile_key,'purpose',purpose,'completedAt',completed_at,'score',raw_score,
        'percentage',raw_percentage,'passed',passed,'domainSummary',domain_summary,'serverAuthoritative',true,'source','protected'
      ) order by completed_at desc,id desc),'[]'::jsonb),'totalCount',count(*),'completedCount',count(*),
        'averagePercentage',round(avg(raw_percentage),2),'passRate',round(100.0*count(*) filter(where passed)/nullif(count(*),0),2)) from rows));
end $$;

alter function exam_delivery.list_staff_history(uuid,text,integer) owner to postgres;
alter function exam_delivery.staff_dashboard_scope(uuid,jsonb) owner to postgres;

revoke execute on function exam_delivery.list_staff_history(uuid,text,integer),exam_delivery.staff_dashboard_scope(uuid,jsonb)
  from public,anon,authenticated,service_role;

grant execute on function exam_delivery.list_staff_history(uuid,text,integer),exam_delivery.staff_dashboard_scope(uuid,jsonb)
  to service_role;
