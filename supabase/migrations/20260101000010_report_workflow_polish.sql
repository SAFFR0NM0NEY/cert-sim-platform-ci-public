-- CertSim report workflow polish.
-- Apply manually after migrations 0001 through 0009.
-- This migration separates internal support notes from reporter-visible
-- feedback and adds safe user-facing report status RPCs.

alter table public.question_reports
add column if not exists title text;

alter table public.question_reports
add column if not exists priority text not null default 'normal';

alter table public.question_reports
add column if not exists internal_notes text;

alter table public.question_reports
add column if not exists reporter_feedback text;

alter table public.question_reports
add column if not exists route_path text;

alter table public.question_reports
add column if not exists exam_title text;

alter table public.question_reports
add column if not exists question_type text;

alter table public.question_reports
add column if not exists result_id uuid references public.exam_results(id) on delete set null;

alter table public.question_reports
add column if not exists reviewed_by uuid references public.profiles(id) on delete set null;

alter table public.question_reports
add column if not exists updated_by uuid references public.profiles(id) on delete set null;

alter table public.question_reports
add column if not exists resolved_at timestamptz;

alter table public.platform_issue_reports
add column if not exists priority text not null default 'normal';

alter table public.platform_issue_reports
add column if not exists internal_notes text;

alter table public.platform_issue_reports
add column if not exists reporter_feedback text;

alter table public.platform_issue_reports
add column if not exists reviewed_by uuid references public.profiles(id) on delete set null;

alter table public.platform_issue_reports
add column if not exists updated_by uuid references public.profiles(id) on delete set null;

alter table public.platform_issue_reports
add column if not exists resolved_at timestamptz;

update public.platform_issue_reports
set internal_notes = developer_notes
where internal_notes is null
  and developer_notes is not null;

alter table public.question_reports
drop constraint if exists question_reports_status_check;

alter table public.question_reports
add constraint question_reports_status_check check (
  status in (
    'open',
    'in_review',
    'need_info',
    'reviewing',
    'resolved',
    'dismissed',
    'archived'
  )
);

alter table public.platform_issue_reports
drop constraint if exists platform_issue_reports_status_check;

alter table public.platform_issue_reports
add constraint platform_issue_reports_status_check check (
  status in (
    'open',
    'in_review',
    'need_info',
    'resolved',
    'dismissed'
  )
);

alter table public.question_reports
drop constraint if exists question_reports_priority_check;

alter table public.question_reports
add constraint question_reports_priority_check check (
  priority in ('low', 'normal', 'high', 'urgent')
);

alter table public.platform_issue_reports
drop constraint if exists platform_issue_reports_priority_check;

alter table public.platform_issue_reports
add constraint platform_issue_reports_priority_check check (
  priority in ('low', 'normal', 'high', 'urgent')
);

create index if not exists question_reports_priority_idx
on public.question_reports (priority);

create index if not exists question_reports_user_created_idx
on public.question_reports (user_id, created_at desc);

create index if not exists platform_issue_reports_priority_idx
on public.platform_issue_reports (priority);

create index if not exists platform_issue_reports_user_created_idx
on public.platform_issue_reports (user_id, created_at desc);

revoke select on public.question_reports from authenticated;
grant select (
  id,
  user_id,
  attempt_id,
  exam_key,
  exam_title,
  question_id,
  question_type,
  report_type,
  title,
  message,
  status,
  priority,
  reporter_feedback,
  route_path,
  result_id,
  created_at,
  updated_at,
  resolved_at
) on public.question_reports to authenticated;

revoke select on public.platform_issue_reports from authenticated;
grant select (
  id,
  user_id,
  report_type,
  title,
  message,
  status,
  priority,
  reporter_feedback,
  route_path,
  exam_key,
  question_id,
  attempt_id,
  result_id,
  created_at,
  updated_at,
  resolved_at
) on public.platform_issue_reports to authenticated;

