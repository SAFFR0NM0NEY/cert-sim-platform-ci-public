-- Issue #25: restore the non-destructive compatibility contract for results
-- saved before protected delivery. Raw public rows remain unchanged; this
-- migration classifies them only while building secured history projections.

create function exam_delivery.classify_legacy_result(
  p_profile_id text,
  p_mode_label text,
  p_attempt_snapshot jsonb,
  p_result_snapshot jsonb,
  p_status text,
  p_submitted_at timestamptz,
  p_raw_score numeric,
  p_raw_percentage numeric
) returns text
language sql
immutable
set search_path=''
as $$
  with evidence as (
    select
      lower(regexp_replace(concat_ws(' ',
        p_profile_id,
        p_mode_label,
        p_attempt_snapshot->'mode'->>'id',
        p_attempt_snapshot->'mode'->>'name',
        p_attempt_snapshot->'mode'->>'label',
        p_attempt_snapshot->'profile'->>'id',
        p_attempt_snapshot->'profile'->>'name',
        p_attempt_snapshot->'profile'->>'sourceFlow',
        p_attempt_snapshot->'metadata'->>'sourceFlow',
        p_result_snapshot->>'sourceFlow',
        p_result_snapshot->>'attemptKind',
        p_result_snapshot->'metadata'->>'sourceFlow',
        p_result_snapshot->'exam'->>'sourceFlow',
        p_result_snapshot->'exam'->'mode'->>'id',
        p_result_snapshot->'exam'->'mode'->>'name',
        p_result_snapshot->'exam'->'profile'->>'id',
        p_result_snapshot->'exam'->'profile'->>'sourceFlow'
      ), '[^a-zA-Z0-9]+', '_', 'g')) searchable,
      lower(replace(replace(coalesce(
        p_result_snapshot->>'purpose',
        p_result_snapshot->'metadata'->>'purpose',
        p_result_snapshot->'exam'->>'purpose',
        p_attempt_snapshot->'metadata'->>'purpose',
        ''
      ), '-', '_'), ' ', '_')) explicit_purpose
  )
  select case
    when explicit_purpose in ('assigned_assessment','self_directed_exam') then explicit_purpose
    when explicit_purpose in ('study_sandbox','targeted_domain','weak_area','pbq_practice') then explicit_purpose
    when searchable ~ '(^|_)weak(_area)?(_focus)?($|_)' then 'weak_area'
    when searchable ~ '(^|_)study_sandbox($|_)' or searchable ~ '(^|_)sandbox($|_)' then 'study_sandbox'
    when searchable ~ '(^|_)targeted_(practice|domain)($|_)' then 'targeted_domain'
    when searchable ~ '(^|_)pbq_(preview|practice)($|_)' then 'pbq_practice'
    when searchable ~ '(^|_)case_(study_)?preview($|_)' then 'study_sandbox'
    when p_status='submitted' and p_submitted_at is not null
      and (p_raw_score is not null or p_raw_percentage is not null)
      and searchable ~ '(^|_)(full|full_mock|full_practice|compact|strict_beta|controlled_beta|realistic|sectioned|certification|exam)($|_)'
      then 'self_directed_exam'
    else 'unclassified'
  end from evidence
$$;

alter function exam_delivery.classify_legacy_result(text,text,jsonb,jsonb,text,timestamptz,numeric,numeric) owner to postgres;
revoke execute on function exam_delivery.classify_legacy_result(text,text,jsonb,jsonb,text,timestamptz,numeric,numeric)
  from public,anon,authenticated,service_role;

