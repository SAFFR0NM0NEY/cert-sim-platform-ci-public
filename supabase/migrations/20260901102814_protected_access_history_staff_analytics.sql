-- Issue #20 G3C3R3: inert production access model, immutable actor
-- classification, and unified authoritative history. This migration creates
-- no activation, entitlement, preview-access, package, assignment, attempt,
-- result, or review row.

create table exam_delivery.exam_profile_activations (
  id uuid primary key default gen_random_uuid(),
  package_version_id uuid not null references exam_delivery.package_versions(id) on delete restrict,
  package_profile_id uuid not null,
  enabled boolean not null default false,
  activation_kind text not null default 'production',
  enabled_at timestamptz,
  disabled_at timestamptz,
  created_by uuid references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint exam_profile_activations_profile_fk foreign key(package_version_id,package_profile_id)
    references exam_delivery.package_profiles(package_version_id,id) on delete restrict,
  constraint exam_profile_activations_identity_unique unique(package_version_id,package_profile_id,activation_kind),
  constraint exam_profile_activations_kind_check check(activation_kind in ('production','preview')),
  constraint exam_profile_activations_timestamp_check check(
    (enabled and enabled_at is not null and disabled_at is null)
    or (not enabled and (enabled_at is null or disabled_at is not null))
  )
);

create table exam_delivery.exam_entitlements (
  id uuid primary key default gen_random_uuid(),
  package_version_id uuid not null references exam_delivery.package_versions(id) on delete restrict,
  package_profile_id uuid not null,
  target_type text not null,
  learner_id uuid references auth.users(id) on delete restrict,
  organisation_id uuid references public.organisations(id) on delete restrict,
  campus_id uuid references public.campuses(id) on delete restrict,
  group_id uuid references public."groups"(id) on delete restrict,
  module_key text,
  enabled boolean not null default false,
  valid_from timestamptz,
  valid_until timestamptz,
  reason_code text not null,
  created_by uuid references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint exam_entitlements_profile_fk foreign key(package_version_id,package_profile_id)
    references exam_delivery.package_profiles(package_version_id,id) on delete restrict,
  constraint exam_entitlements_target_type_check check(target_type in ('learner','organisation','campus','group','module')),
  constraint exam_entitlements_target_check check(
    (target_type='learner' and learner_id is not null and organisation_id is null and campus_id is null and group_id is null and module_key is null)
    or (target_type='organisation' and learner_id is null and organisation_id is not null and campus_id is null and group_id is null and module_key is null)
    or (target_type='campus' and learner_id is null and organisation_id is null and campus_id is not null and group_id is null and module_key is null)
    or (target_type='group' and learner_id is null and organisation_id is null and campus_id is null and group_id is not null and module_key is null)
    or (target_type='module' and learner_id is null and organisation_id is null and campus_id is null and group_id is null and module_key is not null)
  ),
  constraint exam_entitlements_window_check check(valid_until is null or valid_from is null or valid_until>valid_from),
  constraint exam_entitlements_reason_check check(reason_code ~ '^[a-z0-9][a-z0-9_-]{2,63}$')
);

create table exam_delivery.exam_preview_authorizations (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references auth.users(id) on delete restrict,
  package_version_id uuid not null references exam_delivery.package_versions(id) on delete restrict,
  package_profile_id uuid not null,
  purpose exam_delivery.attempt_purpose not null,
  enabled boolean not null default false,
  valid_from timestamptz not null,
  valid_until timestamptz not null,
  reason_code text not null,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint exam_preview_authorizations_profile_fk foreign key(package_version_id,package_profile_id)
    references exam_delivery.package_profiles(package_version_id,id) on delete restrict,
  constraint exam_preview_authorizations_identity_unique unique(actor_id,package_version_id,package_profile_id,purpose),
  constraint exam_preview_authorizations_window_check check(valid_until>valid_from),
  constraint exam_preview_authorizations_reason_check check(reason_code ~ '^issue20_[a-z0-9_-]{3,63}$')
);

create index exam_entitlements_learner_active_idx on exam_delivery.exam_entitlements(learner_id,package_version_id,package_profile_id) where enabled;
create index exam_entitlements_organisation_active_idx on exam_delivery.exam_entitlements(organisation_id,package_version_id,package_profile_id) where enabled;
create index exam_entitlements_campus_active_idx on exam_delivery.exam_entitlements(campus_id,package_version_id,package_profile_id) where enabled;
create index exam_entitlements_group_active_idx on exam_delivery.exam_entitlements(group_id,package_version_id,package_profile_id) where enabled;
create index exam_preview_authorizations_actor_active_idx on exam_delivery.exam_preview_authorizations(actor_id,package_version_id,package_profile_id,purpose) where enabled;

