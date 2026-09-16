import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const databaseUrl = required('SUPABASE_DB_URL');
const databaseHost = new URL(databaseUrl).hostname;
if (!['127.0.0.1', 'localhost', '[::1]'].includes(databaseHost)) {
  throw new Error('ISSUE86_DISPOSABLE_LOCAL_DATABASE_REQUIRED');
}
const psql = process.env.PSQL_PATH?.trim() || 'psql';
let assertions = 0;

const ids = {
  owner: '86000000-0000-4000-8000-000000000001',
  outsider: '86000000-0000-4000-8000-000000000002',
  organisation: '86000000-0000-4000-8000-000000000010',
  package: '86000000-0000-4000-8000-000000000020',
  profile: '86000000-0000-4000-8000-000000000021',
  executableQuestion: '86000000-0000-4000-8000-000000000022',
  ordinaryQuestion: '86000000-0000-4000-8000-000000000023',
  ownerAttempt: '86000000-0000-4000-8000-000000000030',
  ownerItem: '86000000-0000-4000-8000-000000000031',
  ownerOrdinaryItem: '86000000-0000-4000-8000-000000000032',
  outsiderAttempt: '86000000-0000-4000-8000-000000000040',
  outsiderItem: '86000000-0000-4000-8000-000000000041',
  abandonedAttempt: '86000000-0000-4000-8000-000000000050',
  abandonedItem: '86000000-0000-4000-8000-000000000051',
  saveOne: '86000000-0000-4000-8000-000000000060',
  staleSave: '86000000-0000-4000-8000-000000000061',
  saveTwo: '86000000-0000-4000-8000-000000000062',
  runRequest: '86000000-0000-4000-8000-000000000070',
  invalidRun: '86000000-0000-4000-8000-000000000071',
  invalidRunRequest: '86000000-0000-4000-8000-000000000072',
  run: '86000000-0000-4000-8000-000000000073',
  secondRun: '86000000-0000-4000-8000-000000000074',
  secondRunRequest: '86000000-0000-4000-8000-000000000075',
  cancel: '86000000-0000-4000-8000-000000000076',
  evidence: '86000000-0000-4000-8000-000000000080',
  materialization: '86000000-0000-4000-8000-000000000081',
  gradingSession: '86000000-0000-4000-8000-000000000082',
  liveClientRequest: '86000000-0000-4000-8000-000000000090',
  liveExecutionRequest: '86000000-0000-4000-8000-000000000091',
  replayExecutionRequest: '86000000-0000-4000-8000-000000000092',
  competingClientRequest: '86000000-0000-4000-8000-000000000093',
  competingExecutionRequest: '86000000-0000-4000-8000-000000000094',
  ordinaryResponse: '86000000-0000-4000-8000-000000000095',
  ordinaryResponseRequest: '86000000-0000-4000-8000-000000000096',
  submission: '86000000-0000-4000-8000-000000000097',
  conflictingSubmission: '86000000-0000-4000-8000-000000000098',
};

const gradingMaterial = {
  contractVersion: 'certsim-python-trusted-grading-v1',
  taskId: 'issue86-executable',
  maximumRawPoints: 5,
  rules: [{
    id: 'rule.synthetic', type: 'TOKEN', points: 5,
    compiled: {
      contractVersion: 'certsim-python-trusted-grading-v1',
      family: 'token_comment', target: 'process_records', anchor: 'For',
      anchorOccurrence: 1, relation: 'immediately_before_same_block',
      requiredConceptGroups: [['store', 'stores'], ['record', 'records'], ['batch', 'output']],
    },
  }],
};
const gradingMaterialDigest = createHash('sha256').update(canonicalJson(gradingMaterial)).digest('hex');
const executableScoring = {
  maximumRawPoints: 5,
  trustedGrading: { status: 'compiled', materialDigest: gradingMaterialDigest, gradingMaterial },
};

