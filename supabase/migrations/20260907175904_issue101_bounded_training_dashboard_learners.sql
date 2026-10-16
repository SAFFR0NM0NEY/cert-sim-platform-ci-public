-- Issue #101: bound staff learner/readiness payloads while preserving full-scope aggregates.
-- Production application is deferred to a separately authorized phase.

alter function exam_delivery.staff_dashboard_aggregates(uuid,jsonb)
  rename to staff_dashboard_aggregates_issue101_base;

create function exam_delivery.staff_learner_readiness_status(p_row jsonb)
returns text
language sql
immutable
security definer
set search_path = ''
as $$
  select case
    when coalesce((p_row->>'assessmentCount')::integer, 0) = 0 then 'not-started'
    when coalesce((p_row->>'assessmentCount')::integer, 0) < 5 then 'insufficient-data'
    when coalesce((p_row->>'needsReviewCount')::integer, 0) >= 2
      or coalesce((p_row->>'averagePercentage')::numeric * 10, 1000) < 650 then 'at-risk'
    when coalesce((p_row->>'averagePercentage')::numeric * 10, 0) >= 800
      and greatest(coalesce((p_row->>'latestPercentage')::numeric * 10, 0),
        coalesce((p_row->>'bestPercentage')::numeric * 10, 0)) >= 850
      and coalesce((p_row->>'passRate')::numeric, 0) >= 80
      and (select count(*) from jsonb_array_elements(coalesce(p_row->'domains','[]'::jsonb)) domain
        where (domain->>'averagePercentage')::numeric < 70) <= 1 then 'ready'
    when greatest(coalesce((p_row->>'latestPercentage')::numeric * 10, 0),
        coalesce((p_row->>'bestPercentage')::numeric * 10, 0)) >= 700
      and (coalesce((p_row->>'averagePercentage')::numeric * 10, 0) >= 750
        or coalesce((p_row->>'latestPercentage')::numeric * 10, 0) >= 800) then 'almost-ready'
    else 'needs-review'
  end
$$;

