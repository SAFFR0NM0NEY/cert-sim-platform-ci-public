-- CertSim Platform Owner identity management policy extension.
-- Apply manually after 0001_certsim_identity_foundation.sql and
-- 0002_certsim_attempt_result_storage.sql.
-- This migration enables Platform Owner-only management of organisation,
-- campus, group, and membership records through the authenticated frontend.
-- It does not create auth users, enforce exam access, add assignments, or grant
-- anonymous access.

drop policy if exists organisations_platform_owner_manage on public.organisations;
create policy organisations_platform_owner_manage
on public.organisations
for all
to authenticated
using (public.is_platform_owner())
with check (public.is_platform_owner());

drop policy if exists campuses_platform_owner_manage on public.campuses;
create policy campuses_platform_owner_manage
on public.campuses
for all
to authenticated
using (public.is_platform_owner())
with check (public.is_platform_owner());

drop policy if exists groups_platform_owner_manage on public."groups";
create policy groups_platform_owner_manage
on public."groups"
for all
to authenticated
using (public.is_platform_owner())
with check (public.is_platform_owner());

drop policy if exists memberships_platform_owner_manage on public.memberships;
create policy memberships_platform_owner_manage
on public.memberships
for all
to authenticated
using (public.is_platform_owner())
with check (public.is_platform_owner());

grant select, insert, update on public.organisations to authenticated;
grant select, insert, update on public.campuses to authenticated;
grant select, insert, update on public."groups" to authenticated;
grant select, insert, update on public.memberships to authenticated;
