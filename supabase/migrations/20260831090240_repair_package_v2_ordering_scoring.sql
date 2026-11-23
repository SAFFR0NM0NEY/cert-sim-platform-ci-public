-- PostgreSQL WITH ORDINALITY exposes its ordinal as bigint, while the jsonb
-- array extraction operator accepts an integer index. Keep the fixed scorer
-- contract intact and make the positional comparison type-safe.
create or replace function exam_delivery.score_package_v2_response(
  p_question_type text,p_scoring jsonb,p_response jsonb,p_scored boolean
)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  v_answer jsonb := coalesce(p_response->'answer',p_response->'selectedAnswer');
  v_selected jsonb := coalesce(p_response->'selectedAnswers',p_response->'answer');
  v_order jsonb := coalesce(p_response->'selectedOrder',p_response->'answer');
  v_expected jsonb;
  v_earned numeric := 0;
  v_max numeric := 1;
  v_complete boolean := true;
  v_strategy text := p_scoring->>'strategy';
begin
  if not p_scored then return jsonb_build_object('earned',0,'maximum',0,'status','Informational'); end if;
  if p_question_type='single-choice' then
    v_earned := case when v_answer=to_jsonb(p_scoring->>'correctAnswer') or v_answer=to_jsonb(p_scoring->>'correctOptionId') then 1 else 0 end;
  elsif p_question_type='multi-select' then
    v_expected:=coalesce(p_scoring->'correctAnswers',p_scoring->'correctOptionIds');
    v_earned:=case when jsonb_typeof(v_selected)='array' and
      (select coalesce(jsonb_agg(x order by x),'[]'::jsonb) from jsonb_array_elements_text(v_selected) x)=
      (select coalesce(jsonb_agg(x order by x),'[]'::jsonb) from jsonb_array_elements_text(v_expected) x)
      and jsonb_array_length(v_selected)=jsonb_array_length(v_expected) then 1 else 0 end;
  elsif p_question_type='reorder' then
    v_earned:=case when v_order=coalesce(p_scoring->'correctOrder',p_scoring->'correctItemIds') then 1 else 0 end;
  elsif p_question_type='drag-drop-match' then
    v_earned:=case when v_selected=coalesce(p_scoring->'correctPairs',p_scoring->'correctPairsByPrompt') then 1 else 0 end;
  elsif p_question_type in ('dropdown-code','dropdown-command') then
    select coalesce(jsonb_object_agg(x->>'id',to_jsonb(x->>'correctAnswer')),'{}'::jsonb)
      into v_expected from jsonb_array_elements(coalesce(p_scoring->'blanks','[]'::jsonb)) x;
    v_earned:=case when v_selected=v_expected then 1 else 0 end;
  elsif v_strategy in ('per-component-map','per-component-positive') then
    v_expected:=coalesce(p_scoring->'expectedMap','{}'::jsonb);
    select count(*) into v_max from jsonb_object_keys(v_expected);
    select count(*) into v_earned from jsonb_each(v_expected) e
      where p_response->'selectedAnswers'->e.key=e.value;
    if v_strategy='per-component-positive' and exists(
      select 1 from jsonb_each(coalesce(p_response->'selectedAnswers','{}'::jsonb)) a
      where v_expected->a.key is distinct from a.value
    ) then v_complete:=false; end if;
  elsif v_strategy='exact-ordered-sequence' then
    v_expected:=coalesce(p_scoring->'expectedOrder','[]'::jsonb);
    v_max:=jsonb_array_length(v_expected);
    select count(*) into v_earned
    from jsonb_array_elements_text(v_expected) with ordinality e(value,n)
    where p_response->'selectedOrder'->>((e.n-1)::integer)=e.value;
  elsif v_strategy='weighted-rule-evaluation' then
    v_max:=coalesce((p_scoring->>'finalAnswerPoints')::numeric,0)+coalesce((select sum((x->>'points')::numeric) from jsonb_array_elements(coalesce(p_scoring->'criteria','[]'::jsonb)) x),0);
    if p_response->>'selectedAnswer'=p_scoring->>'expectedAnswer' then v_earned:=coalesce((p_scoring->>'finalAnswerPoints')::numeric,0); end if;
    v_earned:=v_earned+coalesce((select sum((c->>'points')::numeric) from jsonb_array_elements(coalesce(p_scoring->'criteria','[]'::jsonb)) c where exists(select 1 from jsonb_array_elements_text(coalesce(c->'commandIds','[]'::jsonb)) expected where exists(select 1 from jsonb_array_elements_text(coalesce(p_response->'executedCommands','[]'::jsonb)) actual where actual=expected))),0);
  elsif v_strategy='exact-whole-state' then
    v_earned:=case when p_response->'selectedAnswer'=p_scoring->'expectedAnswer' then 1 else 0 end;
  else
    raise exception 'unsupported_scoring_model' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_array_elements_text(coalesce(p_scoring->'requiredCommandIds','[]'::jsonb)) required where not exists(select 1 from jsonb_array_elements_text(coalesce(p_response->'executedCommands','[]'::jsonb)) actual where actual=required)) then v_complete:=false; end if;
  return jsonb_build_object('earned',v_earned,'maximum',v_max,'status',case when p_response is null or p_response='{}'::jsonb or not v_complete then 'Incomplete' when v_earned=v_max then 'Correct' when v_earned>0 then 'Partial' else 'Incorrect' end);
end;
$$;

revoke execute on function exam_delivery.score_package_v2_response(text,jsonb,jsonb,boolean)
  from public,anon,authenticated,service_role;
