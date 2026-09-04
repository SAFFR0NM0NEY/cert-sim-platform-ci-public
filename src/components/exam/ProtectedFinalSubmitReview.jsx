import FinalSubmitReviewPresentation from './FinalSubmitReviewPresentation.jsx';

export default function ProtectedFinalSubmitReview({ answers, exam, flaggedQuestionIds, onNavigateToItem, onReturnToExam, onSubmitFinal, questions, remainingSeconds }) {
  const flaggedSet = new Set(flaggedQuestionIds);
  const scoredItems = questions.map((question, questionIndex) => ({ question, questionIndex, answerState: getAnswerState(question, answers[question.id]) })).filter((item) => item.answerState !== 'info');
  const answeredCount = scoredItems.filter((item) => item.answerState === 'answered').length;
  const unansweredCount = scoredItems.filter((item) => item.answerState === 'unanswered').length;
  const incompleteItems = scoredItems.filter((item) => item.answerState === 'incomplete');
  const flaggedCount = scoredItems.filter((item) => flaggedSet.has(item.question.id)).length;
  const incompletePbqCount = scoredItems.filter((item) => String(item.question.type).startsWith('pbq-') && item.answerState !== 'answered').length;
  return <FinalSubmitReviewPresentation examName={exam.name} facts={[{ label: 'Delivery', value: 'Protected exam' }, { label: 'Time remaining', value: formatSeconds(remainingSeconds) }]} hasOpenItems={unansweredCount > 0 || incompleteItems.length > 0 || flaggedCount > 0} hasPbqs={scoredItems.some((item) => String(item.question.type).startsWith('pbq-'))} incompletePbqCount={incompletePbqCount} items={scoredItems.map((item, scoredIndex) => { const flagged = flaggedSet.has(item.question.id); return { answerState: item.answerState, flagged, id: item.question.id, kind: getItemKind(item.question), locked: false, number: item.question.questionNumber ?? scoredIndex + 1, onNavigate: () => onNavigateToItem(item.questionIndex), status: flagged ? 'Flagged' : item.answerState === 'answered' ? 'Answered' : item.answerState === 'incomplete' ? 'Incomplete' : 'Unanswered' }; })} onReturnToExam={onReturnToExam} onSubmitFinal={onSubmitFinal} summary={{ total: scoredItems.length, answered: answeredCount, unanswered: unansweredCount, flagged: flaggedCount, incomplete: incompleteItems.length }} />;
}
function getAnswerState(question, value) {
  if (question.type === 'case-study-info') return 'info';
  if (value == null || value === '') return 'unanswered';
  if (Array.isArray(value)) return value.length ? 'answered' : 'unanswered';
  if (typeof value === 'object') return Object.values(value).some((entry) => entry != null && entry !== '' && (!Array.isArray(entry) || entry.length)) ? 'answered' : 'unanswered';
  return 'answered';
}
function getItemKind(question) {
  if (String(question.type).startsWith('pbq-')) return 'PBQ';
  if (['single-choice', 'multi-select'].includes(question.type)) return 'MCQ';
  return 'Interactive';
}
function formatSeconds(totalSeconds) {
  const safeSeconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  return `${String(Math.floor(safeSeconds / 60)).padStart(2, '0')}:${String(safeSeconds % 60).padStart(2, '0')}`;
}
