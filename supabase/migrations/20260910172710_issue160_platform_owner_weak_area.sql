-- Issue #160: permit an active Platform Owner to use only their own completed
-- protected formal attempts as personal Weak Area practice evidence. Learner
-- analytics and actor classification remain separate and unchanged.

create function exam_delivery.weak_domain_evidence_for_practice(
  p_actor_id uuid,
  p_package_version_id uuid
) returns table(
  domain_key text,
  evidence_count bigint,
  lowest_percentage numeric
)
language sql stable security definer
set search_path = ''
set statement_timeout = '8s'
as $$
  with active_platform_owner as (
    select p_actor_id owner_id
    where exists (
      select 1
      from public.profiles profile
      where profile.id = p_actor_id
        and profile.status = 'active'
    )
      and public.is_platform_owner(p_actor_id)
  ), owner_specific_evidence as (
    select domain.key domain_key,
      count(*)::bigint evidence_count,
      min(coalesce((domain.value->>'percentage')::numeric, 100)) lowest_percentage
    from active_platform_owner owner
    join exam_delivery.attempts attempt on attempt.owner_id = owner.owner_id
    join exam_delivery.attempt_results result on result.attempt_id = attempt.id
    cross join lateral jsonb_each(coalesce(result.domain_summary, '{}'::jsonb)) domain
    where attempt.package_version_id = p_package_version_id
      and attempt.status = 'completed'
      and attempt.purpose in ('assigned_assessment', 'self_directed_exam')
      and attempt.actor_classification = 'staff'
      and attempt.analytics_eligible is not true
      and coalesce((domain.value->>'percentage')::numeric, 100) < 70
    group by domain.key

    union all

    select mapping.target_domain_key,
      count(*)::bigint,
      min(coalesce((domain.value->>'percentage')::numeric, 100))
    from active_platform_owner owner
    join exam_delivery.attempts attempt on attempt.owner_id = owner.owner_id
    join exam_delivery.attempt_results result on result.attempt_id = attempt.id
    cross join lateral jsonb_each(coalesce(result.domain_summary, '{}'::jsonb)) domain
    join exam_delivery.package_domain_compatibility mapping
      on mapping.source_package_version_id = attempt.package_version_id
      and mapping.target_package_version_id = p_package_version_id
      and mapping.source_domain_key = domain.key
      and mapping.enabled
    where attempt.status = 'completed'
      and attempt.purpose in ('assigned_assessment', 'self_directed_exam')
      and attempt.actor_classification = 'staff'
      and attempt.analytics_eligible is not true
      and coalesce((domain.value->>'percentage')::numeric, 100) < 70
    group by mapping.target_domain_key
  ), evidence as (
    select learner.domain_key, learner.evidence_count, learner.lowest_percentage
    from exam_delivery.learner_weak_domain_evidence(
      p_actor_id,
      p_package_version_id
    ) learner

    union all

    select owner.domain_key, owner.evidence_count, owner.lowest_percentage
    from owner_specific_evidence owner
  )
  select evidence.domain_key,
    sum(evidence.evidence_count)::bigint,
    min(evidence.lowest_percentage)
  from evidence
  group by evidence.domain_key
$$;

create or replace function exam_delivery.weak_area_options(
  p_actor_id uuid,
  p_exam_key text,
  p_profile_key text
) returns jsonb
language plpgsql stable security definer
set search_path = ''
set statement_timeout = '8s'
as $$
declare
  v_exam text := exam_delivery.normalize_exam_key(p_exam_key);
  v_binding record;
  v_policy exam_delivery.practice_policies%rowtype;
  v_domains jsonb := '[]'::jsonb;