alter table exam_delivery.exam_profile_activations enable row level security;
alter table exam_delivery.exam_entitlements enable row level security;
alter table exam_delivery.exam_preview_authorizations enable row level security;
revoke all on table exam_delivery.exam_profile_activations,exam_delivery.exam_entitlements,exam_delivery.exam_preview_authorizations from public,anon,authenticated,service_role;

alter table exam_delivery.attempts
  add column actor_classification text,
  add column analytics_eligible boolean;
alter table exam_delivery.attempts add constraint attempts_actor_classification_check
  check(actor_classification is null or actor_classification in ('student','staff','basic','unclassified'));
alter table exam_delivery.attempts add constraint attempts_analytics_classification_check
  check(analytics_eligible is null or not analytics_eligible or (actor_classification='student' and purpose in ('assigned_assessment','self_directed_exam')));

create function exam_delivery.classify_actor(p_actor_id uuid)
returns text language sql stable security definer set search_path='' set statement_timeout='3s' as $$
  select case
    when not exists(select 1 from public.profiles p where p.id=p_actor_id and p.status='active') then 'unclassified'
    when exists(select 1 from public.memberships m where m.user_id=p_actor_id and m.status='active' and m.role in ('platform_owner','college_admin','campus_admin','trainer')) then 'staff'
    when exists(select 1 from public.memberships m where m.user_id=p_actor_id and m.status='active' and m.role='student') then 'student'
    when exists(select 1 from public.profiles p where p.id=p_actor_id and p.status='active' and p.default_role='individual_user') then 'basic'
    else 'unclassified' end
$$;

create function exam_delivery.has_staff_profile_access(p_actor_id uuid,p_package_version_id uuid,p_package_profile_id uuid)
returns boolean language sql stable security definer set search_path='' set statement_timeout='3s' as $$
  select exists(select 1 from exam_delivery.exam_profile_activations a
    where a.package_version_id=p_package_version_id and a.package_profile_id=p_package_profile_id
      and a.activation_kind='production' and a.enabled)
    and exists(select 1 from public.profiles p join public.memberships m on m.user_id=p.id
      where p.id=p_actor_id and p.status='active' and m.status='active'
        and m.role in ('platform_owner','college_admin','campus_admin','trainer'))
$$;

create function exam_delivery.has_student_profile_entitlement(p_actor_id uuid,p_package_version_id uuid,p_package_profile_id uuid)
returns boolean language sql stable security definer set search_path='' set statement_timeout='5s' as $$
  select exists(select 1 from exam_delivery.exam_profile_activations a
    where a.package_version_id=p_package_version_id and a.package_profile_id=p_package_profile_id
      and a.activation_kind='production' and a.enabled)
    and exists(select 1 from public.profiles p join public.memberships m on m.user_id=p.id
      where p.id=p_actor_id and p.status='active' and m.status='active' and m.role='student')
    and exists(
      select 1 from exam_delivery.exam_entitlements e
      where e.package_version_id=p_package_version_id and e.package_profile_id=p_package_profile_id
        and e.enabled and (e.valid_from is null or e.valid_from<=statement_timestamp())
        and (e.valid_until is null or e.valid_until>statement_timestamp())
        and (
          (e.target_type='learner' and e.learner_id=p_actor_id)
          or (e.target_type='organisation' and exists(select 1 from public.memberships m where m.user_id=p_actor_id and m.status='active' and m.role='student' and m.organisation_id=e.organisation_id))
          or (e.target_type='campus' and exists(select 1 from public.memberships m where m.user_id=p_actor_id and m.status='active' and m.role='student' and m.campus_id=e.campus_id))
          or (e.target_type='group' and exists(select 1 from public.memberships m where m.user_id=p_actor_id and m.status='active' and m.role='student' and m.group_id=e.group_id))
          or (e.target_type='module' and false)
        )
    )
$$;

