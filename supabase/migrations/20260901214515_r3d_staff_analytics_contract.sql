-- Issue #20 Phase R3D: complete the bounded staff-analytics exam aggregate
-- contract expected by the protected Edge mapper. This is forward-only and
-- does not rewrite attempts, results, classifications, or learner access.

create or replace function exam_delivery.staff_analytics(p_actor_id uuid)
returns jsonb
language sql
stable
security definer
set search_path=''
set statement_timeout='12s'
as $$
with visible_learners as (
  select distinct m.user_id learner_id
  from public.memberships m
  where m.status='active' and m.role='student'
    and exam_delivery.staff_can_view_learner(p_actor_id,m.user_id)
), all_rows as (
  select a.owner_id learner_id,pv.exam_key,a.completed_at,r.raw_percentage,r.passed,
    a.analytics_eligible is true analytics_eligible,'protected' source
  from exam_delivery.attempts a
  join exam_delivery.package_versions pv on pv.id=a.package_version_id
  join exam_delivery.attempt_results r on r.attempt_id=a.id
  where a.status='completed' and a.owner_id in (select learner_id from visible_learners)
  union all
  select a.user_id,a.exam_key,a.submitted_at,r.raw_percentage,r.passed,false,'legacy_authoritative'
  from public.exam_attempts a
  join public.exam_results r on r.attempt_id=a.id and r.user_id=a.user_id
  where a.user_id is not null and a.status='submitted' and a.submitted_at is not null
    and a.user_id in (select learner_id from visible_learners)
    and not exists(select 1 from exam_delivery.attempts pa where pa.id=a.id)
), learner_rows as (
  select learner_id,count(*) activity_count,
    count(*) filter(where analytics_eligible) assessment_count,
    count(*) filter(where source='legacy_authoritative') historical_count,
    max(completed_at) latest_activity,
    max(raw_percentage) filter(where analytics_eligible) best_percentage,
    min(raw_percentage) filter(where analytics_eligible) lowest_percentage,
    avg(raw_percentage) filter(where analytics_eligible) average_percentage,
    count(*) filter(where analytics_eligible and passed) passed_count,
    count(*) filter(where analytics_eligible and not passed) needs_review_count,
    count(distinct learner_id) filter(where analytics_eligible) assessed_learner_count
  from all_rows group by learner_id
), exam_rows as (
  select exam_delivery.normalize_exam_key(exam_key) exam_key,count(*) activity_count,
    count(*) filter(where analytics_eligible) assessment_count,
    count(*) filter(where source='legacy_authoritative') historical_count,
    count(distinct learner_id) filter(where analytics_eligible) assessed_learner_count,
    max(completed_at) latest_activity,
    max(raw_percentage) filter(where analytics_eligible) best_percentage,
    min(raw_percentage) filter(where analytics_eligible) lowest_percentage,
    avg(raw_percentage) filter(where analytics_eligible) average_percentage,
    count(*) filter(where analytics_eligible and passed) passed_count,
    count(*) filter(where analytics_eligible and not passed) needs_review_count
  from all_rows group by exam_delivery.normalize_exam_key(exam_key)
)
select case
  when not exam_delivery.is_authoritative_staff(p_actor_id)
    or exists(select 1 from public.memberships m where m.user_id=p_actor_id and m.status='active' and m.role='reception')
      and not exists(select 1 from public.memberships m where m.user_id=p_actor_id and m.status='active' and m.role in ('developer','platform_owner','college_admin','campus_admin','trainer'))
  then jsonb_build_object('ok',false,'code','access_not_granted')
  else jsonb_build_object(
    'ok',true,
    'scopeComplete',true,
    'totals',jsonb_build_object(
      'visibleLearners',(select count(*) from visible_learners),
      'learnersWithActivity',(select count(*) from learner_rows),
      'learnersWithoutActivity',(select count(*) from visible_learners)-(select count(*) from learner_rows),
      'historicalActivity',(select count(*) from all_rows),
      'protectedAssessments',(select count(*) from all_rows where analytics_eligible),
      'legacyHistorical',(select count(*) from all_rows where source='legacy_authoritative')
    ),
    'learners',coalesce((select jsonb_agg(jsonb_build_object(
      'learnerId',learner_id,'activityCount',activity_count,'assessmentCount',assessment_count,
      'historicalCount',historical_count,'latestActivity',latest_activity,
      'bestPercentage',best_percentage,'lowestPercentage',lowest_percentage,
      'averagePercentage',average_percentage,'assessedLearnerCount',assessed_learner_count,
      'needsReviewCount',needs_review_count,
      'passRate',case when assessment_count>0 then passed_count*100.0/assessment_count else null end
    ) order by learner_id) from learner_rows),'[]'::jsonb),
    'exams',coalesce((select jsonb_agg(jsonb_build_object(
      'examKey',exam_key,'activityCount',activity_count,'assessmentCount',assessment_count,
      'historicalCount',historical_count,'assessedLearnerCount',assessed_learner_count,
      'latestActivity',latest_activity,'bestPercentage',best_percentage,
      'lowestPercentage',lowest_percentage,'averagePercentage',average_percentage,
      'needsReviewCount',needs_review_count,
      'passRate',case when assessment_count>0 then passed_count*100.0/assessment_count else null end
    ) order by exam_key) from exam_rows),'[]'::jsonb)
  ) end
$$;

alter function exam_delivery.staff_analytics(uuid) owner to postgres;
revoke execute on function exam_delivery.staff_analytics(uuid) from public,anon,authenticated,service_role;
grant execute on function exam_delivery.staff_analytics(uuid) to service_role;
