import assert from 'node:assert/strict';
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
let assertions = 0;
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
      relation: 'immediately_before_same_block', requiredConceptGroups: [['synthetic']] } }] });
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
  values('${profile}','${pkg}','lab','Synthetic seven task Lab',7,1,'{}'),
    ('${canonical}','${pkg}','canonical','Synthetic canonical Lab',7,1,'{}');`);
for (let n = 1; n <= 7; n++) {
  const id = randomUUID(), material = materialFor(`synthetic-${n}`);
  const digest = createHash('sha256').update(canonicalJson(material)).digest('hex');
  sql(`insert into exam_delivery.package_questions(id,package_version_id,question_id,question_type,domain_key,section_key,source_ordinal,presentation_payload,content_hash)
    values('${id}','${pkg}','synthetic-${n}','executable-python-lab-v1','d1','python',${n},'{"interactionVersion":"executable-python-lab-v1"}',repeat('d',64));
    insert into exam_delivery.package_question_protected_content(question_id,package_version_id,scoring_payload,review_payload,authoring_metadata)
    values('${id}','${pkg}',${quoted({ maximumRawPoints: 5, trustedGrading: { status: 'compiled', materialDigest: digest, gradingMaterial: material } })},
      '{"explanation":"SENSITIVE_SENTINEL","remediation":"SENSITIVE_SENTINEL"}','{"scored":true}');`);
}
const administrator = owner();
sql(`insert into exam_delivery.package_forms(id,package_version_id,package_profile_id,form_key,form_ordinal,question_count,membership_hash,blueprint_contract)
  values('${form}','${pkg}','${canonical}','a',1,7,repeat('e',64),'{}');
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
  eq(items.length, 7, 'genuine seven executable items');
  return { id, actor, items };
}
const save = (a, item, revision = 0) => json(`set role service_role;select public.certsim_protected_save_python_workspace('${a.actor}','${a.id}','${item}',${quoted(workspace)},${revision},'${randomUUID()}')`);
const claim = a => rpc('certsim_service_claim_python_expiry', { p_attempt_id: a.id });
const prepare = (a, token) => rpc('certsim_service_prepare_python_expiry', { p_attempt_id: a.id, p_token: token });
const complete = (a, token) => rpc('certsim_service_complete_python_expiry', { p_attempt_id: a.id, p_token: token });
function consume(a, token, mode) {
  const child = spawnSync(process.execPath, ['--experimental-transform-types', 'scripts/issue201-python-expiry-consumer.mjs'], {
    input: JSON.stringify({ attemptId: a.id, token, mode }), encoding: 'utf8', windowsHide: true,
    env: { SUPABASE_URL: api, SUPABASE_SERVICE_ROLE_KEY: key },
  });
  if (child.status !== 0) throw Error('ISOLATED_FROZEN_CONSUMER_FAILED');
  return JSON.parse(child.stdout.trim());
}
async function due(a) {
  const remaining = Number(sql(`select greatest(0,extract(epoch from expires_at-clock_timestamp())) from exam_delivery.attempts where id='${a.id}'`));
  await sleep(Math.ceil(remaining * 1000) + 50);
}
eq(sql('select enabled from exam_delivery.python_expiry_control'), 'f', 'independent default disabled');
sql('select exam_delivery.set_expiry_enrolment(true)');
const legacy = start();
eq(save(legacy, legacy.items[0]).ok, true, 'pre-capability attempt has saved work');
sql('select exam_delivery.set_expiry_worker(true)');
const workerOnly = start();
eq((await claim(workerOnly)).code, 'python_expiry_capability_missing', 'worker activation does not enable Python capability');
sql('select exam_delivery.set_expiry_worker(false)');
sql('select exam_delivery.set_python_expiry_capability(true)');
eq((await claim(legacy)).code, 'python_expiry_capability_missing', 'no historical enrolment');
const central = start({ canon: true });
eq(sql(`select pg_get_functiondef('exam_delivery.prepare_python_expiry_core(uuid,uuid,uuid)'::regprocedure)=
  replace(replace(replace(pg_get_functiondef('exam_delivery.prepare_python_submission_before_expiry_foundation(uuid,uuid,uuid)'::regprocedure),
  'exam_delivery.prepare_python_submission_before_expiry_foundation(', 'exam_delivery.prepare_python_expiry_core('),
  'exam_delivery.authorize_attempt_continuation(p_attempt_id, ''submit'')',
  'exam_delivery.authorize_python_expiry_core(p_attempt_id,p_actor_id,p_submission_id)'),
  'if not found or v_latest.state in (''completed'',''failed'',''cancelled'') then','if not found then')`), 't', 'effective preparation parity');
