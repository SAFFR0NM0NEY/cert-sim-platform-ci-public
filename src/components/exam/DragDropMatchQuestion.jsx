import {
  DndContext,
  useDraggable,
  useDroppable,
} from '@dnd-kit/core';

export default function DragDropMatchQuestion({ question, answer, onAnswerChange }) {
  const selectedPairs =
    answer && typeof answer === 'object' && !Array.isArray(answer) ? answer : {};
  const assignedOptionIds = Object.values(selectedPairs).filter(Boolean);
  const availableOptions = question.options.filter(
    (option) => !assignedOptionIds.includes(option.id),
  );
  const optionById = Object.fromEntries(
    question.options.map((option) => [option.id, option]),
  );

  function handleDragEnd(event) {
    const { active, over } = event;

    if (!over) {
      return;
    }

    const optionId = String(active.id).replace('option-', '');
    const nextPairs = { ...selectedPairs };

    Object.keys(nextPairs).forEach((promptId) => {
      if (nextPairs[promptId] === optionId) {
        delete nextPairs[promptId];
      }
    });

    if (String(over.id).startsWith('prompt-')) {
      const promptId = String(over.id).replace('prompt-', '');
      nextPairs[promptId] = optionId;
    }

    onAnswerChange(question.id, nextPairs);
  }

  return (
    <div className="interactive-question">
      <p className="interaction-hint">
        Drag each option into the matching requirement. Each requirement accepts
        one answer.
      </p>
      <DndContext onDragEnd={handleDragEnd}>
        <div className="match-layout">
          <div className="match-prompts">
            {question.prompts.map((prompt) => (
              <PromptDropZone
                key={prompt.id}
                prompt={prompt}
                selectedOption={optionById[selectedPairs[prompt.id]]}
              />
            ))}
          </div>
          <OptionBank options={availableOptions} />
        </div>
      </DndContext>
    </div>
  );
}

function PromptDropZone({ prompt, selectedOption }) {
  const { isOver, setNodeRef } = useDroppable({
    id: `prompt-${prompt.id}`,
  });

  return (
    <div
      className={isOver ? 'match-zone over' : 'match-zone'}
      ref={setNodeRef}
    >
      <strong>{prompt.text}</strong>
      {selectedOption ? (
        <DraggableOption option={selectedOption} compact />
      ) : (
        <span className="empty-zone">Drop answer here</span>
      )}
    </div>
  );
}

function OptionBank({ options }) {
  const { isOver, setNodeRef } = useDroppable({ id: 'option-bank' });

  return (
    <div className={isOver ? 'option-bank over' : 'option-bank'} ref={setNodeRef}>
      <h4>Answer options</h4>
      <div className="draggable-options">
        {options.length === 0 ? (
          <p className="empty-zone">All options are placed.</p>
        ) : (
          options.map((option) => (
            <DraggableOption key={option.id} option={option} />
          ))
        )}
      </div>
    </div>
  );
}

function DraggableOption({ option, compact = false }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({
      id: `option-${option.id}`,
    });

  const style = transform
    ? {
        transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
      }
    : undefined;

  return (
    <button
      className={[
        'draggable-option',
        compact ? 'compact' : '',
        isDragging ? 'dragging' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      ref={setNodeRef}
      style={style}
      type="button"
      {...listeners}
      {...attributes}
    >
      {option.text}
    </button>
  );
}
