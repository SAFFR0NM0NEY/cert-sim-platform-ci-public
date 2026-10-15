-- Phase A generic multi-exam policy foundation. This migration is intentionally
-- inert until an operator creates and enables an exam policy in a later phase.

create table exam_delivery.exam_access_policies (
  canonical_exam_key text primary key,
  access_mode text not null,
  enabled boolean not null default false,
  require_published_package boolean not null default true,
  require_assignment boolean not null default false,
  policy_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  enabled_at timestamptz,
  disabled_at timestamptz,
  constraint exam_access_policies_key_check check (
    canonical_exam_key = lower(canonical_exam_key)
    and canonical_exam_key ~ '^[a-z0-9]+$'
  ),
  constraint exam_access_policies_mode_check check (
    access_mode in (
      'open_authenticated',
      'assignment_required',
      'organisation_scoped',
      'controlled_beta',
      'disabled'
    )
  ),
  constraint exam_access_policies_version_check check (policy_version > 0),
  constraint exam_access_policies_activation_check check (
    (enabled and access_mode <> 'disabled' and enabled_at is not null and disabled_at is null)
    or (not enabled and enabled_at is null)
  )
);

create table exam_delivery.exam_access_organisations (
  canonical_exam_key text not null
    references exam_delivery.exam_access_policies(canonical_exam_key) on delete restrict,
  organisation_id uuid not null references public.organisations(id) on delete restrict,
  enabled boolean not null default false,
  access_starts_at timestamptz,
  access_ends_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (canonical_exam_key, organisation_id),
  constraint exam_access_organisations_window_check check (
    access_ends_at is null or access_starts_at is null or access_ends_at > access_starts_at
  )
);

create table exam_delivery.exam_access_learners (
  canonical_exam_key text not null
    references exam_delivery.exam_access_policies(canonical_exam_key) on delete restrict,
  learner_id uuid not null references auth.users(id) on delete restrict,
  enabled boolean not null default false,
  access_starts_at timestamptz,
  access_ends_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (canonical_exam_key, learner_id),
  constraint exam_access_learners_window_check check (
    access_ends_at is null or access_starts_at is null or access_ends_at > access_starts_at
  )
);

create index exam_access_organisations_runtime_idx
  on exam_delivery.exam_access_organisations
    (organisation_id, canonical_exam_key)
  where enabled;

create index exam_access_learners_runtime_idx
  on exam_delivery.exam_access_learners
    (learner_id, canonical_exam_key)
  where enabled;

alter table exam_delivery.exam_access_policies enable row level security;
alter table exam_delivery.exam_access_organisations enable row level security;
alter table exam_delivery.exam_access_learners enable row level security;

revoke all on exam_delivery.exam_access_policies
  from public, anon, authenticated, service_role;
revoke all on exam_delivery.exam_access_organisations
  from public, anon, authenticated, service_role;
revoke all on exam_delivery.exam_access_learners
  from public, anon, authenticated, service_role;

create function exam_delivery.normalize_exam_key(p_exam_key text)
returns text
language sql
immutable
strict
security invoker
set search_path = ''
as $$
  select nullif(
    pg_catalog.regexp_replace(
      pg_catalog.lower(pg_catalog.btrim(p_exam_key)),
      '[^a-z0-9]+',
      '',
      'g'
    ),
    ''
  )
$$;