eq(sql(`select pg_get_functiondef('exam_delivery.score_python_expiry_core(uuid,uuid,uuid)'::regprocedure)=
  replace(replace(replace(replace(pg_get_functiondef('exam_delivery.submit_attempt_v2_with_trusted_grading(uuid,uuid,uuid)'::regprocedure),
  'exam_delivery.submit_attempt_v2_with_trusted_grading(', 'exam_delivery.score_python_expiry_core('),
  'exam_delivery.check_eligibility_v2(p_actor_id,v_attempt.exam_key,v_attempt.profile_key)->>''eligible''',
  'exam_delivery.authorize_python_expiry_core(p_attempt_id,p_actor_id,p_submission_id)->>''ok'''),
  'pp.selection_config','(select c.selection_config from exam_delivery.expiry_authority c where c.attempt_id=a.id) selection_config'),
  'v_now timestamptz:=statement_timestamp()','v_now timestamptz:=clock_timestamp()')`), 't', 'existing scorer/projection/redaction parity');
for (const item of central.items) eq(save(central, item).ok, true, 'pre-deadline save');
eq(save(central, central.items[0], 1).ok, true, 'latest eligible revision saved');
eq(json(`select jsonb_build_array(c.version,a.canonical_form_id is not null,a.canonical_form_cycle,
  e.identity=exam_delivery.expiry_identity(a)) from exam_delivery.attempts a
  join exam_delivery.expiry_authority e on e.attempt_id=a.id join exam_delivery.python_expiry_capabilities c on c.attempt_id=a.id
  where a.id='${central.id}'`), [1, true, 1, true], 'canonical immutable capability');
eq((await prepare(central, randomUUID())).code, 'not_due', 'premature denied');
await due(central); // No learner Submit or browser expiry callback.
const lease = await claim(central);
eq(lease.ok, true, 'trusted fixed claim');
const frozen = await prepare(central, lease.leaseToken);
if (process.env.ISSUE201_FROZEN_REPRO_ONLY === 'true') {
  eq(consume(central, lease.leaseToken, 'reproduce').gapConfirmed, true, 'independent consumer reproduces missing-input dependency');
  console.log('FROZEN_INPUT_FAILING_BEFORE=CONFIRMED; BUILDER=MISSING_WORKSPACE; MATERIALIZE=DIGEST_REQUIRED; PROVIDER_CALLS=0');
  process.exit(0);
}
eq(frozen.ok, true, 'post-deadline no-Submit preparation');
eq(frozen.items.length, 7, 'complete frozen inventory');
eq(frozen.items.every(i => i.workspaceRevision === (i.itemId === central.items[0] ? 2 : 1) && i.state === 'authorized'), true, 'all latest saved revisions frozen');
eq(frozen.reason, 'time_limit_expiry', 'expiry reason');
eq((await rpc('certsim_service_materialize_python_expiry', { p_attempt_id: central.id, p_token: lease.leaseToken,
  p_item_id: frozen.items[0].itemId, p_run_id: frozen.items[1].runId,
  p_execution_request_digest: '6'.repeat(64) })).code, 'grading_binding_mismatch', 'wrong item/revision run rejected');
eq((await rpc('certsim_service_prepare_python_expiry', { p_attempt_id: central.id, p_token: lease.leaseToken,
  p_submission_id: randomUUID() })).denied >= 400, true, 'caller submission identity not accepted');
eq((await complete(central, lease.leaseToken)).code, 'grading_incomplete', 'missing evidence cannot complete');
eq(await prepare(central, lease.leaseToken), frozen, 'lost-response replay same identity');
eq((await prepare(central, randomUUID())).code, 'stale_lease', 'stale token fenced');
eq(save(central, central.items[0], 1).code, 'invalid_lifecycle_transition', 'late learner save denied');
eq(json(`set role service_role;select public.certsim_protected_submit_attempt('${central.actor}','${central.id}','${frozen.submissionId}')`).ok, false, 'expiry session does not authorize learner submit');
eq(json(`select exam_delivery.authorize_attempt_continuation('${central.id}','resume')`).ok, false, 'runner remains closed');
eq(json(`select exam_delivery.authorize_attempt_continuation('${central.id}','save_response')`).ok, false, 'learner Run authorization remains closed');

