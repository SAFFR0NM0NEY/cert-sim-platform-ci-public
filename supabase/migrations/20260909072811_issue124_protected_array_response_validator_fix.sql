-- Repair ambiguous JSON set-returning-function aliases in package-v2 array
-- response validation. Response envelopes, limits, scoring, and privileges are
-- intentionally unchanged.

create or replace function exam_delivery.package_v2_response_valid(
  p_question_type text, p_presentation jsonb, p_response jsonb
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  v_answer jsonb := p_response -> 'answer';
  v_allowed jsonb := p_presentation -> 'responseAllowlist';
begin
  if jsonb_typeof(p_response) <> 'object'
     or pg_catalog.pg_column_size(p_response) > 65536
     or exists (select 1 from jsonb_object_keys(p_response) key where key not in ('answer','selectedAnswer','selectedAnswers','selectedOrder','executedCommands','revision')) then
    return false;
  end if;
  if p_question_type = 'single-choice' and jsonb_typeof(v_answer) = 'string' then
    return exists(select 1 from jsonb_array_elements(coalesce(p_presentation->'options','[]'::jsonb)) option where option->>'id'=p_response->>'answer');
  elsif p_question_type = 'true-false-single-v1' then
    return jsonb_typeof(v_answer) = 'boolean';
  elsif p_question_type = 'multi-select' and jsonb_typeof(v_answer) = 'array' then
    return jsonb_array_length(v_answer)<=50
      and (select count(*)=count(distinct selected.selected_value) from jsonb_array_elements_text(v_answer) as selected(selected_value))
      and not exists(
        select 1
        from jsonb_array_elements_text(v_answer) as selected(selected_value)
        where not exists(
          select 1
          from jsonb_array_elements(coalesce(p_presentation->'options','[]'::jsonb)) as allowed(option_value)
          where allowed.option_value->>'id'=selected.selected_value
        )
      );
  elsif p_question_type='reorder' and jsonb_typeof(v_answer)='array' then
    return jsonb_array_length(v_answer)<=100
      and (select count(*)=count(distinct selected.selected_value) from jsonb_array_elements_text(v_answer) as selected(selected_value))
      and not exists(
        select 1
        from jsonb_array_elements_text(v_answer) as selected(selected_value)
        where not exists(
          select 1
          from jsonb_array_elements(coalesce(p_presentation->'items','[]'::jsonb)) as allowed(item_value)
          where allowed.item_value->>'id'=selected.selected_value
        )
      );
  elsif p_question_type = 'true-false-composite-v1' then
    return jsonb_typeof(v_answer)='object'
      and (select count(*) from jsonb_object_keys(v_answer)) <= 100
      and not exists(select 1 from jsonb_each(v_answer) response where jsonb_typeof(response.value)<>'boolean' or not exists(select 1 from jsonb_array_elements(coalesce(p_presentation->'statements','[]'::jsonb)) statement where statement->>'id'=response.key));
  elsif p_question_type = 'matching-v1' then
    return jsonb_typeof(v_answer)='object'
      and (select count(*) from jsonb_object_keys(v_answer)) <= 100
      and not exists(select 1 from jsonb_each_text(v_answer) response where not exists(select 1 from jsonb_array_elements(coalesce(p_presentation->'sources','[]'::jsonb)) source where source->>'id'=response.key) or not exists(select 1 from jsonb_array_elements(coalesce(p_presentation->'targets','[]'::jsonb)) target where target->>'id'=response.value))
      and (coalesce((p_presentation->>'allowTargetReuse')::boolean,false) or (select count(*)=count(distinct value) from jsonb_each_text(v_answer)));
  elsif p_question_type = 'code-dropdown-completion-v1' then
    return jsonb_typeof(v_answer)='object'
      and (select count(*) from jsonb_object_keys(v_answer)) <= 100
      and not exists(select 1 from jsonb_each_text(v_answer) response where not exists(select 1 from jsonb_array_elements(coalesce(p_presentation->'blanks','[]'::jsonb)) blank where blank->>'id'=response.key and exists(select 1 from jsonb_array_elements(coalesce(blank->'options','[]'::jsonb)) option where option->>'id'=response.value)));
  elsif p_question_type in ('drag-drop-match','dropdown-code','dropdown-command') then
    return jsonb_typeof(v_answer)='object' and (select count(*) from jsonb_object_keys(v_answer))<=100;
  elsif p_question_type like 'pbq-%' then
    if jsonb_typeof(v_allowed)<>'object' then return false; end if;
    if p_response?'selectedAnswer' and not (coalesce(v_allowed->'answerIds','[]'::jsonb) @> jsonb_build_array(p_response->>'selectedAnswer')) then return false; end if;
    if p_response?'selectedOrder' and (jsonb_typeof(p_response->'selectedOrder')<>'array' or exists(select 1 from jsonb_array_elements_text(p_response->'selectedOrder') value where not (coalesce(v_allowed->'orderIds','[]'::jsonb) @> jsonb_build_array(value)))) then return false; end if;
    if p_response?'selectedAnswers' and (jsonb_typeof(p_response->'selectedAnswers')<>'object' or exists(select 1 from jsonb_each_text(p_response->'selectedAnswers') response where not (coalesce(v_allowed->'targetIds','[]'::jsonb) @> jsonb_build_array(response.key)) or not (coalesce(case when jsonb_typeof(v_allowed->'answerIdsByTarget')='object' then v_allowed->'answerIdsByTarget'->response.key else (select entry->'answerIds' from jsonb_array_elements(coalesce(v_allowed->'answerIdsByTarget','[]'::jsonb)) entry where entry->>'targetId'=response.key limit 1) end,'[]'::jsonb) @> jsonb_build_array(response.value)))) then return false; end if;
    if p_response?'executedCommands' and (jsonb_typeof(p_response->'executedCommands')<>'array' or jsonb_array_length(p_response->'executedCommands')>100 or exists(select 1 from jsonb_array_elements_text(p_response->'executedCommands') value where length(value)>256 or not (coalesce(v_allowed->'commandIds','[]'::jsonb) @> jsonb_build_array(value)))) then return false; end if;
    return true;
  end if;
  return p_response='{}'::jsonb;
end;
$$;

revoke execute on function exam_delivery.package_v2_response_valid(text,jsonb,jsonb) from public,anon,authenticated,service_role;
