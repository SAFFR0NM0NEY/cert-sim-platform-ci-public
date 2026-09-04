-- Phase E generic package-v2 publication and protected lifecycle.
-- This migration is inert: it creates no package, policy, gate, allowlist,
-- assignment, attempt, or review-release row.

alter table exam_delivery.attempts
  alter column protected_assignment_id drop not null;

alter function exam_delivery.publish_package(jsonb)
  rename to publish_package_ai901_v1;

create function exam_delivery.package_v2_runtime_supported(
  p_generator text,
  p_scorer text,
  p_pbq_runtime text default null
)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select p_generator in (
      'certsim-az204-grouped-generator-v1',
      'certsim-security-plus-pbq-first-generator-v1',
      'certsim-az400-case-workspace-generator-v1'
    )
    and p_scorer in (
      'certsim-az204-exact-scorer-v1',
      'certsim-security-plus-authoritative-pbq-scorer-v1',
      'certsim-az400-authoritative-scorer-v1'
    )
    and (p_pbq_runtime is null or p_pbq_runtime = 'certsim-protected-pbq-runtime-v1')
$$;

create function exam_delivery.publish_package_v2(p_request jsonb)
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
     or v_payload#>>'{releasePolicy,review}' <> 'never'
     or v_payload#>>'{releasePolicy,answers}' <> 'never' then
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

