-- CertSim onboarding invites, access codes, and bulk student onboarding MVP.
-- Apply after 0010_report_workflow_polish.sql.
-- This migration creates onboarding records only. It does not create auth users,
-- send email, enforce paid access, block exams, or use service-role logic.

create extension if not exists pgcrypto;

create table if not exists public.onboarding_invites (
  id uuid primary key default gen_random_uuid(),
  invite_token text not null unique default encode(gen_random_bytes(24), 'hex'),
  invite_code text unique,
  email text,
  intended_role text not null default 'student',
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  campus_id uuid references public.campuses(id) on delete cascade,
  group_id uuid references public."groups"(id) on delete cascade,
  status text not null default 'pending',
  expires_at timestamptz,
  invited_by uuid references public.profiles(id) on delete set null,
  accepted_by_profile_id uuid references public.profiles(id) on delete set null,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  notes text,
  constraint onboarding_invites_status_check check (
    status in ('pending', 'accepted', 'expired', 'revoked')
  ),
  constraint onboarding_invites_role_check check (
    intended_role in (
      'college_admin',
      'campus_admin',
      'trainer',
      'reception',
      'student',
      'individual_user'
    )
  )
);

create table if not exists public.group_access_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique default upper(substr(encode(gen_random_bytes(16), 'hex'), 1, 16)),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  campus_id uuid references public.campuses(id) on delete cascade,
  group_id uuid not null references public."groups"(id) on delete cascade,
  intended_role text not null default 'student',
  status text not null default 'active',
  max_uses integer,
  uses_count integer not null default 0,
  expires_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  notes text,
  constraint group_access_codes_status_check check (
    status in ('active', 'disabled', 'expired')
  ),
  constraint group_access_codes_role_check check (
    intended_role = 'student'
  ),
  constraint group_access_codes_max_uses_check check (
    max_uses is null or max_uses > 0
  ),
  constraint group_access_codes_uses_count_check check (
    uses_count >= 0
  )
);

create table if not exists public.bulk_onboarding_batches (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  campus_id uuid references public.campuses(id) on delete cascade,
  group_id uuid references public."groups"(id) on delete cascade,
  created_by uuid references public.profiles(id) on delete set null,
  status text not null default 'generated',
  total_rows integer not null default 0,
  accepted_rows integer not null default 0,
  failed_rows integer not null default 0,
  created_at timestamptz not null default now(),
  notes text,
  constraint bulk_onboarding_batches_status_check check (
    status in ('generated', 'partial', 'failed', 'archived')
  )
);

create index if not exists onboarding_invites_token_idx
on public.onboarding_invites (invite_token);

create index if not exists onboarding_invites_invite_code_idx
on public.onboarding_invites (invite_code);

create index if not exists onboarding_invites_scope_idx
on public.onboarding_invites (organisation_id, campus_id, group_id);

create index if not exists onboarding_invites_status_idx
on public.onboarding_invites (status);

create index if not exists onboarding_invites_email_idx
on public.onboarding_invites (lower(email));

create index if not exists group_access_codes_code_idx
on public.group_access_codes (code);

create index if not exists group_access_codes_scope_idx
on public.group_access_codes (organisation_id, campus_id, group_id);

create index if not exists group_access_codes_status_idx
on public.group_access_codes (status);

create index if not exists bulk_onboarding_batches_scope_idx
on public.bulk_onboarding_batches (organisation_id, campus_id, group_id);

drop trigger if exists set_onboarding_invites_updated_at on public.onboarding_invites;
create trigger set_onboarding_invites_updated_at
before update on public.onboarding_invites
for each row execute function public.set_updated_at();

drop trigger if exists set_group_access_codes_updated_at on public.group_access_codes;
create trigger set_group_access_codes_updated_at
before update on public.group_access_codes
for each row execute function public.set_updated_at();

