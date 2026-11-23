-- Issue #59: authoritative assignment access and protected functional recovery.
-- This forward-only migration preserves all completed attempts, results, reviews,
-- legacy cutover entitlements, and immutable package content.

create or replace function exam_delivery.normalize_exam_key(p_exam_key text)
returns text
language sql
immutable
strict
security invoker
set search_path = ''
as $$
  select case pg_catalog.regexp_replace(
    pg_catalog.lower(pg_catalog.btrim(p_exam_key)), '[^a-z0-9]+', '', 'g'
  )
    when 'securityplus' then 'securityplussy0701'
    when 'securityplussy0701' then 'securityplussy0701'
    else nullif(pg_catalog.regexp_replace(
      pg_catalog.lower(pg_catalog.btrim(p_exam_key)), '[^a-z0-9]+', '', 'g'
    ), '')
  end
$$;

alter table exam_delivery.exam_entitlements
  add column source_assignment_id uuid references public.exam_assignments(id) on delete restrict;

alter table exam_delivery.exam_entitlements
  add constraint exam_entitlements_assignment_provenance_check check (
    source_assignment_id is null
    or (entitlement_source = 'assignment' and purchase_reference is null)
  );

create unique index exam_entitlements_source_assignment_profile_unique
  on exam_delivery.exam_entitlements(source_assignment_id, package_version_id, package_profile_id)
  where source_assignment_id is not null;

create index exam_entitlements_source_assignment_active_idx
  on exam_delivery.exam_entitlements(source_assignment_id)
  where source_assignment_id is not null and enabled and revoked_at is null;

