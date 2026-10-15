import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { verifySignedExecutionEnvelope } from '../services/python-executor/src/contract.mjs';
import { createSignedGradingEvidenceEnvelope, createExecutionResultDigest } from '../services/python-grading/src/contract.mjs';
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
const workspace = { entryPoint: 'main.py', files: [{ path: 'main.py', content: 'pass # synthetic' }] };
const canonicalJson = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonicalJson).join(',')}]`
    : `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
const materialFor = taskId => ({ contractVersion: 'certsim-python-trusted-grading-v1', taskId,
  maximumRawPoints: 5, rules: [{ id: 'synthetic.rule', type: 'TOKEN', points: 5,
    compiled: { contractVersion: 'certsim-python-trusted-grading-v1', family: 'token_comment',
      target: 'process_records', anchor: 'For', anchorOccurrence: 1,
      relation: 'immediately_before_same_block', requiredConceptGroups: [['synthetic'], ['boundary']] } }] });
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
 values('${id}','${pkg}','{"model":"per-correct-option-no-negative-v1","selectionCap":1,"correctAnswers":["a"],"maximumRawPoints":1}','{"explanation":"SENSITIVE_SENTINEL"}','{"scored":true}');`);
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
const claim = a => rpc('certsim_service_claim_python_expiry', { p_attempt_id: a.id });
const prepare = (a, token) => rpc('certsim_service_prepare_python_expiry', { p_attempt_id: a.id, p_token: token });
const complete = (a, token) => rpc('certsim_service_complete_python_expiry', { p_attempt_id: a.id, p_token: token });
async function due(a) {
  const remaining = Number(sql(`select greatest(0,extract(epoch from expires_at-clock_timestamp())) from exam_delivery.attempts where id='${a.id}'`));
  await sleep(Math.ceil(remaining * 1000) + 50);
}

// Test-only secrets never leave loopback; no production environment is read.
const executionSecret='synthetic-execution-secret-00000000000000000000';
const gradingSecret='synthetic-grading-secret-111111111111111111111';
let mode='valid', delay=0, gradeCalls=0, cancelCalls=0, active=0, peak=0, onGrade=async()=>{}, runtimeFault='';
const seenRequests=new Set(), children=new Set(), logs=[];
const bridge=http.createServer(async(req,res)=>{
 try {
  eq(req.headers['modal-key'],'synthetic-proxy','existing proxy authentication');
  const chunks=[];for await(const c of req) chunks.push(c);
  const body=JSON.parse(Buffer.concat(chunks));
  verifySignedExecutionEnvelope(body.request,body.envelope,executionSecret);
  const result={contractVersion:'certsim.python-execution.result.v1',
   executionId:'execution.'+body.request.requestId.slice(8),status:'finished',stdout:'',stderr:'',exitCode:0,outcome:'completed',diagnostics:[]};
  if(req.url==='/v1/cancel') {
   cancelCalls++;
   if(mode==='stalled_cleanup') {res.writeHead(503,{'content-type':'application/json'});res.end('{}');return;}
   res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,disposalConfirmed:true,
    result:{...result,status:'cancelled',outcome:'cancelled',exitCode:null}}));return;
  }
  eq(req.url,'/v1/grade','only existing grade/cancel protocol');
  eq(seenRequests.has(body.request.requestId),false,'no execution resend across process recreation');
  seenRequests.add(body.request.requestId);gradeCalls++;active++;peak=Math.max(peak,active);
  const thisMode=mode;await onGrade(body);await sleep(delay);
  if(thisMode==='lost_response') {active--;req.socket.destroy();return;}
  if(thisMode==='http_error'||thisMode==='stalled_cleanup') {active--;res.writeHead(503,{'content-type':'application/json'});res.end('{}');return;}
  if(thisMode==='malformed') {active--;res.setHeader('content-type','application/json');res.end('{');return;}
  const evidence={evidenceVersion:'certsim.python-grading.evidence.v1',evidenceId:body.binding.gradingSessionId,
   ...Object.fromEntries(Object.entries(body.binding).filter(([k])=>k!=='bindingVersion')),
   executionId:result.executionId,executionResultDigest:createExecutionResultDigest(result),earnedRawPoints:4,
   rules:[{ruleId:'synthetic.rule',earnedRawPoints:4,maximumRawPoints:5}]};
  if(thisMode==='wrong_digest') evidence.requestDigest='f'.repeat(64);
  if(thisMode==='wrong_material') evidence.materialDigest='f'.repeat(64);
  if(thisMode==='wrong_capacity') {evidence.maximumRawPoints=6;evidence.rules[0].maximumRawPoints=6;}
  const envelope=createSignedGradingEvidenceEnvelope(evidence,thisMode==='wrong_signature'?'wrong-secret-2222222222222222222222222222222':gradingSecret);
  active--;res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,disposalConfirmed:thisMode!=='missing_disposal',envelope,evidence,executionResult:result}));
 } catch {active=Math.max(0,active-1);res.writeHead(500,{'content-type':'application/json'});res.end('{}');}
});
bridge.listen(0,'127.0.0.1');await once(bridge,'listening');
async function runtime(enabled='true') {
 const child=spawn(process.execPath,['--experimental-transform-types','scripts/issue201-python-worker-runtime.mjs'],{
  windowsHide:true,stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,
   SYNTHETIC_WORKER_FAULT:runtimeFault,CERTSIM_PYTHON_EXPIRY_WORKER_ENABLED:enabled,CERTSIM_PYTHON_EXECUTION_ENABLED:'YES',CERTSIM_PYTHON_GRADING_ENABLED:'YES',
   CERTSIM_EXECUTION_SIGNING_SECRET:executionSecret,CERTSIM_GRADING_SIGNING_SECRET:gradingSecret,
   CERTSIM_MODAL_PROXY_KEY:'synthetic-proxy',CERTSIM_MODAL_PROXY_SECRET:'synthetic-proxy-secret',
   CERTSIM_MODAL_BRIDGE_URL:`http://127.0.0.1:${bridge.address().port}`}});
 processes++;children.add(child);child.stdout.on('data',b=>logs.push(String(b)));child.stderr.on('data',b=>logs.push(String(b)));
 const ready=await Promise.race([once(child,'message'),once(child,'exit').then(()=>{throw Error('WORKER_RUNTIME_START_FAILED');}),sleep(10000).then(()=>{throw Error('WORKER_RUNTIME_START_TIMEOUT');})]);
 return {child,url:`http://127.0.0.1:${ready[0].port}`};
}
async function stop(r) {if(r.child.exitCode===null){r.child.kill();await once(r.child,'exit');}children.delete(r.child);}
async function invoke({enabled='true',headers={apikey:key},suffix='',body,method='POST',keep=false}={}) {
 const r=await runtime(enabled);
 try {
  const response=await fetch(r.url+suffix,{method,headers,signal:AbortSignal.timeout(160000),...(body?{body}:{})});
  const value=await response.json();
  eq(/SENSITIVE_SENTINEL|synthetic\.rule|workspace|materialDigest/.test(JSON.stringify(value)),false,'safe HTTP summary');
  if(keep)return {r,response,value};
  return {status:response.status,...value};
 } finally {if(!keep)await stop(r);}
}
const resetCursor=()=>sql(`update exam_delivery.python_worker_control set cursor_deadline='-infinity',cursor_attempt='00000000-0000-0000-0000-000000000000'`);
async function next() {resetCursor();return invoke();}
async function saved(count=7,latestRevisions=false) {
 const a=start({canon:true});
 for(let n=0;n<count;n++){
  eq(save(a,a.items[n],0,{entryPoint:'main.py',files:[{path:'main.py',content:`pass # distinct synthetic task ${n}`}]}).ok,true,'timely distinct save');
  if(latestRevisions)eq(save(a,a.items[n],1,{entryPoint:'main.py',files:[{path:'main.py',content:`pass # latest synthetic task ${n}`}]}).ok,true,'latest distinct revision before expiry');
 }
 await due(a);return a;
}
const finished=a=>sql(`select count(*) from exam_delivery.attempt_results where attempt_id='${a.id}'`)==='1';
async function finish(a,max=20) {for(let n=0;n<max&&!finished(a);n++) await next();eq(finished(a),true,'bounded eventual completion');}
// Synthetic teardown between negative cases. This deliberately clears no
// real provider resource and is not an automatic recovery path in production.
function contain(a) {sql(`update exam_delivery.python_worker_jobs set blocked=true,block_reason='permanent',token=null,lease_until=null where attempt_id='${a.id}';update exam_delivery.python_worker_control set active_run=null where singleton;`);}
try {
 eq(sql('select enabled from exam_delivery.python_worker_control'),'f','DB dispatch defaults disabled');
 for(const enabled of ['false','invalid','']) eq((await invoke({enabled})).state,'disabled','runtime default disabled');
 eq((await invoke()).state,'disabled','independent DB gate');
 eq(sql('select count(*) from exam_delivery.python_worker_jobs'),'0','disabled invocation no attempts mutated');
 for(const credential of ['',anon,'browser-token'])eq((await invoke({headers:{apikey:credential}})).status,401,'nonservice HTTP denied');
 for(const request of [{suffix:'?attemptId='+randomUUID()},{body:'{"enabled":true}'},{body:'{"attemptId":"arbitrary"}'}])eq((await invoke(request)).status,400,'caller cannot select or activate');
 eq((await invoke({method:'GET'})).status,405,'fixed POST service operation');
 sql('select exam_delivery.set_expiry_enrolment(true);select exam_delivery.set_python_expiry_capability(true);select exam_delivery.set_python_worker_dispatch(true)');
 for(const role of ['anon','authenticated','service_role'])for(const table of ['python_worker_jobs','python_worker_control','python_worker_receipts','python_worker_dispatches','python_worker_replacements'])
  eq(execute(`set role ${role};select * from exam_delivery.${table}`).status!==0,true,'private table access denied');
 for(const role of ['anon','authenticated'])eq(sql(`select has_function_privilege('${role}','public.certsim_service_python_worker_claim()','execute')`),'f','browser RPC denied');
 eq(sql("select has_function_privilege('service_role','exam_delivery.set_python_worker_dispatch(boolean)','execute')"),'f','service cannot activate');
 const signup=await fetch(`${api}/auth/v1/signup`,{method:'POST',headers:{apikey:anon,'content-type':'application/json'},
  body:JSON.stringify({email:`${randomUUID()}@example.invalid`,password:'Disposable-only-password-201!'})});
 const browser=await signup.json();eq(typeof browser.access_token,'string','real disposable browser session');
 for(const role of ['student','trainer','platform_owner']) {
  sql(`update public.profiles set status='active' where id='${browser.user.id}';delete from public.memberships where user_id='${browser.user.id}';insert into public.memberships(user_id,organisation_id,role,status) values('${browser.user.id}','${organisation}','${role}','active')`);
  eq((await invoke({headers:{apikey:browser.access_token}})).status,401,'actual browser role denied by worker');
  eq((await rpc('certsim_service_python_worker_claim',{},browser.access_token)).denied>=400,true,'actual browser role denied fixed RPC');
 }

 const central=await saved(7,true);const before=gradeCalls;const outputs=[];
 for(let n=0;n<7;n++) {
  const r=await next();outputs.push(r.state);
  const diagnostic=r.actions===1?'':JSON.stringify(json(`select jsonb_build_object('status',a.status,'purpose',a.purpose,'capable',cap.attempt_id is not null,'due',a.expires_at<=clock_timestamp(),'identity',auth.identity=exam_delivery.expiry_identity(a),'continuation',auth.continuation=to_jsonb(cc),'foundationState',p.state,'jobFailures',j.failures,'jobBlocked',j.blocked,'jobLeaseLive',j.lease_until>clock_timestamp()) from exam_delivery.attempts a left join exam_delivery.python_expiry_capabilities cap on cap.attempt_id=a.id left join exam_delivery.expiry_authority auth on auth.attempt_id=a.id left join exam_delivery.attempt_continuation_contracts cc on cc.attempt_id=a.id left join exam_delivery.expiry_processing p on p.attempt_id=a.id left join exam_delivery.python_worker_jobs j on j.attempt_id=a.id where a.id='${central.id}'`));
  eq(r.actions,1,'one task action per fresh process state='+r.state+' '+diagnostic+' '+logs.filter(s=>s.includes('TEST_RPC_TRACE:')).slice(-3).join(''));
  eq(gradeCalls-before,n+1,'one new request per invocation state='+r.state);
  eq(r.state,'progress','valid signed evidence accepted '+logs.filter(s=>s.includes('TEST_RPC_TRACE:')).slice(-3).join(''));
 }
 eq(outputs.every(s=>s==='progress'),true,'all seven healthy yields');
 eq(json(`select jsonb_build_array(min(workspace_revision),max(workspace_revision),count(distinct workspace_hash)) from exam_delivery.python_expiry_inventory where attempt_id='${central.id}'`),[2,2,7],'latest seven distinct revisions frozen');
 eq(sql(`select failures from exam_delivery.python_worker_jobs where attempt_id='${central.id}'`),'0','healthy progress spends no failure budget');
 eq(sql(`select generation from exam_delivery.expiry_processing where attempt_id='${central.id}'`),'0','foundation five generation ceiling untouched');
 eq((await next()).state,'completed','evidenced attempt finalized separately');
 for(const table of ['exam_delivery.attempt_results','public.exam_results','public.exam_reports'])eq(sql(`select count(*) from ${table} where attempt_id='${central.id}'`),'1','one authoritative/history projection');
 eq(json(`select jsonb_build_array(raw_score,max_score) from exam_delivery.attempt_results where attempt_id='${central.id}'`),[28,37],'seven verified tasks plus two ordinary unanswered');
 await next();eq(gradeCalls-before,7,'completed replay no extra transport');
 const review=json(`set role service_role;select public.certsim_protected_get_review('${central.actor}','${central.id}')`);
 eq(/SENSITIVE_SENTINEL|synthetic\.rule|workspace|materialDigest/.test(JSON.stringify(review)),false,'learner review redacted');
 eq(sql(`select (b.effective_at=a.expires_at and r.completed_at>b.effective_at)::text from exam_delivery.attempts a join exam_delivery.expiry_bindings b on b.attempt_id=a.id join exam_delivery.attempt_results r on r.attempt_id=a.id where a.id='${central.id}'`),'true','effective deadline and physical completion distinguished');
 console.log(JSON.stringify({suite:'python-worker-seven-task-no-submit',assertions,workerProcesses:processes,gradeRequests:gradeCalls-before,signatureVerifiedByWorker:true,driverEvidenceInserts:0}));

 for(const count of [0,2]) {const a=await saved(count),b=gradeCalls;await finish(a);eq(gradeCalls-b,count,'untouched tasks do not execute');eq(sql(`select raw_score from exam_delivery.attempt_results where attempt_id='${a.id}'`),String(count*4),'mixed unanswered scoring');}
 const slow=await saved(1);delay=35000;onGrade=async()=>eq(execute(`begin;set local lock_timeout='1s';select id from exam_delivery.attempts where id='${slow.id}' for update;rollback;`).status,0,'no attempt lock spans provider HTTP');
 const realStart=Date.now();await next();delay=0;onGrade=async()=>{};
 eq(Date.now()-realStart>=35000,true,'real HTTP lasts longer than foundation lease');
 eq(sql(`select failures from exam_delivery.python_worker_jobs where attempt_id='${slow.id}'`),'0','heartbeats retain live owner beyond 30s');await finish(slow);
 console.log(JSON.stringify({suite:'python-worker-real-timing',durationAtLeastMs:35000,heartbeatMs:10000,passed:true}));

 for(const failure of ['wrong_signature','wrong_digest','wrong_material','wrong_capacity','missing_disposal']) {
  const a=await saved(1);mode=failure;eq((await next()).state,'blocked','invalid evidence remains blocked');mode='valid';
  eq(sql(`select count(*) from exam_delivery.python_grading_evidence e join exam_delivery.python_execution_runs x on x.id=e.run_id where x.attempt_id='${a.id}'`),'0','invalid evidence never persisted');
  eq(finished(a),false,'saved work not zero substituted');contain(a);
 }
 for(const failure of ['http_error','malformed']) {
  const a=await saved(1);mode=failure;const b=gradeCalls,c=cancelCalls;
  eq((await next()).state,'reconciled','settled rejected transport reconciles');
  eq(cancelCalls-c,2,'both primary and probe disposed');
  mode='valid';eq((await next()).state,'replacement_ready','separate replacement authorization invocation');
  eq(gradeCalls-b,1,'replacement not dispatched in reconciliation/authorization');
  await finish(a);eq(gradeCalls-b,2,'one durable replacement');
  eq(sql(`select count(*) from exam_delivery.python_worker_replacements r join exam_delivery.python_expiry_inventory i on i.attempt_item_id=r.attempt_item_id where i.attempt_id='${a.id}'`),'1','replacement recorded once');
 }
 const exhausted=await saved(1);mode='http_error';await next();await next();await next();
 eq((await next()).state,'recovery_blocked','second worker replacement refused');mode='valid';contain(exhausted);
 for(const failure of ['lost_response','stalled_cleanup']) {
  const a=await saved(1);mode=failure;const b=gradeCalls;eq((await next()).state,'recovery_blocked','unknown transport/cleanup stays blocked');mode='valid';
  await next();eq(gradeCalls-b,1,'ambiguous request never replaced');eq(finished(a),false,'ambiguous work stays pending');contain(a);
 }
 const late=await saved(1);onGrade=async()=>{sql(`update exam_delivery.python_worker_jobs set lease_until=clock_timestamp()-interval '1 second' where attempt_id='${late.id}'`);};
 eq((await next()).state,'ownership_lost','expired owner cannot yield/finalize');onGrade=async()=>{};
 eq(sql(`select count(*) from exam_delivery.python_worker_receipts s join exam_delivery.python_worker_dispatches d using(run_id) where d.attempt_id='${late.id}'`),'1','verified late receipt retained');
 const lateCalls=gradeCalls;await finish(late);eq(gradeCalls,lateCalls,'late receipt reused with fresh owner');

 // These controlled-clock database changes model interruption/reclaim only;
 // the separate 35s case above exercises real database/HTTP lease timing.
 for(const fault of ['receipt_ack_lost','complete_ack_lost']) {
  const a=await saved(fault==='receipt_ack_lost'?1:0),b=gradeCalls;
  runtimeFault=fault;await next();runtimeFault='';
  sql(`update exam_delivery.python_worker_jobs set next_after='-infinity' where attempt_id='${a.id}'`);
  await finish(a);eq(gradeCalls-b,fault==='receipt_ack_lost'?1:0,'committed evidence/result acknowledgement loss never regrades');
  eq(sql(`select count(*) from public.exam_results where attempt_id='${a.id}'`),'1','lost acknowledgement retains one history result');
 }
 const crashed=await saved(1);resetCursor();
 const crashClaim=await rpc('certsim_service_python_worker_claim',{}),crashOwner={p_attempt_id:crashed.id,p_token:crashClaim.token};
 eq(crashClaim.attemptId,crashed.id,'controlled crash claims only synthetic attempt');
 const crashPlan=await rpc('certsim_service_python_worker_plan',crashOwner);
 const crashInput=await rpc('certsim_service_read_python_expiry_task',{...crashOwner,p_item_id:crashPlan.itemId,p_run_id:crashPlan.runId});
 const {pythonGradingContract}=await import('../supabase/functions/certsim-protected-exam/python-grading.ts');
 const bound=await pythonGradingContract.boundExecutionRequest(crashInput);
 eq((await rpc('certsim_service_python_worker_start',{...crashOwner,p_item_id:crashPlan.itemId,p_run_id:crashPlan.runId,p_digest:bound.requestDigest})).claimed,true,'materialization durable before crash');
 sql(`update exam_delivery.python_worker_jobs set lease_until=clock_timestamp()-interval '1 second' where attempt_id='${crashed.id}'`);
 const crashCalls=gradeCalls;
 eq((await next()).state,'recovery_blocked','crash between materialization and transport cannot establish safe replacement');
 eq(gradeCalls,crashCalls,'restart never resends claimed false generation');
 eq((await rpc('certsim_service_python_worker_transport',{...crashOwner,p_run_id:crashPlan.runId,p_settled:false})).code,'stale_lease','old owner fenced before delayed transport');
 contain(crashed);

 const paused=await saved(1),pausedCalls=gradeCalls;runtimeFault='stale_before_dispatch';
 eq((await next()).state,'recovery_blocked','suspended owner checks elapsed lease immediately before transport');runtimeFault='';
 eq(gradeCalls,pausedCalls,'stale pretransport worker sends nothing');contain(paused);

 const killed=await saved(1),killedCalls=gradeCalls;let accepted;
 const acceptance=new Promise(resolve=>{accepted=resolve;});onGrade=async()=>accepted();delay=1000;resetCursor();
 const doomed=await runtime(),pending=fetch(doomed.url,{method:'POST',headers:{apikey:key}}).catch(()=>null);
 await Promise.race([acceptance,sleep(15000).then(()=>{throw Error('SYNTHETIC_ACCEPTANCE_TIMEOUT');})]);await stop(doomed);await pending;await sleep(1100);onGrade=async()=>{};delay=0;
 sql(`update exam_delivery.python_worker_jobs set lease_until=clock_timestamp()-interval '1 second' where attempt_id='${killed.id}'`);
 eq((await next()).state,'recovery_blocked','process death after acceptance retains uncertain dispatch');
 eq(gradeCalls-killedCalls,1,'process recreation cannot resend accepted request');contain(killed);

 const heartbeatLoss=await saved(1);runtimeFault='renew_fail';delay=35000;
 eq((await next()).state,'ownership_lost','real heartbeat failure fences old owner');runtimeFault='';delay=0;
 const heartbeatCalls=gradeCalls;await finish(heartbeatLoss);eq(gradeCalls,heartbeatCalls,'late evidence after failed heartbeat reused');

 const timedOut=await saved(1);delay=92000;const timeoutCalls=gradeCalls,timeoutStart=Date.now();
 eq((await next()).state,'recovery_blocked','90s grade abort is not proof of transport settlement');
 eq(Date.now()-timeoutStart>=90000,true,'real existing grade timeout ceiling exercised');
 await sleep(2500);delay=0;await next();eq(gradeCalls-timeoutCalls,1,'delayed old response cannot authorize replacement');contain(timedOut);
 console.log(JSON.stringify({suite:'python-worker-real-failure-timing',heartbeatFailureMs:35000,gradeTimeoutMs:90000,passed:true}));

 const failed=await saved(0);resetCursor();
 for(let n=0;n<5;n++) {
  resetCursor();const c=await rpc('certsim_service_python_worker_claim',{});eq(c.attemptId,failed.id,'finite recovery claim');
  eq((await rpc('certsim_service_python_worker_yield',{p_attempt_id:failed.id,p_token:c.token,p_outcome:'failure'})).ok,true,'genuine failure yielded');
  sql(`update exam_delivery.python_worker_jobs set next_after='-infinity' where attempt_id='${failed.id}'`);
 }
 eq(sql(`select failures from exam_delivery.python_worker_jobs where attempt_id='${failed.id}'`),'5','five failures durable, no reset');
 resetCursor();eq((await rpc('certsim_service_python_worker_claim',{})).outcome,'idle','exhausted job not reclaimed');contain(failed);
 for(const status of ['abandoned','voided']) {
  const a=await saved(1),b=gradeCalls;sql(`update exam_delivery.attempts set status='${status}' where id='${a.id}'`);
  await next();eq(gradeCalls,b,'terminal attempt excluded from discovery');eq(finished(a),false,'terminal attempt not revived');
 }

 // Manual evidence below is a separately labelled database fixture, never
 // used by the seven-task signature-verification acceptance above.
 const manual=start({canon:true}),manualSubmission=randomUUID();
 for(const item of manual.items.slice(0,2))eq(save(manual,item).ok,true,'manual timely save');
 const manualPrepared=json(`set role service_role;select public.certsim_service_prepare_python_submission_grading('${manual.actor}','${manual.id}','${manualSubmission}')`);
 eq(manualPrepared.ok,true,'timely manual freeze');
 const manualTask=manualPrepared.items[0];
 json(`set role service_role;select public.certsim_service_materialize_python_submission_grading('${manual.actor}','${manual.id}','${manualSubmission}','${manualTask.itemId}','${manualTask.runId}','${'6'.repeat(64)}')`);
 json(`set role service_role;select public.certsim_service_complete_python_execution('${manualTask.runId}','${'6'.repeat(64)}','synthetic.${manualTask.executionRequestId}','${'8'.repeat(64)}','completed','completed','','',0,true)`);
 json(`set role service_role;select public.certsim_service_persist_verified_python_grading_evidence('${randomUUID()}','${manualTask.runId}','${manualTask.materializationId}','${manualTask.gradingSessionId}','${'6'.repeat(64)}','${'8'.repeat(64)}','${manualTask.materialDigest}','${manualTask.gradingContractVersion}',4,5,'[{"ruleId":"synthetic.rule","earnedRawPoints":4,"maximumRawPoints":5}]')`);
 await due(manual);const manualCalls=gradeCalls,manualCancellations=cancelCalls;
 eq((await next()).state,'manual_pending','verified plus pending manual work deferred intact');
 eq(gradeCalls,manualCalls,'manual pending never taken over');eq(cancelCalls,manualCancellations,'deadline alone never cancels manual generation');
 eq(sql(`select (submission_id='${manualSubmission}'::uuid and reason='manual')::text from exam_delivery.expiry_bindings where attempt_id='${manual.id}'`),'true','manual identity and reason retained');contain(manual);

 const disabled=await saved(1);onGrade=async()=>sql('select exam_delivery.set_python_worker_dispatch(false)');
 await next();onGrade=async()=>{};const gatedCalls=gradeCalls;
 eq((await next()).state,'disabled','DB gate stops new work');eq(gradeCalls,gatedCalls,'disabled dispatch no new bridge call');
 sql('select exam_delivery.set_python_worker_dispatch(true)');await finish(disabled);

 const left=await saved(1),right=await saved(1);delay=1000;resetCursor();
 await Promise.all([invoke(),invoke()]);delay=0;await finish(left);await finish(right);eq(peak,1,'durable cross-attempt admission at most one active HTTP dispatch');
 const same=await saved(1),sameCalls=gradeCalls;delay=1000;resetCursor();await Promise.all([invoke(),invoke()]);delay=0;await finish(same);eq(gradeCalls-sameCalls,1,'same task competition sends once');
 const horizon=await saved(0);resetCursor();const h=await rpc('certsim_service_python_worker_claim',{}),hOwner={p_attempt_id:horizon.id,p_token:h.token};
 eq(h.attemptId,horizon.id,'horizon fixture ownership');
 sql(`update exam_delivery.python_worker_jobs set horizon=clock_timestamp()+interval '1 second' where attempt_id='${horizon.id}'`);
 eq((await rpc('certsim_service_python_worker_renew',hOwner)).ok,true,'renewal bounded by original horizon');
 eq(sql(`select (lease_until<=horizon)::text from exam_delivery.python_worker_jobs where attempt_id='${horizon.id}'`),'true','renewal never exceeds horizon');
 await sleep(1100);eq((await rpc('certsim_service_python_worker_renew',hOwner)).code,'stale_lease','renewal cannot resurrect expired owner');contain(horizon);
 // Keyset discovery crosses more than its 64-record bound without caller IDs.
 for(let n=0;n<70;n++) {
  const a=start({canon:true});sql(`insert into exam_delivery.python_worker_jobs(attempt_id,blocked,block_reason) values('${a.id}',true,'permanent')`);
 }
 const reachable=await saved(1);resetCursor();let discovered=false;
 for(let n=0;n<4&&!discovered;n++){await invoke();discovered=sql(`select count(*) from exam_delivery.python_grading_evidence e join exam_delivery.python_execution_runs x on x.id=e.run_id where x.attempt_id='${reachable.id}'`)==='1';}
 eq(discovered,true,'bounded keyset advances past exhausted/blocked records');await finish(reachable);
 eq(logs.some(line=>/SENSITIVE_SENTINEL|synthetic\.rule|synthetic-execution-secret|synthetic-grading-secret/.test(line)),false,'worker logs contain no sensitive sentinel');
 console.log(JSON.stringify({suite:'python-worker-http-postgrest-integration',assertions,workerProcesses:processes,gradeRequests:gradeCalls,cancellationRequests:cancelCalls,peakDispatches:peak,realProviderCalls:0,productionActions:0,syntheticOnly:true}));
} finally {
 for(const child of children){child.kill();}
 bridge.closeAllConnections();await new Promise(resolve=>bridge.close(resolve));
}
