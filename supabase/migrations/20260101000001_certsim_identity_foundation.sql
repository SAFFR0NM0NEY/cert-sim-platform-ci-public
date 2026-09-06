-- CertSim identity foundation.
-- Apply manually in Supabase SQL Editor or through Supabase CLI when ready.
-- This migration creates profiles, organisations, campuses, groups, and memberships only.
-- It does not create attempt/result storage or enforce frontend access control.

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  display_name text,
  phone text,
  user_type text not null default 'individual',
  default_role text not null default 'individual_user',
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_user_type_check check (
    user_type in ('platform', 'organisation', 'individual')
  ),
  constraint profiles_default_role_check check (
    default_role in (
      'platform_owner',
      'college_admin',
      'campus_admin',
      'trainer',
      'reception',
      'student',
      'individual_user'
    )
  ),
  constraint profiles_status_check check (
    status in ('active', 'invited', 'suspended', 'archived')
  )
);

create table if not exists public.organisations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  organisation_type text not null,
  status text not null default 'active',
  billing_model text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organisations_type_check check (
    organisation_type in (
      'training_provider',
      'company',
      'internal',
      'individual_market'
    )
  ),
  constraint organisations_status_check check (
    status in ('active', 'invited', 'suspended', 'archived')
  )
);

create table if not exists public.campuses (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  name text not null,
  code text,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint campuses_status_check check (
    status in ('active', 'invited', 'suspended', 'archived')
  )
);

create table if not exists public."groups" (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  campus_id uuid references public.campuses(id) on delete set null,
  name text not null,
  academic_year integer,
  max_students integer not null default 50,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint groups_max_students_check check (max_students >= 0),
  constraint groups_status_check check (
    status in ('active', 'invited', 'suspended', 'archived')
  )
);

create table if not exists public.memberships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  campus_id uuid references public.campuses(id) on delete set null,
  group_id uuid references public."groups"(id) on delete set null,
  role text not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint memberships_role_check check (
    role in (
      'platform_owner',
      'college_admin',
      'campus_admin',
      'trainer',
      'reception',
      'student',
      'individual_user'
    )
  ),
  constraint memberships_status_check check (
    status in ('active', 'invited', 'suspended', 'archived')
  )
);

create index if not exists profiles_email_idx on public.profiles (lower(email));
create index if not exists campuses_organisation_id_idx on public.campuses (organisation_id);
create index if not exists campuses_code_idx on public.campuses (organisation_id, code);
create index if not exists groups_organisation_id_idx on public."groups" (organisation_id);
create index if not exists groups_campus_id_idx on public."groups" (campus_id);
create index if not exists memberships_user_id_idx on public.memberships (user_id);
create index if not exists memberships_organisation_id_idx on public.memberships (organisation_id);
create index if not exists memberships_campus_id_idx on public.memberships (campus_id);
create index if not exists memberships_group_id_idx on public.memberships (group_id);
create index if not exists memberships_role_idx on public.memberships (role);

drop trigger if exists set_profiles_updated_at on public.profiles;
create trigger set_profiles_updated_at
before update on public.profiles
for each row
execute function public.set_updated_at();

drop trigger if exists set_organisations_updated_at on public.organisations;
create trigger set_organisations_updated_at
before update on public.organisations
for each row
execute function public.set_updated_at();

drop trigger if exists set_campuses_updated_at on public.campuses;
create trigger set_campuses_updated_at
before update on public.campuses
for each row
execute function public.set_updated_at();

drop trigger if exists set_groups_updated_at on public."groups";
create trigger set_groups_updated_at
before update on public."groups"
for each row
execute function public.set_updated_at();

drop trigger if exists set_memberships_updated_at on public.memberships;
create trigger set_memberships_updated_at
before update on public.memberships
for each row
execute function public.set_updated_at();

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  metadata_full_name text;
  metadata_display_name text;
