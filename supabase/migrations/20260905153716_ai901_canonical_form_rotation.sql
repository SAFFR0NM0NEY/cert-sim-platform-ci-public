-- Issue #21: immutable canonical-form publication and server-owned rotation.
-- This migration is repository-only and inert until a future package explicitly
-- declares canonicalForms inside each private profile selection contract.

alter table exam_delivery.package_versions
  add column declared_review_release_policy text,
  add column declared_answer_release_policy text,
  add constraint package_versions_declared_release_policy_check check (
    (declared_review_release_policy is null and declared_answer_release_policy is null)
    or (declared_review_release_policy, declared_answer_release_policy) in (
      ('never', 'never'),
      ('after_submission', 'after_submission')
    )
  );

alter table exam_delivery.package_profiles
  add constraint package_profiles_id_version_unique unique (id, package_version_id);
alter table exam_delivery.package_questions
  add constraint package_questions_id_version_unique unique (id, package_version_id);

create table exam_delivery.package_forms (
  id uuid primary key default gen_random_uuid(),
  package_version_id uuid not null references exam_delivery.package_versions(id) on delete restrict,
  package_profile_id uuid not null references exam_delivery.package_profiles(id) on delete restrict,
  form_key text not null,
  form_ordinal smallint not null check (form_ordinal > 0),
  question_count integer not null check (question_count > 0),
  membership_hash text not null check (membership_hash ~ '^[0-9a-f]{64}$'),
  blueprint_contract jsonb not null,
  created_at timestamptz not null default statement_timestamp(),
  unique (package_profile_id, form_key),
  unique (package_profile_id, form_ordinal),
  unique (id, package_version_id),
  unique (id, package_profile_id, package_version_id),
  foreign key (package_profile_id, package_version_id)
    references exam_delivery.package_profiles(id, package_version_id) on delete restrict
);

create table exam_delivery.package_form_questions (
  form_id uuid not null,
  package_profile_id uuid not null,
  package_version_id uuid not null references exam_delivery.package_versions(id) on delete restrict,
  package_question_id uuid not null references exam_delivery.package_questions(id) on delete restrict,
  presentation_ordinal integer not null check (presentation_ordinal > 0),
  primary key (form_id, package_question_id),
  unique (form_id, presentation_ordinal),
  unique (package_profile_id, package_question_id),
  foreign key (form_id, package_profile_id, package_version_id)
    references exam_delivery.package_forms(id, package_profile_id, package_version_id) on delete restrict,
  foreign key (package_question_id, package_version_id)
    references exam_delivery.package_questions(id, package_version_id) on delete restrict
);

create table exam_delivery.package_reserve_questions (
  package_version_id uuid not null references exam_delivery.package_versions(id) on delete restrict,
  package_question_id uuid not null references exam_delivery.package_questions(id) on delete restrict,
  primary key (package_version_id, package_question_id),
  foreign key (package_question_id, package_version_id)
    references exam_delivery.package_questions(id, package_version_id) on delete restrict
);

alter table exam_delivery.attempts
  add column canonical_form_id uuid,
  add column canonical_form_cycle integer check (canonical_form_cycle > 0),
  add constraint attempts_canonical_form_pair_check check (
    (canonical_form_id is null) = (canonical_form_cycle is null)
  ),
  add constraint attempts_canonical_form_package_fk
    foreign key (canonical_form_id, package_version_id)
    references exam_delivery.package_forms(id, package_version_id) on delete restrict;

create unique index attempts_one_canonical_form_per_cycle_idx
  on exam_delivery.attempts(owner_id, package_profile_id, canonical_form_cycle, canonical_form_id)
  where canonical_form_id is not null;

create index attempts_canonical_cycle_lookup_idx
  on exam_delivery.attempts(owner_id, package_version_id, package_profile_id, canonical_form_cycle)
  where canonical_form_id is not null;

alter table exam_delivery.package_forms enable row level security;
alter table exam_delivery.package_form_questions enable row level security;
alter table exam_delivery.package_reserve_questions enable row level security;