create function exam_delivery.publish_package(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '15s'
as $$
begin
  if p_request#>>'{packagePayload,packageSchemaVersion}' = 'certsim-protected-package-v2' then
    return exam_delivery.publish_package_v2(p_request);
  end if;
  return exam_delivery.publish_package_ai901_v1(p_request);
end;
$$;

create or replace function public.certsim_protected_publish_package(p_request jsonb)
returns jsonb
language sql
security invoker
set search_path = ''
as $$ select exam_delivery.publish_package(p_request) $$;

revoke execute on function exam_delivery.package_v2_runtime_supported(text,text,text)
  from public,anon,authenticated,service_role;
revoke execute on function exam_delivery.publish_package_v2(jsonb)
  from public,anon,service_role;
revoke execute on function exam_delivery.publish_package(jsonb)
  from public,anon,service_role;
revoke execute on function public.certsim_protected_publish_package(jsonb)
  from public,anon,service_role;
grant execute on function exam_delivery.publish_package_v2(jsonb) to authenticated;
grant execute on function exam_delivery.publish_package(jsonb) to authenticated;
grant execute on function public.certsim_protected_publish_package(jsonb) to authenticated;

create function exam_delivery.create_protected_assignment_v2(
  p_target_user_id uuid,p_organisation_id uuid,p_exam_key text,
  p_package_version text,p_profile_key text,p_available_from timestamptz,
  p_expires_at timestamptz,p_maximum_attempts integer,
  p_review_release_policy text,p_answer_release_policy text
)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='10s' as $$
declare v_actor uuid:=auth.uid(); v_package record; v_created exam_delivery.protected_assignments%rowtype;
begin
  if v_actor is null then raise exception 'assignment_auth_required' using errcode='42501'; end if;
  if p_target_user_id is null or p_organisation_id is null or exam_delivery.normalize_exam_key(p_exam_key) is null
    or nullif(btrim(p_package_version),'') is null or nullif(btrim(p_profile_key),'') is null
    or p_available_from is null or p_maximum_attempts<1
    or p_review_release_policy<>'never' or p_answer_release_policy<>'never'
    or (p_expires_at is not null and p_expires_at<=p_available_from) then
    raise exception 'assignment_invalid_request' using errcode='22023';
  end if;
  if not exists(select 1 from public.memberships where user_id=v_actor and organisation_id=p_organisation_id and role='platform_owner' and status='active')
    or not exists(select 1 from public.memberships where user_id=p_target_user_id and organisation_id=p_organisation_id and role='student' and status='active') then
    raise exception 'assignment_forbidden' using errcode='42501';
  end if;
  select pv.id package_version_id,pp.id package_profile_id,pv.exam_key,pv.package_version,pp.profile_key into strict v_package
  from exam_delivery.package_versions pv join exam_delivery.package_profiles pp on pp.package_version_id=pv.id
  where exam_delivery.normalize_exam_key(pv.exam_key)=exam_delivery.normalize_exam_key(p_exam_key)
    and pv.package_version=p_package_version and pp.profile_key=p_profile_key
    and pv.package_schema_version='certsim-protected-package-v2' and pv.status='published';
  insert into exam_delivery.protected_assignments(learner_id,organisation_id,package_version_id,package_profile_id,status,available_from,expires_at,maximum_attempts,review_release_policy,answer_release_policy,assigned_by)
  values(p_target_user_id,p_organisation_id,v_package.package_version_id,v_package.package_profile_id,'active',p_available_from,p_expires_at,p_maximum_attempts,p_review_release_policy,p_answer_release_policy,v_actor)
  returning * into v_created;
  return jsonb_build_object('ok',true,'examKey',exam_delivery.normalize_exam_key(v_package.exam_key),'packageVersion',v_package.package_version,'profileKey',v_package.profile_key,'status',v_created.status,'maximumAttempts',v_created.maximum_attempts,'reviewReleasePolicy',v_created.review_release_policy,'answerReleasePolicy',v_created.answer_release_policy);
exception when no_data_found or too_many_rows then raise exception 'assignment_package_not_found' using errcode='22023';
end $$;

create function public.certsim_protected_create_assignment_v2(
  p_target_user_id uuid,p_organisation_id uuid,p_exam_key text,
  p_package_version text,p_profile_key text,p_available_from timestamptz,
  p_expires_at timestamptz,p_maximum_attempts integer,
  p_review_release_policy text,p_answer_release_policy text
)
returns jsonb language sql security invoker set search_path='' as $$
  select exam_delivery.create_protected_assignment_v2(p_target_user_id,p_organisation_id,p_exam_key,p_package_version,p_profile_key,p_available_from,p_expires_at,p_maximum_attempts,p_review_release_policy,p_answer_release_policy)
$$;
revoke execute on function exam_delivery.create_protected_assignment_v2(uuid,uuid,text,text,text,timestamptz,timestamptz,integer,text,text) from public,anon,service_role;
revoke execute on function public.certsim_protected_create_assignment_v2(uuid,uuid,text,text,text,timestamptz,timestamptz,integer,text,text) from public,anon,service_role;
grant execute on function exam_delivery.create_protected_assignment_v2(uuid,uuid,text,text,text,timestamptz,timestamptz,integer,text,text) to authenticated;
grant execute on function public.certsim_protected_create_assignment_v2(uuid,uuid,text,text,text,timestamptz,timestamptz,integer,text,text) to authenticated;

-- Generic scorer registry. Every package identifier is allowlisted above;
-- package data selects only one of these fixed, inert data-comparison branches.
create function exam_delivery.score_package_v2_response(
  p_question_type text,p_scoring jsonb,p_response jsonb,p_scored boolean
)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  v_answer jsonb := coalesce(p_response->'answer',p_response->'selectedAnswer');
  v_selected jsonb := coalesce(p_response->'selectedAnswers',p_response->'answer');
  v_order jsonb := coalesce(p_response->'selectedOrder',p_response->'answer');
  v_expected jsonb;
  v_earned numeric := 0;
  v_max numeric := 1;
  v_complete boolean := true;
  v_strategy text := p_scoring->>'strategy';
begin
  if not p_scored then return jsonb_build_object('earned',0,'maximum',0,'status','Informational'); end if;
  if p_question_type='single-choice' then
    v_earned := case when v_answer=to_jsonb(p_scoring->>'correctAnswer') or v_answer=to_jsonb(p_scoring->>'correctOptionId') then 1 else 0 end;
  elsif p_question_type='multi-select' then
    v_expected:=coalesce(p_scoring->'correctAnswers',p_scoring->'correctOptionIds');
    v_earned:=case when jsonb_typeof(v_selected)='array' and
      (select coalesce(jsonb_agg(x order by x),'[]'::jsonb) from jsonb_array_elements_text(v_selected) x)=
      (select coalesce(jsonb_agg(x order by x),'[]'::jsonb) from jsonb_array_elements_text(v_expected) x)
      and jsonb_array_length(v_selected)=jsonb_array_length(v_expected) then 1 else 0 end;
  elsif p_question_type='reorder' then
    v_earned:=case when v_order=coalesce(p_scoring->'correctOrder',p_scoring->'correctItemIds') then 1 else 0 end;
  elsif p_question_type='drag-drop-match' then
    v_earned:=case when v_selected=coalesce(p_scoring->'correctPairs',p_scoring->'correctPairsByPrompt') then 1 else 0 end;
  elsif p_question_type in ('dropdown-code','dropdown-command') then
    select coalesce(jsonb_object_agg(x->>'id',to_jsonb(x->>'correctAnswer')),'{}'::jsonb)
      into v_expected from jsonb_array_elements(coalesce(p_scoring->'blanks','[]'::jsonb)) x;
    v_earned:=case when v_selected=v_expected then 1 else 0 end;
  elsif v_strategy in ('per-component-map','per-component-positive') then
    v_expected:=coalesce(p_scoring->'expectedMap','{}'::jsonb);
    select count(*) into v_max from jsonb_object_keys(v_expected);
    select count(*) into v_earned from jsonb_each(v_expected) e
      where p_response->'selectedAnswers'->e.key=e.value;
    if v_strategy='per-component-positive' and exists(
      select 1 from jsonb_each(coalesce(p_response->'selectedAnswers','{}'::jsonb)) a
      where v_expected->a.key is distinct from a.value
    ) then v_complete:=false; end if;
  elsif v_strategy='exact-ordered-sequence' then
    v_expected:=coalesce(p_scoring->'expectedOrder','[]'::jsonb);
    v_max:=jsonb_array_length(v_expected);
    select count(*) into v_earned
    from jsonb_array_elements_text(v_expected) with ordinality e(value,n)
    where p_response->'selectedOrder'->>(e.n-1)=e.value;
  elsif v_strategy='weighted-rule-evaluation' then
    v_max:=coalesce((p_scoring->>'finalAnswerPoints')::numeric,0)+coalesce((select sum((x->>'points')::numeric) from jsonb_array_elements(coalesce(p_scoring->'criteria','[]'::jsonb)) x),0);
    if p_response->>'selectedAnswer'=p_scoring->>'expectedAnswer' then v_earned:=coalesce((p_scoring->>'finalAnswerPoints')::numeric,0); end if;
    v_earned:=v_earned+coalesce((select sum((c->>'points')::numeric) from jsonb_array_elements(coalesce(p_scoring->'criteria','[]'::jsonb)) c where exists(select 1 from jsonb_array_elements_text(coalesce(c->'commandIds','[]'::jsonb)) expected where exists(select 1 from jsonb_array_elements_text(coalesce(p_response->'executedCommands','[]'::jsonb)) actual where actual=expected))),0);
  elsif v_strategy='exact-whole-state' then
    v_earned:=case when p_response->'selectedAnswer'=p_scoring->'expectedAnswer' then 1 else 0 end;
  else
    raise exception 'unsupported_scoring_model' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_array_elements_text(coalesce(p_scoring->'requiredCommandIds','[]'::jsonb)) required where not exists(select 1 from jsonb_array_elements_text(coalesce(p_response->'executedCommands','[]'::jsonb)) actual where actual=required)) then v_complete:=false; end if;
  return jsonb_build_object('earned',v_earned,'maximum',v_max,'status',case when p_response is null or p_response='{}'::jsonb or not v_complete then 'Incomplete' when v_earned=v_max then 'Correct' when v_earned>0 then 'Partial' else 'Incorrect' end);
end;
$$;

revoke execute on function exam_delivery.score_package_v2_response(text,jsonb,jsonb,boolean)
  from public,anon,authenticated,service_role;
grant execute on function exam_delivery.score_package_v2_response(text,jsonb,jsonb,boolean)
  to service_role;

