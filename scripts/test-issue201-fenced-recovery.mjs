import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { verifySignedExecutionEnvelope } from '../services/python-executor/src/contract.mjs';
import { createSignedGradingEvidenceEnvelope, createExecutionResultDigest } from '../services/python-grading/src/contract.mjs';
import { createTrustedGradingMaterialDigest } from '../services/python-grading/src/trusted-grading-contract.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

// This driver is intentionally incapable of contacting a remote DB/provider.
const db = process.env.SUPABASE_DB_URL;
const api = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anon = process.env.SUPABASE_ANON_KEY;
for (const url of [db, api]) {
  if (!url || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) {
    throw Error('DISPOSABLE_LOOPBACK_REQUIRED');
  }
}
if (!key || !anon) throw Error('DISPOSABLE_KEYS_REQUIRED');
const psql = process.env.PSQL_PATH || 'psql';
let assertions = 0, processes = 0;
function eq(actual, expected, label) {
  // Assertion failures never print grading inputs, identities or credentials.
  try { assert.deepEqual(actual, expected); } catch { throw Error('ASSERTION_FAILED: ' + label); }
  assertions++;
}
function execute(input) {
  return spawnSync(psql, [db, '-XqAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=terse'], {
    input, encoding: 'utf8', windowsHide: true,
  });
}
function sql(input) {
  const r = execute(input);
  if (r.status) throw Error('SYNTHETIC_SQL_FAILED_' + r.stderr.replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi, '<opaque>'));
  return r.stdout.trim();
}
const json = input => JSON.parse(sql(input).split(/\r?\n/).at(-1));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Core parity is checked on effective database definitions, not on a copy of
// the scoring algorithm in this test. Only documented authority inputs differ.
const quoted = value => "'" + JSON.stringify(value).replaceAll("'", "''") + "'::jsonb";
async function rpc(name, args, credential = key) {
  const response = await fetch(`${api}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: { apikey: credential === key ? key : anon, Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!response.ok) return { denied: response.status };
  return response.json();
}
const pkg = randomUUID(), profile = randomUUID(), canonical = randomUUID(), form = randomUUID(), organisation = randomUUID();
const workspace = { entryPoint: 'main.py', files: [{ path: 'main.py', content: 'def sample():\n    pass\n' }] };
const canonicalJson = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonicalJson).join(',')}]`
    : `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
const materialFor = taskId => ({contractVersion: 'certsim-python-trusted-grading-v1',taskId,maximumRawPoints:5,rules:[{id:'synthetic.rule',type:'function_call',points:5,compiled:{contractVersion:'certsim-python-trusted-grading-v1',family:'function_call',target:'sample',arguments:[],keywordArguments:{},repeat:1,expectedObservation:{status:'completed',result:{type:'none'},argumentsAfter:[],stdout:'',stderr:'',files:[],cwdUnchanged:true,argvRestored:true,handlesReleased:true}}}]});
const owner = () => {
  const id = randomUUID();
  sql(`insert into auth.users(id,email,raw_user_meta_data) values('${id}','${id}@example.invalid','{}');
    update public.profiles set status='active',default_role='platform_owner',user_type='platform' where id='${id}';
    insert into public.memberships(user_id,organisation_id,role,status) values('${id}','${organisation}','platform_owner','active');`);
  return id;
};
sql(`insert into public.organisations(id,name,organisation_type,status) values('${organisation}','Synthetic expiry authority','internal','active');
  insert into exam_delivery.package_versions(id,exam_key,package_version,source_commit_sha,validation_hash,package_hash,
    package_schema_version,generator_version,scorer_version,status,declared_review_release_policy,declared_answer_release_policy)
  values('${pkg}','issue201pythonexpiry','1.0.0',repeat('a',40),repeat('b',64),repeat('c',64),
    'certsim-protected-package-v2','certsim-python-next-generation-canonical-forms-v1','certsim-python-trusted-grading-v1','draft','after_submission','after_submission');
  insert into exam_delivery.package_profiles(id,package_version_id,profile_key,display_name,question_count,time_limit_minutes,selection_config)
  values('${profile}','${pkg}','lab','Synthetic seven task Lab',9,1,'{}'),
    ('${canonical}','${pkg}','canonical','Synthetic canonical Lab',9,1,'{}');`);
for (let n = 1; n <= 7; n++) {
  const id = randomUUID(), material = materialFor(`synthetic-${n}`);
  const digest = createHash('sha256').update(canonicalJson(material)).digest('hex');
  sql(`insert into exam_delivery.package_questions(id,package_version_id,question_id,question_type,domain_key,section_key,source_ordinal,presentation_payload,content_hash)
    values('${id}','${pkg}','synthetic-${n}','executable-python-lab-v1','d1','python',${n},'{"interactionVersion":"executable-python-lab-v1"}',repeat('d',64));
    insert into exam_delivery.package_question_protected_content(question_id,package_version_id,scoring_payload,review_payload,authoring_metadata)
    values('${id}','${pkg}',${quoted({ maximumRawPoints: 5, trustedGrading: { status: 'compiled', materialDigest: digest, gradingMaterial: material } })},
      '{"explanation":"SENSITIVE_SENTINEL","remediation":"SENSITIVE_SENTINEL"}','{"scored":true}');`);
}
for(let n=8;n<=9;n++) {
 const id=randomUUID();
 sql(`insert into exam_delivery.package_questions(id,package_version_id,question_id,question_type,domain_key,section_key,source_ordinal,presentation_payload,content_hash)
 values('${id}','${pkg}','ordinary-${n}','multi-select','d1','ordinary',${n},'{"options":[{"id":"a","text":"Synthetic"},{"id":"b","text":"Synthetic"}],"requiredSelections":1}',repeat('d',64));
 insert into exam_delivery.package_question_protected_content(question_id,package_version_id,scoring_payload,review_payload,authoring_metadata)
 values('${id}','${pkg}','{"model":"per-correct-option-no-negative-v1","selectionCap":1,"correctAnswers":["a"],"maximumRawPoints":1}','{"explanation":"Synthetic ordinary review"}','{"scored":true}');`);
}
const administrator = owner();
sql(`insert into exam_delivery.package_forms(id,package_version_id,package_profile_id,form_key,form_ordinal,question_count,membership_hash,blueprint_contract)
  values('${form}','${pkg}','${canonical}','a',1,9,repeat('e',64),'{}');
  insert into exam_delivery.package_form_questions(form_id,package_profile_id,package_version_id,package_question_id,presentation_ordinal)
    select '${form}','${canonical}','${pkg}',id,source_ordinal from exam_delivery.package_questions where package_version_id='${pkg}';
  update exam_delivery.package_versions set status='published',published_at=clock_timestamp() where id='${pkg}';
  insert into public.exam_catalog(exam_key,slug,title,lifecycle,exam_type,current_version,status)
    values('issue201pythonexpiry','python-expiry-fixture','Synthetic Lab','production_ready','certification','1.0.0','active');
  insert into exam_delivery.exam_access_policies(canonical_exam_key,access_mode,enabled,enabled_at)
    values('issue201pythonexpiry','open_authenticated',true,now());
  insert into exam_delivery.exam_profile_activations(package_version_id,package_profile_id,enabled,activation_kind,enabled_at,created_by)
    values('${pkg}','${profile}',true,'production',now(),'${administrator}'),('${pkg}','${canonical}',true,'production',now(),'${administrator}');
  insert into exam_delivery.package_profile_defaults(canonical_exam_key,profile_key,purpose,package_version_id,package_profile_id,configured_by)
    values('issue201pythonexpiry','lab','assigned_assessment','${pkg}','${profile}','${administrator}'),
      ('issue201pythonexpiry','canonical','assigned_assessment','${pkg}','${canonical}','${administrator}'),
      ('issue201pythonexpiry','lab','self_directed_exam','${pkg}','${profile}','${administrator}');
  insert into exam_delivery.practice_policies(canonical_exam_key,package_version,profile_key,purpose,access_mode,enabled,
    maximum_session_items,immediate_feedback,review_release_policy,answer_release_policy)
    values('issue201pythonexpiry','1.0.0','lab','self_directed_exam','open_authenticated',true,10,false,'after_submission','after_submission');
  -- Compress only new synthetic deadlines; never alter a historical attempt.
  create function public.issue201_python_fixture_clock() returns trigger language plpgsql as $$begin
    if new.package_version_id='${pkg}'::uuid then new.expires_at=clock_timestamp()+interval '8 seconds';end if;return new;end$$;
  create trigger issue201_python_fixture_clock before insert on exam_delivery.attempts
    for each row execute function public.issue201_python_fixture_clock();`);
function start({ canon = false, self = false } = {}) {
  const actor = owner(), request = randomUUID();
  const result = self
    ? json(`set role service_role;select public.certsim_protected_start_practice('${actor}',${quoted({ examKey: 'issue201pythonexpiry', profileId: 'lab', purpose: 'self_directed_exam', count: 7, language: 'not_applicable', includePbqs: true, mixStrategy: 'balanced', clientRequestId: request })})`)
    : json(`set role service_role;select public.certsim_protected_start_attempt('${actor}','issue201pythonexpiry','${canon ? 'canonical' : 'lab'}','${request}')`);
  eq(result.ok, true, 'normal supported start');
  const id = result.attempt.attemptId;
  const items = json(`select jsonb_agg(id order by presented_question_number) from exam_delivery.attempt_items where attempt_id='${id}'`);
  eq(items.length, 9, 'seven executable plus two ordinary items');
  const executable=json(`select jsonb_agg(i.id order by presented_question_number) from exam_delivery.attempt_items i join exam_delivery.package_questions q on q.id=i.package_question_id where i.attempt_id='${id}' and q.question_type='executable-python-lab-v1'`);
  return { id, actor, items: executable };
}
const save = (a, item, revision = 0, source = workspace) => json(`set role service_role;select public.certsim_protected_save_python_workspace('${a.actor}','${a.id}','${item}',${quoted(source)},${revision},'${randomUUID()}')`);
async function due(a) {
  const remaining = Number(sql(`select greatest(0,extract(epoch from expires_at-clock_timestamp())) from exam_delivery.attempts where id='${a.id}'`));
  await sleep(Math.ceil(remaining * 1000) + 50);
}


import {signFenceAuthority} from '../supabase/functions/_shared/python-fence-auth.mjs';
import {pythonGradingContract} from '../supabase/functions/certsim-protected-exam/python-grading.ts';
import {pythonExecutionContract} from '../supabase/functions/certsim-protected-exam/python-execution.ts';
const executionSecret='synthetic-legacy-execution-key-0000000000000000',gradingSecret='synthetic-grading-key-11111111111111111111111',fenceSecret='synthetic-expiry-v1-key-222222222222222222222222';
const children=new Set(),payloads=[],recoveryPayloads=[],rpcErrors=[];
let bridge,processCount=0,createCount=0,execCount=0,sequence=0,mode='',faultCreateAt=0,barrierResolve,barrierArrived,arrive;
const sandboxes=new Map();
function arm(name){mode=name;faultCreateAt=createCount+(name.includes('probe')?2:1);barrierArrived=new Promise(r=>arrive=r);}
function release(){barrierResolve?.();barrierResolve=undefined;}
const bounded=(promise,label)=>Promise.race([promise,sleep(15000).then(()=>{throw Error('SYNTHETIC_BARRIER_TIMEOUT '+label);})]);
const observation={status:'completed',result:{type:'none'},argumentsAfter:[],stdout:'',stderr:'',files:[],cwdUnchanged:true,argvRestored:true,handlesReleased:true};
const launcher={namespaceSetup:true,workspaceBytes:16777216,workspaceFlags:['nodev','noexec','nosuid'],learner:{uid:65534,euid:65534,gid:65534,egid:65534,groups:[],pid:1,effectiveCapabilities:0,noNewPrivileges:1,seccompMode:2,nproc:[1,1],cpuSeconds:[4,4],fileSizeBytes:[16777216,16777216],environmentNames:[]}};
const substrate=http.createServer(async(req,res)=>{
 try{
  const chunks=[];for await(const c of req)chunks.push(c);const b=JSON.parse(Buffer.concat(chunks));
  const send=v=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(v));};
  const notFound=()=>{res.statusCode=404;send({name:'NotFoundError'});};
  if(req.url==='/barrier'){arrive?.();await new Promise(r=>barrierResolve=r);send({ok:true});return;}
  if(req.url==='/create'){
   createCount++;
   eq(b.params.env,{},'no secrets in sandbox env');eq(b.params.secrets,[],'no sandbox secrets');eq(b.params.blockNetwork,true,'network isolation unchanged');
   if(mode==='pause_create'||mode==='pause_probe_create'&&createCount===faultCreateAt){arrive?.();await new Promise(r=>barrierResolve=r);}
   if([...sandboxes.values()].some(s=>s.active&&s.name===b.params.name)){res.statusCode=409;send({name:'AlreadyExistsError'});return;}
   const id='sb-synthetic'+(++sequence);sandboxes.set(id,{active:true,name:b.params.name,workspace:null});
   if(mode==='lost_create'||mode==='lost_probe_create'&&createCount===faultCreateAt){arrive?.();req.socket.destroy();return;}
   send({id});return;
  }
  const s=sandboxes.get(b.id);if(!s){notFound();return;}
  if(mode==='notfound_provider'&&['/terminate','/poll'].includes(req.url)){notFound();return;}
  if(req.url==='/terminate'){
   if(mode==='pending_termination'){send({});return;}
   if(mode==='unknown_provider'){res.statusCode=503;send({name:'Error'});return;}
   s.active=false;send({exitCode:0});return;
  }
  if(req.url==='/poll'){if(mode==='unknown_provider'){res.statusCode=503;send({name:'Error'});return;}send({exitCode:s.active?null:0});return;}
  if(req.url==='/exec'){
   if(!s.active){notFound();return;}
   execCount++;eq(b.options.env,{},'exec no authority env');eq(b.options.secrets,[],'exec no secrets');
   s.stdinReady=new Promise(r=>s.stdinDone=r);send({ok:true});return;
  }
  if(req.url==='/stdin'){s.workspace=b.workspace;s.stdinDone?.();send({ok:true});return;}
  if(req.url==='/output'){
   await s.stdinReady;
   send({stdout:s.workspace.entryPoint.startsWith('__certsim_')?'CERTSIM_TRUSTED_PROBE_RESULT='+JSON.stringify([observation])+'\n':'',
    stderr:'CERTSIM_MODAL_LAUNCHER='+JSON.stringify(launcher)+'\n'});return;
  }
  if(req.url==='/wait'){send({ok:true});return;}send({ok:true});
 }catch{res.statusCode=503;res.end('{}');}
});
substrate.listen(0,'127.0.0.1');await once(substrate,'listening');
const baseEnv=()=>({SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,
 SUPABASE_URL:api,SUPABASE_SERVICE_ROLE_KEY:key,CERTSIM_PYTHON_EXECUTION_ENABLED:'YES',CERTSIM_PYTHON_GRADING_ENABLED:'YES',
 CERTSIM_EXECUTION_SIGNING_SECRET:executionSecret,CERTSIM_GRADING_SIGNING_SECRET:gradingSecret,
 CERTSIM_EXPIRY_V1_SIGNING_SECRET:fenceSecret,CERTSIM_PYTHON_FENCE_PROTOCOL:'certsim.python-expiry.fence.v1',
 CERTSIM_PYTHON_EXPIRY_WORKER_ENABLED:'true',CERTSIM_PYTHON_EXPIRY_FENCING_ENABLED:'true',CERTSIM_PYTHON_EXPIRY_RECOVERY_ENABLED:'true',
 CERTSIM_MODAL_PROXY_KEY:'synthetic-proxy',CERTSIM_MODAL_PROXY_SECRET:'synthetic-proxy-secret',
 CERTSIM_FENCE_STORE_URL:api,CERTSIM_FENCE_STORE_SERVICE_KEY:key,SYNTHETIC_MODAL_URL:'http://127.0.0.1:'+substrate.address().port});
async function child(kind,fault='',overrides={}){
 const env={...baseEnv(),SYNTHETIC_MODE:kind,SYNTHETIC_FAULT:fault,...(bridge?{CERTSIM_MODAL_BRIDGE_URL:bridge.url}:{}),...overrides};
 const p=spawn(process.execPath,['--experimental-transform-types','scripts/issue201-fenced-runtime.mjs'],{windowsHide:true,stdio:['ignore','pipe','pipe','ipc'],env});
 children.add(p);processCount++;p.stdout.resume();let errors='';p.stderr.on('data',b=>errors+=String(b));
 p.on('message',v=>{if(v.type==='grade_payload')payloads.push(v.payload);if(v.type==='recovery_payload')recoveryPayloads.push(v.payload);if(v.type==='rpc_error')rpcErrors.push(v.code);});
 const ready=await Promise.race([once(p,'message').then(async([v])=>v.type==='ready'?v:new Promise(r=>p.on('message',m=>{if(m.type==='ready')r(m);}))),once(p,'exit').then(()=>{throw Error('RUNTIME_FAILED '+errors.slice(-500));}),sleep(10000).then(()=>{throw Error('RUNTIME_TIMEOUT');})]);
 return {p,url:'http://127.0.0.1:'+ready.port};
}
async function stop(r){if(r&&r.p.exitCode===null&&r.p.signalCode===null){r.p.kill();await once(r.p,'exit');}if(r)children.delete(r.p);}
async function newBridge(fault=''){await stop(bridge);bridge=await child('bridge',fault);}
async function invoke(overrides={}){
 const r=await child('worker','',overrides);
 try{const response=await fetch(r.url,{method:'POST',headers:{apikey:key},signal:AbortSignal.timeout(155000)});return await response.json();}
 finally{await stop(r);}
}
const cursor=()=>sql("update exam_delivery.python_worker_control set cursor_deadline='-infinity',cursor_attempt='00000000-0000-0000-0000-000000000000',cycle_until=clock_timestamp()");
async function next(overrides={}){let r;for(let i=0;i<4;i++){r=await invoke(overrides);if(!['idle','disabled'].includes(r.state))return r;}return r;}
async function saved(){const a=start({canon:true});eq(save(a,a.items[0]).ok,true,'timely normal save');await due(a);cursor();return a;}
function expire(a){sql("update exam_delivery.python_worker_jobs set lease_until=clock_timestamp()-interval '1 second' where attempt_id='"+a.id+"'");}
const held=()=>sql('select coalesce(active_run::text,\'none\') from exam_delivery.python_worker_control');
const resultCount=a=>sql("select count(*) from exam_delivery.attempt_results where attempt_id='"+a.id+"'");
const resetRecovery=()=>sql("update exam_delivery.python_fences set recovery_until=null,next_after='-infinity' where run_id=(select active_run from exam_delivery.python_worker_control)");
function contain(a){
 // Explicit synthetic teardown only; never an operational recovery/reset API.
 sql("update exam_delivery.python_worker_jobs set blocked=true,block_reason='permanent',token=null,lease_until=null where attempt_id='"+a.id+"';update exam_delivery.python_worker_control set active_run=null");
 for(const s of sandboxes.values())s.active=false;release();mode='';
}
async function finish(a){for(let i=0;i<8&&resultCount(a)==='0';i++){cursor();await next();}eq(resultCount(a),'1','one normal result');}
async function recover(){resetRecovery();return next({CERTSIM_PYTHON_EXPIRY_WORKER_ENABLED:'false'});}
async function pendingWorker(){
 const w=await child('worker');const response=fetch(w.url,{method:'POST',headers:{apikey:key}}).then(r=>r.json()).catch(()=>null);return {w,response};
}
async function post(url,payload){const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});return {status:r.status,body:await r.json()};}

async function authorise(a,unfenced=false){
 cursor();const c=await rpc('certsim_service_python_worker_claim',{});
 eq(c.attemptId,a.id,'fixed synthetic authority claim');const own={p_attempt_id:a.id,p_token:c.token};
 const plan=await rpc('certsim_service_python_worker_plan',own);
 const item=await rpc('certsim_service_python_worker_read',{...own,p_item_id:plan.itemId,p_run_id:plan.runId});
 const bound=await pythonGradingContract.boundExecutionRequest(item);
 const started=await rpc(unfenced?'certsim_service_python_worker_start':'certsim_service_python_worker_fenced_start',{...own,p_item_id:plan.itemId,p_run_id:plan.runId,p_digest:bound.requestDigest});
 eq(started.claimed,true,'new generation materialized');
 if(unfenced)return {runId:plan.runId};
 const binding={bindingVersion:'certsim.python-grading.binding.v1',gradingSessionId:item.gradingSessionId,requestId:bound.request.requestId,requestDigest:bound.requestDigest,materializationId:item.materializationId,materialDigest:item.materialDigest,gradingContractVersion:item.gradingContractVersion,maximumRawPoints:item.maximumRawPoints};
 return {request:bound.request,envelope:await pythonExecutionContract.signRequest(bound.request,fenceSecret),binding,gradingMaterial:item.gradingMaterial,fence:started.fence,auth:await signFenceAuthority({fence:started.fence},'grade',fenceSecret)};
}

try{
 eq(sql('select enabled from exam_delivery.python_fence_control'),'f','fencing defaults disabled');
 await newBridge();
 eq((await invoke()).state,'disabled','all dispatch defaults disabled in SQL');
 sql('select exam_delivery.set_expiry_enrolment(true);select exam_delivery.set_python_expiry_capability(true);select exam_delivery.set_python_worker_dispatch(true);select exam_delivery.set_python_fencing(true)');
 for(const role of ['anon','authenticated','service_role'])for(const table of ['python_fences','python_fence_legs','python_fence_receipts','python_fence_events','python_fence_control'])
  eq(execute('set role '+role+';select * from exam_delivery.'+table).status!==0,true,'journal denied');
 for(const role of ['anon','authenticated'])for(const fn of ['public.certsim_service_python_fence_recovery()','public.certsim_service_python_fence_step(jsonb,text,uuid,text,text,jsonb)'])
  eq(sql("select has_function_privilege('"+role+"','"+fn+"','execute')"),'f','browser fence RPC denied');
 eq(sql("select has_function_privilege('service_role','exam_delivery.set_python_fencing(boolean)','execute')"),'f','service cannot activate');
 const unknownMode=process.argv[2];
 if(unknownMode){
  await newBridge();arm(unknownMode==='unknown-primary'?'lost_create':unknownMode==='unknown-probe'?'lost_probe_create':unknownMode==='unknown-pending'?'pending_termination':unknownMode==='unknown-notfound'?'notfound_provider':'unknown_provider');
  const unresolved=await saved();
  if(unknownMode==='legacy-held'){
   await authorise(unresolved,true);expire(unresolved);
   eq((await recover()).state,'legacy_recovery_blocked','legacy dispatch gains no retrospective fence');
  }else{
   eq((await next()).state,'recovery_blocked','uncertain external creation/disposal');
   eq((await recover()).state,'recovery_blocked','unknown external state retains admission');
  }
  eq(held()!=='none',true,'no force unlock or time-based containment');
  eq(resultCount(unresolved),'0','unknown state produces no result');
  console.log(JSON.stringify({suite:'fenced-'+unknownMode,assertions,processes:processCount,expectedBlocked:true,productionActions:0,realModalCalls:0}));
  // Harness resets the entire disposable DB; never clear this unresolved slot.
 }else{
 // Central: signed delayed grade has not acquired bridge admission.
 await newBridge('delay_admission');arm('admission');
 const a=await saved(),beforeCreates=createCount,beforeExec=execCount;
 const pending=await pendingWorker();await Promise.race([barrierArrived,sleep(15000).then(()=>{throw Error('ADMISSION_BARRIER_TIMEOUT');})]);
 const oldPayload=payloads.at(-1);await stop(pending.w);await pending.response;expire(a);
 await newBridge();eq((await recover()).state,'capacity_recovered','not-admitted dispatch safely closed');eq(held(),'none','global slot released');
 eq(createCount,beforeCreates,'delayed request created no sandbox');eq(execCount,beforeExec,'delayed request executed no code');eq(resultCount(a),'0','unresolved original not zero-completed');
 const second=await saved();eq((await next()).state,'progress','other attempt grades after containment');await finish(second);
 await newBridge();eq((await post(bridge.url+'/v2/expiry-grade',oldPayload)).status,409,'fresh process rejects closed old request');
 eq(resultCount(a),'0','old attempt remains unresolved');eq(sql("select count(*) from exam_delivery.python_fence_receipts where run_id='"+oldPayload.fence.dispatchId+"'"),'0','no old evidence appeared');
 console.log(JSON.stringify({suite:'fenced-central-delayed-request-other-attempt',oldCreateDelta:0,oldExecutionDelta:0,otherAttemptCompleted:true,driverEvidenceInserts:0,passed:true}));
 // Pause after durable intent; expiry/cancellation alone cannot release.
 for(const fault of ['pause_admitted','pause_intent','pause_created','pause_create','pause_probe_create']){
  await newBridge(fault);arm(fault);
  const x=await saved(),b=createCount,e=execCount,p=await pendingWorker();
  await Promise.race([barrierArrived,sleep(15000).then(()=>{throw Error('CREATOR_BARRIER_TIMEOUT '+fault);})]);expire(x);
  const recoveryBridge=await child('bridge');const prior=bridge;bridge=recoveryBridge;
  const r=await recover();
  eq(r.state,['pause_intent','pause_create','pause_probe_create'].includes(fault)?'recovery_blocked':'capacity_recovered','intent versus settled immutable-ID proof');
  if(['pause_intent','pause_create','pause_probe_create'].includes(fault))eq(held()!=='none',true,'outstanding creator retains admission');
  let reusedId;
  if(fault==='pause_created'){
   const oldId=sql("select l.sandbox_id from exam_delivery.python_fence_legs l join exam_delivery.python_worker_dispatches d using(run_id) where d.attempt_id='"+x.id+"' and l.leg='primary'");
   const reused=await post('http://127.0.0.1:'+substrate.address().port+'/create',{params:{env:{},secrets:[],blockNetwork:true,name:sandboxes.get(oldId).name}});
   reusedId=reused.body.id;eq(reusedId!==oldId,true,'provider name reused with a distinct immutable ID');
  }
  release();await p.response;await stop(p.w);await stop(prior);
  if(reusedId){eq(sandboxes.get(reusedId).active,true,'old ID cleanup never terminates reused name');sandboxes.get(reusedId).active=false;}
  if(held()!=='none')eq((await recover()).state,'capacity_recovered','resumed creator settles disposal');
  eq(execCount-e,fault==='pause_probe_create'?1:0,'revoked paused leg executes nothing');eq(resultCount(x),'0','capacity recovery invents no result');
  eq(createCount-b,fault==='pause_admitted'?0:['pause_probe_create','pause_created'].includes(fault)?2:1,'one creation per leg plus explicit reused-name fixture');contain(x);
 }
 // Receipt committed by actual bridge, caller response lost; restart replays.
 await newBridge('receipt_ack_lost');const receipt=await saved(),b=createCount;
 await next();eq(sql("select count(*) from exam_delivery.python_fence_receipts f join exam_delivery.python_worker_dispatches d on d.run_id=f.run_id where d.attempt_id='"+receipt.id+"'"),'1','signed receipt durable before acknowledgment');
 await newBridge();eq((await recover()).state,'capacity_recovered','committed receipt recovered');await finish(receipt);
 eq(createCount-b,2,'receipt replay performs no extra primary or probe');
 // Client disconnect after grading must not cancel the private durable hand-off.
 await newBridge('pause_receipt');arm('receipt');const disconnected=await saved(),disconnectCreates=createCount,dp=await pendingWorker();
 await Promise.race([barrierArrived,sleep(15000).then(()=>{throw Error('DISCONNECT_RECEIPT_BARRIER_TIMEOUT');})]);
 await stop(dp.w);await dp.response;expire(disconnected);release();
 let retained=false;
 for(let n=0;n<100&&!retained;n++){
  retained=sql("select count(*) from exam_delivery.python_fence_receipts f join exam_delivery.python_worker_dispatches d on d.run_id=f.run_id where d.attempt_id='"+disconnected.id+"'")==='1';
  if(!retained)await sleep(20);
 }
 eq(retained,true,'caller disconnect preserves the already verified signed receipt');
 await newBridge();eq((await recover()).state,'capacity_recovered','disconnected caller receipt recovered');await finish(disconnected);
 eq(createCount-disconnectCreates,2,'caller disconnect never causes primary/probe re-execution');
 // Terminal, exhausted and permanent owners release capacity independently.
 for(const status of ['abandoned','voided','exhausted','permanent']){
  await newBridge('delay_admission');arm('admission');const x=await saved(),p=await pendingWorker();
  await Promise.race([barrierArrived,sleep(15000).then(()=>{throw Error('OWNER_BARRIER_TIMEOUT');})]);await stop(p.w);await p.response;
  if(['abandoned','voided','completed'].includes(status))sql("update exam_delivery.attempts set status='"+status+"' where id='"+x.id+"'");
  if(status==='exhausted')sql("update exam_delivery.python_worker_jobs set failures=5,blocked=true,block_reason='permanent' where attempt_id='"+x.id+"'");
  if(status==='permanent')sql("update exam_delivery.python_worker_jobs set blocked=true,block_reason='permanent' where attempt_id='"+x.id+"'");
  expire(x);await newBridge();eq((await recover()).state,'capacity_recovered','terminal/blocked owner capacity recovered');
  eq(held(),'none','capacity released independently');eq(resultCount(x),'0','no fabricated terminal result');
  if(status==='exhausted')eq(sql("select failures from exam_delivery.python_worker_jobs where attempt_id='"+x.id+"'"),'5','failure counter never reset');
  contain(x);
 }
 // A real authoritative completion can race while the sealed dispatch still holds capacity.
 await newBridge('pause_seal');arm('seal');const completedOwner=await saved(),completedPending=await pendingWorker();
 await bounded(barrierArrived,mode);
 const completedToken=sql("select token from exam_delivery.python_worker_jobs where attempt_id='"+completedOwner.id+"'");
 eq((await rpc('certsim_service_python_worker_complete',{p_attempt_id:completedOwner.id,p_token:completedToken})).completed,true,'actual trusted completion before capacity release');
 const resultBefore=sql("select md5(to_jsonb(r)::text) from exam_delivery.attempt_results r where attempt_id='"+completedOwner.id+"'");
 expire(completedOwner);
 const completingBridge=bridge;bridge=await child('bridge');
 eq((await recover()).state,'capacity_recovered','completed owner retains its authentic result while capacity recovers');
 eq(sql("select md5(to_jsonb(r)::text) from exam_delivery.attempt_results r where attempt_id='"+completedOwner.id+"'"),resultBefore,'completed result never rewritten');
 release();await completedPending.response;await stop(completedPending.w);await stop(completingBridge);
 eq(resultCount(completedOwner),'1','completed owner remains completed once');

 // Duplicate across two real bridges, same SQL fence; route downgrade denied.
 await newBridge('pause_intent');arm('intent');const duplicate=await saved(),p=await pendingWorker();
 await bounded(barrierArrived,mode);const captured=payloads.at(-1),other=await child('bridge');
 eq((await post(other.url+'/v2/expiry-grade',captured)).status,409,'second bridge cannot acquire runner');
 const stripped={...captured};delete stripped.fence;delete stripped.auth;
 for(const route of ['/v1/grade','/v1/execute']){
  const legacy=route.endsWith('execute')?{request:captured.request,envelope:captured.envelope}:stripped;
  eq((await post(other.url+route,legacy)).status,401,'purpose/version key prevents route downgrade');
 }
 for(const mutate of [v=>v.fence.epoch='99999',v=>v.fence.protocol='old',v=>v.auth.signature='0'.repeat(64),v=>v.fence.requestDigest='f'.repeat(64),v=>v.fence.dispatchId=randomUUID()]){
  const v=structuredClone(captured);mutate(v);eq((await post(other.url+'/v2/expiry-grade',v)).status>=400,true,'forgery denied');
 }
 release();await p.response;await stop(p.w);await stop(other);await finish(duplicate);

 // Store outage and lost capacity-release acknowledgment, with exact old epoch.
 const outage=await saved(),outPayload=await authorise(outage);expire(outage);await newBridge('store_outage');
 eq((await recover()).state,'recovery_blocked','fence-store transport outage cannot release');
 eq(held(),outPayload.fence.dispatchId,'outage retains exact dispatch');
 await newBridge('release_ack_lost');eq((await recover()).state,'recovery_blocked','release acknowledgment deliberately lost');
 eq(held(),'none','release committed exactly once');const oldRecovery=recoveryPayloads.at(-1);await newBridge();
 eq((await invoke({CERTSIM_PYTHON_EXPIRY_WORKER_ENABLED:'false'})).state,'disabled','idempotent retry after lost release acknowledgment');
 const newer=await saved(),newPayload=await authorise(newer);
 await post(bridge.url+'/v2/expiry-recover',oldRecovery);
 eq(held(),newPayload.fence.dispatchId,'stale recovery cannot clear newer slot');expire(newer);
 eq((await recover()).state,'capacity_recovered','new exact dispatch closes independently');contain(outage);contain(newer);
 // Two simultaneous bridge processes contend on real SQL admission.
 const race=await saved(),racePayload=await authorise(race),r1=await child('bridge'),r2=await child('bridge'),beforeRace=createCount;
 const results=await Promise.all([post(r1.url+'/v2/expiry-grade',racePayload),post(r2.url+'/v2/expiry-grade',racePayload)]);
 eq(results.map(r=>r.status).sort(),[200,409],'two SQL sessions grant only one bridge runner');
 eq(createCount-beforeRace,2,'one primary and one probe across duplicate delivery');await stop(r1);await stop(r2);await finish(race);
 // Explicit real multi-session lock barrier; no row lock spans provider calls.
 const locked=await saved(),lockPayload=await authorise(locked);expire(locked);
 const locker=spawn(psql,[db,'-XqAt','-v','ON_ERROR_STOP=1'],{windowsHide:true,stdio:['pipe','pipe','pipe']});children.add(locker);locker.stderr.resume();
 const lockedReady=new Promise(resolve=>{let text='';locker.stdout.on('data',b=>{text+=b;if(text.includes('FENCE_ROW_LOCK_READY'))resolve();});});
 locker.stdin.write("begin;select id from exam_delivery.attempts where id='"+locked.id+"' for update;select 'FENCE_ROW_LOCK_READY';\n");await bounded(lockedReady,'sql_lock');
 const waiting=recover();let blocked=false;
 for(let n=0;n<50&&!blocked;n++){blocked=Number(sql("select count(*) from pg_stat_activity where wait_event_type='Lock' and query like '%certsim_service_python_fence_recovery%'"))>0;if(!blocked)await sleep(20);}
 eq(blocked,true,'real recovery SQL session waits for held attempt lock');
 locker.stdin.end('rollback;\n');await bounded(once(locker,'exit'),'sql_unlock');children.delete(locker);
 eq((await waiting).state,'capacity_recovered','recovery resumes after explicit lock release');contain(locked);
 // Authentic late success conflicts with a terminal cancellation: retain, never overwrite.
 await newBridge('pause_receipt');arm('receipt');const conflict=await saved(),cp=await pendingWorker();await bounded(barrierArrived,mode);
 const run=held(),fence=payloads.at(-1).fence;
 const cancellation={contractVersion:'certsim.python-execution.result.v1',executionId:'execution.'+fence.primaryId,status:'cancelled',outcome:'cancelled',stdout:'',stderr:'',exitCode:null,diagnostics:[]};
 // Separately labelled negative SQL fixture, not successful evidence insertion.
 const cancellationAck=await rpc('certsim_service_complete_python_execution',{p_run_id:run,p_execution_request_digest:fence.requestDigest,p_provider_execution_id:cancellation.executionId,p_execution_result_digest:createExecutionResultDigest(cancellation),p_state:'cancelled',p_terminal_outcome:'cancelled',p_stdout:'',p_stderr:'',p_exit_code:null,p_disposal_confirmed:true});
 eq(cancellationAck.ok,true,'negative SQL fixture establishes the terminal conflict before receipt hand-off');
 release();await cp.response;await stop(cp.w);await newBridge();
 eq((await recover()).state,'capacity_recovered','conflicting late receipt can recover capacity');
 eq(sql("select state from exam_delivery.python_execution_runs where id='"+run+"'"),'cancelled','terminal record never overwritten');
 eq(sql("select count(*) from exam_delivery.python_fence_receipts where run_id='"+run+"'"),'1','authentic conflicting receipt retained');
 eq(resultCount(conflict),'0','conflict never fabricates score');contain(conflict);

 // Enabled local Deno HTTP handler, actual production worker with same real bridge.
 await newBridge();const denoAttempt=await saved(),denoEnv={...baseEnv(),CERTSIM_MODAL_BRIDGE_URL:bridge.url,DENO_DIR:process.env.DENO_DIR||process.env.RUNNER_TEMP+'/deno-cache'};
 const deno=spawn(process.env.DENO_PATH||'deno',['run','--no-config','--no-check','--allow-env','--allow-net=127.0.0.1,localhost','scripts/issue201-fenced-deno.ts'],{windowsHide:true,env:denoEnv,stdio:['ignore','pipe','pipe']});children.add(deno);processCount++;deno.stderr.resume();
 const port=await bounded(new Promise((resolve,reject)=>{let text='';deno.stdout.on('data',c=>{text+=c;for(const line of text.split('\n'))try{const v=JSON.parse(line);if(v.type==='ready')resolve(v.port);}catch{}});deno.once('exit',()=>reject(Error('DENO_RUNTIME_FAILED')));}),'deno_ready');
 const dr=await fetch('http://127.0.0.1:'+port,{method:'POST',headers:{apikey:key}});eq((await dr.json()).state,'progress','enabled local Deno uses actual fenced bridge');await stop({p:deno});await finish(denoAttempt);
 console.log(JSON.stringify({suite:'fenced-recovery-http-postgrest-actual-bridge-provider',assertions,processes:processCount,simulatedSandboxCreates:createCount,simulatedExecs:execCount,driverSuccessfulEvidenceInserts:0,enabledLocalDeno:true,realModalCalls:0,productionActions:0,passed:true}));
 }
}finally{release();for(const p of children)p.kill();substrate.closeAllConnections();await new Promise(r=>substrate.close(r));}
