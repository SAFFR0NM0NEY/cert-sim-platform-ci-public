import ReorderQuestion from '../exam/ReorderQuestion.jsx';

export default function PBQOrderingLab({ answer = [], lab, onAnswerChange }) {
  const orderingQuestion = {
    id: lab.id,
    items: lab.tasks?.items ?? [],
  };

  function handleOrderChange(_questionId, nextOrder) {
    onAnswerChange?.(nextOrder);
  }

  return (
    <section className="pbq-simulator-panel" aria-label="PBQ ordering lab">
      <div className="pbq-simulator-header">
        <h3>{lab.tasks?.prompt ?? 'Order the response actions'}</h3>
        <p>
          Drag the response actions into the correct order from first to last.
        </p>
      </div>

      <ReorderQuestion
        answer={answer}
        onAnswerChange={handleOrderChange}
        question={orderingQuestion}
      />
    </section>
  );
}
