import React from 'react';
import { createRoot } from 'react-dom/client';
import ReleasedReviewAnswer from '../../src/components/exam/ReleasedReviewAnswer.jsx';
import '../../src/styles/global.css';

const mode = new URLSearchParams(window.location.search).get('mode') ?? 'correct';
const presentation = { type: 'drag-drop-match', prompts: [{ id: 'left-a', text: 'Detect objects in an image' }, { id: 'left-b', text: 'Extract text from a document' }], options: [{ id: 'right-y', text: 'Document Intelligence' }, { id: 'right-x', text: 'Azure AI Vision' }] };
const responses = { correct: { answer: { 'left-a': 'right-x', 'left-b': 'right-y' } }, incorrect: { answer: { 'left-a': 'right-y', 'left-b': 'right-x' } }, malformed: { answer: { 'left-a': 'unknown-right' } } };
function Harness() {
  if (mode === 'withheld') return <p role="status">Question review and answers are withheld for this attempt.</p>;
  return <main><h1>Released question review</h1><dl><div><dt>Your response</dt><dd><ReleasedReviewAnswer presentation={presentation} value={responses[mode]} /></dd></div><div><dt>Correct answer</dt><dd><ReleasedReviewAnswer correct presentation={presentation} value={{ correctPairs: { 'left-a': 'right-x', 'left-b': 'right-y' } }} /></dd></div></dl></main>;
}
createRoot(document.getElementById('root')).render(<Harness />);