create or replace function exam_delivery.list_history(p_actor_id uuid,p_exam_key text,p_cursor text,p_page_size integer)
returns jsonb language sql stable security definer set search_path='' set statement_timeout='8s' as $$
with all_rows as (
  select a.id attempt_id,a.completed_at completed_at,2 source_order,pv.exam_key,pv.package_version,pp.profile_key,
    a.purpose::text purpose,a.actor_classification,r.raw_score,r.raw_percentage,r.passed,r.domain_summary,
    coalesce(rs.release_status::text,'withheld') review_status,true server_authoritative,'protected' source
  from exam_delivery.attempts a join exam_delivery.package_versions pv on pv.id=a.package_version_id
  join exam_delivery.package_profiles pp on pp.id=a.package_profile_id join exam_delivery.attempt_results r on r.attempt_id=a.id
  left join exam_delivery.review_snapshots rs on rs.attempt_id=a.id where a.owner_id=p_actor_id and a.status='completed'
  union all
  select a.id,a.submitted_at,1,a.exam_key,coalesce(a.exam_version,'legacy'),a.profile_id,
    exam_delivery.classify_legacy_result(a.profile_id,a.mode_label,a.attempt_snapshot,r.result_snapshot,a.status,a.submitted_at,r.raw_score,r.raw_percentage),
    null,r.raw_score,r.raw_percentage,r.passed,coalesce(r.domain_breakdown,'{}'::jsonb),
    'withheld',false,'legacy_authoritative'
  from public.exam_attempts a join public.exam_results r on r.attempt_id=a.id and r.user_id=p_actor_id
  where a.user_id=p_actor_id and a.status='submitted' and a.submitted_at is not null
    and not exists(select 1 from exam_delivery.attempts protected_attempt where protected_attempt.id=a.id)
), filtered as (
  select * from all_rows where p_exam_key is null or exam_delivery.normalize_exam_key(exam_key)=exam_delivery.normalize_exam_key(p_exam_key)
), eligible as (
  select * from filtered where p_cursor is null or (completed_at,attempt_id,source_order)<
    ((split_part(p_cursor,'|',1))::timestamptz,(split_part(p_cursor,'|',2))::uuid,(split_part(p_cursor,'|',3))::integer)
  order by completed_at desc,attempt_id desc,source_order desc
), bounded as (select * from eligible limit least(greatest(p_page_size,1),50)+1),
page as (select * from bounded limit least(greatest(p_page_size,1),50))
select jsonb_build_object('ok',true,'items',coalesce((select jsonb_agg(jsonb_build_object(
  'attemptId',attempt_id,'examKey',exam_key,'packageVersion',package_version,'profileKey',profile_key,'purpose',purpose,
  'actorClassification',actor_classification,'completedAt',completed_at,'score',raw_score,'percentage',raw_percentage,
  'passed',passed,'domainSummary',domain_summary,'serverAuthoritative',server_authoritative,'reviewStatus',review_status,'source',source)
  order by completed_at desc,attempt_id desc,source_order desc) from page),'[]'::jsonb),
  'returnedCount',(select count(*) from page),'totalCount',(select count(*) from filtered),
  'remainingCount',greatest((select count(*) from eligible)-(select count(*) from page),0),
  'nextCursor',case when (select count(*) from bounded)>least(greatest(p_page_size,1),50)
    then (select completed_at::text||'|'||attempt_id::text||'|'||source_order::text from page order by completed_at,attempt_id,source_order limit 1) else null end)
$$;

create or replace function exam_delivery.history_summary(p_actor_id uuid,p_exam_key text)
returns jsonb language sql stable security definer set search_path='' set statement_timeout='5s' as $$
with eligible as (
  select a.id,a.completed_at,r.raw_percentage,r.domain_summary
  from exam_delivery.attempts a
  join exam_delivery.package_versions pv on pv.id=a.package_version_id
  join exam_delivery.attempt_results r on r.attempt_id=a.id
  where a.owner_id=p_actor_id and a.status='completed' and a.analytics_eligible is true
    and exam_delivery.normalize_exam_key(pv.exam_key)=exam_delivery.normalize_exam_key(p_exam_key)
  union all
  select a.id,a.submitted_at,r.raw_percentage,coalesce(r.domain_breakdown,'{}'::jsonb)
  from public.exam_attempts a join public.exam_results r on r.attempt_id=a.id and r.user_id=p_actor_id
  where a.user_id=p_actor_id and a.status='submitted' and a.submitted_at is not null
    and exam_delivery.normalize_exam_key(a.exam_key)=exam_delivery.normalize_exam_key(p_exam_key)
    and exam_delivery.classify_legacy_result(a.profile_id,a.mode_label,a.attempt_snapshot,r.result_snapshot,a.status,a.submitted_at,r.raw_score,r.raw_percentage)
      in ('assigned_assessment','self_directed_exam')
    and not exists(select 1 from exam_delivery.attempts pa where pa.id=a.id)
)
select jsonb_build_object('ok',true,
  'latest',(select jsonb_build_object('attemptId',id,'completedAt',completed_at,'percentage',raw_percentage) from eligible order by completed_at desc,id desc limit 1),
  'best',(select jsonb_build_object('attemptId',id,'completedAt',completed_at,'percentage',raw_percentage) from eligible order by raw_percentage desc nulls last,completed_at desc,id desc limit 1),
  'completedCount',(select count(*) from eligible),
  'weakDomains',coalesce((select domain_summary from eligible where domain_summary<>'{}'::jsonb order by completed_at desc,id desc limit 1),'{}'::jsonb),
  'serverAuthoritative',true,'historicalUnclassifiedExcluded',true)
