-- CertSim Exam Assignment MVP.
-- Apply manually after 0001, 0002, 0003, and 0004.
-- This migration creates scoped exam assignments for groups/classes and
-- individual students. It does not enforce exam access, create auth users,
-- send invites, reset passwords, add paid access, or grant anonymous access.

create table if not exists public.exam_assignments (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  campus_id uuid references public.campuses(id) on delete set null,
  group_id uuid references public."groups"(id) on delete cascade,
  student_user_id uuid references public.profiles(id) on delete cascade,
  exam_catalog_id uuid references public.exam_catalog(id) on delete set null,
  exam_key text not null,
  profile_id text,
  title text not null,
  instructions text,
  assigned_by uuid references public.profiles(id) on delete set null,
  assignment_type text not null default 'practice',
  status text not null default 'active',
  due_at timestamptz,
  available_from timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint exam_assignments_target_check check (
    group_id is not null or student_user_id is not null
  ),
  constraint exam_assignments_assignment_type_check check (
    assignment_type in ('practice', 'assessment', 'placement', 'revision')
  ),
  constraint exam_assignments_status_check check (
    status in ('active', 'closed', 'archived')
  )
);

create index if not exists exam_assignments_organisation_id_idx
on public.exam_assignments (organisation_id);

create index if not exists exam_assignments_campus_id_idx
on public.exam_assignments (campus_id);

create index if not exists exam_assignments_group_id_idx
on public.exam_assignments (group_id);

create index if not exists exam_assignments_student_user_id_idx
on public.exam_assignments (student_user_id);

create index if not exists exam_assignments_exam_key_idx
on public.exam_assignments (exam_key);

create index if not exists exam_assignments_status_idx
on public.exam_assignments (status);

create index if not exists exam_assignments_due_at_idx
on public.exam_assignments (due_at);

create index if not exists exam_assignments_assigned_by_idx
on public.exam_assignments (assigned_by);

drop trigger if exists set_exam_assignments_updated_at on public.exam_assignments;
create trigger set_exam_assignments_updated_at
before update on public.exam_assignments
for each row
execute function public.set_updated_at();

insert into public.exam_catalog (
  exam_key,
  slug,
  title,
  vendor,
  lifecycle,
  exam_type,
  source_type,
  current_version,
  status
)
values
  (
    'az204',
    'az204',
    'AZ-204: Developing Solutions for Microsoft Azure',
    'Microsoft',
    'near_retirement_support',
    'certification',
    'official_source',
    '1.0.0',
    'active'
  ),
  (
    'security-plus-sy0-701',
    'security-plus',
    'Security+ SY0-701 Practice Exam',
    'CompTIA',
    'production_ready',
    'certification',
    'official_source',
    '1.0.0',
    'active'
  ),
  (
    'az400',
    'az400',
    'AZ-400: Designing and Implementing Microsoft DevOps Solutions',
    'Microsoft',
    'production_ready',
    'certification',
    'official_source',
    '1.0.0',
    'active'
  ),
  (
    'ai901',
    'ai901',
    'AI-901 AI Fundamentals Practice',
    'Microsoft',
    'controlledBeta',
    'certification',
    'official_source',
    '1.0.0',
    'active'
  ),
  (
    'it-direction',
    'it-direction',
    'IT Direction Assessment',
    null,
    'guidance_assessment',
    'placement',
    'official_source',
    '1.0.0',
    'active'
  )
on conflict (slug) do update
set title = excluded.title,
    vendor = excluded.vendor,
    lifecycle = excluded.lifecycle,
    exam_type = excluded.exam_type,
    source_type = excluded.source_type,
    current_version = excluded.current_version,
    status = excluded.status,
    updated_at = now();