runSql(`
  insert into auth.users(instance_id,id,aud,role,email,encrypted_password,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values
    ('00000000-0000-0000-0000-000000000000','${ids.owner}','authenticated','authenticated','owner-86@example.invalid','','{}','{}',now(),now()),
    ('00000000-0000-0000-0000-000000000000','${ids.outsider}','authenticated','authenticated','outsider-86@example.invalid','','{}','{}',now(),now());
  update public.profiles set status='active' where id in ('${ids.owner}','${ids.outsider}');
  insert into public.organisations(id,name,organisation_type,status)
    values('${ids.organisation}','Issue 86 disposable fixture','internal','active');
  insert into public.memberships(user_id,organisation_id,role,status) values
    ('${ids.owner}','${ids.organisation}','platform_owner','active'),
    ('${ids.outsider}','${ids.organisation}','platform_owner','active');

  insert into exam_delivery.package_versions(
    id,exam_key,package_version,source_commit_sha,validation_hash,package_hash,
    package_schema_version,generator_version,scorer_version,created_at
  ) values(
    '${ids.package}','issue86fixture','1.0.0',repeat('1',40),repeat('2',64),repeat('3',64),
    'certsim-protected-package-v2','issue86','issue86',statement_timestamp()
  );
  insert into exam_delivery.package_profiles(
    id,package_version_id,profile_key,display_name,question_count,time_limit_minutes,selection_config
  ) values('${ids.profile}','${ids.package}','python-r5','Issue 86 synthetic profile',2,60,'{}');
  insert into exam_delivery.package_questions(
    id,package_version_id,question_id,question_type,domain_key,section_key,
    source_ordinal,presentation_payload,content_hash
  ) values
    ('${ids.executableQuestion}','${ids.package}','issue86-executable','executable-python-lab-v1','d1','python',1,
      '{"interactionVersion":"executable-python-lab-v1"}',repeat('4',64)),
    ('${ids.ordinaryQuestion}','${ids.package}','issue86-ordinary','single-choice','d1','standard',2,
      '{"stem":"synthetic","options":[{"id":"a","text":"A"},{"id":"b","text":"B"}]}',repeat('5',64));
  insert into exam_delivery.package_question_protected_content(
    question_id,package_version_id,scoring_payload,review_payload,authoring_metadata
  ) values
    ('${ids.executableQuestion}','${ids.package}','${JSON.stringify(executableScoring)}','{}','{"scored":true}'),
    ('${ids.ordinaryQuestion}','${ids.package}','{"correctAnswer":"a"}',
      '{"explanation":"Synthetic explanation.","remediation":"Synthetic remediation."}','{"scored":true}');
  update exam_delivery.package_versions set status='published',published_at=statement_timestamp()
    where id='${ids.package}';
  insert into exam_delivery.exam_profile_activations(
    package_version_id,package_profile_id,enabled,activation_kind,enabled_at,created_by
  ) values('${ids.package}','${ids.profile}',true,'production',statement_timestamp(),'${ids.owner}');
  insert into exam_delivery.practice_policies(
    canonical_exam_key,package_version,profile_key,purpose,access_mode,enabled,
    maximum_session_items,immediate_feedback,review_release_policy,answer_release_policy
  ) values(
    'issue86fixture','1.0.0','python-r5','study_sandbox','open_authenticated',true,
    10,true,'immediate_study_feedback','immediate_study_feedback'
  );

  insert into exam_delivery.attempts(
    id,owner_id,package_version_id,package_profile_id,client_request_id,status,
    generator_version,scorer_version,created_at,started_at,expires_at,purpose,
    practice_configuration,language_preference,practice_last_activity_at,practice_idle_expires_at
  ) values
    ('${ids.ownerAttempt}','${ids.owner}','${ids.package}','${ids.profile}',gen_random_uuid(),'in_progress',
      'issue86','issue86',statement_timestamp(),statement_timestamp(),null,'study_sandbox','{}','not_applicable',statement_timestamp(),statement_timestamp()+interval '30 days'),
    ('${ids.outsiderAttempt}','${ids.outsider}','${ids.package}','${ids.profile}',gen_random_uuid(),'in_progress',
      'issue86','issue86',statement_timestamp(),statement_timestamp(),null,'study_sandbox','{}','not_applicable',statement_timestamp(),statement_timestamp()+interval '30 days'),
    ('${ids.abandonedAttempt}','${ids.owner}','${ids.package}','${ids.profile}',gen_random_uuid(),'abandoned',
      'issue86','issue86',statement_timestamp(),statement_timestamp(),null,'study_sandbox','{}','not_applicable',statement_timestamp(),statement_timestamp()+interval '30 days');
  insert into exam_delivery.attempt_items(
    id,attempt_id,package_version_id,package_question_id,presented_question_number,
    option_order,presentation_snapshot,presentation_hash
  ) values
    ('${ids.ownerItem}','${ids.ownerAttempt}','${ids.package}','${ids.executableQuestion}',1,'[]',
      '{"interactionVersion":"executable-python-lab-v1"}',repeat('6',64)),
    ('${ids.ownerOrdinaryItem}','${ids.ownerAttempt}','${ids.package}','${ids.ordinaryQuestion}',2,'[]',
      '{"stem":"synthetic","options":[{"id":"a","text":"A"},{"id":"b","text":"B"}]}',repeat('7',64)),
    ('${ids.outsiderItem}','${ids.outsiderAttempt}','${ids.package}','${ids.executableQuestion}',1,'[]',
      '{"interactionVersion":"executable-python-lab-v1"}',repeat('8',64)),
    ('${ids.abandonedItem}','${ids.abandonedAttempt}','${ids.package}','${ids.executableQuestion}',1,'[]',
      '{"interactionVersion":"executable-python-lab-v1"}',repeat('9',64));
  insert into exam_delivery.attempt_item_protected_content(
    attempt_item_id,attempt_id,scoring_snapshot,review_snapshot,protected_snapshot_hash
  ) values
    ('${ids.ownerItem}','${ids.ownerAttempt}','${JSON.stringify(executableScoring)}','{}',repeat('a',64)),
    ('${ids.ownerOrdinaryItem}','${ids.ownerAttempt}','{"correctAnswer":"a"}',
      '{"explanation":"Synthetic explanation.","remediation":"Synthetic remediation."}',repeat('b',64)),
    ('${ids.outsiderItem}','${ids.outsiderAttempt}','${JSON.stringify(executableScoring)}','{}',repeat('c',64)),
    ('${ids.abandonedItem}','${ids.abandonedAttempt}','${JSON.stringify(executableScoring)}','{}',repeat('d',64));
`);

const workspaceOne = `{"entryPoint":"main.py","files":[{"path":"util.py","content":"VALUE = 1\\n"},{"path":"main.py","content":"print(42)\\n"}]}`;
const workspaceOneReordered = `{"files":[{"content":"print(42)\\n","path":"main.py"},{"content":"VALUE = 1\\n","path":"util.py"}],"entryPoint":"main.py"}`;
const workspaceTwo = `{"entryPoint":"main.py","files":[{"path":"main.py","content":"print(84)\\n"}]}`;

const empty = rpc(`select public.certsim_protected_get_python_workspace('${ids.owner}','${ids.ownerAttempt}','${ids.ownerItem}')`);
equal(empty, { ok: true, itemId: ids.ownerItem, exists: false, revision: 0, workspaceHash: null, workspace: null, updatedAt: null }, 'empty workspace DTO');

const first = rpc(`select public.certsim_protected_save_python_workspace(
  '${ids.owner}','${ids.ownerAttempt}','${ids.ownerItem}','${workspaceOne}'::jsonb,0,'${ids.saveOne}')`);
