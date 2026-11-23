-- CertSim reception placement results dashboard.
-- Apply manually after 0011_invites_access_codes_onboarding.sql.
-- This migration stores IT Direction / placement assessment results only.
-- It does not store certification exam results, enforce paid access, block
-- exams, create auth users, or use service-role logic.

create table if not exists public.placement_assessment_results (
  id uuid primary key default gen_random_uuid(),
  assessment_key text not null default 'it-direction',
  profile_id uuid references public.profiles(id) on delete set null,
  organisation_id uuid references public.organisations(id) on delete set null,
  campus_id uuid references public.campuses(id) on delete set null,
  intake_first_name text not null,
  intake_last_name text,
  intake_contact text,
  intake_email text,
  result_summary text,
  recommended_pathway text,
  secondary_pathways jsonb not null default '[]'::jsonb,
  pathway_scores jsonb not null default '[]'::jsonb,
  response_summary jsonb not null default '{}'::jsonb,
  status text not null default 'new',
  reception_notes text,
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint placement_assessment_results_assessment_key_check check (
    assessment_key in ('it-direction')
  ),
  constraint placement_assessment_results_status_check check (
    status in (
      'new',
      'contacted',
      'scheduled',
      'enrolled',
      'not_interested',
      'archived'
    )
  )
);

create index if not exists placement_assessment_results_assessment_key_idx
on public.placement_assessment_results (assessment_key);

create index if not exists placement_assessment_results_profile_id_idx
on public.placement_assessment_results (profile_id);

create index if not exists placement_assessment_results_scope_idx
on public.placement_assessment_results (organisation_id, campus_id);

create index if not exists placement_assessment_results_status_idx
on public.placement_assessment_results (status);

create index if not exists placement_assessment_results_created_at_idx
on public.placement_assessment_results (created_at desc);

drop trigger if exists set_placement_assessment_results_updated_at
on public.placement_assessment_results;

create trigger set_placement_assessment_results_updated_at
before update on public.placement_assessment_results
for each row
execute function public.set_updated_at();

