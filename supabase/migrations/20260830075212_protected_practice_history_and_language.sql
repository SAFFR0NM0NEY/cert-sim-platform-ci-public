-- Issue #20 G3B1: inert protected practice/history foundation.
-- No policy, entitlement, assignment, package, attempt, or access row is created.

create type exam_delivery.attempt_purpose as enum (
  'assigned_assessment','self_directed_exam','study_sandbox',
  'targeted_domain','weak_area','pbq_practice'
);

alter table exam_delivery.attempts
  add column purpose exam_delivery.attempt_purpose not null default 'assigned_assessment',
  add column practice_configuration jsonb not null default '{}'::jsonb,
  add column language_preference text not null default 'not_applicable';

alter table exam_delivery.attempts
  add constraint attempts_practice_configuration_object check (jsonb_typeof(practice_configuration)='object'),
  add constraint attempts_language_preference_check check (language_preference in ('csharp','python','mixed','not_applicable'));

create unique index attempts_one_active_purpose_idx
  on exam_delivery.attempts(owner_id,package_version_id,package_profile_id,purpose)
  where status='in_progress';

create table exam_delivery.practice_policies (
  id uuid primary key default gen_random_uuid(),
  canonical_exam_key text not null,
  package_version text not null,
  profile_key text not null,
  purpose exam_delivery.attempt_purpose not null,
  access_mode text not null,
  enabled boolean not null default false,
  maximum_completed_attempts integer,
  cooldown_seconds integer not null default 0,
  maximum_concurrent_sessions integer not null default 1,
  maximum_session_items integer not null default 40,
  immediate_feedback boolean not null default false,
  review_release_policy text not null default 'never',
  answer_release_policy text not null default 'never',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint practice_policies_identity_unique unique(canonical_exam_key,package_version,profile_key,purpose),
  constraint practice_policies_access_mode_check check(access_mode in ('disabled','open_authenticated','organisation_scoped','assignment_required','controlled_beta')),
  constraint practice_policies_purpose_check check(purpose<>'assigned_assessment'),
  constraint practice_policies_attempt_limit_check check(maximum_completed_attempts is null or maximum_completed_attempts between 1 and 1000),
  constraint practice_policies_cooldown_check check(cooldown_seconds between 0 and 2592000),
  constraint practice_policies_concurrency_check check(maximum_concurrent_sessions=1),
  constraint practice_policies_size_check check(maximum_session_items between 10 and 100),
  constraint practice_policies_review_check check(review_release_policy in ('never','after_submission','immediate_study_feedback')),
  constraint practice_policies_answer_check check(answer_release_policy in ('never','after_submission','immediate_study_feedback')),
  constraint practice_policies_disabled_check check(enabled or access_mode='disabled')
);

create table exam_delivery.practice_feedback_releases (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null,
  attempt_item_id uuid not null,
  response_revision integer not null check(response_revision>0),
  request_id uuid not null,
  released_at timestamptz not null default now(),
  constraint practice_feedback_item_fk foreign key(attempt_id,attempt_item_id)
    references exam_delivery.attempt_items(attempt_id,id) on delete restrict,
  constraint practice_feedback_request_unique unique(attempt_id,request_id),
  constraint practice_feedback_revision_unique unique(attempt_id,attempt_item_id,response_revision)
);

alter table exam_delivery.practice_policies enable row level security;
alter table exam_delivery.practice_feedback_releases enable row level security;
revoke all on table exam_delivery.practice_policies,exam_delivery.practice_feedback_releases from public,anon,authenticated,service_role;