revoke all on table exam_delivery.package_forms from public, anon, authenticated, service_role;
revoke all on table exam_delivery.package_form_questions from public, anon, authenticated, service_role;
revoke all on table exam_delivery.package_reserve_questions from public, anon, authenticated, service_role;

create function exam_delivery.guard_canonical_package_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_package_version_id uuid;
begin
  v_package_version_id := case tg_table_name
    when 'package_forms' then coalesce(new.package_version_id, old.package_version_id)
    when 'package_form_questions' then coalesce(new.package_version_id, old.package_version_id)
    when 'package_reserve_questions' then coalesce(new.package_version_id, old.package_version_id)
  end;
  if exists (
    select 1 from exam_delivery.package_versions pv
    where pv.id = v_package_version_id and pv.status = 'published'
  ) then
    raise exception 'published_package_is_immutable' using errcode = '55000';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

create trigger guard_package_forms_mutation
before insert or update or delete on exam_delivery.package_forms
for each row execute function exam_delivery.guard_canonical_package_mutation();
create trigger guard_package_form_questions_mutation
before insert or update or delete on exam_delivery.package_form_questions
for each row execute function exam_delivery.guard_canonical_package_mutation();
create trigger guard_package_reserve_questions_mutation
before insert or update or delete on exam_delivery.package_reserve_questions
for each row execute function exam_delivery.guard_canonical_package_mutation();

create function exam_delivery.guard_attempt_form_immutability()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.canonical_form_id is not null and (
    new.canonical_form_id is distinct from old.canonical_form_id
    or new.canonical_form_cycle is distinct from old.canonical_form_cycle
  ) then
    raise exception 'attempt_form_assignment_is_immutable' using errcode = '55000';
  end if;
  return new;
end
$$;

create trigger guard_attempt_form_assignment
before update of canonical_form_id, canonical_form_cycle on exam_delivery.attempts
for each row execute function exam_delivery.guard_attempt_form_immutability();

create function exam_delivery.prepare_canonical_forms_on_publish()
returns trigger
language plpgsql
security definer
set search_path = ''
set statement_timeout = '15s'
as $$
declare
  v_profile record;
  v_contract jsonb;
  v_form jsonb;
  v_form_id uuid;
  v_release jsonb;
  v_declared_review text;
  v_declared_answers text;
  v_reference_reserve jsonb;
  v_form_count integer;
  v_member_count integer;
  v_medium integer;
  v_hard_advanced integer;
  v_advanced integer;