async function grade(a, token, task, earned = 4) {
  const requestDigest = '6'.repeat(64), resultDigest = '8'.repeat(64);
  const materialized = await rpc('certsim_service_materialize_python_expiry', {
    p_attempt_id: a.id, p_token: token, p_item_id: task.itemId, p_run_id: task.runId, p_execution_request_digest: requestDigest,
  });
  eq(materialized.ok, true, 'fixed trusted materialization');
  eq(materialized.workspace, workspace, 'materialization uses frozen persisted revision');
  eq(json(`set role service_role;select public.certsim_service_complete_python_execution('${task.runId}','${requestDigest}',
    'synthetic.${task.executionRequestId}','${resultDigest}','completed','completed','','',0,true)`).ok, true, 'synthetic terminal disposal');
  eq((await complete(a, token)).code, 'grading_incomplete', 'terminal without evidence remains incomplete');
  const evidence = (overrides = {}) => ({ id: randomUUID(), run: task.runId, materialization: task.materializationId,
    session: task.gradingSessionId, material: task.materialDigest, ...overrides });
  const persist = e => json(`set role service_role;select public.certsim_service_persist_verified_python_grading_evidence(
    '${e.id}','${e.run}','${e.materialization}','${e.session}','${requestDigest}','${resultDigest}',
    '${e.material}','${task.gradingContractVersion}',${earned},5,
    '[{"ruleId":"synthetic.rule","earnedRawPoints":${earned},"maximumRawPoints":5}]')`);
  eq(persist(evidence({ material: 'f'.repeat(64) })).ok, false, 'wrong material evidence rejected');
  eq(persist(evidence({ materialization: randomUUID() })).ok, false, 'wrong materialization rejected');
  eq(persist(evidence({ session: randomUUID() })).ok, false, 'wrong submission grading identity rejected');
  const e = evidence();
  eq(persist(e).ok, true, 'synthetic evidence via established trusted fixture');
  eq(persist(e).replayed, true, 'evidence exact replay');
  eq(persist({ ...e, material: 'f'.repeat(64) }).ok, false, 'conflicting evidence rejected');
}
for (const task of frozen.items) await grade(central, lease.leaseToken, task);
eq(json(`set role service_role;select public.certsim_protected_submit_attempt('${central.actor}','${central.id}',
  '${frozen.submissionId}')`).code, 'invalid_lifecycle_transition', 'complete expiry evidence still grants no learner-submit bypass');
eq(sql(`select count(*) from exam_delivery.attempt_results where attempt_id='${central.id}'`), '0', 'learner bypass creates no result');
eq((await complete(central, lease.leaseToken)).completed, true, 'authoritative completion');
eq(json(`select jsonb_build_array(raw_score,max_score) from exam_delivery.attempt_results where attempt_id='${central.id}'`), [28, 35], 'existing scorer partial points');
for (let i = 0; i < 2; i++) {
  eq((await prepare(central, lease.leaseToken)).completed, true, 'completed preparation reconciliation');
  eq((await complete(central, lease.leaseToken)).completed, true, 'completed replay');
}
for (const table of ['exam_delivery.attempt_results', 'public.exam_results', 'public.exam_reports']) {
  eq(sql(`select count(*) from ${table} where attempt_id='${central.id}'`), '1', 'one result and compatibility/history projection');
}
const review = json(`set role service_role;select public.certsim_protected_get_review('${central.actor}','${central.id}')`);
eq(review.ok, true, 'review released under frozen authority');
eq(/SENSITIVE_SENTINEL|trustedGrading|materialDigest|runId|workspace|synthetic\.rule/.test(JSON.stringify(review)), false, 'protected review redaction');
eq(sql(`select (b.effective_at=a.expires_at and p.prepared_at>a.expires_at and r.completed_at>p.prepared_at)::text
  from exam_delivery.expiry_bindings b join exam_delivery.attempts a on a.id=b.attempt_id
  join exam_delivery.python_expiry_preparations p using(attempt_id) join exam_delivery.attempt_results r using(attempt_id)
  where b.attempt_id='${central.id}'`), 'true', 'effective cutoff distinct from physical timestamps');
