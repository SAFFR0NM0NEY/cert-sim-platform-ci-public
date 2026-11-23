-- Issue #20 Phase R3A: unified, content-free history detail and complete
-- staff analytics. Repository-only until a separately authorized rollout.

create index exam_entitlements_revoked_by_idx
  on exam_delivery.exam_entitlements(revoked_by)
  where revoked_by is not null;

-- Purchase fulfilment is an operator/runtime concern. It must not remain a
-- directly executable authenticated SECURITY DEFINER RPC.
revoke execute on function public.certsim_grant_purchase_entitlement(
  uuid,uuid,uuid[],text,text,timestamptz
) from public,anon,authenticated,service_role;
grant execute on function public.certsim_grant_purchase_entitlement(
  uuid,uuid,uuid[],text,text,timestamptz
) to service_role;

create or replace function exam_delivery.print_summary(
  p_actor_id uuid,
  p_attempt_id uuid
) returns jsonb
language sql
stable
security definer
set search_path=''
set statement_timeout='5s'
as $$
  select coalesce(
    (
      select jsonb_build_object(
        'ok',true,
        'exam',jsonb_build_object('key',pv.exam_key,'version',pv.package_version),
        'profile',jsonb_build_object('key',pp.profile_key,'name',pp.display_name),
        'purpose',a.purpose,
        'completedAt',a.completed_at,
        'score',r.raw_score,
        'percentage',r.raw_percentage,
        'passed',r.passed,
        'domainSummary',r.domain_summary,
        'completionStatus',a.status,
        'serverAuthoritative',true,
        'source','protected',
        'reviewStatus',coalesce(rs.release_status::text,'withheld')
      )
      from exam_delivery.attempts a
      join exam_delivery.package_versions pv on pv.id=a.package_version_id
      join exam_delivery.package_profiles pp on pp.id=a.package_profile_id
      join exam_delivery.attempt_results r on r.attempt_id=a.id
      left join exam_delivery.review_snapshots rs on rs.attempt_id=a.id
      where a.id=p_attempt_id
        and (a.owner_id=p_actor_id or exam_delivery.staff_can_view_learner(p_actor_id,a.owner_id))
    ),
    (
      select jsonb_build_object(
        'ok',true,
        'exam',jsonb_build_object('key',a.exam_key,'version',coalesce(a.exam_version,'legacy')),
        'profile',jsonb_build_object('key',a.profile_id,'name',a.profile_id),
        'purpose','unclassified',
        'completedAt',a.submitted_at,
        'score',r.raw_score,
        'percentage',r.raw_percentage,
        'passed',r.passed,
        'domainSummary',coalesce(r.domain_breakdown,'{}'::jsonb),
        'completionStatus',a.status,
        'serverAuthoritative',coalesce(r.result_snapshot->>'serverAuthoritative'='true',false),
        'source','legacy_authoritative',
        'reviewStatus','withheld'
      )
      from public.exam_attempts a
      join public.exam_results r on r.attempt_id=a.id and r.user_id=a.user_id
      where a.id=p_attempt_id
        and a.user_id is not null
        and (a.user_id=p_actor_id or exam_delivery.staff_can_view_learner(p_actor_id,a.user_id))
        and a.status='submitted'
        and not exists(select 1 from exam_delivery.attempts pa where pa.id=a.id)
    ),
    jsonb_build_object('ok',false,'code','attempt_not_found')
  )
$$;

create function exam_delivery.staff_analytics(p_actor_id uuid)
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
    max(completed_at) latest_activity,
    max(raw_percentage) filter(where analytics_eligible) best_percentage,
    avg(raw_percentage) filter(where analytics_eligible) average_percentage,
    count(*) filter(where analytics_eligible and passed) passed_count
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
      'historicalCount',historical_count,'latestActivity',latest_activity,
      'bestPercentage',best_percentage,'averagePercentage',average_percentage,
      'passRate',case when assessment_count>0 then passed_count*100.0/assessment_count else null end
    ) order by exam_key) from exam_rows),'[]'::jsonb)
  ) end
$$;

create function public.certsim_protected_staff_analytics(p_actor_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path=''
as $$ select exam_delivery.staff_analytics(p_actor_id) $$;

alter function exam_delivery.print_summary(uuid,uuid) owner to postgres;
alter function exam_delivery.staff_analytics(uuid) owner to postgres;
alter function public.certsim_protected_staff_analytics(uuid) owner to postgres;

revoke execute on function exam_delivery.staff_analytics(uuid),
  public.certsim_protected_staff_analytics(uuid)
from public,anon,authenticated,service_role;
grant execute on function exam_delivery.staff_analytics(uuid),
  public.certsim_protected_staff_analytics(uuid)
to service_role;
