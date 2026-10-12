-- CertSim attempt and result storage foundation.
-- Apply manually after 0001_certsim_identity_foundation.sql.
-- This migration creates storage tables only. It does not connect the frontend
-- exam runner, enforce login, or restrict access to existing exams.

create table if not exists public.exam_catalog (
  id uuid primary key default gen_random_uuid(),
  exam_key text not null unique,
  slug text not null unique,
  title text not null,
  vendor text,
  lifecycle text not null,
  exam_type text not null,
  source_type text not null default 'official_source',
  current_version text not null default '1.0.0',
  status text not null default 'active',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint exam_catalog_exam_type_check check (
    exam_type in ('certification', 'placement', 'custom')
  ),
  constraint exam_catalog_source_type_check check (
    source_type in ('official_source', 'custom_database', 'imported')
  ),
  constraint exam_catalog_status_check check (
    status in ('active', 'draft', 'retired', 'archived')
  )
);

create table if not exists public.exam_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete set null,
  exam_catalog_id uuid references public.exam_catalog(id) on delete set null,
  exam_key text not null,
  exam_version text not null,
  profile_id text not null,
  mode_label text,
  status text not null default 'in_progress',
  started_at timestamptz not null default now(),
  submitted_at timestamptz,
  duration_seconds integer,
  time_limit_minutes integer,
  selected_question_ids jsonb not null default '[]'::jsonb,
  presented_order_snapshot jsonb not null default '{}'::jsonb,
  attempt_snapshot jsonb not null default '{}'::jsonb,
  client_app_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint exam_attempts_status_check check (
    status in ('in_progress', 'submitted', 'abandoned', 'voided')
  ),
  constraint exam_attempts_duration_check check (
    duration_seconds is null or duration_seconds >= 0
  ),
  constraint exam_attempts_time_limit_check check (
    time_limit_minutes is null or time_limit_minutes >= 0
  )
);

create table if not exists public.exam_responses (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public.exam_attempts(id) on delete cascade,
  question_id text not null,
  question_type text not null,
  response_snapshot jsonb not null default '{}'::jsonb,
  presented_snapshot jsonb not null default '{}'::jsonb,
  is_answered boolean not null default false,
  is_scored boolean not null default true,
  created_at timestamptz not null default now(),
  constraint exam_responses_attempt_question_unique unique (attempt_id, question_id)
);