console.log('PYTHON_EXPIRY_NO_SUBMIT_SEVEN_SAVED=PASS');

for (const count of [0, 2]) {
  const a = start({ self: true });
  for (const item of a.items.slice(0, count)) eq(save(a, item).ok, true, 'mixed saved work');
  await due(a);
  const c = await claim(a), p = await prepare(a, c.leaseToken);
  eq(p.items.filter(i => i.state === 'unanswered').length, 7 - count, 'untouched inventory explicit');
  eq(sql(`select count(*) from exam_delivery.python_submission_grading_runs where attempt_id='${a.id}'`), String(count), 'no jobs for unanswered items');
  for (const task of p.items.filter(i => i.state !== 'unanswered')) await grade(a, c.leaseToken, task);
  eq((await complete(a, c.leaseToken)).completed, true, 'mixed/untouched completion');
  eq(json(`select jsonb_build_array(raw_score,max_score,(result_summary->>'answeredCount')::integer)
    from exam_delivery.attempt_results where attempt_id='${a.id}'`), [count * 4, 35, count], 'full denominator and unanswered scoring');
}
console.log('PYTHON_EXPIRY_MIXED_UNTOUCHED=PASS');

const assignment = randomUUID(), assignedActor = owner();
sql(`insert into public.exam_assignments(id,organisation_id,student_user_id,exam_key,profile_id,title,assignment_type,status,
  available_from,due_at,assigned_by,contract_version,package_version_id,package_profile_id,maximum_attempts,
  review_release_policy,answer_release_policy,creation_request_id)
  values('${assignment}','${organisation}','${assignedActor}','issue201pythonexpiry','lab','Synthetic assignment','assessment','active',
    statement_timestamp()-interval '1 minute',statement_timestamp()+interval '1 day','${administrator}','live-v2',
    '${pkg}','${profile}',2,'never','never','${randomUUID()}');`);
const assignedStart = json(`set role service_role;select exam_delivery.start_assignment_attempt('${assignedActor}',
  'issue201pythonexpiry','lab','${randomUUID()}','${assignment}')`);
eq(assignedStart.ok, true, 'normal assignment entry point');
const assigned = { id: assignedStart.attempt.attemptId, actor: assignedActor };
await due(assigned);
const assignmentLease = await claim(assigned);
eq((await prepare(assigned, assignmentLease.leaseToken)).ok, true, 'assignment expiry preparation');
eq((await complete(assigned, assignmentLease.leaseToken)).completed, true, 'untouched assignment scoring');
eq(sql(`select source_assignment_id::text from exam_delivery.attempts where id='${assigned.id}'`), assignment, 'assignment attribution retained');
eq(sql(`select release_status from exam_delivery.review_snapshots where attempt_id='${assigned.id}'`), 'withheld', 'assignment never-review authority retained');
eq(sql(`select identity->>'assignment' from exam_delivery.expiry_authority where attempt_id='${assigned.id}'`), assignment, 'capability binds assignment authority');
eq(json(`set role service_role;select public.certsim_protected_get_review('${assignedActor}','${assigned.id}')`).ok, false, 'withheld review not released');
console.log('PYTHON_EXPIRY_ASSIGNMENT_ATTRIBUTION=PASS');

// A timely manual freeze wins, including already verified evidence. Its
// identity and original completion reason survive trusted expiry preparation.
const manual = start(), manualSubmission = randomUUID();
eq(save(manual, manual.items[0]).ok, true, 'manual fixture saved');
const manualPrepared = json(`set role service_role;select public.certsim_service_prepare_python_submission_grading(
  '${manual.actor}','${manual.id}','${manualSubmission}')`);
eq(manualPrepared.ok, true, 'timely manual preparation unchanged');
const manualTask = manualPrepared.items[0];
json(`set role service_role;select public.certsim_service_materialize_python_submission_grading('${manual.actor}',
  '${manual.id}','${manualSubmission}','${manualTask.itemId}','${manualTask.runId}','${'6'.repeat(64)}')`);