create or replace function public.can_manage_onboarding_scope(
  target_organisation_id uuid,
  target_campus_id uuid,
  target_group_id uuid,
  target_intended_role text default 'student'
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null
    and target_organisation_id is not null
    and target_intended_role not in ('platform_owner', 'developer')
    and (
      public.is_platform_owner(auth.uid())
      or exists (
        select 1
        from public.memberships manager
        where manager.user_id = auth.uid()
          and manager.status = 'active'
          and manager.organisation_id = target_organisation_id
          and (
            (
              manager.role = 'college_admin'
              and target_intended_role not in ('platform_owner', 'developer')
            )
            or (
              manager.role = 'campus_admin'
              and target_campus_id is not null
              and manager.campus_id = target_campus_id
              and target_intended_role in ('trainer', 'reception', 'student', 'individual_user')
            )
          )
      )
    );
$$;

create or replace function public.can_view_onboarding_scope(
  target_organisation_id uuid,
  target_campus_id uuid,
  target_group_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null
    and target_organisation_id is not null
    and (
      public.is_platform_owner(auth.uid())
      or public.has_developer_role(auth.uid())
      or public.can_manage_onboarding_scope(
        target_organisation_id,
        target_campus_id,
        target_group_id,
        'student'
      )
      or (
        target_group_id is not null
        and public.can_trainer_view_group(target_group_id)
      )
    );
$$;

create or replace function public.resolve_onboarding_scope(
  target_organisation_id uuid,
  target_campus_id uuid,
  target_group_id uuid
)
returns table (
  organisation_id uuid,
  campus_id uuid,
  group_id uuid
)
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce(target_organisation_id, grp.organisation_id, campus.organisation_id) as organisation_id,
    coalesce(target_campus_id, grp.campus_id) as campus_id,
    target_group_id as group_id
  from (select 1) seed
  left join public."groups" grp
    on grp.id = target_group_id
  left join public.campuses campus
    on campus.id = coalesce(target_campus_id, grp.campus_id);
$$;

create or replace function public.mask_invite_email(target_email text)
returns text
language sql
stable
as $$
  select case
    when target_email is null or length(trim(target_email)) = 0 then null
    when position('@' in target_email) = 0 then 'email-specific invite'
    else lower(substr(trim(target_email), 1, 1)) || '***' || substr(trim(target_email), position('@' in trim(target_email)))
  end;
$$;

create or replace function public.get_join_invite_summary(target_invite_token text)
returns table (
  kind text,
  status text,
  intended_role text,
  organisation_name text,
  campus_name text,
  group_name text,
  expires_at timestamptz,
  email_required boolean,
  email_hint text,
  is_usable boolean,
  message text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  invite_record public.onboarding_invites%rowtype;
begin
  select *
  into invite_record
  from public.onboarding_invites
  where invite_token = trim(target_invite_token)
  limit 1;

  if invite_record.id is null then
    return query select
      'invite'::text,
      'not_found'::text,
      null::text,
      null::text,
      null::text,
      null::text,
      null::timestamptz,
      false,
      null::text,
      false,
      'This invite link is not valid.'::text;
    return;
  end if;

  return query
  select
    'invite'::text,
    case
      when invite_record.status = 'pending'
        and invite_record.expires_at is not null
        and invite_record.expires_at < now()
        then 'expired'
      else invite_record.status
    end,
    invite_record.intended_role,
    org.name,
    campus.name,
    grp.name,
    invite_record.expires_at,
    invite_record.email is not null,
    public.mask_invite_email(invite_record.email),
    invite_record.status = 'pending'
      and (invite_record.expires_at is null or invite_record.expires_at >= now()),
    case
      when invite_record.status = 'accepted' then 'This invite has already been accepted.'
      when invite_record.status = 'revoked' then 'This invite was revoked.'
      when invite_record.expires_at is not null and invite_record.expires_at < now()
        then 'This invite has expired.'
      else 'Sign in or create an account to accept this invite.'
    end
  from public.organisations org
  left join public.campuses campus on campus.id = invite_record.campus_id
  left join public."groups" grp on grp.id = invite_record.group_id
  where org.id = invite_record.organisation_id;
end;
$$;

create or replace function public.get_join_code_summary(target_code text)
returns table (
  kind text,
  status text,
  intended_role text,
  organisation_name text,
  campus_name text,
  group_name text,
  expires_at timestamptz,
  email_required boolean,
  email_hint text,
  is_usable boolean,
  message text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  code_record public.group_access_codes%rowtype;
begin
  select *
  into code_record
  from public.group_access_codes
  where upper(code) = upper(trim(target_code))
  limit 1;

  if code_record.id is null then
    return query select
      'code'::text,
      'not_found'::text,
      'student'::text,
      null::text,
      null::text,
      null::text,
      null::timestamptz,
      false,
      null::text,
      false,
      'This access code is not valid.'::text;
    return;
  end if;

  return query
  select
    'code'::text,
    case
      when code_record.status = 'active'
        and code_record.expires_at is not null
        and code_record.expires_at < now()
        then 'expired'
      when code_record.status = 'active'
        and code_record.max_uses is not null
        and code_record.uses_count >= code_record.max_uses
        then 'expired'
      else code_record.status
    end,
    code_record.intended_role,
    org.name,
    campus.name,
    grp.name,
    code_record.expires_at,
    false,
    null::text,
    code_record.status = 'active'
      and (code_record.expires_at is null or code_record.expires_at >= now())
      and (code_record.max_uses is null or code_record.uses_count < code_record.max_uses),
    case
      when code_record.status = 'disabled' then 'This group access code is disabled.'
      when code_record.expires_at is not null and code_record.expires_at < now()
        then 'This group access code has expired.'
      when code_record.max_uses is not null and code_record.uses_count >= code_record.max_uses
        then 'This group access code has reached its use limit.'
      else 'Sign in or create an account to join this group.'
    end
  from public.organisations org
  left join public.campuses campus on campus.id = code_record.campus_id
  join public."groups" grp on grp.id = code_record.group_id
  where org.id = code_record.organisation_id;
end;
$$;

create or replace function public.create_onboarding_invite(
  target_email text,
  target_intended_role text,
  target_organisation_id uuid,
  target_campus_id uuid,
  target_group_id uuid,
  target_expires_at timestamptz,
  target_notes text
)
returns public.onboarding_invites
language plpgsql
security definer
set search_path = public
as $$
declare
  resolved_scope record;
  normalized_role text := coalesce(nullif(trim(target_intended_role), ''), 'student');
  normalized_email text := nullif(lower(trim(target_email)), '');
  created_invite public.onboarding_invites%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Sign in with a scoped admin account to create onboarding invites.';
  end if;

  if normalized_role in ('platform_owner', 'developer') then
    raise exception 'Elevated platform roles cannot be granted through onboarding invites.';
  end if;

  select *
  into resolved_scope
  from public.resolve_onboarding_scope(
    target_organisation_id,
    target_campus_id,
    target_group_id
  )
  limit 1;

  if resolved_scope.organisation_id is null then
    raise exception 'Choose a valid organisation, campus, or group for this invite.';
  end if;

  if not public.can_manage_onboarding_scope(
    resolved_scope.organisation_id,
    resolved_scope.campus_id,
    resolved_scope.group_id,
    normalized_role
  ) then
    raise exception 'This invite is outside your onboarding management scope.';
  end if;

  insert into public.onboarding_invites (
    email,
    intended_role,
    organisation_id,
    campus_id,
    group_id,
    status,
    expires_at,
    invited_by,
    notes
  )
  values (
    normalized_email,
    normalized_role,
    resolved_scope.organisation_id,
    resolved_scope.campus_id,
    resolved_scope.group_id,
    'pending',
    target_expires_at,
    auth.uid(),
    nullif(trim(target_notes), '')
  )
  returning * into created_invite;

  return created_invite;
end;
$$;

create or replace function public.revoke_onboarding_invite(target_invite_id uuid)
returns public.onboarding_invites
language plpgsql
security definer
set search_path = public
as $$
declare
  invite_record public.onboarding_invites%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Sign in with a scoped admin account to revoke onboarding invites.';
  end if;

  select *
  into invite_record
  from public.onboarding_invites
  where id = target_invite_id
  limit 1;

  if invite_record.id is null then
    raise exception 'Choose a valid onboarding invite.';
  end if;

  if not public.can_manage_onboarding_scope(
    invite_record.organisation_id,
    invite_record.campus_id,
    invite_record.group_id,
    invite_record.intended_role
  ) then
    raise exception 'This invite is outside your onboarding management scope.';
  end if;

  update public.onboarding_invites
  set status = 'revoked'
  where id = invite_record.id
    and status = 'pending'
  returning * into invite_record;

  return invite_record;
end;
$$;

create or replace function public.create_group_access_code(
  target_group_id uuid,
  target_max_uses integer,
  target_expires_at timestamptz,
  target_notes text
)
returns public.group_access_codes
language plpgsql
security definer
set search_path = public
as $$
declare
  group_record public."groups"%rowtype;
  created_code public.group_access_codes%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Sign in with a scoped admin account to create group access codes.';
  end if;

  select *
  into group_record
  from public."groups"
  where id = target_group_id
  limit 1;

  if group_record.id is null then
    raise exception 'Choose a valid group/class.';
  end if;

  if not public.can_manage_onboarding_scope(
    group_record.organisation_id,
    group_record.campus_id,
    group_record.id,
    'student'
  ) then
    raise exception 'This group access code is outside your onboarding management scope.';
  end if;

  insert into public.group_access_codes (
    organisation_id,
    campus_id,
    group_id,
    intended_role,
    status,
    max_uses,
    expires_at,
    created_by,
    notes
  )
  values (
    group_record.organisation_id,
    group_record.campus_id,
    group_record.id,
    'student',
    'active',
    target_max_uses,
    target_expires_at,
    auth.uid(),
    nullif(trim(target_notes), '')
  )
  returning * into created_code;

  return created_code;
end;
$$;

create or replace function public.disable_group_access_code(target_code_id uuid)
returns public.group_access_codes
language plpgsql
security definer
set search_path = public
as $$
declare
  code_record public.group_access_codes%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Sign in with a scoped admin account to disable group access codes.';
  end if;

  select *
  into code_record
  from public.group_access_codes
  where id = target_code_id
  limit 1;

  if code_record.id is null then
    raise exception 'Choose a valid group access code.';
  end if;

  if not public.can_manage_onboarding_scope(
    code_record.organisation_id,
    code_record.campus_id,
    code_record.group_id,
    'student'
  ) then
    raise exception 'This group access code is outside your onboarding management scope.';
  end if;

  update public.group_access_codes
  set status = 'disabled'
  where id = code_record.id
    and status = 'active'
  returning * into code_record;

  return code_record;
end;
$$;

create or replace function public.accept_onboarding_invite(target_invite_token text)
returns table (
  membership_id uuid,
  organisation_name text,
  campus_name text,
  group_name text,
  role text,
  message text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  invite_record public.onboarding_invites%rowtype;
  requester_email text;
  existing_membership_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in or create an account before accepting this invite.';
  end if;

  select *
  into invite_record
  from public.onboarding_invites
  where invite_token = trim(target_invite_token)
  for update;

  if invite_record.id is null then
    raise exception 'This invite link is not valid.';
  end if;

  if invite_record.status <> 'pending' then
    raise exception 'This invite is not available anymore.';
  end if;

  if invite_record.expires_at is not null and invite_record.expires_at < now() then
    update public.onboarding_invites
    set status = 'expired'
    where id = invite_record.id;
    raise exception 'This invite has expired.';
  end if;

  if invite_record.intended_role in ('platform_owner', 'developer') then
    raise exception 'Elevated platform roles cannot be accepted through onboarding invites.';
  end if;

  select lower(email)
  into requester_email
  from auth.users
  where id = auth.uid();

  if invite_record.email is not null
    and lower(invite_record.email) <> requester_email then
    raise exception 'This invite was created for a different email address.';
  end if;

  select id
  into existing_membership_id
  from public.memberships membership
  where membership.user_id = auth.uid()
    and membership.organisation_id = invite_record.organisation_id
    and membership.campus_id is not distinct from invite_record.campus_id
    and membership.group_id is not distinct from invite_record.group_id
    and membership.role = invite_record.intended_role
    and membership.status = 'active'
  limit 1;

  if existing_membership_id is null then
    insert into public.memberships (
      user_id,
      organisation_id,
      campus_id,
      group_id,
      role,
      status
    )
    values (
      auth.uid(),
      invite_record.organisation_id,
      invite_record.campus_id,
      invite_record.group_id,
      invite_record.intended_role,
      'active'
    )
    returning id into existing_membership_id;
  end if;

  update public.onboarding_invites
  set
    status = 'accepted',
    accepted_by_profile_id = auth.uid(),
    accepted_at = now()
  where id = invite_record.id;

  return query
  select
    existing_membership_id,
    org.name,
    campus.name,
    grp.name,
    invite_record.intended_role,
    'Invite accepted. Your membership is now visible on your account.'::text
  from public.organisations org
  left join public.campuses campus on campus.id = invite_record.campus_id
  left join public."groups" grp on grp.id = invite_record.group_id
  where org.id = invite_record.organisation_id;
end;
$$;

create or replace function public.accept_group_access_code(target_code text)
returns table (
  membership_id uuid,
  organisation_name text,
  campus_name text,
  group_name text,
  role text,
  message text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  code_record public.group_access_codes%rowtype;
  existing_membership_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in or create an account before joining this group.';
  end if;

  select *
  into code_record
  from public.group_access_codes
  where upper(code) = upper(trim(target_code))
  for update;

  if code_record.id is null then
    raise exception 'This access code is not valid.';
  end if;

  if code_record.status <> 'active' then
    raise exception 'This access code is not active.';
  end if;

  if code_record.expires_at is not null and code_record.expires_at < now() then
    update public.group_access_codes
    set status = 'expired'
    where id = code_record.id;
    raise exception 'This access code has expired.';
  end if;

  if code_record.max_uses is not null and code_record.uses_count >= code_record.max_uses then
    raise exception 'This access code has reached its use limit.';
  end if;

  if code_record.intended_role <> 'student' then
    raise exception 'Group access codes can only create student memberships.';
  end if;

  select id
  into existing_membership_id
  from public.memberships membership
  where membership.user_id = auth.uid()
    and membership.organisation_id = code_record.organisation_id
    and membership.campus_id is not distinct from code_record.campus_id
    and membership.group_id = code_record.group_id
    and membership.role = 'student'
    and membership.status = 'active'
  limit 1;

  if existing_membership_id is null then
    insert into public.memberships (
      user_id,
      organisation_id,
      campus_id,
      group_id,
      role,
      status
    )
    values (
      auth.uid(),
      code_record.organisation_id,
      code_record.campus_id,
      code_record.group_id,
      'student',
      'active'
    )
    returning id into existing_membership_id;

    update public.group_access_codes
    set uses_count = uses_count + 1
    where id = code_record.id;
  end if;

  return query
  select
    existing_membership_id,
    org.name,
    campus.name,
    grp.name,
    'student'::text,
    'Group joined. Your membership is now visible on your account.'::text
  from public.organisations org
  left join public.campuses campus on campus.id = code_record.campus_id
  join public."groups" grp on grp.id = code_record.group_id
  where org.id = code_record.organisation_id;
end;
$$;

create or replace function public.create_bulk_onboarding_invites(
  target_group_id uuid,
  target_invites jsonb,
  target_expires_at timestamptz,
  target_notes text
)
returns setof public.onboarding_invites
language plpgsql
security definer
set search_path = public
as $$
declare
  group_record public."groups"%rowtype;
  batch_id uuid;
  invite_row record;
  created_invite public.onboarding_invites%rowtype;
  total_count integer := 0;
  created_count integer := 0;
  failed_count integer := 0;
  normalized_email text;
begin
  if auth.uid() is null then
    raise exception 'Sign in with a scoped admin account to create bulk onboarding invites.';
  end if;

  select *
  into group_record
  from public."groups"
  where id = target_group_id
  limit 1;

  if group_record.id is null then
    raise exception 'Choose a valid group/class for bulk onboarding.';
  end if;

  if not public.can_manage_onboarding_scope(
    group_record.organisation_id,
    group_record.campus_id,
    group_record.id,
    'student'
  ) then
    raise exception 'This bulk onboarding batch is outside your management scope.';
  end if;

  insert into public.bulk_onboarding_batches (
    organisation_id,
    campus_id,
    group_id,
    created_by,
    status,
    notes
  )
  values (
    group_record.organisation_id,
    group_record.campus_id,
    group_record.id,
    auth.uid(),
    'generated',
    nullif(trim(target_notes), '')
  )
  returning id into batch_id;

  for invite_row in
    select *
    from jsonb_to_recordset(coalesce(target_invites, '[]'::jsonb))
      as row(email text, display_name text, notes text)
  loop
    total_count := total_count + 1;
    normalized_email := nullif(lower(trim(invite_row.email)), '');

    if normalized_email is null or position('@' in normalized_email) = 0 then
      failed_count := failed_count + 1;
    else
      insert into public.onboarding_invites (
        email,
        intended_role,
        organisation_id,
        campus_id,
        group_id,
        status,
        expires_at,
        invited_by,
        notes
      )
      values (
        normalized_email,
        'student',
        group_record.organisation_id,
        group_record.campus_id,
        group_record.id,
        'pending',
        target_expires_at,
        auth.uid(),
        nullif(trim(coalesce(invite_row.notes, target_notes)), '')
      )
      returning * into created_invite;

      created_count := created_count + 1;
      return next created_invite;
    end if;
  end loop;

  update public.bulk_onboarding_batches
  set
    total_rows = total_count,
    accepted_rows = created_count,
    failed_rows = failed_count,
    status = case
      when created_count = 0 then 'failed'
      when failed_count > 0 then 'partial'
      else 'generated'
    end
  where id = batch_id;
end;
$$;

alter table public.onboarding_invites enable row level security;
alter table public.group_access_codes enable row level security;
alter table public.bulk_onboarding_batches enable row level security;

drop policy if exists onboarding_invites_select_scoped on public.onboarding_invites;
create policy onboarding_invites_select_scoped
on public.onboarding_invites
for select
to authenticated
using (public.can_view_onboarding_scope(organisation_id, campus_id, group_id));

drop policy if exists group_access_codes_select_scoped on public.group_access_codes;
create policy group_access_codes_select_scoped
on public.group_access_codes
for select
to authenticated
using (public.can_view_onboarding_scope(organisation_id, campus_id, group_id));

drop policy if exists bulk_onboarding_batches_select_scoped on public.bulk_onboarding_batches;
create policy bulk_onboarding_batches_select_scoped
on public.bulk_onboarding_batches
for select
to authenticated
using (public.can_view_onboarding_scope(organisation_id, campus_id, group_id));

grant select on public.onboarding_invites to authenticated;
grant select on public.group_access_codes to authenticated;
grant select on public.bulk_onboarding_batches to authenticated;

revoke all on function public.can_manage_onboarding_scope(uuid, uuid, uuid, text) from public;
revoke all on function public.can_view_onboarding_scope(uuid, uuid, uuid) from public;
revoke all on function public.resolve_onboarding_scope(uuid, uuid, uuid) from public;
revoke all on function public.mask_invite_email(text) from public;
revoke all on function public.create_onboarding_invite(text, text, uuid, uuid, uuid, timestamptz, text) from public;
revoke all on function public.revoke_onboarding_invite(uuid) from public;
revoke all on function public.create_group_access_code(uuid, integer, timestamptz, text) from public;
revoke all on function public.disable_group_access_code(uuid) from public;
revoke all on function public.create_bulk_onboarding_invites(uuid, jsonb, timestamptz, text) from public;
revoke all on function public.accept_onboarding_invite(text) from public;
revoke all on function public.accept_group_access_code(text) from public;
revoke all on function public.get_join_invite_summary(text) from public;
revoke all on function public.get_join_code_summary(text) from public;

grant execute on function public.can_manage_onboarding_scope(uuid, uuid, uuid, text) to authenticated;
grant execute on function public.can_view_onboarding_scope(uuid, uuid, uuid) to authenticated;
grant execute on function public.create_onboarding_invite(text, text, uuid, uuid, uuid, timestamptz, text) to authenticated;
grant execute on function public.revoke_onboarding_invite(uuid) to authenticated;
grant execute on function public.create_group_access_code(uuid, integer, timestamptz, text) to authenticated;
grant execute on function public.disable_group_access_code(uuid) to authenticated;
grant execute on function public.create_bulk_onboarding_invites(uuid, jsonb, timestamptz, text) to authenticated;
grant execute on function public.accept_onboarding_invite(text) to authenticated;
grant execute on function public.accept_group_access_code(text) to authenticated;
grant execute on function public.get_join_invite_summary(text) to anon, authenticated;
grant execute on function public.get_join_code_summary(text) to anon, authenticated;