create function exam_delivery.has_preview_profile_access(p_actor_id uuid,p_package_version_id uuid,p_package_profile_id uuid,p_purpose exam_delivery.attempt_purpose)
returns boolean language sql stable security definer set search_path='' set statement_timeout='3s' as $$
  select exists(select 1 from exam_delivery.exam_preview_authorizations a
    where a.actor_id=p_actor_id and a.package_version_id=p_package_version_id and a.package_profile_id=p_package_profile_id
      and a.purpose=p_purpose and a.enabled and a.valid_from<=statement_timestamp() and a.valid_until>statement_timestamp())
$$;

create function exam_delivery.can_use_profile(p_actor_id uuid,p_package_version_id uuid,p_package_profile_id uuid,p_purpose exam_delivery.attempt_purpose)
returns boolean language sql stable security definer set search_path='' set statement_timeout='5s' as $$
  select exam_delivery.has_preview_profile_access(p_actor_id,p_package_version_id,p_package_profile_id,p_purpose)
    or exam_delivery.has_staff_profile_access(p_actor_id,p_package_version_id,p_package_profile_id)
    or exam_delivery.has_student_profile_entitlement(p_actor_id,p_package_version_id,p_package_profile_id)
$$;

create function exam_delivery.set_attempt_actor_classification()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  new.actor_classification:=exam_delivery.classify_actor(new.owner_id);
  new.analytics_eligible:=new.actor_classification='student' and new.purpose in ('assigned_assessment','self_directed_exam');
  return new;
end $$;
create trigger set_attempt_actor_classification before insert on exam_delivery.attempts
for each row execute function exam_delivery.set_attempt_actor_classification();

create function exam_delivery.guard_attempt_actor_classification()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.actor_classification is distinct from old.actor_classification or new.analytics_eligible is distinct from old.analytics_eligible then
    raise exception 'attempt_actor_classification_immutable' using errcode='23514';
  end if;
  return new;
end $$;
create trigger guard_attempt_actor_classification before update on exam_delivery.attempts
for each row execute function exam_delivery.guard_attempt_actor_classification();

create function exam_delivery.staff_can_view_learner(p_actor_id uuid,p_learner_id uuid)
returns boolean language sql stable security definer set search_path='' set statement_timeout='5s' as $$
  select exists(select 1 from public.memberships m where m.user_id=p_actor_id and m.status='active' and m.role='platform_owner')
  or exists(
    select 1 from public.memberships staff join public.memberships learner on learner.user_id=p_learner_id
    where staff.user_id=p_actor_id and staff.status='active' and learner.status='active' and learner.role='student'
      and ((staff.role='college_admin' and staff.organisation_id=learner.organisation_id)
        or (staff.role='campus_admin' and staff.organisation_id=learner.organisation_id and staff.campus_id=learner.campus_id)
        or (staff.role='trainer' and staff.organisation_id=learner.organisation_id and staff.group_id is not null and staff.group_id=learner.group_id))
  )
$$;