create function exam_delivery.package_v2_response_valid(
  p_question_type text,p_presentation jsonb,p_response jsonb
)
returns boolean language plpgsql immutable security invoker set search_path='' as $$
declare v_answer jsonb:=p_response->'answer'; v_allowed jsonb:=p_presentation->'responseAllowlist';
begin
  if jsonb_typeof(p_response)<>'object' or pg_catalog.pg_column_size(p_response)>65536
    or exists(select 1 from jsonb_object_keys(p_response) key where key not in ('answer','selectedAnswer','selectedAnswers','selectedOrder','executedCommands','revision')) then return false; end if;
  if p_question_type='single-choice' and jsonb_typeof(v_answer)='string' then
    return exists(select 1 from jsonb_array_elements(coalesce(p_presentation->'options','[]'::jsonb)) o where o->>'id'=p_response->>'answer');
  elsif p_question_type='multi-select' and jsonb_typeof(v_answer)='array' then
    return jsonb_array_length(v_answer)<=50 and not exists(select 1 from jsonb_array_elements_text(v_answer) a where not exists(select 1 from jsonb_array_elements(coalesce(p_presentation->'options','[]'::jsonb)) o where o->>'id'=a));
  elsif p_question_type='reorder' and jsonb_typeof(v_answer)='array' then
    return jsonb_array_length(v_answer)<=100 and (select count(*)=count(distinct a) from jsonb_array_elements_text(v_answer) a) and not exists(select 1 from jsonb_array_elements_text(v_answer) a where not exists(select 1 from jsonb_array_elements(coalesce(p_presentation->'items','[]'::jsonb)) i where i->>'id'=a));
  elsif p_question_type in ('drag-drop-match','dropdown-code','dropdown-command') then
    return jsonb_typeof(v_answer)='object'
      and (select count(*) from jsonb_object_keys(v_answer))<=100;
  elsif p_question_type like 'pbq-%' then
    if jsonb_typeof(v_allowed)<>'object' then return false; end if;
    if p_response?'selectedAnswer' and not (coalesce(v_allowed->'answerIds','[]'::jsonb) @> jsonb_build_array(p_response->>'selectedAnswer')) then return false; end if;
    if p_response?'selectedOrder' and (jsonb_typeof(p_response->'selectedOrder')<>'array' or exists(select 1 from jsonb_array_elements_text(p_response->'selectedOrder') x where not (coalesce(v_allowed->'orderIds','[]'::jsonb) @> jsonb_build_array(x)))) then return false; end if;
    if p_response?'selectedAnswers' and (jsonb_typeof(p_response->'selectedAnswers')<>'object' or exists(
      select 1 from jsonb_each_text(p_response->'selectedAnswers') x
      where not (coalesce(v_allowed->'targetIds','[]'::jsonb) @> jsonb_build_array(x.key))
        or not (coalesce(
          case when jsonb_typeof(v_allowed->'answerIdsByTarget')='object' then v_allowed->'answerIdsByTarget'->x.key
            else (select entry->'answerIds' from jsonb_array_elements(coalesce(v_allowed->'answerIdsByTarget','[]'::jsonb)) entry where entry->>'targetId'=x.key limit 1) end,
          '[]'::jsonb
        ) @> jsonb_build_array(x.value))
    )) then return false; end if;
    if p_response?'executedCommands' and (jsonb_typeof(p_response->'executedCommands')<>'array' or jsonb_array_length(p_response->'executedCommands')>100 or exists(select 1 from jsonb_array_elements_text(p_response->'executedCommands') x where length(x)>256 or not (coalesce(v_allowed->'commandIds','[]'::jsonb) @> jsonb_build_array(x)))) then return false; end if;
    return true;
  end if;
  return p_response='{}'::jsonb;
end $$;

alter function exam_delivery.save_response(uuid,uuid,uuid,jsonb,integer,uuid)
  rename to save_response_ai901_v1;
