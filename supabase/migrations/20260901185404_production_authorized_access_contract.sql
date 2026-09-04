-- Issue #20 Phase R2B1: permanent production-authorized personal practice.
-- The hosted data correction is guarded and runs only when the exact known
-- production package/policy inventory is present. A schema-only database with
-- no published packages remains inert for deterministic migration testing.

alter table exam_delivery.practice_policies
  drop constraint practice_policies_access_mode_check;
alter table exam_delivery.practice_policies
  add constraint practice_policies_access_mode_check check (
    access_mode in (
      'disabled','open_authenticated','organisation_scoped',
      'assignment_required','controlled_beta','production_authorized'
    )
  );

alter table exam_delivery.exam_entitlements
  add column entitlement_source text not null default 'assignment',
  add column purchase_reference text,
  add column revoked_at timestamptz,
  add column revoked_by uuid references auth.users(id) on delete restrict;

alter table exam_delivery.exam_entitlements
  add constraint exam_entitlements_source_check check (
    entitlement_source in ('assignment','direct_exam_purchase','package_purchase')
  ),
  add constraint exam_entitlements_purchase_shape_check check (
    (entitlement_source='assignment' and purchase_reference is null)
    or (entitlement_source in ('direct_exam_purchase','package_purchase')
      and target_type='learner' and purchase_reference ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$')
  ),
  add constraint exam_entitlements_revocation_check check (
    (revoked_at is null and revoked_by is null)
    or (revoked_at is not null and revoked_by is not null and not enabled)
  );

create unique index exam_entitlements_purchase_profile_unique
  on exam_delivery.exam_entitlements(
    learner_id,package_version_id,package_profile_id,entitlement_source,purchase_reference
  ) where entitlement_source in ('direct_exam_purchase','package_purchase');

create or replace function exam_delivery.is_authoritative_staff(p_actor_id uuid)
returns boolean language sql stable security definer set search_path='' set statement_timeout='3s' as $$
  select p_actor_id is not null
    and exists(select 1 from public.profiles p where p.id=p_actor_id and p.status='active')
    and exists(select 1 from public.memberships m
      where m.user_id=p_actor_id and m.status='active'
        and m.role in ('developer','platform_owner','college_admin','campus_admin','trainer','reception'))
$$;

create or replace function exam_delivery.classify_actor(p_actor_id uuid)
returns text language sql stable security definer set search_path='' set statement_timeout='3s' as $$
  select case
    when not exists(select 1 from public.profiles p where p.id=p_actor_id and p.status='active') then 'unclassified'
    when exam_delivery.is_authoritative_staff(p_actor_id) then 'staff'
    when exists(select 1 from public.memberships m where m.user_id=p_actor_id and m.status='active' and m.role='student') then 'student'
    when exists(select 1 from public.profiles p where p.id=p_actor_id and p.status='active' and p.default_role='individual_user') then 'basic'
    else 'unclassified' end
$$;

create or replace function exam_delivery.has_staff_profile_access(
  p_actor_id uuid,p_package_version_id uuid,p_package_profile_id uuid
) returns boolean language sql stable security definer set search_path='' set statement_timeout='3s' as $$
  select exam_delivery.is_authoritative_staff(p_actor_id)
    and exists(select 1 from exam_delivery.exam_profile_activations a
      where a.package_version_id=p_package_version_id
        and a.package_profile_id=p_package_profile_id
        and a.activation_kind='production' and a.enabled)
$$;

create or replace function exam_delivery.has_student_profile_entitlement(
  p_actor_id uuid,p_package_version_id uuid,p_package_profile_id uuid
) returns boolean language sql stable security definer set search_path='' set statement_timeout='5s' as $$
  select exists(select 1 from exam_delivery.exam_profile_activations a
      where a.package_version_id=p_package_version_id and a.package_profile_id=p_package_profile_id
        and a.activation_kind='production' and a.enabled)
    and exists(select 1 from public.profiles p join public.memberships m on m.user_id=p.id
      where p.id=p_actor_id and p.status='active' and m.status='active' and m.role='student')
    and exists(select 1 from exam_delivery.exam_entitlements e
      where e.package_version_id=p_package_version_id and e.package_profile_id=p_package_profile_id
        and e.entitlement_source='assignment' and e.enabled and e.revoked_at is null
        and (e.valid_from is null or e.valid_from<=statement_timestamp())
        and (e.valid_until is null or e.valid_until>statement_timestamp())
        and ((e.target_type='learner' and e.learner_id=p_actor_id)
          or (e.target_type='organisation' and exists(select 1 from public.memberships m where m.user_id=p_actor_id and m.status='active' and m.role='student' and m.organisation_id=e.organisation_id))
          or (e.target_type='campus' and exists(select 1 from public.memberships m where m.user_id=p_actor_id and m.status='active' and m.role='student' and m.campus_id=e.campus_id))
          or (e.target_type='group' and exists(select 1 from public.memberships m where m.user_id=p_actor_id and m.status='active' and m.role='student' and m.group_id=e.group_id))))
$$;

create or replace function exam_delivery.has_purchase_profile_entitlement(
  p_actor_id uuid,p_package_version_id uuid,p_package_profile_id uuid
) returns boolean language sql stable security definer set search_path='' set statement_timeout='5s' as $$
  select exists(select 1 from public.profiles p
      where p.id=p_actor_id and p.status='active' and p.default_role='individual_user')
    and exists(select 1 from exam_delivery.exam_profile_activations a
      where a.package_version_id=p_package_version_id and a.package_profile_id=p_package_profile_id
        and a.activation_kind='production' and a.enabled)
    and exists(select 1 from exam_delivery.exam_entitlements e
      where e.learner_id=p_actor_id and e.target_type='learner'
        and e.package_version_id=p_package_version_id and e.package_profile_id=p_package_profile_id
        and e.entitlement_source in ('direct_exam_purchase','package_purchase')
        and e.enabled and e.revoked_at is null
        and (e.valid_from is null or e.valid_from<=statement_timestamp())
        and (e.valid_until is null or e.valid_until>statement_timestamp()))
$$;

create or replace function exam_delivery.can_use_profile(
  p_actor_id uuid,p_package_version_id uuid,p_package_profile_id uuid,p_purpose exam_delivery.attempt_purpose
) returns boolean language sql stable security definer set search_path='' set statement_timeout='5s' as $$
  select exam_delivery.has_preview_profile_access(p_actor_id,p_package_version_id,p_package_profile_id,p_purpose)
    or exam_delivery.has_staff_profile_access(p_actor_id,p_package_version_id,p_package_profile_id)
    or exam_delivery.has_student_profile_entitlement(p_actor_id,p_package_version_id,p_package_profile_id)
    or exam_delivery.has_purchase_profile_entitlement(p_actor_id,p_package_version_id,p_package_profile_id)
$$;

create or replace function exam_delivery.staff_can_view_learner(p_actor_id uuid,p_learner_id uuid)
returns boolean language sql stable security definer set search_path='' set statement_timeout='5s' as $$
  select exists(select 1 from public.memberships m where m.user_id=p_actor_id and m.status='active' and m.role in ('developer','platform_owner'))
  or exists(select 1 from public.memberships staff join public.memberships learner on learner.user_id=p_learner_id
    where staff.user_id=p_actor_id and staff.status='active' and learner.status='active' and learner.role='student'
      and ((staff.role='college_admin' and staff.organisation_id=learner.organisation_id)
        or (staff.role='campus_admin' and staff.organisation_id=learner.organisation_id and staff.campus_id=learner.campus_id)
        or (staff.role='trainer' and staff.organisation_id=learner.organisation_id and staff.group_id is not null and staff.group_id=learner.group_id)))
$$;

create function public.certsim_grant_purchase_entitlement(
  p_learner_id uuid,p_package_version_id uuid,p_package_profile_ids uuid[],
  p_entitlement_source text,p_purchase_reference text,p_valid_until timestamptz default null
) returns jsonb language plpgsql security definer set search_path='' set statement_timeout='8s' as $$
declare v_actor uuid:=auth.uid(); v_count integer;
begin
  if v_actor is null or not exists(select 1 from public.memberships m where m.user_id=v_actor and m.status='active' and m.role in ('developer','platform_owner')) then
    raise exception 'purchase_entitlement_forbidden' using errcode='42501';
  end if;
  if p_entitlement_source not in ('direct_exam_purchase','package_purchase')
    or p_purchase_reference !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$'
    or coalesce(cardinality(p_package_profile_ids),0)=0
    or p_valid_until is not null and p_valid_until<=statement_timestamp()
    or not exists(select 1 from public.profiles p where p.id=p_learner_id and p.status='active' and p.default_role='individual_user') then
    raise exception 'invalid_purchase_entitlement' using errcode='22023';
  end if;
  if exists(select 1 from unnest(p_package_profile_ids) x(id) left join exam_delivery.package_profiles pp
      on pp.id=x.id and pp.package_version_id=p_package_version_id where pp.id is null) then
    raise exception 'purchase_profile_mismatch' using errcode='22023';
  end if;
  insert into exam_delivery.exam_entitlements(
    package_version_id,package_profile_id,target_type,learner_id,enabled,valid_from,valid_until,
    reason_code,created_by,entitlement_source,purchase_reference
  ) select p_package_version_id,x.id,'learner',p_learner_id,true,statement_timestamp(),p_valid_until,
      'purchase_fulfilment',v_actor,p_entitlement_source,p_purchase_reference
    from (select distinct id from unnest(p_package_profile_ids) t(id)) x;
  get diagnostics v_count=row_count;
  return jsonb_build_object('ok',true,'entitlementsCreated',v_count);
end $$;

alter function exam_delivery.is_authoritative_staff(uuid) owner to postgres;
alter function exam_delivery.classify_actor(uuid) owner to postgres;
alter function exam_delivery.has_staff_profile_access(uuid,uuid,uuid) owner to postgres;
alter function exam_delivery.has_student_profile_entitlement(uuid,uuid,uuid) owner to postgres;
alter function exam_delivery.has_purchase_profile_entitlement(uuid,uuid,uuid) owner to postgres;
alter function exam_delivery.can_use_profile(uuid,uuid,uuid,exam_delivery.attempt_purpose) owner to postgres;
alter function exam_delivery.staff_can_view_learner(uuid,uuid) owner to postgres;
alter function public.certsim_grant_purchase_entitlement(uuid,uuid,uuid[],text,text,timestamptz) owner to postgres;

revoke execute on function exam_delivery.is_authoritative_staff(uuid),exam_delivery.classify_actor(uuid),
  exam_delivery.has_staff_profile_access(uuid,uuid,uuid),exam_delivery.has_student_profile_entitlement(uuid,uuid,uuid),
  exam_delivery.has_purchase_profile_entitlement(uuid,uuid,uuid),
  exam_delivery.can_use_profile(uuid,uuid,uuid,exam_delivery.attempt_purpose),
  exam_delivery.staff_can_view_learner(uuid,uuid) from public,anon,authenticated,service_role;
revoke execute on function public.certsim_grant_purchase_entitlement(uuid,uuid,uuid[],text,text,timestamptz)
  from public,anon,authenticated,service_role;
grant execute on function public.certsim_grant_purchase_entitlement(uuid,uuid,uuid[],text,text,timestamptz)
  to authenticated;

do $$
declare v_package_count integer; v_policy_count integer; v_updated integer;
begin
  select count(*) into v_package_count from exam_delivery.package_versions;
  select count(*) into v_policy_count from exam_delivery.practice_policies where purpose='self_directed_exam';
  if v_package_count=0 and v_policy_count=0 then return; end if;
  if v_policy_count<>12
    or (select count(*) from exam_delivery.practice_policies where purpose='self_directed_exam' and enabled)<>0
    or (select count(*) from exam_delivery.practice_policies where purpose='self_directed_exam' and access_mode='disabled')<>12
    or (select count(*) from exam_delivery.practice_policies where purpose='self_directed_exam' and review_release_policy='never' and answer_release_policy='never' and not immediate_feedback and cooldown_seconds=0 and maximum_concurrent_sessions=1)<>12
  then raise exception 'unexpected_practice_policy_prestate'; end if;
  if (select count(*) from exam_delivery.practice_policies where purpose='self_directed_exam'
      and (canonical_exam_key,package_version,profile_key) in (
        ('ai901','1.0.0','ai901-controlled-beta-compact'),('ai901','1.0.0','ai901-controlled-beta-full'),
        ('ai901','2.0.0','ai901-controlled-beta-compact'),
        ('az204','1.1.0','case-heavy-profile'),('az204','1.1.0','compact-profile'),
        ('az204','1.1.0','full-profile'),('az204','1.1.0','standard-profile'),
        ('az400','1.0.0','az400-mvp-compact-profile'),('az400','1.0.0','az400-mvp-full-profile'),
        ('az400','1.0.0','az400-sectioned-full-exam-profile'),
        ('securityplussy0701','1.0.0','strict-beta-compact'),
        ('securityplussy0701','1.0.0','strict-beta-full')))<>12
  then raise exception 'unexpected_practice_policy_identity_prestate'; end if;
  if (select count(*) from exam_delivery.practice_policies where purpose='self_directed_exam'
      and ((canonical_exam_key='ai901' and package_version='2.0.0' and profile_key='ai901-controlled-beta-compact' and maximum_completed_attempts is null and maximum_session_items=25)
        or (canonical_exam_key='ai901' and package_version='1.0.0' and profile_key='ai901-controlled-beta-compact' and maximum_completed_attempts=2 and maximum_session_items=25)
        or (canonical_exam_key='ai901' and package_version='1.0.0' and profile_key='ai901-controlled-beta-full' and maximum_completed_attempts=2 and maximum_session_items=50)
        or (canonical_exam_key='az204' and package_version='1.1.0' and profile_key='case-heavy-profile' and maximum_completed_attempts=2 and maximum_session_items=50)
        or (canonical_exam_key='az204' and package_version='1.1.0' and profile_key='compact-profile' and maximum_completed_attempts=2 and maximum_session_items=40)
        or (canonical_exam_key='az204' and package_version='1.1.0' and profile_key='full-profile' and maximum_completed_attempts=2 and maximum_session_items=60)
        or (canonical_exam_key='az204' and package_version='1.1.0' and profile_key='standard-profile' and maximum_completed_attempts=2 and maximum_session_items=50)
        or (canonical_exam_key='az400' and package_version='1.0.0' and profile_key='az400-mvp-compact-profile' and maximum_completed_attempts=2 and maximum_session_items=60)
        or (canonical_exam_key='az400' and package_version='1.0.0' and profile_key='az400-mvp-full-profile' and maximum_completed_attempts=2 and maximum_session_items=80)
        or (canonical_exam_key='az400' and package_version='1.0.0' and profile_key='az400-sectioned-full-exam-profile' and maximum_completed_attempts=2 and maximum_session_items=80)
        or (canonical_exam_key='securityplussy0701' and package_version='1.0.0' and profile_key='strict-beta-compact' and maximum_completed_attempts=2 and maximum_session_items=45)
        or (canonical_exam_key='securityplussy0701' and package_version='1.0.0' and profile_key='strict-beta-full' and maximum_completed_attempts=2 and maximum_session_items=90)))<>12
  then raise exception 'unexpected_practice_policy_value_prestate'; end if;
  if (select count(*) from exam_delivery.exam_profile_activations where enabled and activation_kind='production')<>11
  then raise exception 'unexpected_activation_prestate'; end if;
  if (select count(*) from exam_delivery.exam_profile_activations a
      join exam_delivery.package_versions pv on pv.id=a.package_version_id
      join exam_delivery.package_profiles pp on pp.id=a.package_profile_id
      where a.enabled and a.activation_kind='production'
        and (exam_delivery.normalize_exam_key(pv.exam_key),pv.package_version,pp.profile_key) in (
          ('ai901','2.0.0','ai901-controlled-beta-compact'),('ai901','2.0.0','ai901-controlled-beta-full'),
          ('az204','1.1.0','case-heavy-profile'),('az204','1.1.0','compact-profile'),
          ('az204','1.1.0','full-profile'),('az204','1.1.0','standard-profile'),
          ('az400','1.0.0','az400-mvp-compact-profile'),('az400','1.0.0','az400-mvp-full-profile'),
          ('az400','1.0.0','az400-sectioned-full-exam-profile'),
          ('securityplussy0701','1.0.0','strict-beta-compact'),
          ('securityplussy0701','1.0.0','strict-beta-full')))<>11
  then raise exception 'unexpected_activation_identity_prestate'; end if;

  insert into exam_delivery.practice_policies(
    canonical_exam_key,package_version,profile_key,purpose,access_mode,enabled,
    maximum_completed_attempts,cooldown_seconds,maximum_concurrent_sessions,
    maximum_session_items,immediate_feedback,review_release_policy,answer_release_policy
  ) values ('ai901','2.0.0','ai901-controlled-beta-full','self_directed_exam',
    'production_authorized',true,null,0,1,50,false,'never','never');

  update exam_delivery.practice_policies p set
    access_mode='production_authorized',enabled=true,maximum_completed_attempts=null,
    cooldown_seconds=0,maximum_concurrent_sessions=1,immediate_feedback=false,
    review_release_policy='never',answer_release_policy='never',updated_at=statement_timestamp()
  where p.purpose='self_directed_exam' and (p.canonical_exam_key,p.package_version,p.profile_key) in (
    ('ai901','2.0.0','ai901-controlled-beta-compact'),
    ('az204','1.1.0','case-heavy-profile'),('az204','1.1.0','compact-profile'),
    ('az204','1.1.0','full-profile'),('az204','1.1.0','standard-profile'),
    ('az400','1.0.0','az400-mvp-compact-profile'),('az400','1.0.0','az400-mvp-full-profile'),
    ('az400','1.0.0','az400-sectioned-full-exam-profile'),
    ('securityplussy0701','1.0.0','strict-beta-compact'),
    ('securityplussy0701','1.0.0','strict-beta-full'));
  get diagnostics v_updated=row_count;
  if v_updated<>10 or (select count(*) from exam_delivery.practice_policies where purpose='self_directed_exam' and enabled and access_mode='production_authorized' and maximum_completed_attempts is null and maximum_concurrent_sessions=1 and cooldown_seconds=0 and review_release_policy='never' and answer_release_policy='never' and not immediate_feedback)<>11
    or (select count(*) from exam_delivery.practice_policies where purpose='self_directed_exam')<>13
    or (select count(*) from exam_delivery.practice_policies where canonical_exam_key='ai901' and package_version='1.0.0' and purpose='self_directed_exam' and not enabled and access_mode='disabled')<>2
    or exists(select 1 from exam_delivery.practice_policies where purpose<>'self_directed_exam' and enabled)
  then raise exception 'unexpected_practice_policy_poststate'; end if;
end $$;
