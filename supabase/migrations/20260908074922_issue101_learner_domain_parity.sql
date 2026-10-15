-- Return one content-free, full-history domain aggregate for learner progress.
-- Raw point evidence is weighted directly. Percentage-only legacy evidence is
-- used only when a domain has no raw-point evidence at all.
create function exam_delivery.learner_domain_history_summary(
  p_actor_id uuid,
  p_exam_key text
) returns jsonb
language sql stable security definer set search_path='' set statement_timeout='5s' as $$
with current_package as (
  select min(d.package_version_id::text)::uuid package_version_id
  from exam_delivery.package_profile_defaults d
  where d.canonical_exam_key=exam_delivery.normalize_exam_key(p_exam_key)
    and d.purpose in ('assigned_assessment','self_directed_exam') and d.enabled
  having count(distinct d.package_version_id)=1
), eligible as (
  select a.id result_id,a.package_version_id,r.domain_summary
  from exam_delivery.attempts a
  join exam_delivery.package_versions pv on pv.id=a.package_version_id
  join exam_delivery.attempt_results r on r.attempt_id=a.id
  where a.owner_id=p_actor_id and a.status='completed' and a.analytics_eligible is true
    and a.purpose in ('assigned_assessment','self_directed_exam')
    and exam_delivery.normalize_exam_key(pv.exam_key)=exam_delivery.normalize_exam_key(p_exam_key)
  union all
  select a.id,null::uuid,coalesce(r.domain_breakdown,'{}'::jsonb)
  from public.exam_attempts a
  join public.exam_results r on r.attempt_id=a.id and r.user_id=p_actor_id
  where a.user_id=p_actor_id and a.status='submitted' and a.submitted_at is not null
    and exam_delivery.normalize_exam_key(a.exam_key)=exam_delivery.normalize_exam_key(p_exam_key)
    and exam_delivery.classify_legacy_result(a.profile_id,a.mode_label,a.attempt_snapshot,r.result_snapshot,
      a.status,a.submitted_at,r.raw_score,r.raw_percentage) in ('assigned_assessment','self_directed_exam')
    and not exists(select 1 from exam_delivery.attempts protected where protected.id=a.id)
), domain_rows as (
  select e.result_id,e.package_version_id,
    coalesce(item.value->>'domainId',item.value->>'domain',item.value->>'domainLabel') source_domain_key,
    coalesce(item.value->>'domainLabel',item.value->>'domain',item.value->>'domainId') domain_label,
    item.value
  from eligible e
  cross join lateral jsonb_array_elements(
    case when jsonb_typeof(e.domain_summary->'items')='array' then e.domain_summary->'items' else '[]'::jsonb end
  ) item(value)
  union all
  select e.result_id,e.package_version_id,entry.key,
    coalesce(entry.value->>'domainLabel',entry.value->>'domain',entry.key),entry.value
  from eligible e
  cross join lateral jsonb_each(
    case when jsonb_typeof(e.domain_summary)='object' and not(e.domain_summary?'items')
      then e.domain_summary else '{}'::jsonb end
  ) entry(key,value)
  where entry.key not in ('byDomain','kind','missingReason','source','summary')
), normalized as (
  select d.result_id,
    coalesce(mapping.target_domain_key,d.source_domain_key) domain_key,
    d.domain_label,
    case when jsonb_typeof(d.value->'earnedPoints')='number' then (d.value->>'earnedPoints')::numeric end earned_points,
    case when jsonb_typeof(d.value->'maxPoints')='number' and (d.value->>'maxPoints')::numeric>0
      then (d.value->>'maxPoints')::numeric end max_points,
    case when jsonb_typeof(d.value->'percentage')='number' then (d.value->>'percentage')::numeric end percentage
  from domain_rows d
  left join current_package target on true
  left join exam_delivery.package_domain_compatibility mapping
    on mapping.source_package_version_id=d.package_version_id
    and mapping.target_package_version_id=target.package_version_id
    and mapping.source_domain_key=d.source_domain_key and mapping.enabled
  where nullif(btrim(d.source_domain_key),'') is not null
), grouped as (
  select domain_key,(array_agg(domain_label order by result_id))[1] domain_label,
    sum(earned_points) filter(where earned_points is not null and max_points is not null) earned_points,
    sum(max_points) filter(where earned_points is not null and max_points is not null) max_points,
    avg(percentage) filter(where percentage is not null) fallback_percentage,
    count(distinct result_id) filter(where earned_points is not null and max_points is not null) raw_samples,
    count(distinct result_id) filter(where percentage is not null) percentage_samples,
    count(distinct result_id) evidence_samples
  from normalized group by domain_key
), items as (
  select domain_key,jsonb_build_object(
    'domainId',domain_key,'domainLabel',domain_label,
    'earnedPoints',case when max_points>0 then earned_points else null end,
    'maxPoints',case when max_points>0 then max_points else null end,
    'percentage',round(case when max_points>0 then earned_points*100/max_points else fallback_percentage end,2),
    'samples',case when max_points>0 then raw_samples else percentage_samples end,
    'aggregationMode',case when max_points>0 then 'raw_points' else 'legacy_percentage_fallback' end,
    'excludedFallbackSamples',case when max_points>0 then greatest(percentage_samples-raw_samples,0) else 0 end
  ) item,evidence_samples
  from grouped where max_points>0 or fallback_percentage is not null
)
select jsonb_build_object(
  'kind','learner_domain_history_v1','source','full_eligible_assessment_history',
  'items',coalesce((select jsonb_agg(item order by domain_key) from items),'[]'::jsonb),
  'evidenceResultCount',coalesce((select count(distinct result_id) from normalized
    where (earned_points is not null and max_points is not null) or percentage is not null),0),
  'historicalDomainKeysPreserved',true
)
$$;