equal(first.ok, true, 'workspace create succeeds');
equal(first.revision, 1, 'workspace starts at revision one');
match(first.workspaceHash, /^[0-9a-f]{64}$/, 'workspace hash is SHA-256');

const replay = rpc(`select public.certsim_protected_save_python_workspace(
  '${ids.owner}','${ids.ownerAttempt}','${ids.ownerItem}','${workspaceOneReordered}'::jsonb,0,'${ids.saveOne}')`);
equal(replay, first, 'same request and logical workspace is idempotent');
equal(Number(scalar(`select count(*) from exam_delivery.python_lab_workspace_revisions where attempt_item_id='${ids.ownerItem}'`)), 1, 'idempotent retry creates no revision');

const conflictingReplay = rpc(`select public.certsim_protected_save_python_workspace(
  '${ids.owner}','${ids.ownerAttempt}','${ids.ownerItem}','${workspaceTwo}'::jsonb,0,'${ids.saveOne}')`);
equal(conflictingReplay.code, 'workspace_request_conflict', 'request identity cannot be rebound');
const stale = rpc(`select public.certsim_protected_save_python_workspace(
  '${ids.owner}','${ids.ownerAttempt}','${ids.ownerItem}','${workspaceTwo}'::jsonb,0,'${ids.staleSave}')`);
equal(stale.code, 'revision_conflict', 'stale expected revision is rejected');
const second = rpc(`select public.certsim_protected_save_python_workspace(
  '${ids.owner}','${ids.ownerAttempt}','${ids.ownerItem}','${workspaceTwo}'::jsonb,1,'${ids.saveTwo}')`);
equal(second.revision, 2, 'workspace revision increments');
equal(Number(scalar(`select count(*) from exam_delivery.python_lab_workspace_revisions where attempt_item_id='${ids.ownerItem}'`)), 2, 'immutable revision history is durable');

const loaded = rpc(`select public.certsim_protected_get_python_workspace('${ids.owner}','${ids.ownerAttempt}','${ids.ownerItem}')`);
equal(loaded.workspace.files, [{ path: 'main.py', content: 'print(84)\n' }], 'workspace is canonical and source-only');
equal(loaded.workspaceHash, second.workspaceHash, 'read returns exact current hash');
equal(
  scalar(`select exam_delivery.python_workspace_hash('${workspaceOne}'::jsonb)=exam_delivery.python_workspace_hash('${workspaceOneReordered}'::jsonb)`),
  't',
  'workspace hash ignores file and object-key order',
);
equal(scalar(`select exam_delivery.python_workspace_hash('${workspaceOne}'::jsonb)=exam_delivery.python_workspace_hash('${workspaceTwo}'::jsonb)`), 'f', 'workspace hash changes with source');
equal(scalar(`select exam_delivery.python_workspace_valid('{"entryPoint":"../main.py","files":[{"path":"../main.py","content":"x"}]}'::jsonb)`), 'f', 'traversal workspace is invalid');
equal(scalar(`select exam_delivery.python_workspace_valid(jsonb_build_object('entryPoint','main.py','files',jsonb_build_array(jsonb_build_object('path','main.py','content',repeat('a',65537)))))`), 'f', 'per-file byte bound is enforced');
equal(scalar(`select exam_delivery.python_workspace_valid(jsonb_build_object('entryPoint','f1.py','files',jsonb_agg(jsonb_build_object('path','f'||n||'.py','content','x')))) from generate_series(1,17) n`), 'f', 'file-count bound is enforced');

equal(rpc(`select public.certsim_protected_get_python_workspace('${ids.outsider}','${ids.ownerAttempt}','${ids.ownerItem}')`).code, 'attempt_not_found', 'cross-owner read is anti-enumerating');
equal(rpc(`select public.certsim_protected_get_python_workspace('${ids.owner}','${ids.ownerAttempt}','${ids.ownerOrdinaryItem}')`).code, 'attempt_not_found', 'non-executable item is denied');
equal(rpc(`select public.certsim_protected_get_python_workspace('${ids.owner}','${ids.abandonedAttempt}','${ids.abandonedItem}')`).code, 'invalid_lifecycle_transition', 'invalid attempt lifecycle fails closed');
equal(rpc(`select public.certsim_protected_save_python_workspace('${ids.owner}','${ids.ownerAttempt}','${ids.ownerItem}','{"entryPoint":"main.py","files":[]}'::jsonb,2,gen_random_uuid())`).code, 'invalid_request', 'invalid workspace save fails closed');

const runDisabled = rpc(`select public.certsim_protected_request_python_run(
  '${ids.owner}','${ids.ownerAttempt}','${ids.ownerItem}',2,'${ids.runRequest}')`);
equal(runDisabled, { ok: false, code: 'executor_disabled' }, 'validated run request is server-disabled');
equal(Number(scalar('select count(*) from exam_delivery.python_execution_runs')), 0, 'disabled request creates no misleading run');
equal(rpc(`select public.certsim_protected_request_python_run('${ids.owner}','${ids.ownerAttempt}','${ids.ownerItem}',1,gen_random_uuid())`).code, 'revision_conflict', 'run binds current workspace revision');

const workspaceHash = scalar(`select workspace_hash from exam_delivery.python_lab_workspaces where attempt_item_id='${ids.ownerItem}'`);
const orchestrationDigest = scalar(`select exam_delivery.python_orchestration_request_digest(
  '${ids.ownerAttempt}','${ids.ownerItem}',2,'${workspaceHash}','${ids.runRequest}')`);
equal(scalar(`select exam_delivery.python_orchestration_request_digest(
  '${ids.ownerAttempt}','${ids.ownerItem}',2,'${workspaceHash}','${ids.runRequest}')`), orchestrationDigest, 'orchestration digest is deterministic');
