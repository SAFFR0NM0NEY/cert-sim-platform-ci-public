import React from 'react';
import { createRoot } from 'react-dom/client';
import ReleasedReviewAnswer from '../../src/components/exam/ReleasedReviewAnswer.jsx';

const mode = new URLSearchParams(window.location.search).get('mode') ?? 'composite';
const fixtures = {
  single: { presentation: { type: 'true-false-single-v1', statementId: 'private-statement', prompt: 'Python is dynamically typed.' }, response: { answer: true }, correct: { correctValue: true } },
  composite: { presentation: { type: 'true-false-composite-v1', statements: [{ id: 's2', text: 'Tuples are immutable.' }, { id: 's1', text: 'Lists are immutable.' }] }, response: { answer: { s1: false, s2: true } }, correct: { correctValuesByStatement: { s1: false, s2: true } } },
  matching: { presentation: { type: 'matching-v1', sources: [{ id: 'source-b', text: 'Immutable sequence' }, { id: 'source-a', text: 'Mutable sequence' }], targets: [{ id: 'target-a', text: 'list' }, { id: 'target-b', text: 'tuple' }] }, response: { answer: { 'source-a': 'target-a', 'source-b': 'target-b' } }, correct: { correctTargetIdsBySource: { 'source-a': 'target-a', 'source-b': 'target-b' } } },
  code: { presentation: { type: 'code-dropdown-completion-v1', blanks: [{ id: 'blank-a', label: 'Function name', options: [{ id: 'option-b', text: 'input' }, { id: 'option-a', text: 'print' }] }] }, response: { answer: { 'blank-a': 'option-a' } }, correct: { correctOptionIdsByBlank: { 'blank-a': 'option-a' } } },
  malformed: { presentation: { type: 'matching-v1', sources: [{ id: 'source-a', text: 'Mutable sequence' }], targets: [{ id: 'target-a', text: 'list' }] }, response: { answer: { 'source-a': 'unknown-target' } }, correct: { correctTargetIdsBySource: { 'source-a': 'target-a' } } },
};

function Harness() {
  if (mode === 'withheld') return <p role="status">Question review and answers are withheld for this attempt.</p>;
  const fixture = fixtures[mode];
  return <main><h1>Released Python Standard review</h1><dl><div><dt>Your response</dt><dd><ReleasedReviewAnswer presentation={fixture.presentation} value={fixture.response} /></dd></div><div><dt>Correct answer</dt><dd><ReleasedReviewAnswer correct presentation={fixture.presentation} value={fixture.correct} /></dd></div></dl></main>;
}

createRoot(document.getElementById('root')).render(<Harness />);
