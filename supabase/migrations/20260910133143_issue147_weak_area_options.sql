-- Issue #147 Phase B: expose only server-authoritative Weak Area eligibility.
-- Empty evidence is a successful discovery result; the existing availability
-- boundary remains authoritative for the selected practice configuration.

create function exam_delivery.weak_area_options(
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
  from exam_delivery.learner_weak_domain_evidence(
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

create function public.certsim_protected_weak_area_options(
  p_actor_id uuid,
  p_exam_key text,
  p_profile_key text
) returns jsonb
language sql stable security invoker
set search_path = ''
as $$
  select exam_delivery.weak_area_options(p_actor_id, p_exam_key, p_profile_key)
$$;

alter function exam_delivery.weak_area_options(uuid,text,text) owner to postgres;
alter function public.certsim_protected_weak_area_options(uuid,text,text) owner to postgres;

revoke execute on function exam_delivery.weak_area_options(uuid,text,text),
  public.certsim_protected_weak_area_options(uuid,text,text)
  from public, anon, authenticated, service_role;

grant execute on function exam_delivery.weak_area_options(uuid,text,text),
  public.certsim_protected_weak_area_options(uuid,text,text)
  to service_role;
