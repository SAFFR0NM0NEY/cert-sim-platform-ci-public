import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveReleasedMatchingPairs } from '../src/lib/releasedAnswerDisplay.js';

const prompts = [{ id: 'left-a', text: 'Detect objects in an image' }, { id: 'left-b', text: 'Extract text from a document' }];
const options = [{ id: 'right-y', text: 'Document Intelligence' }, { id: 'right-x', text: 'Azure AI Vision' }];
const presentation = { type: 'drag-drop-match', prompts, options };
const response = { answer: { 'left-a': 'right-x', 'left-b': 'right-y' } };
const expected = [{ leftText: 'Detect objects in an image', rightText: 'Azure AI Vision' }, { leftText: 'Extract text from a document', rightText: 'Document Intelligence' }];

assert.deepEqual(resolveReleasedMatchingPairs(presentation, response).pairs, expected);
assert.deepEqual(resolveReleasedMatchingPairs(presentation, { correctPairs: response.answer }, { correct: true }).pairs, expected);
assert.equal(resolveReleasedMatchingPairs(presentation, { answer: { 'left-a': 'right-y', 'left-b': 'right-x' } }).status, 'resolved');
assert.deepEqual(resolveReleasedMatchingPairs(presentation, { answer: { 'left-b': 'right-y' } }).pairs, [expected[1]]);
assert.deepEqual(resolveReleasedMatchingPairs({ ...presentation, options: [...options].reverse() }, response).pairs, expected);
for (const stage of ['immediate', 'refresh', 'history', 'saved-results', 'assignment-review']) assert.deepEqual(resolveReleasedMatchingPairs(presentation, JSON.parse(JSON.stringify(response))).pairs, expected, stage);
assert.equal(resolveReleasedMatchingPairs(presentation, { answer: {} }).status, 'empty');
assert.equal(resolveReleasedMatchingPairs(presentation, { answer: { missing: 'right-x' } }).status, 'invalid');
assert.equal(resolveReleasedMatchingPairs(presentation, { answer: { 'left-a': 'missing' } }).status, 'invalid');
assert.equal(resolveReleasedMatchingPairs({ ...presentation, prompts: [...prompts, prompts[0]] }, response).status, 'invalid');
assert.equal(resolveReleasedMatchingPairs({ ...presentation, options: [...options, options[0]] }, response).status, 'invalid');
assert.equal(resolveReleasedMatchingPairs(presentation, { answer: { 'left-a': 'right-x', 'left-b': 'right-x' } }).status, 'invalid');

const component = fs.readFileSync(new URL('../src/components/exam/ReleasedReviewAnswer.jsx', import.meta.url), 'utf8');
const runner = fs.readFileSync(new URL('../src/components/exam/ProtectedExamRunner.jsx', import.meta.url), 'utf8');
const workspace = fs.readFileSync(new URL('../src/components/exam/ReleasedReviewWorkspace.jsx', import.meta.url), 'utf8');
const pdf = fs.readFileSync(new URL('../src/lib/savedResultReportExport.js', import.meta.url), 'utf8');
assert.match(component, /resolveReleasedMatchingPairs/);
assert.match(component, /released-matching-pairs/);
assert.match(component, /Answer details unavailable/);
assert.match(component, /No response recorded/);
assert.doesNotMatch(component, /JSON\.stringify/);
assert.match(runner, /reviewWithheld &&/);
assert.match(runner, /reviewReleased && <button[^>]+>View released review/);
assert.match(workspace, /<ReleasedReviewAnswer/);
assert.doesNotMatch(pdf, /correctPairs|ReleasedReviewAnswer/);
console.log('Issue #113 readable matching review validation passed.');
