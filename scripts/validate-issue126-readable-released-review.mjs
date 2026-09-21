import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  resolveReleasedChoiceTexts,
  resolveReleasedDropdownPairs,
  resolveReleasedMatchingPairs,
  resolveReleasedReorderTexts,
  resolveReleasedStructuredPairs,
  resolveReleasedTrueFalse,
} from '../src/lib/releasedAnswerDisplay.js';

const options = [{ id: 'o1', text: 'Option One' }, { id: 'o2', text: 'Option Two' }];
assert.deepEqual(resolveReleasedChoiceTexts({ options }, { answer: 'o1' }, { questionType: 'single-choice' }).texts, ['Option One']);
assert.deepEqual(resolveReleasedChoiceTexts({ options }, { correctAnswers: ['o2', 'o1'] }, { correct: true, questionType: 'multi-select' }).texts, ['Option Two', 'Option One']);

const reorder = { items: [{ id: 'step-a', text: 'Step A' }, { id: 'step-b', text: 'Step B' }] };
assert.deepEqual(resolveReleasedReorderTexts(reorder, { answer: ['step-b', 'step-a'] }, { questionType: 'reorder' }).texts, ['Step B', 'Step A']);
assert.deepEqual(resolveReleasedReorderTexts(reorder, { correctOrder: ['step-a', 'step-b'] }, { correct: true, questionType: 'reorder' }).texts, ['Step A', 'Step B']);
assert.deepEqual(resolveReleasedReorderTexts(reorder, { correctItemIds: ['step-b', 'step-a'] }, { correct: true, questionType: 'reorder' }).texts, ['Step B', 'Step A']);
assert.equal(resolveReleasedReorderTexts(reorder, { answer: ['unknown'] }, { questionType: 'reorder' }).status, 'invalid');
assert.equal(resolveReleasedReorderTexts({ items: [...reorder.items, reorder.items[0]] }, { answer: ['step-a'] }, { questionType: 'reorder' }).status, 'invalid');

const legacyDropdown = { blanks: [
  { id: 'b1', label: 'Blank One', options: ['alpha', 'beta'] },
  { id: 'b2', options: [{ id: 'choice-a', text: 'Choice A' }, { id: 'choice-b', text: 'Choice B' }] },
] };
assert.deepEqual(resolveReleasedDropdownPairs(legacyDropdown, { answer: { b1: 'beta', b2: 'choice-a' } }, { questionType: 'dropdown-code' }).pairs,
  [{ leftText: 'Blank One', rightText: 'beta' }, { leftText: 'Blank 2', rightText: 'Choice A' }]);
assert.deepEqual(resolveReleasedDropdownPairs(legacyDropdown, { blanks: [{ correctAnswer: 'alpha' }, { correctAnswer: 'choice-b' }] }, { correct: true, questionType: 'dropdown-command' }).pairs,
  [{ leftText: 'Blank One', rightText: 'alpha' }, { leftText: 'Blank 2', rightText: 'Choice B' }]);
assert.deepEqual(resolveReleasedDropdownPairs(legacyDropdown, { correctOptionIdsByBlank: { b1: 'beta', b2: 'choice-b' } }, { correct: true, questionType: 'dropdown-code' }).pairs,
  [{ leftText: 'Blank One', rightText: 'beta' }, { leftText: 'Blank 2', rightText: 'Choice B' }]);
assert.equal(resolveReleasedDropdownPairs(legacyDropdown, { answer: { b1: 'unknown' } }, { questionType: 'dropdown-code' }).status, 'invalid');
assert.equal(resolveReleasedDropdownPairs(legacyDropdown, { blanks: [{ correctAnswer: 'alpha' }] }, { correct: true, questionType: 'dropdown-code' }).status, 'invalid');
assert.equal(resolveReleasedDropdownPairs({ blanks: [{ id: 'b1', options: ['same', 'same'] }] }, { answer: { b1: 'same' } }, { questionType: 'dropdown-code' }).status, 'invalid');

