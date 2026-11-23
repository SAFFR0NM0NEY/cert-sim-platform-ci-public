-- Explicit fixed Python v1 profiles may coexist with variable v3 profiles.
-- No historical package mutation, activation, schedule or deployment.
create function exam_delivery.prepare_fixed_profile_in_mixed_package(p_package uuid,p_profile uuid)
returns void language plpgsql security definer set search_path='' set statement_timeout='15s' as $$
declare p record; c jsonb; f jsonb; q record; form_id uuid; ordinal integer:=0; maximum numeric; n integer;
begin
 if not exists(select 1 from exam_delivery.package_versions v where v.id=p_package
   and v.generator_version='certsim-python-standard-variable-forms-v3' and v.scorer_version='certsim-versioned-structured-partial-v1')
  or not exists(select 1 from exam_delivery.package_profiles pp where pp.package_version_id=p_package
    and pp.selection_config#>>'{canonicalForms,contractVersion}'='certsim-python-standard-variable-forms-v3')
  then raise exception 'fixed_mixed_runtime_invalid'; end if;
 select * into strict p from exam_delivery.package_profiles where id=p_profile and package_version_id=p_package;
 c:=p.selection_config->'canonicalForms';
 if not exam_delivery.json_has_exact_keys(c,array['contractVersion','cycleLength','reservePolicy','reserveQuestionIds','forms'])
  or c->>'contractVersion' is distinct from 'certsim-python-standard-forms-v1'
  or c->>'reservePolicy' is distinct from 'profile-specific-reserve'
  or not exam_delivery.variable_form_integer(c->'cycleLength',20) or (c->>'cycleLength')::integer<2
  or jsonb_typeof(c->'forms') is distinct from 'array' or jsonb_typeof(c->'reserveQuestionIds') is distinct from 'array'
  or not exam_delivery.variable_form_integer(to_jsonb(p.question_count)) or p.question_count<1
  or (p.selection_config ? 'formalReleasePolicy' and p.selection_config->'formalReleasePolicy' is distinct from '{"review":"after_submission","answers":"after_submission"}'::jsonb)
  then raise exception 'fixed_mixed_profile_contract_invalid'; end if;
 if jsonb_array_length(c->'forms')<>(c->>'cycleLength')::integer
  or exists(select 1 from jsonb_array_elements(c->'reserveQuestionIds') x where jsonb_typeof(x)<>'string' or nullif(btrim(x#>>'{}'),'') is null)
  or (select count(*)<>count(distinct value) from jsonb_array_elements(c->'reserveQuestionIds'))
  or exists(select 1 from jsonb_array_elements_text(c->'reserveQuestionIds') x where not exists(select 1 from exam_delivery.package_questions pq where pq.package_version_id=p_package and pq.question_id=x))
  then raise exception 'fixed_mixed_reserve_invalid'; end if;
 for f in select value from jsonb_array_elements(c->'forms') loop
  ordinal:=ordinal+1;
  if not exam_delivery.json_has_exact_keys(f,array['formKey','ordinal','questionIds','membershipHash','rawMaximum'])
   or jsonb_typeof(f->'formKey') is distinct from 'string' or nullif(btrim(f->>'formKey'),'') is null
   or not exam_delivery.variable_form_integer(f->'ordinal',20) or (f->>'ordinal')::integer<>ordinal
   or jsonb_typeof(f->'questionIds') is distinct from 'array' or jsonb_typeof(f->'rawMaximum') is distinct from 'number'
   then raise exception 'fixed_mixed_form_invalid'; end if;
  if jsonb_array_length(f->'questionIds')<>p.question_count
   or (select count(*)<>count(distinct value) from jsonb_array_elements(f->'questionIds'))
   or exists(select 1 from jsonb_array_elements(f->'questionIds') x where jsonb_typeof(x)<>'string' or nullif(btrim(x#>>'{}'),'') is null)
   or f->>'membershipHash' is distinct from exam_delivery.canonical_sha256(f->'questionIds')
   or exists(select 1 from exam_delivery.package_forms pf where pf.package_profile_id=p_profile and pf.form_key=f->>'formKey')
   then raise exception 'fixed_mixed_membership_invalid'; end if;
  maximum:=0;n:=0;
  for q in select pq.*,pc.scoring_payload from jsonb_array_elements_text(f->'questionIds') with ordinality m(id,position)
   join exam_delivery.package_questions pq on pq.package_version_id=p_package and pq.question_id=m.id
   join exam_delivery.package_question_protected_content pc on pc.package_version_id=p_package and pc.question_id=pq.id order by m.position loop
   if c->'reserveQuestionIds' ? q.question_id or exists(select 1 from exam_delivery.package_form_questions fq where fq.package_profile_id=p_profile and fq.package_question_id=q.id)
    then raise exception 'fixed_mixed_membership_invalid'; end if;
   maximum:=maximum+exam_delivery.mixed_variable_question_maximum(q.question_type,q.presentation_payload,q.scoring_payload);n:=n+1;
  end loop;
  if n<>p.question_count or maximum<>(f->>'rawMaximum')::numeric then raise exception 'fixed_mixed_raw_maximum_invalid'; end if;
  insert into exam_delivery.package_forms(package_version_id,package_profile_id,form_key,form_ordinal,question_count,membership_hash,blueprint_contract)
   values(p_package,p_profile,f->>'formKey',ordinal,p.question_count,f->>'membershipHash',c-'forms'-'reserveQuestionIds') returning id into form_id;
  insert into exam_delivery.package_form_questions(form_id,package_profile_id,package_version_id,package_question_id,presentation_ordinal)
   select form_id,p_profile,p_package,pq.id,m.position::integer from jsonb_array_elements_text(f->'questionIds') with ordinality m(id,position)
   join exam_delivery.package_questions pq on pq.package_version_id=p_package and pq.question_id=m.id;
  get diagnostics n=row_count;
  if n<>p.question_count then raise exception 'fixed_mixed_materialization_incomplete'; end if;
 end loop;
 if (select count(*) from exam_delivery.package_form_questions where package_profile_id=p_profile)
   +jsonb_array_length(c->'reserveQuestionIds')<>(select count(*) from exam_delivery.package_questions where package_version_id=p_package)
  then raise exception 'fixed_mixed_partition_invalid'; end if;
end $$;
alter function exam_delivery.prepare_fixed_profile_in_mixed_package(uuid,uuid) owner to postgres;
revoke all on function exam_delivery.prepare_fixed_profile_in_mixed_package(uuid,uuid) from public,anon,authenticated,service_role;

-- Exact occurrence guards abort rather than patch an unexpected upstream body.
do $compat$
declare d text; needle text; replacement text;
begin
 d:=pg_get_functiondef('exam_delivery.prepare_mixed_variable_forms(uuid)'::regprocedure);
 needle:=$needle$  for p in select * from exam_delivery.package_profiles where package_version_id=p_package loop
    c := p.selection_config->'canonicalForms'; policy := c->'countPolicy';$needle$;
 replacement:=$replacement$  if not exists(select 1 from exam_delivery.package_profiles pp where pp.package_version_id=p_package
    and pp.selection_config#>>'{canonicalForms,contractVersion}'='certsim-python-standard-variable-forms-v3')
    then raise exception 'variable_form_profile_required'; end if;
  for p in select * from exam_delivery.package_profiles where package_version_id=p_package loop
    if p.selection_config#>>'{canonicalForms,contractVersion}'='certsim-python-standard-forms-v1' then
      perform exam_delivery.prepare_fixed_profile_in_mixed_package(p_package,p.id);
      continue;
    end if;
    c := p.selection_config->'canonicalForms'; policy := c->'countPolicy';$replacement$;
 if (length(d)-length(replace(d,needle,'')))/length(needle)<>1 then raise exception 'fixed_mixed_publication_contract_drift'; end if;
 execute replace(d,needle,replacement);

 d:=pg_get_functiondef('exam_delivery.attempt_presentation_context(uuid,uuid,jsonb)'::regprocedure);
 needle:=$needle$identity.generator_version is distinct from identity.form_contract$needle$;
 replacement:=$replacement$(identity.generator_version is distinct from identity.form_contract and not
      (identity.generator_version='certsim-python-standard-variable-forms-v3' and identity.form_contract='certsim-python-standard-forms-v1'))$replacement$;
 if (length(d)-length(replace(d,needle,'')))/length(needle)<>1 then raise exception 'fixed_mixed_presentation_contract_drift'; end if;
 execute replace(d,needle,replacement);

 d:=pg_get_functiondef('exam_delivery.materialize_attempt_items_issue21_unrotated_base(uuid,uuid,integer)'::regprocedure);
 needle:=$needle$v_attempt.selection_config#>>'{canonicalForms,contractVersion}' in ('certsim-python-standard-variable-forms-v2','certsim-python-standard-variable-forms-v3')$needle$;
 replacement:=$replacement$(v_attempt.selection_config#>>'{canonicalForms,contractVersion}' in ('certsim-python-standard-variable-forms-v2','certsim-python-standard-variable-forms-v3')
        or (exists(select 1 from exam_delivery.package_versions fixed_runtime where fixed_runtime.id=v_attempt.package_version_id
          and fixed_runtime.generator_version='certsim-python-standard-variable-forms-v3') and v_attempt.selection_config#>>'{canonicalForms,contractVersion}'='certsim-python-standard-forms-v1'))$replacement$;
 if (length(d)-length(replace(d,needle,'')))/length(needle)<>1 then raise exception 'fixed_mixed_practice_contract_drift'; end if;
 execute replace(d,needle,replacement);
end $compat$;
