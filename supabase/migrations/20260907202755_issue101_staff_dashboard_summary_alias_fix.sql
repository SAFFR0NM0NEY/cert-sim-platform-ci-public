create or replace function exam_delivery.staff_dashboard_summary(
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
      'mostActive',coalesce((select jsonb_agg(to_jsonb(top_row) order by top_row."totalAttempts" desc,top_row.learner_id)
        from (select learner_id,display_name,activity_count "totalAttempts",latest_activity "latestAttemptDate"
          from named_activity where activity_count>0 order by activity_count desc,learner_id limit 5) top_row),'[]'::jsonb),
      'leastActive',coalesce((select jsonb_agg(to_jsonb(bottom_row) order by bottom_row."totalAttempts",bottom_row.learner_id)
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

alter function exam_delivery.staff_dashboard_summary(uuid,jsonb,jsonb) owner to postgres;
revoke execute on function exam_delivery.staff_dashboard_summary(uuid,jsonb,jsonb)
  from public, anon, authenticated, service_role;