assert.deepEqual(resolveReleasedTrueFalse({}, { answer: false }, { questionType: 'true-false-single-v1' }).entries, [{ label: '', text: 'False' }]);
const composite = { statements: [{ id: 's1', text: 'Statement One' }, { id: 's2', text: 'Statement Two' }] };
assert.deepEqual(resolveReleasedTrueFalse(composite, { answer: { s2: true } }, { questionType: 'true-false-composite-v1' }).entries, [{ label: 'Statement Two', text: 'True' }]);

const matching = { sources: [{ id: 's1', text: 'Source One' }], targets: [{ id: 't1', text: 'Target One' }] };
assert.deepEqual(resolveReleasedStructuredPairs(matching, { answer: { s1: 't1' } }, { questionType: 'matching-v1' }).pairs, [{ leftText: 'Source One', rightText: 'Target One' }]);
const structuredDropdown = { blanks: [{ id: 'b1', label: 'Blank One', options }] };
assert.deepEqual(resolveReleasedStructuredPairs(structuredDropdown, { correctOptionIdsByBlank: { b1: 'o2' } }, { correct: true, questionType: 'code-dropdown-completion-v1' }).pairs, [{ leftText: 'Blank One', rightText: 'Option Two' }]);

const drag = { prompts: [{ id: 'p1', text: 'Prompt One' }], options };
assert.deepEqual(resolveReleasedMatchingPairs(drag, { answer: { p1: 'o1' } }, { questionType: 'drag-drop-match' }).pairs, [{ leftText: 'Prompt One', rightText: 'Option One' }]);
assert.equal(resolveReleasedMatchingPairs(drag, { answer: { p1: 'missing' } }, { questionType: 'drag-drop-match' }).status, 'invalid');

for (const [resolver, presentation, value, config] of [
  [resolveReleasedChoiceTexts, {}, { answer: 'opaque' }, { questionType: 'single-choice' }],
  [resolveReleasedReorderTexts, {}, { answer: ['opaque'] }, { questionType: 'reorder' }],
  [resolveReleasedDropdownPairs, {}, { answer: { opaque: 'opaque' } }, { questionType: 'dropdown-code' }],
  [resolveReleasedStructuredPairs, {}, { answer: { opaque: 'opaque' } }, { questionType: 'matching-v1' }],
]) assert.equal(resolver(presentation, value, config).status, 'invalid');
assert.equal(resolveReleasedReorderTexts(reorder, { answer: ['step-a'] }, { questionType: 'unsupported-type' }).status, 'not-applicable');

const component = fs.readFileSync(new URL('../src/components/exam/ReleasedReviewAnswer.jsx', import.meta.url), 'utf8');
const workspace = fs.readFileSync(new URL('../src/components/exam/ReleasedReviewWorkspace.jsx', import.meta.url), 'utf8');
const edge = fs.readFileSync(new URL('../supabase/functions/certsim-protected-exam/responses.ts', import.meta.url), 'utf8');
const pdf = fs.readFileSync(new URL('../src/lib/savedResultReportExport.js', import.meta.url), 'utf8');
assert.match(workspace, /questionType=\{item\.questionType\}/);
assert.match(component, /<ol className="released-answer-list">/);
assert.match(component, /Answer details unavailable/);
assert.match(component, /SUPPORTED_RESPONSE_QUESTION_TYPES/);
assert.match(component, /if \(!SUPPORTED_RESPONSE_QUESTION_TYPES\.has\(type\)\) return 'Answer details unavailable';/);
assert.ok(component.indexOf("if (!SUPPORTED_RESPONSE_QUESTION_TYPES.has(type))") < component.indexOf('resolveReleasedTrueFalse('), 'unsupported types must fail closed before typed resolvers and generic formatting');
assert.doesNotMatch(component, /JSON\.stringify/);
for (const field of ['questionType', 'response', 'correctAnswer']) assert.ok(edge.includes(`"${field}"`), `released DTO omits ${field}`);
assert.match(edge, /presentation:\s*sanitizeQuestionPresentation\(item\.questionType, item\.presentation\)/);
assert.match(pdf, /contains no question text, learner answers, correct answers/);
assert.doesNotMatch(pdf, /resolveReleased(?:Reorder|Dropdown|Structured)/);

console.log('Issue #126 readable released-review answers validated.');
