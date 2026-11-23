-- Issue #26: preserve the legacy-purpose contract while detoasting each
-- historical JSON snapshot once per classification.  The previous SQL form
-- could repeatedly decompress the same large result snapshot for each path.

create or replace function exam_delivery.classify_legacy_result(
  p_profile_id text,
  p_mode_label text,
  p_attempt_snapshot jsonb,
  p_result_snapshot jsonb,
  p_status text,
  p_submitted_at timestamptz,
  p_raw_score numeric,
  p_raw_percentage numeric
) returns text
language plpgsql
immutable
set search_path=''
as $$
declare
  v_attempt jsonb := coalesce(p_attempt_snapshot, '{}'::jsonb) || '{}'::jsonb;
  v_result jsonb := coalesce(p_result_snapshot, '{}'::jsonb) || '{}'::jsonb;
  v_searchable text;
  v_explicit_purpose text;
begin
  v_searchable := lower(regexp_replace(concat_ws(' ',
    p_profile_id,
    p_mode_label,
    v_attempt->'mode'->>'id',
    v_attempt->'mode'->>'name',
    v_attempt->'mode'->>'label',
    v_attempt->'profile'->>'id',
    v_attempt->'profile'->>'name',
    v_attempt->'profile'->>'sourceFlow',
    v_attempt->'metadata'->>'sourceFlow',
    v_result->>'sourceFlow',
    v_result->>'attemptKind',
    v_result->'metadata'->>'sourceFlow',
    v_result->'exam'->>'sourceFlow',
    v_result->'exam'->'mode'->>'id',
    v_result->'exam'->'mode'->>'name',
    v_result->'exam'->'profile'->>'id',
    v_result->'exam'->'profile'->>'sourceFlow'
  ), '[^a-zA-Z0-9]+', '_', 'g'));

  v_explicit_purpose := lower(replace(replace(coalesce(
    v_result->>'purpose',
    v_result->'metadata'->>'purpose',
    v_result->'exam'->>'purpose',
    v_attempt->'metadata'->>'purpose',
    ''
  ), '-', '_'), ' ', '_'));

  return case
    when v_explicit_purpose in ('assigned_assessment','self_directed_exam') then v_explicit_purpose
    when v_explicit_purpose in ('study_sandbox','targeted_domain','weak_area','pbq_practice') then v_explicit_purpose
    when v_searchable ~ '(^|_)weak(_area)?(_focus)?($|_)' then 'weak_area'
    when v_searchable ~ '(^|_)study_sandbox($|_)' or v_searchable ~ '(^|_)sandbox($|_)' then 'study_sandbox'
    when v_searchable ~ '(^|_)targeted_(practice|domain)($|_)' then 'targeted_domain'
    when v_searchable ~ '(^|_)pbq_(preview|practice)($|_)' then 'pbq_practice'
    when v_searchable ~ '(^|_)case_(study_)?preview($|_)' then 'study_sandbox'
    when p_status='submitted' and p_submitted_at is not null
      and (p_raw_score is not null or p_raw_percentage is not null)
      and v_searchable ~ '(^|_)(full|full_mock|full_practice|compact|strict_beta|controlled_beta|realistic|sectioned|certification|exam)($|_)'
      then 'self_directed_exam'
    else 'unclassified'
  end;
end
$$;

alter function exam_delivery.classify_legacy_result(text,text,jsonb,jsonb,text,timestamptz,numeric,numeric) owner to postgres;
revoke execute on function exam_delivery.classify_legacy_result(text,text,jsonb,jsonb,text,timestamptz,numeric,numeric)
  from public,anon,authenticated,service_role;
