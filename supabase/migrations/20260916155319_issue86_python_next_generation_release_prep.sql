-- Issue #86: register the independently releasable Python Next Generation
-- profiles without activating or publishing either profile.

insert into exam_delivery.exam_release_candidates(
  canonical_exam_key,
  package_version,
  profile_key,
  release_template,
  catalogue_slug,
  catalogue_title,
  catalogue_vendor,
  catalogue_exam_type,
  catalogue_source_type
)
values
  (
    'pythonnextgeneration',
    '1.0.0',
    'pythonnextgeneration-no-lab',
    'standard_active_exam_v1',
    'pythonnextgeneration',
    'Python Next Generation',
    'Certiport',
    'certification',
    'official_source'
  ),
  (
    'pythonnextgeneration',
    '1.0.0',
    'pythonnextgeneration-lab',
    'standard_active_exam_v1',
    'pythonnextgeneration',
    'Python Next Generation',
    'Certiport',
    'certification',
    'official_source'
  )
on conflict (canonical_exam_key, package_version, profile_key)
do update set
  release_template=excluded.release_template,
  catalogue_slug=excluded.catalogue_slug,
  catalogue_title=excluded.catalogue_title,
  catalogue_vendor=excluded.catalogue_vendor,
  catalogue_exam_type=excluded.catalogue_exam_type,
  catalogue_source_type=excluded.catalogue_source_type;
