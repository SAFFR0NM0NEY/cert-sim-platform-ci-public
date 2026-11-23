-- Issue #150: deterministic, bounded staff learner detail under the same
-- organisation/campus/group authority as the protected Training Dashboard.

-- Keep learner-detail history and analytics on the existing Training Dashboard
-- policy path. The internal exactLearnerId selector is never accepted by the
-- Edge route; staff_learner_detail adds it only after exact-membership approval.
do $issue150_history_scope$
declare
  v_definition text;
  v_before text;
begin
  select replace(pg_get_functiondef(
    'exam_delivery.staff_dashboard_query_issue59_base(uuid,jsonb)'::regprocedure
  ), chr(13), '') into v_definition;

  v_before := v_definition;
  v_definition := replace(v_definition,
    '  v_history jsonb; v_assignment_page jsonb; v_learner_ids jsonb;',
    '  v_history jsonb; v_assignment_page jsonb; v_learner_ids jsonb; v_exact_learner uuid;');
  if v_definition = v_before then
    raise exception 'Issue #150 could not add the exact learner selector';
  end if;

  v_before := v_definition;
  v_definition := replace(v_definition,
    $needle$    v_assignment:=nullif(p_request->>'assignmentId','')::uuid;
    if nullif(p_request->>'cursor','') is not null then$needle$,
    $replacement$    v_assignment:=nullif(p_request->>'assignmentId','')::uuid;
    v_exact_learner:=nullif(p_request->>'exactLearnerId','')::uuid;
    if nullif(p_request->>'cursor','') is not null then$replacement$);
  if v_definition = v_before then
    raise exception 'Issue #150 could not parse the exact learner selector';
  end if;

  v_before := v_definition;
  v_definition := replace(v_definition,
    $needle$    where m.status='active' and m.role='student' and m.organisation_id=v_org and (v_campus is null or m.campus_id=v_campus) and (v_group is null or m.group_id=v_group)$needle$,
    $replacement$    where m.status='active' and m.role='student' and m.organisation_id=v_org and (v_campus is null or m.campus_id=v_campus) and (v_group is null or m.group_id=v_group)
      and (v_exact_learner is null or m.user_id=v_exact_learner)$replacement$);
  if v_definition = v_before then
    raise exception 'Issue #150 could not bind visible history learners';
  end if;

  v_before := v_definition;
  v_definition := replace(v_definition,
    $needle$      and v_workflow in ('overview','analytics','students','results')
      and (v_assignment is null or a.source_assignment_id=v_assignment or (a.source_assignment_id is null and exists ($needle$,
    $replacement$      and v_workflow in ('overview','analytics','students','results')
      and (a.attribution_source is distinct from 'assignment' or (
        a.source_organisation_id=v_org
        and (v_campus is null or a.source_campus_id=v_campus)
        and (v_group is null or a.source_group_id=v_group)
      ))
      and (v_assignment is null or a.source_assignment_id=v_assignment or (a.source_assignment_id is null and exists ($replacement$);
  if v_definition = v_before then
    raise exception 'Issue #150 could not bind protected history attribution';
  end if;

  v_before := v_definition;
  v_definition := replace(v_definition,
    $needle$    'totalCount',(select count(*) from filtered),'completedCount',(select count(*) from filtered),'returnedCount',(select count(*) from page),
    'nextCursor'$needle$,
    $replacement$    'totalCount',(select count(*) from filtered),'completedCount',(select count(*) from filtered),'returnedCount',(select count(*) from page),
    'remainingCount',greatest((select count(*) from ordered)-(select count(*) from page),0),
    'nextCursor'$replacement$);
  if v_definition = v_before then
    raise exception 'Issue #150 could not preserve bounded history pagination';
  end if;

  execute v_definition;
end
$issue150_history_scope$;

-- The same immutable source-scope rule must feed Issue #101 learner analytics,
-- otherwise a hidden assignment can still change counts and latest-attempt IDs.
do $issue150_analytics_scope$
declare
  v_definition text;
  v_before text;
begin
  select replace(pg_get_functiondef(
    'exam_delivery.staff_dashboard_aggregates_issue101_base(uuid,jsonb)'::regprocedure
  ), chr(13), '') into v_definition;

  v_before := v_definition;
  v_definition := replace(v_definition,
    $needle$        and attempt.purpose in ('assigned_assessment','self_directed_exam')
        and (v_exam is null or exam_delivery.normalize_exam_key(pv.exam_key) =$needle$,
    $replacement$        and attempt.purpose in ('assigned_assessment','self_directed_exam')
        and (attempt.attribution_source is distinct from 'assignment' or (
          attempt.source_organisation_id=v_org
          and (v_campus is null or attempt.source_campus_id=v_campus)
          and (v_group is null or attempt.source_group_id=v_group)
        ))
        and (v_exam is null or exam_delivery.normalize_exam_key(pv.exam_key) =$replacement$);
  if v_definition = v_before then
    raise exception 'Issue #150 could not bind protected analytics attribution';
  end if;

  execute v_definition;
end
$issue150_analytics_scope$;

create function exam_delivery.staff_learner_detail(
  p_actor_id uuid,
  p_request jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '15s'
as $$
declare
  v_options jsonb;
  v_full jsonb;
  v_scoped_dashboard jsonb;
  v_history jsonb;
  v_effective_request jsonb;
  v_learner jsonb;
  v_assignment_page jsonb;
  v_learner_page jsonb;
  v_assignment_analytics jsonb;
  v_role text;
  v_membership_id uuid;
  v_learner_id uuid;
  v_org uuid;
  v_campus uuid;
  v_group uuid;
  v_assignment uuid;
  v_exam text := nullif(trim(p_request->>'examKey'), '');
  v_cursor text := nullif(p_request->>'cursor', '');
  v_page_size integer := coalesce(nullif(p_request->>'pageSize', '')::integer, 25);
begin
  if p_actor_id is null or p_request is null or jsonb_typeof(p_request) <> 'object'
    or v_page_size < 1 or v_page_size > 25
    or length(coalesce(v_cursor, '')) > 500
    or (v_exam is not null and v_exam !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  begin
    v_membership_id := nullif(p_request->>'membershipId', '')::uuid;
    v_campus := nullif(p_request->>'campusId', '')::uuid;
    v_group := nullif(p_request->>'groupId', '')::uuid;
    v_assignment := nullif(p_request->>'assignmentId', '')::uuid;
  exception when others then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end;
  if v_membership_id is null then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  v_options := exam_delivery.staff_scope_options(
    p_actor_id,
    jsonb_build_object('organisationId', p_request->>'organisationId')
  );
  if v_options->>'ok' <> 'true' then return v_options; end if;
  v_role := v_options->>'role';
  v_org := nullif(v_options#>>'{selection,organisationId}', '')::uuid;
  if v_org is null then
    return jsonb_build_object('ok', false, 'code', 'scope_required');
  end if;
  if v_campus is not null and not exists (
    select 1 from jsonb_array_elements(v_options->'campuses') item
    where item->>'id' = v_campus::text
  ) then return jsonb_build_object('ok', false, 'code', 'not_visible'); end if;
  if v_group is not null and not exists (
    select 1 from jsonb_array_elements(v_options->'groups') item
    where item->>'id' = v_group::text
  ) then return jsonb_build_object('ok', false, 'code', 'not_visible'); end if;
  if v_assignment is not null and not exists (
    select 1 from jsonb_array_elements(v_options->'assignments') item
    where item->>'id' = v_assignment::text
  ) then return jsonb_build_object('ok', false, 'code', 'not_visible'); end if;

  select membership.user_id,
    jsonb_build_object(
      'membershipId', membership.id,
      'learnerId', membership.user_id,
      'displayName', coalesce(nullif(profile.display_name, ''), nullif(profile.full_name, ''), 'Learner'),
      'email', coalesce(profile.email, ''),
      'status', membership.status,
      'organisationId', membership.organisation_id,
      'organisationName', coalesce(organisation.name, ''),
      'campusId', membership.campus_id,
      'campusName', coalesce(campus.name, ''),
      'groupId', membership.group_id,
      'groupName', coalesce(student_group.name, '')
    )
  into v_learner_id, v_learner
  from public.memberships membership
  join public.profiles profile on profile.id = membership.user_id
  join public.organisations organisation on organisation.id = membership.organisation_id
  left join public.campuses campus on campus.id = membership.campus_id
  left join public.groups student_group on student_group.id = membership.group_id
  where membership.id = v_membership_id
    and membership.role = 'student'
    and membership.status = 'active'
    and membership.organisation_id = v_org
    and (v_campus is null or membership.campus_id = v_campus)
    and (v_group is null or membership.group_id = v_group)
    and (v_assignment is null or exists (
      select 1 from public.exam_assignments assignment
      where assignment.id = v_assignment
        and assignment.organisation_id = v_org
        and assignment.status <> 'archived'
        and (assignment.campus_id is null or assignment.campus_id = membership.campus_id)
        and (assignment.group_id is null or assignment.group_id = membership.group_id)
        and (assignment.student_user_id = membership.user_id
          or (assignment.student_user_id is null and assignment.group_id = membership.group_id))
    ))
    and (v_role <> 'campus_admin' or exists (
      select 1 from public.memberships staff
      where staff.user_id = p_actor_id
        and staff.status = 'active'
        and staff.role = 'campus_admin'
        and staff.campus_id = membership.campus_id
    ))
    and (v_role <> 'trainer' or exists (
      select 1 from public.memberships staff
      where staff.user_id = p_actor_id
        and staff.status = 'active'
        and staff.role = 'trainer'
        and staff.group_id = membership.group_id
    ));
  if v_learner_id is null then
    return jsonb_build_object('ok', false, 'code', 'not_visible');
  end if;

  -- Bind analytics to the exact membership's campus/group even when the caller
  -- came from a broader Platform Owner organisation view.
  v_effective_request := (p_request
    - 'membershipId' - 'cursor' - 'pageSize' - 'readinessStatus'
    - 'progressStatus' - 'search' - 'returnSection') || jsonb_build_object(
      'organisationId', v_org,
      'campusId', v_learner->>'campusId',
      'groupId', v_learner->>'groupId'
    );
  v_full := exam_delivery.staff_dashboard_aggregates_issue101_base(
    p_actor_id,
    v_effective_request
  );
  if v_full->>'ok' <> 'true' then return v_full; end if;

  v_scoped_dashboard := exam_delivery.staff_dashboard_query_issue59_base(
    p_actor_id,
    v_effective_request || jsonb_build_object(
      'exactLearnerId', v_learner_id,
      'workflow', 'results',
      'cursor', v_cursor,
      'pageSize', v_page_size
    )
  );
  if v_scoped_dashboard->>'ok' <> 'true' then return v_scoped_dashboard; end if;
  v_history := v_scoped_dashboard->'history';

  with matching_assignments as materialized (
    select assignment.*
    from public.exam_assignments assignment
    where assignment.organisation_id = v_org
      and assignment.status <> 'archived'
      and (assignment.campus_id is null or assignment.campus_id = (v_learner->>'campusId')::uuid)
      and (assignment.group_id is null or assignment.group_id = (v_learner->>'groupId')::uuid)
      and (assignment.student_user_id = v_learner_id
        or (assignment.student_user_id is null
          and assignment.group_id = (v_learner->>'groupId')::uuid))
      and (v_assignment is null or assignment.id = v_assignment)
      and (v_exam is null or exam_delivery.normalize_exam_key(assignment.exam_key) =
        exam_delivery.normalize_exam_key(v_exam))
    order by assignment.created_at desc, assignment.id desc
  ), bounded as materialized (
    select * from matching_assignments limit 51
  ), page as materialized (
    select * from bounded limit 50
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(jsonb_build_object(
      'id', assignment.id,
      'name', assignment.title,
      'organisationId', assignment.organisation_id,
      'campusId', assignment.campus_id,
      'groupId', assignment.group_id,
      'studentUserId', assignment.student_user_id,
      'examKey', exam_delivery.normalize_exam_key(assignment.exam_key),
      'profileId', assignment.profile_id,
      'status', assignment.status,
      'dueAt', assignment.due_at,
      'availableFrom', assignment.available_from,
      'createdAt', assignment.created_at
    ) order by assignment.created_at desc, assignment.id desc) from page assignment), '[]'::jsonb),
    'returnedCount', (select count(*) from page),
    'totalCount', (select count(*) from matching_assignments),
    'pageSize', 50,
    'complete', (select count(*) from bounded) <= 50
  ) into v_assignment_page;

  select jsonb_build_object(
    'items', coalesce(jsonb_agg(jsonb_build_object(
      'membershipId', v_membership_id,
      'learnerId', v_learner_id,
      'displayName', v_learner->>'displayName',
      'email', v_learner->>'email',
      'groupId', v_learner->'groupId',
      'groupName', v_learner->>'groupName',
      'campusId', v_learner->'campusId',
      'campusName', v_learner->>'campusName',
      'status', v_learner->>'status',
      'examKey', analytics->>'examKey',
      'readinessStatus', exam_delivery.staff_learner_readiness_status(analytics),
      'analytics', analytics,
      'assignmentSummaries', coalesce((
        select jsonb_agg(jsonb_build_object(
          'assignmentId', item->>'assignmentId',
          'assignmentAttemptCount', coalesce((item->>'assignmentAttemptCount')::integer, 0)
        ) order by item->>'assignmentId')
        from jsonb_array_elements(coalesce(v_full->'assignmentLearners', '[]'::jsonb)) item
        where item->>'learnerId' = v_learner_id::text
      ), '[]'::jsonb)
    ) order by analytics->>'examKey'), '[]'::jsonb),
    'returnedCount', count(*)::integer,
    'totalCount', 1,
    'filteredCount', (select count(*) from jsonb_array_elements(coalesce(v_full->'learners', '[]'::jsonb)) candidate
      where candidate->>'learnerId' = v_learner_id::text),
    'pageSize', 50,
    'nextCursor', null,
    'complete', (select count(*) from jsonb_array_elements(coalesce(v_full->'learners', '[]'::jsonb)) candidate
      where candidate->>'learnerId' = v_learner_id::text) <= 50
  ) into v_learner_page
  from (
    select candidate as analytics
    from jsonb_array_elements(coalesce(v_full->'learners', '[]'::jsonb)) candidate
    where candidate->>'learnerId' = v_learner_id::text
    order by candidate->>'examKey'
    limit 50
  ) bounded_analytics;

  if jsonb_array_length(v_learner_page->'items') = 0 then
    v_learner_page := jsonb_set(v_learner_page, '{items}', jsonb_build_array(jsonb_build_object(
      'membershipId', v_membership_id,
      'learnerId', v_learner_id,
      'displayName', v_learner->>'displayName',
      'email', v_learner->>'email',
      'groupId', v_learner->'groupId',
      'groupName', v_learner->>'groupName',
      'campusId', v_learner->'campusId',
      'campusName', v_learner->>'campusName',
      'status', v_learner->>'status',
      'examKey', coalesce(exam_delivery.normalize_exam_key(v_exam), ''),
      'readinessStatus', 'not-started',
      'analytics', jsonb_build_object(
        'learnerId', v_learner_id,
        'examKey', coalesce(exam_delivery.normalize_exam_key(v_exam), ''),
        'activityCount', 0,
        'assessmentCount', 0,
        'historicalCount', 0,
        'assessedLearnerCount', 1,
        'needsReviewCount', 0,
        'passedCount', 0,
        'latestActivity', null,
        'latestAttemptId', null,
        'latestPercentage', null,
        'bestPercentage', null,
        'lowestPercentage', null,
        'averagePercentage', null,
        'passRate', null,
        'domains', '[]'::jsonb
      ),
      'assignmentSummaries', coalesce((
        select jsonb_agg(jsonb_build_object(
          'assignmentId', item->>'assignmentId',
          'assignmentAttemptCount', coalesce((item->>'assignmentAttemptCount')::integer, 0)
        ) order by item->>'assignmentId')
        from jsonb_array_elements(coalesce(v_full->'assignmentLearners', '[]'::jsonb)) item
        where item->>'learnerId' = v_learner_id::text
      ), '[]'::jsonb)
    )), true);
    v_learner_page := jsonb_set(v_learner_page, '{returnedCount}', '1'::jsonb, true);
    v_learner_page := jsonb_set(v_learner_page, '{filteredCount}', '1'::jsonb, true);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'assignmentId', assignment->>'id',
    'examKey', assignment->>'examKey',
    'groupId', assignment->'groupId',
    'dueAt', assignment->'dueAt',
    'totalStudents', 1,
    'assessmentCount', coalesce((learner_assignment->>'assignmentAttemptCount')::integer, 0),
    'assessedLearnerCount', case when coalesce((learner_assignment->>'assignmentAttemptCount')::integer, 0) > 0 then 1 else 0 end,
    'submittedCount', case when coalesce((learner_assignment->>'assignmentAttemptCount')::integer, 0) > 0 then 1 else 0 end,
    'readyCount', case when coalesce((learner_assignment->>'assignmentAttemptCount')::integer, 0) > 0
      and learner_readiness = 'ready' then 1 else 0 end,
    'needsReviewCount', case when coalesce((learner_assignment->>'assignmentAttemptCount')::integer, 0) > 0
      and learner_readiness <> 'ready' then 1 else 0 end,
    'completedButNotReadyCount', case when coalesce((learner_assignment->>'assignmentAttemptCount')::integer, 0) > 0
      and learner_readiness <> 'ready' then 1 else 0 end,
    'notStartedCount', case when coalesce((learner_assignment->>'assignmentAttemptCount')::integer, 0) = 0 then 1 else 0 end,
    'dueSoonCount', case when coalesce((learner_assignment->>'assignmentAttemptCount')::integer, 0) = 0
      and (assignment->>'dueAt')::timestamptz between statement_timestamp() and statement_timestamp() + interval '7 days'
      then 1 else 0 end,
    'overdueCount', case when coalesce((learner_assignment->>'assignmentAttemptCount')::integer, 0) = 0
      and (assignment->>'dueAt')::timestamptz < statement_timestamp() then 1 else 0 end,
    'averagePercentage', learner_analytics->'averagePercentage'
  ) order by assignment->>'createdAt', assignment->>'id'), '[]'::jsonb)
  into v_assignment_analytics
  from jsonb_array_elements(v_assignment_page->'items') assignment
  left join lateral (
    select item learner_assignment
    from jsonb_array_elements(coalesce(v_full->'assignmentLearners', '[]'::jsonb)) item
    where item->>'assignmentId' = assignment->>'id'
      and item->>'learnerId' = v_learner_id::text
    limit 1
  ) matched_assignment on true
  left join lateral (
    select row learner_analytics,
      exam_delivery.staff_learner_readiness_status(row) learner_readiness
    from jsonb_array_elements(coalesce(v_full->'learners', '[]'::jsonb)) row
    where row->>'learnerId' = v_learner_id::text
      and row->>'examKey' = assignment->>'examKey'
    limit 1
  ) matched_analytics on true;

  return jsonb_build_object(
    'ok', true,
    'role', v_role,
    'locks', v_options->'locks',
    'selection', jsonb_build_object(
      'organisationId', v_org,
      'campusId', v_learner->'campusId',
      'groupId', v_learner->'groupId',
      'assignmentId', v_assignment
    ),
    'learner', v_learner,
    'assignmentPage', v_assignment_page,
    'learnerPage', v_learner_page,
    'assignmentAnalytics', v_assignment_analytics,
    'history', v_history - 'ok'
  );
exception when invalid_text_representation or numeric_value_out_of_range then
  return jsonb_build_object('ok', false, 'code', 'invalid_request');
end
$$;

create function public.certsim_protected_staff_learner_detail(
  p_actor_id uuid,
  p_request jsonb
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select exam_delivery.staff_learner_detail(p_actor_id, p_request)
$$;

alter function exam_delivery.staff_learner_detail(uuid,jsonb) owner to postgres;
alter function public.certsim_protected_staff_learner_detail(uuid,jsonb) owner to postgres;

revoke execute on function exam_delivery.staff_learner_detail(uuid,jsonb),
  public.certsim_protected_staff_learner_detail(uuid,jsonb)
from public, anon, authenticated, service_role;

grant execute on function exam_delivery.staff_learner_detail(uuid,jsonb),
  public.certsim_protected_staff_learner_detail(uuid,jsonb)
to service_role;
