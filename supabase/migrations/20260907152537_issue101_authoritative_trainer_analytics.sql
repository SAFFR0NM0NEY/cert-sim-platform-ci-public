-- Issue #101: make trainer analytics raw-point authoritative across every scope.
-- Production application is intentionally deferred to a separately authorized phase.

create or replace function exam_delivery.staff_dashboard_aggregates(
  p_actor_id uuid, p_request jsonb
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
  v_exam text := nullif(trim(p_request->>'examKey'), '');
  v_search text := lower(nullif(trim(p_request->>'search'), ''));
  v_status text := nullif(p_request->>'resultStatus', '');
begin
  v_options := exam_delivery.staff_scope_options(
    p_actor_id, jsonb_build_object('organisationId', p_request->>'organisationId')
  );
  if v_options->>'ok' <> 'true' then return v_options; end if;
  v_role := v_options->>'role';
  v_org := nullif(v_options#>>'{selection,organisationId}', '')::uuid;
  begin
    v_campus := nullif(p_request->>'campusId', '')::uuid;
    v_group := nullif(p_request->>'groupId', '')::uuid;
    v_assignment := nullif(p_request->>'assignmentId', '')::uuid;
  exception when others then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end;
  if v_org is null then return jsonb_build_object('ok', false, 'code', 'scope_required'); end if;
  if v_assignment is not null and not exists (
    select 1 from jsonb_array_elements(v_options->'assignments') item
    where item->>'id' = v_assignment::text
  ) then return jsonb_build_object('ok', false, 'code', 'scope_forbidden'); end if;

  return (
    with assignment_scope as materialized (
      select a.* from public.exam_assignments a
      where a.id = v_assignment
    ), visible_learners as materialized (
      select distinct m.user_id learner_id, m.group_id, p.display_name,
        p.full_name, p.email
      from public.memberships m join public.profiles p on p.id = m.user_id
      where m.status = 'active' and m.role = 'student'
        and m.organisation_id = v_org
        and (v_campus is null or m.campus_id = v_campus)
        and (v_group is null or m.group_id = v_group)
        and (v_assignment is null or exists (
          select 1 from assignment_scope assignment
          where assignment.student_user_id = m.user_id
             or (assignment.student_user_id is null and assignment.group_id = m.group_id)
        ))
        and (v_role <> 'campus_admin' or exists(select 1 from public.memberships staff
          where staff.user_id = p_actor_id and staff.status = 'active'
            and staff.role = 'campus_admin' and staff.campus_id = m.campus_id))
        and (v_role <> 'trainer' or exists(select 1 from public.memberships staff
          where staff.user_id = p_actor_id and staff.status = 'active'
            and staff.role = 'trainer' and staff.group_id = m.group_id))
    ), all_rows as materialized (
      select attempt.id attempt_id, attempt.owner_id learner_id,
        exam_delivery.normalize_exam_key(pv.exam_key) exam_key,
        attempt.completed_at, result.raw_score, result.max_score, result.raw_percentage, result.passed,
        result.domain_summary, attempt.source_assignment_id,
        'protected'::text source
      from exam_delivery.attempts attempt
      join visible_learners learner on learner.learner_id = attempt.owner_id
      join exam_delivery.attempt_results result on result.attempt_id = attempt.id
      join exam_delivery.package_versions pv on pv.id = attempt.package_version_id
      where attempt.status = 'completed' and attempt.analytics_eligible
        and attempt.purpose in ('assigned_assessment','self_directed_exam')
        and (v_exam is null or exam_delivery.normalize_exam_key(pv.exam_key) =
          exam_delivery.normalize_exam_key(v_exam))
        and (v_assignment is null or attempt.source_assignment_id = v_assignment
          or (attempt.source_assignment_id is null and exists (
            select 1 from assignment_scope assignment
            where exam_delivery.normalize_exam_key(assignment.exam_key) =
                  exam_delivery.normalize_exam_key(pv.exam_key)
              and attempt.completed_at >= coalesce(assignment.available_from, assignment.created_at)
              and (assignment.due_at is null or attempt.completed_at <= assignment.due_at)
              and (select count(*) from public.exam_assignments candidate
                where candidate.organisation_id=v_org
                  and exam_delivery.normalize_exam_key(candidate.exam_key)=exam_delivery.normalize_exam_key(pv.exam_key)
                  and (candidate.student_user_id=attempt.owner_id or
                    (candidate.student_user_id is null and exists(select 1 from public.memberships candidate_membership
                      where candidate_membership.user_id=attempt.owner_id
                        and candidate_membership.group_id=candidate.group_id
                        and candidate_membership.status='active' and candidate_membership.role='student')))
                  and attempt.completed_at>=coalesce(candidate.available_from,candidate.created_at)
                  and (candidate.due_at is null or attempt.completed_at<=candidate.due_at))=1
          )))
      union all
      select attempt.id attempt_id, attempt.user_id,
        exam_delivery.normalize_exam_key(attempt.exam_key), attempt.submitted_at,
        result.raw_score,
        coalesce(nullif(result.result_snapshot->>'maxScore','')::numeric,
          case when result.raw_percentage > 0 then result.raw_score * 100.0 / result.raw_percentage end),
        result.raw_percentage, result.passed, coalesce(result.domain_breakdown,'{}'::jsonb),
        null::uuid, 'legacy_authoritative'
      from public.exam_attempts attempt
      join visible_learners learner on learner.learner_id = attempt.user_id
      join public.exam_results result
        on result.attempt_id = attempt.id and result.user_id = attempt.user_id
      cross join lateral (select exam_delivery.classify_legacy_result(
        attempt.profile_id, attempt.mode_label, attempt.attempt_snapshot,
        result.result_snapshot, attempt.status, attempt.submitted_at,
        result.raw_score, result.raw_percentage
      ) purpose) classified
      where attempt.status = 'submitted' and attempt.submitted_at is not null
        and classified.purpose in ('assigned_assessment','self_directed_exam')
        and not exists(select 1 from exam_delivery.attempts protected where protected.id = attempt.id)
        and (v_exam is null or exam_delivery.normalize_exam_key(attempt.exam_key) =
          exam_delivery.normalize_exam_key(v_exam))
        and (v_assignment is null or exists (
          select 1 from assignment_scope assignment
          where exam_delivery.normalize_exam_key(assignment.exam_key) =
                exam_delivery.normalize_exam_key(attempt.exam_key)
            and attempt.submitted_at >= coalesce(assignment.available_from, assignment.created_at)
            and (assignment.due_at is null or attempt.submitted_at <= assignment.due_at)
            and (select count(*) from public.exam_assignments candidate
              where candidate.organisation_id=v_org
                and exam_delivery.normalize_exam_key(candidate.exam_key)=exam_delivery.normalize_exam_key(attempt.exam_key)
                and (candidate.student_user_id=attempt.user_id or
                  (candidate.student_user_id is null and exists(select 1 from public.memberships candidate_membership
                    where candidate_membership.user_id=attempt.user_id
                      and candidate_membership.group_id=candidate.group_id
                      and candidate_membership.status='active' and candidate_membership.role='student')))
                and attempt.submitted_at>=coalesce(candidate.available_from,candidate.created_at)
                and (candidate.due_at is null or attempt.submitted_at<=candidate.due_at))=1
        ))
    ), filtered as materialized (
      select row.* from all_rows row
      join visible_learners learner on learner.learner_id = row.learner_id
      where (v_status is null
        or (v_status = 'passed' and row.passed is true)
        or (v_status = 'needs-review' and row.passed is false)
        or (v_status = 'not-recorded' and row.passed is null))
        and (v_search is null or lower(coalesce(learner.display_name, '')) like '%'||v_search||'%'
          or lower(coalesce(learner.full_name, '')) like '%'||v_search||'%'
          or lower(coalesce(learner.email, '')) like '%'||v_search||'%'
          or lower(row.exam_key) like '%'||v_search||'%')
    ), learner_domain_rows as (
      select row.learner_id, row.exam_key, domain.key domain_key,
        count(*) sample_count,
        sum(coalesce((domain.value->>'earnedPoints')::numeric, 0)) raw_earned_points,
        sum(coalesce((domain.value->>'maxPoints')::numeric, 0)) raw_maximum_points,
        case
          when sum(coalesce((domain.value->>'maxPoints')::numeric, 0)) > 0
          then sum(coalesce((domain.value->>'earnedPoints')::numeric, 0)) * 100.0
            / sum(coalesce((domain.value->>'maxPoints')::numeric, 0))
          else avg((domain.value->>'percentage')::numeric)
        end average_percentage
      from filtered row cross join lateral jsonb_each(row.domain_summary) domain
      where domain.value ? 'percentage'
      group by row.learner_id, row.exam_key, domain.key
    ), assignment_targets as materialized (
      select assignment.id assignment_id, assignment.exam_key, assignment.due_at,
        learner.learner_id
      from public.exam_assignments assignment
      join visible_learners learner on assignment.student_user_id=learner.learner_id
        or (assignment.student_user_id is null and assignment.group_id=learner.group_id)
      where assignment.organisation_id=v_org and assignment.status not in ('archived','closed')
        and (v_campus is null or assignment.campus_id=v_campus)
        and (v_group is null or assignment.group_id=v_group)
        and (v_assignment is null or assignment.id=v_assignment)
        and (v_exam is null or exam_delivery.normalize_exam_key(assignment.exam_key)=exam_delivery.normalize_exam_key(v_exam))
    ), learner_scopes as materialized (
      select distinct learner_id,exam_key from filtered
      union
      select distinct learner_id,exam_delivery.normalize_exam_key(exam_key) from assignment_targets
    ), learner_rows as (
      select scope.learner_id, scope.exam_key, count(row.attempt_id) activity_count,
        count(row.attempt_id) assessment_count,
        count(*) filter(where source = 'legacy_authoritative') historical_count,
        max(completed_at) latest_activity, max(raw_percentage) best_percentage,
        min(raw_percentage) lowest_percentage,
        case when sum(coalesce(max_score,0))>0 then sum(coalesce(raw_score,0))*100.0/sum(coalesce(max_score,0)) else avg(raw_percentage) end average_percentage,
        (array_agg(raw_percentage order by completed_at desc))[1] latest_percentage,
        (array_agg(row.attempt_id order by completed_at desc) filter(where row.attempt_id is not null))[1] latest_attempt_id,
        count(*) filter(where passed) passed_count,
        count(*) filter(where passed is not null) decided_count,
        count(*) filter(where passed is false) needs_review_count
      from learner_scopes scope left join filtered row
        on row.learner_id=scope.learner_id and row.exam_key=scope.exam_key
      group by scope.learner_id, scope.exam_key
    ), exam_rows as (
      select exam_key, count(*) activity_count, count(*) assessment_count,
        count(*) filter(where source = 'legacy_authoritative') historical_count,
        count(distinct learner_id) assessed_learner_count,
        max(completed_at) latest_activity, max(raw_percentage) best_percentage,
        min(raw_percentage) lowest_percentage,
        case when sum(coalesce(max_score,0))>0
          then sum(coalesce(raw_score,0))*100.0/sum(coalesce(max_score,0))
          else avg(raw_percentage) end average_percentage,
        count(*) filter(where passed) passed_count,
        count(*) filter(where passed is not null) decided_count,
        count(*) filter(where passed is false or raw_percentage < 75) needs_review_count
      from filtered group by exam_key
    ), group_domain_rows as (
      select learner.group_id, row.exam_key, domain.key domain_key,
        count(*) sample_count,
        sum(coalesce((domain.value->>'earnedPoints')::numeric,0)) raw_earned_points,
        sum(coalesce((domain.value->>'maxPoints')::numeric,0)) raw_maximum_points,
        count(distinct row.learner_id) filter (
          where (domain.value->>'percentage')::numeric < 70
        ) student_count,
        count(*) filter (where (domain.value->>'percentage')::numeric < 70) weak_count,
        case when sum(coalesce((domain.value->>'maxPoints')::numeric,0))>0 then sum(coalesce((domain.value->>'earnedPoints')::numeric,0))*100.0/sum(coalesce((domain.value->>'maxPoints')::numeric,0)) else avg((domain.value->>'percentage')::numeric) end average_percentage
      from filtered row
      join visible_learners learner on learner.learner_id=row.learner_id
      cross join lateral jsonb_each(row.domain_summary) domain
      where domain.value ? 'percentage'
      group by learner.group_id, row.exam_key, domain.key
    ), group_rows as (
      select learner.group_id, count(*) assessment_count,
        count(distinct row.learner_id) assessed_learner_count,
        case when sum(coalesce(row.max_score,0))>0 then sum(coalesce(row.raw_score,0))*100.0/sum(coalesce(row.max_score,0)) else avg(row.raw_percentage) end average_percentage,
        count(*) filter(where row.passed) passed_count,
        count(*) filter(where row.passed is not null) decided_count
      from filtered row join visible_learners learner on learner.learner_id=row.learner_id
      group by learner.group_id
    ), assignment_learner_rows as (
      select target.assignment_id,target.learner_id,
        count(row.attempt_id) assignment_attempt_count,
        max(row.completed_at) latest_assignment_activity,
        (array_agg(row.attempt_id order by row.completed_at desc)
          filter(where row.attempt_id is not null))[1] latest_assignment_attempt_id
      from assignment_targets target
      left join filtered row on row.learner_id=target.learner_id
        and row.exam_key=exam_delivery.normalize_exam_key(target.exam_key)
        and (row.source_assignment_id=target.assignment_id or (row.source_assignment_id is null
          and (select count(*) from assignment_targets candidate
            where candidate.learner_id=row.learner_id
              and exam_delivery.normalize_exam_key(candidate.exam_key)=row.exam_key
              and row.completed_at>=coalesce((select available_from from public.exam_assignments where id=candidate.assignment_id),
                (select created_at from public.exam_assignments where id=candidate.assignment_id))
              and ((select due_at from public.exam_assignments where id=candidate.assignment_id) is null
                or row.completed_at<=(select due_at from public.exam_assignments where id=candidate.assignment_id)))=1
          and row.completed_at>=coalesce((select available_from from public.exam_assignments where id=target.assignment_id),
            (select created_at from public.exam_assignments where id=target.assignment_id))
          and (target.due_at is null or row.completed_at<=target.due_at)))
      group by target.assignment_id,target.learner_id
    ), assignment_rows as (
      select assignment.id assignment_id, assignment.exam_key, assignment.group_id,
        assignment.due_at, (select count(distinct target.learner_id)
          from assignment_targets target where target.assignment_id=assignment.id) total_students,
        count(row.learner_id) assessment_count,
        count(distinct row.learner_id) assessed_learner_count,
        case when sum(coalesce(row.max_score,0))>0 then sum(coalesce(row.raw_score,0))*100.0/sum(coalesce(row.max_score,0)) else avg(row.raw_percentage) end average_percentage,
        count(*) filter(where row.passed) passed_count,
        count(*) filter(where row.passed is not null) decided_count,
        count(*) filter(where row.passed is false) needs_review_count
      from public.exam_assignments assignment
      left join filtered row on row.source_assignment_id=assignment.id
        or (row.source_assignment_id is null
          and exam_delivery.normalize_exam_key(assignment.exam_key)=row.exam_key
          and (assignment.student_user_id=row.learner_id or
            (assignment.student_user_id is null and exists (
              select 1 from public.memberships target_membership
              where target_membership.user_id=row.learner_id
                and target_membership.group_id=assignment.group_id
                and target_membership.status='active' and target_membership.role='student'
            )))
          and row.completed_at>=coalesce(assignment.available_from,assignment.created_at)
          and (assignment.due_at is null or row.completed_at<=assignment.due_at)
          and (select count(*) from public.exam_assignments candidate
            where candidate.organisation_id=v_org
              and exam_delivery.normalize_exam_key(candidate.exam_key)=row.exam_key
              and (candidate.student_user_id=row.learner_id or
                (candidate.student_user_id is null and exists (
                  select 1 from public.memberships candidate_membership
                  where candidate_membership.user_id=row.learner_id
                    and candidate_membership.group_id=candidate.group_id
                    and candidate_membership.status='active' and candidate_membership.role='student'
                )))
              and row.completed_at>=coalesce(candidate.available_from,candidate.created_at)
              and (candidate.due_at is null or row.completed_at<=candidate.due_at))=1)
      where assignment.organisation_id=v_org
        and (v_campus is null or assignment.campus_id=v_campus)
        and (v_group is null or assignment.group_id=v_group)
        and (v_assignment is null or assignment.id=v_assignment)
      group by assignment.id,assignment.exam_key,assignment.group_id,assignment.due_at
    ), domain_rows as (
      select row.exam_key, domain.key domain_key, count(*) sample_count,
        sum(coalesce((domain.value->>'earnedPoints')::numeric,0)) raw_earned_points,
        sum(coalesce((domain.value->>'maxPoints')::numeric,0)) raw_maximum_points,
        count(*) filter(where (domain.value->>'percentage')::numeric < 70) weak_count,
        count(distinct row.learner_id) filter(
          where (domain.value->>'percentage')::numeric < 70
        ) student_count,
        case when sum(coalesce((domain.value->>'maxPoints')::numeric,0))>0 then sum(coalesce((domain.value->>'earnedPoints')::numeric,0))*100.0/sum(coalesce((domain.value->>'maxPoints')::numeric,0)) else avg((domain.value->>'percentage')::numeric) end average_percentage
      from filtered row cross join lateral jsonb_each(row.domain_summary) domain
      where domain.value ? 'percentage'
      group by row.exam_key, domain.key
    )
    select jsonb_build_object('ok', true, 'scopeComplete', true,
      'totals', jsonb_build_object(
        'visibleLearners', (select count(*) from visible_learners),
        'learnersWithActivity', (select count(distinct learner_id) from learner_rows where activity_count > 0),
        'learnersWithoutActivity', greatest(0,(select count(*) from visible_learners) -
          (select count(distinct learner_id) from learner_rows where activity_count > 0)),
        'historicalActivity', (select count(*) from filtered),
        'protectedAssessments', (select count(*) from filtered where source = 'protected'),
        'legacyHistorical', (select count(*) from filtered where source = 'legacy_authoritative')
      ),
      'learners', coalesce((select jsonb_agg(jsonb_build_object(
        'learnerId', learner_id, 'examKey', exam_key, 'activityCount', activity_count,
        'assessmentCount', assessment_count, 'historicalCount', historical_count,
        'assessedLearnerCount', 1, 'needsReviewCount', needs_review_count,
        'latestActivity', latest_activity, 'latestAttemptId', latest_attempt_id,
        'bestPercentage', best_percentage,
        'latestPercentage', latest_percentage, 'lowestPercentage', lowest_percentage, 'averagePercentage', average_percentage,
        'passedCount', passed_count,
        'domains', coalesce((select jsonb_agg(jsonb_build_object(
          'domainKey', domain_key, 'averagePercentage', average_percentage,
          'sampleCount', sample_count, 'rawEarnedPoints', raw_earned_points, 'rawMaximumPoints', raw_maximum_points
        ) order by domain_key) from learner_domain_rows d
          where d.learner_id=learner_rows.learner_id
            and d.exam_key=learner_rows.exam_key), '[]'::jsonb),
        'passRate', case when decided_count > 0 then passed_count*100.0/decided_count end
      ) order by learner_id) from learner_rows), '[]'::jsonb),
      'exams', coalesce((select jsonb_agg(jsonb_build_object(
        'examKey', exam_key, 'activityCount', activity_count,
        'assessmentCount', assessment_count, 'historicalCount', historical_count,
        'assessedLearnerCount', assessed_learner_count,
        'needsReviewCount', needs_review_count, 'passedCount', passed_count, 'latestActivity', latest_activity,
        'bestPercentage', best_percentage, 'lowestPercentage', lowest_percentage,
        'averagePercentage', average_percentage,
        'passRate', case when decided_count > 0 then passed_count*100.0/decided_count end
      ) order by exam_key) from exam_rows), '[]'::jsonb),
      'groups', coalesce((select jsonb_agg(jsonb_build_object(
        'groupId',group_id,'assessmentCount',assessment_count,
        'assessedLearnerCount',assessed_learner_count,'averagePercentage',average_percentage,
        'passRate',case when decided_count>0 then passed_count*100.0/decided_count end,
        'domains', coalesce((select jsonb_agg(jsonb_build_object(
          'examKey', exam_key, 'domainKey', domain_key,
          'sampleCount', sample_count, 'studentCount', student_count,
          'weakCount', weak_count, 'averagePercentage', average_percentage,
          'rawEarnedPoints', raw_earned_points, 'rawMaximumPoints', raw_maximum_points
        ) order by exam_key, domain_key) from group_domain_rows d
          where d.group_id=group_rows.group_id), '[]'::jsonb)
      ) order by group_id) from group_rows), '[]'::jsonb),
      'assignments', coalesce((select jsonb_agg(jsonb_build_object(
        'assignmentId',assignment_id,'examKey',exam_key,'groupId',group_id,
        'dueAt',due_at,'totalStudents',total_students,'assessmentCount',assessment_count,
        'assessedLearnerCount',assessed_learner_count,'averagePercentage',average_percentage,
        'needsReviewCount',needs_review_count,
        'passRate',case when decided_count>0 then passed_count*100.0/decided_count end
      ) order by assignment_id) from assignment_rows), '[]'::jsonb),
      'assignmentLearners', coalesce((select jsonb_agg(jsonb_build_object(
        'assignmentId',assignment_id,'learnerId',learner_id,
        'assignmentAttemptCount',assignment_attempt_count,
        'latestAssignmentActivity',latest_assignment_activity,
        'latestAssignmentAttemptId',latest_assignment_attempt_id
      ) order by assignment_id,learner_id) from assignment_learner_rows),'[]'::jsonb),
      'domains', coalesce((select jsonb_agg(jsonb_build_object(
        'examKey',exam_key,'domainKey',domain_key,'sampleCount',sample_count,
        'studentCount',student_count,'weakCount',weak_count,
        'averagePercentage',average_percentage,'rawEarnedPoints',raw_earned_points,
        'rawMaximumPoints',raw_maximum_points
      ) order by exam_key,domain_key) from domain_rows), '[]'::jsonb)
    )
  );
end
$$;


alter function exam_delivery.staff_dashboard_aggregates(uuid,jsonb) owner to postgres;
revoke execute on function exam_delivery.staff_dashboard_aggregates(uuid,jsonb) from public, anon, authenticated, service_role;
