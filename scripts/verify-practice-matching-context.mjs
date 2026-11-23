import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {createClient} from '@supabase/supabase-js';
const api=process.env.SUPABASE_URL,db=process.env.SUPABASE_DB_URL;
for(const v of [api,db])if(!v||!['localhost','127.0.0.1','[::1]'].includes(new URL(v).hostname))throw Error('DISPOSABLE_REQUIRED');
if(!process.env.RUNNER_TEMP)throw Error('DISPOSABLE_TEMP_REQUIRED');
const before=process.argv.includes('--before'),phase=before?'before':'after';
let assertions=0;const eq=(a,b,label)=>{assert.deepEqual(a,b,label);assertions++;};
const sql=input=>{const r=spawnSync('psql',[db,'-XqAt','-v','ON_ERROR_STOP=1'],{input,encoding:'utf8'});if(r.status)throw Error('SYNTHETIC_SQL_FAILED');return r.stdout.trim();};
const accounts=JSON.parse(await readFile(path.join(process.env.RUNNER_TEMP,'practice-matching-accounts.json'),'utf8'));
const admin=createClient(api,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
for(const a of accounts){
 const id=sql(`select id from exam_delivery.attempts where owner_id='${a.id}'`),other=accounts.find(b=>b.id!==a.id);
 const resumed=await admin.rpc('certsim_protected_resume_attempt',{p_actor_id:a.id,p_attempt_id:id});eq(resumed.error,null);eq(resumed.data.ok,true);eq(resumed.data.attempt.attemptId,id);eq(resumed.data.attempt.packageVersion,a.packageVersion);eq(resumed.data.attempt.countContract,undefined);
 const page=await admin.rpc('certsim_protected_list_attempt_item_page',{p_actor_id:a.id,p_attempt_id:id,p_after_position:20,p_page_size:20});eq(page.error,null);eq(page.data.ok,true);eq(page.data.items.length,10);
 for(const value of [resumed.data,page.data]){
  if(before)eq(value.presentationPolicy,undefined);
  else eq(value.presentationPolicy,{version:'certsim-attempt-presentation-v1',attemptId:id,matchingReuse:a.legacy?'legacy-preserve':'strict-boolean-default-false'});
  for(const item of value.items){eq(item.presentation.allowTargetReuse,a.policy==='omitted'?undefined:a.policy==='true','raw snapshot remains authored');eq(Object.hasOwn(item.presentation,'correctTargetIdsBySource'),false);}
 }
 const denied=await admin.rpc('certsim_protected_list_attempt_item_page',{p_actor_id:other.id,p_attempt_id:id,p_after_position:20,p_page_size:20});eq(denied.error,null);eq(denied.data.ok,false);eq(denied.data.presentationPolicy,undefined);eq(denied.data.items,undefined);
 eq(sql(`select count(*) from exam_delivery.attempts where owner_id='${a.id}'`),'1');
}
if(!before){
 for(const role of ['anon','authenticated','service_role'])eq(sql(`select has_function_privilege('${role}','exam_delivery.attempt_presentation_context(uuid,uuid,jsonb)','execute')`),'f');
 eq(sql(`select has_function_privilege('service_role','public.certsim_protected_list_attempt_item_page(uuid,uuid,integer,integer)','execute')`),'t');
 eq(sql(`select to_regprocedure('exam_delivery.list_attempt_item_page_issue214_presentation_base(uuid,uuid,integer,integer)') is null`),'t');
 eq(sql(`select provolatile='s' and proconfig @> array['search_path=""','statement_timeout=3s'] from pg_proc where oid='exam_delivery.attempt_presentation_context(uuid,uuid,jsonb)'::regprocedure`),'t');
}
const proof={suite:'practice-owner-pinned-context',phase,assertions,accounts:accounts.length,sourceSnapshotsUnmodified:true,wrongOwnerContextAbsent:true,syntheticOnly:true};console.log(JSON.stringify(proof));await writeFile(path.join(process.env.RUNNER_TEMP,`practice-${phase}-context.json`),JSON.stringify(proof),{mode:0o600});
