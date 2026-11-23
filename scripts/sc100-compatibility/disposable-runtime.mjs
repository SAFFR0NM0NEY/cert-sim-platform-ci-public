import fs from 'node:fs';import {createHash} from 'node:crypto';import {spawnSync} from 'node:child_process';
const paths={runtime:'supabase/migrations/20260916103000_issue86_trusted_grading_completion.sql',variable:'supabase/migrations/20261027162647_issue214_variable_python_forms.sql',mixed:'supabase/migrations/20261028170153_issue214_mixed_variable_forms.sql',scorer:'supabase/migrations/20260906115046_selected_response_partial_scorer.sql'};
const read=key=>fs.readFileSync(paths[key],'utf8');
const sha=s=>createHash('sha256').update(s).digest('hex');
function definition(sql,name){const start=sql.search(new RegExp('create(?: or replace)? function exam_delivery\\.'+name+'\\('));if(start<0)throw Error('SOURCE_FUNCTION_MISSING');const end=sql.indexOf('$$;',start);if(end<0)throw Error('SOURCE_FUNCTION_END_MISSING');return sql.slice(start,end+3);}
export function runtimeSql(){
 const base=definition(read('runtime'),'package_v2_runtime_supported');
 const v=read('variable'),start=v.indexOf('do $extend$'),end=v.indexOf('  execute replace(d,needle,replacement);',start);
 if(start<0||end<0||!v.slice(start,end).includes("pg_get_functiondef('exam_delivery.package_v2_runtime_supported"))throw Error('VARIABLE_RUNTIME_FRAGMENT_DRIFT');
 const variable=v.slice(start,end+'  execute replace(d,needle,replacement);'.length)+'\nend $extend$;';
 const m=read('mixed'),ms=m.indexOf('do $mixed$'),me=m.indexOf('end $mixed$;',ms);
 if(ms<0||me<0||!m.slice(ms,me).includes("pg_get_functiondef('exam_delivery.package_v2_runtime_supported"))throw Error('MIXED_RUNTIME_FRAGMENT_DRIFT');
 return [base,variable,m.slice(ms,me+'end $mixed$;'.length),definition(read('scorer'),'score_selected_response_partial')].join('\n');
}
export function sourceProof(){return Object.fromEntries(Object.entries(paths).map(([key,path])=>[key,{path,sha256:sha(fs.readFileSync(path))}]))}
if(process.argv.includes('--run-disposable')){
 if(process.env.GITHUB_ACTIONS!=='true'||process.env.PGHOST!=='127.0.0.1'||process.env.PGDATABASE!=='certsim_sc100_synthetic')throw Error('DISPOSABLE_CI_ONLY');
 const psql=input=>{const r=spawnSync('psql',['-X','--no-psqlrc','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-At'],{input,encoding:'utf8'});if(r.status!==0){const detail=r.stderr.split('\n').find(line=>line.includes('ERROR:'))??'SQL_ERROR_WITHOUT_DETAIL';const context=r.stderr.split('\n').filter(line=>/^(LINE |QUERY:|CONTEXT:)/.test(line)).join(' | ');throw Error('DISPOSABLE_SQL_ASSERTION_FAILED: '+detail.slice(0,240)+' '+context.slice(0,500));}return r.stdout;};
 if(Number(psql("select current_setting('server_version_num');").trim())<170000||Number(psql("select current_setting('server_version_num');").trim())>=180000)throw Error('POSTGRES17_REQUIRED');
 const assertions=`
 do $test$ declare r jsonb; total numeric; f int; i int; n int; begin
 if exam_delivery.package_v2_runtime_supported('certsim-sc100-canonical-forms-v1','certsim-selected-response-partial-v1',null) then raise exception 'SC100_RUNTIME_UNEXPECTEDLY_ALLOWED'; end if;
 if not exam_delivery.package_v2_runtime_supported('certsim-sc200-canonical-forms-v1','certsim-selected-response-partial-v1',null) then raise exception 'EXISTING_SC200_RUNTIME_REGRESSED'; end if;
 if exam_delivery.package_v2_runtime_supported('unknown','certsim-selected-response-partial-v1',null) or exam_delivery.package_v2_runtime_supported('certsim-sc200-canonical-forms-v1','unknown',null) then raise exception 'STRICT_TUPLE_BOUNDARY_REGRESSED'; end if;
 for f in 1..6 loop total:=0;
 for i in 1..50 loop
 n:=case when i>case when f%2=1 then 38 else 37 end then 2 else 1 end;
 r:=exam_delivery.score_selected_response_partial(case when n=1 then 'single-choice' else 'multi-select' end,
 jsonb_build_object('options',jsonb_build_array(jsonb_build_object('id','a'),jsonb_build_object('id','b'),jsonb_build_object('id','c')),'requiredSelections',n),
 jsonb_build_object('model','per-correct-option-no-negative-v1','correctAnswers',case when n=1 then '["a"]'::jsonb else '["a","b"]'::jsonb end,'selectionCap',n,'maximumRawPoints',n),
 case when n=1 then '{"answer":"a"}'::jsonb else '{"answer":["a","b"]}'::jsonb end,true);
 if (r->>'earned')::numeric<>n or (r->>'maximum')::numeric<>n then raise exception 'SELECTED_SCORER_REGRESSED';end if;
 total:=total+(r->>'maximum')::numeric;end loop;
 if total<>(case when f%2=1 then 62 else 63 end) then raise exception 'FORM_MAXIMUM_REGRESSED';end if;end loop;
 end $test$;
 do $test$ declare p jsonb:='{"options":[{"id":"a"},{"id":"b"},{"id":"c"}],"requiredSelections":2}';s jsonb:='{"model":"per-correct-option-no-negative-v1","correctAnswers":["a","b"],"selectionCap":2,"maximumRawPoints":2}';r jsonb;begin
 r:=exam_delivery.score_selected_response_partial('multi-select',p,s,'{"answer":["a"]}',true);if r->>'earned'<>'1' or r->>'maximum'<>'2' then raise exception 'PARTIAL_SCORING_REGRESSED';end if;
 r:=exam_delivery.score_selected_response_partial('multi-select',p,s,'{"answer":["c"]}',true);if r->>'earned'<>'0' then raise exception 'WRONG_SCORING_REGRESSED';end if;
 r:=exam_delivery.score_selected_response_partial('multi-select',p,s,null,true);if r->>'earned'<>'0' or r->>'status'<>'Incomplete' then raise exception 'UNANSWERED_SCORING_REGRESSED';end if;
 begin perform exam_delivery.score_selected_response_partial('multi-select',p,s,'{"answer":["a","b","c"]}',true);raise exception 'OVERCAP_ACCEPTED';exception when sqlstate '22023' then null;end;
 begin perform exam_delivery.score_selected_response_partial('multi-select',p,s,'{"answer":["a","a"]}',true);raise exception 'DUPLICATE_ACCEPTED';exception when sqlstate '22023' then null;end;
 end $test$;`;
 try{psql('begin;create schema exam_delivery;\n'+runtimeSql()+'\n'+assertions+'\nrollback;');}
 finally{if(psql("select count(*) from pg_namespace where nspname='exam_delivery';").trim()!=='0')throw Error('INDEPENDENT_DISPOSABLE_CLEANUP_FAILED');}
 const proof={sourceSha:process.env.GITHUB_SHA,sources:sourceProof(),postgresMajor:17,syntheticOnly:true,candidateExamKey:'sc100',candidateGenerator:'certsim-sc200-canonical-forms-v1',candidateRuntimeSupported:true,unregisteredLegacySc100IdentifierSupported:false,selectedResponseScores:300,forms:6,rawMaxima:[62,63,62,63,62,63],partialWrongUnansweredAndAdmissibilityChecks:true,independentCleanup:true,migrationsApplied:0,productionActions:0};
 fs.writeFileSync(process.env.RUNNER_TEMP+'/sc100-runtime-proof.json',JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
}
