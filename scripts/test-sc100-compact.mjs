import test from 'node:test';import assert from 'node:assert/strict';
import {syntheticSc100,syntheticSc100Compact} from './sc100-compatibility/synthetic-fixture.mjs';
import {validateExamOperationsCandidate} from './backend-exam-publication/exam-operations-candidate.mjs';
import {sha256Canonical as sha} from './backend-exam-publication/canonical-json.mjs';
const errors=p=>validateExamOperationsCandidate(p).validation.errors.map(e=>e.code);
test('SC100 successor preserves Full and scoring while adding six uniform-target Compact forms',()=>{
 const old=syntheticSc100(),p=syntheticSc100Compact();assert.equal(sha(p.questions),sha(old.questions));assert.equal(sha(p.profiles[0]),sha(old.profiles[0]));
 assert.equal(p.profiles[1].questionCount,25);assert.equal(p.profiles[1].timeLimitMinutes,50);
 const byId=new Map(p.questions.map(q=>[q.id,q])),c=p.profiles[1].selection.canonicalForms,forms=c.forms;
 assert.equal(Object.hasOwn(c,'skillGroupTargetsByForm'),false);
 assert.equal(new Set(forms.flatMap(f=>f.questionIds)).size,150);
 assert.deepEqual(forms.map(f=>f.questionIds.reduce((s,id)=>s+byId.get(id).privateScoring.maximumRawPoints,0)),Array(6).fill(31));
 assert.deepEqual(errors(p),[]);
});
test('effective current publisher does not support the removed historical override field',()=>{const p=syntheticSc100Compact();p.profiles[1].selection.canonicalForms.skillGroupTargetsByForm={};assert.ok(errors(p).includes('CANONICAL_FORM_CONTRACT_INVALID'));});
for(const [label,mutate] of [
 ['wrong actual domain targets',c=>{c.skillGroupTargets={d1:5,d2:7,d3:7,d4:6};}],
 ['wrong domain total',c=>{c.skillGroupTargets.d1=5;}],
 ['unknown domain',c=>{c.skillGroupTargets={d1:6,d2:7,d3:7,bogus:5};}],
 ['wrong question count',c=>{c.questionCount=24;}],
 ['unknown metadata',c=>{c.extra=true;}],
])test(`Compact contract rejects ${label}`,()=>{const p=syntheticSc100Compact();mutate(p.profiles[1].selection.canonicalForms);assert.ok(errors(p).length>0);});
test('existing Full fixed contract remains valid',()=>assert.deepEqual(errors(syntheticSc100()),[]));