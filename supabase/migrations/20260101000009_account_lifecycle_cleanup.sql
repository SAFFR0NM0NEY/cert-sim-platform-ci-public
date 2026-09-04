-- CertSim account lifecycle cleanup.
-- Apply manually after migrations 0001 through 0008.
-- This migration supports safe role removal, profile deactivation, and
-- user-created account deletion requests. It does not hard-delete Supabase
-- Auth users, add paid access enforcement, or use service-role logic.

alter table public.memberships
drop constraint if exists memberships_status_check;

alter table public.memberships
add constraint memberships_status_check check (
  status in ('active', 'invited', 'suspended', 'archived', 'removed')
);

alter table public.profiles
drop constraint if exists profiles_status_check;

alter table public.profiles
add constraint profiles_status_check check (
  status in ('active', 'invited', 'suspended', 'archived', 'deactivated')
);

create index if not exists memberships_status_idx
on public.memberships (status);

create index if not exists profiles_status_idx
on public.profiles (status);

create or replace function public.active_platform_owner_count()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer
  from public.memberships m
  where m.role = 'platform_owner'
    and m.status = 'active';
$$;

create or replace function public.is_last_active_platform_owner_membership(
  target_membership_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.memberships m
    where m.id = target_membership_id
      and m.role = 'platform_owner'
      and m.status = 'active'
  )
  and public.active_platform_owner_count() <= 1;
$$;