create or replace function exam_delivery.resume_attempt(p_actor_id uuid,p_attempt_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' set statement_timeout='10s' as $$
declare v record;
begin
  select a.*,pv.exam_key,pv.package_version,pp.profile_key,pp.display_name,pp.time_limit_minutes into v
  from exam_delivery.attempts a join exam_delivery.package_versions pv on pv.id=a.package_version_id join exam_delivery.package_profiles pp on pp.id=a.package_profile_id
  where a.id=p_attempt_id and a.owner_id=p_actor_id;
  if not found then return jsonb_build_object('ok',false,'code','attempt_not_found'); end if;
  if v.status<>'in_progress' then return jsonb_build_object('ok',false,'code','invalid_lifecycle_transition'); end if;
  if v.purpose='assigned_assessment' and not coalesce((exam_delivery.check_eligibility(p_actor_id,v.exam_key,v.profile_key)->>'eligible')::boolean,false) then return jsonb_build_object('ok',false,'code','exam_unavailable'); end if;
  if v.purpose<>'assigned_assessment' and not exists(select 1 from exam_delivery.practice_policies p where p.canonical_exam_key=exam_delivery.normalize_exam_key(v.exam_key) and p.package_version=v.package_version and p.profile_key=v.profile_key and p.purpose=v.purpose and p.enabled and p.access_mode<>'disabled') then return jsonb_build_object('ok',false,'code','practice_unavailable'); end if;
  return jsonb_build_object('ok',true,'attempt',jsonb_build_object('attemptId',v.id,'examKey',v.exam_key,'packageVersion',v.package_version,'profileKey',v.profile_key,'profileName',v.display_name,'status',v.status,'startedAt',v.started_at,'expiresAt',v.expires_at,'timeLimitMinutes',v.time_limit_minutes,'purpose',v.purpose,'languagePreference',v.language_preference),'items',coalesce((select jsonb_agg(jsonb_build_object('itemId',i.id,'questionNumber',i.presented_question_number,'questionId',q.question_id,'questionType',q.question_type,'domain',q.domain_key,'section',q.section_key,'presentation',i.presentation_snapshot,'response',r.response_payload,'revision',coalesce(r.revision,0)) order by i.presented_question_number) from exam_delivery.attempt_items i join exam_delivery.package_questions q on q.id=i.package_question_id left join exam_delivery.attempt_responses r on r.attempt_id=i.attempt_id and r.attempt_item_id=i.id where i.attempt_id=v.id),'[]'::jsonb));
end $$;

create function exam_delivery.guard_attempt_purpose_immutability()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if old.purpose='assigned_assessment' and old.practice_configuration='{}'::jsonb
     and old.language_preference='not_applicable' and old.status='in_progress'
     and not exists(select 1 from exam_delivery.attempt_responses where attempt_id=old.id) then
    return new;
  end if;
  if new.purpose is distinct from old.purpose or new.practice_configuration is distinct from old.practice_configuration
     or new.language_preference is distinct from old.language_preference then
    raise exception 'attempt_contract_immutable' using errcode='23514';
  end if;
  return new;
end $$;
create trigger guard_attempt_purpose_immutability before update of purpose,practice_configuration,language_preference
  on exam_delivery.attempts for each row execute function exam_delivery.guard_attempt_purpose_immutability();

create function exam_delivery.practice_availability(p_actor_id uuid,p_request jsonb)
returns jsonb language plpgsql stable security definer set search_path='' set statement_timeout='5s' as $$
declare v_exam text:=exam_delivery.normalize_exam_key(p_request->>'examKey'); v_profile text:=p_request->>'profileId';
  v_purpose text:=p_request->>'purpose'; v_version text; v_policy exam_delivery.practice_policies%rowtype;
  v_available integer:=0; v_pbq integer:=0; v_missed integer:=0; v_new integer:=0; v_domains jsonb:='{}'::jsonb; v_requested integer; v_allowed boolean:=false; v_package_id uuid; v_profile_id uuid;
begin
  if p_actor_id is null or v_purpose not in ('self_directed_exam','study_sandbox','targeted_domain','weak_area','pbq_practice')
     or p_request->>'language' not in ('csharp','python','mixed','not_applicable') then
    return jsonb_build_object('ok',false,'code','invalid_request'); end if;
  if not exists(select 1 from public.profiles where id=p_actor_id and status='active') then return jsonb_build_object('ok',false,'code','inactive_account'); end if;
  select pv.package_version,pv.id,pp.id into v_version,v_package_id,v_profile_id from exam_delivery.package_versions pv join exam_delivery.package_profiles pp on pp.package_version_id=pv.id
   where exam_delivery.normalize_exam_key(pv.exam_key)=v_exam and pv.status='published' and pp.profile_key=v_profile order by pv.published_at desc limit 1;
  if not found then return jsonb_build_object('ok',false,'code','package_unavailable'); end if;
  select * into v_policy from exam_delivery.practice_policies where canonical_exam_key=v_exam and package_version=v_version and profile_key=v_profile and purpose=v_purpose::exam_delivery.attempt_purpose;
  if not found or not v_policy.enabled or v_policy.access_mode='disabled' then return jsonb_build_object('ok',false,'code','practice_unavailable'); end if;
  if v_policy.access_mode='open_authenticated' then v_allowed:=true;
  elsif v_policy.access_mode='organisation_scoped' then v_allowed:=exists(select 1 from public.memberships m join exam_delivery.exam_access_organisations o on o.organisation_id=m.organisation_id and o.canonical_exam_key=v_exam and o.enabled where m.user_id=p_actor_id and m.status='active');
  elsif v_policy.access_mode='controlled_beta' then v_allowed:=exists(select 1 from exam_delivery.exam_access_learners l where l.learner_id=p_actor_id and l.canonical_exam_key=v_exam and l.enabled and (l.access_starts_at is null or l.access_starts_at<=statement_timestamp()) and (l.access_ends_at is null or l.access_ends_at>statement_timestamp()));
  elsif v_policy.access_mode='assignment_required' then v_allowed:=exists(select 1 from exam_delivery.protected_assignments a where a.learner_id=p_actor_id and a.package_version_id=v_package_id and a.package_profile_id=v_profile_id and a.status='active' and a.available_from<=statement_timestamp() and (a.expires_at is null or a.expires_at>statement_timestamp())); end if;
  if not v_allowed then return jsonb_build_object('ok',false,'code','access_not_granted'); end if;
  if v_policy.maximum_completed_attempts is not null and (select count(*) from exam_delivery.attempts a where a.owner_id=p_actor_id and a.package_version_id=v_package_id and a.package_profile_id=v_profile_id and a.purpose=v_policy.purpose and a.status='completed')>=v_policy.maximum_completed_attempts then return jsonb_build_object('ok',false,'code','attempt_limit_reached'); end if;
  if v_policy.cooldown_seconds>0 and exists(select 1 from exam_delivery.attempts a where a.owner_id=p_actor_id and a.package_version_id=v_package_id and a.package_profile_id=v_profile_id and a.purpose=v_policy.purpose and a.completed_at>statement_timestamp()-make_interval(secs=>v_policy.cooldown_seconds)) then return jsonb_build_object('ok',false,'code','cooldown_active'); end if;
  select count(*)::integer,count(*) filter(where q.question_type like 'pbq-%')::integer into v_available,v_pbq
    from exam_delivery.package_questions q join exam_delivery.package_versions pv on pv.id=q.package_version_id
    where exam_delivery.normalize_exam_key(pv.exam_key)=v_exam and pv.package_version=v_version;
  select coalesce(jsonb_object_agg(domain_key,total),'{}'::jsonb) into v_domains from (
    select q.domain_key,count(*)::integer total from exam_delivery.package_questions q join exam_delivery.package_versions pv on pv.id=q.package_version_id
    where exam_delivery.normalize_exam_key(pv.exam_key)=v_exam and pv.package_version=v_version group by q.domain_key
  ) d;
  if v_purpose='targeted_domain' and (nullif(p_request->>'domain','') is null or not (v_domains ? (p_request->>'domain'))) then return jsonb_build_object('ok',false,'code','unknown_domain'); end if;
  select count(distinct item->>'questionId')::integer into v_missed from exam_delivery.attempts a join exam_delivery.review_snapshots rs on rs.attempt_id=a.id
    cross join lateral jsonb_array_elements(coalesce(rs.review_payload->'items','[]'::jsonb)) item
    where a.owner_id=p_actor_id and a.package_version_id=v_package_id and item->>'status' in ('Incorrect','Incomplete','Partial');
  select count(*)::integer into v_new from exam_delivery.package_questions q where q.package_version_id=v_package_id and not exists(
    select 1 from exam_delivery.attempt_items i join exam_delivery.attempts a on a.id=i.attempt_id where a.owner_id=p_actor_id and i.package_question_id=q.id);
  v_requested:=case when p_request->>'count'='all' then least(v_available,v_policy.maximum_session_items) else (p_request->>'count')::integer end;
  return jsonb_build_object('ok',true,'examKey',v_exam,'packageVersion',v_version,'profileKey',v_profile,'purpose',v_purpose,
    'available',v_available,'selectedCount',least(v_requested,v_available,v_policy.maximum_session_items),'adjustedCount',v_requested>least(v_available,v_policy.maximum_session_items),
    'domainCounts',v_domains,'missedCount',v_missed,'newCount',v_new,'pbqCount',v_pbq,'languages',case when v_exam='az204' and v_version='1.1.0' then '["csharp","python","mixed"]'::jsonb else '["not_applicable"]'::jsonb end);
end $$;

create function exam_delivery.prune_practice_selection(p_actor_id uuid,p_attempt_id uuid,p_request jsonb,p_limit integer)
returns integer language plpgsql security definer set search_path='' set statement_timeout='10s' as $$
declare v_kept integer;
begin
  create temporary table certsim_keep_items(item_id uuid primary key) on commit drop;
  insert into certsim_keep_items(item_id)
  with raw as (
    select i.id item_id,q.question_id,q.domain_key,q.question_type,
      coalesce(pc.authoring_metadata#>>'{group,groupKey}',q.question_id) unit_key,
      pc.authoring_metadata#>>'{group,role}' group_role,
      coalesce((pc.authoring_metadata->>'scored')::boolean,true) scored,
      exists(select 1 from exam_delivery.attempts prior join exam_delivery.review_snapshots rs on rs.attempt_id=prior.id
        cross join lateral jsonb_array_elements(coalesce(rs.review_payload->'items','[]'::jsonb)) reviewed
        where prior.owner_id=p_actor_id and prior.id<>p_attempt_id and reviewed->>'questionId'=q.question_id and reviewed->>'status' in ('Incorrect','Incomplete','Partial')) missed,
      not exists(select 1 from exam_delivery.attempts prior join exam_delivery.attempt_items seen on seen.attempt_id=prior.id where prior.owner_id=p_actor_id and prior.id<>p_attempt_id and seen.package_question_id=q.id) unseen,
      exists(select 1 from exam_delivery.attempts prior join exam_delivery.attempt_results result on result.attempt_id=prior.id
        cross join lateral jsonb_each(result.domain_summary) domain where prior.owner_id=p_actor_id and domain.key=q.domain_key and coalesce((domain.value->>'percentage')::numeric,100)<70) weak_domain
    from exam_delivery.attempt_items i join exam_delivery.package_questions q on q.id=i.package_question_id
    join exam_delivery.package_question_protected_content pc on pc.question_id=q.id where i.attempt_id=p_attempt_id
  ), units as (
    select unit_key,count(*) filter(where scored)::integer scored_size,
      bool_or(question_type like 'pbq-%' or group_role='atomic-pbq') pbq,
      bool_or(group_role in ('context','question')) case_study,bool_or(domain_key=p_request->>'domain') target_domain,
      bool_or(missed) missed,bool_or(unseen) unseen,bool_or(weak_domain) weak_domain
    from raw group by unit_key
  ), candidates as (
    select *,case p_request->>'mixStrategy'
      when 'missed-heavy' then case when missed then 0 when weak_domain then 1 when unseen then 2 else 3 end
      when 'new-heavy' then case when unseen then 0 when weak_domain then 1 when missed then 2 else 3 end
      else case when missed then 0 when unseen then 1 when weak_domain then 2 else 3 end end priority
    from units where scored_size>0
      and ((p_request->>'includePbqs')::boolean or not pbq)
      and (p_request->>'purpose' not in ('targeted_domain','weak_area','pbq_practice')
        or (p_request->>'purpose'='targeted_domain' and target_domain)
        or (p_request->>'purpose'='weak_area' and (missed or weak_domain))
        or (p_request->>'purpose'='pbq_practice' and (pbq or case_study)))
  ), ranked as (
    select *,coalesce(sum(scored_size) over(order by priority,md5((p_request->>'clientRequestId')||unit_key) rows between unbounded preceding and 1 preceding),0) preceding
    from candidates
  ), selected as(select unit_key from ranked where preceding<p_limit)
  select r.item_id from raw r join selected s using(unit_key);
  get diagnostics v_kept=row_count;
  if v_kept=0 then raise exception 'practice_pool_empty' using errcode='22023'; end if;
  delete from exam_delivery.attempt_item_protected_content pc where pc.attempt_id=p_attempt_id and not exists(select 1 from certsim_keep_items k where k.item_id=pc.attempt_item_id);
  delete from exam_delivery.attempt_items i where i.attempt_id=p_attempt_id and not exists(select 1 from certsim_keep_items k where k.item_id=i.id);
  update exam_delivery.attempt_items set presented_question_number=presented_question_number+1000000 where attempt_id=p_attempt_id;
  with numbered as(select id,row_number() over(order by presented_question_number)::integer n from exam_delivery.attempt_items where attempt_id=p_attempt_id)
  update exam_delivery.attempt_items i set presented_question_number=n.n from numbered n where i.id=n.id;
  return v_kept;
end $$;

create function exam_delivery.start_practice(p_actor_id uuid,p_request jsonb)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='15s' as $$
declare v_availability jsonb; v_started jsonb; v_attempt uuid; v_existing uuid; v_limit integer;
begin
  v_availability:=exam_delivery.practice_availability(p_actor_id,p_request);
  if not coalesce((v_availability->>'ok')::boolean,false) then return v_availability; end if;
  select a.id into v_existing from exam_delivery.attempts a join exam_delivery.package_versions pv on pv.id=a.package_version_id join exam_delivery.package_profiles pp on pp.id=a.package_profile_id
   where a.owner_id=p_actor_id and exam_delivery.normalize_exam_key(pv.exam_key)=v_availability->>'examKey' and pv.package_version=v_availability->>'packageVersion'
     and pp.profile_key=v_availability->>'profileKey' and a.purpose=(p_request->>'purpose')::exam_delivery.attempt_purpose and a.status='in_progress' for update of a;
  if found then return exam_delivery.resume_attempt(p_actor_id,v_existing); end if;
  v_started:=exam_delivery.start_attempt(p_actor_id,p_request->>'examKey',p_request->>'profileId',(p_request->>'clientRequestId')::uuid);
  if not coalesce((v_started->>'ok')::boolean,false) then return v_started; end if;
  v_attempt:=(v_started#>>'{attempt,attemptId}')::uuid;
  update exam_delivery.attempts set purpose=(p_request->>'purpose')::exam_delivery.attempt_purpose,
    practice_configuration=p_request-'clientRequestId',language_preference=p_request->>'language' where id=v_attempt and owner_id=p_actor_id;
  if v_availability->>'examKey'='az204' and v_availability->>'packageVersion'='1.1.0' then
    update exam_delivery.attempt_items i set presentation_snapshot=i.presentation_snapshot||variant.payload,
      presentation_hash=encode(extensions.digest(convert_to((i.presentation_snapshot||variant.payload)::text,'UTF8'),'sha256'),'hex')
    from exam_delivery.package_question_protected_content pc
    cross join lateral (select coalesce(pc.authoring_metadata#>'{group,languageVariants}'->
      case when p_request->>'language'='mixed' then case when get_byte(extensions.digest(convert_to((p_request->>'clientRequestId')||i.id::text,'UTF8'),'sha256'),0)%2=0 then 'csharp' else 'python' end
      else p_request->>'language' end,'{}'::jsonb) payload) variant
    where i.attempt_id=v_attempt and pc.question_id=i.package_question_id and variant.payload<>'{}'::jsonb;
  end if;
  v_limit:=(v_availability->>'selectedCount')::integer;
  perform exam_delivery.prune_practice_selection(p_actor_id,v_attempt,p_request,v_limit);
  return exam_delivery.resume_attempt(p_actor_id,v_attempt);
exception when unique_violation then return jsonb_build_object('ok',false,'code','attempt_conflict');
end $$;

create function exam_delivery.check_practice_item(p_actor_id uuid,p_attempt_id uuid,p_item_id uuid,p_expected_revision integer,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='5s' as $$
declare v record; v_score jsonb; v_release exam_delivery.practice_feedback_releases%rowtype;
begin
  select a.purpose,a.status,r.revision,q.question_type,pc.scoring_snapshot,pc.review_snapshot,p.immediate_feedback into v
  from exam_delivery.attempts a join exam_delivery.attempt_items i on i.attempt_id=a.id join exam_delivery.attempt_responses r on r.attempt_id=a.id and r.attempt_item_id=i.id
  join exam_delivery.package_questions q on q.id=i.package_question_id join exam_delivery.attempt_item_protected_content pc on pc.attempt_item_id=i.id
  join exam_delivery.package_versions pv on pv.id=a.package_version_id join exam_delivery.package_profiles pp on pp.id=a.package_profile_id
  join exam_delivery.practice_policies p on p.canonical_exam_key=exam_delivery.normalize_exam_key(pv.exam_key) and p.package_version=pv.package_version and p.profile_key=pp.profile_key and p.purpose=a.purpose
  where a.id=p_attempt_id and a.owner_id=p_actor_id and i.id=p_item_id for update of a;
  if not found then return jsonb_build_object('ok',false,'code','attempt_not_found'); end if;
  if v.status<>'in_progress' or not v.immediate_feedback then return jsonb_build_object('ok',false,'code','review_unavailable'); end if;
  if v.revision<>p_expected_revision then return jsonb_build_object('ok',false,'code','stale_response'); end if;
  insert into exam_delivery.practice_feedback_releases(attempt_id,attempt_item_id,response_revision,request_id)
    values(p_attempt_id,p_item_id,p_expected_revision,p_request_id) on conflict(attempt_id,attempt_item_id,response_revision) do update set request_id=exam_delivery.practice_feedback_releases.request_id returning * into v_release;
  select exam_delivery.score_package_v2_response(v.question_type,v.scoring_snapshot,r.response_payload,true) into v_score from exam_delivery.attempt_responses r where r.attempt_id=p_attempt_id and r.attempt_item_id=p_item_id;
  return jsonb_build_object('ok',true,'itemId',p_item_id,'revision',p_expected_revision,'status',v_score->>'status','earnedPoints',(v_score->>'earned')::numeric,'maxPoints',(v_score->>'maximum')::numeric,'review',v.review_snapshot,'releasedAt',v_release.released_at);
end $$;

create function exam_delivery.list_history(p_actor_id uuid,p_exam_key text,p_cursor text,p_page_size integer)
returns jsonb language sql stable security definer set search_path='' set statement_timeout='5s' as $$
with rows as (select a.id,pv.exam_key,pv.package_version,pp.profile_key,a.purpose,a.completed_at,r.raw_score,r.raw_percentage,r.passed,r.domain_summary,rs.release_status
 from exam_delivery.attempts a join exam_delivery.package_versions pv on pv.id=a.package_version_id join exam_delivery.package_profiles pp on pp.id=a.package_profile_id
 join exam_delivery.attempt_results r on r.attempt_id=a.id left join exam_delivery.review_snapshots rs on rs.attempt_id=a.id
 where a.owner_id=p_actor_id and (p_exam_key is null or exam_delivery.normalize_exam_key(pv.exam_key)=exam_delivery.normalize_exam_key(p_exam_key))
 and (p_cursor is null or (a.completed_at,a.id)<((split_part(p_cursor,'|',1))::timestamptz,(split_part(p_cursor,'|',2))::uuid)) order by a.completed_at desc,a.id desc limit least(greatest(p_page_size,1),50)+1), page as(select * from rows limit least(greatest(p_page_size,1),50))
select jsonb_build_object('ok',true,'items',coalesce((select jsonb_agg(jsonb_build_object('attemptId',id,'examKey',exam_key,'packageVersion',package_version,'profileKey',profile_key,'purpose',purpose,'completedAt',completed_at,'score',raw_score,'percentage',raw_percentage,'passed',passed,'domainSummary',domain_summary,'serverAuthoritative',true,'reviewStatus',coalesce(release_status::text,'withheld')) order by completed_at desc,id desc) from page),'[]'::jsonb),'nextCursor',case when (select count(*) from rows)>p_page_size then (select completed_at::text||'|'||id::text from page order by completed_at,id limit 1) else null end) $$;

create function exam_delivery.history_summary(p_actor_id uuid,p_exam_key text) returns jsonb language sql stable security definer set search_path='' set statement_timeout='5s' as $$
with eligible as(select a.id,a.completed_at,r.raw_percentage,r.domain_summary from exam_delivery.attempts a join exam_delivery.package_versions pv on pv.id=a.package_version_id join exam_delivery.attempt_results r on r.attempt_id=a.id where a.owner_id=p_actor_id and exam_delivery.normalize_exam_key(pv.exam_key)=exam_delivery.normalize_exam_key(p_exam_key) and a.purpose in ('assigned_assessment','self_directed_exam'))
select jsonb_build_object('ok',true,'latest',(select jsonb_build_object('attemptId',id,'completedAt',completed_at,'percentage',raw_percentage) from eligible order by completed_at desc,id desc limit 1),'best',(select jsonb_build_object('attemptId',id,'completedAt',completed_at,'percentage',raw_percentage) from eligible order by raw_percentage desc,completed_at desc limit 1),'completedCount',(select count(*) from eligible),'weakDomains',coalesce((select domain_summary from eligible order by completed_at desc limit 1),'{}'::jsonb),'serverAuthoritative',true) $$;

create function exam_delivery.print_summary(p_actor_id uuid,p_attempt_id uuid) returns jsonb language sql stable security definer set search_path='' set statement_timeout='5s' as $$
select coalesce((select jsonb_build_object('ok',true,'exam',jsonb_build_object('key',pv.exam_key,'version',pv.package_version),'profile',jsonb_build_object('key',pp.profile_key,'name',pp.display_name),'purpose',a.purpose,'completedAt',a.completed_at,'score',r.raw_score,'percentage',r.raw_percentage,'passed',r.passed,'domainSummary',r.domain_summary,'completionStatus',a.status,'serverAuthoritative',true,'reviewStatus',coalesce(rs.release_status::text,'withheld')) from exam_delivery.attempts a join exam_delivery.package_versions pv on pv.id=a.package_version_id join exam_delivery.package_profiles pp on pp.id=a.package_profile_id join exam_delivery.attempt_results r on r.attempt_id=a.id left join exam_delivery.review_snapshots rs on rs.attempt_id=a.id where a.id=p_attempt_id and a.owner_id=p_actor_id),jsonb_build_object('ok',false,'code','attempt_not_found')) $$;

create function public.certsim_protected_practice_availability(p_actor_id uuid,p_request jsonb) returns jsonb language sql stable security invoker set search_path='' as $$select exam_delivery.practice_availability(p_actor_id,p_request)$$;
create function public.certsim_protected_start_practice(p_actor_id uuid,p_request jsonb) returns jsonb language sql security invoker set search_path='' as $$select exam_delivery.start_practice(p_actor_id,p_request)$$;
create function public.certsim_protected_check_practice_item(p_actor_id uuid,p_attempt_id uuid,p_item_id uuid,p_expected_revision integer,p_request_id uuid) returns jsonb language sql security invoker set search_path='' as $$select exam_delivery.check_practice_item(p_actor_id,p_attempt_id,p_item_id,p_expected_revision,p_request_id)$$;
create function public.certsim_protected_list_history(p_actor_id uuid,p_exam_key text,p_cursor text,p_page_size integer) returns jsonb language sql stable security invoker set search_path='' as $$select exam_delivery.list_history(p_actor_id,p_exam_key,p_cursor,p_page_size)$$;
create function public.certsim_protected_history_summary(p_actor_id uuid,p_exam_key text) returns jsonb language sql stable security invoker set search_path='' as $$select exam_delivery.history_summary(p_actor_id,p_exam_key)$$;
create function public.certsim_protected_print_summary(p_actor_id uuid,p_attempt_id uuid) returns jsonb language sql stable security invoker set search_path='' as $$select exam_delivery.print_summary(p_actor_id,p_attempt_id)$$;

revoke execute on function exam_delivery.guard_attempt_purpose_immutability(),exam_delivery.practice_availability(uuid,jsonb),exam_delivery.prune_practice_selection(uuid,uuid,jsonb,integer),exam_delivery.start_practice(uuid,jsonb),exam_delivery.check_practice_item(uuid,uuid,uuid,integer,uuid),exam_delivery.list_history(uuid,text,text,integer),exam_delivery.history_summary(uuid,text),exam_delivery.print_summary(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function exam_delivery.practice_availability(uuid,jsonb),exam_delivery.start_practice(uuid,jsonb),exam_delivery.check_practice_item(uuid,uuid,uuid,integer,uuid),exam_delivery.list_history(uuid,text,text,integer),exam_delivery.history_summary(uuid,text),exam_delivery.print_summary(uuid,uuid) to service_role;
revoke execute on function public.certsim_protected_practice_availability(uuid,jsonb),public.certsim_protected_start_practice(uuid,jsonb),public.certsim_protected_check_practice_item(uuid,uuid,uuid,integer,uuid),public.certsim_protected_list_history(uuid,text,text,integer),public.certsim_protected_history_summary(uuid,text),public.certsim_protected_print_summary(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.certsim_protected_practice_availability(uuid,jsonb),public.certsim_protected_start_practice(uuid,jsonb),public.certsim_protected_check_practice_item(uuid,uuid,uuid,integer,uuid),public.certsim_protected_list_history(uuid,text,text,integer),public.certsim_protected_history_summary(uuid,text),public.certsim_protected_print_summary(uuid,uuid) to service_role;