json(`set role service_role;select public.certsim_service_complete_python_execution('${manualTask.runId}','${'6'.repeat(64)}',
  'synthetic.${manualTask.executionRequestId}','${'8'.repeat(64)}','completed','completed','','',0,true)`);
json(`set role service_role;select public.certsim_service_persist_verified_python_grading_evidence('${randomUUID()}',
  '${manualTask.runId}','${manualTask.materializationId}','${manualTask.gradingSessionId}','${'6'.repeat(64)}',
  '${'8'.repeat(64)}','${manualTask.materialDigest}','${manualTask.gradingContractVersion}',4,5,
  '[{"ruleId":"synthetic.rule","earnedRawPoints":4,"maximumRawPoints":5}]')`);
await due(manual);
const manualLease = await claim(manual), manualFrozen = await prepare(manual, manualLease.leaseToken);
eq(manualFrozen.submissionId, manualSubmission, 'manual identity retained');
eq(manualFrozen.reason, 'manual', 'manual reason retained');
eq(manualFrozen.items.find(i => i.itemId === manualTask.itemId).runId, manualTask.runId, 'manual evidence run reused');
eq((await complete(manual, manualLease.leaseToken)).completed, true, 'manual evidence reused by existing scorer');
console.log('PYTHON_EXPIRY_MANUAL_REUSE=PASS');

const pending = start();
eq(save(pending, pending.items[0]).ok, true, 'pending fixture saved');
await due(pending);
const pendingLease = await claim(pending), pendingFrozen = await prepare(pending, pendingLease.leaseToken);
const pendingTask = pendingFrozen.items.find(i => i.state === 'authorized');
await rpc('certsim_service_materialize_python_expiry', { p_attempt_id: pending.id, p_token: pendingLease.leaseToken,
  p_item_id: pendingTask.itemId, p_run_id: pendingTask.runId, p_execution_request_digest: '6'.repeat(64) });
eq((await prepare(pending, pendingLease.leaseToken)).items.find(i => i.itemId === pendingTask.itemId).state, 'running', 'active generation preserved');
eq(sql(`select count(*) from exam_delivery.python_submission_grading_runs where attempt_id='${pending.id}'`), '1', 'replay never replaces active generation');
eq((await complete(pending, pendingLease.leaseToken)).code, 'grading_incomplete', 'pending execution cannot score');
json(`set role service_role;select public.certsim_service_complete_python_execution('${pendingTask.runId}','${'6'.repeat(64)}',
  'synthetic.${pendingTask.executionRequestId}','${'8'.repeat(64)}','failed','timeout','','',null,true)`);
await prepare(pending, pendingLease.leaseToken);
eq(sql(`select count(*) from exam_delivery.python_submission_grading_runs where attempt_id='${pending.id}'`), '1', 'terminal without evidence not automatically regenerated');
eq((await complete(pending, pendingLease.leaseToken)).code, 'grading_incomplete', 'transport failure cannot become zero');

for (const state of ['abandoned', 'voided']) {
  const a = start(); await due(a); const c = await claim(a);
  sql(`update exam_delivery.attempts set status='${state}' where id='${a.id}'`);
  eq((await prepare(a, c.leaseToken)).code, 'invalid_lifecycle_transition', 'deliberate terminal state before preparation');
  eq(sql(`select count(*) from exam_delivery.python_expiry_preparations where attempt_id='${a.id}'`), '0', 'terminal state creates no work');
  const b = start(); await due(b); const d = await claim(b); await prepare(b, d.leaseToken);
  sql(`update exam_delivery.attempts set status='${state}' where id='${b.id}'`);
  eq((await complete(b, d.leaseToken)).code, 'invalid_lifecycle_transition', 'terminal state before completion');
  eq(sql(`select count(*) from exam_delivery.attempt_results where attempt_id='${b.id}'`), '0', 'terminal state cannot create result');
}