create or replace function public.get_my_report_statuses()
returns table (
  id uuid,
  source text,
  report_type text,
  title text,
  message text,
  status text,
  priority text,
  reporter_feedback text,
  route_path text,
  exam_key text,
  exam_title text,
  question_id text,
  question_type text,
  attempt_id uuid,
  result_id uuid,
  created_at timestamptz,
  updated_at timestamptz,
  resolved_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select *
  from (
  select
    report.id,
    'question_reports'::text as source,
    report.report_type,
    coalesce(
      nullif(report.title, ''),
      case
        when report.question_id is not null then 'Question ' || report.question_id
        else 'Question report'
      end
    ) as title,
    report.message,
    report.status,
    report.priority,
    report.reporter_feedback,
    report.route_path,
    report.exam_key,
    report.exam_title,
    report.question_id,
    report.question_type,
    report.attempt_id,
    report.result_id,
    report.created_at,
    report.updated_at,
    report.resolved_at
  from public.question_reports report
  where report.user_id = auth.uid()

  union all

  select
    report.id,
    'platform_issue_reports'::text as source,
    report.report_type,
    report.title,
    report.message,
    report.status,
    report.priority,
    report.reporter_feedback,
    report.route_path,
    report.exam_key,
    null::text as exam_title,
    report.question_id,
    null::text as question_type,
    report.attempt_id,
    report.result_id,
    report.created_at,
    report.updated_at,
    report.resolved_at
  from public.platform_issue_reports report
  where report.user_id = auth.uid()
  ) report_statuses
  order by report_statuses.created_at desc
  limit 100;
$$;

create or replace function public.get_developer_report_queue()
returns table (
  id uuid,
  source text,
  user_id uuid,
  report_type text,
  title text,
  message text,
  status text,
  priority text,
  internal_notes text,
  reporter_feedback text,
  route_path text,
  exam_key text,
  exam_title text,
  question_id text,
  question_type text,
  attempt_id uuid,
  result_id uuid,
  metadata jsonb,
  created_at timestamptz,
  updated_at timestamptz,
  resolved_at timestamptz,
  reporter_email text,
  reporter_full_name text,
  reporter_display_name text,
  reporter_status text,
  attempt_exam_key text,
  attempt_mode_label text,
  attempt_status text,
  attempt_submitted_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not (public.has_developer_role() or public.is_platform_owner()) then
    raise exception 'This account cannot view the Developer report queue.';
  end if;

  return query
  select *
  from (
  select
    report.id,
    'question_reports'::text as source,
    report.user_id,
    report.report_type,
    coalesce(
      nullif(report.title, ''),
      case
        when report.question_id is not null then 'Question ' || report.question_id
        else 'Question report'
      end
    ) as title,
    report.message,
    report.status,
    report.priority,
    report.internal_notes,
    report.reporter_feedback,
    report.route_path,
    report.exam_key,
    report.exam_title,
    report.question_id,
    report.question_type,
    report.attempt_id,
    report.result_id,
    report.metadata,
    report.created_at,
    report.updated_at,
    report.resolved_at,
    reporter.email as reporter_email,
    reporter.full_name as reporter_full_name,
    reporter.display_name as reporter_display_name,
    reporter.status as reporter_status,
    attempt.exam_key as attempt_exam_key,
    attempt.mode_label as attempt_mode_label,
    attempt.status as attempt_status,
    attempt.submitted_at as attempt_submitted_at
  from public.question_reports report
  left join public.profiles reporter on reporter.id = report.user_id
  left join public.exam_attempts attempt on attempt.id = report.attempt_id

  union all

  select
    report.id,
    'platform_issue_reports'::text as source,
    report.user_id,
    report.report_type,
    report.title,
    report.message,
    report.status,
    report.priority,
    report.internal_notes,
    report.reporter_feedback,
    report.route_path,
    report.exam_key,
    null::text as exam_title,
    report.question_id,
    null::text as question_type,
    report.attempt_id,
    report.result_id,
    report.metadata,
    report.created_at,
    report.updated_at,
    report.resolved_at,
    reporter.email as reporter_email,
    reporter.full_name as reporter_full_name,
    reporter.display_name as reporter_display_name,
    reporter.status as reporter_status,
    attempt.exam_key as attempt_exam_key,
    attempt.mode_label as attempt_mode_label,
    attempt.status as attempt_status,
    attempt.submitted_at as attempt_submitted_at
  from public.platform_issue_reports report
  left join public.profiles reporter on reporter.id = report.user_id
  left join public.exam_attempts attempt on attempt.id = report.attempt_id
  ) report_queue
  order by report_queue.created_at desc
  limit 200;
end;
$$;

create or replace function public.update_report_workflow(
  target_source text,
  target_report_id uuid,
  target_status text,
  target_priority text default 'normal',
  target_internal_notes text default null,
  target_reporter_feedback text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_source text := trim(coalesce(target_source, ''));
  normalized_status text := trim(coalesce(target_status, 'open'));
  normalized_priority text := trim(coalesce(target_priority, 'normal'));
  next_resolved_at timestamptz;
begin
  if not (public.has_developer_role() or public.is_platform_owner()) then
    raise exception 'This account cannot update report workflow status.';
  end if;

  if target_report_id is null then
    raise exception 'Choose a report to update.';
  end if;

  if normalized_status not in ('open', 'in_review', 'need_info', 'resolved', 'dismissed') then
    raise exception 'Choose a valid report status.';
  end if;

  if normalized_priority not in ('low', 'normal', 'high', 'urgent') then
    raise exception 'Choose a valid report priority.';
  end if;

  next_resolved_at := case
    when normalized_status in ('resolved', 'dismissed') then now()
    else null
  end;

  if normalized_source = 'question_reports' then
    update public.question_reports
    set
      status = normalized_status,
      priority = normalized_priority,
      internal_notes = nullif(target_internal_notes, ''),
      reporter_feedback = nullif(target_reporter_feedback, ''),
      reviewed_by = auth.uid(),
      updated_by = auth.uid(),
      resolved_at = next_resolved_at
    where id = target_report_id;

    if not found then
      raise exception 'Question report was not found.';
    end if;

    return jsonb_build_object('source', normalized_source, 'id', target_report_id);
  end if;

  if normalized_source = 'platform_issue_reports' then
    update public.platform_issue_reports
    set
      status = normalized_status,
      priority = normalized_priority,
      internal_notes = nullif(target_internal_notes, ''),
      developer_notes = nullif(target_internal_notes, ''),
      reporter_feedback = nullif(target_reporter_feedback, ''),
      reviewed_by = auth.uid(),
      updated_by = auth.uid(),
      resolved_at = next_resolved_at
    where id = target_report_id;

    if not found then
      raise exception 'Platform issue report was not found.';
    end if;

    return jsonb_build_object('source', normalized_source, 'id', target_report_id);
  end if;

  raise exception 'Choose a supported report source.';
end;
$$;

revoke all on function public.get_my_report_statuses() from public;
grant execute on function public.get_my_report_statuses() to authenticated;

revoke all on function public.get_developer_report_queue() from public;
grant execute on function public.get_developer_report_queue() to authenticated;

revoke all on function public.update_report_workflow(
  text,
  uuid,
  text,
  text,
  text,
  text
) from public;
grant execute on function public.update_report_workflow(
  text,
  uuid,
  text,
  text,
  text,
  text
) to authenticated;
