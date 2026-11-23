-- Opt-in mixed-family forms. All97 prior migrations immutable; no data/default
-- mutation, enrolment, provider, schedule or activation. Existingv2 unchanged.
create function exam_delivery.mixed_variable_question_maximum(p_type text,p_presentation jsonb,p_scoring jsonb)
returns numeric language plpgsql immutable set search_path='' as $$
begin
 if p_type <> 'single-choice' then
  return exam_delivery.variable_question_maximum(p_type,p_presentation,p_scoring);
 end if;
 if jsonb_typeof(p_presentation) is distinct from 'object' or jsonb_typeof(p_scoring) is distinct from 'object'
  or p_presentation->>'interactionVersion' is distinct from 'selected-response-v1'
  or jsonb_typeof(p_presentation->'prompt') is distinct from 'string' or nullif(btrim(p_presentation->>'prompt'),'') is null
  or jsonb_typeof(p_presentation->'options') is distinct from 'array'
  then raise exception 'variable_form_response_invalid'; end if;
 if jsonb_array_length(p_presentation->'options')=0
  or exists(select 1 from jsonb_array_elements(p_presentation->'options') o where
    jsonb_typeof(o->'id') is distinct from 'string' or nullif(btrim(o->>'id'),'') is null
    or jsonb_typeof(o->'text') is distinct from 'string' or nullif(btrim(o->>'text'),'') is null)
  or (select count(distinct o->>'id') from jsonb_array_elements(p_presentation->'options') o) <> jsonb_array_length(p_presentation->'options')
  or p_scoring->>'model' is distinct from 'exact-single-v1'
  or jsonb_typeof(p_scoring->'correctOptionId') is distinct from 'string'
  or nullif(btrim(p_scoring->>'correctOptionId'),'') is null or p_scoring ? 'correctAnswer'
  or not exists(select 1 from jsonb_array_elements(p_presentation->'options') o where o->'id'=p_scoring->'correctOptionId')
  or p_scoring->'maximumRawPoints' is distinct from '1'::jsonb
  then raise exception 'variable_form_scoring_invalid'; end if;
 return 1;
end $$;
revoke all on function exam_delivery.mixed_variable_question_maximum(text,jsonb,jsonb) from public,anon,authenticated,service_role;

-- Same full blueprint/partition validator, distinct new opt-in identity; the
-- four structured families delegate to their unchangedv2 validation helper.
create function exam_delivery.prepare_mixed_variable_forms(p_package uuid)
returns void language plpgsql security definer set search_path = '' set statement_timeout = '15s' as $$
declare p record; c jsonb; f jsonb; b jsonb; policy jsonb; member record; v_question record;
  f_id uuid; n integer; ordinal integer; actual_max numeric; declared_counts jsonb; actual_counts jsonb;