// Two actual SQL sessions, with a ready marker after taking the attempt lock.
async function locked(a, body) {
  const child = spawn(psql, [db, '-XqAt', '-v', 'ON_ERROR_STOP=1'], { windowsHide: true });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  const ended = new Promise((resolve, reject) => { child.on('error', reject);
    child.on('close', code => code ? reject(Error('SYNTHETIC_LOCK_SESSION_FAILED')) : resolve()); });
  child.stdin.write(`begin;select id from exam_delivery.attempts where id='${a.id}' for update;select 'LOCK_READY';\n`);
  const until = Date.now() + 5000;
  while (!output.includes('LOCK_READY')) { if (Date.now() > until) { child.kill(); throw Error('LOCK_READY_TIMEOUT'); } await sleep(10); }
  try { await body(child); } finally { child.stdin.end('rollback;\n'); await ended; }
}
const racing = start(); await due(racing); const racingLease = await claim(racing);
const concurrent = await Promise.all([prepare(racing, racingLease.leaseToken), prepare(racing, racingLease.leaseToken)]);
eq(concurrent[0].submissionId, concurrent[1].submissionId, 'concurrent preparers converge');
const simultaneousCompletion = await Promise.all([complete(racing, racingLease.leaseToken), complete(racing, racingLease.leaseToken)]);
eq(simultaneousCompletion.every(r => r.completed), true, 'concurrent completion converges');
eq(sql(`select count(*) from public.exam_results where attempt_id='${racing.id}'`), '1', 'concurrent completion one history projection');
const rollback = start(); await due(rollback); const rollbackLease = await claim(rollback);
sql(`begin;select exam_delivery.prepare_python_expiry('${rollback.id}','${rollbackLease.leaseToken}');rollback;`);
eq(sql(`select count(*) from exam_delivery.python_submission_grading_sessions where attempt_id='${rollback.id}'`), '0', 'rollback has no session');
eq(sql(`select count(*) from exam_delivery.expiry_bindings where attempt_id='${rollback.id}'`), '0', 'rollback has no binding');
eq((await prepare(rollback, rollbackLease.leaseToken)).ok, true, 'retry after rollback succeeds');
sql(`create function public.issue201_python_result_fault() returns trigger language plpgsql as $$begin
  if new.attempt_id='${rollback.id}'::uuid then raise exception 'synthetic_projection_fault';end if;return new;end$$;
  create trigger issue201_python_result_fault before insert on public.exam_reports
    for each row execute function public.issue201_python_result_fault();`);
eq((await complete(rollback, rollbackLease.leaseToken)).denied >= 400, true, 'projection fault aborts completion');
for (const table of ['exam_delivery.attempt_results', 'exam_delivery.review_snapshots', 'public.exam_results']) {
  eq(sql(`select count(*) from ${table} where attempt_id='${rollback.id}'`), '0', 'atomic completion rollback');
}
eq(sql(`select status from exam_delivery.attempts where id='${rollback.id}'`), 'in_progress', 'rollback preserves lifecycle');
sql('drop trigger issue201_python_result_fault on public.exam_reports;drop function public.issue201_python_result_fault()');
eq((await complete(rollback, rollbackLease.leaseToken)).completed, true, 'same freeze completes after rollback');
const completionClock = start(); await due(completionClock); const clockLease = await claim(completionClock);
await prepare(completionClock, clockLease.leaseToken);
await locked(completionClock, async child => {
  const waiting = complete(completionClock, clockLease.leaseToken);
  const waitLimit = Date.now() + 5000;
  while (sql(`select exists(select 1 from pg_stat_activity where wait_event_type='Lock'
    and query like '%certsim_service_complete_python_expiry%')`) !== 't') {
    if (Date.now() > waitLimit) throw Error('COMPLETION_LOCK_WAIT_NOT_OBSERVED');
    await sleep(10);
  }
  const afterRequestStart = sql('select clock_timestamp()');
  child.stdin.write('commit;\n');
  eq((await waiting).completed, true, 'completion waits for attempt lock');
  eq(sql(`select (completed_at>'${afterRequestStart}'::timestamptz)::text from exam_delivery.attempt_results
    where attempt_id='${completionClock.id}'`), 'true', 'physical completion timestamp taken after attempt lock');
});
const lateSave = start();
await locked(lateSave, async child => {
  const waiting = fetch(`${api}/rest/v1/rpc/certsim_protected_save_python_workspace`, {
    method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_actor_id: lateSave.actor, p_attempt_id: lateSave.id, p_item_id: lateSave.items[0],
      p_workspace: workspace, p_expected_revision: 0, p_request_id: randomUUID() }),
  });
  await due(lateSave); child.stdin.write('commit;\n');
  eq((await (await waiting).json()).code, 'invalid_lifecycle_transition', 'save request begun timely but accepted late denied');
});
const acceptedSave = start();
// Save accepts inside transaction, retains the attempt lock across deadline.
const child = spawn(psql, [db, '-XqAt', '-v', 'ON_ERROR_STOP=1'], { windowsHide: true });
let acceptedOutput = '';
child.stdout.on('data', chunk => { acceptedOutput += chunk; });
const acceptedEnd = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => code ? reject(Error('SYNTHETIC_SAVE_SESSION_FAILED')) : resolve()); });
child.stdin.write(`begin;select public.certsim_protected_save_python_workspace('${acceptedSave.actor}','${acceptedSave.id}',
  '${acceptedSave.items[0]}',${quoted(workspace)},0,'${randomUUID()}');select 'SAVE_ACCEPTED';\n`);
