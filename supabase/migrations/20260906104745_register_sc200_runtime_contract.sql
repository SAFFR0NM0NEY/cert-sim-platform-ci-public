-- Register only the reviewed SC-200 package-v2 generator/scorer tuple.
-- This migration creates no package, access, assignment, or runtime data.

do $$
begin
  if not exam_delivery.package_v2_runtime_supported('certsim-ai901-weighted-generator-v2','certsim-ai901-exact-scorer-v2',null)
     or not exam_delivery.package_v2_runtime_supported('certsim-az204-grouped-generator-v1','certsim-az204-exact-scorer-v1',null)
     or not exam_delivery.package_v2_runtime_supported('certsim-security-plus-pbq-first-generator-v1','certsim-security-plus-authoritative-pbq-scorer-v1','certsim-protected-pbq-runtime-v1')
     or not exam_delivery.package_v2_runtime_supported('certsim-az400-case-workspace-generator-v1','certsim-az400-authoritative-scorer-v1','certsim-protected-pbq-runtime-v1')
     or exam_delivery.package_v2_runtime_supported('certsim-sc200-canonical-forms-v1','certsim-selected-response-partial-v1',null)
     or exam_delivery.package_v2_runtime_supported('certsim-sc200-canonical-forms-v1','certsim-az204-exact-scorer-v1',null)
     or exam_delivery.package_v2_runtime_supported('certsim-az204-grouped-generator-v1','certsim-selected-response-partial-v1',null)
     or exam_delivery.package_v2_runtime_supported('unknown-generator','unknown-scorer',null)
  then
    raise exception 'sc200_runtime_precondition_drift';
  end if;
end
$$;

create or replace function exam_delivery.package_v2_runtime_supported(
  p_generator text,
  p_scorer text,
  p_pbq_runtime text default null
)
returns boolean
language sql
immutable
parallel unsafe
security invoker
set search_path = ''
as $$
  select (p_generator,p_scorer) in (
      ('certsim-ai901-weighted-generator-v2','certsim-ai901-exact-scorer-v2'),
      ('certsim-az204-grouped-generator-v1','certsim-az204-exact-scorer-v1'),
      ('certsim-security-plus-pbq-first-generator-v1','certsim-security-plus-authoritative-pbq-scorer-v1'),
      ('certsim-az400-case-workspace-generator-v1','certsim-az400-authoritative-scorer-v1'),
      ('certsim-sc200-canonical-forms-v1','certsim-selected-response-partial-v1')
    )
    and (p_pbq_runtime is null or p_pbq_runtime = 'certsim-protected-pbq-runtime-v1')
$$;

alter function exam_delivery.package_v2_runtime_supported(text,text,text) owner to postgres;
revoke execute on function exam_delivery.package_v2_runtime_supported(text,text,text)
from public, anon, authenticated, service_role;
grant execute on function exam_delivery.package_v2_runtime_supported(text,text,text) to postgres;

do $$
begin
  if not exam_delivery.package_v2_runtime_supported('certsim-ai901-weighted-generator-v2','certsim-ai901-exact-scorer-v2',null)
     or not exam_delivery.package_v2_runtime_supported('certsim-az204-grouped-generator-v1','certsim-az204-exact-scorer-v1',null)
     or not exam_delivery.package_v2_runtime_supported('certsim-security-plus-pbq-first-generator-v1','certsim-security-plus-authoritative-pbq-scorer-v1','certsim-protected-pbq-runtime-v1')
     or not exam_delivery.package_v2_runtime_supported('certsim-az400-case-workspace-generator-v1','certsim-az400-authoritative-scorer-v1','certsim-protected-pbq-runtime-v1')
     or not exam_delivery.package_v2_runtime_supported('certsim-sc200-canonical-forms-v1','certsim-selected-response-partial-v1',null)
     or exam_delivery.package_v2_runtime_supported('certsim-sc200-canonical-forms-v1','certsim-az204-exact-scorer-v1',null)
     or exam_delivery.package_v2_runtime_supported('certsim-az204-grouped-generator-v1','certsim-selected-response-partial-v1',null)
     or exam_delivery.package_v2_runtime_supported('certsim-sc200-canonical-forms-v1','certsim-selected-response-partial-v1','unsupported-runtime')
     or exam_delivery.package_v2_runtime_supported('unknown-generator','unknown-scorer',null)
  then
    raise exception 'sc200_runtime_postcondition_failed';
  end if;
end
$$;