begin
  if p_actor_id is null
    or nullif(v_exam, '') is null
    or length(v_exam) not between 2 and 64
    or p_profile_key is null
    or p_profile_key !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  if not exists (
    select 1 from public.profiles profile
    where profile.id = p_actor_id and profile.status = 'active'
  ) then
    return jsonb_build_object('ok', false, 'code', 'inactive_account');
  end if;

  select binding.package_version_id,
    binding.package_profile_id,
    binding.package_version
  into v_binding
  from exam_delivery.resolve_package_profile_default(
    v_exam,
    p_profile_key,
    'weak_area'::exam_delivery.attempt_purpose
  ) binding;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'no_published_package');
  end if;

  select policy.* into v_policy
  from exam_delivery.practice_policies policy
  where policy.canonical_exam_key = v_exam
    and policy.package_version = v_binding.package_version
    and policy.profile_key = p_profile_key
    and policy.purpose = 'weak_area'::exam_delivery.attempt_purpose;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'practice_unavailable');
  end if;

  if not v_policy.enabled or v_policy.access_mode = 'disabled' then
    return jsonb_build_object('ok', false, 'code', 'practice_unavailable');
  end if;

  if not exam_delivery.can_use_profile(
    p_actor_id,
    v_binding.package_version_id,
    v_binding.package_profile_id,
    'weak_area'::exam_delivery.attempt_purpose
  ) then
    return jsonb_build_object('ok', false, 'code', 'access_not_granted');
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'domainKey', evidence.domain_key,
        'evidenceCount', evidence.evidence_count,
        'lowestPercentage', evidence.lowest_percentage
      ) order by evidence.lowest_percentage, evidence.domain_key
    ),
    '[]'::jsonb
  )
  into v_domains
  from exam_delivery.weak_domain_evidence_for_practice(
    p_actor_id,
    v_binding.package_version_id
  ) evidence
  where exists (
    select 1
    from exam_delivery.package_questions question
    where question.package_version_id = v_binding.package_version_id
      and question.domain_key = evidence.domain_key
  );

  return jsonb_build_object(
    'ok', true,
    'examKey', v_exam,
    'packageVersion', v_binding.package_version,
    'profileKey', p_profile_key,
    'domains', v_domains
  );
end
$$;

-- Preserve the reviewed availability implementation byte-for-byte apart from
-- routing its Weak Area evidence lookup through the same unified authority.
do $$
declare
  v_definition text := pg_get_functiondef(
    'exam_delivery.practice_availability(uuid,jsonb)'::regprocedure
  );
  v_updated text;
begin
  if (
    select count(*)
    from regexp_matches(
      v_definition,
      'exam_delivery\.learner_weak_domain_evidence\(',
      'g'
    )
  ) <> 1 then
    raise exception 'issue160_practice_availability_contract_drift';
  end if;

  v_updated := replace(
    v_definition,
    'exam_delivery.learner_weak_domain_evidence(',
    'exam_delivery.weak_domain_evidence_for_practice('
  );
  execute v_updated;
end
$$;

-- The AZ-204 materializer still performs its own Weak Area evidence check after
-- availability succeeds. Route that existing check through the same authority
-- so discovery, availability, and start cannot drift.
do $$
declare
  v_definition text := pg_get_functiondef(
    'exam_delivery.materialize_attempt_items_issue21_unrotated_base(uuid,uuid,integer)'::regprocedure
  );
  v_updated text;
begin
  if (
    select count(*)
    from regexp_matches(
      v_definition,
      'exam_delivery\.learner_weak_domain_evidence\(',
      'g'
    )
  ) <> 1 then
    raise exception 'issue160_practice_materializer_contract_drift';
  end if;

  v_updated := replace(
    v_definition,
    'exam_delivery.learner_weak_domain_evidence(',
    'exam_delivery.weak_domain_evidence_for_practice('
  );
  execute v_updated;
end
$$;

alter function exam_delivery.weak_domain_evidence_for_practice(uuid,uuid)
  owner to postgres;
alter function exam_delivery.weak_area_options(uuid,text,text)
  owner to postgres;
alter function exam_delivery.practice_availability(uuid,jsonb)
  owner to postgres;
alter function exam_delivery.materialize_attempt_items_issue21_unrotated_base(uuid,uuid,integer)
  owner to postgres;

revoke execute on function exam_delivery.weak_domain_evidence_for_practice(uuid,uuid)
  from public, anon, authenticated, service_role;