create or replace function exam_delivery.history_summary(p_actor_id uuid,p_exam_key text)
returns jsonb language sql stable security definer set search_path='' set statement_timeout='5s' as $$
with eligible as (
  select a.id,a.completed_at,r.raw_score,r.raw_percentage,r.passed
  from exam_delivery.attempts a
  join exam_delivery.package_versions pv on pv.id=a.package_version_id
  join exam_delivery.attempt_results r on r.attempt_id=a.id
  where a.owner_id=p_actor_id and a.status='completed' and a.analytics_eligible is true
    and a.purpose in ('assigned_assessment','self_directed_exam')
    and exam_delivery.normalize_exam_key(pv.exam_key)=exam_delivery.normalize_exam_key(p_exam_key)
  union all
  select a.id,a.submitted_at,r.raw_score,r.raw_percentage,r.passed
  from public.exam_attempts a join public.exam_results r on r.attempt_id=a.id and r.user_id=p_actor_id
  where a.user_id=p_actor_id and a.status='submitted' and a.submitted_at is not null
    and exam_delivery.normalize_exam_key(a.exam_key)=exam_delivery.normalize_exam_key(p_exam_key)
    and exam_delivery.classify_legacy_result(a.profile_id,a.mode_label,a.attempt_snapshot,r.result_snapshot,
      a.status,a.submitted_at,r.raw_score,r.raw_percentage) in ('assigned_assessment','self_directed_exam')
    and not exists(select 1 from exam_delivery.attempts protected where protected.id=a.id)
), domains as (
  select exam_delivery.learner_domain_history_summary(p_actor_id,p_exam_key) value
)
select jsonb_build_object('ok',true,
  'latest',(select jsonb_build_object('attemptId',id,'completedAt',completed_at,'score',raw_score,'percentage',raw_percentage) from eligible order by completed_at desc,id desc limit 1),
  'best',(select jsonb_build_object('attemptId',id,'completedAt',completed_at,'score',raw_score,'percentage',raw_percentage) from eligible order by raw_percentage desc nulls last,completed_at desc,id desc limit 1),
  'completedCount',(select count(*) from eligible),'scoredCount',(select count(raw_percentage) from eligible),
  'averagePercentage',(select round(avg(raw_percentage),2) from eligible),'averageScore',(select round(avg(raw_score),2) from eligible),
  'passedCount',(select count(*) from eligible where passed is true),'needsReviewCount',(select count(*) from eligible where passed is false),
  'domainSummary',(select value from domains),'weakDomains',(select value from domains),
  'serverAuthoritative',true,'historicalUnclassifiedExcluded',true)
$$;

alter function exam_delivery.learner_domain_history_summary(uuid,text) owner to postgres;
alter function exam_delivery.history_summary(uuid,text) owner to postgres;

revoke execute on function exam_delivery.learner_domain_history_summary(uuid,text)
  from public,anon,authenticated,service_role;
grant execute on function exam_delivery.learner_domain_history_summary(uuid,text) to service_role;

-- Preserve the existing checked service-role wrapper boundary.
revoke execute on function exam_delivery.history_summary(uuid,text)
  from public,anon,authenticated,service_role;
grant execute on function exam_delivery.history_summary(uuid,text) to service_role;
