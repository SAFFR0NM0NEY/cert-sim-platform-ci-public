-- Repository-only AI-901 package-v2 runtime registration.
-- This migration creates no package, access policy, scope, gate, assignment,
-- attempt, result, or review row.

create or replace function exam_delivery.package_v2_runtime_supported(
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
  select (p_generator,p_scorer) in (
      ('certsim-ai901-weighted-generator-v2','certsim-ai901-exact-scorer-v2'),
      ('certsim-az204-grouped-generator-v1','certsim-az204-exact-scorer-v1'),
      ('certsim-security-plus-pbq-first-generator-v1','certsim-security-plus-authoritative-pbq-scorer-v1'),
      ('certsim-az400-case-workspace-generator-v1','certsim-az400-authoritative-scorer-v1')
    )
    and (p_pbq_runtime is null or p_pbq_runtime = 'certsim-protected-pbq-runtime-v1')
$$;
