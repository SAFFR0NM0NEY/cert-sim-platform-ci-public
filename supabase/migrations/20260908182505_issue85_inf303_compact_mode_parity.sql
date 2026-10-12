-- Issue #85: extend the fixed-form Python materializer to multiple profiles.
-- Profile-specific reserves remain in immutable selection_config; the existing
-- package reserve table continues to mean questions absent from every profile.

do $issue85_compact$
declare
  v_prepare text;
  v_old text;
  v_new text;
begin
  v_prepare := pg_get_functiondef('exam_delivery.prepare_canonical_forms_on_publish()'::regprocedure);

  v_old := $$or (select count(*) from exam_delivery.package_profiles pp where pp.package_version_id = new.id) <> 1$$;
  v_new := $$or (select count(*) from exam_delivery.package_profiles pp where pp.package_version_id = new.id) not between 1 and 20$$;
  if (length(v_prepare)-length(replace(v_prepare,v_old,'')))/length(v_old) <> 1 then
    raise exception 'issue85_python_profile_count_contract_drift';
  end if;
  v_prepare := replace(v_prepare,v_old,v_new);

  v_old := $$insert into exam_delivery.package_reserve_questions(package_version_id, package_question_id)
      select new.id, q.id
      from jsonb_array_elements_text(v_contract->'reserveQuestionIds') reserve(question_id)
      join exam_delivery.package_questions q
        on q.package_version_id = new.id and q.question_id = reserve.question_id;
      get diagnostics v_member_count = row_count;
      if v_member_count <> jsonb_array_length(v_contract->'reserveQuestionIds') then
        raise exception 'canonical_form_reserve_materialization_incomplete' using errcode = 'P0001';
      end if;$$;
  v_new := $$-- Profile-specific reserve membership is validated above and remains
      -- immutable in package_profiles.selection_config. It is intentionally not
      -- inserted into the package-global reserve table inside this loop.$$;
  if (length(v_prepare)-length(replace(v_prepare,v_old,'')))/length(v_old) <> 1 then
    raise exception 'issue85_python_reserve_contract_drift';
  end if;
  v_prepare := replace(v_prepare,v_old,v_new);

  v_old := $$    new.declared_review_release_policy := 'after_submission';$$;
  v_new := $$    insert into exam_delivery.package_reserve_questions(package_version_id, package_question_id)
    select new.id, q.id
    from exam_delivery.package_questions q
    where q.package_version_id = new.id
      and not exists (
        select 1 from exam_delivery.package_form_questions fq
        where fq.package_version_id = new.id and fq.package_question_id = q.id
      );
    get diagnostics v_member_count = row_count;
    if v_member_count <> (
      select count(*) from exam_delivery.package_questions q
      where q.package_version_id = new.id
        and not exists (
          select 1 from exam_delivery.package_form_questions fq
          where fq.package_version_id = new.id and fq.package_question_id = q.id
        )
    ) then
      raise exception 'canonical_form_reserve_materialization_incomplete' using errcode = 'P0001';
    end if;

    new.declared_review_release_policy := 'after_submission';$$;
  if (length(v_prepare)-length(replace(v_prepare,v_old,'')))/length(v_old) <> 1 then
    raise exception 'issue85_python_global_reserve_contract_drift';
  end if;
  execute replace(v_prepare,v_old,v_new);
end $issue85_compact$;

alter function exam_delivery.prepare_canonical_forms_on_publish() owner to postgres;
revoke execute on function exam_delivery.prepare_canonical_forms_on_publish()
from public, anon, authenticated, service_role;
grant execute on function exam_delivery.prepare_canonical_forms_on_publish() to postgres;

insert into exam_delivery.exam_release_candidates(
  canonical_exam_key, package_version, profile_key, release_template,
  catalogue_slug, catalogue_title, catalogue_vendor,
  catalogue_exam_type, catalogue_source_type
) values
  ('inf303','1.1.0','inf303-standard','standard_active_exam_v1','inf303','INF-303 — Python Standard','Certiport','certification','official_source'),
  ('inf303','1.1.0','inf303-compact','standard_active_exam_v1','inf303','INF-303 — Python Standard','Certiport','certification','official_source')
on conflict (canonical_exam_key,package_version,profile_key) do update set
  release_template=excluded.release_template,
  catalogue_slug=excluded.catalogue_slug,
  catalogue_title=excluded.catalogue_title,
  catalogue_vendor=excluded.catalogue_vendor,
  catalogue_exam_type=excluded.catalogue_exam_type,
  catalogue_source_type=excluded.catalogue_source_type;

