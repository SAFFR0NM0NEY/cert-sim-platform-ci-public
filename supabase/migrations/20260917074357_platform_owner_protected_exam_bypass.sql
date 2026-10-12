-- Protected-exam profile use has a narrower authority boundary than staff
-- administration and reporting. Only an active Platform Owner may bypass an
-- assignment or purchase entitlement for an enabled production profile.

create or replace function exam_delivery.has_staff_profile_access(
  p_actor_id uuid,
  p_package_version_id uuid,
  p_package_profile_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
set statement_timeout = '3s'
as $$
  select p_actor_id is not null
    and exists (
      select 1
      from public.profiles profile
      where profile.id = p_actor_id
        and profile.status = 'active'
    )
    and exists (
      select 1
      from public.memberships membership
      where membership.user_id = p_actor_id
        and membership.status = 'active'
        and membership.role = 'platform_owner'
    )
    and exists (
      select 1
      from exam_delivery.exam_profile_activations activation
      where activation.package_version_id = p_package_version_id
        and activation.package_profile_id = p_package_profile_id
        and activation.activation_kind = 'production'
        and activation.enabled
    )
$$;

alter function exam_delivery.has_staff_profile_access(uuid, uuid, uuid)
  owner to postgres;

revoke execute on function exam_delivery.has_staff_profile_access(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
