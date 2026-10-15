-- Issue #23 follow-up: retain the bounded assignment/scope contract while
-- including every authoritative assessment result visible to the selected
-- institutional scope. Practice remains excluded and legacy rows retain an
-- explicit non-server-authoritative classification.

alter function exam_delivery.staff_dashboard_scope(uuid,jsonb)
  rename to staff_dashboard_scope_issue23_base;

create function exam_delivery.staff_dashboard_scope(p_actor_id uuid,p_request jsonb)
returns jsonb language plpgsql stable security definer set search_path='' set statement_timeout='12s' as $$
declare
  v_base jsonb;
  v_history jsonb;
  v_role text;
  v_org uuid;
  v_campus uuid;
  v_group uuid;
  v_assignment uuid;
begin
  v_base:=exam_delivery.staff_dashboard_scope_issue23_base(p_actor_id,p_request);
  if v_base->>'ok'<>'true' then return v_base; end if;

  v_role:=v_base->>'role';
  v_org:=nullif(v_base#>>'{selection,organisationId}','')::uuid;
  v_campus:=nullif(v_base#>>'{selection,campusId}','')::uuid;
  v_group:=nullif(v_base#>>'{selection,groupId}','')::uuid;
  v_assignment:=nullif(v_base#>>'{selection,assignmentId}','')::uuid;

  with visible_learners as materialized (
    select distinct learner.user_id learner_id
    from public.memberships learner
    where learner.status='active' and learner.role='student'
      and v_org is not null and learner.organisation_id=v_org
      and (v_campus is null or learner.campus_id=v_campus)
      and (v_group is null or learner.group_id=v_group)
      and (v_role<>'trainer' or exists(
        select 1 from public.memberships trainer
        where trainer.user_id=p_actor_id and trainer.status='active' and trainer.role='trainer'
          and trainer.organisation_id=learner.organisation_id
          and trainer.group_id is not null and trainer.group_id=learner.group_id
      ))
  ), assessment_rows as materialized (
    select a.id attempt_id,a.owner_id learner_id,a.source_assignment_id assignment_id,
      exam_delivery.normalize_exam_key(pv.exam_key) exam_key,pv.package_version,pp.profile_key,
      a.purpose::text purpose,a.completed_at,r.raw_score,r.raw_percentage,r.passed,r.domain_summary,
      true server_authoritative,'protected' source
    from exam_delivery.attempts a
    join visible_learners learner on learner.learner_id=a.owner_id
    join exam_delivery.attempt_results r on r.attempt_id=a.id
    join exam_delivery.package_versions pv on pv.id=a.package_version_id
    join exam_delivery.package_profiles pp on pp.id=a.package_profile_id
    where a.status='completed' and a.analytics_eligible is true
      and a.purpose in ('assigned_assessment','self_directed_exam')
      and (
        (a.purpose='self_directed_exam' and v_assignment is null)
        or (
          a.purpose='assigned_assessment' and a.source_assignment_id is not null
          and (v_assignment is null or a.source_assignment_id=v_assignment)
          and a.source_organisation_id=v_org
          and (v_campus is null or a.source_campus_id=v_campus)
          and (v_group is null or a.source_group_id=v_group)
        )
      )
    union all
    select a.id,a.user_id,null::uuid,exam_delivery.normalize_exam_key(a.exam_key),
      coalesce(a.exam_version,'legacy'),a.profile_id,classified.purpose,a.submitted_at,
      r.raw_score,r.raw_percentage,r.passed,coalesce(r.domain_breakdown,'{}'::jsonb),
      false,'legacy_authoritative'
    from public.exam_attempts a
    join visible_learners learner on learner.learner_id=a.user_id
    join public.exam_results r on r.attempt_id=a.id and r.user_id=a.user_id
    cross join lateral (select exam_delivery.classify_legacy_result(
      a.profile_id,a.mode_label,a.attempt_snapshot,r.result_snapshot,a.status,
      a.submitted_at,r.raw_score,r.raw_percentage
    ) purpose) classified
    where v_assignment is null and a.status='submitted' and a.submitted_at is not null
      and classified.purpose in ('assigned_assessment','self_directed_exam')
      and not exists(select 1 from exam_delivery.attempts protected where protected.id=a.id)
  )
  select jsonb_build_object(
    'items',coalesce(jsonb_agg(jsonb_build_object(
      'attemptId',attempt_id,'learnerId',learner_id,'assignmentId',assignment_id,
      'examKey',exam_key,'packageVersion',package_version,'profileKey',profile_key,
      'purpose',purpose,'completedAt',completed_at,'score',raw_score,
      'percentage',raw_percentage,'passed',passed,'domainSummary',domain_summary,
      'analyticsEligible',true,'serverAuthoritative',server_authoritative,'source',source
    ) order by completed_at desc,attempt_id desc),'[]'::jsonb),
    'totalCount',count(*),'completedCount',count(*),
    'averagePercentage',round(avg(raw_percentage),2),
    'passRate',round(100.0*count(*) filter(where passed)/nullif(count(*),0),2)
  ) into v_history from assessment_rows;

  return jsonb_set(v_base,'{history}',v_history,true);
end $$;

create or replace function public.certsim_protected_staff_dashboard_scope(p_actor_id uuid,p_request jsonb)
returns jsonb language sql stable security invoker set search_path='' as $$
  select exam_delivery.staff_dashboard_scope(p_actor_id,p_request)
$$;

alter function exam_delivery.staff_dashboard_scope_issue23_base(uuid,jsonb) owner to postgres;
alter function exam_delivery.staff_dashboard_scope(uuid,jsonb) owner to postgres;
alter function public.certsim_protected_staff_dashboard_scope(uuid,jsonb) owner to postgres;

revoke execute on function exam_delivery.staff_dashboard_scope_issue23_base(uuid,jsonb),
  exam_delivery.staff_dashboard_scope(uuid,jsonb),
  public.certsim_protected_staff_dashboard_scope(uuid,jsonb)
from public,anon,authenticated,service_role;

grant execute on function exam_delivery.staff_dashboard_scope(uuid,jsonb),
  public.certsim_protected_staff_dashboard_scope(uuid,jsonb)
to service_role;