create function exam_delivery.staff_dashboard_learner_page(
  p_actor_id uuid, p_request jsonb, p_full jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '12s'
as $$
declare
  v_options jsonb;
  v_role text;
  v_org uuid;
  v_campus uuid;
  v_group uuid;
  v_assignment uuid;
  v_size integer := coalesce(nullif(p_request->>'learnerPageSize','')::integer, 25);
  v_search text := lower(nullif(trim(p_request->>'search'),''));
  v_readiness text := nullif(trim(p_request->>'readinessStatus'),'');
  v_cursor jsonb;
  v_cursor_name text;
  v_cursor_learner uuid;
  v_cursor_exam text;
begin
  if v_size < 1 or v_size > 50
    or (v_readiness is not null and v_readiness not in
      ('ready','almost-ready','needs-review','at-risk','insufficient-data','not-started')) then
    return jsonb_build_object('ok',false,'code','invalid_request');
  end if;
  v_options := exam_delivery.staff_scope_options(
    p_actor_id, jsonb_build_object('organisationId',p_request->>'organisationId'));
  if v_options->>'ok' <> 'true' then return v_options; end if;
  v_role := v_options->>'role';
  v_org := nullif(v_options#>>'{selection,organisationId}','')::uuid;
  begin
    v_campus := nullif(p_request->>'campusId','')::uuid;
    v_group := nullif(p_request->>'groupId','')::uuid;
    v_assignment := nullif(p_request->>'assignmentId','')::uuid;
    if nullif(p_request->>'learnerCursor','') is not null then
      v_cursor := convert_from(decode(p_request->>'learnerCursor','base64'),'utf8')::jsonb;
      if jsonb_typeof(v_cursor) <> 'object'
        or (select array_agg(key order by key) from jsonb_object_keys(v_cursor) key)
          <> array['exam','learner','name']::text[] then
        return jsonb_build_object('ok',false,'code','invalid_request');
      end if;
      v_cursor_name := v_cursor->>'name';
      v_cursor_learner := (v_cursor->>'learner')::uuid;
      v_cursor_exam := v_cursor->>'exam';
    end if;
  exception when others then
    return jsonb_build_object('ok',false,'code','invalid_request');
  end;
  if v_org is null then return jsonb_build_object('ok',false,'code','scope_required'); end if;
  if v_campus is not null and not exists(
    select 1 from jsonb_array_elements(v_options->'campuses') item where item->>'id'=v_campus::text
  ) then return jsonb_build_object('ok',false,'code','scope_forbidden'); end if;
  if v_group is not null and not exists(
    select 1 from jsonb_array_elements(v_options->'groups') item where item->>'id'=v_group::text
  ) then return jsonb_build_object('ok',false,'code','scope_forbidden'); end if;

  return (
    with visible as materialized (
      select distinct on (m.user_id) m.id membership_id, m.user_id learner_id, m.group_id, m.campus_id,
        coalesce(nullif(p.display_name,''),nullif(p.full_name,''),'Learner') display_name,
        coalesce(p.email,'') email, coalesce(g.name,'') group_name,
        coalesce(c.name,'') campus_name, m.status
      from public.memberships m
      join public.profiles p on p.id=m.user_id
      left join public.groups g on g.id=m.group_id
      left join public.campuses c on c.id=m.campus_id
      where m.status='active' and m.role='student' and m.organisation_id=v_org
        and (v_campus is null or m.campus_id=v_campus)
        and (v_group is null or m.group_id=v_group)
        and (v_assignment is null or exists(select 1 from public.exam_assignments a
          where a.id=v_assignment and (a.student_user_id=m.user_id
            or (a.student_user_id is null and a.group_id=m.group_id))))
        and (v_role<>'campus_admin' or exists(select 1 from public.memberships staff
          where staff.user_id=p_actor_id and staff.status='active'
            and staff.role='campus_admin' and staff.campus_id=m.campus_id))
        and (v_role<>'trainer' or exists(select 1 from public.memberships staff
          where staff.user_id=p_actor_id and staff.status='active'
            and staff.role='trainer' and staff.group_id=m.group_id))
      order by m.user_id, m.created_at, m.id
    ), analytics_rows as materialized (
      select row, row->>'learnerId' learner_id_text,
        coalesce(row->>'examKey','') exam_key,
        exam_delivery.staff_learner_readiness_status(row) readiness_status
      from jsonb_array_elements(coalesce(p_full->'learners','[]'::jsonb)) row
    ), candidates as materialized (
      select visible.*, coalesce(analytics_rows.exam_key,'') exam_key,
        coalesce(analytics_rows.readiness_status,'not-started') readiness_status,
        analytics_rows.row analytics
      from visible left join analytics_rows
        on analytics_rows.learner_id_text=visible.learner_id::text
      where (v_search is null or lower(visible.display_name) like '%'||v_search||'%'
          or lower(visible.email) like '%'||v_search||'%'
          or lower(visible.group_name) like '%'||v_search||'%'
          or lower(coalesce(analytics_rows.exam_key,'')) like '%'||v_search||'%')
        and (v_readiness is null
          or coalesce(analytics_rows.readiness_status,'not-started')=v_readiness)
    ), ordered as materialized (
      select * from candidates
      where v_cursor is null or
        (lower(display_name),learner_id,exam_key) >
        (v_cursor_name,v_cursor_learner,v_cursor_exam)
      order by lower(display_name),learner_id,exam_key
    ), bounded as materialized (select * from ordered limit v_size+1),
    page as materialized (select * from bounded limit v_size)
    select jsonb_build_object(
      'items',coalesce((select jsonb_agg(jsonb_build_object(
        'membershipId',membership_id,'learnerId',learner_id,'displayName',display_name,'email',email,
        'groupId',group_id,'groupName',group_name,'campusId',campus_id,
        'campusName',campus_name,'status',status,'examKey',exam_key,
        'readinessStatus',readiness_status,'analytics',coalesce(analytics,'{}'::jsonb),
        'assignmentSummaries',coalesce((select jsonb_agg(jsonb_build_object(
          'assignmentId',item->>'assignmentId',
          'assignmentAttemptCount',coalesce((item->>'assignmentAttemptCount')::integer,0)
        )) from jsonb_array_elements(coalesce(p_full->'assignmentLearners','[]'::jsonb)) item
          where item->>'learnerId'=learner_id::text),'[]'::jsonb)
      ) order by lower(display_name),learner_id,exam_key) from page),'[]'::jsonb),
      'returnedCount',(select count(*) from page),
      'totalCount',(select count(*) from visible),
      'filteredCount',(select count(*) from candidates),
      'pageSize',v_size,
      'nextCursor',case when (select count(*) from bounded)>v_size then
        (select encode(convert_to(jsonb_build_object('name',lower(display_name),
          'learner',learner_id,'exam',exam_key)::text,'utf8'),'base64')
          from page order by lower(display_name) desc,learner_id desc,exam_key desc limit 1)
        else null end,
      'complete',(select count(*) from bounded)<=v_size
    )
  );
end
$$;

create function exam_delivery.staff_dashboard_summary(
  p_actor_id uuid, p_request jsonb, p_full jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '12s'
as $$
declare v_summary jsonb; v_options jsonb; v_org uuid; v_campus uuid; v_group uuid;
begin
  if p_full->>'ok' <> 'true' then return p_full; end if;
  v_options:=exam_delivery.staff_scope_options(p_actor_id,
    jsonb_build_object('organisationId',p_request->>'organisationId'));
  if v_options->>'ok'<>'true' then return v_options; end if;
  begin
    v_org:=nullif(v_options#>>'{selection,organisationId}','')::uuid;
    v_campus:=nullif(p_request->>'campusId','')::uuid;
    v_group:=nullif(p_request->>'groupId','')::uuid;
  exception when others then return jsonb_build_object('ok',false,'code','invalid_request'); end;
  with learner_rows as materialized (
    select row, row->>'learnerId' learner_id,
      exam_delivery.staff_learner_readiness_status(row) readiness_status
    from jsonb_array_elements(coalesce(p_full->'learners','[]'::jsonb)) row
  ), activity as materialized (
    select learner_id, sum((row->>'activityCount')::integer) activity_count,
      max(row->>'latestActivity') latest_activity
    from learner_rows group by learner_id
  ), named_activity as materialized (
    select activity.*,coalesce(nullif(profile.display_name,''),nullif(profile.full_name,''),'Learner') display_name
    from activity join public.profiles profile on profile.id=activity.learner_id::uuid
  ), group_scope as materialized (
    select item->>'id' group_id, item->>'name' group_name
    from jsonb_array_elements(coalesce(v_options->'groups','[]'::jsonb)) item
    where (v_group is null or item->>'id'=v_group::text)
      and (v_campus is null or item->>'campusId'=v_campus::text)
  )
  select (p_full - 'learners' - 'assignmentLearners') || jsonb_build_object(
    'readinessSummary',jsonb_build_object(
      'ready',(select count(*) from learner_rows where readiness_status='ready'),
      'almost-ready',(select count(*) from learner_rows where readiness_status='almost-ready'),
      'needs-review',(select count(*) from learner_rows where readiness_status='needs-review'),
      'at-risk',(select count(*) from learner_rows where readiness_status='at-risk'),
      'insufficient-data',(select count(*) from learner_rows where readiness_status='insufficient-data'),
      'not-started',(select count(*) from learner_rows where readiness_status='not-started')
    ),
    'activitySummary',jsonb_build_object(
      'mostActive',coalesce((select jsonb_agg(to_jsonb(top_row) order by activity_count desc,learner_id)
        from (select learner_id,display_name,activity_count "totalAttempts",latest_activity "latestAttemptDate"
          from named_activity where activity_count>0 order by activity_count desc,learner_id limit 5) top_row),'[]'::jsonb),
      'leastActive',coalesce((select jsonb_agg(to_jsonb(bottom_row) order by activity_count,learner_id)
        from (select learner_id,display_name,activity_count "totalAttempts",latest_activity "latestAttemptDate"
          from named_activity where activity_count>0 order by activity_count,learner_id limit 5) bottom_row),'[]'::jsonb),
      'noAttemptCount',greatest(0,coalesce((p_full#>>'{totals,visibleLearners}')::integer,0)-
        (select count(*) from activity where activity_count>0)),
      'noAttemptPreview','[]'::jsonb
    ),
    'groups',coalesce((select jsonb_agg(coalesce(group_row,'{}'::jsonb) || jsonb_build_object(
      'groupId',group_scope.group_id,
      'studentCount',(select count(distinct membership.user_id) from public.memberships membership
        where membership.group_id=group_scope.group_id::uuid
          and membership.role='student' and membership.status='active'),
      'activeStudents',(select count(distinct membership.user_id) from public.memberships membership
        where membership.group_id=group_scope.group_id::uuid
          and membership.role='student' and membership.status='active'),
      'studentsWithAttempts',coalesce((group_row->>'assessedLearnerCount')::integer,0),
      'readyStudents',(select count(distinct membership.user_id) from public.memberships membership
        where membership.group_id=group_scope.group_id::uuid
          and membership.role='student' and membership.status='active'
          and exists(select 1 from learner_rows learner
            where learner.learner_id=membership.user_id::text and learner.readiness_status='ready')),
      'studentsWithoutAttempts',greatest(0,(select count(distinct membership.user_id)
        from public.memberships membership where membership.group_id=group_scope.group_id::uuid
          and membership.role='student' and membership.status='active')-
        coalesce((group_row->>'assessedLearnerCount')::integer,0))
    ) order by group_scope.group_name,group_scope.group_id)
      from group_scope left join lateral (select item group_row
        from jsonb_array_elements(coalesce(p_full->'groups','[]'::jsonb)) item
        where item->>'groupId'=group_scope.group_id) matched on true),'[]'::jsonb),
    'assignments',coalesce((select jsonb_agg(assignment_row || jsonb_build_object(
      'submittedCount',(select count(*) from jsonb_array_elements(coalesce(p_full->'assignmentLearners','[]'::jsonb)) item
        where item->>'assignmentId'=assignment_row->>'assignmentId'
          and coalesce((item->>'assignmentAttemptCount')::integer,0)>0),
      'readyCount',(select count(*) from jsonb_array_elements(coalesce(p_full->'assignmentLearners','[]'::jsonb)) item
        where item->>'assignmentId'=assignment_row->>'assignmentId'
          and coalesce((item->>'assignmentAttemptCount')::integer,0)>0
          and exists(select 1 from learner_rows learner where learner.learner_id=item->>'learnerId'
            and learner.row->>'examKey'=assignment_row->>'examKey'
            and learner.readiness_status='ready')),
      'completedButNotReadyCount',(select count(*) from jsonb_array_elements(coalesce(p_full->'assignmentLearners','[]'::jsonb)) item
        where item->>'assignmentId'=assignment_row->>'assignmentId'
          and coalesce((item->>'assignmentAttemptCount')::integer,0)>0
          and not exists(select 1 from learner_rows learner where learner.learner_id=item->>'learnerId'
            and learner.row->>'examKey'=assignment_row->>'examKey'
            and learner.readiness_status='ready')),
      'notStartedCount',greatest(0,coalesce((assignment_row->>'totalStudents')::integer,0)-
        (select count(*) from jsonb_array_elements(coalesce(p_full->'assignmentLearners','[]'::jsonb)) item
          where item->>'assignmentId'=assignment_row->>'assignmentId'
            and coalesce((item->>'assignmentAttemptCount')::integer,0)>0)),
      'dueSoonCount',case when (assignment_row->>'dueAt')::timestamptz between statement_timestamp()
          and statement_timestamp()+interval '7 days' then greatest(0,coalesce((assignment_row->>'totalStudents')::integer,0)-
            (select count(*) from jsonb_array_elements(coalesce(p_full->'assignmentLearners','[]'::jsonb)) item
              where item->>'assignmentId'=assignment_row->>'assignmentId'
                and coalesce((item->>'assignmentAttemptCount')::integer,0)>0)) else 0 end,
      'overdueCount',case when (assignment_row->>'dueAt')::timestamptz < statement_timestamp()
        then greatest(0,coalesce((assignment_row->>'totalStudents')::integer,0)-
          (select count(*) from jsonb_array_elements(coalesce(p_full->'assignmentLearners','[]'::jsonb)) item
            where item->>'assignmentId'=assignment_row->>'assignmentId'
              and coalesce((item->>'assignmentAttemptCount')::integer,0)>0)) else 0 end
    )) from jsonb_array_elements(coalesce(p_full->'assignments','[]'::jsonb)) assignment_row),'[]'::jsonb)
  ) into v_summary;
  return v_summary;
end
$$;

create function exam_delivery.staff_dashboard_aggregates(p_actor_id uuid,p_request jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '12s'
as $$
declare v_full jsonb;
begin
  v_full:=exam_delivery.staff_dashboard_aggregates_issue101_base(p_actor_id,p_request);
  return exam_delivery.staff_dashboard_summary(p_actor_id,p_request,v_full);
end
$$;

create or replace function exam_delivery.staff_dashboard_query(p_actor_id uuid,p_request jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '15s'
as $$
declare v_page jsonb; v_full jsonb; v_analytics jsonb; v_learner_page jsonb;
begin
  v_page:=exam_delivery.staff_dashboard_query_issue59_base(p_actor_id,p_request);
  if v_page->>'ok'<>'true' then return v_page; end if;
  v_full:=exam_delivery.staff_dashboard_aggregates_issue101_base(p_actor_id,p_request);
  if v_full->>'ok'<>'true' then return v_full; end if;
  v_analytics:=exam_delivery.staff_dashboard_summary(p_actor_id,p_request,v_full);
  v_learner_page:=case when coalesce(p_request->>'workflow','results') in ('analytics','assignments','students','results')
    then exam_delivery.staff_dashboard_learner_page(p_actor_id,p_request,v_full)
    else jsonb_build_object('items','[]'::jsonb,'returnedCount',0,
      'totalCount',coalesce((v_full#>>'{totals,visibleLearners}')::integer,0),
      'filteredCount',coalesce((v_full#>>'{totals,visibleLearners}')::integer,0),
      'pageSize',coalesce(nullif(p_request->>'learnerPageSize','')::integer,25),
      'nextCursor',null,'complete',true) end;
  if v_learner_page->>'ok'='false' then return v_learner_page; end if;
  return (v_page - 'learnerIds') || jsonb_build_object(
    'analytics',v_analytics-'ok','learnerPage',v_learner_page);
end
$$;

alter function exam_delivery.staff_dashboard_aggregates_issue101_base(uuid,jsonb) owner to postgres;
alter function exam_delivery.staff_learner_readiness_status(jsonb) owner to postgres;
alter function exam_delivery.staff_dashboard_learner_page(uuid,jsonb,jsonb) owner to postgres;
alter function exam_delivery.staff_dashboard_summary(uuid,jsonb,jsonb) owner to postgres;
alter function exam_delivery.staff_dashboard_aggregates(uuid,jsonb) owner to postgres;
alter function exam_delivery.staff_dashboard_query(uuid,jsonb) owner to postgres;

revoke execute on function exam_delivery.staff_dashboard_aggregates_issue101_base(uuid,jsonb),
  exam_delivery.staff_learner_readiness_status(jsonb),
  exam_delivery.staff_dashboard_learner_page(uuid,jsonb,jsonb),
  exam_delivery.staff_dashboard_summary(uuid,jsonb,jsonb),
  exam_delivery.staff_dashboard_aggregates(uuid,jsonb),
  exam_delivery.staff_dashboard_query(uuid,jsonb)
from public,anon,authenticated,service_role;
grant execute on function exam_delivery.staff_dashboard_query(uuid,jsonb) to service_role;