create table if not exists public.exam_results (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null unique references public.exam_attempts(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete set null,
  exam_key text not null,
  profile_id text not null,
  scoring_engine_version text not null,
  raw_score numeric,
  raw_percentage numeric,
  scaled_score integer,
  passed boolean,
  pass_mark integer,
  domain_breakdown jsonb not null default '{}'::jsonb,
  pbq_breakdown jsonb not null default '{}'::jsonb,
  case_study_breakdown jsonb not null default '{}'::jsonb,
  weak_areas jsonb not null default '[]'::jsonb,
  result_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint exam_results_raw_percentage_check check (
    raw_percentage is null or (raw_percentage >= 0 and raw_percentage <= 100)
  )
);

create table if not exists public.exam_reports (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null unique references public.exam_attempts(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete set null,
  report_type text not null default 'practice_result',
  report_title text not null,
  report_snapshot jsonb not null default '{}'::jsonb,
  pdf_generated boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.question_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete set null,
  attempt_id uuid references public.exam_attempts(id) on delete set null,
  exam_key text not null,
  question_id text,
  report_type text not null,
  message text not null,
  status text not null default 'open',
  assigned_to uuid references public.profiles(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint question_reports_report_type_check check (
    report_type in (
      'question_issue',
      'bug',
      'content_feedback',
      'scoring_issue',
      'other'
    )
  ),
  constraint question_reports_status_check check (
    status in ('open', 'reviewing', 'resolved', 'dismissed', 'archived')
  )
);

create index if not exists exam_attempts_user_id_idx on public.exam_attempts (user_id);
create index if not exists exam_attempts_exam_key_idx on public.exam_attempts (exam_key);
create index if not exists exam_attempts_status_idx on public.exam_attempts (status);
create index if not exists exam_attempts_submitted_at_idx on public.exam_attempts (submitted_at);
create index if not exists exam_responses_attempt_id_idx on public.exam_responses (attempt_id);
create index if not exists exam_results_user_id_idx on public.exam_results (user_id);
create index if not exists exam_results_exam_key_idx on public.exam_results (exam_key);
create index if not exists question_reports_status_idx on public.question_reports (status);
create index if not exists question_reports_exam_key_idx on public.question_reports (exam_key);
create index if not exists question_reports_assigned_to_idx on public.question_reports (assigned_to);

drop trigger if exists set_exam_catalog_updated_at on public.exam_catalog;
create trigger set_exam_catalog_updated_at
before update on public.exam_catalog
for each row
execute function public.set_updated_at();

drop trigger if exists set_exam_attempts_updated_at on public.exam_attempts;
create trigger set_exam_attempts_updated_at
before update on public.exam_attempts
for each row
execute function public.set_updated_at();

drop trigger if exists set_question_reports_updated_at on public.question_reports;
create trigger set_question_reports_updated_at
before update on public.question_reports
for each row
execute function public.set_updated_at();

create or replace function public.owns_attempt(target_attempt_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select target_attempt_id is not null
    and exists (
      select 1
      from public.exam_attempts attempt
      where attempt.id = target_attempt_id
        and attempt.user_id = auth.uid()
    );
$$;

alter table public.exam_catalog enable row level security;
alter table public.exam_attempts enable row level security;
alter table public.exam_responses enable row level security;
alter table public.exam_results enable row level security;
alter table public.exam_reports enable row level security;
alter table public.question_reports enable row level security;

drop policy if exists exam_catalog_select_authenticated_or_platform_owner on public.exam_catalog;
create policy exam_catalog_select_authenticated_or_platform_owner
on public.exam_catalog
for select
to authenticated
using (status = 'active' or public.is_platform_owner());

drop policy if exists exam_catalog_platform_owner_manage on public.exam_catalog;
create policy exam_catalog_platform_owner_manage
on public.exam_catalog
for all
to authenticated
using (public.is_platform_owner())
with check (public.is_platform_owner());

drop policy if exists exam_attempts_select_own_or_platform_owner on public.exam_attempts;
create policy exam_attempts_select_own_or_platform_owner
on public.exam_attempts
for select
to authenticated
using (user_id = auth.uid() or public.is_platform_owner());

drop policy if exists exam_attempts_insert_own on public.exam_attempts;
create policy exam_attempts_insert_own
on public.exam_attempts
for insert
to authenticated
with check (user_id = auth.uid());

drop policy if exists exam_attempts_platform_owner_manage on public.exam_attempts;
create policy exam_attempts_platform_owner_manage
on public.exam_attempts
for all
to authenticated
using (public.is_platform_owner())
with check (public.is_platform_owner());

drop policy if exists exam_responses_select_own_or_platform_owner on public.exam_responses;
create policy exam_responses_select_own_or_platform_owner
on public.exam_responses
for select
to authenticated
using (public.owns_attempt(attempt_id) or public.is_platform_owner());

drop policy if exists exam_responses_insert_for_own_attempt on public.exam_responses;
create policy exam_responses_insert_for_own_attempt
on public.exam_responses
for insert
to authenticated
with check (public.owns_attempt(attempt_id));

drop policy if exists exam_responses_platform_owner_manage on public.exam_responses;
create policy exam_responses_platform_owner_manage
on public.exam_responses
for all
to authenticated
using (public.is_platform_owner())
with check (public.is_platform_owner());

drop policy if exists exam_results_select_own_or_platform_owner on public.exam_results;
create policy exam_results_select_own_or_platform_owner
on public.exam_results
for select
to authenticated
using (
  user_id = auth.uid()
  or public.owns_attempt(attempt_id)
  or public.is_platform_owner()
);

drop policy if exists exam_results_insert_for_own_attempt on public.exam_results;
create policy exam_results_insert_for_own_attempt
on public.exam_results
for insert
to authenticated
with check (
  public.owns_attempt(attempt_id)
  and (user_id is null or user_id = auth.uid())
);

drop policy if exists exam_results_platform_owner_manage on public.exam_results;
create policy exam_results_platform_owner_manage
on public.exam_results
for all
to authenticated
using (public.is_platform_owner())
with check (public.is_platform_owner());

drop policy if exists exam_reports_select_own_or_platform_owner on public.exam_reports;
create policy exam_reports_select_own_or_platform_owner
on public.exam_reports
for select
to authenticated
using (
  user_id = auth.uid()
  or public.owns_attempt(attempt_id)
  or public.is_platform_owner()
);

drop policy if exists exam_reports_insert_for_own_attempt on public.exam_reports;
create policy exam_reports_insert_for_own_attempt
on public.exam_reports
for insert
to authenticated
with check (
  public.owns_attempt(attempt_id)
  and (user_id is null or user_id = auth.uid())
);

drop policy if exists exam_reports_platform_owner_manage on public.exam_reports;
create policy exam_reports_platform_owner_manage
on public.exam_reports
for all
to authenticated
using (public.is_platform_owner())
with check (public.is_platform_owner());

drop policy if exists question_reports_select_own_or_platform_owner on public.question_reports;
create policy question_reports_select_own_or_platform_owner
on public.question_reports
for select
to authenticated
using (
  user_id = auth.uid()
  or assigned_to = auth.uid()
  or public.is_platform_owner()
);

drop policy if exists question_reports_insert_own on public.question_reports;
create policy question_reports_insert_own
on public.question_reports
for insert
to authenticated
with check (
  user_id = auth.uid()
  and (attempt_id is null or public.owns_attempt(attempt_id))
);

drop policy if exists question_reports_update_assignee_or_platform_owner on public.question_reports;
create policy question_reports_update_assignee_or_platform_owner
on public.question_reports
for update
to authenticated
using (assigned_to = auth.uid() or public.is_platform_owner())
with check (assigned_to = auth.uid() or public.is_platform_owner());

drop policy if exists question_reports_platform_owner_manage on public.question_reports;
create policy question_reports_platform_owner_manage
on public.question_reports
for all
to authenticated
using (public.is_platform_owner())
with check (public.is_platform_owner());

revoke all on public.exam_catalog from anon, authenticated;
revoke all on public.exam_attempts from anon, authenticated;
revoke all on public.exam_responses from anon, authenticated;
revoke all on public.exam_results from anon, authenticated;
revoke all on public.exam_reports from anon, authenticated;
revoke all on public.question_reports from anon, authenticated;

grant select, insert, update, delete on public.exam_catalog to authenticated;
grant select, insert, update, delete on public.exam_attempts to authenticated;
grant select, insert, update, delete on public.exam_responses to authenticated;
grant select, insert, update, delete on public.exam_results to authenticated;
grant select, insert, update, delete on public.exam_reports to authenticated;
grant select, insert, update, delete on public.question_reports to authenticated;

revoke all on function public.owns_attempt(uuid) from public;
grant execute on function public.owns_attempt(uuid) to authenticated;
