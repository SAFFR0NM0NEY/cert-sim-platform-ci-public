import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const read=(path)=>readFile(new URL(`../${path}`,import.meta.url),'utf8');
const [sql,contract,client,runner,handler,routes,edgeTests,fixture,pgtap]=await Promise.all([
  read('supabase/migrations/20260905192938_cross_version_package_compatibility.sql'),
  read('src/lib/protectedExamContract.js'),read('src/lib/protectedExamClient.js'),
  read('src/components/exam/ProtectedExamRunner.jsx'),read('supabase/functions/certsim-protected-exam/handler.ts'),
  read('supabase/functions/certsim-protected-exam/routes.ts'),read('supabase/functions/certsim-protected-exam/tests/function_test.ts'),
  read('scripts/test-issue21-canonical-form-lifecycle.mjs'),read('supabase/tests/backend_exam_delivery_issue21_compatibility.sql'),
]);
for(const token of ['package_profile_defaults','package_domain_compatibility','resolve_package_profile_default','configure_package_successor','discover_current_formal_attempt','create_protected_assignment_current','pg_advisory_xact_lock','learner_started_new_attempt']) assert.match(sql,new RegExp(token));
for(const key of ['ai-agents','ai-powered-information-extraction','ai-speech','computer-vision','generative-ai','machine-learning-foundations','natural-language-processing','responsible-ai-ai-fundamentals']) assert.match(fixture,new RegExp(key));
assert.doesNotMatch(contract,/PACKAGE_VERSIONS|getProtectedPackageVersion/);
assert.doesNotMatch(client,/currentQuery[\s\S]{0,180}packageVersion/);
assert.doesNotMatch(runner,/expectedPackageVersion|getProtectedPackageVersion/);
assert.match(handler,/\["examKey", "profileId", "purpose", "language", "assignmentId"\]/);
assert.match(routes,/certsim_protected_discover_current_formal_attempt/);
assert.match(edgeTests,/examKey=az204&packageVersion=1\.1\.0&profileId=compact-profile&purpose=self_directed_exam&language=mixed/);
assert.match(edgeTests,/assertEquals\(response\.status, 400\)/);
assert.match(sql,/revoke all on table[\s\S]*public,anon,authenticated,service_role/);
assert.doesNotMatch(sql,/grant execute[\s\S]{0,180}configure_package_successor[\s\S]{0,80}authenticated/);
assert.match(sql,/v_assignment_id is null[\s\S]*source_assignment_id is null[\s\S]*v_assignment_id is not null[\s\S]*source_assignment_id=v_assignment_id/);
assert.match(sql,/create or replace function exam_delivery\.start_assignment_attempt\([\s\S]*resolve_package_profile_default\([\s\S]*'assigned_assessment'::exam_delivery\.attempt_purpose[\s\S]*'self_directed_exam',v_assignment\.id/);
assert.match(sql,/replace\(replace\([\s\S]*pg_get_functiondef\('exam_delivery\.start_assignment_attempt[\s\S]*E'\\r\\n',E'\\n'\),E'\\r',E'\\n'\)/);
assert.match(sql,/alter function exam_delivery\.start_assignment_attempt\(uuid,text,text,uuid,uuid\) owner to postgres/);
assert.match(sql,/assignment_default_resolution_contract_drift/);
const explicitAssignmentStart=sql.match(/create or replace function exam_delivery\.start_assignment_attempt\([\s\S]*?end \$\$;/)?.[0];
assert.ok(explicitAssignmentStart);
const assertAssignmentContract=(candidate)=>{
  const normalized=candidate.replace(/\r\n?/g,'\n');
  assert.equal((normalized.match(/resolve_package_profile_default/g)||[]).length,1);
  assert.equal((normalized.match(/'assigned_assessment'::exam_delivery\.attempt_purpose/g)||[]).length,1);
  assert.equal((normalized.match(/'self_directed_exam',v_assignment\.id/g)||[]).length,1);
  assert.doesNotMatch(normalized,/order by pv\.published_at desc/);
};
assertAssignmentContract(explicitAssignmentStart);
assertAssignmentContract(explicitAssignmentStart.replace(/\n/g,'\r\n'));
assert.throws(()=>assertAssignmentContract(explicitAssignmentStart.replace('resolve_package_profile_default','missing_default_resolver')));
assert.throws(()=>assertAssignmentContract(explicitAssignmentStart.replace('resolve_package_profile_default','resolve_package_profile_default resolve_package_profile_default')));
assert.match(sql,/regexp_count\(v_definition,'resolve_package_profile_default'\)<>1/);
assert.match(fixture,/2\.0\.0[\s\S]*3\.0\.0[\s\S]*REPLACEMENT_DID_NOT_USE_SUCCESSOR/);
assert.match(fixture,/SUCCESSOR_PUBLICATION_REPLAY_FAILED/);
assert.match(pgtap,/select plan\(32\)/);
assert.match(pgtap,/min\\\(a\\\.id::text\\\)::uuid/);
const canonical=await read('supabase/migrations/20260905153716_ai901_canonical_form_rotation.sql');
assert.equal(createHash('sha256').update(canonical.replace(/\r\n/g,'\n')).digest('hex'),'3a0272a06c879bfdb590a2a55b752e651c7f133438eb7af2a4dc8f64bc2deeeb');
console.log(JSON.stringify({ok:true,compatibilityContracts:31,domainMappings:8,canonicalMigrationUnchanged:true,lfAndCrlfPortable:true}));