for (const [expression, message] of [
  [`exam_delivery.python_orchestration_request_digest('${ids.outsiderAttempt}','${ids.ownerItem}',2,'${workspaceHash}','${ids.runRequest}')`, 'attempt identity changes orchestration digest'],
  [`exam_delivery.python_orchestration_request_digest('${ids.ownerAttempt}','${ids.outsiderItem}',2,'${workspaceHash}','${ids.runRequest}')`, 'item identity changes orchestration digest'],
  [`exam_delivery.python_orchestration_request_digest('${ids.ownerAttempt}','${ids.ownerItem}',1,'${workspaceHash}','${ids.runRequest}')`, 'workspace revision changes orchestration digest'],
  [`exam_delivery.python_orchestration_request_digest('${ids.ownerAttempt}','${ids.ownerItem}',2,repeat('b',64),'${ids.runRequest}')`, 'workspace hash changes orchestration digest'],
  [`exam_delivery.python_orchestration_request_digest('${ids.ownerAttempt}','${ids.ownerItem}',2,'${workspaceHash}','${ids.invalidRunRequest}')`, 'execution request identity changes orchestration digest'],
]) equal(scalar(`select ${expression}`) === orchestrationDigest, false, message);

expectFailure(`insert into exam_delivery.python_execution_runs(
  id,attempt_id,attempt_item_id,workspace_revision,workspace_hash,execution_request_id,orchestration_request_digest,state
) values('${ids.invalidRun}','${ids.ownerAttempt}','${ids.ownerItem}',2,'${workspaceHash}','${ids.invalidRunRequest}',repeat('a',64),'authorized')`, /orchestration_request_digest_matches/i, 'fabricated orchestration digest is rejected');

runSql(`insert into exam_delivery.python_execution_runs(
  id,attempt_id,attempt_item_id,workspace_revision,workspace_hash,execution_request_id,orchestration_request_digest,state
) values(
  '${ids.run}','${ids.ownerAttempt}','${ids.ownerItem}',2,'${workspaceHash}','${ids.runRequest}',
  exam_delivery.python_orchestration_request_digest('${ids.ownerAttempt}','${ids.ownerItem}',2,'${workspaceHash}','${ids.runRequest}'),'authorized'
)`);
equal(scalar(`select orchestration_request_digest=exam_delivery.python_orchestration_request_digest(attempt_id,attempt_item_id,workspace_revision,workspace_hash,execution_request_id) from exam_delivery.python_execution_runs where id='${ids.run}'`), 't', 'run orchestration digest binds durable request identity exactly');
equal(scalar(`select execution_request_digest is null from exam_delivery.python_execution_runs where id='${ids.run}'`), 't', 'new authorized run has no fabricated R4 execution request digest');
const executionRequestDigest = 'c'.repeat(64);
expectFailure(`insert into exam_delivery.python_grading_materializations(
  id,grading_session_id,run_id,execution_request_digest,material_digest,grading_contract_version,maximum_raw_points
) values('${ids.materialization}','${ids.gradingSession}','${ids.run}','${executionRequestDigest}',repeat('d',64),'certsim.python-grading.binding.v1',5)`, /foreign key/i, 'run without canonical execution request digest cannot receive grading materialization');
equal(rpc(`select exam_delivery.persist_verified_python_grading_evidence(
  '${ids.evidence}','${ids.run}','${ids.materialization}','${ids.gradingSession}',
  '${executionRequestDigest}',repeat('e',64),repeat('d',64),'certsim.python-grading.binding.v1',3,5,
  '[{"ruleId":"tests.public","earnedRawPoints":3,"maximumRawPoints":5}]'::jsonb
)`).code, 'grading_binding_mismatch', 'run without canonical execution request digest cannot receive grading evidence');
runSql(`update exam_delivery.python_execution_runs set
  execution_request_digest='${executionRequestDigest}',state='queued',updated_at=statement_timestamp()
  where id='${ids.run}'`);
equal(scalar(`select execution_request_digest from exam_delivery.python_execution_runs where id='${ids.run}'`), executionRequestDigest, 'trusted transition records canonical R2 execution request digest');
expectFailure(`update exam_delivery.python_execution_runs set execution_request_digest=repeat('d',64),updated_at=statement_timestamp() where id='${ids.run}'`, /execution_request_digest_immutable/i, 'execution request digest is immutable once assigned');
expectFailure(`insert into exam_delivery.python_execution_runs(
  id,attempt_id,attempt_item_id,workspace_revision,workspace_hash,execution_request_id,orchestration_request_digest,state
) values(
  '${ids.secondRun}','${ids.ownerAttempt}','${ids.ownerItem}',2,'${workspaceHash}','${ids.secondRunRequest}',
  exam_delivery.python_orchestration_request_digest('${ids.ownerAttempt}','${ids.ownerItem}',2,'${workspaceHash}','${ids.secondRunRequest}'),'authorized'
)`, /one_active_item/i, 'only one active run may exist per item');

const queued = rpc(`select public.certsim_protected_get_python_run('${ids.owner}','${ids.ownerAttempt}','${ids.ownerItem}','${ids.run}')`);
equal(queued.state, 'queued', 'bounded run status is readable by owner');
equal(Object.hasOwn(queued, 'providerExecutionId'), false, 'run DTO omits provider identity');
equal(Object.hasOwn(queued, 'executionResultDigest'), false, 'run DTO omits execution internals');
equal(rpc(`select public.certsim_protected_get_python_run('${ids.outsider}','${ids.ownerAttempt}','${ids.ownerItem}','${ids.run}')`).code, 'attempt_not_found', 'cross-owner run status is anti-enumerating');

const cancelledRequest = rpc(`select public.certsim_protected_cancel_python_run(
  '${ids.owner}','${ids.ownerAttempt}','${ids.ownerItem}','${ids.run}','${ids.cancel}')`);