$$;

create or replace function exam_delivery.list_staff_history(p_actor_id uuid,p_cursor text,p_page_size integer)
returns jsonb language sql stable security definer set search_path='' set statement_timeout='10s' as $$
with all_rows as (
  select a.id attempt_id,a.owner_id learner_id,a.completed_at completed_at,2 source_order,pv.exam_key,pv.package_version,
    pp.profile_key,a.purpose::text purpose,a.actor_classification,a.analytics_eligible,r.raw_score,r.raw_percentage,r.passed,
    r.domain_summary,coalesce(rs.release_status::text,'withheld') review_status,true server_authoritative,'protected' source
  from exam_delivery.attempts a join exam_delivery.package_versions pv on pv.id=a.package_version_id
  join exam_delivery.package_profiles pp on pp.id=a.package_profile_id join exam_delivery.attempt_results r on r.attempt_id=a.id
  left join exam_delivery.review_snapshots rs on rs.attempt_id=a.id
  where a.status='completed' and exam_delivery.staff_can_view_learner(p_actor_id,a.owner_id)
  union all
  select a.id,a.user_id,a.submitted_at,1,a.exam_key,coalesce(a.exam_version,'legacy'),a.profile_id,
    classified.purpose,null,(classified.purpose in ('assigned_assessment','self_directed_exam')),
    r.raw_score,r.raw_percentage,r.passed,coalesce(r.domain_breakdown,'{}'::jsonb),'withheld',false,'legacy_authoritative'
  from public.exam_attempts a join public.exam_results r on r.attempt_id=a.id and r.user_id=a.user_id
  cross join lateral (select exam_delivery.classify_legacy_result(a.profile_id,a.mode_label,a.attempt_snapshot,r.result_snapshot,a.status,a.submitted_at,r.raw_score,r.raw_percentage) purpose) classified
  where a.status='submitted' and a.submitted_at is not null and exam_delivery.staff_can_view_learner(p_actor_id,a.user_id)
    and not exists(select 1 from exam_delivery.attempts protected_attempt where protected_attempt.id=a.id)
), eligible as (
  select * from all_rows where p_cursor is null or (completed_at,attempt_id,source_order)<
    ((split_part(p_cursor,'|',1))::timestamptz,(split_part(p_cursor,'|',2))::uuid,(split_part(p_cursor,'|',3))::integer)
  order by completed_at desc,attempt_id desc,source_order desc
), bounded as (select * from eligible limit least(greatest(p_page_size,1),50)+1),
page as (select * from bounded limit least(greatest(p_page_size,1),50))
select jsonb_build_object('ok',true,'items',coalesce((select jsonb_agg(jsonb_build_object(
  'attemptId',attempt_id,'learnerId',learner_id,'examKey',exam_key,'packageVersion',package_version,'profileKey',profile_key,
  'purpose',purpose,'actorClassification',actor_classification,'analyticsEligible',analytics_eligible,'completedAt',completed_at,
  'score',raw_score,'percentage',raw_percentage,'passed',passed,'domainSummary',domain_summary,'serverAuthoritative',server_authoritative,
  'reviewStatus',review_status,'source',source) order by completed_at desc,attempt_id desc,source_order desc) from page),'[]'::jsonb),
  'returnedCount',(select count(*) from page),'totalCount',(select count(*) from all_rows),
  'remainingCount',greatest((select count(*) from eligible)-(select count(*) from page),0),
  'nextCursor',case when (select count(*) from bounded)>least(greatest(p_page_size,1),50)
    then (select completed_at::text||'|'||attempt_id::text||'|'||source_order::text from page order by completed_at,attempt_id,source_order limit 1) else null end)
$$;