begin
  if old.status = new.status or new.status <> 'published' then return new; end if;
  if not exists (
    select 1 from exam_delivery.package_profiles pp
    where pp.package_version_id = new.id and pp.selection_config ? 'canonicalForms'
  ) then return new; end if;

  if exists (
    select 1 from exam_delivery.package_profiles pp
    where pp.package_version_id = new.id and not (pp.selection_config ? 'canonicalForms')
  ) then raise exception 'canonical_form_profile_declaration_incomplete' using errcode = '22023'; end if;

  for v_profile in
    select pp.* from exam_delivery.package_profiles pp
    where pp.package_version_id = new.id order by pp.profile_key
  loop
    v_contract := v_profile.selection_config->'canonicalForms';
    v_release := v_profile.selection_config->'formalReleasePolicy';
    if jsonb_typeof(v_contract) is distinct from 'object' or jsonb_typeof(v_release) is distinct from 'object'
    then raise exception 'canonical_form_contract_invalid' using errcode = '22023'; end if;
    if not exam_delivery.json_has_exact_keys(v_contract,array['contractVersion','profileKey','questionCount','cycleLength','reservePolicy','reserveQuestionIds','skillGroupTargets','requiredObjectiveKeys','minimumCoverageTagCounts','difficultyRequirements','forms'])
      or v_contract->>'contractVersion' <> 'certsim-canonical-forms-v2'
      or (v_contract->>'profileKey') is distinct from v_profile.profile_key
      or jsonb_typeof(v_contract->'questionCount') is distinct from 'number'
      or not (v_contract->>'questionCount' ~ '^\d+$')
      or jsonb_typeof(v_contract->'cycleLength') is distinct from 'number'
      or not (v_contract->>'cycleLength' ~ '^\d+$')
      or jsonb_typeof(v_contract->'forms') is distinct from 'array'
      or jsonb_typeof(v_contract->'reserveQuestionIds') is distinct from 'array'
      or jsonb_typeof(v_contract->'skillGroupTargets') is distinct from 'object'
      or jsonb_typeof(v_contract->'requiredObjectiveKeys') is distinct from 'array'
      or jsonb_typeof(v_contract->'minimumCoverageTagCounts') is distinct from 'object'
      or jsonb_typeof(v_contract->'difficultyRequirements') is distinct from 'object'
      or v_contract->>'reservePolicy' <> 'practice-only-until-versioned-rebalance'
      or not exam_delivery.json_has_exact_keys(v_release, array['review','answers'])
      or (v_release->>'review', v_release->>'answers') <> ('after_submission','after_submission')
    then raise exception 'canonical_form_contract_invalid' using errcode = '22023'; end if;

    if (v_contract->>'questionCount')::integer <> v_profile.question_count
      or (v_contract->>'cycleLength')::integer not between 2 and 20
      or jsonb_array_length(v_contract->'forms') <> (v_contract->>'cycleLength')::integer
      or (select count(*) from jsonb_object_keys(v_contract->'skillGroupTargets')) = 0
      or exists (select 1 from jsonb_each(v_contract->'skillGroupTargets') target(key,value)
        where nullif(btrim(target.key),'') is null or jsonb_typeof(target.value) is distinct from 'number'
          or not (target.value#>>'{}' ~ '^\d+$'))
      or (select coalesce(sum((value#>>'{}')::integer),0) from jsonb_each(v_contract->'skillGroupTargets')) <> v_profile.question_count
      or jsonb_array_length(v_contract->'requiredObjectiveKeys') = 0
      or exists (select 1 from jsonb_array_elements(v_contract->'requiredObjectiveKeys') objective(value)
        where jsonb_typeof(objective.value) is distinct from 'string' or nullif(btrim(objective.value#>>'{}'),'') is null)
      or (select count(*) <> count(distinct value#>>'{}') from jsonb_array_elements(v_contract->'requiredObjectiveKeys') objective(value))
      or exists (select 1 from jsonb_each(v_contract->'minimumCoverageTagCounts') coverage(key,value)
        where nullif(btrim(coverage.key),'') is null or jsonb_typeof(coverage.value) is distinct from 'number'
          or not (coverage.value#>>'{}' ~ '^\d+$'))
      or not exam_delivery.json_has_exact_keys(v_contract->'difficultyRequirements',array['minimumMedium','minimumHardOrAdvanced','minimumAdvanced'])
      or exists (select 1 from jsonb_each(v_contract->'difficultyRequirements') difficulty(key,value)
        where jsonb_typeof(difficulty.value) is distinct from 'number' or not (difficulty.value#>>'{}' ~ '^\d+$'))
    then raise exception 'canonical_form_generic_metadata_invalid' using errcode = '22023'; end if;

    if v_declared_review is null then
      v_declared_review := v_release->>'review';
      v_declared_answers := v_release->>'answers';
      v_reference_reserve := v_contract->'reserveQuestionIds';
    elsif (v_declared_review, v_declared_answers) is distinct from (v_release->>'review', v_release->>'answers')
      or v_reference_reserve is distinct from v_contract->'reserveQuestionIds'
    then raise exception 'canonical_form_cross_profile_contract_mismatch' using errcode = '22023'; end if;

    if exists (select 1 from jsonb_array_elements(v_contract->'reserveQuestionIds') reserve(value)
        where jsonb_typeof(reserve.value) is distinct from 'string' or nullif(btrim(reserve.value#>>'{}'),'') is null)
      or (select count(*) <> count(distinct value) from jsonb_array_elements_text(v_contract->'reserveQuestionIds'))
      or exists (
        select 1 from jsonb_array_elements_text(v_contract->'reserveQuestionIds') r(question_id)
        where not exists (
          select 1 from exam_delivery.package_questions q
          where q.package_version_id = new.id and q.question_id = r.question_id
        )
      )
    then raise exception 'canonical_form_reserve_invalid' using errcode = '22023'; end if;

    v_form_count := 0;
    for v_form in select value from jsonb_array_elements(v_contract->'forms')
    loop
      v_form_count := v_form_count + 1;
      if jsonb_typeof(v_form) is distinct from 'object'
        or not exam_delivery.json_has_exact_keys(v_form,array['formKey','ordinal','questionIds','membershipHash'])
        or nullif(btrim(v_form->>'formKey'),'') is null
        or jsonb_typeof(v_form->'ordinal') is distinct from 'number'
        or not (v_form->>'ordinal' ~ '^\d+$')
        or jsonb_typeof(v_form->'questionIds') is distinct from 'array'
      then raise exception 'canonical_form_definition_invalid' using errcode = '22023'; end if;
      if (v_form->>'ordinal')::integer <> v_form_count
        or jsonb_array_length(v_form->'questionIds') <> v_profile.question_count
        or v_form->>'membershipHash' <> exam_delivery.canonical_sha256(v_form->'questionIds')
        or exists (select 1 from jsonb_array_elements(v_form->'questionIds') member(value)
          where jsonb_typeof(member.value) is distinct from 'string' or nullif(btrim(member.value#>>'{}'),'') is null)
        or (select count(*) <> count(distinct value) from jsonb_array_elements_text(v_form->'questionIds'))
      then raise exception 'canonical_form_definition_invalid' using errcode = '22023'; end if;

      if exists (
        select 1 from jsonb_array_elements_text(v_form->'questionIds') member(question_id)
        where not exists (
          select 1 from exam_delivery.package_questions q
          where q.package_version_id = new.id and q.question_id = member.question_id
        )
      ) or exists (
        select 1 from jsonb_array_elements_text(v_form->'questionIds') member(question_id)
        join jsonb_array_elements_text(v_contract->'reserveQuestionIds') reserve(question_id)
          on reserve.question_id = member.question_id
      ) then raise exception 'canonical_form_membership_invalid' using errcode = '22023'; end if;

      select count(*) filter (where q.presentation_payload->>'difficulty' = 'medium'),
        count(*) filter (where q.presentation_payload->>'difficulty' in ('hard','advanced')),
        count(*) filter (where q.presentation_payload->>'difficulty' = 'advanced')
      into v_medium, v_hard_advanced, v_advanced
      from jsonb_array_elements_text(v_form->'questionIds') member(question_id)
      join exam_delivery.package_questions q on q.package_version_id = new.id and q.question_id = member.question_id;

      if exists (
          select 1 from jsonb_array_elements_text(v_form->'questionIds') member(question_id)
          join exam_delivery.package_questions q on q.package_version_id = new.id and q.question_id = member.question_id
          where nullif(btrim(q.presentation_payload->>'officialSkillGroup'),'') is null
            or nullif(btrim(q.presentation_payload->>'officialObjectiveKey'),'') is null
            or not (v_contract->'skillGroupTargets' ? (q.presentation_payload->>'officialSkillGroup'))
            or q.presentation_payload->>'difficulty' not in ('easy','medium','hard','advanced')
            or jsonb_typeof(q.presentation_payload->'coverageTags') is distinct from 'array'
            or exists (select 1 from jsonb_array_elements(q.presentation_payload->'coverageTags') tag(value)
              where jsonb_typeof(tag.value) is distinct from 'string' or nullif(btrim(tag.value#>>'{}'),'') is null)
            or (select count(*) <> count(distinct value#>>'{}') from jsonb_array_elements(q.presentation_payload->'coverageTags') tag(value))
        )
        or v_medium < (v_contract#>>'{difficultyRequirements,minimumMedium}')::integer
        or v_hard_advanced < (v_contract#>>'{difficultyRequirements,minimumHardOrAdvanced}')::integer
        or v_advanced < (v_contract#>>'{difficultyRequirements,minimumAdvanced}')::integer
        or exists (
          select 1 from jsonb_each_text(v_contract->'skillGroupTargets') required(skill_group, target)
          where (select count(*) from jsonb_array_elements_text(v_form->'questionIds') member(question_id)
            join exam_delivery.package_questions q on q.package_version_id = new.id and q.question_id = member.question_id
            where q.presentation_payload->>'officialSkillGroup' = required.skill_group) <> required.target::integer
        ) or exists (
          select 1 from jsonb_array_elements_text(v_contract->'requiredObjectiveKeys') required(objective_key)
          where not exists (select 1 from jsonb_array_elements_text(v_form->'questionIds') member(question_id)
            join exam_delivery.package_questions q on q.package_version_id = new.id and q.question_id = member.question_id
            where q.presentation_payload->>'officialObjectiveKey' = required.objective_key)
        ) or exists (
          select 1 from jsonb_each_text(v_contract->'minimumCoverageTagCounts') required(coverage_tag, minimum_count)
          where (select count(*) from jsonb_array_elements_text(v_form->'questionIds') member(question_id)
            join exam_delivery.package_questions q on q.package_version_id = new.id and q.question_id = member.question_id
            where coalesce(q.presentation_payload->'coverageTags','[]'::jsonb) ? required.coverage_tag) < required.minimum_count::integer
        )
      then raise exception 'canonical_form_blueprint_invalid' using errcode = '22023'; end if;

      insert into exam_delivery.package_forms(
        package_version_id, package_profile_id, form_key, form_ordinal,
        question_count, membership_hash, blueprint_contract
      ) values (
        new.id, v_profile.id, v_form->>'formKey', (v_form->>'ordinal')::smallint,
        v_profile.question_count, v_form->>'membershipHash', v_contract - 'forms' - 'reserveQuestionIds'
      ) returning id into v_form_id;

      insert into exam_delivery.package_form_questions(
        form_id, package_profile_id, package_version_id, package_question_id, presentation_ordinal
      )
      select v_form_id, v_profile.id, new.id, q.id, member.ordinality::integer
      from jsonb_array_elements_text(v_form->'questionIds') with ordinality member(question_id, ordinality)
      join exam_delivery.package_questions q on q.package_version_id = new.id and q.question_id = member.question_id;
      get diagnostics v_member_count = row_count;
      if v_member_count <> v_profile.question_count then
        raise exception 'canonical_form_materialization_incomplete' using errcode = 'P0001';
      end if;
    end loop;
    if (select count(*) from exam_delivery.package_form_questions fq where fq.package_profile_id = v_profile.id)
      <> (v_contract->>'cycleLength')::integer * v_profile.question_count
    then raise exception 'canonical_form_union_incomplete' using errcode = 'P0001'; end if;
  end loop;

  insert into exam_delivery.package_reserve_questions(package_version_id, package_question_id)
  select new.id, q.id
  from jsonb_array_elements_text(v_reference_reserve) reserve(question_id)
  join exam_delivery.package_questions q on q.package_version_id = new.id and q.question_id = reserve.question_id;

  new.declared_review_release_policy := v_declared_review;
  new.declared_answer_release_policy := v_declared_answers;
  return new;
end
$$;

create trigger prepare_canonical_forms_before_publish
before update of status on exam_delivery.package_versions
for each row execute function exam_delivery.prepare_canonical_forms_on_publish();

create function exam_delivery.guard_declared_self_directed_release_policy()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_package exam_delivery.package_versions%rowtype;
begin
  if new.purpose <> 'self_directed_exam' then return new; end if;
  select pv.* into v_package
  from exam_delivery.package_versions pv
  where exam_delivery.normalize_exam_key(pv.exam_key) = new.canonical_exam_key
    and pv.package_version = new.package_version and pv.status = 'published';
  if found and v_package.declared_review_release_policy is not null and (
    new.review_release_policy is distinct from v_package.declared_review_release_policy
    or new.answer_release_policy is distinct from v_package.declared_answer_release_policy
  ) then raise exception 'self_directed_release_policy_conflicts_with_package' using errcode = '22023'; end if;
  return new;
end
$$;

create trigger guard_declared_self_directed_release_policy
before insert or update of canonical_exam_key, package_version, purpose, review_release_policy, answer_release_policy
on exam_delivery.practice_policies
for each row execute function exam_delivery.guard_declared_self_directed_release_policy();

create function exam_delivery.allocate_canonical_form(p_attempt_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  v_attempt exam_delivery.attempts%rowtype;
  v_form_id uuid;
  v_previous_form_id uuid;
  v_cycle integer;
  v_form_count integer;
  v_seen_count integer;
begin
  select * into strict v_attempt from exam_delivery.attempts a
  where a.id = p_attempt_id for update;
  if v_attempt.purpose not in ('assigned_assessment','self_directed_exam') then return null; end if;
  if v_attempt.canonical_form_id is not null then return v_attempt.canonical_form_id; end if;

  select count(*)::integer into v_form_count from exam_delivery.package_forms f
  where f.package_version_id = v_attempt.package_version_id
    and f.package_profile_id = v_attempt.package_profile_id;
  if v_form_count = 0 then return null; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    v_attempt.owner_id::text || ':' || v_attempt.package_version_id::text || ':' || v_attempt.package_profile_id::text, 0
  ));
  select a.canonical_form_id into v_previous_form_id
  from exam_delivery.attempts a
  where a.owner_id = v_attempt.owner_id
    and a.package_version_id = v_attempt.package_version_id
    and a.package_profile_id = v_attempt.package_profile_id
    and a.canonical_form_id is not null and a.id <> v_attempt.id
  order by a.created_at desc, a.id desc limit 1;

  select coalesce(max(a.canonical_form_cycle), 1) into v_cycle
  from exam_delivery.attempts a
  where a.owner_id = v_attempt.owner_id
    and a.package_version_id = v_attempt.package_version_id
    and a.package_profile_id = v_attempt.package_profile_id
    and a.canonical_form_id is not null;
  select count(distinct a.canonical_form_id)::integer into v_seen_count
  from exam_delivery.attempts a
  where a.owner_id = v_attempt.owner_id
    and a.package_version_id = v_attempt.package_version_id
    and a.package_profile_id = v_attempt.package_profile_id
    and a.canonical_form_cycle = v_cycle and a.canonical_form_id is not null;
  if v_seen_count >= v_form_count then v_cycle := v_cycle + 1; end if;

  select f.id into strict v_form_id
  from exam_delivery.package_forms f
  where f.package_version_id = v_attempt.package_version_id
    and f.package_profile_id = v_attempt.package_profile_id
    and not exists (
      select 1 from exam_delivery.attempts seen
      where seen.owner_id = v_attempt.owner_id
        and seen.package_version_id = v_attempt.package_version_id
        and seen.package_profile_id = v_attempt.package_profile_id
        and seen.canonical_form_cycle = v_cycle and seen.canonical_form_id = f.id
    )
    and (v_cycle = 1 or v_form_count = 1 or f.id is distinct from v_previous_form_id)
  order by f.form_ordinal limit 1;

  update exam_delivery.attempts
  set canonical_form_id = v_form_id, canonical_form_cycle = v_cycle
  where id = v_attempt.id and canonical_form_id is null;
  if not found then raise exception 'canonical_form_allocation_conflict' using errcode = '40001'; end if;
  return v_form_id;
exception when no_data_found or too_many_rows then
  raise exception 'canonical_form_unavailable' using errcode = '22023';
end
$$;

alter function exam_delivery.materialize_attempt_items(uuid,uuid,integer)
  rename to materialize_attempt_items_issue21_unrotated_base;

create function exam_delivery.materialize_attempt_items(
  p_attempt_id uuid,
  p_request_id uuid,
  p_practice_limit integer default null
)
returns integer
language plpgsql
security definer
set search_path = ''
set statement_timeout = '15s'
as $$
declare
  v_attempt record;
  v_form exam_delivery.package_forms%rowtype;
  v_inserted integer;
begin
  select a.*, pp.question_count into strict v_attempt
  from exam_delivery.attempts a
  join exam_delivery.package_profiles pp on pp.id = a.package_profile_id
  where a.id = p_attempt_id and a.client_request_id = p_request_id and a.status = 'in_progress'
  for update of a for share of pp;

  if v_attempt.purpose not in ('assigned_assessment','self_directed_exam')
    or not exists (
      select 1 from exam_delivery.package_forms f
      where f.package_version_id = v_attempt.package_version_id
        and f.package_profile_id = v_attempt.package_profile_id
    )
  then return exam_delivery.materialize_attempt_items_issue21_unrotated_base(p_attempt_id, p_request_id, p_practice_limit); end if;

  perform exam_delivery.allocate_canonical_form(p_attempt_id);
  select f.* into strict v_form from exam_delivery.package_forms f
  join exam_delivery.attempts a on a.canonical_form_id = f.id
  where a.id = p_attempt_id and f.package_version_id = v_attempt.package_version_id
    and f.package_profile_id = v_attempt.package_profile_id;

  select count(*)::integer into v_inserted
  from exam_delivery.package_form_questions fq
  join exam_delivery.package_questions q on q.id = fq.package_question_id
  where fq.form_id = v_form.id and fq.package_version_id = v_attempt.package_version_id;
  if v_inserted <> v_attempt.question_count
    or v_inserted <> v_form.question_count
    or exists (select 1 from jsonb_each_text(v_form.blueprint_contract->'skillGroupTargets') required(skill_group, target)
      where (select count(*) from exam_delivery.package_form_questions fq2
        join exam_delivery.package_questions q2 on q2.id=fq2.package_question_id
        where fq2.form_id=v_form.id and q2.presentation_payload->>'officialSkillGroup'=required.skill_group) <> required.target::integer)
    or exists (select 1 from jsonb_array_elements_text(v_form.blueprint_contract->'requiredObjectiveKeys') required(objective_key)
      where not exists (select 1 from exam_delivery.package_form_questions fq2
        join exam_delivery.package_questions q2 on q2.id=fq2.package_question_id
        where fq2.form_id=v_form.id and q2.presentation_payload->>'officialObjectiveKey'=required.objective_key))
    or exists (select 1 from jsonb_each_text(v_form.blueprint_contract->'minimumCoverageTagCounts') required(coverage_tag, minimum_count)
      where (select count(*) from exam_delivery.package_form_questions fq2
        join exam_delivery.package_questions q2 on q2.id=fq2.package_question_id
        where fq2.form_id=v_form.id and coalesce(q2.presentation_payload->'coverageTags','[]'::jsonb) ? required.coverage_tag) < required.minimum_count::integer)
  then raise exception 'canonical_form_runtime_validation_failed' using errcode = 'P0001'; end if;

  with inserted as (
    insert into exam_delivery.attempt_items(
      attempt_id, package_version_id, package_question_id, presented_question_number,
      section_ordinal, option_order, presentation_snapshot, presentation_hash
    )
    select p_attempt_id, v_attempt.package_version_id, q.id, fq.presentation_ordinal,
      null, '[]'::jsonb, q.presentation_payload,
      encode(extensions.digest(convert_to(q.presentation_payload::text, 'UTF8'), 'sha256'), 'hex')
    from exam_delivery.package_form_questions fq
    join exam_delivery.package_questions q on q.id = fq.package_question_id
    where fq.form_id = v_form.id and fq.package_version_id = v_attempt.package_version_id
    order by fq.presentation_ordinal
    returning id, package_question_id
  )
  insert into exam_delivery.attempt_item_protected_content(
    attempt_item_id, attempt_id, scoring_snapshot, review_snapshot, protected_snapshot_hash
  )
  select i.id, p_attempt_id, pc.scoring_payload, pc.review_payload,
    encode(extensions.digest(convert_to((pc.scoring_payload || pc.review_payload)::text, 'UTF8'), 'sha256'), 'hex')
  from inserted i
  join exam_delivery.package_question_protected_content pc on pc.question_id = i.package_question_id;
  get diagnostics v_inserted = row_count;
  if v_inserted <> v_attempt.question_count then
    raise exception 'canonical_form_materialization_incomplete' using errcode = 'P0001';
  end if;
  return v_inserted;
exception when no_data_found or too_many_rows then
  raise exception 'attempt_not_materializable' using errcode = '22023';
end
$$;

alter function exam_delivery.guard_canonical_package_mutation() owner to postgres;
alter function exam_delivery.guard_attempt_form_immutability() owner to postgres;
alter function exam_delivery.prepare_canonical_forms_on_publish() owner to postgres;
alter function exam_delivery.guard_declared_self_directed_release_policy() owner to postgres;
alter function exam_delivery.allocate_canonical_form(uuid) owner to postgres;
alter function exam_delivery.materialize_attempt_items_issue21_unrotated_base(uuid,uuid,integer) owner to postgres;
alter function exam_delivery.materialize_attempt_items(uuid,uuid,integer) owner to postgres;

revoke execute on function exam_delivery.guard_canonical_package_mutation(),
  exam_delivery.guard_attempt_form_immutability(),
  exam_delivery.prepare_canonical_forms_on_publish(),
  exam_delivery.guard_declared_self_directed_release_policy(),
  exam_delivery.allocate_canonical_form(uuid),
  exam_delivery.materialize_attempt_items_issue21_unrotated_base(uuid,uuid,integer),
  exam_delivery.materialize_attempt_items(uuid,uuid,integer)
from public, anon, authenticated, service_role;

-- Canonical form allocation is exclusively server-owned. Fail closed instead
-- of silently ignoring a client-supplied selector at either public start path.
create or replace function public.certsim_protected_start_practice(p_actor_id uuid,p_request jsonb)
returns jsonb language sql security invoker set search_path='' as $$
  select case
    when p_request ?| array['canonicalFormId','canonical_form_id','canonicalFormKey','canonical_form_key']
      then jsonb_build_object('ok',false,'code','invalid_request')
    else exam_delivery.start_practice(p_actor_id,p_request)
  end
$$;

create or replace function public.certsim_protected_replace_current_practice_attempt(p_actor_id uuid,p_request jsonb)
returns jsonb language sql security invoker set search_path='' as $$
  select case
    when p_request ?| array['canonicalFormId','canonical_form_id','canonicalFormKey','canonical_form_key']
      then jsonb_build_object('ok',false,'code','invalid_request')
    else exam_delivery.replace_current_practice_attempt(p_actor_id,p_request)
  end
$$;

alter function public.certsim_protected_start_practice(uuid,jsonb) owner to postgres;
alter function public.certsim_protected_replace_current_practice_attempt(uuid,jsonb) owner to postgres;
revoke execute on function public.certsim_protected_start_practice(uuid,jsonb),
  public.certsim_protected_replace_current_practice_attempt(uuid,jsonb)
from public, anon, authenticated, service_role;
grant execute on function public.certsim_protected_start_practice(uuid,jsonb),
  public.certsim_protected_replace_current_practice_attempt(uuid,jsonb)
to service_role;

comment on table exam_delivery.package_forms is
  'Private immutable canonical form definitions for explicitly declaring package profiles.';
comment on table exam_delivery.package_form_questions is
  'Private ordered canonical form membership; never exposed through browser DTOs.';
comment on table exam_delivery.package_reserve_questions is
  'Private practice-only reserve membership excluded from ordinary canonical formal attempts.';
