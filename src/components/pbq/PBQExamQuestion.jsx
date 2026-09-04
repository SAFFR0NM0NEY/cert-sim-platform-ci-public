import ConfigPanelLab from './ConfigPanelLab.jsx';
import EvidenceSelectionLab from './EvidenceSelectionLab.jsx';
import FirewallRuleSimulator from './FirewallRuleSimulator.jsx';
import InteractiveInvestigationLab from './InteractiveInvestigationLab.jsx';
import InteractiveTopologyLab from './InteractiveTopologyLab.jsx';
import MultiHostTerminalLab from './MultiHostTerminalLab.jsx';
import NetworkDiagramLab from './NetworkDiagramLab.jsx';
import PBQMatchingLab from './PBQMatchingLab.jsx';
import PBQOrderingLab from './PBQOrderingLab.jsx';
import PracticalPBQLab from './PracticalPBQLab.jsx';
import SimulatedTerminal from './SimulatedTerminal.jsx';
import SIEMLogViewer from './SIEMLogViewer.jsx';
import WorkspacePBQLab from './WorkspacePBQLab.jsx';

export default function PBQExamQuestion({
  answer,
  hideTrainingLabels = false,
  lab,
  onAnswerChange,
}) {
  const selectedAnswer = answer ?? lab.initialState?.selectedAnswer ?? '';
  const selectedOptionAnswer = getTerminalSelectedAnswer(selectedAnswer);
  const isWorkspaceLab = getInteractionStyle(lab) === 'workspace';

  function updateAnswer(nextAnswer) {
    onAnswerChange?.(lab.id, nextAnswer);
  }

  function handleAnswerOptionChange(optionId) {
    if (lab.type === 'pbq-terminal') {
      updateAnswer({
        ...createTerminalAnswerState(selectedAnswer),
        selectedAnswer: optionId,
      });
      return;
    }

    updateAnswer(optionId);
  }

  return (
    <article className="question-card pbq-exam-question">
      <div className="question-meta">
        <span>{isWorkspaceLab ? 'Workspace PBQ' : 'Performance-based question'}</span>
        {!hideTrainingLabels && <span>{lab.difficulty}</span>}
      </div>
      {!hideTrainingLabels && <p className="domain-label">{lab.domain}</p>}
      <h3>{lab.title}</h3>
      {isWorkspaceLab ? (
        <p className="pbq-preview-compact-note">
          Use the simulated workspace panels to review the scenario, inspect
          evidence, and configure your answer.
        </p>
      ) : (
        <>
          <p>{lab.scenario}</p>

          <section className="pbq-instructions" aria-label="PBQ instructions">
            <h4>Instructions</h4>
            <ul>
              {lab.instructions.map((instruction) => (
                <li key={instruction}>{instruction}</li>
              ))}
            </ul>
          </section>
        </>
      )}

      <PBQExamSurface
        answer={selectedAnswer}
        lab={lab}
        onAnswerChange={updateAnswer}
      />

      {lab.tasks?.answerOptions?.length > 0 && (
        <section className="pbq-answer-panel" aria-label="PBQ answer choices">
          <h4>{lab.tasks.prompt}</h4>
          <div className="option-list">
            {lab.tasks.answerOptions.map((option) => (
              <label className="option-row" key={option.id}>
                <input
                  type="radio"
                  name={`${lab.id}-answer`}
                  checked={selectedOptionAnswer === option.id}
                  onChange={() => handleAnswerOptionChange(option.id)}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </section>
      )}

      <p className="pbq-safety-note">{lab.safetyNote}</p>
    </article>
  );
}

function getInteractionStyle(lab) {
  return lab?.tasks?.interactionStyle ?? lab?.interactionStyle ?? '';
}

function PBQExamSurface({ answer, lab, onAnswerChange }) {
  if (lab.type === 'pbq-terminal') {
    const terminalAnswer = createTerminalAnswerState(answer);

    function handleTerminalStateChange(nextTerminalState) {
      const currentAnswer = createTerminalAnswerState(answer);

      onAnswerChange({
        ...currentAnswer,
        selectedAnswer:
          nextTerminalState.action === 'reset' ? '' : currentAnswer.selectedAnswer,
        commandHistory: nextTerminalState.commandHistory,
        executedCommands:
          nextTerminalState.action === 'reset'
            ? []
            : nextTerminalState.scoredCommand
              ? [...currentAnswer.executedCommands, nextTerminalState.scoredCommand]
              : currentAnswer.executedCommands,
        terminalTranscript: nextTerminalState.terminalTranscript,
      });
    }

    function handleCommandReset() {
      onAnswerChange(createTerminalAnswerState(''));
    }

    return (
      <SimulatedTerminal
        commandHistory={terminalAnswer.commandHistory}
        lab={lab}
        onCommandReset={handleCommandReset}
        onTerminalStateChange={handleTerminalStateChange}
        terminalTranscript={terminalAnswer.terminalTranscript}
      />
    );
  }

  if ((lab.tasks?.interactionStyle ?? lab.interactionStyle) === 'interactive-topology') {
    return (
      <InteractiveTopologyLab
        answer={answer}
        lab={lab}
        onAnswerChange={onAnswerChange}
      />
    );
  }

  if ((lab.tasks?.interactionStyle ?? lab.interactionStyle) === 'workspace') {
    return (
      <WorkspacePBQLab
        answer={answer}
        lab={lab}
        onAnswerChange={onAnswerChange}
      />
    );
  }

  if ((lab.tasks?.interactionStyle ?? lab.interactionStyle) === 'practical-sections') {
    return (
      <PracticalPBQLab
        answer={answer}
        lab={lab}
        onAnswerChange={onAnswerChange}
      />
    );
  }

  if (lab.type === 'pbq-multi-host-terminal') {
    return (
      <MultiHostTerminalLab
        answer={answer}
        lab={lab}
        onAnswerChange={onAnswerChange}
      />
    );
  }

  if (lab.type === 'pbq-firewall') {
    return (
      <FirewallRuleSimulator
        answer={answer}
        lab={lab}
        onAnswerChange={onAnswerChange}
      />
    );
  }

  if (lab.tasks?.interactionStyle === 'investigation-review') {
    return (
      <InteractiveInvestigationLab
        answer={answer}
        lab={lab}
        onAnswerChange={onAnswerChange}
      />
    );
  }

  if (lab.type === 'pbq-ordering') {
    return (
      <PBQOrderingLab
        answer={Array.isArray(answer) ? answer : lab.initialState?.selectedAnswer}
        lab={lab}
        onAnswerChange={onAnswerChange}
      />
    );
  }

  if (lab.type === 'pbq-config-panel') {
    return (
      <ConfigPanelLab
        answer={answer}
        lab={lab}
        onAnswerChange={onAnswerChange}
      />
    );
  }

  if (lab.type === 'pbq-hotspot' && lab.tasks?.evidenceItems) {
    return (
      <EvidenceSelectionLab
        answer={answer}
        lab={lab}
        onAnswerChange={onAnswerChange}
      />
    );
  }

  if (lab.type === 'pbq-drag-drop-match') {
    return (
      <PBQMatchingLab
        answer={answer}
        lab={lab}
        onAnswerChange={onAnswerChange}
      />
    );
  }

  if (lab.type === 'pbq-siem') {
    return <SIEMLogViewer lab={lab} />;
  }

  if (lab.type === 'pbq-network-diagram' || lab.type === 'pbq-hotspot') {
    return (
      <NetworkDiagramLab
        answer={answer}
        lab={lab}
        onAnswerChange={onAnswerChange}
      />
    );
  }

  return (
    <section className="pbq-simulator-panel">
      <h3>{lab.type} scaffold</h3>
      <p>This PBQ type is reserved for future original Security+ labs.</p>
    </section>
  );
}

function createTerminalAnswerState(answer) {
  if (answer && typeof answer === 'object' && !Array.isArray(answer)) {
    return {
      selectedAnswer: answer.selectedAnswer ?? '',
      commandHistory: Array.isArray(answer.commandHistory)
        ? answer.commandHistory
        : [],
      executedCommands: Array.isArray(answer.executedCommands)
        ? answer.executedCommands
        : [],
      terminalTranscript: Array.isArray(answer.terminalTranscript)
        ? answer.terminalTranscript
        : null,
    };
  }

  return {
    selectedAnswer: answer ?? '',
    commandHistory: [],
    executedCommands: [],
    terminalTranscript: null,
  };
}

function getTerminalSelectedAnswer(answer) {
  if (answer && typeof answer === 'object' && !Array.isArray(answer)) {
    return answer.selectedAnswer ?? '';
  }

  return answer ?? '';
}
