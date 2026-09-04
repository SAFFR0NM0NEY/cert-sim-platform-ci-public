-- CertSim profile display-name management.
-- Apply manually after migrations 0001 through 0005.
-- This adds a scoped, authenticated RPC for display-name corrections and
-- self-service display-name updates only.
-- It does not create auth users, invites, access enforcement, service-role
-- logic, or broad public profile reads.

create or replace function public.update_managed_profile_display_name(
  target_profile_id uuid,
  target_display_name text,
  target_full_name text default null
)
returns table (
  id uuid,
  email text,
  full_name text,
  display_name text,
  status text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_display_name text;
  normalized_full_name text;
begin
  if auth.uid() is null then
    raise exception 'Sign in to update profile display names.'
      using errcode = '42501';
  end if;

  if target_profile_id is null then
    raise exception 'Choose a visible profile to update.'
      using errcode = '22023';
  end if;

  normalized_display_name := nullif(btrim(coalesce(target_display_name, '')), '');
  normalized_full_name := nullif(btrim(coalesce(target_full_name, '')), '');

  if normalized_display_name is null then
    raise exception 'Display name is required.'
      using errcode = '22023';
  end if;

  if not (
    target_profile_id = auth.uid()
    or public.is_platform_owner()
    or public.can_trainer_view_student(target_profile_id)
  ) then
    raise exception 'This profile is not visible to your account.'
      using errcode = '42501';
  end if;

  update public.profiles profile
  set display_name = normalized_display_name,
      full_name = case
        when
          (target_profile_id = auth.uid() or public.is_platform_owner())
          and normalized_full_name is not null
          then normalized_full_name
        else profile.full_name
      end,
      updated_at = now()
  where profile.id = target_profile_id;

  return query
    select
      profile.id,
      profile.email,
      profile.full_name,
      profile.display_name,
      profile.status
    from public.profiles profile
    where profile.id = target_profile_id;
end;
$$;

revoke all on function public.update_managed_profile_display_name(uuid, text, text)
from public;

grant execute on function public.update_managed_profile_display_name(uuid, text, text) to authenticated;
