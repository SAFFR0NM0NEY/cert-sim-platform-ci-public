-- Versioned structured-response support for the INF-303 Python Standard package.
-- Existing package-v2 response envelopes and persistence remain unchanged.

create or replace function exam_delivery.randomize_presentation_arrays(p_value jsonb,p_seed text,p_path text default '$')
returns jsonb language plpgsql immutable security invoker set search_path='' as $$
declare v_type text:=jsonb_typeof(p_value); v_result jsonb; v_key text; v_entry jsonb;
begin
  if v_type='object' then
    v_result:='{}'::jsonb;
    for v_key,v_entry in select key,value from jsonb_each(p_value) loop
      if jsonb_typeof(v_entry)='array' and lower(v_key)=any(array['options','items','choices','availableoptions','commands','targets']) then
        select coalesce(jsonb_agg(exam_delivery.randomize_presentation_arrays(element.value,p_seed,p_path||'.'||v_key||'['||element.n||']') order by md5(p_seed||':'||p_path||':'||v_key||':'||coalesce(element.value->>'id',element.n::text))),'[]'::jsonb)
          into v_entry from jsonb_array_elements(v_entry) with ordinality element(value,n);
      else
        v_entry:=exam_delivery.randomize_presentation_arrays(v_entry,p_seed,p_path||'.'||v_key);
      end if;
      v_result:=v_result||jsonb_build_object(v_key,v_entry);
    end loop;
    return v_result;
  elsif v_type='array' then
    select coalesce(jsonb_agg(exam_delivery.randomize_presentation_arrays(element.value,p_seed,p_path||'['||element.n||']') order by element.n),'[]'::jsonb)
      into v_result from jsonb_array_elements(p_value) with ordinality element(value,n);
    return v_result;
  end if;
  return p_value;
end;
$$;

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
      and (select count(*)=count(distinct value) from jsonb_array_elements_text(v_answer) value)
      and not exists(select 1 from jsonb_array_elements_text(v_answer) value where not exists(select 1 from jsonb_array_elements(coalesce(p_presentation->'options','[]'::jsonb)) option where option->>'id'=value));
  elsif p_question_type='reorder' and jsonb_typeof(v_answer)='array' then
    return jsonb_array_length(v_answer)<=100 and (select count(*)=count(distinct value) from jsonb_array_elements_text(v_answer) value)
      and not exists(select 1 from jsonb_array_elements_text(v_answer) value where not exists(select 1 from jsonb_array_elements(coalesce(p_presentation->'items','[]'::jsonb)) item where item->>'id'=value));
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

create or replace function exam_delivery.score_package_v2_response(
  p_question_type text, p_scoring jsonb, p_response jsonb, p_scored boolean
)
returns jsonb language plpgsql immutable security invoker set search_path='' as $$
declare
  v_answer jsonb:=coalesce(p_response->'answer',p_response->'selectedAnswer');
  v_selected jsonb:=coalesce(p_response->'selectedAnswers',p_response->'answer');
  v_order jsonb:=coalesce(p_response->'selectedOrder',p_response->'answer');
  v_expected jsonb; v_earned numeric:=0; v_max numeric:=1; v_complete boolean:=true; v_strategy text:=p_scoring->>'strategy';
