import test from 'node:test';import assert from 'node:assert/strict';
import {validateExamOperationsCandidate,MIGRATION_CLASSIFICATIONS} from './backend-exam-publication/exam-operations-candidate.mjs';
import {classifyRuntimeCompatibility,SUPPORTED_RUNTIME_TUPLES} from './backend-exam-publication/exam-operations-capability-registry.mjs';
import {syntheticSc100,legacySyntheticSc100} from './sc100-compatibility/synthetic-fixture.mjs';
const codes=p=>validateExamOperationsCandidate(p).validation.errors.map(x=>x.code);
test('legacy SC100 representation reproduces all four exact canonical-form failures',()=>{
 assert.deepEqual([...new Set(codes(legacySyntheticSc100()))].sort(),['CANONICAL_FORM_BLUEPRINT_INVALID','CANONICAL_FORM_CONTRACT_INVALID','CANONICAL_FORM_DEFINITION_INVALID','CANONICAL_FORM_RESERVE_POLICY_INVALID']);
});
test('correct metadata with the existing shared implementation validates SC100 without new runtime grants',()=>{
 const r=validateExamOperationsCandidate(syntheticSc100());assert.deepEqual(r.validation.errors,[]);assert.equal(r.ok,true);assert.equal(r.migrationClassification,MIGRATION_CLASSIFICATIONS.contentRelease);assert.deepEqual(r.validation.warnings,[]);
});
test('unregistered legacy SC100 implementation identifier remains rejected',()=>{
 const p=syntheticSc100();p.runtime.generatorVersion='certsim-sc100-canonical-forms-v1';const r=validateExamOperationsCandidate(p);assert.equal(r.ok,false);assert.ok(r.validation.warnings.some(x=>x.code==='RUNTIME_TUPLE_UNSUPPORTED'));
});
for(const [name,mutate,code] of [
 ['extra raw maximum',c=>{c.forms[0].rawMaximum=62},'CANONICAL_FORM_DEFINITION_INVALID'],
 ['obsolete reserve label',c=>{c.reservePolicy='none-disjoint-full-bank'},'CANONICAL_FORM_RESERVE_POLICY_INVALID'],
 ['missing blueprint',c=>{delete c.skillGroupTargets},'CANONICAL_FORM_BLUEPRINT_INVALID'],
 ['changed domain target',c=>{c.skillGroupTargets.d1=10;c.skillGroupTargets.d4=12},'CANONICAL_FORM_BLUEPRINT_INVALID'],
 ['duplicate member',c=>{c.forms[0].questionIds[1]=c.forms[0].questionIds[0]},'CANONICAL_FORM_DEFINITION_INVALID'],
])test(`existing guard still rejects ${name}`,()=>{const p=syntheticSc100();mutate(p.profiles[0].selection.canonicalForms);assert.ok(codes(p).includes(code));});
test('six disjoint SC100 memberships retain62/63 maxima under the supported shared implementation',()=>{
 const p=syntheticSc100(),byId=new Map(p.questions.map(q=>[q.id,q]));const forms=p.profiles[0].selection.canonicalForms.forms;
 assert.equal(new Set(forms.flatMap(f=>f.questionIds)).size,300);assert.deepEqual(forms.map(f=>f.questionIds.reduce((n,id)=>n+byId.get(id).privateScoring.maximumRawPoints,0)),[62,63,62,63,62,63]);
 const r=classifyRuntimeCompatibility(p.runtime,p.exam.capabilities);assert.deepEqual(r.reasons,[]);assert.equal(p.exam.examKey,'sc100');assert.equal(p.profiles[0].profileKey,'sc100-full');
 for(const tuple of SUPPORTED_RUNTIME_TUPLES)assert.ok(!tuple.generatorVersion.includes('sc100'));
 assert.equal(p.runtime.generatorVersion,'certsim-sc200-canonical-forms-v1');
});
