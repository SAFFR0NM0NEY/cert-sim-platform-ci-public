-- Ordinary selected-response items need not declare an authored group role.
-- Preserve every reviewed selector rule; make the PBQ classification total.
do $migration$
declare
  definition text;
  anchor constant text := 'else group_role=''atomic-pbq'' end) pbq';
  replacement constant text := 'else coalesce(group_role=''atomic-pbq'',false) end) pbq';
begin
  definition := pg_get_functiondef('exam_delivery.materialize_attempt_items_issue21_unrotated_base(uuid,uuid,integer)'::regprocedure);
  if (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> 1 then
    raise exception 'issue232_practice_pbq_predicate_contract_drift' using errcode='P0001';
  end if;
  execute replace(definition,anchor,replacement);
end
$migration$;
