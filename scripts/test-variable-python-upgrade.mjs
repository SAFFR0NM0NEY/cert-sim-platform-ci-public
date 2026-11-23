import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { variablePythonCandidate } from './fixtures/variable-python-forms.mjs';
import { sha256Canonical } from './backend-exam-publication/canonical-json.mjs';
const db=process.env.SUPABASE_DB_URL,api=process.env.SUPABASE_URL;
for(const value of [db,api])if(!value||!['localhost','127.0.0.1','[::1]'].includes(new URL(value).hostname))throw Error('DISPOSABLE_UPGRADE_REQUIRED');
if(!process.env.RUNNER_TEMP)throw Error('DISPOSABLE_TEMP_REQUIRED');
const checkpoint=path.join(process.env.RUNNER_TEMP,'variable-prior96.json');
const admin=createClient(api,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
let assertions=0;const eq=(a,b)=>{assert.deepEqual(a,b);assertions++;};
function sql(input,allowFailure=false){const r=spawnSync('psql',[db,'-XqAt','-v','ON_ERROR_STOP=1'],{input,encoding:'utf8'});if(r.status&&!allowFailure)throw Error('SYNTHETIC_UPGRADE_SQL_FAILED');return allowFailure?r.status:r.stdout.trim();}
const snapshot=(ids)=>JSON.parse(sql(`select jsonb_agg(jsonb_build_object('id',a.id,'owner',a.owner_id,'attemptHash',md5(to_jsonb(a)::text),'deadline',a.expires_at,'items',(select jsonb_agg(i.id order by i.presented_question_number) from exam_delivery.attempt_items i where i.attempt_id=a.id)) order by a.id) from exam_delivery.attempts a${ids?` where a.id in (${ids.map(id=>`'${id}'::uuid`).join(',')})`:''}`));
function fixtureDdlProbe(id,drain=false) {
  const r=spawnSync('psql',[db,'-XqAt','-v','ON_ERROR_STOP=1','-v','VERBOSITY=sqlstate'],{encoding:'utf8',input:`begin;
    alter table exam_delivery.attempts disable trigger guard_attempt_identity_and_lifecycle;
    update exam_delivery.attempts set status=status where id='${id}'::uuid;
    ${drain?'set constraints all immediate;':''}
    alter table exam_delivery.attempts enable trigger guard_attempt_identity_and_lifecycle;
    rollback;`});
  return {ok:r.status===0,sqlstate:r.stderr.match(/ERROR:\s+([0-9A-Z]{5})/)?.[1]??null};
}
if(process.argv.includes('--seed96')) {
  const report=execFileSync(process.execPath,['scripts/test-issue214-reserve-materialization.mjs','--prior96'],{encoding:'utf8',env:process.env});
  console.log(report.trim());
  const rows=snapshot();eq(rows.length,2);
  eq(fixtureDdlProbe(rows[0].id),{ok:true,sqlstate:null});
  eq(fixtureDdlProbe(rows[0].id,true),{ok:true,sqlstate:null});
  console.log(JSON.stringify({suite:'variable-prior96-fixture-ddl',undrained:'pass',drained:'pass',syntheticOnly:true}));
  const missing=await admin.rpc('certsim_protected_count_contract',{p_actor_id:rows[0].owner,p_operation:'resume',p_arguments:{p_attempt_id:rows[0].id},p_count_contract:'certsim-authorised-form-count-v1'});
  eq(missing.error?.code,'PGRST202');
  const candidate=variablePythonCandidate(),request={publicationRequestId:crypto.randomUUID(),sourceCommitSha:'c'.repeat(40),packagePayload:candidate,packageHash:sha256Canonical(candidate)};
  eq(sql(`set request.jwt.claim.sub='${rows[0].owner}';set role authenticated;select public.certsim_protected_publish_package($request$${JSON.stringify(request)}$request$::jsonb);`,true)>0,true);
  eq(sql("select count(*) from exam_delivery.package_versions where generator_version='certsim-python-standard-variable-forms-v2'"),'0');
  await writeFile(checkpoint,JSON.stringify(rows),{mode:0o600});
  console.log(JSON.stringify({suite:'variable-prior96-unsupported-backend',assertions,normalFixedAttempts:2,variablePublicationRejected:true,syntheticOnly:true}));
} else {
  eq(sql('select count(*) from supabase_migrations.schema_migrations'),process.env.CERTSIM_VALIDATION_MIGRATIONS||'97');
  const before=JSON.parse(await readFile(checkpoint,'utf8')),ids=before.map(a=>a.id);eq(snapshot(ids),before);
  eq(fixtureDdlProbe(ids[0]),{ok:false,sqlstate:'55006'});
  eq(fixtureDdlProbe(ids[0],true),{ok:true,sqlstate:null});
  console.log(JSON.stringify({suite:'variable-new97-fixture-ddl',undrainedSqlstate:'55006',drained:'pass',syntheticOnly:true}));
  for(const old of before) {
    const resumed=await admin.rpc('certsim_protected_resume_attempt',{p_actor_id:old.owner,p_attempt_id:old.id});
    eq(resumed.error,null);eq(resumed.data.ok,true);eq(resumed.data.attempt.attemptId,old.id);
    eq(resumed.data.items.map(i=>i.itemId),old.items);eq(Date.parse(resumed.data.attempt.expiresAt),Date.parse(old.deadline));
    eq(resumed.data.attempt.countContract,undefined);
  }
  eq(snapshot(ids),before);
  console.log(JSON.stringify({suite:'variable-upgrade96-fixed-resume',targetMigrations:Number(process.env.CERTSIM_VALIDATION_MIGRATIONS||97),assertions,fixedAttemptsPreserved:before.length,syntheticOnly:true}));
}
