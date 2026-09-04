-- CertSim Trainer Dashboard read-only policy extension.
-- Apply manually after 0001, 0002, and 0003.
-- This migration allows active trainers to read only assigned group/student
-- summaries and submitted result/report rows. It does not create assignments,
-- invites, auth users, access enforcement, or anonymous access.

create or replace function public.has_trainer_role(target_user_id uuid default auth.uid())
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
      and m.role = 'trainer'
      and m.status = 'active'
  );
$$;

create or replace function public.can_trainer_view_group(target_group_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select target_group_id is not null
    and (
      public.is_platform_owner()
      or exists (
        select 1
        from public.memberships trainer
        join public."groups" target_group
          on target_group.id = target_group_id
        where trainer.user_id = auth.uid()
          and trainer.role = 'trainer'
          and trainer.status = 'active'
          and (
            trainer.group_id = target_group_id
            or (
              trainer.group_id is null
              and trainer.campus_id is not null
              and trainer.campus_id = target_group.campus_id
            )
            or (
              trainer.group_id is null
              and trainer.campus_id is null
              and trainer.organisation_id = target_group.organisation_id
            )
          )
      )
    );
$$;

create or replace function public.can_trainer_view_membership(target_membership_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select target_membership_id is not null
    and (
      public.is_platform_owner()
      or exists (
        select 1
        from public.memberships student
        left join public."groups" student_group
          on student_group.id = student.group_id
        where student.id = target_membership_id
          and student.role = 'student'
          and student.status = 'active'
          and exists (
            select 1
            from public.memberships trainer
            where trainer.user_id = auth.uid()
              and trainer.role = 'trainer'
              and trainer.status = 'active'
              and (
                (
                  trainer.group_id is not null
                  and trainer.group_id = student.group_id
                )
                or (
                  trainer.group_id is null
                  and trainer.campus_id is not null
                  and trainer.campus_id = coalesce(student.campus_id, student_group.campus_id)
                )
                or (
                  trainer.group_id is null
                  and trainer.campus_id is null
                  and trainer.organisation_id = student.organisation_id
                )
              )
          )
      )
    );
$$;

create or replace function public.can_trainer_view_student(target_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select target_user_id is not null
    and (
      public.is_platform_owner()
      or exists (
        select 1
        from public.memberships student
        where student.user_id = target_user_id
          and public.can_trainer_view_membership(student.id)
      )
    );
$$;

create or replace function public.can_trainer_view_attempt(target_attempt_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select target_attempt_id is not null
    and (
      public.is_platform_owner()
      or exists (
        select 1
        from public.exam_attempts attempt
        where attempt.id = target_attempt_id
          and attempt.status = 'submitted'
          and public.can_trainer_view_student(attempt.user_id)
      )
    );
$$;

drop policy if exists groups_trainer_select_assigned on public."groups";
create policy groups_trainer_select_assigned
on public."groups"
for select
to authenticated
using (public.can_trainer_view_group(id));

drop policy if exists memberships_trainer_select_assigned_students on public.memberships;
create policy memberships_trainer_select_assigned_students
on public.memberships
for select
to authenticated
using (public.can_trainer_view_membership(id));

drop policy if exists profiles_trainer_select_assigned_students on public.profiles;
create policy profiles_trainer_select_assigned_students
on public.profiles
for select
to authenticated
using (public.can_trainer_view_student(id));

drop policy if exists exam_attempts_trainer_select_assigned_students on public.exam_attempts;
create policy exam_attempts_trainer_select_assigned_students
on public.exam_attempts
for select
to authenticated
using (public.can_trainer_view_attempt(id));

drop policy if exists exam_results_trainer_select_assigned_students on public.exam_results;
create policy exam_results_trainer_select_assigned_students
on public.exam_results
for select
to authenticated
using (public.can_trainer_view_attempt(attempt_id));

drop policy if exists exam_reports_trainer_select_assigned_students on public.exam_reports;
create policy exam_reports_trainer_select_assigned_students
on public.exam_reports
for select
to authenticated
using (public.can_trainer_view_attempt(attempt_id));

revoke all on function public.has_trainer_role(uuid) from public;
revoke all on function public.can_trainer_view_group(uuid) from public;
revoke all on function public.can_trainer_view_membership(uuid) from public;
revoke all on function public.can_trainer_view_student(uuid) from public;
revoke all on function public.can_trainer_view_attempt(uuid) from public;

grant execute on function public.has_trainer_role(uuid) to authenticated;
grant execute on function public.can_trainer_view_group(uuid) to authenticated;
grant execute on function public.can_trainer_view_membership(uuid) to authenticated;
grant execute on function public.can_trainer_view_student(uuid) to authenticated;
grant execute on function public.can_trainer_view_attempt(uuid) to authenticated;

grant select on public.profiles to authenticated;
grant select on public."groups" to authenticated;
grant select on public.memberships to authenticated;
grant select on public.exam_attempts to authenticated;
grant select on public.exam_results to authenticated;
grant select on public.exam_reports to authenticated;