create or replace function exam_delivery.print_summary(p_actor_id uuid,p_attempt_id uuid)
returns jsonb language sql stable security definer set search_path='' set statement_timeout='5s' as $$
  select coalesce(
    (select jsonb_build_object('ok',true,'exam',jsonb_build_object('key',pv.exam_key,'version',pv.package_version),
      'profile',jsonb_build_object('key',pp.profile_key,'name',pp.display_name),'purpose',a.purpose,'completedAt',a.completed_at,
      'score',r.raw_score,'percentage',r.raw_percentage,'passed',r.passed,'domainSummary',r.domain_summary,
      'completionStatus',a.status,'serverAuthoritative',true,'source','protected','reviewStatus',coalesce(rs.release_status::text,'withheld'))
     from exam_delivery.attempts a join exam_delivery.package_versions pv on pv.id=a.package_version_id
     join exam_delivery.package_profiles pp on pp.id=a.package_profile_id join exam_delivery.attempt_results r on r.attempt_id=a.id
     left join exam_delivery.review_snapshots rs on rs.attempt_id=a.id
     where a.id=p_attempt_id and (a.owner_id=p_actor_id or exam_delivery.staff_can_view_learner(p_actor_id,a.owner_id))),
    (select jsonb_build_object('ok',true,'exam',jsonb_build_object('key',a.exam_key,'version',coalesce(a.exam_version,'legacy')),
      'profile',jsonb_build_object('key',a.profile_id,'name',a.profile_id),
      'purpose',exam_delivery.classify_legacy_result(a.profile_id,a.mode_label,a.attempt_snapshot,r.result_snapshot,a.status,a.submitted_at,r.raw_score,r.raw_percentage),
      'completedAt',a.submitted_at,'score',r.raw_score,'percentage',r.raw_percentage,'passed',r.passed,
      'domainSummary',coalesce(r.domain_breakdown,'{}'::jsonb),'completionStatus',a.status,
      'serverAuthoritative',false,'source','legacy_authoritative','reviewStatus','withheld')
     from public.exam_attempts a join public.exam_results r on r.attempt_id=a.id and r.user_id=a.user_id
     where a.id=p_attempt_id and a.user_id is not null
       and (a.user_id=p_actor_id or exam_delivery.staff_can_view_learner(p_actor_id,a.user_id))
       and a.status='submitted' and not exists(select 1 from exam_delivery.attempts pa where pa.id=a.id)),
    jsonb_build_object('ok',false,'code','attempt_not_found'))
$$;