create or replace function exam_delivery.list_history(p_actor_id uuid,p_exam_key text,p_cursor text,p_page_size integer)
returns jsonb language sql stable security definer set search_path='' set statement_timeout='8s' as $$
with all_rows as (
  select a.id attempt_id,a.completed_at completed_at,2 source_order,pv.exam_key,pv.package_version,pp.profile_key,
    a.purpose::text purpose,a.actor_classification,r.raw_score,r.raw_percentage,r.passed,r.domain_summary,
    coalesce(rs.release_status::text,'withheld') review_status,true server_authoritative,'protected' source
  from exam_delivery.attempts a join exam_delivery.package_versions pv on pv.id=a.package_version_id
  join exam_delivery.package_profiles pp on pp.id=a.package_profile_id join exam_delivery.attempt_results r on r.attempt_id=a.id
  left join exam_delivery.review_snapshots rs on rs.attempt_id=a.id where a.owner_id=p_actor_id and a.status='completed'
  union all
  select a.id,a.submitted_at,1,a.exam_key,coalesce(a.exam_version,'legacy'),a.profile_id,
    'unclassified',null,r.raw_score,r.raw_percentage,r.passed,coalesce(r.domain_breakdown,'{}'::jsonb),
    'withheld',coalesce(r.result_snapshot->>'serverAuthoritative'='true',false),'legacy_authoritative'
  from public.exam_attempts a join public.exam_results r on r.attempt_id=a.id and r.user_id=p_actor_id
  where a.user_id=p_actor_id and a.status='submitted' and a.submitted_at is not null
    and not exists(select 1 from exam_delivery.attempts protected_attempt where protected_attempt.id=a.id)
), filtered as (
  select * from all_rows where p_exam_key is null or exam_delivery.normalize_exam_key(exam_key)=exam_delivery.normalize_exam_key(p_exam_key)
), eligible as (
  select * from filtered where p_cursor is null or (completed_at,attempt_id,source_order)<
    ((split_part(p_cursor,'|',1))::timestamptz,(split_part(p_cursor,'|',2))::uuid,(split_part(p_cursor,'|',3))::integer)
  order by completed_at desc,attempt_id desc,source_order desc
), bounded as (select * from eligible limit least(greatest(p_page_size,1),50)+1),
page as (select * from bounded limit least(greatest(p_page_size,1),50))
select jsonb_build_object('ok',true,'items',coalesce((select jsonb_agg(jsonb_build_object(
  'attemptId',attempt_id,'examKey',exam_key,'packageVersion',package_version,'profileKey',profile_key,'purpose',purpose,
  'actorClassification',actor_classification,'completedAt',completed_at,'score',raw_score,'percentage',raw_percentage,
  'passed',passed,'domainSummary',domain_summary,'serverAuthoritative',server_authoritative,'reviewStatus',review_status,'source',source)
  order by completed_at desc,attempt_id desc,source_order desc) from page),'[]'::jsonb),
  'returnedCount',(select count(*) from page),'totalCount',(select count(*) from filtered),
  'remainingCount',greatest((select count(*) from eligible)-(select count(*) from page),0),
  'nextCursor',case when (select count(*) from bounded)>least(greatest(p_page_size,1),50)
    then (select completed_at::text||'|'||attempt_id::text||'|'||source_order::text from page order by completed_at,attempt_id,source_order limit 1) else null end)
$$;

create or replace function exam_delivery.history_summary(p_actor_id uuid,p_exam_key text)
returns jsonb language sql stable security definer set search_path='' set statement_timeout='5s' as $$
with eligible as(select a.id,a.completed_at,r.raw_percentage,r.domain_summary from exam_delivery.attempts a
  join exam_delivery.package_versions pv on pv.id=a.package_version_id join exam_delivery.attempt_results r on r.attempt_id=a.id
  where a.owner_id=p_actor_id and a.status='completed' and a.analytics_eligible is true
    and exam_delivery.normalize_exam_key(pv.exam_key)=exam_delivery.normalize_exam_key(p_exam_key))
select jsonb_build_object('ok',true,'latest',(select jsonb_build_object('attemptId',id,'completedAt',completed_at,'percentage',raw_percentage) from eligible order by completed_at desc,id desc limit 1),
  'best',(select jsonb_build_object('attemptId',id,'completedAt',completed_at,'percentage',raw_percentage) from eligible order by raw_percentage desc,completed_at desc,id desc limit 1),
  'completedCount',(select count(*) from eligible),'weakDomains',coalesce((select domain_summary from eligible order by completed_at desc,id desc limit 1),'{}'::jsonb),
  'serverAuthoritative',true,'historicalUnclassifiedExcluded',true)
$$;

alter function exam_delivery.classify_actor(uuid) owner to postgres;
alter function exam_delivery.has_staff_profile_access(uuid,uuid,uuid) owner to postgres;
alter function exam_delivery.has_student_profile_entitlement(uuid,uuid,uuid) owner to postgres;
alter function exam_delivery.has_preview_profile_access(uuid,uuid,uuid,exam_delivery.attempt_purpose) owner to postgres;
alter function exam_delivery.can_use_profile(uuid,uuid,uuid,exam_delivery.attempt_purpose) owner to postgres;
alter function exam_delivery.set_attempt_actor_classification() owner to postgres;
alter function exam_delivery.guard_attempt_actor_classification() owner to postgres;
alter function exam_delivery.staff_can_view_learner(uuid,uuid) owner to postgres;
alter function exam_delivery.list_history(uuid,text,text,integer) owner to postgres;
alter function exam_delivery.history_summary(uuid,text) owner to postgres;