create or replace function public.can_manage_membership_lifecycle(
  target_membership_id uuid,
  target_status text
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select target_membership_id is not null
    and target_status in ('active', 'invited', 'suspended', 'archived', 'removed')
    and exists (
      select 1
      from public.memberships target_membership
      where target_membership.id = target_membership_id
        and not (
          target_membership.role = 'platform_owner'
          and target_membership.status = 'active'
          and target_status <> 'active'
          and public.active_platform_owner_count() <= 1
        )
        and (
          public.is_platform_owner()
          or exists (
            select 1
            from public.memberships manager
            where manager.user_id = auth.uid()
              and manager.status = 'active'
              and manager.organisation_id = target_membership.organisation_id
              and (
                (
                  manager.role = 'college_admin'
                  and target_membership.role not in ('platform_owner', 'developer')
                )
                or (
                  manager.role = 'campus_admin'
                  and target_membership.role not in (
                    'platform_owner',
                    'developer',
                    'college_admin'
                  )
                  and manager.campus_id is not null
                  and manager.campus_id = coalesce(
                    target_membership.campus_id,
                    (
                      select target_group.campus_id
                      from public."groups" target_group
                      where target_group.id = target_membership.group_id
                    )
                  )
                )
              )
          )
        )
    );
$$;

create or replace function public.update_membership_lifecycle_status(
  target_membership_id uuid,
  target_status text
)
returns table (
  id uuid,
  user_id uuid,
  organisation_id uuid,
  campus_id uuid,
  group_id uuid,
  role text,
  status text,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_status text;
begin
  if auth.uid() is null then
    raise exception 'Sign in to update membership lifecycle status.'
      using errcode = '42501';
  end if;

  normalized_status := nullif(btrim(coalesce(target_status, '')), '');

  if target_membership_id is null or normalized_status is null then
    raise exception 'Choose a membership and lifecycle status.'
      using errcode = '22023';
  end if;

  if normalized_status not in ('active', 'invited', 'suspended', 'archived', 'removed') then
    raise exception 'Choose a valid membership lifecycle status.'
      using errcode = '22023';
  end if;

  if public.is_last_active_platform_owner_membership(target_membership_id)
    and normalized_status <> 'active' then
    raise exception 'The last active Platform Owner cannot be removed or suspended.'
      using errcode = '42501';
  end if;

  if not public.can_manage_membership_lifecycle(
    target_membership_id,
    normalized_status
  ) then
    raise exception 'This membership role is not in your lifecycle-management scope.'
      using errcode = '42501';
  end if;

  update public.memberships membership
  set status = normalized_status,
      updated_at = now()
  where membership.id = target_membership_id;

  return query
    select
      membership.id,
      membership.user_id,
      membership.organisation_id,
      membership.campus_id,
      membership.group_id,
      membership.role,
      membership.status,
      membership.created_at,
      membership.updated_at
    from public.memberships membership
    where membership.id = target_membership_id;
end;
$$;

create or replace function public.is_last_active_platform_owner_profile(
  target_profile_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select target_profile_id is not null
    and public.active_platform_owner_count() <= 1
    and exists (
      select 1
      from public.memberships m
      where m.user_id = target_profile_id
        and m.role = 'platform_owner'
        and m.status = 'active'
    );
$$;

create or replace function public.update_managed_profile_status(
  target_profile_id uuid,
  target_status text
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
  normalized_status text;
begin
  if auth.uid() is null then
    raise exception 'Sign in to update profile lifecycle status.'
      using errcode = '42501';
  end if;

  normalized_status := nullif(btrim(coalesce(target_status, '')), '');

  if target_profile_id is null or normalized_status is null then
    raise exception 'Choose a visible profile and lifecycle status.'
      using errcode = '22023';
  end if;

  if normalized_status not in ('active', 'deactivated') then
    raise exception 'Choose active or deactivated profile status.'
      using errcode = '22023';
  end if;

  if normalized_status = 'deactivated'
    and public.is_last_active_platform_owner_profile(target_profile_id) then
    raise exception 'The last active Platform Owner profile cannot be deactivated.'
      using errcode = '42501';
  end if;

  if not public.is_platform_owner() then
    raise exception 'Only Platform Owner can deactivate or reactivate profiles in this phase.'
      using errcode = '42501';
  end if;

  update public.profiles profile
  set status = normalized_status,
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

create table if not exists public.account_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete set null,
  email_snapshot text,
  reason text,
  status text not null default 'open',
  requested_at timestamptz not null default now(),
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  admin_notes text,
  updated_at timestamptz not null default now(),
  constraint account_deletion_requests_status_check check (
    status in ('open', 'in_review', 'completed', 'cancelled')
  )
);

alter table public.account_deletion_requests
add column if not exists profile_id uuid references public.profiles(id) on delete cascade;

alter table public.account_deletion_requests
add column if not exists user_id uuid references public.profiles(id) on delete set null;

alter table public.account_deletion_requests
add column if not exists email_snapshot text;

alter table public.account_deletion_requests
add column if not exists reason text;

alter table public.account_deletion_requests
add column if not exists reviewed_by uuid references public.profiles(id) on delete set null;

alter table public.account_deletion_requests
add column if not exists reviewed_at timestamptz;

alter table public.account_deletion_requests
add column if not exists admin_notes text;

alter table public.account_deletion_requests
add column if not exists updated_at timestamptz not null default now();

alter table public.account_deletion_requests
alter column profile_id set not null;

alter table public.account_deletion_requests
drop constraint if exists account_deletion_requests_status_check;

alter table public.account_deletion_requests
add constraint account_deletion_requests_status_check check (
  status in ('open', 'in_review', 'completed', 'cancelled')
);

create index if not exists account_deletion_requests_profile_id_idx
on public.account_deletion_requests (profile_id);

create index if not exists account_deletion_requests_status_idx
on public.account_deletion_requests (status);

drop trigger if exists set_account_deletion_requests_updated_at
on public.account_deletion_requests;

create trigger set_account_deletion_requests_updated_at
before update on public.account_deletion_requests
for each row
execute function public.set_updated_at();

alter table public.account_deletion_requests enable row level security;

drop policy if exists account_deletion_requests_select_own_or_support
on public.account_deletion_requests;
create policy account_deletion_requests_select_own_or_support
on public.account_deletion_requests
for select
to authenticated
using (
  profile_id = auth.uid()
  or public.is_platform_owner()
  or public.has_developer_role()
);

drop policy if exists account_deletion_requests_insert_own
on public.account_deletion_requests;
create policy account_deletion_requests_insert_own
on public.account_deletion_requests
for insert
to authenticated
with check (
  profile_id = auth.uid()
  and coalesce(user_id, auth.uid()) = auth.uid()
  and status = 'open'
);

drop policy if exists account_deletion_requests_update_support
on public.account_deletion_requests;
create policy account_deletion_requests_update_support
on public.account_deletion_requests
for update
to authenticated
using (
  public.is_platform_owner()
  or (
    public.has_developer_role()
    and status in ('open', 'in_review')
  )
)
with check (
  public.is_platform_owner()
  or (
    public.has_developer_role()
    and status in ('open', 'in_review')
  )
);

create or replace function public.update_account_deletion_request_status(
  target_request_id uuid,
  target_status text,
  target_admin_notes text default null
)
returns table (
  id uuid,
  profile_id uuid,
  user_id uuid,
  email_snapshot text,
  reason text,
  status text,
  requested_at timestamptz,
  reviewed_by uuid,
  reviewed_at timestamptz,
  admin_notes text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_status text;
begin
  if auth.uid() is null then
    raise exception 'Sign in to update account deletion requests.'
      using errcode = '42501';
  end if;

  normalized_status := nullif(btrim(coalesce(target_status, '')), '');

  if target_request_id is null or normalized_status is null then
    raise exception 'Choose an account deletion request and status.'
      using errcode = '22023';
  end if;

  if normalized_status not in ('open', 'in_review', 'completed', 'cancelled') then
    raise exception 'Choose a valid account deletion request status.'
      using errcode = '22023';
  end if;

  if not (public.is_platform_owner() or public.has_developer_role()) then
    raise exception 'This account cannot update account deletion requests.'
      using errcode = '42501';
  end if;

  if normalized_status in ('completed', 'cancelled')
    and not public.is_platform_owner() then
    raise exception 'Only Platform Owner can complete or cancel account deletion requests.'
      using errcode = '42501';
  end if;

  if public.has_developer_role()
    and not public.is_platform_owner()
    and not exists (
      select 1
      from public.account_deletion_requests request
      where request.id = target_request_id
        and request.status in ('open', 'in_review')
    ) then
    raise exception 'Developer can triage only open or in-review account deletion requests.'
      using errcode = '42501';
  end if;

  update public.account_deletion_requests request
  set status = normalized_status,
      admin_notes = nullif(btrim(coalesce(target_admin_notes, '')), ''),
      reviewed_by = auth.uid(),
      reviewed_at = now()
  where request.id = target_request_id;

  return query
    select
      request.id,
      request.profile_id,
      request.user_id,
      request.email_snapshot,
      request.reason,
      request.status,
      request.requested_at,
      request.reviewed_by,
      request.reviewed_at,
      request.admin_notes
    from public.account_deletion_requests request
    where request.id = target_request_id;
end;
$$;

revoke update on public.account_deletion_requests from authenticated;
grant select, insert on public.account_deletion_requests to authenticated;

revoke all on function public.active_platform_owner_count() from public;
revoke all on function public.is_last_active_platform_owner_membership(uuid) from public;
revoke all on function public.can_manage_membership_lifecycle(uuid, text) from public;
revoke all on function public.update_membership_lifecycle_status(uuid, text) from public;
revoke all on function public.is_last_active_platform_owner_profile(uuid) from public;
revoke all on function public.update_managed_profile_status(uuid, text) from public;
revoke all on function public.update_account_deletion_request_status(uuid, text, text) from public;

grant execute on function public.active_platform_owner_count() to authenticated;
grant execute on function public.is_last_active_platform_owner_membership(uuid) to authenticated;
grant execute on function public.can_manage_membership_lifecycle(uuid, text) to authenticated;
grant execute on function public.update_membership_lifecycle_status(uuid, text) to authenticated;
grant execute on function public.is_last_active_platform_owner_profile(uuid) to authenticated;
grant execute on function public.update_managed_profile_status(uuid, text) to authenticated;
grant execute on function public.update_account_deletion_request_status(uuid, text, text) to authenticated;