create or replace function exam_delivery.reconcile_assignment_entitlements(
  p_assignment_id uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
set statement_timeout = '8s'
as $$
declare
  v_assignment public.exam_assignments%rowtype;
  v_enabled boolean;
  v_count integer := 0;
begin
  select * into strict v_assignment
  from public.exam_assignments
  where id = p_assignment_id
  for update;

  v_enabled := v_assignment.status = 'active'
    and (v_assignment.due_at is null or v_assignment.due_at > statement_timestamp());

  update exam_delivery.exam_entitlements
  set enabled = false,
      revoked_at = case when v_assignment.assigned_by is not null
        then coalesce(revoked_at, statement_timestamp()) else null end,
      revoked_by = case when v_assignment.assigned_by is not null
        then coalesce(revoked_by, v_assignment.assigned_by) else null end,
      updated_at = statement_timestamp()
  where source_assignment_id = v_assignment.id
    and enabled
    and not v_enabled;

  if not v_enabled then
    get diagnostics v_count = row_count;
    return v_count;
  end if;

  insert into exam_delivery.exam_entitlements(
    package_version_id, package_profile_id, target_type, learner_id, group_id,
    enabled, valid_from, valid_until, reason_code, created_by,
    entitlement_source, source_assignment_id
  )
  select pv.id, pp.id,
    case when v_assignment.student_user_id is not null then 'learner' else 'group' end,
    v_assignment.student_user_id, v_assignment.group_id,
    true, coalesce(v_assignment.available_from, v_assignment.created_at),
    v_assignment.due_at, 'assignment_sync', v_assignment.assigned_by,
    'assignment', v_assignment.id
  from exam_delivery.package_versions pv
  join exam_delivery.package_profiles pp on pp.package_version_id = pv.id
  join exam_delivery.exam_profile_activations activation
    on activation.package_version_id = pv.id
   and activation.package_profile_id = pp.id
   and activation.activation_kind = 'production'
   and activation.enabled
  where pv.status = 'published'
    and exam_delivery.normalize_exam_key(pv.exam_key) =
        exam_delivery.normalize_exam_key(v_assignment.exam_key)
    and (v_assignment.profile_id is null or pp.profile_key = v_assignment.profile_id)
  on conflict (source_assignment_id, package_version_id, package_profile_id)
    where source_assignment_id is not null
  do update set
    target_type = excluded.target_type,
    learner_id = excluded.learner_id,
    group_id = excluded.group_id,
    enabled = true,
    valid_from = excluded.valid_from,
    valid_until = excluded.valid_until,
    revoked_at = null,
    revoked_by = null,
    updated_at = statement_timestamp();
  get diagnostics v_count = row_count;

  update exam_delivery.exam_entitlements e
  set enabled = false,
      revoked_at = case when v_assignment.assigned_by is not null
        then coalesce(e.revoked_at, statement_timestamp()) else null end,
      revoked_by = case when v_assignment.assigned_by is not null
        then coalesce(e.revoked_by, v_assignment.assigned_by) else null end,
      updated_at = statement_timestamp()
  where e.source_assignment_id = v_assignment.id
    and e.enabled
    and not exists (
      select 1
      from exam_delivery.package_versions pv
      join exam_delivery.package_profiles pp on pp.package_version_id = pv.id
      join exam_delivery.exam_profile_activations activation
        on activation.package_version_id = pv.id
       and activation.package_profile_id = pp.id
       and activation.activation_kind = 'production'
       and activation.enabled
      where pv.id = e.package_version_id
        and pp.id = e.package_profile_id
        and pv.status = 'published'
        and exam_delivery.normalize_exam_key(pv.exam_key) =
            exam_delivery.normalize_exam_key(v_assignment.exam_key)
        and (v_assignment.profile_id is null or pp.profile_key = v_assignment.profile_id)
    );

  return v_count;
exception when no_data_found then
  return 0;
end
$$;

-- Public trainer assignments are optional provenance on the normal protected
-- self-directed path. Validate the attribution server-side before availability
-- or mutation code can use it.
create function exam_delivery.validate_practice_assignment(
  p_actor_id uuid, p_exam_key text, p_profile_key text, p_assignment_id uuid
)
returns public.exam_assignments
language plpgsql stable security definer
set search_path = '' set statement_timeout = '5s'
as $$
declare v_assignment public.exam_assignments%rowtype;
begin
  select * into v_assignment from public.exam_assignments a
  where a.id = p_assignment_id and a.status = 'active'
    and (a.available_from is null or a.available_from <= statement_timestamp())
    and (a.due_at is null or a.due_at > statement_timestamp())
    and exam_delivery.normalize_exam_key(a.exam_key) = exam_delivery.normalize_exam_key(p_exam_key)
    and (nullif(a.profile_id, '') is null or a.profile_id = p_profile_key)
    and (a.student_user_id = p_actor_id or (a.student_user_id is null and a.group_id is not null
      and exists(select 1 from public.memberships m where m.user_id = p_actor_id
        and m.status = 'active' and m.role = 'student'
        and m.organisation_id = a.organisation_id and m.group_id = a.group_id
        and (a.campus_id is null or m.campus_id = a.campus_id))))
    and exists(select 1 from exam_delivery.exam_entitlements e
      join exam_delivery.package_versions pv on pv.id = e.package_version_id
      join exam_delivery.package_profiles pp on pp.id = e.package_profile_id
      where e.source_assignment_id = a.id and e.enabled and e.revoked_at is null
        and (e.valid_from is null or e.valid_from <= statement_timestamp())
        and (e.valid_until is null or e.valid_until > statement_timestamp())
        and exam_delivery.normalize_exam_key(pv.exam_key) = exam_delivery.normalize_exam_key(p_exam_key)
        and pp.profile_key = p_profile_key);
  if not found then raise exception 'assignment_conflict' using errcode = '42501'; end if;
  return v_assignment;
end
$$;

create or replace function exam_delivery.sync_exam_assignment_entitlements()
returns trigger
language plpgsql
security definer
set search_path = ''
set statement_timeout = '8s'
as $$
begin
  perform exam_delivery.reconcile_assignment_entitlements(new.id);
  return new;
end
$$;

create trigger sync_exam_assignment_entitlements
after insert or update of exam_key, profile_id, student_user_id, group_id,
  status, available_from, due_at
on public.exam_assignments
for each row execute function exam_delivery.sync_exam_assignment_entitlements();

create function exam_delivery.sync_profile_activation_assignments()
returns trigger
language plpgsql
security definer
set search_path = ''
set statement_timeout = '8s'
as $$
declare
  v_exam_key text;
  v_profile_key text;
  v_assignment_id uuid;
begin
  if new.activation_kind <> 'production' or not new.enabled
    or (tg_op = 'UPDATE' and old.activation_kind = 'production'
      and new.activation_kind = 'production' and old.enabled and new.enabled
      and old.package_version_id = new.package_version_id
      and old.package_profile_id = new.package_profile_id) then
    return new;
  end if;
  select exam_delivery.normalize_exam_key(pv.exam_key), pp.profile_key
    into strict v_exam_key, v_profile_key
  from exam_delivery.package_versions pv
  join exam_delivery.package_profiles pp
    on pp.package_version_id = pv.id and pp.id = new.package_profile_id
  where pv.id = new.package_version_id and pv.status = 'published';
  for v_assignment_id in
    select assignment.id from public.exam_assignments assignment
    where assignment.status = 'active'
      and (assignment.due_at is null or assignment.due_at > statement_timestamp())
      and exam_delivery.normalize_exam_key(assignment.exam_key) = v_exam_key
      and (nullif(assignment.profile_id, '') is null or assignment.profile_id = v_profile_key)
    order by assignment.id
  loop
    perform exam_delivery.reconcile_assignment_entitlements(v_assignment_id);
  end loop;
  return new;
exception when no_data_found then
  return new;
end
$$;

create trigger sync_profile_activation_assignments
after insert or update of enabled, package_version_id, package_profile_id, activation_kind
on exam_delivery.exam_profile_activations
for each row execute function exam_delivery.sync_profile_activation_assignments();

-- Backfill only current active assignments. Existing cutover rows are untouched.
do $$
declare v_id uuid;
begin
  for v_id in
    select id from public.exam_assignments
    where status = 'active' and (due_at is null or due_at > statement_timestamp())
    order by created_at, id
  loop
    perform exam_delivery.reconcile_assignment_entitlements(v_id);
  end loop;
end
$$;

create or replace function exam_delivery.has_purchase_profile_entitlement(
  p_actor_id uuid, p_package_version_id uuid, p_package_profile_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
  select exists(select 1 from public.profiles p
      where p.id = p_actor_id and p.status = 'active')
    and exists(select 1 from exam_delivery.exam_profile_activations a
      where a.package_version_id = p_package_version_id
        and a.package_profile_id = p_package_profile_id
        and a.activation_kind = 'production' and a.enabled)
    and exists(select 1 from exam_delivery.exam_entitlements e
      where e.learner_id = p_actor_id and e.target_type = 'learner'
        and e.package_version_id = p_package_version_id
        and e.package_profile_id = p_package_profile_id
        and e.entitlement_source in ('direct_exam_purchase','package_purchase')
        and e.enabled and e.revoked_at is null
        and (e.valid_from is null or e.valid_from <= statement_timestamp())
        and (e.valid_until is null or e.valid_until > statement_timestamp()))
$$;

create or replace function public.certsim_grant_purchase_entitlement(
  p_learner_id uuid, p_package_version_id uuid, p_package_profile_ids uuid[],
  p_entitlement_source text, p_purchase_reference text,
  p_valid_until timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '8s'
as $$
declare
  v_actor uuid := auth.uid();
  v_count integer;
  v_valid_until timestamptz := coalesce(
    p_valid_until, statement_timestamp() + interval '365 days'
  );
begin
  if v_actor is null or not exists(select 1 from public.memberships m
      where m.user_id = v_actor and m.status = 'active'
        and m.role in ('developer','platform_owner')) then
    raise exception 'purchase_entitlement_forbidden' using errcode = '42501';
  end if;
  if p_entitlement_source not in ('direct_exam_purchase','package_purchase')
    or p_purchase_reference !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$'
    or coalesce(cardinality(p_package_profile_ids), 0) = 0
    or v_valid_until <= statement_timestamp()
    or not exists(select 1 from public.profiles p
      where p.id = p_learner_id and p.status = 'active') then
    raise exception 'invalid_purchase_entitlement' using errcode = '22023';
  end if;
  if exists(select 1 from unnest(p_package_profile_ids) x(id)
      left join exam_delivery.package_profiles pp
        on pp.id = x.id and pp.package_version_id = p_package_version_id
      where pp.id is null) then
    raise exception 'purchase_profile_mismatch' using errcode = '22023';
  end if;
  insert into exam_delivery.exam_entitlements(
    package_version_id, package_profile_id, target_type, learner_id, enabled,
    valid_from, valid_until, reason_code, created_by, entitlement_source,
    purchase_reference
  )
  select p_package_version_id, x.id, 'learner', p_learner_id, true,
    statement_timestamp(), v_valid_until, 'purchase_fulfilment', v_actor,
    p_entitlement_source, p_purchase_reference
  from (select distinct id from unnest(p_package_profile_ids) t(id)) x;
  get diagnostics v_count = row_count;
  return jsonb_build_object('ok', true, 'entitlementsCreated', v_count,
    'validUntil', v_valid_until);
end
$$;

-- Package-scoped weak-domain evidence combines current protected assessments
-- with compatible pre-migration assessments. Legacy question identities and
-- answers are intentionally never read: only domain-level percentages cross
-- this bridge.
create function exam_delivery.learner_weak_domain_evidence(
  p_actor_id uuid, p_package_version_id uuid
)
returns table(domain_key text, evidence_count bigint, lowest_percentage numeric)
language sql stable security definer
set search_path = '' set statement_timeout = '8s'
as $$
  with package as (
    select exam_delivery.normalize_exam_key(pv.exam_key) exam_key
    from exam_delivery.package_versions pv where pv.id = p_package_version_id
  ), current_domains as (
    select domain.key domain_key,
      coalesce((domain.value->>'percentage')::numeric, 100) percentage
    from exam_delivery.attempts attempt
    join exam_delivery.attempt_results result on result.attempt_id = attempt.id
    cross join lateral jsonb_each(result.domain_summary) domain
    where attempt.owner_id = p_actor_id and attempt.status = 'completed'
      and attempt.analytics_eligible is true
      and attempt.purpose in ('assigned_assessment','self_directed_exam')
      and attempt.package_version_id = p_package_version_id
  ), legacy_domains as (
    select domain.key domain_key,
      coalesce((domain.value->>'percentage')::numeric, 100) percentage
    from public.exam_attempts attempt
    join public.exam_results result on result.attempt_id = attempt.id
    cross join package
    cross join lateral jsonb_each(coalesce(result.domain_breakdown, '{}'::jsonb)) domain
    where coalesce(result.user_id, attempt.user_id) = p_actor_id
      and attempt.status = 'submitted' and attempt.submitted_at is not null
      and exam_delivery.normalize_exam_key(coalesce(nullif(result.exam_key,''), attempt.exam_key)) = package.exam_key
      and exam_delivery.classify_legacy_result(attempt.profile_id, attempt.mode_label,
        attempt.attempt_snapshot, result.result_snapshot, attempt.status,
        attempt.submitted_at, result.raw_score, result.raw_percentage)
        in ('assigned_assessment','self_directed_exam')
      and not exists(select 1 from exam_delivery.attempts protected where protected.id = attempt.id)
  ), compatible as (
    select * from current_domains union all select * from legacy_domains
  )
  select compatible.domain_key, count(*) evidence_count, min(compatible.percentage) lowest_percentage
  from compatible
  where compatible.percentage < 70
  group by compatible.domain_key
$$;

alter function exam_delivery.learner_weak_domain_evidence(uuid,uuid) owner to postgres;
revoke execute on function exam_delivery.learner_weak_domain_evidence(uuid,uuid)
  from public, anon, authenticated, service_role;

-- Preserve the proven availability implementation and add only safe immutable
-- profile metadata needed by the protected presentation layer.
alter function exam_delivery.practice_availability(uuid, jsonb)
  rename to practice_availability_issue59_base;

create function exam_delivery.practice_availability(p_actor_id uuid, p_request jsonb)
returns jsonb
language sql
stable
security definer
set search_path = ''
set statement_timeout = '8s'
as $$
  with availability as (
    select exam_delivery.practice_availability_issue59_base(p_actor_id, p_request) value
  ), assignment_check as materialized (
    select 1 valid where nullif(p_request->>'assignmentId', '') is null
    union all
    select 1 from exam_delivery.validate_practice_assignment(
      p_actor_id, p_request->>'examKey', p_request->>'profileId',
      (p_request->>'assignmentId')::uuid
    ) where nullif(p_request->>'assignmentId', '') is not null
  ), profile as (
    select pv.id package_version_id, pp.id package_profile_id,
      pp.question_count, pp.time_limit_minutes, pp.selection_config
    from availability a
    join exam_delivery.package_versions pv
      on exam_delivery.normalize_exam_key(pv.exam_key) = a.value->>'examKey'
     and pv.package_version = a.value->>'packageVersion'
    join exam_delivery.package_profiles pp
      on pp.package_version_id = pv.id
     and pp.profile_key = a.value->>'profileKey'
  )
  select case
    when coalesce((a.value->>'ok')::boolean, false)
      and a.value->>'purpose' = 'weak_area'
      and weak.missed_count = 0
      and weak.weak_count = 0
    then jsonb_build_object('ok', false, 'code', 'no_weak_areas')
    when coalesce((a.value->>'ok')::boolean, false)
      and a.value->>'purpose' = 'weak_area'
      and (weak.weak_count > 0 or weak.missed_count > 0)
      and weak.available_count = 0
    then jsonb_build_object('ok', false, 'code', 'weak_domain_unavailable')
    when coalesce((a.value->>'ok')::boolean, false)
    then a.value || case when a.value->>'purpose' = 'weak_area' then jsonb_build_object(
      'available', weak.available_count,
      'selectedCount', least((a.value->>'selectedCount')::integer, weak.available_count),
      'adjustedCount', coalesce((a.value->>'adjustedCount')::boolean, false)
        or (a.value->>'selectedCount')::integer > weak.available_count
    ) else '{}'::jsonb end || jsonb_build_object('profileComposition', jsonb_build_object(
      'questionCount', p.question_count,
      'timeLimitMinutes', p.time_limit_minutes,
      'standardQuestionCount', coalesce(
        (p.selection_config->>'standardQuestionCount')::integer,
        (p.selection_config->>'normalScoredQuestionCount')::integer,
        p.question_count
          - coalesce((p.selection_config->>'pbqCount')::integer, 0)
      ),
      'caseStudyCount', coalesce((p.selection_config->>'caseStudyCount')::integer,
        coalesce((p.selection_config->>'longCaseStudyCount')::integer, 0)
          + coalesce((p.selection_config->>'shortCaseStudyCount')::integer, 0)),
      'caseStudyQuestionCount', greatest(0,
        p.question_count
          - coalesce(
              (p.selection_config->>'standardQuestionCount')::integer,
              (p.selection_config->>'normalScoredQuestionCount')::integer,
              p.question_count - coalesce((p.selection_config->>'pbqCount')::integer, 0)
            )
          - coalesce((p.selection_config->>'pbqCount')::integer, 0)
      ),
      'pbqCount', coalesce((p.selection_config->>'pbqCount')::integer, 0),
      'sectionOrder', p.selection_config->>'sectionOrder'
    )) else a.value end
  from availability a cross join assignment_check left join profile p on true
  cross join lateral (
    select count(*) weak_count,
      (select count(distinct reviewed->>'questionId')::integer
       from exam_delivery.attempts prior
       join exam_delivery.review_snapshots review on review.attempt_id = prior.id
       cross join lateral jsonb_array_elements(coalesce(review.review_payload->'items','[]'::jsonb)) reviewed
       join exam_delivery.package_questions question
         on question.package_version_id = p.package_version_id
        and question.question_id = reviewed->>'questionId'
        and question.domain_key = p_request->>'domain'
       where prior.owner_id = p_actor_id and prior.package_version_id = p.package_version_id
         and prior.status = 'completed'
         and prior.analytics_eligible is true
         and prior.purpose in ('assigned_assessment','self_directed_exam')
         and reviewed->>'status' in ('Incorrect','Incomplete','Partial')) missed_count,
      (select count(*)::integer from exam_delivery.package_questions question
       where question.package_version_id = p.package_version_id
         and question.domain_key = p_request->>'domain'
         and question.question_type <> 'case-study-context'
         and (coalesce((p_request->>'includePbqs')::boolean, false)
           or question.question_type not like 'pbq-%')) available_count
    from exam_delivery.learner_weak_domain_evidence(p_actor_id, p.package_version_id) evidence
    where evidence.domain_key = p_request->>'domain'
  ) weak
$$;

create function exam_delivery.apply_practice_assignment_attribution()
returns trigger language plpgsql security definer
set search_path = '' set statement_timeout = '5s'
as $$
declare v_assignment public.exam_assignments%rowtype; v_exam text; v_profile text;
begin
  if nullif(new.practice_configuration->>'assignmentId', '') is null then return new; end if;
  if new.purpose <> 'self_directed_exam' then
    raise exception 'assignment_conflict' using errcode = '42501';
  end if;
  select pv.exam_key, pp.profile_key into strict v_exam, v_profile
  from exam_delivery.package_versions pv
  join exam_delivery.package_profiles pp on pp.id = new.package_profile_id
  where pv.id = new.package_version_id and pp.package_version_id = pv.id;
  v_assignment := exam_delivery.validate_practice_assignment(
    new.owner_id, v_exam, v_profile,
    (new.practice_configuration->>'assignmentId')::uuid
  );
  new.source_assignment_id := v_assignment.id;
  new.source_organisation_id := v_assignment.organisation_id;
  new.source_campus_id := v_assignment.campus_id;
  new.source_group_id := v_assignment.group_id;
  new.attribution_source := 'assignment';
  return new;
exception when invalid_text_representation or no_data_found or too_many_rows then
  raise exception 'assignment_conflict' using errcode = '42501';
end
$$;

create trigger apply_practice_assignment_attribution
before insert on exam_delivery.attempts
for each row execute function exam_delivery.apply_practice_assignment_attribution();

-- Assigned self-directed attempts use the same deliberate replacement flow.
-- The requested assignment must remain valid and match the preserved source.
do $$
declare v_definition text; v_updated text;
begin
  v_definition := pg_get_functiondef(
    'exam_delivery.replace_current_practice_attempt(uuid,jsonb)'::regprocedure
  );
  v_updated := replace(v_definition,
    E'if v_existing.protected_assignment_id is not null or v_existing.source_assignment_id is not null\n    or v_existing.attribution_source=''assignment''\n    or exists',
    E'if (v_existing.source_assignment_id is null and nullif(p_request->>''assignmentId'','''') is not null)\n    or (v_existing.source_assignment_id is not null and (nullif(p_request->>''assignmentId'','''') is null\n      or v_existing.source_assignment_id<>(p_request->>''assignmentId'')::uuid))\n    or v_existing.protected_assignment_id is not null or exists');
  if v_updated = v_definition then raise exception 'issue59_assignment_replacement_contract_drift'; end if;
  execute v_updated;

  v_definition := pg_get_functiondef(
    'exam_delivery.list_current_attempt_bindings(uuid,text,text)'::regprocedure
  );
  v_updated := replace(v_definition, '''attemptId'',a.id,',
    '''attemptId'',a.id,''assignmentId'',a.source_assignment_id,');
  v_updated := replace(v_updated,
    E'    and a.source_assignment_id is null\n    and a.attribution_source is distinct from ''assignment''\n', '');
  if v_updated = v_definition then raise exception 'issue59_assignment_binding_contract_drift'; end if;
  execute v_updated;
end
$$;

-- The prior materializer is retained verbatim except for the fixed-purpose
-- branch predicates and the PBQ/case practice discriminator. Guarded textual
-- replacement makes migration drift fail before any function replacement.
create function exam_delivery.fixed_profile_case_keys(
  p_package_version_id uuid, p_request_id uuid, p_question_count integer,
  p_selection_config jsonb
)
returns text[] language plpgsql stable security definer
set search_path = '' set statement_timeout = '5s' as $$
declare
  v_long integer := coalesce((p_selection_config->>'longCaseStudyCount')::integer,0);
  v_short integer := coalesce((p_selection_config->>'shortCaseStudyCount')::integer,0);
  v_case_count integer := coalesce((p_selection_config->>'caseStudyCount')::integer,v_long+v_short,0);
  v_pbq integer := coalesce((p_selection_config->>'pbqCount')::integer,0);
  v_standard integer := coalesce((p_selection_config->>'normalScoredQuestionCount')::integer,
    (p_selection_config->>'standardQuestionCount')::integer,p_question_count-v_pbq);
  v_case_target integer := greatest(0,p_question_count-v_standard-v_pbq);
  v_keys text[];
  v_scored integer;
begin
  with contexts as (
    select pc.authoring_metadata#>>'{group,groupKey}' group_key,
      pc.authoring_metadata#>>'{group,groupSize}' group_size,
      (select count(*) from exam_delivery.package_questions member
       join exam_delivery.package_question_protected_content content on content.question_id=member.id
       where member.package_version_id=p_package_version_id
         and content.authoring_metadata#>>'{group,groupKey}'=pc.authoring_metadata#>>'{group,groupKey}'
         and coalesce((content.authoring_metadata->>'scored')::boolean,true)) scored_size
    from exam_delivery.package_questions q
    join exam_delivery.package_question_protected_content pc on pc.question_id=q.id
    where q.package_version_id=p_package_version_id
      and pc.authoring_metadata#>>'{group,role}'='context'
  ), ranked as (
    select *,row_number() over(partition by group_size
      order by md5(p_request_id::text||':'||group_key)) class_rank,
      row_number() over(partition by scored_size
      order by md5(p_request_id::text||':'||group_key)) size_rank
    from contexts
  ), chosen as (
    select group_key,1 class_order,class_rank rank_order from ranked
      where (v_long>0 or v_short>0) and group_size='long' and class_rank<=v_long
    union all
    select group_key,2,class_rank from ranked
      where (v_long>0 or v_short>0) and group_size='short' and class_rank<=v_short
    union all
    select group_key,3,size_rank from ranked
      where v_long=0 and v_short=0 and v_case_count>0
        and scored_size=v_case_target/v_case_count and size_rank<=v_case_count
  )
  select coalesce(array_agg(group_key order by class_order,rank_order),'{}') into v_keys from chosen;
  select count(*)::integer into v_scored
  from exam_delivery.package_questions member
  join exam_delivery.package_question_protected_content content on content.question_id=member.id
  where member.package_version_id=p_package_version_id
    and content.authoring_metadata#>>'{group,groupKey}'=any(v_keys)
    and coalesce((content.authoring_metadata->>'scored')::boolean,true);
  if cardinality(v_keys)<>v_case_count or v_scored<>v_case_target then
    raise exception 'selection_incomplete' using errcode='22023';
  end if;
  return v_keys;
end
$$;

do $$
declare
  v_definition text := pg_get_functiondef(
    'exam_delivery.materialize_attempt_items(uuid,uuid,integer)'::regprocedure
  );
  v_updated text;
  v_case_select integer;
  v_pbq_select integer;
begin
  if v_definition not like '%where v_attempt.purpose<>''assigned_assessment''%'
    or v_definition not like '%where v_attempt.purpose=''assigned_assessment''%'
    or v_definition not like '%(pbq or case_study)%' then
    raise exception 'issue59_materializer_contract_drift';
  end if;
  v_updated := replace(v_definition,
    'where v_attempt.purpose<>''assigned_assessment''%s    group by',
    'where v_attempt.purpose not in (''assigned_assessment'',''self_directed_exam'')%s    group by');
  -- PostgreSQL preserves line breaks in pg_get_functiondef; use regex for the
  -- three branch predicates while deliberately leaving AZ-204 language
  -- presentation logic unchanged for self-directed attempts.
  v_updated := regexp_replace(v_updated,
    'where v_attempt\.purpose<>''assigned_assessment''([[:space:]]+)group by',
    'where v_attempt.purpose not in (''assigned_assessment'',''self_directed_exam'')\1group by');
  v_updated := regexp_replace(v_updated,
    'where v_attempt\.purpose=''assigned_assessment''([[:space:]]+)union all',
    'where v_attempt.purpose in (''assigned_assessment'',''self_directed_exam'')\1union all');
  v_updated := regexp_replace(v_updated,
    'where v_attempt\.purpose<>''assigned_assessment''([[:space:]]+)\), ordered',
    'where v_attempt.purpose not in (''assigned_assessment'',''self_directed_exam'')\1), ordered');
  v_updated := regexp_replace(v_updated,
    'if v_attempt\.purpose=''assigned_assessment'' and',
    'if v_attempt.purpose in (''assigned_assessment'',''self_directed_exam'') and');
  v_updated := regexp_replace(v_updated,
    'if v_attempt\.purpose<>''assigned_assessment'' and not exists',
    'if v_attempt.purpose not in (''assigned_assessment'',''self_directed_exam'') and not exists');
  v_updated := replace(v_updated, '(v_attempt.purpose=''pbq_practice'' and (pbq or case_study))',
    '(v_attempt.purpose=''pbq_practice'' and case coalesce(v_attempt.practice_configuration->>''contentKind'',''pbq'') when ''case-study'' then case_study else pbq end)');
  v_case_select := strpos(v_updated,'select coalesce(array_agg(group_key), ''{}'') into v_case_keys');
  v_pbq_select := strpos(substr(v_updated,v_case_select+1),'select coalesce(array_agg(group_key), ''{}'') into v_pbq_keys');
  if v_case_select=0 or v_pbq_select=0 then raise exception 'issue59_case_selector_contract_drift'; end if;
  v_pbq_select := v_case_select+v_pbq_select;
  v_updated := substr(v_updated,1,v_case_select-1)
    || 'v_case_keys := exam_delivery.fixed_profile_case_keys(v_attempt.package_version_id,p_request_id,v_attempt.question_count,v_attempt.selection_config);' || chr(10) || '  '
    || substr(v_updated,v_pbq_select);
  if v_updated = v_definition then
    raise exception 'issue59_materializer_not_changed';
  end if;
  execute v_updated;
end
$$;

create or replace function exam_delivery.abandon_attempt(
  p_actor_id uuid, p_attempt_id uuid, p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare v_now timestamptz := statement_timestamp();
begin
  if p_actor_id is null or p_attempt_id is null or p_request_id is null then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_attempt_id::text, 0));
  update exam_delivery.attempts
  set status = 'abandoned', submitted_at = null, completed_at = null
  where id = p_attempt_id and owner_id = p_actor_id and status = 'in_progress';
  if not found then
    return jsonb_build_object('ok', false, 'code', 'attempt_not_found');
  end if;
  return jsonb_build_object('ok', true, 'attemptId', p_attempt_id,
    'status', 'abandoned', 'abandonedAt', v_now);
end
$$;

create function public.certsim_protected_abandon_attempt(
  p_actor_id uuid, p_attempt_id uuid, p_request_id uuid
)
returns jsonb language sql security invoker set search_path = '' as $$
  select exam_delivery.abandon_attempt(p_actor_id, p_attempt_id, p_request_id)
$$;

-- Enable only the established protected practice purposes for currently active
-- production profiles. Access still requires can_use_profile authorization.
insert into exam_delivery.practice_policies(
  canonical_exam_key, package_version, profile_key, purpose, access_mode,
  enabled, maximum_completed_attempts, cooldown_seconds,
  maximum_concurrent_sessions, maximum_session_items, immediate_feedback,
  review_release_policy, answer_release_policy
)
select exam_delivery.normalize_exam_key(pv.exam_key), pv.package_version,
  pp.profile_key, purpose.value::exam_delivery.attempt_purpose,
  'production_authorized', true, null, 0, 1,
  greatest(10, least(100, pp.question_count)),
  purpose.value = 'study_sandbox',
  case when purpose.value = 'study_sandbox' then 'immediate_study_feedback'
    else 'after_submission' end,
  case when purpose.value = 'study_sandbox' then 'immediate_study_feedback'
    else 'after_submission' end
from exam_delivery.package_versions pv
join exam_delivery.package_profiles pp on pp.package_version_id = pv.id
join exam_delivery.exam_profile_activations activation
  on activation.package_version_id = pv.id
 and activation.package_profile_id = pp.id
 and activation.activation_kind = 'production' and activation.enabled
cross join (values ('study_sandbox'),('targeted_domain'),('weak_area'),('pbq_practice')) purpose(value)
where pv.status = 'published'
on conflict (canonical_exam_key, package_version, profile_key, purpose)
do update set access_mode = excluded.access_mode, enabled = true,
  maximum_completed_attempts = null, cooldown_seconds = 0,
  maximum_session_items = excluded.maximum_session_items,
  immediate_feedback = excluded.immediate_feedback,
  review_release_policy = excluded.review_release_policy,
  answer_release_policy = excluded.answer_release_policy,
  updated_at = statement_timestamp();

alter function exam_delivery.normalize_exam_key(text) owner to postgres;
alter function exam_delivery.reconcile_assignment_entitlements(uuid) owner to postgres;
alter function exam_delivery.sync_exam_assignment_entitlements() owner to postgres;
alter function exam_delivery.sync_profile_activation_assignments() owner to postgres;
alter function exam_delivery.validate_practice_assignment(uuid,text,text,uuid) owner to postgres;
alter function exam_delivery.apply_practice_assignment_attribution() owner to postgres;
alter function exam_delivery.fixed_profile_case_keys(uuid,uuid,integer,jsonb) owner to postgres;
alter function exam_delivery.practice_availability_issue59_base(uuid,jsonb) owner to postgres;
alter function exam_delivery.practice_availability(uuid,jsonb) owner to postgres;
alter function exam_delivery.has_purchase_profile_entitlement(uuid,uuid,uuid) owner to postgres;
alter function public.certsim_grant_purchase_entitlement(uuid,uuid,uuid[],text,text,timestamptz) owner to postgres;
alter function exam_delivery.abandon_attempt(uuid,uuid,uuid) owner to postgres;
alter function public.certsim_protected_abandon_attempt(uuid,uuid,uuid) owner to postgres;

revoke execute on function exam_delivery.reconcile_assignment_entitlements(uuid),
  exam_delivery.sync_exam_assignment_entitlements(),
  exam_delivery.sync_profile_activation_assignments(),
  exam_delivery.validate_practice_assignment(uuid,text,text,uuid),
  exam_delivery.apply_practice_assignment_attribution(),
  exam_delivery.fixed_profile_case_keys(uuid,uuid,integer,jsonb),
  exam_delivery.practice_availability_issue59_base(uuid,jsonb),
  exam_delivery.practice_availability(uuid,jsonb),
  exam_delivery.has_purchase_profile_entitlement(uuid,uuid,uuid),
  exam_delivery.abandon_attempt(uuid,uuid,uuid)
from public, anon, authenticated, service_role;
grant execute on function exam_delivery.practice_availability(uuid,jsonb),
  exam_delivery.has_purchase_profile_entitlement(uuid,uuid,uuid),
  exam_delivery.abandon_attempt(uuid,uuid,uuid)
to service_role;
revoke execute on function public.certsim_grant_purchase_entitlement(uuid,uuid,uuid[],text,text,timestamptz),
  public.certsim_protected_abandon_attempt(uuid,uuid,uuid)
from public, anon, authenticated, service_role;
grant execute on function public.certsim_protected_abandon_attempt(uuid,uuid,uuid)
to service_role;
grant execute on function public.certsim_grant_purchase_entitlement(uuid,uuid,uuid[],text,text,timestamptz)
  to authenticated;

alter function public.get_my_report_statuses()
  rename to get_my_report_statuses_issue59_base;

create function public.get_my_report_statuses()
returns table (
  id uuid, source text, report_type text, title text, message text,
  status text, priority text, reporter_feedback text, route_path text,
  exam_key text, exam_title text, question_id text, question_type text,
  attempt_id uuid, result_id uuid, created_at timestamptz,
  updated_at timestamptz, resolved_at timestamptz
)
language sql
stable
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
  select * from (
    select * from public.get_my_report_statuses_issue59_base()
    union all
    select report.id, 'protected_question_reports'::text,
      'question_issue'::text, 'Protected question report'::text,
      report.message, report.status, 'normal'::text, null::text,
      null::text, exam_delivery.normalize_exam_key(pv.exam_key),
      null::text, question.question_id, question.question_type, report.attempt_id,
      null::uuid, report.created_at, report.created_at,
      case when report.status in ('resolved','dismissed') then report.created_at end
    from exam_delivery.question_issue_reports report
    join exam_delivery.attempts attempt on attempt.id = report.attempt_id
    join exam_delivery.package_versions pv on pv.id = attempt.package_version_id
    join exam_delivery.attempt_items item on item.id = report.attempt_item_id
      and item.attempt_id = report.attempt_id
    join exam_delivery.package_questions question on question.id = item.package_question_id
      and question.package_version_id = item.package_version_id
    where report.owner_id = auth.uid()
  ) report_statuses
  order by created_at desc
  limit 100
$$;

alter function public.get_my_report_statuses_issue59_base() owner to postgres;
alter function public.get_my_report_statuses() owner to postgres;
revoke execute on function public.get_my_report_statuses_issue59_base()
from public, anon, authenticated, service_role;
revoke execute on function public.get_my_report_statuses()
from public, anon, authenticated, service_role;
grant execute on function public.get_my_report_statuses() to authenticated;

create or replace function exam_delivery.list_history(
  p_actor_id uuid, p_exam_key text, p_cursor text, p_page_size integer
)
returns jsonb language sql stable security definer
set search_path = '' set statement_timeout = '8s' as $$
with all_rows as (
  select a.id attempt_id,a.source_assignment_id assignment_id,a.completed_at,2 source_order,
    pv.exam_key,pv.package_version,pp.profile_key,a.purpose::text purpose,
    a.actor_classification,r.raw_score,r.raw_percentage,r.passed,r.domain_summary,
    coalesce(rs.release_status::text,'withheld') review_status,
    true server_authoritative,'protected' source
  from exam_delivery.attempts a
  join exam_delivery.package_versions pv on pv.id=a.package_version_id
  join exam_delivery.package_profiles pp on pp.id=a.package_profile_id
  join exam_delivery.attempt_results r on r.attempt_id=a.id
  left join exam_delivery.review_snapshots rs on rs.attempt_id=a.id
  where a.owner_id=p_actor_id and a.status='completed'
  union all
  select a.id,null::uuid,a.submitted_at,1,a.exam_key,coalesce(a.exam_version,'legacy'),a.profile_id,
    exam_delivery.classify_legacy_result(a.profile_id,a.mode_label,a.attempt_snapshot,
      r.result_snapshot,a.status,a.submitted_at,r.raw_score,r.raw_percentage),
    null,r.raw_score,r.raw_percentage,r.passed,coalesce(r.domain_breakdown,'{}'::jsonb),
    'withheld',false,'legacy_authoritative'
  from public.exam_attempts a
  join public.exam_results r on r.attempt_id=a.id and r.user_id=p_actor_id
  where a.user_id=p_actor_id and a.status='submitted' and a.submitted_at is not null
    and not exists(select 1 from exam_delivery.attempts protected where protected.id=a.id)
), filtered as (
  select * from all_rows where p_exam_key is null
    or exam_delivery.normalize_exam_key(exam_key)=exam_delivery.normalize_exam_key(p_exam_key)
), eligible as (
  select * from filtered where p_cursor is null or (completed_at,attempt_id,source_order)<
    (split_part(p_cursor,'|',1)::timestamptz,split_part(p_cursor,'|',2)::uuid,split_part(p_cursor,'|',3)::integer)
  order by completed_at desc,attempt_id desc,source_order desc
), bounded as (select * from eligible limit least(greatest(p_page_size,1),50)+1),
page as (select * from bounded limit least(greatest(p_page_size,1),50))
select jsonb_build_object('ok',true,'items',coalesce((select jsonb_agg(jsonb_build_object(
  'attemptId',attempt_id,'assignmentId',assignment_id,'examKey',exam_key,
  'packageVersion',package_version,'profileKey',profile_key,'purpose',purpose,
  'actorClassification',actor_classification,'completedAt',completed_at,'score',raw_score,
  'percentage',raw_percentage,'passed',passed,'domainSummary',domain_summary,
  'serverAuthoritative',server_authoritative,'reviewStatus',review_status,'source',source)
  order by completed_at desc,attempt_id desc,source_order desc) from page),'[]'::jsonb),
  'returnedCount',(select count(*) from page),'totalCount',(select count(*) from filtered),
  'remainingCount',greatest((select count(*) from eligible)-(select count(*) from page),0),
  'nextCursor',case when (select count(*) from bounded)>least(greatest(p_page_size,1),50)
    then (select completed_at::text||'|'||attempt_id::text||'|'||source_order::text
      from page order by completed_at,attempt_id,source_order limit 1) else null end)
$$;

create function exam_delivery.staff_dashboard_aggregates(
  p_actor_id uuid, p_request jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '12s'
as $$
declare
  v_options jsonb;
  v_role text;
  v_org uuid;
  v_campus uuid;
  v_group uuid;
  v_assignment uuid;
  v_exam text := nullif(trim(p_request->>'examKey'), '');
  v_search text := lower(nullif(trim(p_request->>'search'), ''));
  v_status text := nullif(p_request->>'resultStatus', '');
begin
  v_options := exam_delivery.staff_scope_options(
    p_actor_id, jsonb_build_object('organisationId', p_request->>'organisationId')
  );
  if v_options->>'ok' <> 'true' then return v_options; end if;
  v_role := v_options->>'role';
  v_org := nullif(v_options#>>'{selection,organisationId}', '')::uuid;
  begin
    v_campus := nullif(p_request->>'campusId', '')::uuid;
    v_group := nullif(p_request->>'groupId', '')::uuid;
    v_assignment := nullif(p_request->>'assignmentId', '')::uuid;
  exception when others then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end;
  if v_org is null then return jsonb_build_object('ok', false, 'code', 'scope_required'); end if;
  if v_assignment is not null and not exists (
    select 1 from jsonb_array_elements(v_options->'assignments') item
    where item->>'id' = v_assignment::text
  ) then return jsonb_build_object('ok', false, 'code', 'scope_forbidden'); end if;

  return (
    with assignment_scope as materialized (
      select a.* from public.exam_assignments a
      where a.id = v_assignment
    ), visible_learners as materialized (
      select distinct m.user_id learner_id, m.group_id, p.display_name,
        p.full_name, p.email
      from public.memberships m join public.profiles p on p.id = m.user_id
      where m.status = 'active' and m.role = 'student'
        and m.organisation_id = v_org
        and (v_campus is null or m.campus_id = v_campus)
        and (v_group is null or m.group_id = v_group)
        and (v_assignment is null or exists (
          select 1 from assignment_scope assignment
          where assignment.student_user_id = m.user_id
             or (assignment.student_user_id is null and assignment.group_id = m.group_id)
        ))
        and (v_role <> 'campus_admin' or exists(select 1 from public.memberships staff
          where staff.user_id = p_actor_id and staff.status = 'active'
            and staff.role = 'campus_admin' and staff.campus_id = m.campus_id))
        and (v_role <> 'trainer' or exists(select 1 from public.memberships staff
          where staff.user_id = p_actor_id and staff.status = 'active'
            and staff.role = 'trainer' and staff.group_id = m.group_id))
    ), all_rows as materialized (
      select attempt.id attempt_id, attempt.owner_id learner_id,
        exam_delivery.normalize_exam_key(pv.exam_key) exam_key,
        attempt.completed_at, result.raw_percentage, result.passed,
        result.domain_summary, attempt.source_assignment_id,
        'protected'::text source
      from exam_delivery.attempts attempt
      join visible_learners learner on learner.learner_id = attempt.owner_id
      join exam_delivery.attempt_results result on result.attempt_id = attempt.id
      join exam_delivery.package_versions pv on pv.id = attempt.package_version_id
      where attempt.status = 'completed' and attempt.analytics_eligible
        and attempt.purpose in ('assigned_assessment','self_directed_exam')
        and (v_exam is null or exam_delivery.normalize_exam_key(pv.exam_key) =
          exam_delivery.normalize_exam_key(v_exam))
        and (v_assignment is null or attempt.source_assignment_id = v_assignment
          or (attempt.source_assignment_id is null and exists (
            select 1 from assignment_scope assignment
            where exam_delivery.normalize_exam_key(assignment.exam_key) =
                  exam_delivery.normalize_exam_key(pv.exam_key)
              and attempt.completed_at >= coalesce(assignment.available_from, assignment.created_at)
              and (assignment.due_at is null or attempt.completed_at <= assignment.due_at)
              and (select count(*) from public.exam_assignments candidate
                where candidate.organisation_id=v_org
                  and exam_delivery.normalize_exam_key(candidate.exam_key)=exam_delivery.normalize_exam_key(pv.exam_key)
                  and (candidate.student_user_id=attempt.owner_id or
                    (candidate.student_user_id is null and exists(select 1 from public.memberships candidate_membership
                      where candidate_membership.user_id=attempt.owner_id
                        and candidate_membership.group_id=candidate.group_id
                        and candidate_membership.status='active' and candidate_membership.role='student')))
                  and attempt.completed_at>=coalesce(candidate.available_from,candidate.created_at)
                  and (candidate.due_at is null or attempt.completed_at<=candidate.due_at))=1
          )))
      union all
      select attempt.id attempt_id, attempt.user_id,
        exam_delivery.normalize_exam_key(attempt.exam_key), attempt.submitted_at,
        result.raw_percentage, result.passed, coalesce(result.domain_breakdown,'{}'::jsonb),
        null::uuid, 'legacy_authoritative'
      from public.exam_attempts attempt
      join visible_learners learner on learner.learner_id = attempt.user_id
      join public.exam_results result
        on result.attempt_id = attempt.id and result.user_id = attempt.user_id
      cross join lateral (select exam_delivery.classify_legacy_result(
        attempt.profile_id, attempt.mode_label, attempt.attempt_snapshot,
        result.result_snapshot, attempt.status, attempt.submitted_at,
        result.raw_score, result.raw_percentage
      ) purpose) classified
      where attempt.status = 'submitted' and attempt.submitted_at is not null
        and classified.purpose in ('assigned_assessment','self_directed_exam')
        and not exists(select 1 from exam_delivery.attempts protected where protected.id = attempt.id)
        and (v_exam is null or exam_delivery.normalize_exam_key(attempt.exam_key) =
          exam_delivery.normalize_exam_key(v_exam))
        and (v_assignment is null or exists (
          select 1 from assignment_scope assignment
          where exam_delivery.normalize_exam_key(assignment.exam_key) =
                exam_delivery.normalize_exam_key(attempt.exam_key)
            and attempt.submitted_at >= coalesce(assignment.available_from, assignment.created_at)
            and (assignment.due_at is null or attempt.submitted_at <= assignment.due_at)
            and (select count(*) from public.exam_assignments candidate
              where candidate.organisation_id=v_org
                and exam_delivery.normalize_exam_key(candidate.exam_key)=exam_delivery.normalize_exam_key(attempt.exam_key)
                and (candidate.student_user_id=attempt.user_id or
                  (candidate.student_user_id is null and exists(select 1 from public.memberships candidate_membership
                    where candidate_membership.user_id=attempt.user_id
                      and candidate_membership.group_id=candidate.group_id
                      and candidate_membership.status='active' and candidate_membership.role='student')))
                and attempt.submitted_at>=coalesce(candidate.available_from,candidate.created_at)
                and (candidate.due_at is null or attempt.submitted_at<=candidate.due_at))=1
        ))
    ), filtered as materialized (
      select row.* from all_rows row
      join visible_learners learner on learner.learner_id = row.learner_id
      where (v_status is null
        or (v_status = 'passed' and row.passed is true)
        or (v_status = 'needs-review' and row.passed is false)
        or (v_status = 'not-recorded' and row.passed is null))
        and (v_search is null or lower(coalesce(learner.display_name, '')) like '%'||v_search||'%'
          or lower(coalesce(learner.full_name, '')) like '%'||v_search||'%'
          or lower(coalesce(learner.email, '')) like '%'||v_search||'%'
          or lower(row.exam_key) like '%'||v_search||'%')
    ), learner_domain_rows as (
      select row.learner_id, row.exam_key, domain.key domain_key,
        count(*) sample_count,
        case
          when sum(coalesce((domain.value->>'maxPoints')::numeric, 0)) > 0
          then sum(coalesce((domain.value->>'earnedPoints')::numeric, 0)) * 100.0
            / sum(coalesce((domain.value->>'maxPoints')::numeric, 0))
          else avg((domain.value->>'percentage')::numeric)
        end average_percentage
      from filtered row cross join lateral jsonb_each(row.domain_summary) domain
      where domain.value ? 'percentage'
      group by row.learner_id, row.exam_key, domain.key
    ), assignment_targets as materialized (
      select assignment.id assignment_id, assignment.exam_key, assignment.due_at,
        learner.learner_id
      from public.exam_assignments assignment
      join visible_learners learner on assignment.student_user_id=learner.learner_id
        or (assignment.student_user_id is null and assignment.group_id=learner.group_id)
      where assignment.organisation_id=v_org and assignment.status not in ('archived','closed')
        and (v_campus is null or assignment.campus_id=v_campus)
        and (v_group is null or assignment.group_id=v_group)
        and (v_assignment is null or assignment.id=v_assignment)
        and (v_exam is null or exam_delivery.normalize_exam_key(assignment.exam_key)=exam_delivery.normalize_exam_key(v_exam))
    ), learner_scopes as materialized (
      select distinct learner_id,exam_key from filtered
      union
      select distinct learner_id,exam_delivery.normalize_exam_key(exam_key) from assignment_targets
    ), learner_rows as (
      select scope.learner_id, scope.exam_key, count(row.attempt_id) activity_count,
        count(row.attempt_id) assessment_count,
        count(*) filter(where source = 'legacy_authoritative') historical_count,
        max(completed_at) latest_activity, max(raw_percentage) best_percentage,
        min(raw_percentage) lowest_percentage, avg(raw_percentage) average_percentage,
        (array_agg(raw_percentage order by completed_at desc))[1] latest_percentage,
        (array_agg(row.attempt_id order by completed_at desc) filter(where row.attempt_id is not null))[1] latest_attempt_id,
        count(*) filter(where passed) passed_count,
        count(*) filter(where passed is not null) decided_count,
        count(*) filter(where passed is false) needs_review_count
      from learner_scopes scope left join filtered row
        on row.learner_id=scope.learner_id and row.exam_key=scope.exam_key
      group by scope.learner_id, scope.exam_key
    ), exam_rows as (
      select exam_key, count(*) activity_count, count(*) assessment_count,
        count(*) filter(where source = 'legacy_authoritative') historical_count,
        count(distinct learner_id) assessed_learner_count,
        max(completed_at) latest_activity, max(raw_percentage) best_percentage,
        min(raw_percentage) lowest_percentage, avg(raw_percentage) average_percentage,
        count(*) filter(where passed) passed_count,
        count(*) filter(where passed is not null) decided_count,
        count(*) filter(where passed is false or raw_percentage < 75) needs_review_count
      from filtered group by exam_key
    ), group_domain_rows as (
      select learner.group_id, row.exam_key, domain.key domain_key,
        count(*) sample_count,
        count(distinct row.learner_id) filter (
          where (domain.value->>'percentage')::numeric < 70
        ) student_count,
        count(*) filter (where (domain.value->>'percentage')::numeric < 70) weak_count,
        avg((domain.value->>'percentage')::numeric) average_percentage
      from filtered row
      join visible_learners learner on learner.learner_id=row.learner_id
      cross join lateral jsonb_each(row.domain_summary) domain
      where domain.value ? 'percentage'
      group by learner.group_id, row.exam_key, domain.key
    ), group_rows as (
      select learner.group_id, count(*) assessment_count,
        count(distinct row.learner_id) assessed_learner_count,
        avg(row.raw_percentage) average_percentage,
        count(*) filter(where row.passed) passed_count,
        count(*) filter(where row.passed is not null) decided_count
      from filtered row join visible_learners learner on learner.learner_id=row.learner_id
      group by learner.group_id
    ), assignment_learner_rows as (
      select target.assignment_id,target.learner_id,
        count(row.attempt_id) assignment_attempt_count,
        max(row.completed_at) latest_assignment_activity,
        (array_agg(row.attempt_id order by row.completed_at desc)
          filter(where row.attempt_id is not null))[1] latest_assignment_attempt_id
      from assignment_targets target
      left join filtered row on row.learner_id=target.learner_id
        and row.exam_key=exam_delivery.normalize_exam_key(target.exam_key)
        and (row.source_assignment_id=target.assignment_id or (row.source_assignment_id is null
          and (select count(*) from assignment_targets candidate
            where candidate.learner_id=row.learner_id
              and exam_delivery.normalize_exam_key(candidate.exam_key)=row.exam_key
              and row.completed_at>=coalesce((select available_from from public.exam_assignments where id=candidate.assignment_id),
                (select created_at from public.exam_assignments where id=candidate.assignment_id))
              and ((select due_at from public.exam_assignments where id=candidate.assignment_id) is null
                or row.completed_at<=(select due_at from public.exam_assignments where id=candidate.assignment_id)))=1
          and row.completed_at>=coalesce((select available_from from public.exam_assignments where id=target.assignment_id),
            (select created_at from public.exam_assignments where id=target.assignment_id))
          and (target.due_at is null or row.completed_at<=target.due_at)))
      group by target.assignment_id,target.learner_id
    ), assignment_rows as (
      select assignment.id assignment_id, assignment.exam_key, assignment.group_id,
        assignment.due_at, (select count(distinct target.learner_id)
          from assignment_targets target where target.assignment_id=assignment.id) total_students,
        count(row.learner_id) assessment_count,
        count(distinct row.learner_id) assessed_learner_count,
        avg(row.raw_percentage) average_percentage,
        count(*) filter(where row.passed) passed_count,
        count(*) filter(where row.passed is not null) decided_count,
        count(*) filter(where row.passed is false) needs_review_count
      from public.exam_assignments assignment
      left join filtered row on row.source_assignment_id=assignment.id
        or (row.source_assignment_id is null
          and exam_delivery.normalize_exam_key(assignment.exam_key)=row.exam_key
          and (assignment.student_user_id=row.learner_id or
            (assignment.student_user_id is null and exists (
              select 1 from public.memberships target_membership
              where target_membership.user_id=row.learner_id
                and target_membership.group_id=assignment.group_id
                and target_membership.status='active' and target_membership.role='student'
            )))
          and row.completed_at>=coalesce(assignment.available_from,assignment.created_at)
          and (assignment.due_at is null or row.completed_at<=assignment.due_at)
          and (select count(*) from public.exam_assignments candidate
            where candidate.organisation_id=v_org
              and exam_delivery.normalize_exam_key(candidate.exam_key)=row.exam_key
              and (candidate.student_user_id=row.learner_id or
                (candidate.student_user_id is null and exists (
                  select 1 from public.memberships candidate_membership
                  where candidate_membership.user_id=row.learner_id
                    and candidate_membership.group_id=candidate.group_id
                    and candidate_membership.status='active' and candidate_membership.role='student'
                )))
              and row.completed_at>=coalesce(candidate.available_from,candidate.created_at)
              and (candidate.due_at is null or row.completed_at<=candidate.due_at))=1)
      where assignment.organisation_id=v_org
        and (v_campus is null or assignment.campus_id=v_campus)
        and (v_group is null or assignment.group_id=v_group)
        and (v_assignment is null or assignment.id=v_assignment)
      group by assignment.id,assignment.exam_key,assignment.group_id,assignment.due_at
    ), domain_rows as (
      select row.exam_key, domain.key domain_key, count(*) sample_count,
        count(*) filter(where (domain.value->>'percentage')::numeric < 70) weak_count,
        count(distinct row.learner_id) filter(
          where (domain.value->>'percentage')::numeric < 70
        ) student_count,
        avg((domain.value->>'percentage')::numeric) average_percentage
      from filtered row cross join lateral jsonb_each(row.domain_summary) domain
      where domain.value ? 'percentage'
      group by row.exam_key, domain.key
    )
    select jsonb_build_object('ok', true, 'scopeComplete', true,
      'totals', jsonb_build_object(
        'visibleLearners', (select count(*) from visible_learners),
        'learnersWithActivity', (select count(distinct learner_id) from learner_rows where activity_count > 0),
        'learnersWithoutActivity', greatest(0,(select count(*) from visible_learners) -
          (select count(distinct learner_id) from learner_rows where activity_count > 0)),
        'historicalActivity', (select count(*) from filtered),
        'protectedAssessments', (select count(*) from filtered where source = 'protected'),
        'legacyHistorical', (select count(*) from filtered where source = 'legacy_authoritative')
      ),
      'learners', coalesce((select jsonb_agg(jsonb_build_object(
        'learnerId', learner_id, 'examKey', exam_key, 'activityCount', activity_count,
        'assessmentCount', assessment_count, 'historicalCount', historical_count,
        'assessedLearnerCount', 1, 'needsReviewCount', needs_review_count,
        'latestActivity', latest_activity, 'latestAttemptId', latest_attempt_id,
        'bestPercentage', best_percentage,
        'latestPercentage', latest_percentage, 'lowestPercentage', lowest_percentage, 'averagePercentage', average_percentage,
        'passedCount', passed_count,
        'domains', coalesce((select jsonb_agg(jsonb_build_object(
          'domainKey', domain_key, 'averagePercentage', average_percentage,
          'sampleCount', sample_count
        ) order by domain_key) from learner_domain_rows d
          where d.learner_id=learner_rows.learner_id
            and d.exam_key=learner_rows.exam_key), '[]'::jsonb),
        'passRate', case when decided_count > 0 then passed_count*100.0/decided_count end
      ) order by learner_id) from learner_rows), '[]'::jsonb),
      'exams', coalesce((select jsonb_agg(jsonb_build_object(
        'examKey', exam_key, 'activityCount', activity_count,
        'assessmentCount', assessment_count, 'historicalCount', historical_count,
        'assessedLearnerCount', assessed_learner_count,
        'needsReviewCount', needs_review_count, 'passedCount', passed_count, 'latestActivity', latest_activity,
        'bestPercentage', best_percentage, 'lowestPercentage', lowest_percentage,
        'averagePercentage', average_percentage,
        'passRate', case when decided_count > 0 then passed_count*100.0/decided_count end
      ) order by exam_key) from exam_rows), '[]'::jsonb),
      'groups', coalesce((select jsonb_agg(jsonb_build_object(
        'groupId',group_id,'assessmentCount',assessment_count,
        'assessedLearnerCount',assessed_learner_count,'averagePercentage',average_percentage,
        'passRate',case when decided_count>0 then passed_count*100.0/decided_count end,
        'domains', coalesce((select jsonb_agg(jsonb_build_object(
          'examKey', exam_key, 'domainKey', domain_key,
          'sampleCount', sample_count, 'studentCount', student_count,
          'weakCount', weak_count, 'averagePercentage', average_percentage
        ) order by exam_key, domain_key) from group_domain_rows d
          where d.group_id=group_rows.group_id), '[]'::jsonb)
      ) order by group_id) from group_rows), '[]'::jsonb),
      'assignments', coalesce((select jsonb_agg(jsonb_build_object(
        'assignmentId',assignment_id,'examKey',exam_key,'groupId',group_id,
        'dueAt',due_at,'totalStudents',total_students,'assessmentCount',assessment_count,
        'assessedLearnerCount',assessed_learner_count,'averagePercentage',average_percentage,
        'needsReviewCount',needs_review_count,
        'passRate',case when decided_count>0 then passed_count*100.0/decided_count end
      ) order by assignment_id) from assignment_rows), '[]'::jsonb),
      'assignmentLearners', coalesce((select jsonb_agg(jsonb_build_object(
        'assignmentId',assignment_id,'learnerId',learner_id,
        'assignmentAttemptCount',assignment_attempt_count,
        'latestAssignmentActivity',latest_assignment_activity,
        'latestAssignmentAttemptId',latest_assignment_attempt_id
      ) order by assignment_id,learner_id) from assignment_learner_rows),'[]'::jsonb),
      'domains', coalesce((select jsonb_agg(jsonb_build_object(
        'examKey',exam_key,'domainKey',domain_key,'sampleCount',sample_count,
        'studentCount',student_count,'weakCount',weak_count,
        'averagePercentage',average_percentage
      ) order by exam_key,domain_key) from domain_rows), '[]'::jsonb)
    )
  );
end
$$;

alter function exam_delivery.staff_dashboard_query(uuid,jsonb)
  rename to staff_dashboard_query_issue59_base;

-- Keep explicit assignment provenance authoritative. For historical rows that
-- predate attribution, include a result only when exactly one visible
-- assignment can claim the same learner/exam/time window. The returned row
-- intentionally retains assignmentId=null.
do $$
declare
  v_definition text := pg_get_functiondef(
    'exam_delivery.staff_dashboard_query_issue59_base(uuid,jsonb)'::regprocedure
  );
  v_updated text;
begin
  v_updated := replace(v_definition,
    '(v_assignment is null or a.source_assignment_id=v_assignment)',
    '(v_assignment is null or a.source_assignment_id=v_assignment or (a.source_assignment_id is null and exists (
      select 1 from public.exam_assignments selected_assignment
      where selected_assignment.id=v_assignment
        and exam_delivery.normalize_exam_key(selected_assignment.exam_key)=exam_delivery.normalize_exam_key(pv.exam_key)
        and (selected_assignment.student_user_id=a.owner_id or (selected_assignment.student_user_id is null and exists (
          select 1 from public.memberships target where target.user_id=a.owner_id
            and target.group_id=selected_assignment.group_id and target.status=''active'' and target.role=''student'')))
        and a.completed_at>=coalesce(selected_assignment.available_from,selected_assignment.created_at)
        and (selected_assignment.due_at is null or a.completed_at<=selected_assignment.due_at)
        and (select count(*) from public.exam_assignments candidate
          where candidate.organisation_id=selected_assignment.organisation_id
            and exam_delivery.normalize_exam_key(candidate.exam_key)=exam_delivery.normalize_exam_key(pv.exam_key)
            and (candidate.student_user_id=a.owner_id or (candidate.student_user_id is null and exists (
              select 1 from public.memberships candidate_target where candidate_target.user_id=a.owner_id
                and candidate_target.group_id=candidate.group_id and candidate_target.status=''active'' and candidate_target.role=''student'')))
            and a.completed_at>=coalesce(candidate.available_from,candidate.created_at)
            and (candidate.due_at is null or a.completed_at<=candidate.due_at))=1)))');
  v_updated := replace(v_updated,
    'where v_workflow in (''overview'',''analytics'',''students'',''results'') and v_assignment is null and a.status=''submitted''',
    'where v_workflow in (''overview'',''analytics'',''students'',''results'') and (v_assignment is null or exists (
      select 1 from public.exam_assignments selected_assignment
      where selected_assignment.id=v_assignment
        and exam_delivery.normalize_exam_key(selected_assignment.exam_key)=exam_delivery.normalize_exam_key(a.exam_key)
        and (selected_assignment.student_user_id=a.user_id or (selected_assignment.student_user_id is null and exists (
          select 1 from public.memberships target where target.user_id=a.user_id
            and target.group_id=selected_assignment.group_id and target.status=''active'' and target.role=''student'')))
        and a.submitted_at>=coalesce(selected_assignment.available_from,selected_assignment.created_at)
        and (selected_assignment.due_at is null or a.submitted_at<=selected_assignment.due_at)
        and (select count(*) from public.exam_assignments candidate
          where candidate.organisation_id=selected_assignment.organisation_id
            and exam_delivery.normalize_exam_key(candidate.exam_key)=exam_delivery.normalize_exam_key(a.exam_key)
            and (candidate.student_user_id=a.user_id or (candidate.student_user_id is null and exists (
              select 1 from public.memberships candidate_target where candidate_target.user_id=a.user_id
                and candidate_target.group_id=candidate.group_id and candidate_target.status=''active'' and candidate_target.role=''student'')))
            and a.submitted_at>=coalesce(candidate.available_from,candidate.created_at)
            and (candidate.due_at is null or a.submitted_at<=candidate.due_at))=1)) and a.status=''submitted''');
  if v_updated=v_definition then raise exception 'issue59_raw_assignment_history_drift'; end if;
  execute v_updated;
end $$;

create function exam_delivery.staff_dashboard_query(p_actor_id uuid, p_request jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '15s'
as $$
declare v_page jsonb; v_analytics jsonb;
begin
  v_page := exam_delivery.staff_dashboard_query_issue59_base(p_actor_id, p_request);
  if v_page->>'ok' <> 'true' then return v_page; end if;
  v_analytics := exam_delivery.staff_dashboard_aggregates(p_actor_id, p_request);
  if v_analytics->>'ok' <> 'true' then return v_analytics; end if;
  return v_page || jsonb_build_object('analytics', v_analytics - 'ok');
end
$$;

alter function exam_delivery.staff_dashboard_aggregates(uuid,jsonb) owner to postgres;
alter function exam_delivery.staff_dashboard_query_issue59_base(uuid,jsonb) owner to postgres;
alter function exam_delivery.staff_dashboard_query(uuid,jsonb) owner to postgres;
revoke execute on function exam_delivery.staff_dashboard_aggregates(uuid,jsonb),
  exam_delivery.staff_dashboard_query_issue59_base(uuid,jsonb),
  exam_delivery.staff_dashboard_query(uuid,jsonb)
from public, anon, authenticated, service_role;
grant execute on function exam_delivery.staff_dashboard_query(uuid,jsonb) to service_role;

-- Final Issue #59 contract closure: weak-area materialization must use the same
-- package-wide, cross-profile evidence boundary as availability.
do $$
declare
  v_definition text := pg_get_functiondef(
    'exam_delivery.materialize_attempt_items(uuid,uuid,integer)'::regprocedure
  );
  v_updated text;
begin
  v_updated := replace(v_definition,
    'where prior.owner_id=v_attempt.owner_id and prior.id<>p_attempt_id',
    'where prior.owner_id=v_attempt.owner_id and prior.id<>p_attempt_id and prior.package_version_id=v_attempt.package_version_id');
  v_updated := replace(v_updated,
    'where prior.owner_id=v_attempt.owner_id' || chr(10) || '          and prior.status=''completed''',
    'where prior.owner_id=v_attempt.owner_id and prior.package_version_id=v_attempt.package_version_id' || chr(10) || '          and prior.status=''completed''');
  if v_updated = v_definition
    or (length(v_updated)-length(replace(v_updated,
      'prior.package_version_id=v_attempt.package_version_id',''))) /
      length('prior.package_version_id=v_attempt.package_version_id') < 2 then
    raise exception 'issue59_materializer_evidence_scope_drift';
  end if;
  v_definition := v_updated;
  v_updated := replace(v_definition,
    E'exists(select 1 from exam_delivery.attempts prior\n        join exam_delivery.attempt_results result on result.attempt_id=prior.id\n        cross join lateral jsonb_each(result.domain_summary) domain\n        where prior.owner_id=v_attempt.owner_id and prior.package_version_id=v_attempt.package_version_id\n          and prior.status=''completed''\n          and prior.purpose in (''assigned_assessment'',''self_directed_exam'')\n          and domain.key=q.domain_key\n          and coalesce((domain.value->>''percentage'')::numeric,100)<70) weak_domain',
    E'exists(select 1 from exam_delivery.learner_weak_domain_evidence(v_attempt.owner_id,v_attempt.package_version_id) evidence\n        where evidence.domain_key=q.domain_key) weak_domain');
  v_updated := replace(v_updated,
    E'or (v_attempt.purpose=''weak_area'' and (missed or weak_domain))',
    E'or (v_attempt.purpose=''weak_area'' and target_domain and (missed or weak_domain))');
  if v_updated = v_definition or v_updated not like '%learner_weak_domain_evidence%' then
    raise exception 'issue59_legacy_weak_domain_bridge_drift';
  end if;
  execute v_updated;
end
$$;

-- An assignment is validated at start and recorded as immutable provenance.
-- Its due/closed state blocks every new or replacement start, but cannot turn a
-- still-timed attempt into a pause or destroy its technical recovery path.
create or replace function exam_delivery.authorize_attempt_continuation(
  p_attempt_id uuid, p_operation text
)
returns jsonb language plpgsql stable security definer
set search_path = '' set statement_timeout = '5s' as $$
declare v record; v_assessment jsonb; v_assignment_continuation boolean;
begin
  if p_attempt_id is null or p_operation not in ('resume','save_response','check_item','submit') then
    return jsonb_build_object('ok',false,'code','invalid_request');
  end if;
  select a.owner_id,a.status,a.expires_at,a.purpose,a.practice_configuration,
    a.language_preference,a.package_version_id,a.package_profile_id,
    a.source_assignment_id,a.attribution_source,pv.exam_key,pv.package_version,
    pv.package_schema_version,pp.profile_key,policy.access_mode,policy.enabled
  into v from exam_delivery.attempts a
  join exam_delivery.package_versions pv on pv.id=a.package_version_id
  join exam_delivery.package_profiles pp on pp.id=a.package_profile_id
  left join exam_delivery.practice_policies policy
    on policy.canonical_exam_key=exam_delivery.normalize_exam_key(pv.exam_key)
   and policy.package_version=pv.package_version and policy.profile_key=pp.profile_key
   and policy.purpose=a.purpose
  where a.id=p_attempt_id;
  if not found then return jsonb_build_object('ok',false,'code','attempt_not_found'); end if;
  if v.status<>'in_progress' or statement_timestamp()>=v.expires_at then
    return jsonb_build_object('ok',false,'code','invalid_lifecycle_transition');
  end if;
  if not exists(select 1 from public.profiles profile where profile.id=v.owner_id and profile.status='active') then
    return jsonb_build_object('ok',false,'code','inactive_account');
  end if;
  v_assignment_continuation := v.purpose='self_directed_exam'
    and v.source_assignment_id is not null and v.attribution_source='assignment';
  if v.purpose='assigned_assessment' then
    if v.package_schema_version='certsim-protected-package-v2' then
      v_assessment:=exam_delivery.check_assessment_eligibility_v2(v.owner_id,v.exam_key,v.profile_key);
    else v_assessment:=exam_delivery.check_eligibility(v.owner_id,v.exam_key,v.profile_key); end if;
    if not coalesce((v_assessment->>'eligible')::boolean,false) then
      return jsonb_build_object('ok',false,'code','exam_unavailable');
    end if;
  else
    if not coalesce(v.enabled,false) or v.access_mode='disabled'
      or not exists(select 1 from exam_delivery.exam_profile_activations activation
        where activation.package_version_id=v.package_version_id
          and activation.package_profile_id=v.package_profile_id
          and activation.activation_kind='production' and activation.enabled) then
      return jsonb_build_object('ok',false,'code','practice_unavailable');
    end if;
    if not v_assignment_continuation and not exam_delivery.can_use_profile(
      v.owner_id,v.package_version_id,v.package_profile_id,v.purpose) then
      return jsonb_build_object('ok',false,'code','access_not_granted');
    end if;
  end if;
  return jsonb_build_object('ok',true,'ownerId',v.owner_id,
    'examKey',exam_delivery.normalize_exam_key(v.exam_key),'profileKey',v.profile_key,
    'purpose',v.purpose,'operation',p_operation);
end $$;

create or replace function exam_delivery.list_current_attempt_bindings(
  p_actor_id uuid,p_exam_key text,p_purpose text
) returns jsonb language sql stable security definer
set search_path='' set statement_timeout='5s' as $$
select jsonb_build_object('ok',true,'candidates',coalesce(jsonb_agg(jsonb_build_object(
  'attemptId',a.id,'assignmentId',a.source_assignment_id,
  'examKey',exam_delivery.normalize_exam_key(pv.exam_key),'packageVersion',pv.package_version,
  'profileKey',pp.profile_key,'profileName',pp.display_name,'purpose',a.purpose,
  'languagePreference',a.language_preference,'startedAt',a.started_at,'expiresAt',a.expires_at,
  'selectedCount',pp.question_count,'fixedProfileSize',true,
  'profileComposition',jsonb_build_object(
    'questionCount',pp.question_count,'timeLimitMinutes',pp.time_limit_minutes,
    'standardQuestionCount',coalesce((pp.selection_config->>'standardQuestionCount')::integer,
      (pp.selection_config->>'normalScoredQuestionCount')::integer,
      pp.question_count-coalesce((pp.selection_config->>'pbqCount')::integer,0)),
    'caseStudyCount',coalesce((pp.selection_config->>'caseStudyCount')::integer,
      coalesce((pp.selection_config->>'longCaseStudyCount')::integer,0)+coalesce((pp.selection_config->>'shortCaseStudyCount')::integer,0)),
    'caseStudyQuestionCount',greatest(0,pp.question_count-coalesce((pp.selection_config->>'standardQuestionCount')::integer,
      (pp.selection_config->>'normalScoredQuestionCount')::integer,pp.question_count-coalesce((pp.selection_config->>'pbqCount')::integer,0))
      -coalesce((pp.selection_config->>'pbqCount')::integer,0)),
    'pbqCount',coalesce((pp.selection_config->>'pbqCount')::integer,0),'sectionOrder',pp.selection_config->>'sectionOrder'),
  'replacementPermitted',coalesce(policy.maximum_completed_attempts is null
    and policy.maximum_concurrent_sessions=1 and policy.enabled and policy.access_mode<>'disabled'
    and a.purpose='self_directed_exam' and case when a.source_assignment_id is null then
      exam_delivery.can_use_profile(a.owner_id,a.package_version_id,a.package_profile_id,a.purpose)
    else exists(select 1 from public.exam_assignments assignment
      where assignment.id=a.source_assignment_id and assignment.status='active'
        and (assignment.available_from is null or assignment.available_from<=statement_timestamp())
        and (assignment.due_at is null or assignment.due_at>statement_timestamp())
        and exam_delivery.normalize_exam_key(assignment.exam_key)=exam_delivery.normalize_exam_key(pv.exam_key)
        and (nullif(assignment.profile_id,'') is null or assignment.profile_id=pp.profile_key)
        and (assignment.student_user_id=a.owner_id or (assignment.student_user_id is null
          and exists(select 1 from public.memberships membership where membership.user_id=a.owner_id
            and membership.group_id=assignment.group_id and membership.status='active'
            and membership.role='student'))))
    end,false)
) order by a.started_at,a.id),'[]'::jsonb))
from exam_delivery.attempts a
join exam_delivery.package_versions pv on pv.id=a.package_version_id
join exam_delivery.package_profiles pp on pp.id=a.package_profile_id
left join exam_delivery.practice_policies policy
  on policy.canonical_exam_key=exam_delivery.normalize_exam_key(pv.exam_key)
 and policy.package_version=pv.package_version and policy.profile_key=pp.profile_key
 and policy.purpose=a.purpose
cross join lateral (select exam_delivery.authorize_attempt_continuation(a.id,'resume') authorization) auth
where a.owner_id=p_actor_id and a.status='in_progress' and a.expires_at>statement_timestamp()
  and coalesce((auth.authorization->>'ok')::boolean,false)
  and (auth.authorization->>'ownerId')::uuid=p_actor_id
  and exam_delivery.normalize_exam_key(pv.exam_key)=exam_delivery.normalize_exam_key(p_exam_key)
  and a.purpose::text=p_purpose
$$;

-- Translate only the known assignment validator denial into the public
-- allowlisted business contract. Every other database failure stays closed.
alter function exam_delivery.practice_availability(uuid,jsonb)
  rename to practice_availability_issue59_enriched;
create function exam_delivery.practice_availability(p_actor_id uuid,p_request jsonb)
returns jsonb language plpgsql stable security definer
set search_path='' set statement_timeout='8s' as $$
begin
  return exam_delivery.practice_availability_issue59_enriched(p_actor_id,p_request);
exception when sqlstate '42501' then
  if nullif(p_request->>'assignmentId','') is not null then
    return jsonb_build_object('ok',false,'code','assignment_conflict');
  end if;
  raise;
end $$;

create or replace function exam_delivery.resume_attempt(p_actor_id uuid,p_attempt_id uuid)
returns jsonb language plpgsql stable security definer
set search_path='' set statement_timeout='10s' as $$
declare v record; v_authorization jsonb;
begin
  v_authorization:=exam_delivery.authorize_attempt_continuation(p_attempt_id,'resume');
  if not coalesce((v_authorization->>'ok')::boolean,false) then return v_authorization; end if;
  if (v_authorization->>'ownerId')::uuid<>p_actor_id then return jsonb_build_object('ok',false,'code','attempt_not_found'); end if;
  select a.*,pv.exam_key,pv.package_version,pp.profile_key,pp.display_name,pp.time_limit_minutes into v
  from exam_delivery.attempts a join exam_delivery.package_versions pv on pv.id=a.package_version_id
  join exam_delivery.package_profiles pp on pp.id=a.package_profile_id where a.id=p_attempt_id;
  return jsonb_build_object('ok',true,'attempt',jsonb_build_object(
    'attemptId',v.id,'assignmentId',v.source_assignment_id,'examKey',v.exam_key,
    'packageVersion',v.package_version,'profileKey',v.profile_key,'profileName',v.display_name,
    'status',v.status,'startedAt',v.started_at,'expiresAt',v.expires_at,
    'timeLimitMinutes',v.time_limit_minutes,'purpose',v.purpose,
    'languagePreference',v.language_preference),'items',coalesce((select jsonb_agg(jsonb_build_object(
      'itemId',i.id,'questionNumber',i.presented_question_number,'questionId',q.question_id,
      'questionType',q.question_type,'domain',q.domain_key,'section',q.section_key,
      'presentation',i.presentation_snapshot,'response',r.response_payload,'revision',coalesce(r.revision,0))
      order by i.presented_question_number) from exam_delivery.attempt_items i
      join exam_delivery.package_questions q on q.id=i.package_question_id
      left join exam_delivery.attempt_responses r on r.attempt_id=i.attempt_id and r.attempt_item_id=i.id
      where i.attempt_id=v.id),'[]'::jsonb));
end $$;

alter function exam_delivery.start_practice(uuid,jsonb)
  rename to start_practice_issue59_attribution_base;
create function exam_delivery.start_practice(p_actor_id uuid,p_request jsonb)
returns jsonb language plpgsql security definer
set search_path='' set statement_timeout='15s' as $$
declare v_availability jsonb; v_package_id uuid; v_profile_id uuid;
  v_existing exam_delivery.attempts%rowtype; v_assignment_id uuid;
begin
  begin v_assignment_id:=nullif(p_request->>'assignmentId','')::uuid;
  exception when invalid_text_representation then return jsonb_build_object('ok',false,'code','invalid_request'); end;
  v_availability:=exam_delivery.practice_availability(p_actor_id,p_request);
  if not coalesce((v_availability->>'ok')::boolean,false) then return v_availability; end if;
  select pv.id,pp.id into strict v_package_id,v_profile_id
  from exam_delivery.package_versions pv join exam_delivery.package_profiles pp on pp.package_version_id=pv.id
  where exam_delivery.normalize_exam_key(pv.exam_key)=v_availability->>'examKey'
    and pv.package_version=v_availability->>'packageVersion' and pp.profile_key=v_availability->>'profileKey';
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_actor_id::text||':'||v_package_id::text||':'||
    v_profile_id::text||':'||(p_request->>'purpose')||':'||(p_request->>'language'),0));
  select * into v_existing from exam_delivery.attempts a where a.owner_id=p_actor_id
    and a.package_version_id=v_package_id and a.package_profile_id=v_profile_id
    and a.purpose=(p_request->>'purpose')::exam_delivery.attempt_purpose
    and a.language_preference=p_request->>'language' and a.status='in_progress' for update;
  if found and not ((v_assignment_id is not null and v_existing.source_assignment_id=v_assignment_id
      and v_existing.attribution_source='assignment') or
    (v_assignment_id is null and v_existing.source_assignment_id is null
      and v_existing.attribution_source is distinct from 'assignment')) then
    return jsonb_build_object('ok',false,'code','attempt_conflict');
  end if;
  return exam_delivery.start_practice_issue59_attribution_base(p_actor_id,p_request);
