import React from 'react';
import { createRoot } from 'react-dom/client';
import ReleasedReviewAnswer from '../../src/components/exam/ReleasedReviewAnswer.jsx';

const mode = new URLSearchParams(window.location.search).get('mode') ?? 'reorder';
const fixtures = {
  reorder: {
    questionType: 'reorder',
    presentation: { items: [{ id: 'step-a', text: 'Step A' }, { id: 'step-b', text: 'Step B' }] },
    response: { answer: ['step-b', 'step-a'] },
    correct: { correctOrder: ['step-a', 'step-b'] },
  },
  dropdown: {
    questionType: 'dropdown-code',
    presentation: { blanks: [{ id: 'blank-a', label: 'Blank One', options: ['alpha', 'beta'] }, { id: 'blank-b', options: [{ id: 'option-a', text: 'Option One' }, { id: 'option-b', text: 'Option Two' }] }] },
    response: { answer: { 'blank-a': 'beta', 'blank-b': 'option-a' } },
    correct: { blanks: [{ correctAnswer: 'alpha' }, { correctAnswer: 'option-b' }] },
  },
  command: {
    questionType: 'dropdown-command',
    presentation: { blanks: [{ id: 'blank-a', label: 'Command argument', options: [{ id: 'option-a', text: '--safe' }, { id: 'option-b', text: '--review' }] }] },
    response: { answer: { 'blank-a': 'option-a' } },
    correct: { correctOptionIdsByBlank: { 'blank-a': 'option-b' } },
  },
  malformed: {
    questionType: 'reorder',
    presentation: { items: [{ id: 'step-a', text: 'Step A' }] },
    response: { answer: ['private-unknown'] },
    correct: { correctOrder: ['step-a'] },
  },
  informational: {
    questionType: 'case-study-context',
    presentation: { heading: 'Safe context' },
    response: {},
    correct: {},
  },
  unsupportedString: {
    questionType: 'unsupported-authoritative-type',
    presentation: {},
    response: 'opaque-private-id',
    correct: 'opaque-private-id',
  },
  unsupportedArray: {
    questionType: 'unsupported-authoritative-type',
    presentation: {},
    response: ['opaque-a', 'opaque-b'],
    correct: ['opaque-a', 'opaque-b'],
  },
  unsupportedObject: {
    questionType: 'unsupported-authoritative-type',
    presentation: {},
    response: { answer: 'opaque-private-id' },
    correct: { answer: 'opaque-private-id' },
  },
  choice: {
    questionType: 'single-choice',
    presentation: { options: [{ id: 'option-a', text: 'Readable answer' }, { id: 'option-b', text: 'Other answer' }] },
    response: { answer: 'option-a' },
    correct: { correctAnswer: 'option-b' },
  },
};

function Harness() {
  const fixture = fixtures[mode];
  return <main><h1>Released review</h1><dl>
    <div><dt>Your response</dt><dd><ReleasedReviewAnswer presentation={fixture.presentation} questionType={fixture.questionType} value={fixture.response} /></dd></div>
    <div><dt>Correct answer</dt><dd><ReleasedReviewAnswer correct presentation={fixture.presentation} questionType={fixture.questionType} value={fixture.correct} /></dd></div>
  </dl></main>;
}

createRoot(document.getElementById('root')).render(<Harness />);