revoke execute on function exam_delivery.classify_actor(uuid),exam_delivery.has_staff_profile_access(uuid,uuid,uuid),
  exam_delivery.has_student_profile_entitlement(uuid,uuid,uuid),exam_delivery.has_preview_profile_access(uuid,uuid,uuid,exam_delivery.attempt_purpose),
  exam_delivery.can_use_profile(uuid,uuid,uuid,exam_delivery.attempt_purpose),exam_delivery.set_attempt_actor_classification(),
  exam_delivery.guard_attempt_actor_classification(),exam_delivery.staff_can_view_learner(uuid,uuid),
  exam_delivery.list_history(uuid,text,text,integer),exam_delivery.history_summary(uuid,text)
from public,anon,authenticated,service_role;
grant execute on function exam_delivery.list_history(uuid,text,text,integer),exam_delivery.history_summary(uuid,text) to service_role;

create or replace function exam_delivery.practice_availability(p_actor_id uuid,p_request jsonb)
returns jsonb language plpgsql stable security definer set search_path='' set statement_timeout='5s' as $$
declare v_exam text:=exam_delivery.normalize_exam_key(p_request->>'examKey'); v_profile text:=p_request->>'profileId';
  v_purpose text:=p_request->>'purpose'; v_version text; v_policy exam_delivery.practice_policies%rowtype;
  v_available integer:=0; v_pbq integer:=0; v_missed integer:=0; v_new integer:=0; v_domains jsonb:='{}'::jsonb; v_requested integer;
  v_package_id uuid; v_profile_id uuid;
begin
  if p_actor_id is null or v_purpose not in ('self_directed_exam','study_sandbox','targeted_domain','weak_area','pbq_practice')
     or p_request->>'language' not in ('csharp','python','mixed','not_applicable') then
    return jsonb_build_object('ok',false,'code','invalid_request'); end if;
  if not exists(select 1 from public.profiles where id=p_actor_id and status='active') then return jsonb_build_object('ok',false,'code','inactive_account'); end if;
  select pv.package_version,pv.id,pp.id into v_version,v_package_id,v_profile_id
  from exam_delivery.package_versions pv join exam_delivery.package_profiles pp on pp.package_version_id=pv.id
  where exam_delivery.normalize_exam_key(pv.exam_key)=v_exam and pv.status='published' and pp.profile_key=v_profile
  order by pv.published_at desc limit 1;
  if not found then return jsonb_build_object('ok',false,'code','package_unavailable'); end if;
  select * into v_policy from exam_delivery.practice_policies where canonical_exam_key=v_exam and package_version=v_version
    and profile_key=v_profile and purpose=v_purpose::exam_delivery.attempt_purpose;
  if not found or not v_policy.enabled or v_policy.access_mode='disabled' then return jsonb_build_object('ok',false,'code','practice_unavailable'); end if;
  if not exam_delivery.can_use_profile(p_actor_id,v_package_id,v_profile_id,v_purpose::exam_delivery.attempt_purpose) then
    return jsonb_build_object('ok',false,'code','access_not_granted'); end if;
  if v_policy.maximum_completed_attempts is not null and (select count(*) from exam_delivery.attempts a
    where a.owner_id=p_actor_id and a.package_version_id=v_package_id and a.package_profile_id=v_profile_id
      and a.purpose=v_policy.purpose and a.status='completed')>=v_policy.maximum_completed_attempts
  then return jsonb_build_object('ok',false,'code','attempt_limit_reached'); end if;
  if v_policy.cooldown_seconds>0 and exists(select 1 from exam_delivery.attempts a
    where a.owner_id=p_actor_id and a.package_version_id=v_package_id and a.package_profile_id=v_profile_id
      and a.purpose=v_policy.purpose and a.completed_at>statement_timestamp()-make_interval(secs=>v_policy.cooldown_seconds))
  then return jsonb_build_object('ok',false,'code','cooldown_active'); end if;
  select count(*)::integer,count(*) filter(where q.question_type like 'pbq-%')::integer into v_available,v_pbq
  from exam_delivery.package_questions q where q.package_version_id=v_package_id;
  select coalesce(jsonb_object_agg(domain_key,total),'{}'::jsonb) into v_domains from (
    select q.domain_key,count(*)::integer total from exam_delivery.package_questions q
    where q.package_version_id=v_package_id group by q.domain_key
  ) d;
  if v_purpose='targeted_domain' and (nullif(p_request->>'domain','') is null or not (v_domains ? (p_request->>'domain'))) then
    return jsonb_build_object('ok',false,'code','unknown_domain'); end if;
  select count(distinct item->>'questionId')::integer into v_missed
  from exam_delivery.attempts a join exam_delivery.review_snapshots rs on rs.attempt_id=a.id
  cross join lateral jsonb_array_elements(coalesce(rs.review_payload->'items','[]'::jsonb)) item
  where a.owner_id=p_actor_id and a.package_version_id=v_package_id and a.status='completed' and a.analytics_eligible is true
    and item->>'status' in ('Incorrect','Incomplete','Partial');
  select count(*)::integer into v_new from exam_delivery.package_questions q where q.package_version_id=v_package_id and not exists(
    select 1 from exam_delivery.attempt_items i join exam_delivery.attempts a on a.id=i.attempt_id
    where a.owner_id=p_actor_id and i.package_question_id=q.id);
  v_requested:=case when p_request->>'count'='all' then least(v_available,v_policy.maximum_session_items) else (p_request->>'count')::integer end;
  return jsonb_build_object('ok',true,'examKey',v_exam,'packageVersion',v_version,'profileKey',v_profile,'purpose',v_purpose,
    'available',v_available,'selectedCount',least(v_requested,v_available,v_policy.maximum_session_items),
    'adjustedCount',v_requested>least(v_available,v_policy.maximum_session_items),'domainCounts',v_domains,
    'missedCount',v_missed,'newCount',v_new,'pbqCount',v_pbq,
    'languages',case when v_exam='az204' and v_version='1.1.0' then '["csharp","python","mixed"]'::jsonb else '["not_applicable"]'::jsonb end);
