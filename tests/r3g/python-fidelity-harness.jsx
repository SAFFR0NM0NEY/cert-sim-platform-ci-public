import React from 'react';
import { createRoot } from 'react-dom/client';
import QuestionCard from '../../src/components/exam/QuestionCard.jsx';
import DropdownCodeQuestion from '../../src/components/exam/DropdownCodeQuestion.jsx';
import DropdownCommandQuestion from '../../src/components/exam/DropdownCommandQuestion.jsx';
import ReleasedReviewWorkspace from '../../src/components/exam/ReleasedReviewWorkspace.jsx';
import { toPresentationQuestion } from '../../src/lib/protectedExamContract.js';
import '../../src/styles/global.css';

const code = 'if 2 < 3:\n    # supplied comment\n    for n in [1, 2]:\n\n\tprint("a  b", n)\n  else invalid syntax';
const item = { domain: 'domain-2', itemId: 'synthetic', questionId: 'synthetic-source', questionNumber: 1, questionType: 'single-choice', presentation: { question: code, options: [{ id: 'a', text: code }, { id: 'b', text: 'Ordinary prose stays readable.' }] } };
window.fidelityCode = code;
const parameters = new URLSearchParams(location.search);
const mode = parameters.get('mode');
const fixtures = {
  'long-prose': 'A supplied long prose line ' + 'readable words '.repeat(40) + '\nSecond supplied line',
  'long-code': 'if 2 < 3:\n    # supplied comment\n    for n in [1, 2]:\n\n\tprint("a  b", n)  # ' + 'unchanged long line '.repeat(40) + '\n  else invalid syntax',
  token: 'Unbroken token:\n    ' + 'SyntheticToken'.repeat(80) + '\nEnd supplied token',
  short: code,
  single: 'Ordinary non-Python prose stays readable.',
};
const fixture = parameters.get('fixture');
if (fixture) {
  item.presentation.question = fixtures[fixture];
  item.presentation.options[0].text = fixtures[fixture];
}
if (fixture === 'unbroken-choice') {
  item.presentation.question = 'Synthetic selected-response containment.';
  item.presentation.options = [
    { id: 'a', text: 'https://example.invalid/' + 'syntheticunbrokenresource'.repeat(16) },
    { id: 'b', text: 'Synthetic alternative two.' },
    { id: 'c', text: 'Synthetic alternative three.' },
    { id: 'd', text: 'Synthetic alternative four.' },
  ];
  if (parameters.get('response') === 'multi') {
    item.questionType = 'multi-select';
    item.presentation.selectionLimit = 2;
  }
  window.fidelityOption = item.presentation.options[0].text;
}
window.fidelityFixture = item.presentation.question;
if (mode === 'completion') {
  item.questionType = 'code-dropdown-completion-v1';
  item.presentation.codeTemplate = 'for n in [1, 2]:\n    if n > 0:\n\n\tprint([[value]])\n# ' + 'long supplied line '.repeat(20);
  item.presentation.blanks = [{ id: 'value', options: [{ id: 'n', text: 'n' }] }];
}
if (mode === 'composite') {
  item.questionType = 'true-false-composite-v1';
  item.presentation.statements = [{ id: 'one', text: item.presentation.question }, { id: 'two', text: 'A plain statement.' }];
}
function Harness() {
  const [answer, setAnswer] = React.useState();
  const [returns, setReturns] = React.useState(0);
  if (mode === 'legacy-code' || mode === 'legacy-command') {
    const Component = mode === 'legacy-code' ? DropdownCodeQuestion : DropdownCommandQuestion;
    const question = { id: 'synthetic-legacy', codeTemplate: 'for n in [1, 2]:\n    print({{value}})\n# ' + 'long supplied line '.repeat(20), blanks: [{ id: 'value', options: ['n'] }] };
    return <main className="exam-workspace protected-exam-workspace" style={{ maxWidth: 900, margin: '20px auto' }}><div className="question-card"><Component question={question} answer={answer} onAnswerChange={(_id, value) => setAnswer(value)} /></div></main>;
  }
  const reviewed = { ...item, status: 'correct', response: { answer: 'a' }, ...(fixture ? { correctAnswer: { correctOptionId: 'a' } } : {}) };
  const items = fixture ? [reviewed, { ...reviewed, itemId: 'second-synthetic', questionNumber: 2, presentation: { question: 'Second ordinary non-Python question.', options: [{ id: 'a', text: 'A plain answer.' }] } }] : [reviewed];
  return <main className="exam-workspace protected-exam-workspace" style={{ maxWidth: 900, margin: '20px auto' }}>{mode === 'review' ? <ReleasedReviewWorkspace review={{ items }} onReturn={() => setReturns(n => n + 1)} /> : <QuestionCard domainContext={{examKey:'inf303',packageVersion:parameters.get('version')??'1.3.0'}} question={toPresentationQuestion(item)} answer={answer} onAnswerChange={(_id, value) => setAnswer(value)} />}{returns > 0 && <p role="status">Returned to result summary</p>}</main>;
}
createRoot(document.getElementById('root')).render(<Harness />);
