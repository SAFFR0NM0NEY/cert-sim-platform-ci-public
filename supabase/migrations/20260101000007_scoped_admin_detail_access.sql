-- CertSim scoped organisation detail access.
-- Apply manually after migrations 0001 through 0006.
-- This migration supports organisation/campus/group detail pages for scoped
-- admins and trainers. It does not create auth users, invite links, paid
-- access enforcement, service-role logic, or anonymous access.

create or replace function public.can_scoped_admin_manage_organisation(
  target_organisation_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select target_organisation_id is not null
    and (
      public.is_platform_owner()
      or exists (
        select 1
        from public.memberships admin
        where admin.user_id = auth.uid()
          and admin.role = 'college_admin'
          and admin.status = 'active'
          and admin.organisation_id = target_organisation_id
      )
    );
$$;

create or replace function public.can_scoped_admin_manage_campus(
  target_campus_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select target_campus_id is not null
    and (
      public.is_platform_owner()
      or exists (
        select 1
        from public.campuses target_campus
        join public.memberships admin
          on admin.organisation_id = target_campus.organisation_id
        where target_campus.id = target_campus_id
          and admin.user_id = auth.uid()
          and admin.status = 'active'
          and (
            admin.role = 'college_admin'
            or (
              admin.role = 'campus_admin'
              and admin.campus_id = target_campus.id
            )
          )
      )
    );
$$;

create or replace function public.can_scoped_admin_manage_group(
  target_group_id uuid
)
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
        from public."groups" target_group
        join public.memberships admin
          on admin.organisation_id = target_group.organisation_id
        where target_group.id = target_group_id
          and admin.user_id = auth.uid()
          and admin.status = 'active'
          and (
            admin.role = 'college_admin'
            or (
              admin.role = 'campus_admin'
              and admin.campus_id = target_group.campus_id
            )
          )
      )
    );
$$;

create or replace function public.can_scoped_manager_view_membership(
  target_membership_id uuid
)
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
        from public.memberships target_membership
        left join public."groups" target_group
          on target_group.id = target_membership.group_id
        join public.memberships manager
          on manager.organisation_id = target_membership.organisation_id
        where target_membership.id = target_membership_id
          and manager.user_id = auth.uid()
          and manager.status = 'active'
          and (
            manager.role = 'college_admin'
            or (
              manager.role = 'campus_admin'
              and manager.campus_id = coalesce(
                target_membership.campus_id,
                target_group.campus_id
              )
            )
          )
      )
      or public.can_trainer_view_membership(target_membership_id)
    );
$$;

create or replace function public.can_scoped_manager_view_student(
  target_profile_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select target_profile_id is not null
    and (
      public.is_platform_owner()
      or exists (
        select 1
        from public.memberships student
        where student.user_id = target_profile_id
          and student.role = 'student'
          and public.can_scoped_manager_view_membership(student.id)
      )
    );
$$;

create or replace function public.can_scoped_manager_view_attempt(
  target_attempt_id uuid
)
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
          and public.can_scoped_manager_view_student(attempt.user_id)
      )
    );
$$;

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
        target_group_id is not null
        and public.can_scoped_admin_manage_group(target_group_id)
      )
      or (
        target_group_id is null
        and target_campus_id is not null
        and public.can_scoped_admin_manage_campus(target_campus_id)
      )
      or (
        target_group_id is null
        and target_campus_id is null
        and public.can_scoped_admin_manage_organisation(target_organisation_id)
      )
      or (
        target_student_user_id is not null
        and public.can_scoped_manager_view_student(target_student_user_id)
      )
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

drop policy if exists organisations_scoped_admin_update on public.organisations;
create policy organisations_scoped_admin_update
on public.organisations
for update
to authenticated
using (public.can_scoped_admin_manage_organisation(id))
with check (public.can_scoped_admin_manage_organisation(id));

drop policy if exists campuses_scoped_admin_update on public.campuses;
create policy campuses_scoped_admin_update
on public.campuses
for update
to authenticated
using (public.can_scoped_admin_manage_campus(id))
with check (public.can_scoped_admin_manage_campus(id));

drop policy if exists groups_scoped_admin_update on public."groups";
create policy groups_scoped_admin_update
on public."groups"
for update
to authenticated
using (public.can_scoped_admin_manage_group(id))
with check (public.can_scoped_admin_manage_group(id));

drop policy if exists memberships_scoped_admin_select on public.memberships;
create policy memberships_scoped_admin_select
on public.memberships
for select
to authenticated
using (public.can_scoped_manager_view_membership(id));

drop policy if exists profiles_scoped_admin_select on public.profiles;
create policy profiles_scoped_admin_select
on public.profiles
for select
to authenticated
using (public.can_scoped_manager_view_student(id));

drop policy if exists exam_attempts_scoped_admin_select on public.exam_attempts;
create policy exam_attempts_scoped_admin_select
on public.exam_attempts
for select
to authenticated
using (public.can_scoped_manager_view_attempt(id));

drop policy if exists exam_results_scoped_admin_select on public.exam_results;
create policy exam_results_scoped_admin_select
on public.exam_results
for select
to authenticated
using (public.can_scoped_manager_view_attempt(attempt_id));

drop policy if exists exam_reports_scoped_admin_select on public.exam_reports;
create policy exam_reports_scoped_admin_select
on public.exam_reports
for select
to authenticated
using (public.can_scoped_manager_view_attempt(attempt_id));

grant update (name, organisation_type, status, billing_model, notes, updated_at)
on public.organisations to authenticated;

grant update (name, code, status, updated_at)
on public.campuses to authenticated;

grant update (name, academic_year, max_students, status, updated_at)
on public."groups" to authenticated;

revoke all on function public.can_scoped_admin_manage_organisation(uuid) from public;
revoke all on function public.can_scoped_admin_manage_campus(uuid) from public;
revoke all on function public.can_scoped_admin_manage_group(uuid) from public;
revoke all on function public.can_scoped_manager_view_membership(uuid) from public;
revoke all on function public.can_scoped_manager_view_student(uuid) from public;
revoke all on function public.can_scoped_manager_view_attempt(uuid) from public;

grant execute on function public.can_scoped_admin_manage_organisation(uuid) to authenticated;
grant execute on function public.can_scoped_admin_manage_campus(uuid) to authenticated;
grant execute on function public.can_scoped_admin_manage_group(uuid) to authenticated;
grant execute on function public.can_scoped_manager_view_membership(uuid) to authenticated;
grant execute on function public.can_scoped_manager_view_student(uuid) to authenticated;
grant execute on function public.can_scoped_manager_view_attempt(uuid) to authenticated;