begin
  if not p_scored then return jsonb_build_object('earned',0,'maximum',0,'status','Informational'); end if;
  if p_question_type='single-choice' then v_earned:=case when v_answer=to_jsonb(coalesce(p_scoring->>'correctAnswer',p_scoring->>'correctOptionId')) then 1 else 0 end;
  elsif p_question_type='true-false-single-v1' then v_earned:=case when v_answer=p_scoring->'correctValue' then 1 else 0 end;
  elsif p_question_type='multi-select' then v_expected:=coalesce(p_scoring->'correctAnswers',p_scoring->'correctOptionIds'); v_earned:=case when jsonb_typeof(v_selected)='array' and (select coalesce(jsonb_agg(value order by value),'[]'::jsonb) from jsonb_array_elements_text(v_selected) value)=(select coalesce(jsonb_agg(value order by value),'[]'::jsonb) from jsonb_array_elements_text(v_expected) value) and jsonb_array_length(v_selected)=jsonb_array_length(v_expected) then 1 else 0 end;
  elsif p_question_type='reorder' then v_earned:=case when v_order=coalesce(p_scoring->'correctOrder',p_scoring->'correctItemIds') then 1 else 0 end;
  elsif p_question_type='drag-drop-match' then v_earned:=case when v_selected=coalesce(p_scoring->'correctPairs',p_scoring->'correctPairsByPrompt') then 1 else 0 end;
  elsif p_question_type in ('true-false-composite-v1','matching-v1') then
    v_expected:=case when p_question_type='true-false-composite-v1' then p_scoring->'correctValuesByStatement' else p_scoring->'correctTargetIdsBySource' end;
    v_max:=(select count(*) from jsonb_object_keys(v_expected));
    v_earned:=(select count(*) from jsonb_each(v_expected) expected where v_selected->expected.key=expected.value);
    v_complete:=(select count(*) from jsonb_object_keys(coalesce(v_selected,'{}'::jsonb)))=v_max;
  elsif p_question_type='code-dropdown-completion-v1' then
    v_expected:=p_scoring->'correctOptionIdsByBlank';
    v_max:=coalesce((p_scoring->>'maximumRawPoints')::numeric,(select count(*) from jsonb_object_keys(v_expected)));
    v_earned:=coalesce((select sum(coalesce((p_scoring->'pointsByBlank'->>expected.key)::numeric,1)) from jsonb_each(v_expected) expected where v_selected->expected.key=expected.value),0);
    v_complete:=(select count(*) from jsonb_object_keys(coalesce(v_selected,'{}'::jsonb)))=(select count(*) from jsonb_object_keys(v_expected));
  elsif p_question_type in ('dropdown-code','dropdown-command') then select coalesce(jsonb_object_agg(item->>'id',to_jsonb(item->>'correctAnswer')),'{}'::jsonb) into v_expected from jsonb_array_elements(coalesce(p_scoring->'blanks','[]'::jsonb)) item; v_earned:=case when v_selected=v_expected then 1 else 0 end;
  elsif v_strategy in ('per-component-map','per-component-positive') then v_expected:=coalesce(p_scoring->'expectedMap','{}'::jsonb); select count(*) into v_max from jsonb_object_keys(v_expected); select count(*) into v_earned from jsonb_each(v_expected) expected where p_response->'selectedAnswers'->expected.key=expected.value; if v_strategy='per-component-positive' and exists(select 1 from jsonb_each(coalesce(p_response->'selectedAnswers','{}'::jsonb)) actual where v_expected->actual.key is distinct from actual.value) then v_complete:=false; end if;
  elsif v_strategy='exact-ordered-sequence' then v_expected:=coalesce(p_scoring->'expectedOrder','[]'::jsonb); v_max:=jsonb_array_length(v_expected); select count(*) into v_earned from jsonb_array_elements_text(v_expected) with ordinality expected(value,n) where p_response->'selectedOrder'->>((expected.n-1)::integer)=expected.value;
  elsif v_strategy='weighted-rule-evaluation' then v_max:=coalesce((p_scoring->>'finalAnswerPoints')::numeric,0)+coalesce((select sum((item->>'points')::numeric) from jsonb_array_elements(coalesce(p_scoring->'criteria','[]'::jsonb)) item),0); if p_response->>'selectedAnswer'=p_scoring->>'expectedAnswer' then v_earned:=coalesce((p_scoring->>'finalAnswerPoints')::numeric,0); end if; v_earned:=v_earned+coalesce((select sum((criterion->>'points')::numeric) from jsonb_array_elements(coalesce(p_scoring->'criteria','[]'::jsonb)) criterion where exists(select 1 from jsonb_array_elements_text(coalesce(criterion->'commandIds','[]'::jsonb)) expected where exists(select 1 from jsonb_array_elements_text(coalesce(p_response->'executedCommands','[]'::jsonb)) actual where actual=expected))),0);
  elsif v_strategy='exact-whole-state' then v_earned:=case when p_response->'selectedAnswer'=p_scoring->'expectedAnswer' then 1 else 0 end;
  else raise exception 'unsupported_scoring_model' using errcode='22023'; end if;
  if exists(select 1 from jsonb_array_elements_text(coalesce(p_scoring->'requiredCommandIds','[]'::jsonb)) required where not exists(select 1 from jsonb_array_elements_text(coalesce(p_response->'executedCommands','[]'::jsonb)) actual where actual=required)) then v_complete:=false; end if;
  return jsonb_build_object('earned',v_earned,'maximum',v_max,'status',case when p_response is null or p_response='{}'::jsonb or not v_complete then 'Incomplete' when v_earned=v_max then 'Correct' when v_earned>0 then 'Partial' else 'Incorrect' end);
end;
$$;

revoke execute on function exam_delivery.package_v2_response_valid(text,jsonb,jsonb) from public,anon,authenticated,service_role;
revoke execute on function exam_delivery.score_package_v2_response(text,jsonb,jsonb,boolean) from public,anon,authenticated,service_role;
