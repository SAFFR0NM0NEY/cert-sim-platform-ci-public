begin;
select plan(11);

select has_table('exam_delivery','exam_release_candidates','release-candidate authority exists');
select is((
  select count(*)::integer
  from exam_delivery.exam_release_candidates
  where canonical_exam_key='pythonnextgeneration'
),2,'Python Next Generation has exactly two release candidates');
select is((
  select count(*)::integer
  from exam_delivery.exam_release_candidates
  where canonical_exam_key='pythonnextgeneration'
    and package_version='1.0.0'
    and profile_key='pythonnextgeneration-no-lab'
),1,'the no-lab profile is independently registered');
select is((
  select count(*)::integer
  from exam_delivery.exam_release_candidates
  where canonical_exam_key='pythonnextgeneration'
    and package_version='1.0.0'
    and profile_key='pythonnextgeneration-lab'
),1,'the lab profile is independently registered');
select is((
  select count(*)::integer
  from exam_delivery.exam_release_candidates
  where canonical_exam_key='pythonnextgeneration'
    and package_version='1.0.0'
    and release_template='standard_active_exam_v1'
    and catalogue_slug='pythonnextgeneration'
    and catalogue_title='Python Next Generation'
    and catalogue_vendor='Certiport'
    and catalogue_exam_type='certification'
    and catalogue_source_type='official_source'
),2,'both candidates use the exact shared release metadata');
select is((
  select count(distinct profile_key)::integer
  from exam_delivery.exam_release_candidates
  where canonical_exam_key='pythonnextgeneration' and package_version='1.0.0'
),2,'the two profile identities remain distinct');
select is((
  select count(distinct catalogue_slug)::integer
  from exam_delivery.exam_release_candidates
  where canonical_exam_key='pythonnextgeneration' and package_version='1.0.0'
),1,'both profiles retain one logical catalogue identity');
select is((select count(*)::integer from public.exam_catalog where exam_key='pythonnextgeneration'),0,'migration does not create a catalogue row');
select is((
  select count(*)::integer
  from exam_delivery.exam_profile_activations a
  join exam_delivery.package_versions pv on pv.id=a.package_version_id
  where pv.exam_key='pythonnextgeneration' and pv.package_version='1.0.0'
),0,'migration does not activate either profile');
select is((select count(*)::integer from exam_delivery.package_profile_defaults where canonical_exam_key='pythonnextgeneration'),0,'migration does not create profile defaults');
select is((select count(*)::integer from exam_delivery.practice_policies where canonical_exam_key='pythonnextgeneration'),0,'migration does not create practice policy');

select * from finish();
rollback;