exception when sqlstate '42501' then
  if nullif(p_request->>'assignmentId','') is not null then
    return jsonb_build_object('ok',false,'code','assignment_conflict');
  end if;
  raise;
when no_data_found or too_many_rows then return jsonb_build_object('ok',false,'code','package_unavailable');
end $$;

alter function exam_delivery.authorize_attempt_continuation(uuid,text) owner to postgres;
alter function exam_delivery.list_current_attempt_bindings(uuid,text,text) owner to postgres;
alter function exam_delivery.practice_availability_issue59_enriched(uuid,jsonb) owner to postgres;
alter function exam_delivery.practice_availability(uuid,jsonb) owner to postgres;
alter function exam_delivery.resume_attempt(uuid,uuid) owner to postgres;
alter function exam_delivery.start_practice_issue59_attribution_base(uuid,jsonb) owner to postgres;
alter function exam_delivery.start_practice(uuid,jsonb) owner to postgres;
revoke execute on function exam_delivery.authorize_attempt_continuation(uuid,text),
  exam_delivery.list_current_attempt_bindings(uuid,text,text),
  exam_delivery.practice_availability_issue59_enriched(uuid,jsonb),
  exam_delivery.practice_availability(uuid,jsonb),
  exam_delivery.start_practice_issue59_attribution_base(uuid,jsonb),
  exam_delivery.start_practice(uuid,jsonb)
