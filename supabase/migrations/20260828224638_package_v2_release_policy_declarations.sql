-- Package release policy is a declaration of capability. Effective learner
-- release remains controlled independently by protected assignment policy.
-- Current assignment creation continues to accept only never/never.
create or replace function exam_delivery.publish_package_v2(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '15s'
as $$
declare
  v_actor uuid := auth.uid();
  v_payload jsonb := p_request->'packagePayload';
  v_request_id uuid;
  v_exam_key text;
  v_version text;
  v_source_commit text := p_request->>'sourceCommitSha';
  v_source_hash text;
  v_validation_hash text;
  v_package_hash text := p_request->>'packageHash';
  v_actual_hash text;
  v_generator text;
  v_scorer text;
  v_pbq_runtime text;
  v_package_id uuid;
  v_existing record;
  v_profile_count integer;
  v_question_count integer;
begin
  if v_actor is null then
    raise exception 'publication_auth_required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.memberships m
    where m.user_id = v_actor and m.role = 'platform_owner' and m.status = 'active'
  ) then
    raise exception 'publication_forbidden' using errcode = '42501';
  end if;
  if pg_catalog.pg_column_size(p_request) > 16777216
     or jsonb_typeof(p_request) <> 'object'
     or not exam_delivery.json_has_exact_keys(
       p_request,array['publicationRequestId','sourceCommitSha','packagePayload','packageHash']
     ) then
    raise exception 'publication_invalid_request' using errcode = '22023';
  end if;
  begin
    v_request_id := (p_request->>'publicationRequestId')::uuid;
  exception when others then
    raise exception 'publication_invalid_request' using errcode = '22023';
  end;
  if jsonb_typeof(v_payload) <> 'object'
     or v_payload->>'packageSchemaVersion' <> 'certsim-protected-package-v2'
     or v_payload->>'validationContractVersion' <> 'certsim-protected-multi-exam-validation-v1'
     or jsonb_typeof(v_payload->'exam') <> 'object'
     or jsonb_typeof(v_payload->'source') <> 'object'
     or jsonb_typeof(v_payload->'runtime') <> 'object'
     or jsonb_typeof(v_payload->'profiles') <> 'array'
     or jsonb_array_length(v_payload->'profiles') < 1
     or jsonb_typeof(v_payload->'questions') <> 'array'
     or jsonb_array_length(v_payload->'questions') < 1
     or jsonb_array_length(v_payload->'questions') > 5000 then
    raise exception 'publication_contract_unsupported' using errcode = '22023';
  end if;
  if jsonb_typeof(v_payload#>'{exam,capabilities}') <> 'array'
     or jsonb_array_length(v_payload#>'{exam,capabilities}') < 1
     or exists(
       select 1 from jsonb_array_elements_text(v_payload#>'{exam,capabilities}') capability
       where capability not in (
         'single-choice','multi-select','reorder','drag-drop-match','dropdown-code','dropdown-command',
         'case-study-context','informational','pbq-terminal','pbq-multi-host-terminal','pbq-firewall',
         'pbq-siem','pbq-network-diagram','pbq-config-panel','pbq-hotspot','pbq-drag-drop-match',
         'pbq-ordering','pbq-workspace'
       )
     ) or (
       select count(*)<>count(distinct capability)
       from jsonb_array_elements_text(v_payload#>'{exam,capabilities}') capability
     ) or exists(
       select 1 from jsonb_array_elements(v_payload->'profiles') p
       where jsonb_typeof(p)<>'object' or nullif(p->>'profileKey','') is null
         or (p->>'questionCount')::integer<1 or (p->>'timeLimitMinutes')::integer<1
         or jsonb_typeof(p->'selection')<>'object'
     ) or (
       select count(*)<>count(distinct p->>'profileKey') from jsonb_array_elements(v_payload->'profiles') p
     ) then
    raise exception 'publication_contract_unsupported' using errcode = '22023';
  end if;

  v_exam_key := exam_delivery.normalize_exam_key(v_payload#>>'{exam,examKey}');
  v_version := v_payload#>>'{exam,packageVersion}';
  v_source_hash := v_payload#>>'{source,sourceHash}';
  v_validation_hash := v_payload#>>'{source,validationHash}';
  v_generator := v_payload#>>'{runtime,generatorVersion}';
  v_scorer := v_payload#>>'{runtime,scorerVersion}';
  v_pbq_runtime := v_payload#>>'{runtime,pbqRuntimeVersion}';
  v_actual_hash := exam_delivery.canonical_sha256(v_payload);

  if v_exam_key is null or v_exam_key !~ '^[a-z0-9]+$'
     or v_version is null or v_version !~ '^[a-z0-9][a-z0-9._-]*$'
     or v_source_commit !~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
     or v_source_hash !~ '^[0-9a-f]{64}$'
     or v_validation_hash !~ '^[0-9a-f]{64}$'
     or v_package_hash !~ '^[0-9a-f]{64}$'
     or v_actual_hash <> v_package_hash
     or not exam_delivery.package_v2_runtime_supported(v_generator,v_scorer,v_pbq_runtime)
     or jsonb_typeof(v_payload->'releasePolicy') <> 'object'
     or not exam_delivery.json_has_exact_keys(v_payload->'releasePolicy',array['review','answers'])
     or (
       v_payload#>>'{releasePolicy,review}',
       v_payload#>>'{releasePolicy,answers}'
     ) not in (
       ('never','never'),
       ('after_submission','after_submission')
     ) then
    raise exception 'publication_contract_unsupported' using errcode = '22023';
  end if;

  if exists (
    select 1 from jsonb_array_elements(v_payload->'questions') q
    where jsonb_typeof(q) <> 'object'
       or nullif(q->>'id','') is null
       or nullif(q->>'type','') is null
       or nullif(q->>'domainKey','') is null
       or not (v_payload#>'{exam,capabilities}' @> jsonb_build_array(q->>'type'))
       or jsonb_typeof(q->'presentation') <> 'object'
       or jsonb_typeof(coalesce(q->'privateReview','{}'::jsonb)) <> 'object'
       or (coalesce((q->>'scored')::boolean,true) and jsonb_typeof(q->'privateScoring') <> 'object')
       or not exam_delivery.presentation_is_safe(q->'presentation')
  ) or (
    select count(*) <> count(distinct q->>'id')
    from jsonb_array_elements(v_payload->'questions') q
  ) or exists(
    select 1 from jsonb_array_elements(v_payload->'questions') q
    where q->>'type' in ('case-study-context','informational')
      and coalesce((q->>'scored')::boolean,true)
  ) or exists(
    select 1 from jsonb_array_elements(v_payload->'questions') child
    where child#>>'{group,role}'='question' and not exists(
      select 1 from jsonb_array_elements(v_payload->'questions') context
      where context#>>'{group,groupKey}'=child#>>'{group,groupKey}'
        and context#>>'{group,role}'='context' and coalesce((context->>'scored')::boolean,true)=false
    )
  ) or exists(
    select 1 from (
      select q#>>'{group,groupKey}' group_key,(q#>>'{group,order}')::integer group_order,count(*) count
      from jsonb_array_elements(v_payload->'questions') q
      where nullif(q#>>'{group,groupKey}','') is not null
      group by 1,2 having count(*)>1
    ) duplicates
  ) then
    raise exception 'publication_question_invalid' using errcode = '22023';
  end if;

  select * into v_existing from exam_delivery.publication_runs
  where publication_request_id = v_request_id;
  if found then
    if v_existing.expected_package_hash = v_package_hash
       and v_existing.expected_validation_hash = v_validation_hash
       and v_existing.source_commit_sha = v_source_commit
       and v_existing.status = 'succeeded' then
      return jsonb_build_object(
        'ok',true,'classification','idempotent_replay','replayed',true,
        'examKey',v_exam_key,'packageVersion',v_version,
        'profileCount',jsonb_array_length(v_payload->'profiles'),
        'questionCount',jsonb_array_length(v_payload->'questions'),
        'packageHash',v_package_hash,'validationHash',v_validation_hash
      );
    end if;
    raise exception 'publication_request_conflict' using errcode = '23505';
  end if;

  select * into v_existing from exam_delivery.package_versions
  where exam_key = v_exam_key and package_version = v_version;
  if found then
    if v_existing.package_hash = v_package_hash
       and v_existing.validation_hash = v_validation_hash
       and v_existing.source_commit_sha = v_source_commit
       and v_existing.package_schema_version = 'certsim-protected-package-v2' then
      return jsonb_build_object(
        'ok',true,'classification','exact_match','replayed',true,
        'examKey',v_exam_key,'packageVersion',v_version,
        'profileCount',(select count(*) from exam_delivery.package_profiles where package_version_id=v_existing.id),
        'questionCount',(select count(*) from exam_delivery.package_questions where package_version_id=v_existing.id),
        'packageHash',v_package_hash,'validationHash',v_validation_hash
      );
    end if;
    raise exception 'publication_identity_conflict' using errcode = '23505';
  end if;
  if exists (select 1 from exam_delivery.package_versions where package_hash=v_package_hash) then
    raise exception 'publication_hash_conflict' using errcode = '23505';
  end if;

  insert into exam_delivery.package_versions(
    exam_key,package_version,source_commit_sha,validation_hash,package_hash,
    package_schema_version,generator_version,scorer_version,status
  ) values (
    v_exam_key,v_version,v_source_commit,v_validation_hash,v_package_hash,
    'certsim-protected-package-v2',v_generator,v_scorer,'draft'
  ) returning id into v_package_id;

  insert into exam_delivery.package_profiles(
    package_version_id,profile_key,display_name,question_count,time_limit_minutes,selection_config
  )
  select v_package_id,p->>'profileKey',coalesce(nullif(p->>'displayName',''),p->>'profileKey'),
         (p->>'questionCount')::integer,(p->>'timeLimitMinutes')::integer,p->'selection'
  from jsonb_array_elements(v_payload->'profiles') p;
  get diagnostics v_profile_count = row_count;

  with source as (
    select q,ordinality::integer ordinal
    from jsonb_array_elements(v_payload->'questions') with ordinality as value(q,ordinality)
  ), inserted as (
    insert into exam_delivery.package_questions(
      package_version_id,question_id,question_type,domain_key,section_key,
      source_ordinal,presentation_payload,content_hash
    )
    select v_package_id,q->>'id',q->>'type',q->>'domainKey',nullif(q->>'sectionKey',''),
           ordinal,q->'presentation',exam_delivery.canonical_sha256(jsonb_build_object(
             'presentation',q->'presentation','scoring',coalesce(q->'privateScoring','{}'::jsonb),
             'review',coalesce(q->'privateReview','{}'::jsonb),'group',coalesce(q->'group','{}'::jsonb),
             'scored',coalesce((q->>'scored')::boolean,true)
           ))
    from source
    returning id,question_id
  )
  insert into exam_delivery.package_question_protected_content(
    question_id,package_version_id,scoring_payload,review_payload,authoring_metadata
  )
  select i.id,v_package_id,coalesce(q->'privateScoring','{}'::jsonb),
         coalesce(q->'privateReview','{}'::jsonb),
         jsonb_build_object('scored',coalesce((q->>'scored')::boolean,true),'group',coalesce(q->'group','{}'::jsonb))
  from inserted i
  join jsonb_array_elements(v_payload->'questions') q on q->>'id'=i.question_id;
  get diagnostics v_question_count = row_count;

  if v_profile_count <> jsonb_array_length(v_payload->'profiles')
     or v_question_count <> jsonb_array_length(v_payload->'questions') then
    raise exception 'publication_atomicity_failure' using errcode = 'P0001';
  end if;

  update exam_delivery.package_versions
  set status='published',published_at=statement_timestamp()
  where id=v_package_id;
  insert into exam_delivery.publication_runs(
    publication_request_id,package_version_id,actor_user_id,source_commit_sha,
    expected_validation_hash,expected_package_hash,actual_package_hash,status,completed_at
  ) values (
    v_request_id,v_package_id,v_actor,v_source_commit,v_validation_hash,
    v_package_hash,v_actual_hash,'succeeded',statement_timestamp()
  );

  return jsonb_build_object(
    'ok',true,'classification','new_candidate','replayed',false,
    'examKey',v_exam_key,'packageVersion',v_version,'profileCount',v_profile_count,
    'questionCount',v_question_count,'packageHash',v_package_hash,'validationHash',v_validation_hash
  );
exception
  when unique_violation then
    raise exception 'publication_conflict' using errcode = '23505';
end;
$$;

-- CREATE OR REPLACE preserves the existing ACL, and these explicit statements
-- keep the operator boundary auditable and fail closed.
revoke execute on function exam_delivery.publish_package_v2(jsonb)
  from public, anon, service_role;
grant execute on function exam_delivery.publish_package_v2(jsonb)
  to authenticated;