create function exam_delivery.save_response(p_actor_id uuid,p_attempt_id uuid,p_item_id uuid,p_response jsonb,p_expected_revision integer,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='10s' as $$
declare
  v_record record;
  v_existing exam_delivery.attempt_responses%rowtype;
  v_saved exam_delivery.attempt_responses%rowtype;
  v_now timestamptz:=statement_timestamp();
begin
  if p_request_id is null or p_expected_revision<0 then return jsonb_build_object('ok',false,'code','invalid_request'); end if;
  select pv.package_schema_version,pv.exam_key,pp.profile_key,a.status,a.expires_at,
         q.question_type,i.presentation_snapshot into v_record
  from exam_delivery.attempts a join exam_delivery.package_versions pv on pv.id=a.package_version_id
  join exam_delivery.package_profiles pp on pp.id=a.package_profile_id
  join exam_delivery.attempt_items i on i.attempt_id=a.id
  join exam_delivery.package_questions q on q.id=i.package_question_id
  where a.id=p_attempt_id and a.owner_id=p_actor_id and i.id=p_item_id for update of a;
  if not found then return jsonb_build_object('ok',false,'code','attempt_not_found'); end if;
  if v_record.package_schema_version<>'certsim-protected-package-v2' then
    return exam_delivery.save_response_ai901_v1(p_actor_id,p_attempt_id,p_item_id,p_response,p_expected_revision,p_request_id);
  end if;
  if not coalesce((exam_delivery.check_eligibility_v2(p_actor_id,v_record.exam_key,v_record.profile_key)->>'eligible')::boolean,false) then return jsonb_build_object('ok',false,'code','exam_unavailable'); end if;
  if v_record.status<>'in_progress' or v_now>=v_record.expires_at then return jsonb_build_object('ok',false,'code','invalid_lifecycle_transition'); end if;
  if not exam_delivery.package_v2_response_valid(v_record.question_type,v_record.presentation_snapshot,p_response) then return jsonb_build_object('ok',false,'code','invalid_response'); end if;
  select * into v_existing from exam_delivery.attempt_responses where attempt_id=p_attempt_id and attempt_item_id=p_item_id for update;
  if found and v_existing.last_request_id=p_request_id then
    if v_existing.response_payload=p_response and v_existing.revision=p_expected_revision+1 then return jsonb_build_object('ok',true,'itemId',p_item_id,'revision',v_existing.revision,'updatedAt',v_existing.updated_at); end if;
    return jsonb_build_object('ok',false,'code','response_conflict');
  end if;
  if coalesce(v_existing.revision,0)<>p_expected_revision then return jsonb_build_object('ok',false,'code','stale_response'); end if;
  insert into exam_delivery.attempt_responses(attempt_id,attempt_item_id,response_payload,revision,last_request_id,created_at,updated_at)
  values(p_attempt_id,p_item_id,p_response,p_expected_revision+1,p_request_id,v_now,v_now)
  on conflict(attempt_id,attempt_item_id) do update set response_payload=excluded.response_payload,revision=excluded.revision,last_request_id=excluded.last_request_id,updated_at=excluded.updated_at
  where exam_delivery.attempt_responses.revision=p_expected_revision returning * into v_saved;
  if not found then return jsonb_build_object('ok',false,'code','stale_response'); end if;
  return jsonb_build_object('ok',true,'itemId',p_item_id,'revision',v_saved.revision,'updatedAt',v_saved.updated_at);
exception when unique_violation then return jsonb_build_object('ok',false,'code','response_conflict');
end $$;

create or replace function public.certsim_protected_save_response(p_actor_id uuid,p_attempt_id uuid,p_item_id uuid,p_response jsonb,p_expected_revision integer,p_request_id uuid)
returns jsonb language sql security invoker set search_path='' as $$ select exam_delivery.save_response(p_actor_id,p_attempt_id,p_item_id,p_response,p_expected_revision,p_request_id) $$;

alter function exam_delivery.check_eligibility(uuid,text,text)
  rename to check_eligibility_ai901_v1;
alter function exam_delivery.start_attempt(uuid,text,text,uuid)
  rename to start_attempt_ai901_v1;
alter function exam_delivery.submit_attempt(uuid,uuid,uuid)
  rename to submit_attempt_ai901_v1;
alter function exam_delivery.resume_current_attempt(uuid,text,text)
  rename to resume_current_attempt_ai901_v1;

create function exam_delivery.check_eligibility_v2(
  p_actor_id uuid,p_exam_key text,p_profile_key text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '10s'
as $$
declare
  v_key text:=exam_delivery.normalize_exam_key(p_exam_key);
  v_now timestamptz:=statement_timestamp();
  v_policy exam_delivery.exam_access_policies%rowtype;
  v_package record;
  v_assignment record;
  v_allowed boolean:=false;
  v_count integer:=0;
begin
  if p_actor_id is null or v_key is null or nullif(btrim(p_profile_key),'') is null then
    return jsonb_build_object('eligible',false,'reasonCode','invalid_request');
  end if;
  if not exists(select 1 from public.profiles where id=p_actor_id and status='active') then
    return jsonb_build_object('eligible',false,'reasonCode','inactive_account');
  end if;
  select * into v_policy from exam_delivery.exam_access_policies where canonical_exam_key=v_key;
  if not found or not v_policy.enabled or v_policy.access_mode='disabled' then
    return jsonb_build_object('eligible',false,'reasonCode','exam_disabled');
  end if;
  select pv.id package_version_id,pv.package_version,pp.id package_profile_id,
         pp.profile_key,pp.display_name,pp.question_count,pp.time_limit_minutes
    into v_package
  from exam_delivery.package_versions pv join exam_delivery.package_profiles pp on pp.package_version_id=pv.id
  where exam_delivery.normalize_exam_key(pv.exam_key)=v_key and pp.profile_key=p_profile_key
    and pv.package_schema_version='certsim-protected-package-v2'
    and (not v_policy.require_published_package or pv.status='published')
  order by pv.published_at desc nulls last,pv.created_at desc limit 1;
  if not found then return jsonb_build_object('eligible',false,'reasonCode','package_unavailable'); end if;

  if v_policy.access_mode='open_authenticated' then v_allowed:=true;
  elsif v_policy.access_mode='organisation_scoped' then
    v_allowed:=exists(
      select 1 from public.memberships m
      join public.organisations o on o.id=m.organisation_id and o.status='active'
      join exam_delivery.exam_access_organisations s on s.organisation_id=m.organisation_id and s.canonical_exam_key=v_key and s.enabled
      where m.user_id=p_actor_id and m.status='active'
        and (s.access_starts_at is null or s.access_starts_at<=v_now)
        and (s.access_ends_at is null or s.access_ends_at>v_now)
    );
  elsif v_policy.access_mode='controlled_beta' then
    v_allowed:=exists(
      select 1 from exam_delivery.exam_access_learners l
      where l.canonical_exam_key=v_key and l.learner_id=p_actor_id and l.enabled
        and (l.access_starts_at is null or l.access_starts_at<=v_now)
        and (l.access_ends_at is null or l.access_ends_at>v_now)
    );
  elsif v_policy.access_mode='assignment_required' then v_allowed:=true;
  end if;
  if not v_allowed then return jsonb_build_object('eligible',false,'reasonCode','access_not_granted'); end if;

  if v_policy.require_assignment or v_policy.access_mode='assignment_required' then
    select a.id,a.maximum_attempts into v_assignment
    from exam_delivery.protected_assignments a
    join public.memberships m on m.user_id=a.learner_id and m.organisation_id=a.organisation_id and m.role='student' and m.status='active'
    join public.organisations o on o.id=a.organisation_id and o.status='active'
    where a.learner_id=p_actor_id and a.package_version_id=v_package.package_version_id
      and a.package_profile_id=v_package.package_profile_id and a.status='active'
      and a.available_from<=v_now and (a.expires_at is null or a.expires_at>v_now)
    limit 1;
    if not found then return jsonb_build_object('eligible',false,'reasonCode','assignment_required'); end if;
    select count(*)::integer into v_count from exam_delivery.attempts a
    where a.protected_assignment_id=v_assignment.id and a.status<>'voided';
    if v_count>=v_assignment.maximum_attempts and not exists(
      select 1 from exam_delivery.attempts a where a.protected_assignment_id=v_assignment.id and a.owner_id=p_actor_id and a.status='in_progress'
    ) then return jsonb_build_object('eligible',false,'reasonCode','attempt_limit_reached'); end if;
  end if;
  return jsonb_build_object('eligible',true,'reasonCode','eligible','examKey',v_key,
    'packageVersion',v_package.package_version,'profileKey',v_package.profile_key,
    'profileName',v_package.display_name,'questionCount',v_package.question_count,
    'timeLimitMinutes',v_package.time_limit_minutes);
end;
$$;

create function exam_delivery.check_eligibility(p_actor_id uuid,p_exam_key text,p_profile_key text)
returns jsonb language plpgsql stable security definer set search_path='' set statement_timeout='10s' as $$
declare v_key text:=exam_delivery.normalize_exam_key(p_exam_key);
begin
  if v_key='ai901' and not exists(select 1 from exam_delivery.exam_access_policies where canonical_exam_key='ai901') then
    return exam_delivery.check_eligibility_ai901_v1(p_actor_id,p_exam_key,p_profile_key);
  end if;
  return exam_delivery.check_eligibility_v2(p_actor_id,p_exam_key,p_profile_key);
end $$;

create function exam_delivery.start_attempt_v2(
  p_actor_id uuid,p_exam_key text,p_profile_key text,p_request_id uuid
)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='15s' as $$
declare
  v_key text:=exam_delivery.normalize_exam_key(p_exam_key);
  v_existing exam_delivery.attempts%rowtype;
  v_package record;
  v_assignment_id uuid;
  v_attempt exam_delivery.attempts%rowtype;
  v_now timestamptz:=statement_timestamp();
  v_case_count integer;
  v_pbq_count integer;
  v_case_keys text[]:='{}';
  v_pbq_keys text[]:='{}';
  v_group_scored integer:=0;
  v_standard_count integer;
  v_inserted integer;
begin
  if p_actor_id is null or p_request_id is null then return jsonb_build_object('ok',false,'code','invalid_request'); end if;
  select * into v_existing from exam_delivery.attempts where owner_id=p_actor_id and client_request_id=p_request_id;
  if found then
    if exists(select 1 from exam_delivery.package_profiles pp join exam_delivery.package_versions pv on pv.id=pp.package_version_id where pp.id=v_existing.package_profile_id and pp.profile_key=p_profile_key and exam_delivery.normalize_exam_key(pv.exam_key)=v_key) then
      return exam_delivery.resume_attempt(p_actor_id,v_existing.id);
    end if;
    return jsonb_build_object('ok',false,'code','attempt_conflict');
  end if;
  if not coalesce((exam_delivery.check_eligibility_v2(p_actor_id,p_exam_key,p_profile_key)->>'eligible')::boolean,false) then
    return jsonb_build_object('ok',false,'code',exam_delivery.check_eligibility_v2(p_actor_id,p_exam_key,p_profile_key)->>'reasonCode');
  end if;
  select pv.id package_version_id,pv.generator_version,pv.scorer_version,pp.id package_profile_id,
         pp.question_count,pp.time_limit_minutes,pp.selection_config
    into strict v_package
  from exam_delivery.package_versions pv join exam_delivery.package_profiles pp on pp.package_version_id=pv.id
  where exam_delivery.normalize_exam_key(pv.exam_key)=v_key and pp.profile_key=p_profile_key
    and pv.package_schema_version='certsim-protected-package-v2' and pv.status='published'
  order by pv.published_at desc limit 1 for share of pv,pp;
  select a.id into v_assignment_id from exam_delivery.protected_assignments a
  where a.learner_id=p_actor_id and a.package_version_id=v_package.package_version_id
    and a.package_profile_id=v_package.package_profile_id and a.status='active'
    and a.available_from<=v_now and (a.expires_at is null or a.expires_at>v_now) limit 1 for update;

  insert into exam_delivery.attempts(owner_id,package_version_id,package_profile_id,protected_assignment_id,
    client_request_id,status,generator_version,scorer_version,created_at,started_at,expires_at)
  values(p_actor_id,v_package.package_version_id,v_package.package_profile_id,v_assignment_id,
    p_request_id,'in_progress',v_package.generator_version,v_package.scorer_version,v_now,v_now,
    v_now+make_interval(mins=>v_package.time_limit_minutes)) returning * into v_attempt;

  v_case_count:=coalesce((v_package.selection_config->>'caseStudyCount')::integer,
    coalesce((v_package.selection_config->>'longCaseStudyCount')::integer,0)+coalesce((v_package.selection_config->>'shortCaseStudyCount')::integer,0),0);
  v_pbq_count:=coalesce((v_package.selection_config->>'pbqCount')::integer,0);
  select coalesce(array_agg(group_key),'{}') into v_case_keys from (
    select pc.authoring_metadata#>>'{group,groupKey}' group_key
    from exam_delivery.package_questions q join exam_delivery.package_question_protected_content pc on pc.question_id=q.id
    where q.package_version_id=v_package.package_version_id
      and pc.authoring_metadata#>>'{group,role}'=cast('context' as text)
    order by md5(p_request_id::text||cast(':' as text)||(pc.authoring_metadata#>>'{group,groupKey}')) limit v_case_count
  ) x;
  select coalesce(array_agg(group_key),'{}') into v_pbq_keys from (
    select pc.authoring_metadata#>>'{group,groupKey}' group_key
    from exam_delivery.package_questions q join exam_delivery.package_question_protected_content pc on pc.question_id=q.id
    where q.package_version_id=v_package.package_version_id
      and (pc.authoring_metadata#>>'{group,role}'=cast('atomic-pbq' as text)
        or q.question_type like cast('pbq-%' as text))
    order by md5(p_request_id::text||cast(':' as text)||q.question_id) limit v_pbq_count
  ) x;
  select count(*)::integer into v_group_scored
  from exam_delivery.package_questions q join exam_delivery.package_question_protected_content pc on pc.question_id=q.id
  where q.package_version_id=v_package.package_version_id
    and coalesce((pc.authoring_metadata->>'scored')::boolean,true)
    and pc.authoring_metadata#>>'{group,groupKey}'=any(v_case_keys||v_pbq_keys);
  v_standard_count:=v_package.question_count-v_group_scored;
  if v_standard_count<0 then raise exception 'selection_incomplete' using errcode='22023'; end if;

  with candidates as (
    select q.*,pc.scoring_payload,pc.review_payload,pc.authoring_metadata,
      pc.authoring_metadata#>>'{group,groupKey}' group_key,
      pc.authoring_metadata#>>'{group,role}' group_role,
      coalesce((pc.authoring_metadata#>>'{group,order}')::integer,0) group_order,
      coalesce((pc.authoring_metadata->>'scored')::boolean,true) scored
    from exam_delivery.package_questions q join exam_delivery.package_question_protected_content pc on pc.question_id=q.id
    where q.package_version_id=v_package.package_version_id
  ), standard as (
    select * from candidates where scored
      and coalesce(group_role,cast('' as text)) not in (
        cast('context' as text),cast('question' as text),cast('atomic-pbq' as text)
      ) and question_type not like cast('pbq-%' as text)
    order by md5(p_request_id::text||cast(':' as text)||question_id),source_ordinal limit v_standard_count
  ), selected as (
    select * from candidates where group_key=any(v_case_keys||v_pbq_keys)
    union all select * from standard
  ), ordered as (
    select s.*,row_number() over(order by
      case when group_key=any(v_case_keys) then 1 when v_package.selection_config->>'pbqPlacement'=cast('front-loaded' as text) and group_key=any(v_pbq_keys) then 1 when group_key is null then 2 else 3 end,
      case when group_key is not null then md5(p_request_id::text||cast(':' as text)||group_key) else md5(p_request_id::text||cast(':' as text)||question_id) end,
      group_order,source_ordinal) presented_number
    from selected s
  ), inserted as (
    insert into exam_delivery.attempt_items(attempt_id,package_version_id,package_question_id,presented_question_number,section_ordinal,option_order,presentation_snapshot,presentation_hash)
    select v_attempt.id,v_package.package_version_id,id,presented_number,null,'[]'::jsonb,presentation_payload,
      encode(extensions.digest(convert_to(presentation_payload::text,'UTF8'),'sha256'),'hex') from ordered
    returning id,package_question_id
  )
  insert into exam_delivery.attempt_item_protected_content(attempt_item_id,attempt_id,scoring_snapshot,review_snapshot,protected_snapshot_hash)
  select i.id,v_attempt.id,pc.scoring_payload,pc.review_payload,
    encode(extensions.digest(convert_to((pc.scoring_payload||pc.review_payload)::text,'UTF8'),'sha256'),'hex')
  from inserted i join exam_delivery.package_question_protected_content pc on pc.question_id=i.package_question_id;
  get diagnostics v_inserted=row_count;
  if (select count(*) from exam_delivery.attempt_items i join exam_delivery.package_question_protected_content pc on pc.question_id=i.package_question_id where i.attempt_id=v_attempt.id and coalesce((pc.authoring_metadata->>'scored')::boolean,true))<>v_package.question_count then
    raise exception 'selection_incomplete' using errcode='P0001';
  end if;
  return exam_delivery.resume_attempt(p_actor_id,v_attempt.id);
exception when no_data_found or too_many_rows then return jsonb_build_object('ok',false,'code','package_unavailable');
when unique_violation then return jsonb_build_object('ok',false,'code','attempt_conflict');
end $$;

create function exam_delivery.start_attempt(p_actor_id uuid,p_exam_key text,p_profile_key text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='15s' as $$
declare v_key text:=exam_delivery.normalize_exam_key(p_exam_key);
begin
  if v_key='ai901' and not exists(select 1 from exam_delivery.exam_access_policies where canonical_exam_key='ai901') then
    return exam_delivery.start_attempt_ai901_v1(p_actor_id,p_exam_key,p_profile_key,p_request_id);
  end if;
  return exam_delivery.start_attempt_v2(p_actor_id,p_exam_key,p_profile_key,p_request_id);
end $$;

create function exam_delivery.submit_attempt_v2(p_actor_id uuid,p_attempt_id uuid,p_submission_id uuid)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='15s' as $$
declare
  v_attempt record; v_existing exam_delivery.attempt_results%rowtype; v_now timestamptz:=statement_timestamp();
  v_response_hash text; v_raw numeric; v_max numeric; v_percentage numeric; v_scaled integer; v_pass_mark integer; v_passed boolean;
  v_domain jsonb; v_summary jsonb; v_review jsonb; v_catalog_id uuid;
begin
  if p_actor_id is null or p_submission_id is null then return jsonb_build_object('ok',false,'code','invalid_request'); end if;
  select a.*,pv.exam_key,pv.package_version,pv.package_schema_version,pp.profile_key,pp.time_limit_minutes,pp.selection_config
    into v_attempt from exam_delivery.attempts a join exam_delivery.package_versions pv on pv.id=a.package_version_id join exam_delivery.package_profiles pp on pp.id=a.package_profile_id
    where a.id=p_attempt_id and a.owner_id=p_actor_id for update of a;
  if not found then return jsonb_build_object('ok',false,'code','attempt_not_found'); end if;
  select * into v_existing from exam_delivery.attempt_results where attempt_id=p_attempt_id;
  if found then if v_existing.submission_id=p_submission_id then return exam_delivery.get_result(p_actor_id,p_attempt_id); end if; return jsonb_build_object('ok',false,'code','submission_conflict'); end if;
  if v_attempt.status<>'in_progress' then return jsonb_build_object('ok',false,'code','invalid_lifecycle_transition'); end if;
  if not coalesce((exam_delivery.check_eligibility_v2(p_actor_id,v_attempt.exam_key,v_attempt.profile_key)->>'eligible')::boolean,false) then return jsonb_build_object('ok',false,'code','exam_unavailable'); end if;
  select encode(extensions.digest(convert_to(coalesce(jsonb_agg(jsonb_build_object('itemId',i.id,'response',r.response_payload) order by i.id)::text,'[]'),'UTF8'),'sha256'),'hex') into v_response_hash
    from exam_delivery.attempt_items i left join exam_delivery.attempt_responses r on r.attempt_id=i.attempt_id and r.attempt_item_id=i.id where i.attempt_id=p_attempt_id;
  with scored as (
    select q.domain_key,coalesce(r.response_payload,'{}'::jsonb) response,
      exam_delivery.score_package_v2_response(q.question_type,pc.scoring_snapshot,coalesce(r.response_payload,'{}'::jsonb),coalesce((meta.authoring_metadata->>'scored')::boolean,true)) score
    from exam_delivery.attempt_items i join exam_delivery.package_questions q on q.id=i.package_question_id
    join exam_delivery.package_question_protected_content meta on meta.question_id=q.id
    join exam_delivery.attempt_item_protected_content pc on pc.attempt_item_id=i.id
    left join exam_delivery.attempt_responses r on r.attempt_item_id=i.id where i.attempt_id=p_attempt_id
  ) select coalesce(sum((score->>'earned')::numeric),0),coalesce(sum((score->>'maximum')::numeric),0) into v_raw,v_max from scored;
  if v_max<=0 then raise exception 'scoring_contract_invalid' using errcode='22023'; end if;
  with scored as (
    select q.domain_key,exam_delivery.score_package_v2_response(q.question_type,pc.scoring_snapshot,coalesce(r.response_payload,'{}'::jsonb),coalesce((meta.authoring_metadata->>'scored')::boolean,true)) score
    from exam_delivery.attempt_items i join exam_delivery.package_questions q on q.id=i.package_question_id join exam_delivery.package_question_protected_content meta on meta.question_id=q.id join exam_delivery.attempt_item_protected_content pc on pc.attempt_item_id=i.id left join exam_delivery.attempt_responses r on r.attempt_item_id=i.id where i.attempt_id=p_attempt_id
  ), domains as (
    select domain_key,jsonb_build_object('domain',domain_key,'correct',count(*) filter(where score->>'status'='Correct'),'total',count(*) filter(where (score->>'maximum')::numeric>0),'earnedPoints',sum((score->>'earned')::numeric),'maxPoints',sum((score->>'maximum')::numeric),'percentage',case when sum((score->>'maximum')::numeric)>0 then round(100*sum((score->>'earned')::numeric)/sum((score->>'maximum')::numeric),2) else 0 end) value from scored group by domain_key
  ) select coalesce(jsonb_object_agg(domain_key,value),'{}'::jsonb) into v_domain from domains;
  select jsonb_build_object('questionCount',count(*) filter(where coalesce((meta.authoring_metadata->>'scored')::boolean,true)),'presentedCount',count(*),'answeredCount',count(r.id)) into v_summary
    from exam_delivery.attempt_items i join exam_delivery.package_question_protected_content meta on meta.question_id=i.package_question_id left join exam_delivery.attempt_responses r on r.attempt_item_id=i.id where i.attempt_id=p_attempt_id;
  select jsonb_build_object('items',jsonb_agg(jsonb_build_object('itemId',i.id,'questionNumber',i.presented_question_number,'questionId',q.question_id,'questionType',q.question_type,'domain',q.domain_key,'section',q.section_key,'presentation',i.presentation_snapshot,'response',coalesce(r.response_payload,'{}'::jsonb),'status',score.value->>'status','earnedPoints',(score.value->>'earned')::numeric,'maxPoints',(score.value->>'maximum')::numeric,'correctAnswer',pc.scoring_snapshot,'explanation',pc.review_snapshot->>'explanation','remediation',pc.review_snapshot->>'remediation') order by i.presented_question_number)) into v_review
    from exam_delivery.attempt_items i join exam_delivery.package_questions q on q.id=i.package_question_id join exam_delivery.package_question_protected_content meta on meta.question_id=q.id join exam_delivery.attempt_item_protected_content pc on pc.attempt_item_id=i.id left join exam_delivery.attempt_responses r on r.attempt_item_id=i.id cross join lateral (select exam_delivery.score_package_v2_response(q.question_type,pc.scoring_snapshot,coalesce(r.response_payload,'{}'::jsonb),coalesce((meta.authoring_metadata->>'scored')::boolean,true)) value) score where i.attempt_id=p_attempt_id;
  v_percentage:=round(100*v_raw/v_max,4); v_pass_mark:=coalesce((v_attempt.selection_config#>>'{scoringContract,scoreScale,pass}')::integer,700); v_scaled:=round(v_percentage*10); v_passed:=v_scaled>=v_pass_mark;
  v_summary:=v_summary||jsonb_build_object('rawScore',v_raw,'maxScore',v_max,'rawPercentage',v_percentage,'scaledScore',v_scaled,'passed',v_passed,'passMark',v_pass_mark);
  insert into exam_delivery.attempt_results(attempt_id,submission_id,response_hash,scorer_version,raw_score,max_score,raw_percentage,passed,domain_summary,result_summary,server_authoritative,submitted_at,completed_at,created_at) values(p_attempt_id,p_submission_id,v_response_hash,v_attempt.scorer_version,v_raw,v_max,v_percentage,v_passed,v_domain,v_summary,true,v_now,v_now,v_now);
  insert into exam_delivery.review_snapshots(attempt_id,release_status,review_payload,review_hash,created_at) values(p_attempt_id,'withheld',v_review,encode(extensions.digest(convert_to(v_review::text,'UTF8'),'sha256'),'hex'),v_now);
  update exam_delivery.attempts set status='completed',submitted_at=v_now,completed_at=v_now where id=p_attempt_id;
  select id into v_catalog_id from public.exam_catalog where exam_delivery.normalize_exam_key(exam_key)=exam_delivery.normalize_exam_key(v_attempt.exam_key) and status='active' limit 1;
  insert into public.exam_attempts(id,user_id,exam_catalog_id,exam_key,exam_version,profile_id,mode_label,status,started_at,submitted_at,duration_seconds,time_limit_minutes,selected_question_ids,presented_order_snapshot,attempt_snapshot,client_app_version,created_at,updated_at)
  select p_attempt_id,p_actor_id,v_catalog_id,v_attempt.exam_key,v_attempt.package_version,v_attempt.profile_key,'Protected Exam','submitted',v_attempt.started_at,v_now,greatest(0,extract(epoch from v_now-v_attempt.started_at)::integer),v_attempt.time_limit_minutes,jsonb_agg(q.question_id order by i.presented_question_number),jsonb_build_object('questionIds',jsonb_agg(q.question_id order by i.presented_question_number),'itemTypes',jsonb_agg(jsonb_build_object('id',q.question_id,'type',q.question_type,'domain',q.domain_key,'isScored',coalesce((meta.authoring_metadata->>'scored')::boolean,true)) order by i.presented_question_number)),jsonb_build_object('attemptId',p_attempt_id,'sourceFlow','protected-exam-delivery','serverAuthoritative',true),'protected-server-v2',v_attempt.created_at,v_now from exam_delivery.attempt_items i join exam_delivery.package_questions q on q.id=i.package_question_id join exam_delivery.package_question_protected_content meta on meta.question_id=q.id where i.attempt_id=p_attempt_id;
  insert into public.exam_responses(attempt_id,question_id,question_type,response_snapshot,presented_snapshot,is_answered,is_scored,created_at) select p_attempt_id,q.question_id,q.question_type,coalesce(r.response_payload,'{}'::jsonb),i.presentation_snapshot,r.id is not null,coalesce((meta.authoring_metadata->>'scored')::boolean,true),v_now from exam_delivery.attempt_items i join exam_delivery.package_questions q on q.id=i.package_question_id join exam_delivery.package_question_protected_content meta on meta.question_id=q.id left join exam_delivery.attempt_responses r on r.attempt_item_id=i.id where i.attempt_id=p_attempt_id;
  insert into public.exam_results(attempt_id,user_id,exam_key,profile_id,scoring_engine_version,raw_score,raw_percentage,scaled_score,passed,pass_mark,domain_breakdown,pbq_breakdown,case_study_breakdown,weak_areas,result_snapshot,created_at) values(p_attempt_id,p_actor_id,v_attempt.exam_key,v_attempt.profile_key,v_attempt.scorer_version,v_raw,v_percentage,v_scaled,v_passed,v_pass_mark,v_domain,'{}','{}','[]',v_summary,v_now);
  insert into public.exam_reports(attempt_id,user_id,report_type,report_title,report_snapshot,pdf_generated,created_at) values(p_attempt_id,p_actor_id,'study_report_snapshot','Protected Exam Study Report',jsonb_build_object('result',v_summary,'domainBreakdown',v_domain,'reviewStatus','withheld','serverAuthoritative',true),false,v_now);
  return exam_delivery.get_result(p_actor_id,p_attempt_id);
end $$;

create function exam_delivery.submit_attempt(p_actor_id uuid,p_attempt_id uuid,p_submission_id uuid)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='15s' as $$
declare v_schema text;
begin
  select pv.package_schema_version into v_schema from exam_delivery.attempts a join exam_delivery.package_versions pv on pv.id=a.package_version_id where a.id=p_attempt_id and a.owner_id=p_actor_id;
  if v_schema='certsim-protected-package-v2' then return exam_delivery.submit_attempt_v2(p_actor_id,p_attempt_id,p_submission_id); end if;
  return exam_delivery.submit_attempt_ai901_v1(p_actor_id,p_attempt_id,p_submission_id);
end $$;

create or replace function exam_delivery.resume_current_attempt(p_actor_id uuid,p_exam_key text,p_profile_key text)
returns jsonb language plpgsql stable security definer set search_path='' set statement_timeout='5s' as $$
declare v_attempt_id uuid;
begin
  if exam_delivery.normalize_exam_key(p_exam_key)='ai901'
     and not exists(select 1 from exam_delivery.exam_access_policies where canonical_exam_key='ai901') then
    return exam_delivery.resume_current_attempt_ai901_v1(p_actor_id,p_exam_key,p_profile_key);
  end if;
  if not coalesce((exam_delivery.check_eligibility(p_actor_id,p_exam_key,p_profile_key)->>'eligible')::boolean,false) then return jsonb_build_object('ok',false,'code','exam_unavailable'); end if;
  select a.id into v_attempt_id from exam_delivery.attempts a join exam_delivery.package_versions pv on pv.id=a.package_version_id join exam_delivery.package_profiles pp on pp.id=a.package_profile_id where a.owner_id=p_actor_id and exam_delivery.normalize_exam_key(pv.exam_key)=exam_delivery.normalize_exam_key(p_exam_key) and pp.profile_key=p_profile_key and a.status='in_progress' order by a.created_at desc limit 1;
  if not found then return jsonb_build_object('ok',false,'code','attempt_not_found'); end if;
  return exam_delivery.resume_attempt(p_actor_id,v_attempt_id);
end $$;

create or replace function public.certsim_protected_check_eligibility(p_actor_id uuid,p_exam_key text,p_profile_key text)
returns jsonb language sql stable security invoker set search_path='' as $$ select exam_delivery.check_eligibility(p_actor_id,p_exam_key,p_profile_key) $$;
create or replace function public.certsim_protected_start_attempt(p_actor_id uuid,p_exam_key text,p_profile_key text,p_request_id uuid)
returns jsonb language sql security invoker set search_path='' as $$ select exam_delivery.start_attempt(p_actor_id,p_exam_key,p_profile_key,p_request_id) $$;
create or replace function public.certsim_protected_submit_attempt(p_actor_id uuid,p_attempt_id uuid,p_submission_id uuid)
returns jsonb language sql security invoker set search_path='' as $$ select exam_delivery.submit_attempt_idempotent(p_actor_id,p_attempt_id,p_submission_id) $$;
create or replace function public.certsim_protected_resume_current_attempt(p_actor_id uuid,p_exam_key text,p_profile_key text)
returns jsonb language sql stable security invoker set search_path='' as $$ select exam_delivery.resume_current_attempt(p_actor_id,p_exam_key,p_profile_key) $$;

revoke execute on function exam_delivery.check_eligibility(uuid,text,text) from public,anon,authenticated,service_role;
revoke execute on function exam_delivery.start_attempt(uuid,text,text,uuid) from public,anon,authenticated,service_role;
revoke execute on function exam_delivery.resume_attempt(uuid,uuid) from public,anon,authenticated,service_role;
revoke execute on function exam_delivery.resume_current_attempt(uuid,text,text) from public,anon,authenticated,service_role;
revoke execute on function exam_delivery.save_response(uuid,uuid,uuid,jsonb,integer,uuid) from public,anon,authenticated,service_role;
revoke execute on function exam_delivery.submit_attempt(uuid,uuid,uuid) from public,anon,authenticated,service_role;
revoke execute on function exam_delivery.submit_attempt_idempotent(uuid,uuid,uuid) from public,anon,authenticated,service_role;
revoke execute on function exam_delivery.get_result(uuid,uuid) from public,anon,authenticated,service_role;
revoke execute on function exam_delivery.get_review(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function exam_delivery.check_eligibility(uuid,text,text) to service_role;
grant execute on function exam_delivery.start_attempt(uuid,text,text,uuid) to service_role;
grant execute on function exam_delivery.resume_attempt(uuid,uuid) to service_role;
grant execute on function exam_delivery.resume_current_attempt(uuid,text,text) to service_role;
grant execute on function exam_delivery.save_response(uuid,uuid,uuid,jsonb,integer,uuid) to service_role;
grant execute on function exam_delivery.submit_attempt(uuid,uuid,uuid) to service_role;
grant execute on function exam_delivery.submit_attempt_idempotent(uuid,uuid,uuid) to service_role;
grant execute on function exam_delivery.get_result(uuid,uuid) to service_role;
grant execute on function exam_delivery.get_review(uuid,uuid) to service_role;

-- The existing fixed public lifecycle wrappers remain SECURITY INVOKER and
-- service-role-only. Publication remains the only authenticated operator RPC.
revoke execute on function public.certsim_protected_check_eligibility(uuid,text,text) from public,anon,authenticated,service_role;
revoke execute on function public.certsim_protected_start_attempt(uuid,text,text,uuid) from public,anon,authenticated,service_role;
revoke execute on function public.certsim_protected_resume_attempt(uuid,uuid) from public,anon,authenticated,service_role;
revoke execute on function public.certsim_protected_resume_current_attempt(uuid,text,text) from public,anon,authenticated,service_role;
revoke execute on function public.certsim_protected_save_response(uuid,uuid,uuid,jsonb,integer,uuid) from public,anon,authenticated,service_role;
revoke execute on function public.certsim_protected_submit_attempt(uuid,uuid,uuid) from public,anon,authenticated,service_role;
revoke execute on function public.certsim_protected_get_result(uuid,uuid) from public,anon,authenticated,service_role;
revoke execute on function public.certsim_protected_get_review(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.certsim_protected_check_eligibility(uuid,text,text) to service_role;
grant execute on function public.certsim_protected_start_attempt(uuid,text,text,uuid) to service_role;
grant execute on function public.certsim_protected_resume_attempt(uuid,uuid) to service_role;
grant execute on function public.certsim_protected_resume_current_attempt(uuid,text,text) to service_role;
grant execute on function public.certsim_protected_save_response(uuid,uuid,uuid,jsonb,integer,uuid) to service_role;
grant execute on function public.certsim_protected_submit_attempt(uuid,uuid,uuid) to service_role;
grant execute on function public.certsim_protected_get_result(uuid,uuid) to service_role;
grant execute on function public.certsim_protected_get_review(uuid,uuid) to service_role;

revoke all on all tables in schema exam_delivery from service_role;
