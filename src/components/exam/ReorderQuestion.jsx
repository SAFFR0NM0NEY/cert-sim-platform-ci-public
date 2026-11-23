import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

export default function ReorderQuestion({ question, answer, onAnswerChange }) {
  const sensors = useSensors(useSensor(PointerSensor));
  const order = Array.isArray(answer) && answer.length > 0
    ? answer
    : question.items.map((item) => item.id);
  const itemById = Object.fromEntries(
    question.items.map((item) => [item.id, item]),
  );

  function handleDragEnd(event) {
    const { active, over } = event;

    if (!over || active.id === over.id) {
      return;
    }

    const oldIndex = order.indexOf(active.id);
    const newIndex = order.indexOf(over.id);
    const nextOrder = arrayMove(order, oldIndex, newIndex);
    onAnswerChange(question.id, nextOrder);
  }

  return (
    <div className="interactive-question">
      <p className="interaction-hint">
        Drag the steps into the correct order from top to bottom.
      </p>
      <DndContext
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
        sensors={sensors}
      >
        <SortableContext items={order} strategy={verticalListSortingStrategy}>
          <ol className="sortable-list">
            {order.map((itemId, index) => (
              <SortableStep
                index={index}
                item={itemById[itemId]}
                key={itemId}
              />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
    </div>
  );
}

function SortableStep({ item, index }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <li
      className={isDragging ? 'sortable-step dragging' : 'sortable-step'}
      ref={setNodeRef}
      style={style}
    >
      <span className="step-number">{index + 1}</span>
      <button
        className="drag-handle"
        type="button"
        {...attributes}
        {...listeners}
      >
        Drag
      </button>
      <span>{item.text}</span>
    </li>
  );
}