equal(cancelledRequest.state, 'cancel_requested', 'cancel moves run to explicit reconciliation state');
equal(cancelledRequest.disposalState, 'pending', 'cancel requests disposal reconciliation');
equal(rpc(`select public.certsim_protected_cancel_python_run('${ids.owner}','${ids.ownerAttempt}','${ids.ownerItem}','${ids.run}','${ids.cancel}')`), cancelledRequest, 'cancel retry is idempotent');
expectFailure(`update exam_delivery.python_execution_runs set state='running',updated_at=statement_timestamp() where id='${ids.run}'`, /transition_invalid/i, 'backward run transition is rejected');
runSql(`update exam_delivery.python_execution_runs set
  state='cancelled',execution_result_digest=repeat('e',64),terminal_outcome='cancelled',
  completed_at=statement_timestamp(),updated_at=statement_timestamp()
  where id='${ids.run}'`);
expectFailure(`update exam_delivery.python_execution_runs set terminal_outcome='failed',updated_at=statement_timestamp() where id='${ids.run}'`, /terminal_immutable/i, 'terminal result binding is immutable');
runSql(`update exam_delivery.python_execution_runs set
  disposal_state='confirmed',disposed_at=statement_timestamp(),updated_at=statement_timestamp()
  where id='${ids.run}'`);
equal(scalar(`select disposal_state from exam_delivery.python_execution_runs where id='${ids.run}'`), 'confirmed', 'terminal disposal can be reconciled');
expectFailure(`delete from exam_delivery.python_execution_runs where id='${ids.run}'`, /python_run_immutable/i, 'run identity cannot be deleted');

runSql(`insert into exam_delivery.python_grading_materializations(
  id,grading_session_id,run_id,execution_request_digest,material_digest,grading_contract_version,maximum_raw_points
) values('${ids.materialization}','${ids.gradingSession}','${ids.run}','${executionRequestDigest}',repeat('d',64),'certsim.python-grading.binding.v1',5)`);
const rules = `[{"ruleId":"tests.public","earnedRawPoints":3,"maximumRawPoints":5}]`;
equal(rpc(`select exam_delivery.persist_verified_python_grading_evidence(
  '${ids.evidence}','${ids.run}','${ids.materialization}','${ids.gradingSession}',
  repeat('b',64),repeat('e',64),repeat('d',64),'certsim.python-grading.binding.v1',3,5,'${rules}'::jsonb
)`).code, 'grading_binding_mismatch', 'mismatched canonical execution request digest is rejected');
equal(rpc(`select exam_delivery.persist_verified_python_grading_evidence(
  '${ids.evidence}','${ids.run}','${ids.materialization}','${ids.gradingSession}',
  '${executionRequestDigest}',repeat('f',64),repeat('d',64),'certsim.python-grading.binding.v1',3,5,'${rules}'::jsonb
)`).code, 'grading_binding_mismatch', 'result digest mismatch is rejected');
equal(rpc(`select exam_delivery.persist_verified_python_grading_evidence(
  '${ids.evidence}','${ids.run}','${ids.materialization}','${ids.gradingSession}',
  '${executionRequestDigest}',repeat('e',64),repeat('d',64),'certsim.python-grading.binding.v1',3,6,
  '[{"ruleId":"tests.public","earnedRawPoints":3,"maximumRawPoints":6}]'::jsonb
)`).code, 'grading_binding_mismatch', 'evidence maximum must match materialization');
const persisted = rpc(`select exam_delivery.persist_verified_python_grading_evidence(
  '${ids.evidence}','${ids.run}','${ids.materialization}','${ids.gradingSession}',
  '${executionRequestDigest}',repeat('e',64),repeat('d',64),'certsim.python-grading.binding.v1',3,5,'${rules}'::jsonb
)`);
equal(persisted, { ok: true, replayed: false, evidenceId: ids.evidence, earnedRawPoints: 3, maximumRawPoints: 5 }, 'verified opaque raw points persist');
equal(rpc(`select exam_delivery.persist_verified_python_grading_evidence(
  '${ids.evidence}','${ids.run}','${ids.materialization}','${ids.gradingSession}',
  '${executionRequestDigest}',repeat('e',64),repeat('d',64),'certsim.python-grading.binding.v1',3,5,'${rules}'::jsonb
)`), { ok: true, replayed: true, evidenceId: ids.evidence, earnedRawPoints: 3, maximumRawPoints: 5 }, 'exact evidence replay is idempotent');
equal(rpc(`select exam_delivery.persist_verified_python_grading_evidence(
  '${ids.evidence}','${ids.run}','${ids.materialization}','${ids.gradingSession}',
  '${executionRequestDigest}',repeat('e',64),repeat('d',64),'certsim.python-grading.binding.v1',2,5,
  '[{"ruleId":"tests.public","earnedRawPoints":2,"maximumRawPoints":5}]'::jsonb
)`).code, 'grading_evidence_replay', 'conflicting evidence replay is rejected');
expectFailure(`update exam_delivery.python_grading_evidence set earned_raw_points=4 where evidence_id='${ids.evidence}'`, /immutable/i, 'grading evidence is immutable');

const liveDigest = '1'.repeat(64);
const liveResultDigest = '2'.repeat(64);
const begun = rpc(`select public.certsim_service_begin_python_execution(
  '${ids.owner}','${ids.ownerAttempt}','${ids.ownerItem}',2,
  '${ids.liveClientRequest}','${ids.liveExecutionRequest}','${liveDigest}',
  20000,134217728,1048576
)`);
equal(begun.ok, true, 'service-only begin accepts the exact saved revision');
equal(begun.replayed, false, 'first execution begin is not a replay');
equal(begun.executionRequestId, ids.liveExecutionRequest, 'server execution request identity is bound');
const liveRun = begun.runId;