create or replace function exam_delivery.staff_analytics(p_actor_id uuid)
returns jsonb language sql stable security definer set search_path='' set statement_timeout='12s' as $$
with visible_learners as (
  select distinct m.user_id learner_id from public.memberships m
  where m.status='active' and m.role='student' and exam_delivery.staff_can_view_learner(p_actor_id,m.user_id)
), all_rows as (
  select a.owner_id learner_id,pv.exam_key,a.completed_at,r.raw_percentage,r.passed,
    a.analytics_eligible is true analytics_eligible,'protected' source
  from exam_delivery.attempts a join exam_delivery.package_versions pv on pv.id=a.package_version_id
  join exam_delivery.attempt_results r on r.attempt_id=a.id
  where a.status='completed' and a.owner_id in (select learner_id from visible_learners)
  union all
  select a.user_id,a.exam_key,a.submitted_at,r.raw_percentage,r.passed,
    exam_delivery.classify_legacy_result(a.profile_id,a.mode_label,a.attempt_snapshot,r.result_snapshot,a.status,a.submitted_at,r.raw_score,r.raw_percentage)
      in ('assigned_assessment','self_directed_exam'),'legacy_authoritative'
  from public.exam_attempts a join public.exam_results r on r.attempt_id=a.id and r.user_id=a.user_id
  where a.user_id is not null and a.status='submitted' and a.submitted_at is not null
    and a.user_id in (select learner_id from visible_learners)
    and not exists(select 1 from exam_delivery.attempts pa where pa.id=a.id)
), learner_rows as (
  select learner_id,count(*) activity_count,count(*) filter(where analytics_eligible) assessment_count,
    count(*) filter(where source='legacy_authoritative') historical_count,max(completed_at) latest_activity,
    max(raw_percentage) filter(where analytics_eligible) best_percentage,min(raw_percentage) filter(where analytics_eligible) lowest_percentage,
    avg(raw_percentage) filter(where analytics_eligible) average_percentage,count(*) filter(where analytics_eligible and passed) passed_count,
    count(*) filter(where analytics_eligible and not passed) needs_review_count,
    count(distinct learner_id) filter(where analytics_eligible) assessed_learner_count
  from all_rows group by learner_id
), exam_rows as (
  select exam_delivery.normalize_exam_key(exam_key) exam_key,count(*) activity_count,
    count(*) filter(where analytics_eligible) assessment_count,count(*) filter(where source='legacy_authoritative') historical_count,
    count(distinct learner_id) filter(where analytics_eligible) assessed_learner_count,max(completed_at) latest_activity,
    max(raw_percentage) filter(where analytics_eligible) best_percentage,min(raw_percentage) filter(where analytics_eligible) lowest_percentage,
    avg(raw_percentage) filter(where analytics_eligible) average_percentage,count(*) filter(where analytics_eligible and passed) passed_count,
    count(*) filter(where analytics_eligible and not passed) needs_review_count
  from all_rows group by exam_delivery.normalize_exam_key(exam_key)
)
select case when not exam_delivery.is_authoritative_staff(p_actor_id)
  or exists(select 1 from public.memberships m where m.user_id=p_actor_id and m.status='active' and m.role='reception')
    and not exists(select 1 from public.memberships m where m.user_id=p_actor_id and m.status='active' and m.role in ('developer','platform_owner','college_admin','campus_admin','trainer'))
  then jsonb_build_object('ok',false,'code','access_not_granted')
  else jsonb_build_object('ok',true,'scopeComplete',true,
    'totals',jsonb_build_object('visibleLearners',(select count(*) from visible_learners),
      'learnersWithActivity',(select count(*) from learner_rows),'learnersWithoutActivity',(select count(*) from visible_learners)-(select count(*) from learner_rows),
      'historicalActivity',(select count(*) from all_rows),'protectedAssessments',(select count(*) from all_rows where analytics_eligible),
      'legacyHistorical',(select count(*) from all_rows where source='legacy_authoritative')),
    'learners',coalesce((select jsonb_agg(jsonb_build_object('learnerId',learner_id,'activityCount',activity_count,
      'assessmentCount',assessment_count,'historicalCount',historical_count,'latestActivity',latest_activity,
      'bestPercentage',best_percentage,'lowestPercentage',lowest_percentage,'averagePercentage',average_percentage,
      'assessedLearnerCount',assessed_learner_count,'needsReviewCount',needs_review_count,
      'passRate',case when assessment_count>0 then passed_count*100.0/assessment_count else null end) order by learner_id) from learner_rows),'[]'::jsonb),
    'exams',coalesce((select jsonb_agg(jsonb_build_object('examKey',exam_key,'activityCount',activity_count,
      'assessmentCount',assessment_count,'historicalCount',historical_count,'assessedLearnerCount',assessed_learner_count,
      'latestActivity',latest_activity,'bestPercentage',best_percentage,'lowestPercentage',lowest_percentage,
      'averagePercentage',average_percentage,'needsReviewCount',needs_review_count,
      'passRate',case when assessment_count>0 then passed_count*100.0/assessment_count else null end) order by exam_key) from exam_rows),'[]'::jsonb)
  ) end
$$;

alter function exam_delivery.list_history(uuid,text,text,integer) owner to postgres;
alter function exam_delivery.history_summary(uuid,text) owner to postgres;
alter function exam_delivery.list_staff_history(uuid,text,integer) owner to postgres;
alter function exam_delivery.print_summary(uuid,uuid) owner to postgres;
alter function exam_delivery.staff_analytics(uuid) owner to postgres;

revoke execute on function exam_delivery.list_history(uuid,text,text,integer),
  exam_delivery.history_summary(uuid,text),exam_delivery.list_staff_history(uuid,text,integer),
  exam_delivery.print_summary(uuid,uuid),exam_delivery.staff_analytics(uuid)
from public,anon,authenticated,service_role;
grant execute on function exam_delivery.list_history(uuid,text,text,integer),
  exam_delivery.history_summary(uuid,text),exam_delivery.list_staff_history(uuid,text,integer),
  exam_delivery.print_summary(uuid,uuid),exam_delivery.staff_analytics(uuid)
to service_role;