while (!acceptedOutput.includes('SAVE_ACCEPTED')) { if (child.exitCode !== null) throw Error('SYNTHETIC_SAVE_FAILED'); await sleep(10); }
await due(acceptedSave);
const waitingClaim = claim(acceptedSave);
child.stdin.end('commit;\n'); await acceptedEnd;
const acceptedLease = await waitingClaim, acceptedFrozen = await prepare(acceptedSave, acceptedLease.leaseToken);
eq(acceptedFrozen.items.find(i => i.itemId === acceptedSave.items[0]).workspaceRevision, 1, 'accepted-before deadline committed-after included');

const manualRace = start(), raceSubmission = randomUUID();
eq(save(manualRace, manualRace.items[0]).ok, true, 'manual-race saved');
const manualChild = spawn(psql, [db, '-XqAt', '-v', 'ON_ERROR_STOP=1'], { windowsHide: true });
let manualOutput = '';
manualChild.stdout.on('data', chunk => { manualOutput += chunk; });
const manualEnd = new Promise((resolve, reject) => { manualChild.on('error', reject);
  manualChild.on('close', code => code ? reject(Error('SYNTHETIC_MANUAL_SESSION_FAILED')) : resolve()); });
manualChild.stdin.write(`begin;select public.certsim_service_prepare_python_submission_grading('${manualRace.actor}',
  '${manualRace.id}','${raceSubmission}');select 'MANUAL_FROZEN';\n`);
while (!manualOutput.includes('MANUAL_FROZEN')) { if (manualChild.exitCode !== null) throw Error('SYNTHETIC_MANUAL_FREEZE_FAILED'); await sleep(10); }
await due(manualRace);
const manualWaiting = claim(manualRace);
manualChild.stdin.end('commit;\n'); await manualEnd;
const raceLease = await manualWaiting, raceFrozen = await prepare(manualRace, raceLease.leaseToken);
eq(raceFrozen.submissionId, raceSubmission, 'manual freeze wins real two-session expiry race');
eq(raceFrozen.reason, 'manual', 'race preserves manual reason');

// Other test windows have elapsed more than the real 30-second lease. A new
// processing claim must keep the active/terminal execution identity intact.
const remainingLease = Number(sql(`select greatest(0,extract(epoch from lease_until-clock_timestamp())) from exam_delivery.expiry_processing where attempt_id='${pending.id}'`));
if (remainingLease > 0) await sleep(Math.ceil(remainingLease * 1000) + 50);
const reclaimed = await claim(pending);
eq(reclaimed.ok, true, 'real lease-expiry reclaim');
eq((await prepare(pending, pendingLease.leaseToken)).code, 'stale_lease', 'old worker fenced after reclaim');
eq((await prepare(pending, reclaimed.leaseToken)).items.find(i => i.itemId === pendingTask.itemId).runId,
  pendingTask.runId, 'lease reclaim preserves generation and frozen identity');
console.log('PYTHON_EXPIRY_CONCURRENCY_ROLLBACK=PASS');

sql('select exam_delivery.set_python_expiry_capability(false)');
const oldActor = owner();
const oldChild = spawn(psql, [db, '-XqAt', '-v', 'ON_ERROR_STOP=1'], { windowsHide: true });
let oldOutput = '';
oldChild.stdout.on('data', chunk => { oldOutput += chunk; });
const oldEnd = new Promise((resolve, reject) => { oldChild.on('error', reject);
  oldChild.on('close', code => code ? reject(Error('SYNTHETIC_CREATION_SESSION_FAILED')) : resolve()); });
