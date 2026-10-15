-- CertSim role access matrix and Developer Dashboard support.
-- Apply manually after migrations 0001 through 0007.
-- This migration adds the developer role, support-report visibility, and a
-- small platform issue report queue. It does not create auth users, paid access
-- enforcement, service-role logic, or anonymous access.

alter table public.profiles
drop constraint if exists profiles_default_role_check;

alter table public.profiles
add constraint profiles_default_role_check check (
  default_role in (
    'platform_owner',
    'developer',
    'college_admin',
    'campus_admin',
    'trainer',
    'reception',
    'student',
    'individual_user'
  )
);

alter table public.memberships
drop constraint if exists memberships_role_check;

alter table public.memberships
add constraint memberships_role_check check (
  role in (
    'platform_owner',
    'developer',
    'college_admin',
    'campus_admin',
    'trainer',
    'reception',
    'student',
    'individual_user'
  )
);

create or replace function public.has_developer_role(
  target_user_id uuid default auth.uid()
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
    where m.user_id = coalesce(target_user_id, auth.uid())
      and m.role = 'developer'
      and m.status = 'active'
  );
$$;

create table if not exists public.platform_issue_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  report_type text not null default 'platform_bug',
  title text not null,
  message text not null,
  status text not null default 'open',
  developer_notes text,
  route_path text,
  exam_key text,
  question_id text,
  attempt_id uuid references public.exam_attempts(id) on delete set null,
  result_id uuid references public.exam_results(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint platform_issue_reports_report_type_check check (
    report_type in (
      'question_issue',
      'platform_bug',
      'result_issue',
      'access_issue',
      'other'
    )
  ),
  constraint platform_issue_reports_status_check check (
    status in ('open', 'in_review', 'resolved', 'dismissed')
  )
);

create index if not exists platform_issue_reports_user_id_idx
on public.platform_issue_reports (user_id);

create index if not exists platform_issue_reports_status_idx
on public.platform_issue_reports (status);

create index if not exists platform_issue_reports_report_type_idx
on public.platform_issue_reports (report_type);

create index if not exists platform_issue_reports_exam_key_idx
on public.platform_issue_reports (exam_key);

drop trigger if exists set_platform_issue_reports_updated_at
on public.platform_issue_reports;

create trigger set_platform_issue_reports_updated_at
before update on public.platform_issue_reports
for each row
execute function public.set_updated_at();

alter table public.platform_issue_reports enable row level security;

alter table public.question_reports
drop constraint if exists question_reports_report_type_check;

alter table public.question_reports
add constraint question_reports_report_type_check check (
  report_type in (
    'question_issue',
    'platform_bug',
    'result_issue',
    'access_issue',
    'bug',
    'content_feedback',
    'scoring_issue',
    'other'
  )
);

alter table public.question_reports
drop constraint if exists question_reports_status_check;

alter table public.question_reports
add constraint question_reports_status_check check (
  status in (
    'open',
    'in_review',
    'reviewing',
    'resolved',
    'dismissed',
    'archived'
  )
);

drop policy if exists organisations_developer_select_troubleshooting
on public.organisations;
create policy organisations_developer_select_troubleshooting
on public.organisations
for select
to authenticated
using (public.has_developer_role() or public.is_platform_owner());

drop policy if exists campuses_developer_select_troubleshooting
on public.campuses;
create policy campuses_developer_select_troubleshooting
on public.campuses
for select
to authenticated
using (public.has_developer_role() or public.is_platform_owner());

drop policy if exists groups_developer_select_troubleshooting
on public."groups";
create policy groups_developer_select_troubleshooting
on public."groups"
for select
to authenticated
using (public.has_developer_role() or public.is_platform_owner());

drop policy if exists memberships_developer_select_troubleshooting
on public.memberships;
create policy memberships_developer_select_troubleshooting
on public.memberships
for select
to authenticated
using (public.has_developer_role() or public.is_platform_owner());

drop policy if exists profiles_developer_select_troubleshooting
on public.profiles;
create policy profiles_developer_select_troubleshooting
on public.profiles
for select
to authenticated
using (public.has_developer_role() or public.is_platform_owner());

drop policy if exists exam_attempts_developer_select_troubleshooting
on public.exam_attempts;
create policy exam_attempts_developer_select_troubleshooting
on public.exam_attempts
for select
to authenticated
using (public.has_developer_role() or public.is_platform_owner());

drop policy if exists exam_results_developer_select_troubleshooting
on public.exam_results;
create policy exam_results_developer_select_troubleshooting
on public.exam_results
for select
to authenticated
using (public.has_developer_role() or public.is_platform_owner());

drop policy if exists exam_reports_developer_select_troubleshooting
on public.exam_reports;
create policy exam_reports_developer_select_troubleshooting
on public.exam_reports
for select
to authenticated
using (public.has_developer_role() or public.is_platform_owner());

drop policy if exists question_reports_developer_select_queue
on public.question_reports;
create policy question_reports_developer_select_queue
on public.question_reports
for select
to authenticated
using (public.has_developer_role() or public.is_platform_owner());

drop policy if exists question_reports_developer_update_queue
on public.question_reports;
create policy question_reports_developer_update_queue
on public.question_reports
for update
to authenticated
using (public.has_developer_role() or public.is_platform_owner())
with check (public.has_developer_role() or public.is_platform_owner());

drop policy if exists platform_issue_reports_select_own_or_support
on public.platform_issue_reports;
create policy platform_issue_reports_select_own_or_support
on public.platform_issue_reports
for select
to authenticated
using (
  user_id = auth.uid()
  or public.has_developer_role()
  or public.is_platform_owner()
);

drop policy if exists platform_issue_reports_insert_own
on public.platform_issue_reports;
create policy platform_issue_reports_insert_own
on public.platform_issue_reports
for insert
to authenticated
with check (user_id = auth.uid());

drop policy if exists platform_issue_reports_update_support
on public.platform_issue_reports;
create policy platform_issue_reports_update_support
on public.platform_issue_reports
for update
to authenticated
using (public.has_developer_role() or public.is_platform_owner())
with check (public.has_developer_role() or public.is_platform_owner());

revoke all on public.platform_issue_reports from anon, authenticated;
grant select, insert, update on public.platform_issue_reports to authenticated;

revoke all on function public.has_developer_role(uuid) from public;
grant execute on function public.has_developer_role(uuid) to authenticated;
