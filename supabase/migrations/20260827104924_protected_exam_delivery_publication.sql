-- Authenticated platform-owner-only immutable package publication.
-- This migration adds no browser table grants, pilot activation, or runtime capability.

create function exam_delivery.canonical_json(p_value jsonb)
returns text
language plpgsql
immutable
strict
security invoker
set search_path = ''
as $$
declare
  value_type text := pg_catalog.jsonb_typeof(p_value);
  result text;
begin
  case value_type
    when 'null' then return 'null';
    when 'boolean' then return p_value::text;
    when 'string' then return p_value::text;
    when 'number' then
      if p_value::text = '-0' then
        raise exception 'publication_invalid_number' using errcode = '22023';
      end if;
      return p_value::text;
    when 'array' then
      select '[' || coalesce(pg_catalog.string_agg(exam_delivery.canonical_json(item.value), ',' order by item.ordinality), '') || ']'
      into result
      from pg_catalog.jsonb_array_elements(p_value) with ordinality as item(value, ordinality);
      return result;
    when 'object' then
      select '{' || coalesce(pg_catalog.string_agg(pg_catalog.to_jsonb(item.key)::text || ':' || exam_delivery.canonical_json(item.value), ',' order by item.key collate "C"), '') || '}'
      into result
      from pg_catalog.jsonb_each(p_value) as item(key, value);
      return result;
    else
      raise exception 'publication_invalid_json' using errcode = '22023';
  end case;
end;
$$;

create function exam_delivery.canonical_sha256(p_value jsonb)
returns text
language sql
immutable
strict
security invoker
set search_path = ''
as $$
  select pg_catalog.encode(extensions.digest(exam_delivery.canonical_json(p_value), 'sha256'), 'hex')
$$;

create function exam_delivery.json_has_exact_keys(p_value jsonb, p_keys text[])
returns boolean
language sql
immutable
strict
security invoker
set search_path = ''
as $$
  select pg_catalog.jsonb_typeof(p_value) = 'object'
    and (select pg_catalog.array_agg(k order by k collate "C") from pg_catalog.jsonb_object_keys(p_value) k)
      = (select pg_catalog.array_agg(k order by k collate "C") from pg_catalog.unnest(p_keys) k)
$$;

create function exam_delivery.presentation_is_safe(p_value jsonb)
returns boolean
language sql
immutable
strict
security invoker
set search_path = ''
as $$
  with recursive nodes(value) as (
    select p_value
    union all
    select child.value
    from nodes parent
    cross join lateral (
      select value from pg_catalog.jsonb_array_elements(case when pg_catalog.jsonb_typeof(parent.value)='array' then parent.value else '[]'::jsonb end)
      union all
      select value from pg_catalog.jsonb_each(case when pg_catalog.jsonb_typeof(parent.value)='object' then parent.value else '{}'::jsonb end)
    ) child
  )
  select not exists (
    select 1 from nodes, lateral pg_catalog.jsonb_object_keys(case when pg_catalog.jsonb_typeof(nodes.value)='object' then nodes.value else '{}'::jsonb end) key
    where pg_catalog.jsonb_typeof(nodes.value) = 'object'
      and pg_catalog.lower(pg_catalog.regexp_replace(key, '[^a-zA-Z0-9]', '', 'g')) = any(array[
        'acceptedanswer','acceptedanswers','answer','answerkey','answers','correctanswer','correctanswers','correctness','correctorder','correctpairs','expectedactions','expectedanswer','expectedanswers','explanation','hiddenanswermetadata','iscorrect','maxpoints','partialcredit','points','remediation','rubric','score','scoring','scoringkey','scoringkeys','scoringrules','weight','weights'
      ])
  )
$$;