end $$;

alter function exam_delivery.practice_availability(uuid,jsonb) owner to postgres;
revoke execute on function exam_delivery.practice_availability(uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function exam_delivery.practice_availability(uuid,jsonb) to service_role;

create function exam_delivery.list_staff_history(p_actor_id uuid,p_cursor text,p_page_size integer)
returns jsonb language sql stable security definer set search_path='' set statement_timeout='10s' as $$
with all_rows as (
  select a.id attempt_id,a.owner_id learner_id,a.completed_at completed_at,2 source_order,pv.exam_key,pv.package_version,
    pp.profile_key,a.purpose::text purpose,a.actor_classification,a.analytics_eligible,r.raw_score,r.raw_percentage,r.passed,
    r.domain_summary,coalesce(rs.release_status::text,'withheld') review_status,true server_authoritative,'protected' source
  from exam_delivery.attempts a join exam_delivery.package_versions pv on pv.id=a.package_version_id
  join exam_delivery.package_profiles pp on pp.id=a.package_profile_id join exam_delivery.attempt_results r on r.attempt_id=a.id
  left join exam_delivery.review_snapshots rs on rs.attempt_id=a.id
  where a.status='completed' and exam_delivery.staff_can_view_learner(p_actor_id,a.owner_id)
  union all
  select a.id,a.user_id,a.submitted_at,1,a.exam_key,coalesce(a.exam_version,'legacy'),a.profile_id,'unclassified',null,null,
    r.raw_score,r.raw_percentage,r.passed,coalesce(r.domain_breakdown,'{}'::jsonb),'withheld',
    coalesce(r.result_snapshot->>'serverAuthoritative'='true',false),'legacy_authoritative'
  from public.exam_attempts a join public.exam_results r on r.attempt_id=a.id and r.user_id=a.user_id
  where a.status='submitted' and a.submitted_at is not null and exam_delivery.staff_can_view_learner(p_actor_id,a.user_id)
    and not exists(select 1 from exam_delivery.attempts protected_attempt where protected_attempt.id=a.id)
), eligible as (
  select * from all_rows where p_cursor is null or (completed_at,attempt_id,source_order)<
    ((split_part(p_cursor,'|',1))::timestamptz,(split_part(p_cursor,'|',2))::uuid,(split_part(p_cursor,'|',3))::integer)
  order by completed_at desc,attempt_id desc,source_order desc
), bounded as (select * from eligible limit least(greatest(p_page_size,1),50)+1),
page as (select * from bounded limit least(greatest(p_page_size,1),50))
select jsonb_build_object('ok',true,'items',coalesce((select jsonb_agg(jsonb_build_object(
  'attemptId',attempt_id,'learnerId',learner_id,'examKey',exam_key,'packageVersion',package_version,'profileKey',profile_key,
  'purpose',purpose,'actorClassification',actor_classification,'analyticsEligible',analytics_eligible,'completedAt',completed_at,
  'score',raw_score,'percentage',raw_percentage,'passed',passed,'domainSummary',domain_summary,'serverAuthoritative',server_authoritative,
  'reviewStatus',review_status,'source',source) order by completed_at desc,attempt_id desc,source_order desc) from page),'[]'::jsonb),
  'returnedCount',(select count(*) from page),'totalCount',(select count(*) from all_rows),
  'remainingCount',greatest((select count(*) from eligible)-(select count(*) from page),0),
  'nextCursor',case when (select count(*) from bounded)>least(greatest(p_page_size,1),50)
    then (select completed_at::text||'|'||attempt_id::text||'|'||source_order::text from page order by completed_at,attempt_id,source_order limit 1) else null end)
$$;

create function public.certsim_protected_list_staff_history(p_actor_id uuid,p_cursor text,p_page_size integer)
returns jsonb language sql stable security invoker set search_path='' as $$
  select exam_delivery.list_staff_history(p_actor_id,p_cursor,p_page_size)
$$;
alter function exam_delivery.list_staff_history(uuid,text,integer) owner to postgres;
alter function public.certsim_protected_list_staff_history(uuid,text,integer) owner to postgres;
revoke execute on function exam_delivery.list_staff_history(uuid,text,integer),public.certsim_protected_list_staff_history(uuid,text,integer)
  from public,anon,authenticated,service_role;
grant execute on function exam_delivery.list_staff_history(uuid,text,integer),public.certsim_protected_list_staff_history(uuid,text,integer) to service_role;

create or replace function exam_delivery.start_practice(p_actor_id uuid,p_request jsonb)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='15s' as $$
declare v_availability jsonb; v_attempt exam_delivery.attempts%rowtype; v_existing exam_delivery.attempts%rowtype;
  v_package record; v_policy exam_delivery.practice_policies%rowtype; v_request_id uuid; v_configuration jsonb;
  v_now timestamptz:=statement_timestamp(); v_limit integer; v_response_count integer:=0; v_consumed_count integer:=0; v_has_expired boolean:=false;
begin
  begin v_request_id:=(p_request->>'clientRequestId')::uuid;
  exception when invalid_text_representation then return jsonb_build_object('ok',false,'code','invalid_request'); end;
  if p_actor_id is null or v_request_id is null then return jsonb_build_object('ok',false,'code','invalid_request'); end if;
  v_configuration:=p_request-'clientRequestId';
  v_availability:=exam_delivery.practice_availability(p_actor_id,p_request);
  if not coalesce((v_availability->>'ok')::boolean,false) then return v_availability; end if;
  if exam_delivery.classify_actor(p_actor_id) not in ('student','staff') then return jsonb_build_object('ok',false,'code','access_not_granted'); end if;
  if (v_availability->>'examKey'='az204' and v_availability->>'packageVersion'='1.1.0' and p_request->>'language' not in ('csharp','python','mixed'))
    or (not (v_availability->>'examKey'='az204' and v_availability->>'packageVersion'='1.1.0') and p_request->>'language'<>'not_applicable')
  then return jsonb_build_object('ok',false,'code','invalid_request'); end if;
  select pv.id package_version_id,pv.generator_version,pv.scorer_version,pp.id package_profile_id,pp.time_limit_minutes into strict v_package
  from exam_delivery.package_versions pv join exam_delivery.package_profiles pp on pp.package_version_id=pv.id
  where exam_delivery.normalize_exam_key(pv.exam_key)=v_availability->>'examKey' and pv.package_version=v_availability->>'packageVersion'
    and pp.profile_key=v_availability->>'profileKey' and pv.package_schema_version='certsim-protected-package-v2' and pv.status='published'
  for share of pv,pp;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_actor_id::text||':'||v_package.package_version_id::text||':'||
    v_package.package_profile_id::text||':'||(p_request->>'purpose')||':'||(p_request->>'language'),0));
  select * into v_existing from exam_delivery.attempts where owner_id=p_actor_id and client_request_id=v_request_id for update;
  if found then
    if v_existing.purpose=(p_request->>'purpose')::exam_delivery.attempt_purpose and v_existing.practice_configuration=v_configuration
      and v_existing.language_preference=p_request->>'language' and v_existing.package_version_id=v_package.package_version_id
      and v_existing.package_profile_id=v_package.package_profile_id then return exam_delivery.resume_attempt(p_actor_id,v_existing.id); end if;
    return jsonb_build_object('ok',false,'code','attempt_conflict');
  end if;
  select * into v_policy from exam_delivery.practice_policies p where p.canonical_exam_key=v_availability->>'examKey'
    and p.package_version=v_availability->>'packageVersion' and p.profile_key=v_availability->>'profileKey'
    and p.purpose=(p_request->>'purpose')::exam_delivery.attempt_purpose for update;
  if not found or not v_policy.enabled or v_policy.access_mode='disabled' then return jsonb_build_object('ok',false,'code','practice_unavailable'); end if;
  select a.* into v_existing from exam_delivery.attempts a where a.owner_id=p_actor_id
    and a.package_version_id=v_package.package_version_id and a.package_profile_id=v_package.package_profile_id
    and a.purpose=(p_request->>'purpose')::exam_delivery.attempt_purpose and a.language_preference=p_request->>'language'
    and a.status='in_progress' for update of a;
  if found then
    if v_existing.expires_at>v_now then return exam_delivery.resume_attempt(p_actor_id,v_existing.id); end if;
    if v_existing.protected_assignment_id is not null or exists(select 1 from exam_delivery.attempt_results r where r.attempt_id=v_existing.id)
      or exists(select 1 from exam_delivery.review_snapshots r where r.attempt_id=v_existing.id)
    then return jsonb_build_object('ok',false,'code','invalid_lifecycle_transition'); end if;
    select count(*)::integer into v_response_count from exam_delivery.attempt_responses r where r.attempt_id=v_existing.id;
    v_has_expired:=true;
  end if;
  if v_policy.maximum_completed_attempts is not null then
    select count(*)::integer into v_consumed_count from exam_delivery.attempts a
    where a.owner_id=p_actor_id and a.package_version_id=v_package.package_version_id and a.package_profile_id=v_package.package_profile_id
      and a.purpose=v_policy.purpose and (a.status='completed' or (a.status='expired' and exists(
        select 1 from exam_delivery.attempt_responses r where r.attempt_id=a.id)));
    if v_has_expired and v_response_count>0 then v_consumed_count:=v_consumed_count+1; end if;
    if v_consumed_count>=v_policy.maximum_completed_attempts then return jsonb_build_object('ok',false,'code','attempt_limit_reached'); end if;
  end if;
  v_availability:=exam_delivery.practice_availability(p_actor_id,p_request);
  if not coalesce((v_availability->>'ok')::boolean,false) then return v_availability; end if;
  if v_has_expired then
    update exam_delivery.attempts set status='expired' where id=v_existing.id and status='in_progress' and expires_at<=v_now;
    if not found then return jsonb_build_object('ok',false,'code','attempt_conflict'); end if;
  end if;
  insert into exam_delivery.attempts(owner_id,package_version_id,package_profile_id,protected_assignment_id,client_request_id,status,
    generator_version,scorer_version,created_at,started_at,expires_at,purpose,practice_configuration,language_preference)
  values(p_actor_id,v_package.package_version_id,v_package.package_profile_id,null,v_request_id,'in_progress',v_package.generator_version,
    v_package.scorer_version,v_now,v_now,v_now+make_interval(mins=>v_package.time_limit_minutes),
    (p_request->>'purpose')::exam_delivery.attempt_purpose,v_configuration,p_request->>'language') returning * into v_attempt;
  v_limit:=(v_availability->>'selectedCount')::integer;
  perform exam_delivery.materialize_attempt_items(v_attempt.id,v_request_id,v_limit);
  if v_has_expired then insert into exam_delivery.practice_attempt_expirations(expired_attempt_id,replacement_attempt_id,owner_id,reason_code,
    response_count,expired_at,replacement_started_at) values(v_existing.id,v_attempt.id,p_actor_id,'practice_window_expired',
    v_response_count,v_now,v_attempt.started_at); end if;
  return exam_delivery.resume_attempt(p_actor_id,v_attempt.id);
exception when no_data_found or too_many_rows then return jsonb_build_object('ok',false,'code','package_unavailable');
when unique_violation then return jsonb_build_object('ok',false,'code','attempt_conflict');
end $$;
alter function exam_delivery.start_practice(uuid,jsonb) owner to postgres;
revoke execute on function exam_delivery.start_practice(uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function exam_delivery.start_practice(uuid,jsonb) to service_role;
