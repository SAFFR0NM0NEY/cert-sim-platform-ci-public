-- Issue #85: register the immutable Python Standard package with the audited
-- release operation and avoid advertising PBQ practice for packages without
-- PBQ inventory. Existing configured products are not rewritten.

insert into exam_delivery.exam_release_candidates(
  canonical_exam_key, package_version, profile_key, release_template,
  catalogue_slug, catalogue_title, catalogue_vendor,
  catalogue_exam_type, catalogue_source_type
) values (
  'inf303', '1.0.0', 'inf303-standard', 'standard_active_exam_v1',
  'inf303', 'INF-303 — Python Standard', 'Certiport',
  'certification', 'official_source'
)
on conflict (canonical_exam_key, package_version, profile_key) do update set
  release_template = excluded.release_template,
  catalogue_slug = excluded.catalogue_slug,
  catalogue_title = excluded.catalogue_title,
  catalogue_vendor = excluded.catalogue_vendor,
  catalogue_exam_type = excluded.catalogue_exam_type,
  catalogue_source_type = excluded.catalogue_source_type;

do $issue85_release$
declare
  v_definition text;
  v_updated text;
  v_needle text := $$from unnest(array['self_directed_exam','study_sandbox','targeted_domain','weak_area','pbq_practice']) purpose(value)$$;
  v_replacement text := $$from unnest(case when exists(
      select 1 from exam_delivery.package_questions release_question
      where release_question.package_version_id = v_package.package_version_id
        and release_question.question_type like 'pbq-%'
    ) then array['self_directed_exam','study_sandbox','targeted_domain','weak_area','pbq_practice']
      else array['self_directed_exam','study_sandbox','targeted_domain','weak_area'] end) purpose(value)$$;
begin
  v_definition := pg_get_functiondef('exam_delivery.configure_exam_release_stage(uuid,jsonb)'::regprocedure);
  if (length(v_definition) - length(replace(v_definition, v_needle, ''))) / length(v_needle) <> 2 then
    raise exception 'issue85_release_configuration_contract_drift';
  end if;
  v_updated := replace(v_definition, v_needle, v_replacement);
  if v_updated = v_definition
    or (length(v_updated) - length(replace(v_updated, 'release_question.question_type like ''pbq-%''', ''))) /
      length('release_question.question_type like ''pbq-%''') <> 2
  then
    raise exception 'issue85_release_configuration_contract_drift';
  end if;
  execute v_updated;
end $issue85_release$;

alter function exam_delivery.configure_exam_release_stage(uuid,jsonb) owner to postgres;
revoke execute on function exam_delivery.configure_exam_release_stage(uuid,jsonb)
  from public, anon, authenticated, service_role;
