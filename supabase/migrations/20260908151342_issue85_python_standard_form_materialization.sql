-- Issue #85: materialize the explicit Python Standard fixed-form contract.
-- The existing rich certsim-canonical-forms-v2 path below is retained unchanged.

create or replace function exam_delivery.prepare_canonical_forms_on_publish()
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
  v_python_raw_maximum numeric;
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

  -- Python Standard has a deliberately smaller, fixed-form contract. Dispatch
  -- only when both its exact contract and exact non-PBQ runtime are present.
  if exists (
    select 1 from exam_delivery.package_profiles pp
    where pp.package_version_id = new.id
      and pp.selection_config#>>'{canonicalForms,contractVersion}' = 'certsim-python-standard-forms-v1'
  ) then
    if new.generator_version <> 'certsim-python-standard-canonical-forms-v1'
      or new.scorer_version <> 'certsim-versioned-structured-partial-v1'
      or (select count(*) from exam_delivery.package_profiles pp where pp.package_version_id = new.id) <> 1
      or exists (
        select 1 from exam_delivery.package_profiles pp
        where pp.package_version_id = new.id
          and pp.selection_config#>>'{canonicalForms,contractVersion}' <> 'certsim-python-standard-forms-v1'
      )
    then raise exception 'canonical_form_contract_invalid' using errcode = '22023'; end if;

    for v_profile in
      select pp.* from exam_delivery.package_profiles pp
      where pp.package_version_id = new.id order by pp.profile_key
    loop
      v_contract := v_profile.selection_config->'canonicalForms';
      if jsonb_typeof(v_contract) is distinct from 'object'
        or not exam_delivery.json_has_exact_keys(v_contract,array[
          'contractVersion','cycleLength','reservePolicy','reserveQuestionIds','forms'
        ])
        or v_contract->>'contractVersion' <> 'certsim-python-standard-forms-v1'
        or jsonb_typeof(v_contract->'cycleLength') is distinct from 'number'
        or not (v_contract->>'cycleLength' ~ '^\d+$')
        or (v_contract->>'cycleLength')::integer not between 2 and 20
        or jsonb_typeof(v_contract->'forms') is distinct from 'array'
        or jsonb_array_length(v_contract->'forms') <> (v_contract->>'cycleLength')::integer
        or v_contract->>'reservePolicy' <> 'profile-specific-reserve'
        or jsonb_typeof(v_contract->'reserveQuestionIds') is distinct from 'array'
      then raise exception 'canonical_form_contract_invalid' using errcode = '22023'; end if;

      if exists (
          select 1 from jsonb_array_elements(v_contract->'reserveQuestionIds') reserve(value)
          where jsonb_typeof(reserve.value) is distinct from 'string'
            or nullif(pg_catalog.btrim(reserve.value#>>'{}'),'') is null
        )
        or (select count(*) <> count(distinct value)
            from jsonb_array_elements_text(v_contract->'reserveQuestionIds'))
        or exists (
          select 1 from jsonb_array_elements_text(v_contract->'reserveQuestionIds') reserve(question_id)
          where not exists (
            select 1 from exam_delivery.package_questions q
            where q.package_version_id = new.id and q.question_id = reserve.question_id
          )
        )
      then raise exception 'canonical_form_reserve_invalid' using errcode = '22023'; end if;

      -- Reject malformed form collections, duplicate keys, cross-form
      -- duplicates, and reserve overlap before materializing.
      if exists (
          select 1 from jsonb_array_elements(v_contract->'forms') form(value)
          where jsonb_typeof(form.value) is distinct from 'object'
            or jsonb_typeof(form.value->'questionIds') is distinct from 'array'
        )
        or (select count(*) <> count(distinct form.value->>'formKey')
            from jsonb_array_elements(v_contract->'forms') form(value))
        or exists (
          select member.question_id
          from jsonb_array_elements(v_contract->'forms') form(value)
          cross join lateral jsonb_array_elements_text(form.value->'questionIds') member(question_id)
          group by member.question_id having count(*) > 1
        )
        or exists (
          select 1
          from jsonb_array_elements(v_contract->'forms') form(value)
          cross join lateral jsonb_array_elements_text(form.value->'questionIds') member(question_id)
          join jsonb_array_elements_text(v_contract->'reserveQuestionIds') reserve(question_id)
            on reserve.question_id = member.question_id
        )
      then raise exception 'canonical_form_membership_invalid' using errcode = '22023'; end if;

      v_form_count := 0;
      for v_form in select value from jsonb_array_elements(v_contract->'forms')
      loop
        v_form_count := v_form_count + 1;
        if jsonb_typeof(v_form) is distinct from 'object'
          or not exam_delivery.json_has_exact_keys(v_form,array[
            'formKey','ordinal','questionIds','membershipHash','rawMaximum'
          ])
          or nullif(pg_catalog.btrim(v_form->>'formKey'),'') is null
          or jsonb_typeof(v_form->'ordinal') is distinct from 'number'
          or not (v_form->>'ordinal' ~ '^\d+$')
          or (v_form->>'ordinal')::integer <> v_form_count
          or jsonb_typeof(v_form->'questionIds') is distinct from 'array'
          or jsonb_array_length(v_form->'questionIds') <> v_profile.question_count
          or jsonb_typeof(v_form->'rawMaximum') is distinct from 'number'
          or not (v_form->>'rawMaximum' ~ '^\d+(\.\d+)?$')
          or nullif(pg_catalog.btrim(v_form->>'membershipHash'),'') is null
          or v_form->>'membershipHash' <> exam_delivery.canonical_sha256(v_form->'questionIds')
          or exists (
            select 1 from jsonb_array_elements(v_form->'questionIds') member(value)
            where jsonb_typeof(member.value) is distinct from 'string'
              or nullif(pg_catalog.btrim(member.value#>>'{}'),'') is null
          )
          or (select count(*) <> count(distinct value)
              from jsonb_array_elements_text(v_form->'questionIds'))
          or exists (
            select 1 from jsonb_array_elements_text(v_form->'questionIds') member(question_id)
            where not exists (
              select 1 from exam_delivery.package_questions q
              where q.package_version_id = new.id and q.question_id = member.question_id
            )
          )
        then raise exception 'canonical_form_definition_invalid' using errcode = '22023'; end if;

        select pg_catalog.sum((pc.scoring_payload->>'maximumRawPoints')::numeric)
        into v_python_raw_maximum
        from jsonb_array_elements_text(v_form->'questionIds') member(question_id)
        join exam_delivery.package_questions q
          on q.package_version_id = new.id and q.question_id = member.question_id
        join exam_delivery.package_question_protected_content pc
          on pc.package_version_id = new.id and pc.question_id = q.id
        where jsonb_typeof(pc.scoring_payload->'maximumRawPoints') = 'number'
          and pc.scoring_payload->>'maximumRawPoints' ~ '^\d+(\.\d+)?$';

        if v_python_raw_maximum is null
          or v_python_raw_maximum <> (v_form->>'rawMaximum')::numeric
          or (select count(*)
              from jsonb_array_elements_text(v_form->'questionIds') member(question_id)
              join exam_delivery.package_questions q
                on q.package_version_id = new.id and q.question_id = member.question_id
              join exam_delivery.package_question_protected_content pc
                on pc.package_version_id = new.id and pc.question_id = q.id
              where jsonb_typeof(pc.scoring_payload->'maximumRawPoints') = 'number'
                and pc.scoring_payload->>'maximumRawPoints' ~ '^\d+(\.\d+)?$')
             <> v_profile.question_count
        then raise exception 'canonical_form_raw_maximum_invalid' using errcode = '22023'; end if;

        insert into exam_delivery.package_forms(
          package_version_id, package_profile_id, form_key, form_ordinal,
          question_count, membership_hash, blueprint_contract
        ) values (
          new.id, v_profile.id, v_form->>'formKey', (v_form->>'ordinal')::smallint,
          v_profile.question_count, v_form->>'membershipHash',
          v_contract - 'forms' - 'reserveQuestionIds'
        ) returning id into v_form_id;

        insert into exam_delivery.package_form_questions(
          form_id, package_profile_id, package_version_id, package_question_id, presentation_ordinal
        )
        select v_form_id, v_profile.id, new.id, q.id, member.ordinality::integer
        from jsonb_array_elements_text(v_form->'questionIds') with ordinality member(question_id, ordinality)
        join exam_delivery.package_questions q
          on q.package_version_id = new.id and q.question_id = member.question_id;
        get diagnostics v_member_count = row_count;
        if v_member_count <> v_profile.question_count then
          raise exception 'canonical_form_materialization_incomplete' using errcode = 'P0001';
        end if;
      end loop;

      if (select count(*) from exam_delivery.package_form_questions fq
          where fq.package_profile_id = v_profile.id)
          <> (v_contract->>'cycleLength')::integer * v_profile.question_count
        or (select count(distinct member.question_id)
            from jsonb_array_elements(v_contract->'forms') form(value)
            cross join lateral jsonb_array_elements_text(form.value->'questionIds') member(question_id))
           + jsonb_array_length(v_contract->'reserveQuestionIds')
           <> (select count(*) from exam_delivery.package_questions q where q.package_version_id = new.id)
        or exists (
          select 1 from exam_delivery.package_questions q
          where q.package_version_id = new.id
            and not exists (
              select 1
              from jsonb_array_elements(v_contract->'forms') form(value)
              cross join lateral jsonb_array_elements_text(form.value->'questionIds') member(question_id)
              where member.question_id = q.question_id
            )
            and not (v_contract->'reserveQuestionIds' ? q.question_id)
        )
      then raise exception 'canonical_form_union_incomplete' using errcode = '22023'; end if;

      insert into exam_delivery.package_reserve_questions(package_version_id, package_question_id)
      select new.id, q.id
      from jsonb_array_elements_text(v_contract->'reserveQuestionIds') reserve(question_id)
      join exam_delivery.package_questions q
        on q.package_version_id = new.id and q.question_id = reserve.question_id;
      get diagnostics v_member_count = row_count;
      if v_member_count <> jsonb_array_length(v_contract->'reserveQuestionIds') then
        raise exception 'canonical_form_reserve_materialization_incomplete' using errcode = 'P0001';
      end if;
    end loop;

    new.declared_review_release_policy := 'after_submission';
    new.declared_answer_release_policy := 'after_submission';
    return new;
  end if;

  -- Existing certsim-canonical-forms-v2 implementation begins here unchanged.
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

alter function exam_delivery.prepare_canonical_forms_on_publish() owner to postgres;
revoke execute on function exam_delivery.prepare_canonical_forms_on_publish()
  from public, anon, authenticated, service_role;
grant execute on function exam_delivery.prepare_canonical_forms_on_publish() to postgres;