from public,anon,authenticated,service_role;
grant execute on function exam_delivery.practice_availability(uuid,jsonb),
  exam_delivery.list_current_attempt_bindings(uuid,text,text),
  exam_delivery.start_practice(uuid,jsonb) to service_role;

-- Public trainer assignments launch a normal self-directed timed exam while
-- retaining immutable source attribution. They are not the legacy formal
-- protected-assignment model.
do $$
declare v_definition text; v_updated text;
begin
  v_definition := pg_get_functiondef(
    'exam_delivery.start_assignment_attempt(uuid,text,text,uuid,uuid)'::regprocedure
  );
  v_updated := replace(v_definition,
    'or nullif(v_assignment.profile_id,'''') is null or v_assignment.profile_id<>p_profile_key',
    'or (nullif(v_assignment.profile_id,'''') is not null and v_assignment.profile_id<>p_profile_key)');
  v_updated := replace(v_updated,
    '''assigned_assessment'',v_assignment.id',
    '''self_directed_exam'',v_assignment.id');
  if v_updated = v_definition then raise exception 'issue59_assignment_start_contract_drift'; end if;
  execute v_updated;

  v_definition := pg_get_functiondef(
    'exam_delivery.discover_assignment_attempt(uuid,text,text,text,text,text,uuid)'::regprocedure
  );
  v_updated := replace(v_definition,
    'p_purpose<>''assigned_assessment''',
    'p_purpose<>''self_directed_exam''');
  if v_updated = v_definition then raise exception 'issue59_assignment_discovery_contract_drift'; end if;
  execute v_updated;
end
$$;