const replayedBegin = rpc(`select public.certsim_service_begin_python_execution(
  '${ids.owner}','${ids.ownerAttempt}','${ids.ownerItem}',2,
  '${ids.liveClientRequest}','${ids.replayExecutionRequest}',repeat('3',64),
  20000,134217728,1048576
)`);
equal(replayedBegin.runId, liveRun, 'ambiguous begin retry returns the same durable run');
equal(replayedBegin.executionRequestId, ids.liveExecutionRequest, 'retry retains the original server request identity');
equal(replayedBegin.replayed, true, 'ambiguous begin retry is explicitly classified');
equal(Number(scalar(`select count(*) from exam_delivery.python_execution_runs where client_request_id='${ids.liveClientRequest}'`)), 1, 'ambiguous begin creates no duplicate run');

equal(rpc(`select public.certsim_service_begin_python_execution(
  '${ids.owner}','${ids.ownerAttempt}','${ids.ownerItem}',2,
  '${ids.competingClientRequest}','${ids.competingExecutionRequest}',repeat('4',64),
  20000,134217728,1048576
)`).code, 'run_in_progress', 'a second active run for the item is rejected');
const liveAuthority = rpc(`select public.certsim_service_get_python_execution_authority(
  '${ids.owner}','${ids.ownerAttempt}','${ids.ownerItem}','${liveRun}'
)`);
equal(liveAuthority.executionRequestId, ids.liveExecutionRequest, 'cancellation authority restores the server request identity');
equal(liveAuthority.workspace, JSON.parse(workspaceTwo), 'cancellation authority restores the exact immutable workspace revision');

const completed = rpc(`select public.certsim_service_complete_python_execution(
  '${liveRun}','${liveDigest}','execution.${ids.liveExecutionRequest}',
  '${liveResultDigest}','completed','completed','learner output' || chr(10),'',0,true
)`);
equal(completed.state, 'completed', 'terminal completion is persisted');
equal(completed.stdout, 'learner output\n', 'bounded learner stdout is returned');
equal(completed.stderr, '', 'empty learner stderr remains explicit');
equal(completed.exitCode, 0, 'learner exit code is returned');
equal(completed.disposalState, 'confirmed', 'terminal completion requires confirmed disposal');
equal(rpc(`select public.certsim_service_complete_python_execution(
  '${liveRun}','${liveDigest}','execution.${ids.liveExecutionRequest}',
  '${liveResultDigest}','completed','completed','learner output' || chr(10),'',0,true
)`).runId, liveRun, 'terminal completion retry is idempotent');
equal(rpc(`select public.certsim_service_complete_python_execution(
  '${liveRun}','${liveDigest}','execution.${ids.liveExecutionRequest}',
  repeat('5',64),'completed','completed','changed','',0,true
)`).code, 'terminal_rebinding_prohibited', 'terminal output and digest rebinding is prohibited');
const learnerRun = rpc(`select public.certsim_protected_get_python_run(
  '${ids.owner}','${ids.ownerAttempt}','${ids.ownerItem}','${liveRun}'
)`);
equal(learnerRun.stdout, 'learner output\n', 'learner run DTO includes bounded stdout');
equal(Object.hasOwn(learnerRun, 'providerExecutionId'), false, 'learner run DTO excludes provider identity');

expectFailure(`set role authenticated; select public.certsim_protected_get_python_workspace('${ids.owner}','${ids.ownerAttempt}','${ids.ownerItem}')`, /permission denied/i, 'browser cannot execute fixed wrapper directly');
expectFailure(`set role authenticated; select public.certsim_service_begin_python_execution(
  '${ids.owner}','${ids.ownerAttempt}','${ids.ownerItem}',2,gen_random_uuid(),gen_random_uuid(),repeat('a',64),20000,134217728,1048576
)`, /permission denied/i, 'browser cannot execute service-only run begin');
expectFailure(`set role service_role; insert into exam_delivery.python_lab_workspaces(attempt_item_id,attempt_id,current_revision,workspace,workspace_hash)
  values(gen_random_uuid(),'${ids.ownerAttempt}',1,'{}',repeat('a',64))`, /permission denied/i, 'service role cannot mutate orchestration tables directly');
equal(scalar(`select has_function_privilege('service_role','public.certsim_service_persist_verified_python_grading_evidence(uuid,uuid,uuid,uuid,text,text,text,text,integer,integer,jsonb)','EXECUTE')`), 't', 'service role can invoke the enabled fixed evidence wrapper');
expectFailure(`set role authenticated; select public.certsim_service_persist_verified_python_grading_evidence(
  gen_random_uuid(),'${ids.run}','${ids.materialization}','${ids.gradingSession}','${executionRequestDigest}',repeat('e',64),repeat('d',64),
  'certsim.python-grading.binding.v1',3,5,'${rules}'::jsonb)`, /permission denied/i, 'browser cannot invoke the evidence wrapper');
equal(Number(scalar(`select count(*) from information_schema.role_table_grants where table_schema='exam_delivery'
  and table_name like 'python_%' and grantee in ('anon','authenticated','service_role')`)), 0, 'no browser or service table grants exist');
equal(Number(scalar(`select count(*) from exam_delivery.python_grading_evidence`)), 1, 'one unique evidence row exists');
equal(Number(scalar(`select count(*) from exam_delivery.attempt_results where attempt_id='${ids.ownerAttempt}'`)), 0, 'Python evidence does not manufacture a generic result');

runSql(`insert into exam_delivery.attempt_responses(
  id,attempt_id,attempt_item_id,response_payload,revision,last_request_id
) values(
  '${ids.ordinaryResponse}','${ids.ownerAttempt}','${ids.ownerOrdinaryItem}',
  '{"answer":"a"}'::jsonb,1,'${ids.ordinaryResponseRequest}'
)`);

