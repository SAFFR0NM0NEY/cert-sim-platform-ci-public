import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { reserveCandidate, richReserveCandidate } from './fixtures/issue214-reserves.mjs';
import { sha256Canonical } from './backend-exam-publication/canonical-json.mjs';
import { buildExamOperationsReadQuery } from './exam-operations/read-production-state.mjs';
import { buildExamOperationsCurrentState } from './backend-exam-publication/exam-operations-current-state.mjs';
import { validateExamOperationsCandidate } from './backend-exam-publication/exam-operations-candidate.mjs';
import { createExamOperationsReleaseDiff } from './backend-exam-publication/exam-operations-release-diff.mjs';
const db = process.env.SUPABASE_DB_URL;
if (!db || !['localhost','127.0.0.1','[::1]'].includes(new URL(db).hostname)) throw Error('DISPOSABLE_LOCAL_REQUIRED');
let assertions = 0;
function sql(input) {
  const r = spawnSync(process.env.PSQL_PATH || 'psql', [db,'-XqAt','-v','ON_ERROR_STOP=1'], { input, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw Error('ISSUE214_SYNTHETIC_SQL_FAILED');
  return r.stdout.trim();
}
function eq(a,b) { assert.deepEqual(a,b); assertions++; }
const actor = randomUUID(), org = randomUUID(), candidate = reserveCandidate();
const request = { publicationRequestId: randomUUID(), sourceCommitSha: 'c'.repeat(40), packagePayload: candidate, packageHash: sha256Canonical(candidate) };
sql(`insert into auth.users(id,email,raw_user_meta_data) values('${actor}','fixture214@example.invalid','{}');
update public.profiles set status='active',default_role='platform_owner',user_type='platform' where id='${actor}';
insert into public.organisations(id,name,organisation_type,status) values('${org}','Synthetic 214','internal','active');
insert into public.memberships(user_id,organisation_id,role,status) values('${actor}','${org}','platform_owner','active');
set request.jwt.claim.sub='${actor}';set role authenticated;
select public.certsim_protected_publish_package($payload$${JSON.stringify(request)}$payload$::jsonb);`);
const expectedMigrations=process.argv.includes('--prior96')?96:Number(process.env.CERTSIM_VALIDATION_MIGRATIONS||97);
eq(sql(`select count(*) from supabase_migrations.schema_migrations`), String(expectedMigrations));
eq(sql(`select count(*) from exam_delivery.package_forms f join exam_delivery.package_versions p on p.id=f.package_version_id where p.exam_key='fixture214'`), '4');
for (const p of candidate.profiles) {
  const stored = JSON.parse(sql(`select selection_config#>'{canonicalForms,reserveQuestionIds}' from exam_delivery.package_profiles pp join exam_delivery.package_versions pv on pv.id=pp.package_version_id where pv.exam_key='fixture214' and profile_key='${p.profileKey}'`));
  eq(stored, p.selection.canonicalForms.reserveQuestionIds);
  for (const f of p.selection.canonicalForms.forms) {
    eq(JSON.parse(sql(`select jsonb_agg(q.question_id order by fq.presentation_ordinal) from exam_delivery.package_form_questions fq join exam_delivery.package_forms f on f.id=fq.form_id join exam_delivery.package_questions q on q.id=fq.package_question_id join exam_delivery.package_versions pv on pv.id=f.package_version_id where pv.exam_key='fixture214' and f.form_key='${f.formKey}'`)), f.questionIds);
  }
}
eq(JSON.parse(sql(`select jsonb_agg(q.question_id order by q.question_id) from exam_delivery.package_reserve_questions r join exam_delivery.package_questions q on q.id=r.package_question_id join exam_delivery.package_versions pv on pv.id=r.package_version_id where pv.exam_key='fixture214'`)), ['q7','q8']);
// Use the retained controlled release entry point, only in this disposable fixture.
for (const p of candidate.profiles) {
  sql(`insert into exam_delivery.exam_release_candidates(canonical_exam_key,package_version,profile_key,release_template,catalogue_slug,catalogue_title,catalogue_vendor,catalogue_exam_type,catalogue_source_type) values('fixture214','1.0.0','${p.profileKey}','standard_active_exam_v1','fixture214','Synthetic 214','Fixture','certification','official_source');
set request.jwt.claim.sub='${actor}';set role authenticated;
select public.certsim_configure_exam_release_stage('${JSON.stringify({ examKey: 'fixture214', packageVersion: '1.0.0', profileKey: p.profileKey, releaseStage: 'standard_active_exam_v1', requestId: randomUUID() })}'::jsonb);`);
  const started = JSON.parse(sql(`set role service_role; select public.certsim_protected_start_attempt('${actor}','fixture214','${p.profileKey}','${randomUUID()}')`));
  eq(started.ok, true);
  const id = started.attempt.attemptId;
  eq(Number(sql(`select count(*) from exam_delivery.attempt_items where attempt_id='${id}'`)), p.questionCount);
  const members = JSON.parse(sql(`select jsonb_agg(q.question_id order by ai.presented_question_number) from exam_delivery.attempt_items ai join exam_delivery.package_questions q on q.id=ai.package_question_id where ai.attempt_id='${id}'`));
  eq(p.selection.canonicalForms.forms.some(f => JSON.stringify(f.questionIds) === JSON.stringify(members)), true);
  if (p.profileKey === 'full') eq(members.some(id => ['q3','q6'].includes(id)), true);
  eq(Number(sql(`select extract(epoch from expires_at-started_at)::integer from exam_delivery.attempts where id='${id}'`)), p.timeLimitMinutes * 60);
  const before = sql(`select md5(to_jsonb(a)::text) from exam_delivery.attempts a where id='${id}'`);
  const resumed = JSON.parse(sql(`set role service_role; select public.certsim_protected_resume_attempt('${actor}','${id}')`));
  eq(resumed.ok, true);
  eq(resumed.attempt.attemptId, id);
  eq(sql(`select md5(to_jsonb(a)::text) from exam_delivery.attempts a where id='${id}'`), before);
}
const raw = JSON.parse(sql(buildExamOperationsReadQuery('fixture214', { genericReleaseOperations: true })));
const snapshot = buildExamOperationsCurrentState(raw, 'fixture214').snapshot;
eq(snapshot.currentPackage.profiles.map(p => [p.profileKey,p.forms.reserveItemCount]), [['compact',4],['full',2]]);
eq(snapshot.currentPackage.inventory.globalReserveItemCount, 2);
console.log(JSON.stringify({ suite: 'issue214-normal-publication-start-resume', assertions, migrations: expectedMigrations, profiles: 2, memberships: 10, globalReserveCount: 2, syntheticOnly: true }));

const rich = richReserveCandidate(), richBefore = assertions;
const richValidation = validateExamOperationsCandidate(rich);
eq(richValidation.ok, true);
eq(richValidation.manifest.inventory.globalReserveItemCount, 1);
const richRequest = { publicationRequestId: randomUUID(), sourceCommitSha: 'd'.repeat(40), packagePayload: rich, packageHash: sha256Canonical(rich) };
sql(`set request.jwt.claim.sub='${actor}';set role authenticated;
select public.certsim_protected_publish_package($payload$${JSON.stringify(richRequest)}$payload$::jsonb);`);
for (const p of rich.profiles) {
  for (const f of p.selection.canonicalForms.forms) {
    eq(JSON.parse(sql(`select jsonb_agg(q.question_id order by fq.presentation_ordinal) from exam_delivery.package_form_questions fq join exam_delivery.package_forms f on f.id=fq.form_id join exam_delivery.package_questions q on q.id=fq.package_question_id join exam_delivery.package_versions pv on pv.id=f.package_version_id where pv.exam_key='fixture214rich' and f.form_key='${f.formKey}'`)), f.questionIds);
  }
  sql(`insert into exam_delivery.exam_release_candidates(canonical_exam_key,package_version,profile_key,release_template,catalogue_slug,catalogue_title,catalogue_vendor,catalogue_exam_type,catalogue_source_type) values('fixture214rich','1.0.0','${p.profileKey}','standard_active_exam_v1','fixture214rich','Synthetic rich 214','Fixture','certification','official_source');
set request.jwt.claim.sub='${actor}';set role authenticated;
select public.certsim_configure_exam_release_stage('${JSON.stringify({examKey:'fixture214rich',packageVersion:'1.0.0',profileKey:p.profileKey,releaseStage:'standard_active_exam_v1',requestId:randomUUID()})}'::jsonb);`);
}
eq(JSON.parse(sql(`select jsonb_agg(q.question_id order by q.question_id) from exam_delivery.package_reserve_questions r join exam_delivery.package_questions q on q.id=r.package_question_id join exam_delivery.package_versions pv on pv.id=r.package_version_id where pv.exam_key='fixture214rich'`)), ['q7']);
eq(sql(`select count(*) from exam_delivery.package_questions q join exam_delivery.package_versions pv on pv.id=q.package_version_id where pv.exam_key='fixture214rich' and q.question_id='q8' and not exists(select 1 from exam_delivery.package_form_questions f where f.package_question_id=q.id) and not exists(select 1 from exam_delivery.package_reserve_questions r where r.package_question_id=q.id)`), '1');
const richRaw = JSON.parse(sql(buildExamOperationsReadQuery('fixture214rich', {genericReleaseOperations:true})));
const built = buildExamOperationsCurrentState(richRaw, 'fixture214rich');
eq(built.snapshot.currentPackage.inventory.globalReserveItemCount, 1);
const richDiff = createExamOperationsReleaseDiff({currentState:built.snapshot,candidateValidation:richValidation,currentFingerprintIndex:built.privateComparisonIndex,candidateContract:rich});
eq(richDiff.overallChangeClassification, 'NO_CHANGE');
eq(richDiff.aggregateInventory.globalReserveItemCount.availability, 'available');
eq(richDiff.aggregateInventory.globalReserveItemCount.delta, 0);
console.log(JSON.stringify({suite:'issue214-rich-normal-publication-parity',assertions:assertions-richBefore,profiles:rich.profiles.length,globalReserveCount:1,undeclaredUnusedItems:1,comparison:'NO_CHANGE',syntheticOnly:true}));