create or replace function public.can_manage_exam_assignment_scope(
  target_organisation_id uuid,
  target_campus_id uuid,
  target_group_id uuid,
  target_student_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select (
    target_organisation_id is not null
    and (
      public.is_platform_owner()
      or (
        public.has_trainer_role()
        and (
          (
            target_group_id is not null
            and public.can_trainer_view_group(target_group_id)
          )
          or (
            target_student_user_id is not null
            and public.can_trainer_view_student(target_student_user_id)
          )
          or exists (
            select 1
            from public.memberships trainer
            where trainer.user_id = auth.uid()
              and trainer.role = 'trainer'
              and trainer.status = 'active'
              and trainer.group_id is null
              and target_group_id is null
              and target_student_user_id is null
              and (
                (
                  trainer.campus_id is not null
                  and trainer.campus_id = target_campus_id
                )
                or (
                  trainer.campus_id is null
                  and trainer.organisation_id = target_organisation_id
                )
              )
          )
        )
      )
    )
  );
$$;

create or replace function public.can_student_view_exam_assignment(target_assignment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select target_assignment_id is not null
    and exists (
      select 1
      from public.exam_assignments assignment
      where assignment.id = target_assignment_id
        and assignment.status in ('active', 'closed')
        and (
          assignment.student_user_id = auth.uid()
          or exists (
            select 1
            from public.memberships student
            where student.user_id = auth.uid()
              and student.role = 'student'
              and student.status = 'active'
              and assignment.group_id is not null
              and assignment.student_user_id is null
              and student.group_id = assignment.group_id
          )
        )
    );
$$;

create or replace function public.can_manage_exam_assignment(target_assignment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select target_assignment_id is not null
    and exists (
      select 1
      from public.exam_assignments assignment
      where assignment.id = target_assignment_id
        and public.can_manage_exam_assignment_scope(
          assignment.organisation_id,
          assignment.campus_id,
          assignment.group_id,
          assignment.student_user_id
        )
    );
$$;

alter table public.exam_assignments enable row level security;

drop policy if exists exam_assignments_select_scoped on public.exam_assignments;
create policy exam_assignments_select_scoped
on public.exam_assignments
for select
to authenticated
using (
  public.can_manage_exam_assignment_scope(
    organisation_id,
    campus_id,
    group_id,
    student_user_id
  )
  or public.can_student_view_exam_assignment(id)
);

drop policy if exists exam_assignments_insert_scoped on public.exam_assignments;
create policy exam_assignments_insert_scoped
on public.exam_assignments
for insert
to authenticated
with check (
  assigned_by = auth.uid()
  and public.can_manage_exam_assignment_scope(
    organisation_id,
    campus_id,
    group_id,
    student_user_id
  )
);

drop policy if exists exam_assignments_update_scoped on public.exam_assignments;
create policy exam_assignments_update_scoped
on public.exam_assignments
for update
to authenticated
using (public.can_manage_exam_assignment(id))
with check (
  public.can_manage_exam_assignment_scope(
    organisation_id,
    campus_id,
    group_id,
    student_user_id
  )
);

drop policy if exists exam_assignments_platform_owner_manage on public.exam_assignments;
create policy exam_assignments_platform_owner_manage
on public.exam_assignments
for all
to authenticated
using (public.is_platform_owner())
with check (public.is_platform_owner());

revoke all on public.exam_assignments from anon, authenticated;
grant select, insert on public.exam_assignments to authenticated;
grant update (title, instructions, status, due_at, available_from)
on public.exam_assignments to authenticated;

revoke all on function public.can_manage_exam_assignment_scope(uuid, uuid, uuid, uuid) from public;
revoke all on function public.can_student_view_exam_assignment(uuid) from public;
revoke all on function public.can_manage_exam_assignment(uuid) from public;

grant execute on function public.can_manage_exam_assignment_scope(uuid, uuid, uuid, uuid) to authenticated;
grant execute on function public.can_student_view_exam_assignment(uuid) to authenticated;
grant execute on function public.can_manage_exam_assignment(uuid) to authenticated;
