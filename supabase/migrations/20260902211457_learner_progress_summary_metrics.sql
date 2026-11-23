-- Add bounded, aggregate learner progress metrics to the existing protected
-- history summary. The service-only wrapper and its grants are unchanged.
create or replace function exam_delivery.history_summary(p_actor_id uuid,p_exam_key text)
returns jsonb language sql stable security definer set search_path='' set statement_timeout='5s' as $$
with eligible as (
  select a.id,a.completed_at,r.raw_score,r.raw_percentage,r.passed,r.domain_summary
  from exam_delivery.attempts a
  join exam_delivery.package_versions pv on pv.id=a.package_version_id
  join exam_delivery.attempt_results r on r.attempt_id=a.id
  where a.owner_id=p_actor_id and a.status='completed' and a.analytics_eligible is true
    and exam_delivery.normalize_exam_key(pv.exam_key)=exam_delivery.normalize_exam_key(p_exam_key)
  union all
  select a.id,a.submitted_at,r.raw_score,r.raw_percentage,r.passed,coalesce(r.domain_breakdown,'{}'::jsonb)
  from public.exam_attempts a join public.exam_results r on r.attempt_id=a.id and r.user_id=p_actor_id
  where a.user_id=p_actor_id and a.status='submitted' and a.submitted_at is not null
    and exam_delivery.normalize_exam_key(a.exam_key)=exam_delivery.normalize_exam_key(p_exam_key)
    and exam_delivery.classify_legacy_result(a.profile_id,a.mode_label,a.attempt_snapshot,r.result_snapshot,a.status,a.submitted_at,r.raw_score,r.raw_percentage)
      in ('assigned_assessment','self_directed_exam')
    and not exists(select 1 from exam_delivery.attempts pa where pa.id=a.id)
)
select jsonb_build_object('ok',true,
  'latest',(select jsonb_build_object('attemptId',id,'completedAt',completed_at,'score',raw_score,'percentage',raw_percentage) from eligible order by completed_at desc,id desc limit 1),
  'best',(select jsonb_build_object('attemptId',id,'completedAt',completed_at,'score',raw_score,'percentage',raw_percentage) from eligible order by raw_percentage desc nulls last,completed_at desc,id desc limit 1),
  'completedCount',(select count(*) from eligible),
  'scoredCount',(select count(raw_percentage) from eligible),
  'averagePercentage',(select round(avg(raw_percentage),2) from eligible),
  'averageScore',(select round(avg(raw_score),2) from eligible),
  'passedCount',(select count(*) from eligible where passed is true),
  'needsReviewCount',(select count(*) from eligible where passed is false),
  'weakDomains',coalesce((select domain_summary from eligible where domain_summary<>'{}'::jsonb order by completed_at desc,id desc limit 1),'{}'::jsonb),
  'serverAuthoritative',true,'historicalUnclassifiedExcluded',true)
$$;