create function exam_delivery.publish_package(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '15s'
as $$
declare
  actor uuid := auth.uid();
  request_id uuid;
  package_id uuid;
  existing_run exam_delivery.publication_runs%rowtype;
  existing_package exam_delivery.package_versions%rowtype;
  package_content jsonb;
  actual_package_hash text;
  actual_validation_hash text;
  profile_count integer;
  question_count integer;
  protected_count integer;
  publication_stage text := 'validation';
begin
  if actor is null then raise exception 'publication_auth_required' using errcode='42501'; end if;
  if not exists (select 1 from public.memberships m where m.user_id=actor and m.role='platform_owner' and m.status='active') then
    raise exception 'publication_forbidden' using errcode='42501';
  end if;
  if not exam_delivery.json_has_exact_keys(p_request,array['publicationRequestId','packageIdentity','sourceMetadata','packageMetadata','validationMetadata','packageProfiles','presentationQuestions','protectedQuestions']) then
    raise exception 'publication_request_invalid' using errcode='22023';
  end if;
  begin request_id := (p_request->>'publicationRequestId')::uuid; exception when others then raise exception 'publication_request_id_invalid' using errcode='22023'; end;
  if not exam_delivery.json_has_exact_keys(p_request->'packageIdentity',array['examKey','packageVersion','packageSchemaVersion','generatorVersion','scorerVersion'])
    or not exam_delivery.json_has_exact_keys(p_request->'sourceMetadata',array['sourceCommitSha'])
    or not exam_delivery.json_has_exact_keys(p_request->'validationMetadata',array['validationContractVersion','packageHash','validationHash','manifest'])
    or p_request#>>'{packageIdentity,examKey}' <> 'ai901'
    or p_request#>>'{packageIdentity,packageVersion}' <> '1.0.0'
    or p_request#>>'{packageIdentity,packageSchemaVersion}' <> 'certsim-protected-package-v1'
    or p_request#>>'{packageIdentity,generatorVersion}' <> 'certsim-protected-generator-v1'
    or p_request#>>'{packageIdentity,scorerVersion}' <> 'certsim-protected-standard-scorer-v1'
    or p_request#>>'{validationMetadata,validationContractVersion}' <> 'certsim-protected-standard-validation-v1'
    or p_request#>>'{sourceMetadata,sourceCommitSha}' !~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
    or pg_catalog.jsonb_typeof(p_request->'packageProfiles') <> 'array'
    or pg_catalog.jsonb_typeof(p_request->'presentationQuestions') <> 'array'
    or pg_catalog.jsonb_typeof(p_request->'protectedQuestions') <> 'array' then
    raise exception 'publication_contract_invalid' using errcode='22023';
  end if;

  publication_stage := 'reconstruct';
  select pg_catalog.jsonb_build_object(
    'packageSchemaVersion',p_request#>'{packageIdentity,packageSchemaVersion}',
    'exam',p_request->'packageMetadata',
    'profiles',p_request->'packageProfiles',
    'questions',pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'questionId',q->'questionId','questionType',q->'questionType','domainKey',q->'domainKey','sectionKey',q->'sectionKey','sourceOrdinal',q->'sourceOrdinal',
        'presentationPayload',q->'presentationPayload','scoringPayload',protected.item->'scoringPayload','reviewPayload',protected.item->'reviewPayload','authoringMetadata',protected.item->'authoringMetadata'
      ) order by (q->>'sourceOrdinal')::integer
    )
  ) into package_content
  from pg_catalog.jsonb_array_elements(p_request->'presentationQuestions') q
  join lateral (
    select item from pg_catalog.jsonb_array_elements(p_request->'protectedQuestions') item
    where item->>'questionId'=q->>'questionId'
  ) protected on true;

  publication_stage := 'payload';
  select pg_catalog.jsonb_array_length(p_request->'packageProfiles'), pg_catalog.jsonb_array_length(p_request->'presentationQuestions'), pg_catalog.jsonb_array_length(p_request->'protectedQuestions')
    into profile_count,question_count,protected_count;
  if profile_count<>2 or question_count<>234 or protected_count<>234
    or (select count(distinct q->>'questionId') from pg_catalog.jsonb_array_elements(p_request->'presentationQuestions') q)<>234
    or (select count(distinct q->>'questionId') from pg_catalog.jsonb_array_elements(p_request->'protectedQuestions') q)<>234
    or (select count(distinct p->>'profileKey') from pg_catalog.jsonb_array_elements(p_request->'packageProfiles') p)<>2
    or (select count(*) from pg_catalog.jsonb_array_elements(p_request->'presentationQuestions') q where not exam_delivery.json_has_exact_keys(q,array['questionId','questionType','domainKey','sectionKey','sourceOrdinal','presentationPayload','contentHash']) or q->>'questionType'<>all(array['single-choice','multi-select','drag-drop-match','reorder','dropdown-code','dropdown-command']) or pg_catalog.jsonb_typeof(q->'presentationPayload')<>'object' or not exam_delivery.presentation_is_safe(q->'presentationPayload'))<>0
    or (select count(*) from pg_catalog.jsonb_array_elements(p_request->'protectedQuestions') q where not exam_delivery.json_has_exact_keys(q,array['questionId','scoringPayload','reviewPayload','authoringMetadata']) or pg_catalog.jsonb_typeof(q->'scoringPayload')<>'object' or pg_catalog.jsonb_typeof(q->'reviewPayload')<>'object' or pg_catalog.jsonb_typeof(q->'authoringMetadata')<>'object')<>0
    or (select count(*) from pg_catalog.jsonb_array_elements(p_request->'packageProfiles') p where not exam_delivery.json_has_exact_keys(p,array['profileKey','displayName','questionCount','timeLimitMinutes','selectionConfig']) or pg_catalog.jsonb_typeof(p->'selectionConfig')<>'object')<>0 then
    raise exception 'publication_payload_invalid' using errcode='22023';
  end if;

  publication_stage := 'package_hash';
  actual_package_hash := exam_delivery.canonical_sha256(package_content);
  publication_stage := 'validation_hash';
  actual_validation_hash := exam_delivery.canonical_sha256(p_request#>'{validationMetadata,manifest}');
  if actual_package_hash<>p_request#>>'{validationMetadata,packageHash}' or actual_package_hash<>'a7a617a5d77455d997d1e536743f9a60bb6666c716292310c1777930ad08d293' then
    raise exception 'publication_package_hash_mismatch' using errcode='22023';
  end if;
  if actual_validation_hash<>p_request#>>'{validationMetadata,validationHash}' or actual_validation_hash<>'d356418e9a3c5c0349737893ad94946e9ba89a2a5db879d6f781522eb8797c22'
    or p_request#>>'{validationMetadata,manifest,packageHash}'<>actual_package_hash then
    raise exception 'publication_validation_hash_mismatch' using errcode='22023';
  end if;
  publication_stage := 'content_hash';
  if exists (select 1 from pg_catalog.jsonb_array_elements(p_request->'presentationQuestions') q join lateral (select item from pg_catalog.jsonb_array_elements(p_request->'protectedQuestions') item where item->>'questionId'=q->>'questionId') p on true where q->>'contentHash'<>exam_delivery.canonical_sha256(pg_catalog.jsonb_build_object('presentationPayload',q->'presentationPayload','scoringPayload',p.item->'scoringPayload','reviewPayload',p.item->'reviewPayload','authoringMetadata',p.item->'authoringMetadata'))) then
    raise exception 'publication_content_hash_mismatch' using errcode='22023';
  end if;

  publication_stage := 'replay';
  select * into existing_run from exam_delivery.publication_runs where publication_request_id=request_id;
  if found then
    if existing_run.expected_package_hash=actual_package_hash and existing_run.expected_validation_hash=actual_validation_hash and existing_run.source_commit_sha=p_request#>>'{sourceMetadata,sourceCommitSha}' and existing_run.status='succeeded' then
      return pg_catalog.jsonb_build_object('ok',true,'classification','idempotent_replay','replayed',true,'examKey','ai901','packageVersion','1.0.0','profileCount',2,'questionCount',234,'packageHash',actual_package_hash,'validationHash',actual_validation_hash);
    end if;
    raise exception 'publication_request_conflict' using errcode='23505';
  end if;
  select * into existing_package from exam_delivery.package_versions where exam_key='ai901' and package_version='1.0.0';
  if found then
    if existing_package.package_hash=actual_package_hash and existing_package.validation_hash=actual_validation_hash and existing_package.status='published' then
      return pg_catalog.jsonb_build_object('ok',true,'classification','exact_match','replayed',true,'examKey','ai901','packageVersion','1.0.0','profileCount',2,'questionCount',234,'packageHash',actual_package_hash,'validationHash',actual_validation_hash);
    end if;
    raise exception 'publication_identity_conflict' using errcode='23505';
  end if;

  if not exists (select 1 from public.memberships m where m.user_id=actor and m.role='platform_owner' and m.status='active') then raise exception 'publication_forbidden' using errcode='42501'; end if;
  publication_stage := 'package';
  insert into exam_delivery.package_versions(exam_key,package_version,source_commit_sha,validation_hash,package_hash,package_schema_version,generator_version,scorer_version,status)
  values('ai901','1.0.0',p_request#>>'{sourceMetadata,sourceCommitSha}',actual_validation_hash,actual_package_hash,'certsim-protected-package-v1','certsim-protected-generator-v1','certsim-protected-standard-scorer-v1','draft') returning id into package_id;
  if not exists (select 1 from public.memberships m where m.user_id=actor and m.role='platform_owner' and m.status='active') then raise exception 'publication_forbidden' using errcode='42501'; end if;
  publication_stage := 'run';
  insert into exam_delivery.publication_runs(publication_request_id,package_version_id,actor_user_id,source_commit_sha,expected_validation_hash,expected_package_hash,actual_package_hash,status,completed_at)
  values(request_id,package_id,actor,p_request#>>'{sourceMetadata,sourceCommitSha}',actual_validation_hash,actual_package_hash,actual_package_hash,'succeeded',pg_catalog.clock_timestamp());
  publication_stage := 'profiles';
  insert into exam_delivery.package_profiles(package_version_id,profile_key,display_name,question_count,time_limit_minutes,selection_config)
  select package_id,p->>'profileKey',p->>'displayName',(p->>'questionCount')::integer,(p->>'timeLimitMinutes')::integer,p->'selectionConfig' from pg_catalog.jsonb_array_elements(p_request->'packageProfiles') p;
  publication_stage := 'questions';
  insert into exam_delivery.package_questions(package_version_id,question_id,question_type,domain_key,section_key,source_ordinal,presentation_payload,content_hash)
  select package_id,q->>'questionId',q->>'questionType',q->>'domainKey',q->>'sectionKey',(q->>'sourceOrdinal')::integer,q->'presentationPayload',q->>'contentHash' from pg_catalog.jsonb_array_elements(p_request->'presentationQuestions') q;
  publication_stage := 'protected';
  insert into exam_delivery.package_question_protected_content(question_id,package_version_id,scoring_payload,review_payload,authoring_metadata)
  select stored.id,package_id,q->'scoringPayload',q->'reviewPayload',q->'authoringMetadata' from pg_catalog.jsonb_array_elements(p_request->'protectedQuestions') q join exam_delivery.package_questions stored on stored.package_version_id=package_id and stored.question_id=q->>'questionId';
  if (select count(*) from exam_delivery.package_profiles where package_version_id=package_id)<>2 or (select count(*) from exam_delivery.package_questions where package_version_id=package_id)<>234 or (select count(*) from exam_delivery.package_question_protected_content where package_version_id=package_id)<>234 then raise exception 'publication_count_mismatch' using errcode='23514'; end if;
  publication_stage := 'publish';
  update exam_delivery.package_versions set status='published',published_at=pg_catalog.clock_timestamp() where id=package_id and status='draft';
  return pg_catalog.jsonb_build_object('ok',true,'classification','new_candidate','replayed',false,'examKey','ai901','packageVersion','1.0.0','profileCount',2,'questionCount',234,'packageHash',actual_package_hash,'validationHash',actual_validation_hash);
exception when others then
  if sqlstate in ('42501','22023','23505','23514') then raise; end if;
  raise exception 'publication_failed_%_%', publication_stage, sqlstate using errcode='P0001';
end;
$$;

create function public.certsim_protected_publish_package(p_request jsonb)
returns jsonb language sql security invoker set search_path = ''
as $$ select exam_delivery.publish_package(p_request) $$;

revoke all on function exam_delivery.canonical_json(jsonb) from public,anon,authenticated,service_role;
revoke all on function exam_delivery.canonical_sha256(jsonb) from public,anon,authenticated,service_role;
revoke all on function exam_delivery.json_has_exact_keys(jsonb,text[]) from public,anon,authenticated,service_role;
revoke all on function exam_delivery.presentation_is_safe(jsonb) from public,anon,authenticated,service_role;
revoke all on function exam_delivery.publish_package(jsonb) from public,anon,service_role;
revoke all on function public.certsim_protected_publish_package(jsonb) from public,anon,service_role;
grant usage on schema exam_delivery to authenticated;
grant execute on function exam_delivery.publish_package(jsonb) to authenticated;
grant execute on function public.certsim_protected_publish_package(jsonb) to authenticated;