const prepared = rpc(`select public.certsim_service_prepare_python_submission_grading(
  '${ids.owner}','${ids.ownerAttempt}','${ids.submission}'
)`);
equal(prepared.ok, true, 'final submission grading preparation succeeds');
equal(prepared.required, true, 'executable item requires trusted grading');
equal(prepared.ready, false, 'submission is not ready before verified evidence');
equal(prepared.completed, false, 'first preparation is not a completed-result replay');
equal(prepared.items.length, 1, 'one executable item receives one grading authority');
const gradingItem = prepared.items[0];
equal(gradingItem.itemId, ids.ownerItem, 'grading authority binds the exact attempt item');
equal(gradingItem.workspaceRevision, 2, 'grading freezes the latest workspace revision');
equal(gradingItem.workspaceHash, second.workspaceHash, 'grading freezes the latest workspace hash');
equal(gradingItem.workspace, JSON.parse(workspaceTwo), 'grading restores the exact frozen workspace');
equal(gradingItem.gradingMaterial, gradingMaterial, 'grading authority returns the exact protected material to service authority');
equal(gradingItem.materialDigest, gradingMaterialDigest, 'grading authority binds the protected material digest');
equal(gradingItem.maximumRawPoints, 5, 'grading authority binds the raw-point capacity');
equal(rpc(`select public.certsim_service_prepare_python_submission_grading(
  '${ids.owner}','${ids.ownerAttempt}','${ids.conflictingSubmission}'
)`).code, 'submission_conflict', 'submission identity cannot be rebound after freeze');
equal(rpc(`select public.certsim_protected_save_python_workspace(
  '${ids.owner}','${ids.ownerAttempt}','${ids.ownerItem}','${workspaceTwo}'::jsonb,2,'${ids.conflictingSubmission}'
)`).code, 'submission_in_progress', 'new workspace saves are blocked after submission freeze');
equal(rpc(`select public.certsim_protected_save_python_workspace(
  '${ids.owner}','${ids.ownerAttempt}','${ids.ownerItem}','${workspaceTwo}'::jsonb,1,'${ids.saveTwo}'
)`), second, 'an exact pre-freeze save replay remains idempotent');

const finalRequestDigest = '9'.repeat(64);
const finalResultDigest = '8'.repeat(64);
const claimed = rpc(`select public.certsim_service_materialize_python_submission_grading(
  '${ids.owner}','${ids.ownerAttempt}','${ids.submission}','${ids.ownerItem}',
  '${gradingItem.runId}','${finalRequestDigest}'
)`);
equal(claimed.claimed, true, 'first final grading materialization claims the durable run');
equal(claimed.state, 'running', 'claimed final grading run is explicitly running');
equal(rpc(`select public.certsim_service_materialize_python_submission_grading(
  '${ids.owner}','${ids.ownerAttempt}','${ids.submission}','${ids.ownerItem}',
  '${gradingItem.runId}','${finalRequestDigest}'
)`).claimed, false, 'materialization retry creates no duplicate run');

const finalCompleted = rpc(`select public.certsim_service_complete_python_execution(
  '${gradingItem.runId}','${finalRequestDigest}','execution.${gradingItem.executionRequestId}',
  '${finalResultDigest}','completed','completed','','',0,true
)`);
equal(finalCompleted.state, 'completed', 'final R2 execution persists terminally before scoring');
equal(finalCompleted.disposalState, 'confirmed', 'final R2 execution confirms resource disposal');
equal(rpc(`select public.certsim_protected_submit_attempt(
  '${ids.owner}','${ids.ownerAttempt}','${ids.submission}'
)`).code, 'grading_incomplete', 'missing R5 evidence fails closed instead of silently scoring zero');
equal(Number(scalar(`select count(*) from exam_delivery.attempt_results where attempt_id='${ids.ownerAttempt}'`)), 0, 'incomplete grading creates no result');

const finalRules = `[{"ruleId":"rule.synthetic","earnedRawPoints":4,"maximumRawPoints":5}]`;
const finalEvidence = rpc(`select public.certsim_service_persist_verified_python_grading_evidence(
  '${gradingItem.gradingSessionId}','${gradingItem.runId}','${gradingItem.materializationId}',
  '${gradingItem.gradingSessionId}','${finalRequestDigest}','${finalResultDigest}',
  '${gradingMaterialDigest}','certsim-python-trusted-grading-v1',4,5,'${finalRules}'::jsonb
)`);
equal(finalEvidence.replayed, false, 'first final R5 evidence persistence is classified as new');
equal(rpc(`select public.certsim_service_persist_verified_python_grading_evidence(
  '${gradingItem.gradingSessionId}','${gradingItem.runId}','${gradingItem.materializationId}',
  '${gradingItem.gradingSessionId}','${finalRequestDigest}','${finalResultDigest}',
  '${gradingMaterialDigest}','certsim-python-trusted-grading-v1',4,5,'${finalRules}'::jsonb
)`).replayed, true, 'exact final R5 evidence retry is idempotent');
equal(rpc(`select public.certsim_service_persist_verified_python_grading_evidence(
  '${gradingItem.gradingSessionId}','${gradingItem.runId}','${gradingItem.materializationId}',
  '${gradingItem.gradingSessionId}','${finalRequestDigest}','${finalResultDigest}',
  '${gradingMaterialDigest}','certsim-python-trusted-grading-v1',3,5,
  '[{"ruleId":"rule.synthetic","earnedRawPoints":3,"maximumRawPoints":5}]'::jsonb
)`).code, 'grading_evidence_replay', 'conflicting final evidence retry is rejected');