oldChild.stdin.write(`begin;select public.certsim_protected_start_attempt('${oldActor}','issue201pythonexpiry',
  'canonical','${randomUUID()}');select 'CREATED_DISABLED';\n`);
while (!oldOutput.includes('CREATED_DISABLED')) { if (oldChild.exitCode !== null) throw Error('SYNTHETIC_CREATION_FAILED'); await sleep(10); }
sql('select exam_delivery.set_python_expiry_capability(true)');
oldChild.stdin.end('commit;\n'); await oldEnd;
eq(sql(`select count(*) from exam_delivery.python_expiry_capabilities c join exam_delivery.attempts a on a.id=c.attempt_id
  where a.owner_id='${oldActor}'`), '0', 'creation before activation cannot enrol by delayed commit');
eq((await claim(legacy)).code, 'python_expiry_capability_missing', 'saved historical attempt remains ineligible after deadline');
for (const statement of [
  `update exam_delivery.python_expiry_capabilities set version=version where attempt_id='${central.id}'`,
  `update exam_delivery.python_expiry_inventory set maximum_raw_points=maximum_raw_points where attempt_id='${central.id}'`,
  `delete from exam_delivery.python_expiry_preparations where attempt_id='${central.id}'`,
  `delete from exam_delivery.python_expiry_events where attempt_id='${central.id}'`,
]) eq(execute(statement).status !== 0, true, 'new authority/freeze/event records are immutable');
console.log('PYTHON_EXPIRY_FUTURE_ONLY_ACTIVATION=PASS');

// ACL proof in SQL and real PostgREST transport; owner-browser is authenticated,
// never service_role. No browser receives internal task/submission references.
for (const role of ['anon', 'authenticated', 'service_role']) {
  for (const table of ['python_expiry_control', 'python_expiry_capabilities', 'python_expiry_preparations', 'python_expiry_inventory']) {
    eq(sql(`select has_table_privilege('${role}','exam_delivery.${table}','select,insert,update,delete')`), 'f', 'private tables denied');
  }
  eq(sql(`select has_function_privilege('${role}','exam_delivery.set_python_expiry_capability(boolean)','execute')`), 'f', 'activation denied');
  eq(sql(`select has_function_privilege('${role}','exam_delivery.prepare_python_expiry_core(uuid,uuid,uuid)','execute')`), 'f', 'private core denied');
}
eq((await rpc('certsim_service_prepare_python_expiry', { p_attempt_id: central.id, p_token: randomUUID() }, anon)).denied >= 400, true, 'anonymous HTTP denied');
eq(json(`set role service_role;select public.certsim_protected_get_review('${administrator}','${central.id}')`).ok, false, 'cross-user review denied');
eq((await rpc('certsim_protected_save_python_workspace', { p_actor_id: administrator, p_attempt_id: central.id,
  p_item_id: central.items[0], p_workspace: workspace, p_expected_revision: 2, p_request_id: randomUUID() })).denied >= 400,
  true, 'cross-user save denied');
const authResponse = await fetch(`${api}/auth/v1/signup`, { method: 'POST', headers: { apikey: anon, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: `synthetic-${randomUUID()}@example.invalid`, password: 'Synthetic-fixture-only-201!' }) });
const auth = await authResponse.json();
if (!auth.access_token || !auth.user?.id) throw Error('SYNTHETIC_AUTH_REQUIRED');
for (const role of ['student', 'trainer', 'platform_owner']) {
  sql(`update public.profiles set status='active' where id='${auth.user.id}';
    delete from public.memberships where user_id='${auth.user.id}';
    insert into public.memberships(user_id,organisation_id,role,status) values('${auth.user.id}','${organisation}','${role}','active');`);
  eq((await rpc('certsim_service_prepare_python_expiry', { p_attempt_id: central.id, p_token: randomUUID() }, auth.access_token)).denied >= 400, true, 'learner/staff/owner browser HTTP denied');
}
sql('select exam_delivery.set_python_expiry_capability(false);select exam_delivery.set_expiry_enrolment(false)');
console.log(JSON.stringify({ suite: 'issue201-python-expiry-authority', assertions, syntheticOnly: true,
  providerCalls: 0, cryptographicVerifierTestedByFixture: false }));