begin
  if not exists (select 1 from exam_delivery.package_versions v where v.id=p_package
    and v.generator_version='certsim-python-standard-variable-forms-v3'
    and v.scorer_version='certsim-versioned-structured-partial-v1') then raise exception 'variable_form_runtime_invalid'; end if;
  for v_question in select q.*,pc.scoring_payload,pc.authoring_metadata from exam_delivery.package_questions q
    join exam_delivery.package_question_protected_content pc on pc.question_id=q.id and pc.package_version_id=p_package
    where q.package_version_id=p_package loop
    if v_question.authoring_metadata->'scored' is distinct from 'true'::jsonb
      or coalesce(v_question.authoring_metadata->'group','{}'::jsonb) not in ('{}'::jsonb,'null'::jsonb)
      then raise exception 'variable_form_response_invalid'; end if;
    perform exam_delivery.mixed_variable_question_maximum(v_question.question_type,v_question.presentation_payload,v_question.scoring_payload);
  end loop;
  for p in select * from exam_delivery.package_profiles where package_version_id=p_package loop
    c := p.selection_config->'canonicalForms'; policy := c->'countPolicy';
    if not exam_delivery.json_has_exact_keys(c,array['contractVersion','cycleLength','reservePolicy','reserveQuestionIds','deliveryContract','countPolicy','forms'])
      or c->>'contractVersion' is distinct from 'certsim-python-standard-variable-forms-v3'
      or c->>'deliveryContract' is distinct from 'certsim-authorised-form-count-v2'
      or c->>'reservePolicy' is distinct from 'profile-specific-reserve'
      or p.selection_config->'formalReleasePolicy' is distinct from '{"review":"after_submission","answers":"after_submission"}'::jsonb
      or not exam_delivery.variable_form_integer(c->'cycleLength',20)
      or jsonb_typeof(c->'forms') is distinct from 'array'
      or jsonb_typeof(c->'reserveQuestionIds') is distinct from 'array'
      or not exam_delivery.json_has_exact_keys(policy,array['mode','allowedCounts','minimum','maximum'])
      or policy->>'mode' is distinct from 'authorised-form-counts-v1'
      or jsonb_typeof(policy->'allowedCounts') is distinct from 'array'
      then raise exception 'variable_form_contract_invalid'; end if;
    if (c->>'cycleLength')::integer < 2 or jsonb_array_length(c->'forms') <> (c->>'cycleLength')::integer
      or jsonb_array_length(policy->'allowedCounts') < 2
      or exists (select 1 from jsonb_array_elements(policy->'allowedCounts') x where not exam_delivery.variable_form_integer(x) or x='0'::jsonb)
      then raise exception 'variable_form_count_policy_invalid'; end if;
    select jsonb_agg(x order by (x::text)::integer) into declared_counts from (select distinct value x from jsonb_array_elements(policy->'allowedCounts')) s;
    if declared_counts <> policy->'allowedCounts' or policy->'minimum' <> declared_counts->0
      or policy->'maximum' <> declared_counts->-1 or p.question_count <> (policy->>'maximum')::integer
      or coalesce(p.selection_config->'standardQuestionCount',p.selection_config->'normalScoredQuestionCount',to_jsonb(p.question_count)) <> to_jsonb(p.question_count)
      or exists (select 1 from jsonb_each(p.selection_config) x where x.key in ('caseStudyCount','caseStudyQuestionCount','pbqCount','executableCount','longCaseStudyCount','shortCaseStudyCount') and x.value <> '0'::jsonb)
      then raise exception 'variable_form_count_policy_invalid'; end if;
    if exists (select 1 from jsonb_array_elements(c->'reserveQuestionIds') x where jsonb_typeof(x) <> 'string')
      or (select count(*) <> count(distinct value) from jsonb_array_elements(c->'reserveQuestionIds'))
      or exists (select 1 from jsonb_array_elements_text(c->'reserveQuestionIds') x where not exists (select 1 from exam_delivery.package_questions q where q.package_version_id=p_package and q.question_id=x))
      then raise exception 'variable_form_reserve_invalid'; end if;
    ordinal := 0;
    for f in select value from jsonb_array_elements(c->'forms') loop
      ordinal := ordinal+1;
      if not exam_delivery.json_has_exact_keys(f,array['formKey','ordinal','questionCount','questionIds','membershipHash','rawMaximum','blueprint'])
        or not exam_delivery.variable_form_integer(f->'questionCount') or f->'questionCount'='0'::jsonb
        or not exam_delivery.variable_form_integer(f->'ordinal',20) or (f->>'ordinal')::integer <> ordinal
        or jsonb_typeof(f->'formKey') is distinct from 'string' or nullif(btrim(f->>'formKey'),'') is null
        or jsonb_typeof(f->'questionIds') is distinct from 'array'
        or not policy->'allowedCounts' @> jsonb_build_array(f->'questionCount')
        then raise exception 'variable_form_definition_invalid'; end if;
      n := (f->>'questionCount')::integer; b := f->'blueprint';
      if jsonb_array_length(f->'questionIds') <> n
        or (select count(distinct value) from jsonb_array_elements(f->'questionIds')) <> n
        or exists (select 1 from jsonb_array_elements(f->'questionIds') x where jsonb_typeof(x) <> 'string')
        or f->>'membershipHash' is distinct from exam_delivery.canonical_sha256(f->'questionIds')
        then raise exception 'variable_form_membership_invalid'; end if;
      if not exam_delivery.json_has_exact_keys(b,array['composition','domainCounts','requiredObjectiveKeys','minimumCoverageTagCounts','difficultyRequirements'])
        or b->'composition' is distinct from jsonb_build_object('standardQuestionCount',n,'caseStudyCount',0,'caseStudyQuestionCount',0,'pbqCount',0,'executableCount',0)
        or jsonb_typeof(b->'domainCounts') is distinct from 'object'
        or jsonb_typeof(b->'requiredObjectiveKeys') is distinct from 'array'
        or jsonb_typeof(b->'minimumCoverageTagCounts') is distinct from 'object'
        or not exam_delivery.json_has_exact_keys(b->'difficultyRequirements',array['minimumMedium','minimumHardOrAdvanced','minimumAdvanced'])
        then raise exception 'variable_form_blueprint_invalid'; end if;
      actual_max := 0;
      for member in select value id from jsonb_array_elements_text(f->'questionIds') loop
        select pq.*,pc.scoring_payload,pc.authoring_metadata into v_question from exam_delivery.package_questions pq
          join exam_delivery.package_question_protected_content pc on pc.question_id=pq.id and pc.package_version_id=p_package
          where pq.package_version_id=p_package and pq.question_id=member.id;
        if not found or c->'reserveQuestionIds' ? member.id
          or exists (select 1 from exam_delivery.package_form_questions fq where fq.package_profile_id=p.id and fq.package_question_id=v_question.id)
          then raise exception 'variable_form_membership_invalid'; end if;
        if v_question.authoring_metadata->'scored' is distinct from 'true'::jsonb
          or coalesce(v_question.authoring_metadata->'group','{}'::jsonb) not in ('{}'::jsonb,'null'::jsonb)
          then raise exception 'variable_form_response_invalid'; end if;
        actual_max := actual_max + exam_delivery.mixed_variable_question_maximum(v_question.question_type,v_question.presentation_payload,v_question.scoring_payload);
        if v_question.presentation_payload->>'difficulty' is null or v_question.presentation_payload->>'difficulty' not in ('easy','medium','hard','advanced')
          or jsonb_typeof(v_question.presentation_payload->'coverageTags') is distinct from 'array'
          then raise exception 'variable_form_blueprint_invalid'; end if;
        if exists (select 1 from jsonb_array_elements(v_question.presentation_payload->'coverageTags') x where jsonb_typeof(x) <> 'string' or nullif(btrim(x#>>'{}'),'') is null)
          or (select count(*) <> count(distinct value) from jsonb_array_elements(v_question.presentation_payload->'coverageTags'))
          then raise exception 'variable_form_blueprint_invalid'; end if;
      end loop;
      if jsonb_typeof(f->'rawMaximum') is distinct from 'number' or (f->>'rawMaximum')::numeric <> actual_max then raise exception 'variable_form_raw_maximum_invalid'; end if;
      insert into exam_delivery.package_forms(package_version_id,package_profile_id,form_key,form_ordinal,question_count,membership_hash,blueprint_contract)
        values(p_package,p.id,f->>'formKey',ordinal,n,f->>'membershipHash',jsonb_build_object('contractVersion',c->'contractVersion','questionCount',n,'rawMaximum',actual_max,'blueprint',b)) returning id into f_id;
      insert into exam_delivery.package_form_questions(form_id,package_profile_id,package_version_id,package_question_id,presentation_ordinal)
        select f_id,p.id,p_package,pq.id,x.ordinality::integer from jsonb_array_elements_text(f->'questionIds') with ordinality x(id,ordinality)
        join exam_delivery.package_questions pq on pq.package_version_id=p_package and pq.question_id=x.id;
      if (select count(*) from exam_delivery.package_form_questions where form_id=f_id) <> n then raise exception 'variable_form_materialization_incomplete'; end if;
      -- Every declared domain must match; sum equality also excludes undeclared domains.
      if exists (select 1 from jsonb_each(b->'domainCounts') x where nullif(btrim(x.key),'') is null or not exam_delivery.variable_form_integer(x.value)
          or (select count(*) from exam_delivery.package_form_questions fq join exam_delivery.package_questions pq on pq.id=fq.package_question_id where fq.form_id=f_id and pq.domain_key=x.key) <> (x.value::text)::integer)
        or (select coalesce(sum((value::text)::integer),0) from jsonb_each(b->'domainCounts')) <> n
        or jsonb_array_length(b->'requiredObjectiveKeys') = 0
        or (select count(*) <> count(distinct value) from jsonb_array_elements(b->'requiredObjectiveKeys'))
        or exists (select 1 from jsonb_array_elements(b->'requiredObjectiveKeys') x where jsonb_typeof(x) <> 'string' or nullif(btrim(x#>>'{}'),'') is null
          or not exists (select 1 from exam_delivery.package_form_questions fq join exam_delivery.package_questions pq on pq.id=fq.package_question_id where fq.form_id=f_id and coalesce(pq.section_key,pq.presentation_payload->>'officialObjectiveKey')=x#>>'{}'))
        or exists (select 1 from jsonb_each(b->'minimumCoverageTagCounts') x where nullif(btrim(x.key),'') is null or not exam_delivery.variable_form_integer(x.value,n)
          or (select count(*) from exam_delivery.package_form_questions fq join exam_delivery.package_questions pq on pq.id=fq.package_question_id where fq.form_id=f_id and pq.presentation_payload->'coverageTags' ? x.key) < (x.value::text)::integer)
        or exists (select 1 from jsonb_each(b->'difficultyRequirements') x where not exam_delivery.variable_form_integer(x.value,n)
          or (select count(*) from exam_delivery.package_form_questions fq join exam_delivery.package_questions pq on pq.id=fq.package_question_id where fq.form_id=f_id and case x.key when 'minimumMedium' then pq.presentation_payload->>'difficulty'='medium' when 'minimumHardOrAdvanced' then pq.presentation_payload->>'difficulty' in ('hard','advanced') when 'minimumAdvanced' then pq.presentation_payload->>'difficulty'='advanced' else false end) < (x.value::text)::integer)
        then raise exception 'variable_form_blueprint_invalid'; end if;
    end loop;
    select jsonb_agg(x order by x) into actual_counts from (select distinct question_count x from exam_delivery.package_forms where package_profile_id=p.id) s;
    if actual_counts <> declared_counts
      or (select count(*) from exam_delivery.package_form_questions where package_profile_id=p.id) + jsonb_array_length(c->'reserveQuestionIds') <> (select count(*) from exam_delivery.package_questions where package_version_id=p_package)
      then raise exception 'variable_form_partition_invalid'; end if;
  end loop;
  insert into exam_delivery.package_reserve_questions(package_version_id,package_question_id)
    select p_package,q.id from exam_delivery.package_questions q where q.package_version_id=p_package
      and not exists (select 1 from exam_delivery.package_form_questions fq where fq.package_version_id=p_package and fq.package_question_id=q.id);
exception when others then
  -- No protected values or parser details escape the publication boundary.
  if sqlerrm ~ '^variable_form_[a-z_]+$' then
    raise exception using message=sqlerrm,errcode='22023';
  end if;
  raise exception using message='variable_form_publication_invalid_'||sqlstate,errcode='22023';
end $$;
revoke all on function exam_delivery.prepare_mixed_variable_forms(uuid) from public,anon,authenticated,service_role;
do $mixed$
declare d text; a text := $needle$p_generator in ('certsim-python-standard-canonical-forms-v1','certsim-python-standard-variable-forms-v2')$needle$; b text := $replacement$p_generator in ('certsim-python-standard-canonical-forms-v1','certsim-python-standard-variable-forms-v2','certsim-python-standard-variable-forms-v3')$replacement$;
begin
 d := pg_get_functiondef('exam_delivery.package_v2_runtime_supported(text,text,text)'::regprocedure);
 if (length(d)-length(replace(d,a,'')))/length(a) <> 1 then raise exception 'issue214_mixed_contract_drift'; end if;
 execute replace(d,a,b);
end $mixed$;
do $mixed$
declare d text; a text := $needle$v_actual_hash := exam_delivery.canonical_sha256(v_payload);$needle$; b text := $replacement$v_actual_hash := exam_delivery.canonical_sha256(v_payload);
  if (v_payload#>>'{runtime,generatorVersion}'='certsim-python-standard-variable-forms-v3'
    or exists(select 1 from jsonb_array_elements(v_payload->'profiles') p where p#>>'{selection,canonicalForms,contractVersion}'='certsim-python-standard-variable-forms-v3'))
    and exists(select 1 from jsonb_array_elements(v_payload->'questions') q where q ? 'scored' and q->'scored' is distinct from 'true'::jsonb)
    then raise exception 'variable_form_scored_invalid' using errcode='22023'; end if;
  if v_payload#>>'{runtime,generatorVersion}'='certsim-python-standard-variable-forms-v3' and exists(
    select 1 from jsonb_array_elements_text(v_payload#>'{exam,capabilities}') c where c not in
     ('single-choice','true-false-single-v1','true-false-composite-v1','matching-v1','code-dropdown-completion-v1'))
    then raise exception 'variable_form_capability_unsupported' using errcode='22023'; end if;
$replacement$;
begin
 d := pg_get_functiondef('exam_delivery.publish_package_v2(jsonb)'::regprocedure);
 if (length(d)-length(replace(d,a,'')))/length(a) <> 1 then raise exception 'issue214_mixed_contract_drift'; end if;
 execute replace(d,a,b);
end $mixed$;
do $mixed$
declare d text; a text := $needle$  if new.generator_version = 'certsim-python-standard-variable-forms-v2'$needle$; b text := $replacement$  if new.generator_version = 'certsim-python-standard-variable-forms-v3' or exists(select 1 from exam_delivery.package_profiles pp
    where pp.package_version_id=new.id and pp.selection_config#>>'{canonicalForms,contractVersion}'='certsim-python-standard-variable-forms-v3') then
    perform exam_delivery.prepare_mixed_variable_forms(new.id);
    new.declared_review_release_policy := 'after_submission';
    new.declared_answer_release_policy := 'after_submission';
    return new;
  end if;
  if new.generator_version = 'certsim-python-standard-variable-forms-v2'$replacement$;
begin
 d := pg_get_functiondef('exam_delivery.prepare_canonical_forms_on_publish()'::regprocedure);
 if (length(d)-length(replace(d,a,'')))/length(a) <> 1 then raise exception 'issue214_mixed_contract_drift'; end if;
 execute replace(d,a,b);
end $mixed$;
do $mixed$
declare d text; a text := $needle$v_form.blueprint_contract->>'contractVersion' is distinct from 'certsim-python-standard-variable-forms-v2'$needle$; b text := $replacement$(v_form.blueprint_contract->>'contractVersion' is distinct from 'certsim-python-standard-variable-forms-v2' and v_form.blueprint_contract->>'contractVersion' is distinct from 'certsim-python-standard-variable-forms-v3')$replacement$;
begin
 d := pg_get_functiondef('exam_delivery.materialize_attempt_items(uuid,uuid,integer)'::regprocedure);
 if (length(d)-length(replace(d,a,'')))/length(a) <> 1 then raise exception 'issue214_mixed_contract_drift'; end if;
 execute replace(d,a,b);
end $mixed$;
do $mixed$
declare d text; a text := $needle$v_attempt.selection_config#>>'{canonicalForms,contractVersion}'='certsim-python-standard-variable-forms-v2'$needle$; b text := $replacement$v_attempt.selection_config#>>'{canonicalForms,contractVersion}' in ('certsim-python-standard-variable-forms-v2','certsim-python-standard-variable-forms-v3')$replacement$;
begin
 d := pg_get_functiondef('exam_delivery.materialize_attempt_items_issue21_unrotated_base(uuid,uuid,integer)'::regprocedure);
 if (length(d)-length(replace(d,a,'')))/length(a) <> 1 then raise exception 'issue214_mixed_contract_drift'; end if;
 execute replace(d,a,b);
end $mixed$;

create or replace function exam_delivery.guard_variable_attempt_start()
returns trigger language plpgsql security definer set search_path='' as $$
declare version text; negotiated text := current_setting('certsim.count_contract',true);
begin
 select p.selection_config#>>'{canonicalForms,contractVersion}' into version
  from exam_delivery.package_profiles p where p.id=new.package_profile_id;
 -- All newv3 starts negotiate presentation/delivery support, including practice.
 -- Practice still has no formal allocation or count-override restriction.
 if version='certsim-python-standard-variable-forms-v3' and negotiated is distinct from 'certsim-authorised-form-count-v2'
  then raise exception 'count_contract_required' using errcode='22023'; end if;
 if new.purpose in ('assigned_assessment','self_directed_exam') then
  if version in ('certsim-python-standard-variable-forms-v2','certsim-python-standard-variable-forms-v3') then
   if negotiated is distinct from 'certsim-authorised-form-count-v2' and (version='certsim-python-standard-variable-forms-v3' or negotiated is distinct from 'certsim-authorised-form-count-v1')
    then raise exception 'count_contract_required' using errcode='22023'; end if;
   if current_setting('certsim.count_requested',true)='requested'
    then raise exception 'count_override_forbidden' using errcode='22023'; end if;
  end if;
 end if;
 return new;
end $$;
create or replace function exam_delivery.attempt_presentation_context(p_actor_id uuid,p_attempt_id uuid,p_result jsonb)
returns jsonb language plpgsql stable security definer set search_path='' set statement_timeout='3s' as $$
declare identity record; policy text;
begin
  if p_result->>'ok' is distinct from 'true' then return p_result; end if;
  if jsonb_typeof(p_result->'items') is distinct from 'array'
    then raise exception 'presentation_context_invalid' using errcode='22023'; end if;
  if not exists (select 1 from jsonb_array_elements(p_result->'items') item where item->>'questionType'='matching-v1')
    then return p_result; end if;
  if p_result ? 'attempt' and p_result#>>'{attempt,attemptId}' is distinct from p_attempt_id::text
    then raise exception 'presentation_context_invalid' using errcode='22023'; end if;
  select a.generator_version,a.scorer_version,v.generator_version package_generator,v.scorer_version package_scorer,
    p.selection_config#>>'{canonicalForms,contractVersion}' form_contract,
    p.selection_config ? 'canonicalForms' declared_form into identity
    from exam_delivery.attempts a join exam_delivery.package_versions v on v.id=a.package_version_id
    join exam_delivery.package_profiles p on p.id=a.package_profile_id and p.package_version_id=a.package_version_id
    where a.id=p_attempt_id and a.owner_id=p_actor_id;
  if not found or identity.generator_version is distinct from identity.package_generator
    or identity.scorer_version is distinct from identity.package_scorer
    then raise exception 'presentation_context_invalid' using errcode='22023'; end if;
  if identity.generator_version in ('certsim-python-standard-variable-forms-v2','certsim-python-standard-variable-forms-v3')
    or identity.form_contract in ('certsim-python-standard-variable-forms-v2','certsim-python-standard-variable-forms-v3') then
    if identity.generator_version is distinct from identity.form_contract
      or identity.scorer_version is distinct from 'certsim-versioned-structured-partial-v1'
      then raise exception 'presentation_context_invalid' using errcode='22023'; end if;
    policy := 'strict-boolean-default-false';
  elsif coalesce(exam_delivery.package_v2_runtime_supported(identity.generator_version,identity.scorer_version,null),false)
    and (not identity.declared_form or identity.form_contract in ('certsim-canonical-forms-v2','certsim-python-standard-forms-v1')) then
    policy := 'legacy-preserve';
  else raise exception 'presentation_context_invalid' using errcode='22023';
  end if;
  return p_result || jsonb_build_object('presentationPolicy',jsonb_build_object(
    'version','certsim-attempt-presentation-v1','attemptId',p_attempt_id,'matchingReuse',policy));
end $$;
create or replace function exam_delivery.resume_attempt(p_actor_id uuid,p_attempt_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' set statement_timeout='10s' as $$
declare r jsonb; a record; bindings jsonb;
begin
  r := exam_delivery.resume_attempt_issue214_fixed_base(p_actor_id,p_attempt_id);
  if r->>'ok'='false' then return r; end if;
  r := exam_delivery.attempt_presentation_context(p_actor_id,p_attempt_id,r);
  select at.purpose,f.question_count,p.selection_config into a from exam_delivery.attempts at
    join exam_delivery.package_profiles p on p.id=at.package_profile_id
    join exam_delivery.package_forms f on f.id=at.canonical_form_id
    where at.id=p_attempt_id and at.owner_id=p_actor_id
      and p.selection_config#>>'{canonicalForms,contractVersion}' in ('certsim-python-standard-variable-forms-v2','certsim-python-standard-variable-forms-v3');
  if found then
    if current_setting('certsim.count_contract',true) is distinct from 'certsim-authorised-form-count-v2' and (a.selection_config#>>'{canonicalForms,contractVersion}'='certsim-python-standard-variable-forms-v3' or current_setting('certsim.count_contract',true) is distinct from 'certsim-authorised-form-count-v1')
      then return jsonb_build_object('ok',false,'code','count_contract_required'); end if;
    select jsonb_agg(jsonb_build_object('itemId',i.id,'questionId',q.question_id,'questionType',q.question_type,
      'questionNumber',i.presented_question_number) order by i.presented_question_number) into bindings
      from exam_delivery.attempt_items i join exam_delivery.package_questions q on q.id=i.package_question_id where i.attempt_id=p_attempt_id;
    r := jsonb_set(r,'{attempt,countContract}',jsonb_build_object('version',case when a.selection_config#>>'{canonicalForms,contractVersion}'='certsim-python-standard-variable-forms-v3' then 'certsim-authorised-form-count-v2' else 'certsim-authorised-form-count-v1' end,
      'mode','variable','exactCount',a.question_count,'allowedCounts',a.selection_config#>'{canonicalForms,countPolicy,allowedCounts}',
      'composition',jsonb_build_object('standardQuestionCount',a.question_count,'caseStudyCount',0,'caseStudyQuestionCount',0,'pbqCount',0,'executableCount',0),
      'bindings',bindings));
  end if;
  return r;
end $$;
create or replace function exam_delivery.variable_count_policy(p_result jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare c jsonb;
begin
  if p_result->>'purpose' not in ('assigned_assessment','self_directed_exam')
    or (p_result->>'eligible' is distinct from 'true' and p_result->>'ok' is distinct from 'true') then return p_result; end if;
  select p.selection_config->'canonicalForms' into c from exam_delivery.package_profiles p
    join exam_delivery.package_versions v on v.id=p.package_version_id
    where exam_delivery.normalize_exam_key(v.exam_key)=exam_delivery.normalize_exam_key(p_result->>'examKey')
      and v.package_version=p_result->>'packageVersion' and p.profile_key=p_result->>'profileKey'
      and p.selection_config#>>'{canonicalForms,contractVersion}' in ('certsim-python-standard-variable-forms-v2','certsim-python-standard-variable-forms-v3');
  if not found then return p_result; end if;
  if current_setting('certsim.count_contract',true) is distinct from 'certsim-authorised-form-count-v2' and (c->>'contractVersion'='certsim-python-standard-variable-forms-v3' or current_setting('certsim.count_contract',true) is distinct from 'certsim-authorised-form-count-v1') then
    return p_result || jsonb_build_object('eligible',false,'available',false,'reasonCode','count_contract_required','code','count_contract_required');
  end if;
  return p_result || jsonb_build_object('fixedProfileSize',false,'countPolicy',
    (c->'countPolicy') || jsonb_build_object('version',case when c->>'contractVersion'='certsim-python-standard-variable-forms-v3' then 'certsim-authorised-form-count-v2' else 'certsim-authorised-form-count-v1' end));
end $$;
create or replace function exam_delivery.assert_variable_attempt_complete()
returns trigger language plpgsql security definer set search_path='' as $$
declare a record; n integer;
begin
  select at.*,f.question_count into a from exam_delivery.attempts at
    join exam_delivery.package_profiles p on p.id=at.package_profile_id
    left join exam_delivery.package_forms f on f.id=at.canonical_form_id and f.package_profile_id=at.package_profile_id
    where at.id=new.id and at.purpose in ('assigned_assessment','self_directed_exam')
      and p.selection_config#>>'{canonicalForms,contractVersion}' in ('certsim-python-standard-variable-forms-v2','certsim-python-standard-variable-forms-v3');
  if not found then return null; end if;
  if a.canonical_form_id is null or a.canonical_form_cycle is null or a.question_count is null
    or (select count(*) from exam_delivery.attempt_items where attempt_id=a.id) <> a.question_count
    or exists (select 1 from exam_delivery.package_form_questions fq where fq.form_id=a.canonical_form_id
      and not exists (select 1 from exam_delivery.attempt_items i where i.attempt_id=a.id
        and i.package_question_id=fq.package_question_id and i.presented_question_number=fq.presentation_ordinal))
    then raise exception 'variable_attempt_initialization_incomplete' using errcode='23514'; end if;
  return null;
end $$;
create or replace function exam_delivery.list_current_attempt_bindings(p_actor_id uuid,p_exam_key text,p_purpose text)
returns jsonb language plpgsql stable security definer set search_path='' set statement_timeout='5s' as $$
declare r jsonb; candidate jsonb; c jsonb; n integer; candidates jsonb := '[]'::jsonb;
begin
  r := exam_delivery.list_current_attempt_bindings_issue214_fixed_base(p_actor_id,p_exam_key,p_purpose);
  for candidate in select value from jsonb_array_elements(r->'candidates') loop
    select p.selection_config->'canonicalForms',f.question_count into c,n from exam_delivery.attempts a
      join exam_delivery.package_profiles p on p.id=a.package_profile_id
      join exam_delivery.package_forms f on f.id=a.canonical_form_id
      where a.id=(candidate->>'attemptId')::uuid and a.owner_id=p_actor_id
        and p.selection_config#>>'{canonicalForms,contractVersion}' in ('certsim-python-standard-variable-forms-v2','certsim-python-standard-variable-forms-v3');
    if found then
      candidate := candidate || jsonb_build_object('selectedCount',n,'countPolicy',
        (c->'countPolicy') || jsonb_build_object('version',case when c->>'contractVersion'='certsim-python-standard-variable-forms-v3' then 'certsim-authorised-form-count-v2' else 'certsim-authorised-form-count-v1' end),
        'profileComposition',(candidate->'profileComposition') || jsonb_build_object('questionCount',n,
          'standardQuestionCount',n,'caseStudyCount',0,'caseStudyQuestionCount',0,'pbqCount',0,'executableCount',0));
    end if;
    candidates := candidates || jsonb_build_array(candidate);
  end loop;
  return r || jsonb_build_object('candidates',candidates);
end $$;
create or replace function exam_delivery.print_summary(p_actor_id uuid,p_attempt_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' set statement_timeout='5s' as $$
declare r jsonb; counts jsonb;
begin
  r := exam_delivery.print_summary_issue214_fixed_base(p_actor_id,p_attempt_id);
  if r->>'ok' is distinct from 'true' or r->>'source' is distinct from 'protected' then return r; end if;
  select jsonb_build_object('questionCount',f.question_count,'answeredCount',ar.result_summary->'answeredCount','rawMaximum',ar.max_score)
    into counts from exam_delivery.attempts a join exam_delivery.package_profiles p on p.id=a.package_profile_id
    join exam_delivery.package_forms f on f.id=a.canonical_form_id join exam_delivery.attempt_results ar on ar.attempt_id=a.id
    where a.id=p_attempt_id and p.selection_config#>>'{canonicalForms,contractVersion}' in ('certsim-python-standard-variable-forms-v2','certsim-python-standard-variable-forms-v3');
  return r || coalesce(counts,'{}'::jsonb);
end $$;

-- New negotiated transport; inherited argument/override/actor checks unchanged.
create function public.certsim_protected_mixed_count_contract(p_actor_id uuid,p_operation text,p_arguments jsonb,p_count_contract text)
returns jsonb language plpgsql volatile security invoker set search_path='' set statement_timeout='15s' as $$
declare r jsonb; previous_contract text := current_setting('certsim.count_contract',true);
  previous_requested text := current_setting('certsim.count_requested',true);
  allowed_arguments text[];
begin
  if p_count_contract is distinct from 'certsim-authorised-form-count-v2' or jsonb_typeof(p_arguments) is distinct from 'object'
    then return jsonb_build_object('ok',false,'code','count_contract_required'); end if;
  allowed_arguments := case p_operation
    when 'eligibility' then array['p_exam_key','p_package_version','p_profile_key','p_purpose']
    when 'current' then array['p_exam_key','p_profile_key','p_purpose','p_language','p_assignment_id']
    when 'start' then array['p_exam_key','p_profile_key','p_request_id','p_assignment_id']
    when 'resume' then array['p_attempt_id']
    when 'practiceAvailability' then array['p_request']
    when 'practiceStart' then array['p_request']
    when 'practiceReplace' then array['p_request'] else null end;
  if allowed_arguments is null or exists (select 1 from jsonb_object_keys(p_arguments) k where not k=any(allowed_arguments))
    then raise exception 'count_override_forbidden' using errcode='22023'; end if;
  if p_arguments ? 'p_request' then
    if jsonb_typeof(p_arguments->'p_request') is distinct from 'object' then raise exception 'count_override_forbidden' using errcode='22023'; end if;
    if exists (select 1 from jsonb_object_keys(p_arguments->'p_request') k where not k=any(array[
      'examKey','profileId','purpose','language','count','clientRequestId','includePbqs','mixStrategy','domain','objective','contentKind','assignmentId']))
      then raise exception 'count_override_forbidden' using errcode='22023'; end if;
  end if;
  perform set_config('certsim.count_contract',p_count_contract,true);
  perform set_config('certsim.count_requested',case when p_arguments#>'{p_request}' ? 'count' then 'requested' else '' end,true);
  if p_operation in ('practiceStart','practiceReplace') then
    if p_arguments#>'{p_request}' ?| array['formId','canonicalFormId','questionCount','exactCount','allowedCounts'] then
      raise exception 'count_override_forbidden' using errcode='22023'; end if;
    if p_arguments#>'{p_request}' ? 'count' then
      r := public.certsim_protected_practice_availability(p_actor_id,p_arguments->'p_request');
      if r ? 'countPolicy' then raise exception 'count_override_forbidden' using errcode='22023'; end if;
    end if;
  end if;
  case p_operation
    when 'eligibility' then r := public.certsim_protected_check_profile_eligibility(p_actor_id,p_arguments->>'p_exam_key',p_arguments->>'p_package_version',p_arguments->>'p_profile_key',(p_arguments->>'p_purpose')::exam_delivery.attempt_purpose);
    when 'practiceAvailability' then r := public.certsim_protected_practice_availability(p_actor_id,p_arguments->'p_request');
    when 'start' then r := public.certsim_protected_start_attempt(p_actor_id,p_arguments->>'p_exam_key',p_arguments->>'p_profile_key',(p_arguments->>'p_request_id')::uuid,(p_arguments->>'p_assignment_id')::uuid);
    when 'practiceStart' then r := public.certsim_protected_start_practice(p_actor_id,p_arguments->'p_request');
    when 'practiceReplace' then r := public.certsim_protected_replace_current_practice_attempt(p_actor_id,p_arguments->'p_request');
    when 'resume' then r := public.certsim_protected_resume_attempt(p_actor_id,(p_arguments->>'p_attempt_id')::uuid);
    when 'current' then r := public.certsim_protected_discover_current_formal_attempt(p_actor_id,p_arguments->>'p_exam_key',p_arguments->>'p_profile_key',p_arguments->>'p_purpose',p_arguments->>'p_language',(p_arguments->>'p_assignment_id')::uuid);
    else raise exception 'count_operation_invalid' using errcode='22023';
  end case;
  perform set_config('certsim.count_contract',coalesce(previous_contract,''),true);
  perform set_config('certsim.count_requested',coalesce(previous_requested,''),true);
  return r;
exception when others then
  perform set_config('certsim.count_contract',coalesce(previous_contract,''),true);
  perform set_config('certsim.count_requested',coalesce(previous_requested,''),true);
  raise;
end $$;
revoke all on function public.certsim_protected_mixed_count_contract(uuid,text,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.certsim_protected_mixed_count_contract(uuid,text,jsonb,text) to service_role;