begin
  metadata_full_name := nullif(
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name'
    ),
    ''
  );

  metadata_display_name := nullif(
    coalesce(
      new.raw_user_meta_data ->> 'display_name',
      new.raw_user_meta_data ->> 'name',
      new.raw_user_meta_data ->> 'full_name',
      split_part(coalesce(new.email, ''), '@', 1)
    ),
    ''
  );

  insert into public.profiles (
    id,
    email,
    full_name,
    display_name,
    user_type,
    default_role,
    status
  )
  values (
    new.id,
    new.email,
    metadata_full_name,
    metadata_display_name,
    'individual',
    'individual_user',
    'active'
  )
  on conflict (id) do update
    set email = excluded.email,
        updated_at = now();

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row
execute function public.handle_new_auth_user();

create or replace function public.is_platform_owner(target_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.memberships m
    where m.user_id = coalesce(target_user_id, auth.uid())
      and m.role = 'platform_owner'
      and m.status = 'active'
  );
$$;

create or replace function public.has_organisation_membership(target_organisation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select target_organisation_id is not null
    and exists (
      select 1
      from public.memberships m
      where m.user_id = auth.uid()
        and m.organisation_id = target_organisation_id
        and m.status = 'active'
    );
$$;

create or replace function public.has_campus_membership(target_campus_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select target_campus_id is not null
    and exists (
      select 1
      from public.memberships m
      where m.user_id = auth.uid()
        and m.campus_id = target_campus_id
        and m.status = 'active'
    );
$$;

create or replace function public.has_group_membership(target_group_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select target_group_id is not null
    and exists (
      select 1
      from public.memberships m
      where m.user_id = auth.uid()
        and m.group_id = target_group_id
        and m.status = 'active'
    );
$$;

alter table public.profiles enable row level security;
alter table public.organisations enable row level security;
alter table public.campuses enable row level security;
alter table public."groups" enable row level security;
alter table public.memberships enable row level security;

drop policy if exists profiles_select_own_or_platform_owner on public.profiles;
create policy profiles_select_own_or_platform_owner
on public.profiles
for select
to authenticated
using (id = auth.uid() or public.is_platform_owner());

drop policy if exists profiles_update_own_basic_fields on public.profiles;
create policy profiles_update_own_basic_fields
on public.profiles
for update
to authenticated
using (id = auth.uid())
with check (id = auth.uid());

drop policy if exists organisations_select_member_or_platform_owner on public.organisations;
create policy organisations_select_member_or_platform_owner
on public.organisations
for select
to authenticated
using (public.is_platform_owner() or public.has_organisation_membership(id));

drop policy if exists campuses_select_member_or_platform_owner on public.campuses;
create policy campuses_select_member_or_platform_owner
on public.campuses
for select
to authenticated
using (
  public.is_platform_owner()
  or public.has_organisation_membership(organisation_id)
  or public.has_campus_membership(id)
);

drop policy if exists groups_select_member_or_platform_owner on public."groups";
create policy groups_select_member_or_platform_owner
on public."groups"
for select
to authenticated
using (
  public.is_platform_owner()
  or public.has_organisation_membership(organisation_id)
  or public.has_campus_membership(campus_id)
  or public.has_group_membership(id)
);

drop policy if exists memberships_select_own_or_platform_owner on public.memberships;
create policy memberships_select_own_or_platform_owner
on public.memberships
for select
to authenticated
using (user_id = auth.uid() or public.is_platform_owner());

revoke all on public.profiles from anon, authenticated;
revoke all on public.organisations from anon, authenticated;
revoke all on public.campuses from anon, authenticated;
revoke all on public."groups" from anon, authenticated;
revoke all on public.memberships from anon, authenticated;

grant select on public.profiles to authenticated;
grant update (full_name, display_name, phone, updated_at) on public.profiles to authenticated;
grant select on public.organisations to authenticated;
grant select on public.campuses to authenticated;
grant select on public."groups" to authenticated;
grant select on public.memberships to authenticated;

revoke all on function public.is_platform_owner(uuid) from public;
revoke all on function public.has_organisation_membership(uuid) from public;
revoke all on function public.has_campus_membership(uuid) from public;
revoke all on function public.has_group_membership(uuid) from public;

grant execute on function public.is_platform_owner(uuid) to authenticated;
grant execute on function public.has_organisation_membership(uuid) to authenticated;
grant execute on function public.has_campus_membership(uuid) to authenticated;
grant execute on function public.has_group_membership(uuid) to authenticated;
