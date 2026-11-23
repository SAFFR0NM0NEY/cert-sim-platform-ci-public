-- Test-only source inspection. Follow only these explicit count wrappers, and
-- require their delegation before combining wrapper and retained source. This
-- preserves negative source assertions across both layers and old schemas.
create or replace function pg_temp.certsim_effective_definition(p_function regprocedure)
returns text language plpgsql set search_path='' as $$
declare wrapper text := pg_get_functiondef(p_function);
  original_name text; base_name text; base_oid oid;
begin
  select p.proname into original_name from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    where p.oid=p_function and n.nspname='exam_delivery';
  base_name := case original_name
    when 'resume_attempt' then 'resume_attempt_issue214_fixed_base'
    when 'practice_availability' then 'practice_availability_issue214_fixed_base'
    when 'check_profile_eligibility' then 'check_profile_eligibility_issue214_fixed_base'
    when 'list_current_attempt_bindings' then 'list_current_attempt_bindings_issue214_fixed_base'
    when 'print_summary' then 'print_summary_issue214_fixed_base' end;
  if base_name is null then return wrapper; end if;
  select p.oid into base_oid from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    where n.nspname='exam_delivery' and p.proname=base_name;
  if not found then return wrapper; end if;
  if position(('exam_delivery.'||base_name||'(') in wrapper)=0 then
    raise exception 'retained_wrapper_delegation_missing';
  end if;
  return wrapper || E'\n' || pg_get_functiondef(base_oid);
end $$;
