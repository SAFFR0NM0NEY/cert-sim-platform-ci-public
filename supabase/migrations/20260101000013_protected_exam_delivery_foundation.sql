-- CertSim protected exam-delivery schema and security foundation.
--
-- Phase 17B creates private storage only. It deliberately does not publish an
-- exam, create an attempt, score a response, expose an RPC, or grant browser
-- access. Later backend phases must add their own narrowly reviewed grants.

create schema if not exists exam_delivery;

revoke all on schema exam_delivery from public, anon, authenticated, service_role;

alter default privileges for role postgres in schema exam_delivery
  revoke all on tables from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema exam_delivery
  revoke all on sequences from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema exam_delivery
  revoke execute on functions from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema exam_delivery
  revoke usage on types from public, anon, authenticated, service_role;

create type exam_delivery.package_publication_status as enum (
  'draft',
  'published',
  'retired',
  'superseded'
);

create type exam_delivery.publication_run_status as enum (
  'pending',
  'succeeded',
  'failed'
);

create type exam_delivery.attempt_status as enum (
  'in_progress',
  'submitted',
  'completed',
  'expired',
  'abandoned',
  'voided'
);

create type exam_delivery.review_release_status as enum (
  'withheld',
  'released'
);

create table exam_delivery.package_versions (
  id uuid primary key default gen_random_uuid(),
  exam_key text not null,
  package_version text not null,
  source_commit_sha text not null,
  validation_hash text not null,
  package_hash text not null,
  package_schema_version text not null,
  generator_version text not null,
  scorer_version text not null,
  status exam_delivery.package_publication_status not null default 'draft',
  supersedes_package_version_id uuid references exam_delivery.package_versions(id) on delete restrict,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  retired_at timestamptz,
  constraint package_versions_exam_key_nonempty check (
    btrim(exam_key) <> '' and exam_key ~ '^[a-z0-9][a-z0-9-]*$'
  ),
  constraint package_versions_version_nonempty check (btrim(package_version) <> ''),
  constraint package_versions_source_commit_sha_check check (
    source_commit_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
  ),
  constraint package_versions_validation_hash_check check (
    validation_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint package_versions_package_hash_check check (
    package_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint package_versions_schema_version_nonempty check (
    btrim(package_schema_version) <> ''
  ),
  constraint package_versions_generator_version_nonempty check (
    btrim(generator_version) <> ''
  ),
  constraint package_versions_scorer_version_nonempty check (
    btrim(scorer_version) <> ''
  ),
  constraint package_versions_not_self_superseding check (
    supersedes_package_version_id is null or supersedes_package_version_id <> id
  ),
  constraint package_versions_lifecycle_timestamps_check check (
    (status = 'draft' and published_at is null and retired_at is null)
    or (status = 'published' and published_at is not null and retired_at is null)
    or (
      status in ('retired', 'superseded')
      and published_at is not null
      and retired_at is not null
      and retired_at >= published_at
    )
  ),
  constraint package_versions_created_before_publication_check check (
    published_at is null or published_at >= created_at
  ),
  constraint package_versions_exam_version_unique unique (exam_key, package_version),
  constraint package_versions_package_hash_unique unique (package_hash)
);

create table exam_delivery.package_profiles (
  id uuid primary key default gen_random_uuid(),
  package_version_id uuid not null references exam_delivery.package_versions(id) on delete restrict,
  profile_key text not null,
  display_name text not null,
  question_count integer not null,
  time_limit_minutes integer,
  selection_config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint package_profiles_key_nonempty check (btrim(profile_key) <> ''),
  constraint package_profiles_display_name_nonempty check (btrim(display_name) <> ''),
  constraint package_profiles_question_count_check check (question_count > 0),
  constraint package_profiles_time_limit_check check (
    time_limit_minutes is null or time_limit_minutes > 0
  ),
  constraint package_profiles_selection_config_object_check check (
    jsonb_typeof(selection_config) = 'object'
  ),
  constraint package_profiles_version_key_unique unique (package_version_id, profile_key),
  constraint package_profiles_version_id_unique unique (package_version_id, id)
);

-- This table contains only fields that a future active-attempt projection may
-- safely select. Answer, scoring, explanation, and remediation data belongs in
-- package_question_protected_content below.
create table exam_delivery.package_questions (
  id uuid primary key default gen_random_uuid(),
  package_version_id uuid not null references exam_delivery.package_versions(id) on delete restrict,
  question_id text not null,
  question_type text not null,
  domain_key text not null,
  section_key text,
  source_ordinal integer not null,
  presentation_payload jsonb not null,
  content_hash text not null,
  created_at timestamptz not null default now(),
  constraint package_questions_question_id_nonempty check (btrim(question_id) <> ''),
  constraint package_questions_type_nonempty check (btrim(question_type) <> ''),
  constraint package_questions_domain_nonempty check (btrim(domain_key) <> ''),
  constraint package_questions_section_nonempty check (
    section_key is null or btrim(section_key) <> ''
  ),
  constraint package_questions_source_ordinal_check check (source_ordinal > 0),
  constraint package_questions_presentation_object_check check (
    jsonb_typeof(presentation_payload) = 'object'
  ),
  constraint package_questions_content_hash_check check (
    content_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint package_questions_version_question_unique unique (package_version_id, question_id),
  constraint package_questions_version_ordinal_unique unique (package_version_id, source_ordinal),
  constraint package_questions_version_id_unique unique (package_version_id, id)
);

create table exam_delivery.package_question_protected_content (
  question_id uuid primary key,
  package_version_id uuid not null,
  scoring_payload jsonb not null,
  review_payload jsonb not null,
  authoring_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint package_question_protected_question_fk
    foreign key (package_version_id, question_id)
    references exam_delivery.package_questions(package_version_id, id)
    on delete restrict,
  constraint package_question_protected_scoring_object_check check (
    jsonb_typeof(scoring_payload) = 'object'
  ),
  constraint package_question_protected_review_object_check check (
    jsonb_typeof(review_payload) = 'object'
  ),
  constraint package_question_protected_authoring_object_check check (
    jsonb_typeof(authoring_metadata) = 'object'
  )
);

create table exam_delivery.publication_runs (
  id uuid primary key default gen_random_uuid(),
  publication_request_id uuid not null unique,
  package_version_id uuid references exam_delivery.package_versions(id) on delete restrict,
  actor_user_id uuid references auth.users(id) on delete set null,
  source_commit_sha text not null,
  expected_validation_hash text not null,
  expected_package_hash text not null,
  actual_package_hash text,
  status exam_delivery.publication_run_status not null default 'pending',
  error_code text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint publication_runs_source_commit_sha_check check (
    source_commit_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
  ),
  constraint publication_runs_validation_hash_check check (
    expected_validation_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint publication_runs_expected_package_hash_check check (
    expected_package_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint publication_runs_actual_package_hash_check check (
    actual_package_hash is null or actual_package_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint publication_runs_error_code_nonempty check (
    error_code is null or btrim(error_code) <> ''
  ),
  constraint publication_runs_completion_state_check check (
    (status = 'pending' and completed_at is null and error_code is null)
    or (
      status = 'succeeded'
      and completed_at is not null
      and error_code is null
      and actual_package_hash = expected_package_hash
    )
    or (status = 'failed' and completed_at is not null and error_code is not null)
  ),
  constraint publication_runs_completed_after_created_check check (
    completed_at is null or completed_at >= created_at
  )
);

-- A missing row is disabled. The only initial gate is also explicitly disabled.
create table exam_delivery.pilot_gates (
  exam_key text primary key,
  enabled boolean not null default false,
  enabled_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pilot_gates_exam_key_nonempty check (
    btrim(exam_key) <> '' and exam_key ~ '^[a-z0-9][a-z0-9-]*$'
  ),
  constraint pilot_gates_enabled_timestamp_check check (
    (enabled = true and enabled_at is not null and disabled_at is null)
    or (
      enabled = false
      and (
        (enabled_at is null and disabled_at is null)
        or (enabled_at is not null and disabled_at is not null and disabled_at >= enabled_at)
      )
    )
  ),
  constraint pilot_gates_disabled_timestamp_check check (
    disabled_at is null or disabled_at >= created_at
  )
);

create table exam_delivery.pilot_access (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  exam_key text not null references exam_delivery.pilot_gates(exam_key) on delete restrict,
  enabled boolean not null default false,
  access_starts_at timestamptz,
  access_ends_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pilot_access_window_check check (
    access_ends_at is null
    or access_starts_at is null
    or access_ends_at > access_starts_at
  ),
  constraint pilot_access_user_exam_unique unique (user_id, exam_key)
);

create table exam_delivery.attempts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete restrict,
  package_version_id uuid not null references exam_delivery.package_versions(id) on delete restrict,
  package_profile_id uuid not null,
  client_request_id uuid not null,
  status exam_delivery.attempt_status not null default 'in_progress',
  generator_version text not null,
  scorer_version text not null,
  created_at timestamptz not null default now(),
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  submitted_at timestamptz,
  completed_at timestamptz,
  constraint attempts_package_profile_fk
    foreign key (package_version_id, package_profile_id)
    references exam_delivery.package_profiles(package_version_id, id)
    on delete restrict,
  constraint attempts_generator_version_nonempty check (btrim(generator_version) <> ''),
  constraint attempts_scorer_version_nonempty check (btrim(scorer_version) <> ''),
  constraint attempts_start_created_order_check check (started_at >= created_at),
  constraint attempts_expiry_order_check check (expires_at > started_at),
  constraint attempts_submission_order_check check (
    submitted_at is null or submitted_at >= started_at
  ),
  constraint attempts_completion_order_check check (
    completed_at is null
    or (submitted_at is not null and completed_at >= submitted_at)
  ),
  constraint attempts_lifecycle_timestamps_check check (
    (status = 'in_progress' and submitted_at is null and completed_at is null)
    or (status = 'submitted' and submitted_at is not null and completed_at is null)
    or (status = 'completed' and submitted_at is not null and completed_at is not null)
    or (status in ('expired', 'abandoned', 'voided') and completed_at is null)
  ),
  constraint attempts_owner_request_unique unique (owner_id, client_request_id),
  constraint attempts_id_owner_unique unique (id, owner_id),
  constraint attempts_id_package_version_unique unique (id, package_version_id)
);

create table exam_delivery.attempt_items (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null,
  package_version_id uuid not null,
  package_question_id uuid not null,
  presented_question_number integer not null,
  section_ordinal integer,
  option_order jsonb not null default '[]'::jsonb,
  presentation_snapshot jsonb not null,
  presentation_hash text not null,
  created_at timestamptz not null default now(),
  constraint attempt_items_attempt_version_fk
    foreign key (attempt_id, package_version_id)
    references exam_delivery.attempts(id, package_version_id)
    on delete restrict,
  constraint attempt_items_package_question_fk
    foreign key (package_version_id, package_question_id)
    references exam_delivery.package_questions(package_version_id, id)
    on delete restrict,
  constraint attempt_items_question_number_check check (presented_question_number > 0),
  constraint attempt_items_section_ordinal_check check (
    section_ordinal is null or section_ordinal > 0
  ),
  constraint attempt_items_option_order_array_check check (
    jsonb_typeof(option_order) = 'array'
  ),
  constraint attempt_items_presentation_object_check check (
    jsonb_typeof(presentation_snapshot) = 'object'
  ),
  constraint attempt_items_presentation_hash_check check (
    presentation_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint attempt_items_attempt_number_unique unique (attempt_id, presented_question_number),
  constraint attempt_items_attempt_question_unique unique (attempt_id, package_question_id),
  constraint attempt_items_attempt_id_unique unique (attempt_id, id)
);

create table exam_delivery.attempt_item_protected_content (
  attempt_item_id uuid primary key,
  attempt_id uuid not null,
  scoring_snapshot jsonb not null,
  review_snapshot jsonb not null,
  protected_snapshot_hash text not null,
  created_at timestamptz not null default now(),
  constraint attempt_item_protected_item_fk
    foreign key (attempt_id, attempt_item_id)
    references exam_delivery.attempt_items(attempt_id, id)
    on delete restrict,
  constraint attempt_item_protected_scoring_object_check check (
    jsonb_typeof(scoring_snapshot) = 'object'
  ),
  constraint attempt_item_protected_review_object_check check (
    jsonb_typeof(review_snapshot) = 'object'
  ),
  constraint attempt_item_protected_hash_check check (
    protected_snapshot_hash ~ '^[0-9a-f]{64}$'
  )
);

create table exam_delivery.attempt_responses (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null,
  attempt_item_id uuid not null,
  response_payload jsonb not null,
  revision integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint attempt_responses_item_fk
    foreign key (attempt_id, attempt_item_id)
    references exam_delivery.attempt_items(attempt_id, id)
    on delete restrict,
  constraint attempt_responses_payload_object_check check (
    jsonb_typeof(response_payload) = 'object'
  ),
  constraint attempt_responses_revision_check check (revision >= 0),
  constraint attempt_responses_updated_order_check check (updated_at >= created_at),
  constraint attempt_responses_attempt_item_unique unique (attempt_id, attempt_item_id)
);

create table exam_delivery.attempt_results (
  attempt_id uuid primary key references exam_delivery.attempts(id) on delete restrict,
  submission_id uuid not null unique,
  response_hash text not null,
  scorer_version text not null,
  raw_score numeric(12, 4) not null,
  max_score numeric(12, 4) not null,
  raw_percentage numeric(7, 4) not null,
  passed boolean,
  domain_summary jsonb not null default '{}'::jsonb,
  result_summary jsonb not null default '{}'::jsonb,
  server_authoritative boolean not null default true,
  submitted_at timestamptz not null,
  completed_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint attempt_results_response_hash_check check (
    response_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint attempt_results_scorer_version_nonempty check (btrim(scorer_version) <> ''),
  constraint attempt_results_score_bounds_check check (
    raw_score >= 0 and max_score > 0 and raw_score <= max_score
  ),
  constraint attempt_results_percentage_check check (
    raw_percentage >= 0 and raw_percentage <= 100
  ),
  constraint attempt_results_domain_summary_object_check check (
    jsonb_typeof(domain_summary) = 'object'
  ),
  constraint attempt_results_result_summary_object_check check (
    jsonb_typeof(result_summary) = 'object'
  ),
  constraint attempt_results_server_authoritative_check check (server_authoritative = true),
  constraint attempt_results_completion_order_check check (completed_at >= submitted_at),
  constraint attempt_results_created_order_check check (created_at >= completed_at)
);

create table exam_delivery.review_snapshots (
  attempt_id uuid primary key references exam_delivery.attempt_results(attempt_id) on delete restrict,
  release_status exam_delivery.review_release_status not null default 'withheld',
  review_payload jsonb not null,
  review_hash text not null,
  created_at timestamptz not null default now(),
  released_at timestamptz,
  constraint review_snapshots_payload_object_check check (
    jsonb_typeof(review_payload) = 'object'
  ),
  constraint review_snapshots_hash_check check (
    review_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint review_snapshots_release_state_check check (
    (release_status = 'withheld' and released_at is null)
    or (release_status = 'released' and released_at is not null)
  ),
  constraint review_snapshots_release_order_check check (
    released_at is null or released_at >= created_at
  )
);

create index package_versions_supersedes_idx
  on exam_delivery.package_versions (supersedes_package_version_id);
create index package_versions_publication_selection_idx
  on exam_delivery.package_versions (exam_key, status, published_at desc);
create index publication_runs_package_version_idx
  on exam_delivery.publication_runs (package_version_id);
create index publication_runs_actor_user_idx
  on exam_delivery.publication_runs (actor_user_id);
create index package_question_protected_version_idx
  on exam_delivery.package_question_protected_content (package_version_id);
create index pilot_access_exam_key_idx
  on exam_delivery.pilot_access (exam_key);
create index pilot_access_exam_user_idx
  on exam_delivery.pilot_access (exam_key, user_id)
  where enabled = true;
create index attempts_owner_status_idx
  on exam_delivery.attempts (owner_id, status, started_at desc);
create index attempts_package_version_idx
  on exam_delivery.attempts (package_version_id);
create index attempts_package_profile_idx
  on exam_delivery.attempts (package_profile_id);
create index attempts_active_expiry_idx
  on exam_delivery.attempts (expires_at)
  where status in ('in_progress', 'submitted');
create index attempt_items_package_question_idx
  on exam_delivery.attempt_items (package_question_id);
create index attempt_item_protected_attempt_idx
  on exam_delivery.attempt_item_protected_content (attempt_id);

-- Published package identity/content is append-only. Draft package children may
-- be assembled, but cannot be changed after their parent leaves draft state.
create function exam_delivery.guard_package_version_immutability()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'Published, retired, or superseded package versions cannot be deleted.';
    end if;
    return old;
  end if;

  if old.status <> 'draft' and (
    new.id is distinct from old.id
    or new.exam_key is distinct from old.exam_key
    or new.package_version is distinct from old.package_version
    or new.source_commit_sha is distinct from old.source_commit_sha
    or new.validation_hash is distinct from old.validation_hash
    or new.package_hash is distinct from old.package_hash
    or new.package_schema_version is distinct from old.package_schema_version
    or new.generator_version is distinct from old.generator_version
    or new.scorer_version is distinct from old.scorer_version
    or new.supersedes_package_version_id is distinct from old.supersedes_package_version_id
    or new.created_at is distinct from old.created_at
    or new.published_at is distinct from old.published_at
    or (old.retired_at is not null and new.retired_at is distinct from old.retired_at)
  ) then
    raise exception 'Published package identity and content are immutable.';
  end if;

  if not (
    new.status = old.status
    or (old.status = 'draft' and new.status = 'published')
    or (old.status = 'published' and new.status in ('retired', 'superseded'))
  ) then
    raise exception 'Invalid package publication lifecycle transition.';
  end if;

  return new;
end;
$$;

create function exam_delivery.guard_package_child_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  old_parent_status exam_delivery.package_publication_status;
  new_parent_status exam_delivery.package_publication_status;
begin
  if tg_op <> 'INSERT' then
    select package.status
      into old_parent_status
      from exam_delivery.package_versions as package
     where package.id = old.package_version_id;

    if old_parent_status is distinct from 'draft'::exam_delivery.package_publication_status then
      raise exception 'Published package children are immutable.';
    end if;
  end if;

  if tg_op <> 'DELETE' then
    select package.status
      into new_parent_status
      from exam_delivery.package_versions as package
     where package.id = new.package_version_id;

    if new_parent_status is distinct from 'draft'::exam_delivery.package_publication_status then
      raise exception 'Package children may only be written while the package is draft.';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;

create function exam_delivery.guard_attempt_identity_and_lifecycle()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Protected attempts are retained and cannot be deleted.';
  end if;

  if new.id is distinct from old.id
    or new.owner_id is distinct from old.owner_id
    or new.package_version_id is distinct from old.package_version_id
    or new.package_profile_id is distinct from old.package_profile_id
    or new.client_request_id is distinct from old.client_request_id
    or new.generator_version is distinct from old.generator_version
    or new.scorer_version is distinct from old.scorer_version
    or new.created_at is distinct from old.created_at
    or new.started_at is distinct from old.started_at
    or new.expires_at is distinct from old.expires_at
  then
    raise exception 'Protected attempt identity and version traceability are immutable.';
  end if;

  if not (
    new.status = old.status
    or (old.status = 'in_progress' and new.status in ('submitted', 'completed', 'expired', 'abandoned', 'voided'))
    or (old.status = 'submitted' and new.status in ('completed', 'voided'))
  ) then
    raise exception 'Invalid protected attempt lifecycle transition.';
  end if;

  if old.status in ('completed', 'expired', 'abandoned', 'voided') then
    raise exception 'Terminal protected attempts are immutable.';
  end if;

  if old.submitted_at is not null and new.submitted_at is distinct from old.submitted_at then
    raise exception 'Protected attempt submission timestamps are immutable once set.';
  end if;

  return new;
end;
$$;

create function exam_delivery.guard_attempt_response_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  parent_status exam_delivery.attempt_status;
  target_attempt_id uuid;
begin
  if tg_op = 'DELETE' then
    target_attempt_id := old.attempt_id;
  else
    target_attempt_id := new.attempt_id;
  end if;

  select attempt.status
    into parent_status
    from exam_delivery.attempts as attempt
   where attempt.id = target_attempt_id;

  if parent_status is distinct from 'in_progress'::exam_delivery.attempt_status then
    raise exception 'Responses may only change while the protected attempt is in progress.';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;

create function exam_delivery.reject_immutable_row_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception 'Protected snapshot and result rows are immutable.';
end;
$$;

create function exam_delivery.guard_review_release()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Protected review snapshots cannot be deleted.';
  end if;

  if new.attempt_id is distinct from old.attempt_id
    or new.review_payload is distinct from old.review_payload
    or new.review_hash is distinct from old.review_hash
    or new.created_at is distinct from old.created_at
  then
    raise exception 'Protected review content is immutable.';
  end if;

  if not (
    new.release_status = old.release_status
    or (old.release_status = 'withheld' and new.release_status = 'released')
  ) then
    raise exception 'Invalid review-release transition.';
  end if;

  if old.released_at is not null and new.released_at is distinct from old.released_at then
    raise exception 'Review-release timestamps are immutable once set.';
  end if;

  return new;
end;
$$;

create trigger guard_package_version_immutability
before update or delete on exam_delivery.package_versions
for each row execute function exam_delivery.guard_package_version_immutability();

create trigger guard_package_profiles_mutation
before insert or update or delete on exam_delivery.package_profiles
for each row execute function exam_delivery.guard_package_child_mutation();

create trigger guard_package_questions_mutation
before insert or update or delete on exam_delivery.package_questions
for each row execute function exam_delivery.guard_package_child_mutation();

create trigger guard_package_question_protected_mutation
before insert or update or delete on exam_delivery.package_question_protected_content
for each row execute function exam_delivery.guard_package_child_mutation();

create trigger guard_attempt_identity_and_lifecycle
before update or delete on exam_delivery.attempts
for each row execute function exam_delivery.guard_attempt_identity_and_lifecycle();

create trigger reject_attempt_item_mutation
before update or delete on exam_delivery.attempt_items
for each row execute function exam_delivery.reject_immutable_row_mutation();

create trigger reject_attempt_item_protected_mutation
before update or delete on exam_delivery.attempt_item_protected_content
for each row execute function exam_delivery.reject_immutable_row_mutation();

create trigger guard_attempt_response_mutation
before insert or update or delete on exam_delivery.attempt_responses
for each row execute function exam_delivery.guard_attempt_response_mutation();

create trigger reject_attempt_result_mutation
before update or delete on exam_delivery.attempt_results
for each row execute function exam_delivery.reject_immutable_row_mutation();

create trigger guard_review_release
before update or delete on exam_delivery.review_snapshots
for each row execute function exam_delivery.guard_review_release();

alter table exam_delivery.package_versions enable row level security;
alter table exam_delivery.package_profiles enable row level security;
alter table exam_delivery.package_questions enable row level security;
alter table exam_delivery.package_question_protected_content enable row level security;
alter table exam_delivery.publication_runs enable row level security;
alter table exam_delivery.pilot_gates enable row level security;
alter table exam_delivery.pilot_access enable row level security;
alter table exam_delivery.attempts enable row level security;
alter table exam_delivery.attempt_items enable row level security;
alter table exam_delivery.attempt_item_protected_content enable row level security;
alter table exam_delivery.attempt_responses enable row level security;
alter table exam_delivery.attempt_results enable row level security;
alter table exam_delivery.review_snapshots enable row level security;

revoke all on all tables in schema exam_delivery from public, anon, authenticated, service_role;
revoke all on all sequences in schema exam_delivery from public, anon, authenticated, service_role;
revoke execute on all functions in schema exam_delivery from public, anon, authenticated, service_role;
revoke usage on type exam_delivery.package_publication_status
  from public, anon, authenticated, service_role;
revoke usage on type exam_delivery.publication_run_status
  from public, anon, authenticated, service_role;
revoke usage on type exam_delivery.attempt_status
  from public, anon, authenticated, service_role;
revoke usage on type exam_delivery.review_release_status
  from public, anon, authenticated, service_role;

-- Minimal non-sensitive gate identity only. No package, question, answer, user,
-- attempt, response, result, or review data is seeded.
insert into exam_delivery.pilot_gates (exam_key, enabled)
values ('ai-901', false);