create function exam_delivery.evaluate_access_policy(
  p_exam_key text,
  p_profile_key text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '10s'
as $$
declare
  v_actor uuid := auth.uid();
  v_exam_key text := exam_delivery.normalize_exam_key(p_exam_key);
  v_now timestamptz := statement_timestamp();
  v_policy exam_delivery.exam_access_policies%rowtype;
  v_package record;
  v_assignment record;
  v_allowed boolean := false;
begin
  if v_actor is null then
    return pg_catalog.jsonb_build_object('eligible', false, 'reasonCode', 'authentication_required');
  end if;
  if v_exam_key is null or nullif(pg_catalog.btrim(p_profile_key), '') is null then
    return pg_catalog.jsonb_build_object('eligible', false, 'reasonCode', 'invalid_request');
  end if;
  if not exists (
    select 1 from public.profiles p where p.id = v_actor and p.status = 'active'
  ) then
    return pg_catalog.jsonb_build_object('eligible', false, 'reasonCode', 'inactive_account');
  end if;

  select p.* into v_policy
  from exam_delivery.exam_access_policies p
  where p.canonical_exam_key = v_exam_key;

  if not found or not v_policy.enabled or v_policy.access_mode = 'disabled' then
    return pg_catalog.jsonb_build_object('eligible', false, 'reasonCode', 'exam_disabled');
  end if;

  select pv.id as package_version_id, pv.package_version, pp.id as package_profile_id,
         pp.profile_key, pp.display_name, pp.question_count, pp.time_limit_minutes
    into v_package
  from exam_delivery.package_versions pv
  join exam_delivery.package_profiles pp on pp.package_version_id = pv.id
  where exam_delivery.normalize_exam_key(pv.exam_key) = v_exam_key
    and pp.profile_key = p_profile_key
    and (not v_policy.require_published_package or pv.status = 'published')
  order by pv.published_at desc nulls last, pv.created_at desc
  limit 1;

  if not found then
    return pg_catalog.jsonb_build_object('eligible', false, 'reasonCode', 'package_unavailable');
  end if;

  if v_policy.access_mode = 'open_authenticated' then
    v_allowed := true;
  elsif v_policy.access_mode = 'organisation_scoped' then
    v_allowed := exists (
      select 1
      from public.memberships m
      join public.organisations o on o.id = m.organisation_id and o.status = 'active'
      join exam_delivery.exam_access_organisations scope
        on scope.organisation_id = m.organisation_id
       and scope.canonical_exam_key = v_exam_key
       and scope.enabled
      where m.user_id = v_actor and m.status = 'active'
        and (scope.access_starts_at is null or scope.access_starts_at <= v_now)
        and (scope.access_ends_at is null or scope.access_ends_at > v_now)
    );
  elsif v_policy.access_mode = 'controlled_beta' then
    v_allowed := exists (
      select 1 from exam_delivery.exam_access_learners learner
      where learner.canonical_exam_key = v_exam_key
        and learner.learner_id = v_actor and learner.enabled
        and (learner.access_starts_at is null or learner.access_starts_at <= v_now)
        and (learner.access_ends_at is null or learner.access_ends_at > v_now)
    );
  elsif v_policy.access_mode = 'assignment_required' then
    v_allowed := true;
  end if;

  if not v_allowed then
    return pg_catalog.jsonb_build_object('eligible', false, 'reasonCode', 'access_not_granted');
  end if;

  if v_policy.require_assignment or v_policy.access_mode = 'assignment_required' then
    select a.id, a.maximum_attempts
      into v_assignment
    from exam_delivery.protected_assignments a
    join public.memberships m
      on m.user_id = a.learner_id
     and m.organisation_id = a.organisation_id
     and m.role = 'student' and m.status = 'active'
    join public.organisations o on o.id = a.organisation_id and o.status = 'active'
    where a.learner_id = v_actor
      and a.package_version_id = v_package.package_version_id
      and a.package_profile_id = v_package.package_profile_id
      and a.status = 'active'
      and a.available_from <= v_now
      and (a.expires_at is null or a.expires_at > v_now)
    limit 1;

    if not found then
      return pg_catalog.jsonb_build_object('eligible', false, 'reasonCode', 'assignment_required');
    end if;

    if (
      select pg_catalog.count(*)
      from exam_delivery.attempts attempt
      where attempt.protected_assignment_id = v_assignment.id
        and attempt.status <> 'voided'
    ) >= v_assignment.maximum_attempts and not exists (
      select 1 from exam_delivery.attempts attempt
      where attempt.protected_assignment_id = v_assignment.id
        and attempt.owner_id = v_actor and attempt.status = 'in_progress'
    ) then
      return pg_catalog.jsonb_build_object('eligible', false, 'reasonCode', 'attempt_limit_reached');
    end if;
  end if;

  return pg_catalog.jsonb_build_object(
    'eligible', true,
    'reasonCode', 'eligible',
    'examKey', v_exam_key,
    'packageVersion', v_package.package_version,
    'profileKey', v_package.profile_key,
    'profileName', v_package.display_name,
    'questionCount', v_package.question_count,
    'timeLimitMinutes', v_package.time_limit_minutes
  );
end;
$$;

create function public.certsim_protected_evaluate_access_policy(
  p_exam_key text,
  p_profile_key text
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select exam_delivery.evaluate_access_policy(p_exam_key, p_profile_key)
$$;

revoke execute on function exam_delivery.normalize_exam_key(text)
  from public, anon, authenticated, service_role;
revoke execute on function exam_delivery.evaluate_access_policy(text, text)
  from public, anon, authenticated, service_role;
revoke execute on function public.certsim_protected_evaluate_access_policy(text, text)
  from public, anon, authenticated, service_role;

grant usage on schema exam_delivery to authenticated;
grant execute on function exam_delivery.evaluate_access_policy(text, text) to authenticated;
grant execute on function public.certsim_protected_evaluate_access_policy(text, text) to authenticated;

comment on table exam_delivery.exam_access_policies is
  'Inert generic access-policy definitions. A later controlled phase must create and enable rows.';
comment on function exam_delivery.normalize_exam_key(text) is
  'Deterministic compact exam-key normalization; ai-901 and ai901 both normalize to ai901.';