const ready = rpc(`select public.certsim_service_prepare_python_submission_grading(
  '${ids.owner}','${ids.ownerAttempt}','${ids.submission}'
)`);
equal(ready.ready, true, 'verified R5 evidence makes final submission ready');
equal(ready.items[0].state, 'graded', 'prepared authority classifies the item as graded');
const submitted = rpc(`select public.certsim_protected_submit_attempt(
  '${ids.owner}','${ids.ownerAttempt}','${ids.submission}'
)`);
equal(submitted.ok, true, 'generic protected submission consumes trusted grading evidence');
equal(Number(scalar(`select raw_score from exam_delivery.attempt_results where attempt_id='${ids.ownerAttempt}'`)), 5, 'generic score combines four lab points with one ordinary point');
equal(Number(scalar(`select max_score from exam_delivery.attempt_results where attempt_id='${ids.ownerAttempt}'`)), 6, 'generic maximum combines lab and ordinary capacities');
equal(scalar(`select status from exam_delivery.attempts where id='${ids.ownerAttempt}'`), 'completed', 'successful trusted submission completes the attempt');
equal(Number(scalar(`select (result_summary->>'answeredCount')::integer from exam_delivery.attempt_results where attempt_id='${ids.ownerAttempt}'`)), 2, 'saved workspace counts as an answered executable item');
equal(Number(scalar(`select count(*) from exam_delivery.python_submission_grading_runs where attempt_id='${ids.ownerAttempt}' and submission_id='${ids.submission}'`)), 1, 'submission owns one durable grading run');
equal(Number(scalar(`select count(*) from exam_delivery.python_grading_evidence evidence join exam_delivery.python_submission_grading_runs submission_run on submission_run.run_id=evidence.run_id where submission_run.attempt_id='${ids.ownerAttempt}' and submission_run.submission_id='${ids.submission}'`)), 1, 'submission owns one durable grading evidence row');

const storedResponseHash = scalar(`select response_hash from exam_delivery.attempt_results where attempt_id='${ids.ownerAttempt}'`);
equal(storedResponseHash, scalar(`select encode(extensions.digest(convert_to(coalesce(jsonb_agg(jsonb_build_object(
  'itemId',i.id,'response',r.response_payload,
  'workspaceRevision',case when q.question_type='executable-python-lab-v1' then w.current_revision end,
  'workspaceHash',case when q.question_type='executable-python-lab-v1' then w.workspace_hash end
) order by i.id)::text,'[]'),'UTF8'),'sha256'),'hex')
from exam_delivery.attempt_items i
join exam_delivery.package_questions q on q.id=i.package_question_id
left join exam_delivery.attempt_responses r on r.attempt_id=i.attempt_id and r.attempt_item_id=i.id
left join exam_delivery.python_lab_workspaces w on w.attempt_id=i.attempt_id and w.attempt_item_id=i.id
where i.attempt_id='${ids.ownerAttempt}'`), 'result hash includes the exact final workspace revision and hash');

const review = JSON.parse(scalar(`select review_payload::text from exam_delivery.review_snapshots where attempt_id='${ids.ownerAttempt}'`));
const executableReview = review.items.find((item) => item.itemId === ids.ownerItem);
equal(Boolean(executableReview), true, 'review retains the executable item score');
equal(executableReview.earnedPoints, 4, 'review exposes only the awarded executable raw points');
equal(executableReview.maxPoints, 5, 'review exposes only the executable maximum points');
equal(Object.hasOwn(executableReview, 'correctAnswer'), false, 'review omits executable protected scoring material');
equal(Object.hasOwn(executableReview, 'explanation'), false, 'review omits executable protected explanation material');
equal(Object.hasOwn(executableReview, 'remediation'), false, 'review omits executable protected remediation material');
equal(JSON.stringify(review).includes('trustedGrading'), false, 'review serialization contains no trusted grading payload');
equal(JSON.stringify(review).includes(gradingMaterialDigest), false, 'review serialization contains no grading material digest');
equal(rpc(`select public.certsim_protected_submit_attempt(
  '${ids.owner}','${ids.ownerAttempt}','${ids.submission}'
)`), submitted, 'same final submission retry returns the existing generic result');
equal(rpc(`select public.certsim_protected_submit_attempt(
  '${ids.owner}','${ids.ownerAttempt}','${ids.conflictingSubmission}'
)`).code, 'submission_conflict', 'completed attempt rejects a conflicting submission identity');
const completedPreparation = rpc(`select public.certsim_service_prepare_python_submission_grading(
  '${ids.owner}','${ids.ownerAttempt}','${ids.submission}'
)`);
equal(completedPreparation, { ok: true, required: false, ready: true, completed: true, items: [] }, 'completed submission preparation is an idempotent result replay');
expectFailure(`delete from exam_delivery.python_submission_grading_sessions where attempt_id='${ids.ownerAttempt}'`, /immutable/i, 'submission freeze authority is immutable');

console.log(JSON.stringify({ ok: true, assertions, providerCalls: 0, learnerExecutions: 0 }, null, 2));

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function execute(sql) {
  return spawnSync(psql, ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-d', databaseUrl], {
    input: `${sql.trim()}\n`,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function runSql(sql) {
  const result = execute(sql);
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'psql failed');
  return result.stdout.trim();
}

function scalar(sql) {
  return runSql(sql).split(/\r?\n/).at(-1)?.trim() ?? '';
}

function rpc(sql) {
  return JSON.parse(scalar(sql));
}

function equal(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  assertions += 1;
}

function match(actual, pattern, message) {
  assert.match(actual, pattern, message);
  assertions += 1;
}

function expectFailure(sql, pattern, message) {
  const result = execute(sql);
  assert.notEqual(result.status, 0, `${message}: statement unexpectedly succeeded`);
  assert.match(`${result.stderr}\n${result.stdout}`, pattern, message);
  assertions += 1;
}