create or replace function public.can_view_placement_scope(
  target_organisation_id uuid,
  target_campus_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null
    and (
      public.is_platform_owner(auth.uid())
      or public.has_developer_role(auth.uid())
      or (
        target_organisation_id is not null
        and exists (
          select 1
          from public.memberships m
          where m.user_id = auth.uid()
            and m.status = 'active'
            and m.role = 'college_admin'
            and m.organisation_id = target_organisation_id
        )
      )
      or (
        target_campus_id is not null
        and exists (
          select 1
          from public.memberships m
          where m.user_id = auth.uid()
            and m.status = 'active'
            and m.role in ('campus_admin', 'reception')
            and m.campus_id = target_campus_id
        )
      )
    );
$$;

create or replace function public.can_manage_placement_scope(
  target_organisation_id uuid,
  target_campus_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null
    and (
      public.is_platform_owner(auth.uid())
      or (
        target_organisation_id is not null
        and exists (
          select 1
          from public.memberships m
          where m.user_id = auth.uid()
            and m.status = 'active'
            and m.role = 'college_admin'
            and m.organisation_id = target_organisation_id
        )
      )
      or (
        target_campus_id is not null
        and exists (
          select 1
          from public.memberships m
          where m.user_id = auth.uid()
            and m.status = 'active'
            and m.role in ('campus_admin', 'reception')
            and m.campus_id = target_campus_id
        )
      )
    );
$$;

create or replace function public.save_placement_assessment_result(
  target_assessment_key text,
  target_intake_first_name text,
  target_intake_last_name text,
  target_intake_contact text,
  target_intake_email text,
  target_result_summary text,
  target_recommended_pathway text,
  target_secondary_pathways jsonb,
  target_pathway_scores jsonb,
  target_response_summary jsonb
)
returns table (
  id uuid,
  created_at timestamptz,
  message text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_first_name text := nullif(trim(target_intake_first_name), '');
  normalized_assessment_key text := coalesce(nullif(trim(target_assessment_key), ''), 'it-direction');
  scoped_organisation_id uuid;
  scoped_campus_id uuid;
  saved_result public.placement_assessment_results%rowtype;
begin
  if normalized_assessment_key <> 'it-direction' then
    raise exception 'Only IT Direction placement results can be saved here.';
  end if;

  if normalized_first_name is null then
    raise exception 'Client/student name is required before saving placement guidance.';
  end if;

  if auth.uid() is not null then
    select
      m.organisation_id,
      m.campus_id
    into
      scoped_organisation_id,
      scoped_campus_id
    from public.memberships m
    where m.user_id = auth.uid()
      and m.status = 'active'
    order by case m.role
      when 'reception' then 1
      when 'campus_admin' then 2
      when 'college_admin' then 3
      when 'student' then 4
      when 'individual_user' then 5
      else 6
    end,
    m.created_at
    limit 1;
  end if;

  insert into public.placement_assessment_results (
    assessment_key,
    profile_id,
    organisation_id,
    campus_id,
    intake_first_name,
    intake_last_name,
    intake_contact,
    intake_email,
    result_summary,
    recommended_pathway,
    secondary_pathways,
    pathway_scores,
    response_summary,
    status
  )
  values (
    normalized_assessment_key,
    auth.uid(),
    scoped_organisation_id,
    scoped_campus_id,
    normalized_first_name,
    nullif(trim(target_intake_last_name), ''),
    nullif(trim(target_intake_contact), ''),
    nullif(lower(trim(target_intake_email)), ''),
    nullif(trim(target_result_summary), ''),
    nullif(trim(target_recommended_pathway), ''),
    coalesce(target_secondary_pathways, '[]'::jsonb),
    coalesce(target_pathway_scores, '[]'::jsonb),
    coalesce(target_response_summary, '{}'::jsonb),
    'new'
  )
  returning * into saved_result;

  return query
  select
    saved_result.id,
    saved_result.created_at,
    'Placement result saved for follow-up.'::text;
end;
$$;

create or replace function public.get_reception_placement_results()
returns table (
  id uuid,
  assessment_key text,
  profile_id uuid,
  organisation_id uuid,
  campus_id uuid,
  organisation_name text,
  campus_name text,
  intake_first_name text,
  intake_last_name text,
  intake_contact text,
  intake_email text,
  result_summary text,
  recommended_pathway text,
  secondary_pathways jsonb,
  pathway_scores jsonb,
  response_summary jsonb,
  status text,
  reception_notes text,
  reviewed_by uuid,
  reviewed_by_name text,
  reviewed_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in with a reception, scoped admin, Developer, or Platform Owner account to view placement results.';
  end if;

  return query
  select
    result.id,
    result.assessment_key,
    result.profile_id,
    result.organisation_id,
    result.campus_id,
    org.name,
    campus.name,
    result.intake_first_name,
    result.intake_last_name,
    result.intake_contact,
    result.intake_email,
    result.result_summary,
    result.recommended_pathway,
    result.secondary_pathways,
    result.pathway_scores,
    result.response_summary,
    result.status,
    result.reception_notes,
    result.reviewed_by,
    coalesce(reviewer.display_name, reviewer.full_name, reviewer.email),
    result.reviewed_at,
    result.created_at,
    result.updated_at
  from public.placement_assessment_results result
  left join public.organisations org on org.id = result.organisation_id
  left join public.campuses campus on campus.id = result.campus_id
  left join public.profiles reviewer on reviewer.id = result.reviewed_by
  where public.can_view_placement_scope(result.organisation_id, result.campus_id)
  order by result.created_at desc;
end;
$$;

create or replace function public.update_placement_assessment_result(
  target_result_id uuid,
  target_status text,
  target_reception_notes text
)
returns public.placement_assessment_results
language plpgsql
security definer
set search_path = public
as $$
declare
  result_record public.placement_assessment_results%rowtype;
  normalized_status text := coalesce(nullif(trim(target_status), ''), 'new');
begin
  if auth.uid() is null then
    raise exception 'Sign in with a reception or scoped admin account to update placement results.';
  end if;

  if normalized_status not in (
    'new',
    'contacted',
    'scheduled',
    'enrolled',
    'not_interested',
    'archived'
  ) then
    raise exception 'Choose a valid placement follow-up status.';
  end if;

  select *
  into result_record
  from public.placement_assessment_results
  where id = target_result_id
  limit 1;

  if result_record.id is null then
    raise exception 'Choose a valid placement result.';
  end if;

  if not public.can_manage_placement_scope(
    result_record.organisation_id,
    result_record.campus_id
  ) then
    raise exception 'This placement result is outside your reception management scope.';
  end if;

  update public.placement_assessment_results result
  set
    status = normalized_status,
    reception_notes = nullif(trim(target_reception_notes), ''),
    reviewed_by = auth.uid(),
    reviewed_at = now()
  where result.id = target_result_id
  returning * into result_record;

  return result_record;
end;
$$;

alter table public.placement_assessment_results enable row level security;

drop policy if exists placement_assessment_results_select_scoped
on public.placement_assessment_results;
create policy placement_assessment_results_select_scoped
on public.placement_assessment_results
for select
to authenticated
using (public.can_view_placement_scope(organisation_id, campus_id));

drop policy if exists placement_assessment_results_update_scoped
on public.placement_assessment_results;
create policy placement_assessment_results_update_scoped
on public.placement_assessment_results
for update
to authenticated
using (public.can_manage_placement_scope(organisation_id, campus_id))
with check (public.can_manage_placement_scope(organisation_id, campus_id));

revoke all on public.placement_assessment_results from anon, authenticated;
grant select on public.placement_assessment_results to authenticated;

revoke all on function public.can_view_placement_scope(uuid, uuid) from public;
revoke all on function public.can_manage_placement_scope(uuid, uuid) from public;
revoke all on function public.save_placement_assessment_result(
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  jsonb,
  jsonb,
  jsonb
) from public;
revoke all on function public.get_reception_placement_results() from public;
revoke all on function public.update_placement_assessment_result(uuid, text, text) from public;

grant execute on function public.can_view_placement_scope(uuid, uuid) to authenticated;
grant execute on function public.can_manage_placement_scope(uuid, uuid) to authenticated;
grant execute on function public.save_placement_assessment_result(
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  jsonb,
  jsonb,
  jsonb
) to anon, authenticated;
grant execute on function public.get_reception_placement_results() to authenticated;
grant execute on function public.update_placement_assessment_result(uuid, text, text) to authenticated;
