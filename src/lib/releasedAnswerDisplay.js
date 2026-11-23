const CORRECT_SINGLE_KEYS = ['correctOptionId', 'correctAnswer'];
const CORRECT_MULTIPLE_KEYS = ['correctOptionIds', 'correctAnswers'];
const RELEASED_PBQ_TYPES = new Set([
  'pbq-terminal',
  'pbq-multi-host-terminal',
  'pbq-firewall',
  'pbq-siem',
  'pbq-network-diagram',
  'pbq-config-panel',
  'pbq-hotspot',
  'pbq-drag-drop-match',
  'pbq-ordering',
  'pbq-workspace',
]);

export function resolveReleasedPbqAnswer(presentation, value, { correct = false, questionType } = {}) {
  if (!isPlainObject(presentation)) return pbqResult('invalid');
  const type = resolveQuestionType(presentation, questionType);
  if (!RELEASED_PBQ_TYPES.has(type)) return pbqResult('not-applicable');

  if (isReleasedAnswerUnavailable(value)) return pbqResult('unavailable');

  const contract = createPbqDisplayContract(presentation, type);
  if (contract.status !== 'resolved') return pbqResult('invalid');

  const envelope = correct
    ? readReleasedPbqCorrectAnswer(value)
    : readReleasedPbqResponse(value);
  if (!contract.hasInteraction) {
    return envelope.status === 'empty'
      ? pbqResult('not-applicable')
      : pbqResult('invalid');
  }
  if (envelope.status !== 'resolved') {
    return pbqResult(correct && envelope.status === 'empty' ? 'invalid' : envelope.status);
  }

  const groups = [];
  const answer = envelope.answer;

  if (Object.hasOwn(answer, 'selectedAnswers')) {
    const selected = resolvePbqSelectedAnswers(contract.targets, answer.selectedAnswers);
    if (selected.status === 'invalid') return pbqResult('invalid');
    const pairs = selected.entries.filter((entry) => entry.text);
    const lines = selected.entries.filter((entry) => !entry.text).map((entry) => entry.label);
    if (pairs.length > 0) {
      groups.push({ kind: 'pairs', label: 'Selections', entries: pairs });
    }
    if (lines.length > 0) {
      groups.push({ kind: 'lines', label: 'Selected items', texts: lines });
    }
  }

  if (Object.hasOwn(answer, 'selectedOrder')) {
    const ordered = resolvePbqIds(contract.orderItems, answer.selectedOrder, { unique: true });
    if (ordered.status === 'invalid') return pbqResult('invalid');
    if (ordered.texts.length > 0) {
      groups.push({ kind: 'ordered', label: 'Order', texts: ordered.texts });
    }
  }

  if (Object.hasOwn(answer, 'selectedAnswer')) {
    const selected = resolvePbqSingleAnswer(contract.answerOptions, answer.selectedAnswer);
    if (selected.status === 'invalid') return pbqResult('invalid');
    if (selected.text) {
      groups.push({ kind: 'lines', label: 'Answer', texts: [selected.text] });
    }
  }

  if (Object.hasOwn(answer, 'executedCommands')) {
    const commands = resolvePbqCommands(contract.commands, answer.executedCommands);
    if (commands.status === 'invalid') return pbqResult('invalid');
    if (commands.texts.length > 0) {
      groups.push({ kind: 'ordered', label: correct ? 'Required commands' : 'Commands run', texts: commands.texts });
    }
  }

  if (groups.length === 0) return pbqResult(correct ? 'invalid' : 'empty');
  return { status: 'resolved', groups };
}

export function resolveReleasedChoiceTexts(presentation, value, { correct = false, questionType } = {}) {
  const question = asObject(presentation);
  const type = resolveQuestionType(question, questionType);

  if (!['single-choice', 'multi-select'].includes(type)) {
    return { status: 'not-applicable', texts: [] };
  }

  const options = Array.isArray(question.options) ? question.options : [];
  const optionTextById = new Map();

  for (const option of options) {
    const safeOption = asObject(option);
    const id = typeof safeOption.id === 'string' ? safeOption.id : '';
    const text = typeof safeOption.text === 'string' ? safeOption.text.trim() : '';

    if (!id || !text || optionTextById.has(id)) {
      return { status: 'invalid', texts: [] };
    }

    optionTextById.set(id, text);
  }

  const answer = correct
    ? readCorrectOptionIds(value, type)
    : readResponseOptionIds(value, type);

  if (answer.status !== 'resolved') {
    return answer;
  }

  if (new Set(answer.ids).size !== answer.ids.length) {
    return { status: 'invalid', texts: [] };
  }

  const texts = answer.ids.map((id) => optionTextById.get(id));
  if (texts.some((text) => !text)) {
    return { status: 'invalid', texts: [] };
  }

  return { status: 'resolved', texts };
}

export function resolveReleasedMatchingPairs(presentation, value, { correct = false, questionType } = {}) {
  const question = asObject(presentation);
  if (resolveQuestionType(question, questionType) !== 'drag-drop-match') {
    return { status: 'not-applicable', pairs: [] };
  }

  const prompts = indexIdTextCollection(question.prompts);
  const options = indexIdTextCollection(question.options);
  if (prompts.status !== 'resolved' || options.status !== 'resolved') {
    return { status: 'invalid', pairs: [] };
  }

  const source = asObject(value);
  const rawPairs = correct
    ? source.correctPairs ?? source.correctPairsByPrompt
    : source.answer;

  if (!correct && Object.keys(source).length === 0) return { status: 'empty', pairs: [] };
  if (!rawPairs || typeof rawPairs !== 'object' || Array.isArray(rawPairs)) {
    return { status: 'invalid', pairs: [] };
  }

  const pairEntries = Object.entries(rawPairs);
  if (pairEntries.length === 0) {
    return correct ? { status: 'invalid', pairs: [] } : { status: 'empty', pairs: [] };
  }
  if (new Set(pairEntries.map(([, rightId]) => rightId)).size !== pairEntries.length) {
    return { status: 'invalid', pairs: [] };
  }

  const pairByPromptId = new Map(pairEntries);
  if ([...pairByPromptId.keys()].some((id) => !prompts.textById.has(id)) ||
      [...pairByPromptId.values()].some((id) => typeof id !== 'string' || !options.textById.has(id))) {
    return { status: 'invalid', pairs: [] };
  }

  return {
    status: 'resolved',
    pairs: prompts.ids
      .filter((promptId) => pairByPromptId.has(promptId))
      .map((promptId) => ({
        leftText: prompts.textById.get(promptId),
        rightText: options.textById.get(pairByPromptId.get(promptId)),
      })),
  };
}

export function resolveReleasedTrueFalse(presentation, value, { correct = false, questionType } = {}) {
  const question = asObject(presentation);
  const type = resolveQuestionType(question, questionType);
  if (!['true-false-single-v1', 'true-false-composite-v1'].includes(type)) return { status: 'not-applicable', entries: [] };
  const source = asObject(value);
  if (type === 'true-false-single-v1') {
    const raw = correct ? source.correctValue : source.answer;
    if (raw === undefined && !correct && Object.keys(source).length === 0) return { status: 'empty', entries: [] };
    if (typeof raw !== 'boolean') return { status: 'invalid', entries: [] };
    return { status: 'resolved', entries: [{ label: '', text: raw ? 'True' : 'False' }] };
  }
  const statements = indexIdTextCollection(question.statements);
  if (statements.status !== 'resolved') return { status: 'invalid', entries: [] };
  const answers = correct ? asObject(source.correctValuesByStatement) : asObject(source.answer);
  if (!correct && Object.keys(source).length === 0) return { status: 'empty', entries: [] };
  if (Object.keys(answers).length === 0) return correct ? { status: 'invalid', entries: [] } : { status: 'empty', entries: [] };
  if (Object.keys(answers).some((id) => !statements.textById.has(id)) || Object.values(answers).some((entry) => typeof entry !== 'boolean')) return { status: 'invalid', entries: [] };
  return { status: 'resolved', entries: statements.ids.filter((id) => Object.hasOwn(answers, id)).map((id) => ({ label: statements.textById.get(id), text: answers[id] ? 'True' : 'False' })) };
}

export function resolveReleasedStructuredPairs(presentation, value, { correct = false, questionType } = {}) {
  const question = asObject(presentation);
  const type = resolveQuestionType(question, questionType);
  if (!['matching-v1', 'code-dropdown-completion-v1'].includes(type)) return { status: 'not-applicable', pairs: [] };
  const left = type === 'matching-v1' ? indexIdTextCollection(question.sources) : indexBlankCollection(question.blanks);
  if (left.status !== 'resolved') return { status: 'invalid', pairs: [] };
  const rightByLeft = type === 'matching-v1'
    ? new Map(left.ids.map((id) => [id, indexIdTextCollection(question.targets)]))
    : left.optionIndexes;
  if ([...rightByLeft.values()].some((entry) => entry.status !== 'resolved')) return { status: 'invalid', pairs: [] };
  const source = asObject(value);
  const answers = correct ? asObject(source[type === 'matching-v1' ? 'correctTargetIdsBySource' : 'correctOptionIdsByBlank']) : asObject(source.answer);
  if (!correct && Object.keys(source).length === 0) return { status: 'empty', pairs: [] };
  if (Object.keys(answers).length === 0) return correct ? { status: 'invalid', pairs: [] } : { status: 'empty', pairs: [] };
  if (Object.keys(answers).some((id) => !left.textById.has(id)) || Object.entries(answers).some(([id, answerId]) => typeof answerId !== 'string' || !rightByLeft.get(id)?.textById.has(answerId))) return { status: 'invalid', pairs: [] };
  return { status: 'resolved', pairs: left.ids.filter((id) => Object.hasOwn(answers, id)).map((id) => ({ leftText: left.textById.get(id), rightText: rightByLeft.get(id).textById.get(answers[id]) })) };
}

export function resolveReleasedReorderTexts(presentation, value, { correct = false, questionType } = {}) {
  const question = asObject(presentation);
  if (resolveQuestionType(question, questionType) !== 'reorder') return { status: 'not-applicable', texts: [] };
  const items = indexIdTextCollection(question.items);
  if (items.status !== 'resolved') return { status: 'invalid', texts: [] };
  const source = asObject(value);
  const ids = correct
    ? source.correctOrder ?? source.correctItemIds
    : source.answer;
  if (!correct && Object.keys(source).length === 0) return { status: 'empty', texts: [] };
  if (!Array.isArray(ids) || ids.length === 0) return correct ? { status: 'invalid', texts: [] } : { status: 'empty', texts: [] };
  if (ids.some((id) => typeof id !== 'string' || !items.textById.has(id)) || new Set(ids).size !== ids.length) {
    return { status: 'invalid', texts: [] };
  }
  return { status: 'resolved', texts: ids.map((id) => items.textById.get(id)) };
}

export function resolveReleasedDropdownPairs(presentation, value, { correct = false, questionType } = {}) {
  const question = asObject(presentation);
  const type = resolveQuestionType(question, questionType);
  if (!['dropdown-code', 'dropdown-command'].includes(type)) return { status: 'not-applicable', pairs: [] };
  const blanks = indexLegacyDropdownBlanks(question.blanks);
  if (blanks.status !== 'resolved') return { status: 'invalid', pairs: [] };
  const source = asObject(value);
  let answers;
  if (correct && Array.isArray(source.blanks)) {
    if (source.blanks.length !== blanks.ids.length) return { status: 'invalid', pairs: [] };
    answers = Object.fromEntries(blanks.ids.map((id, index) => [id, asObject(source.blanks[index]).correctAnswer]));
  } else {
    answers = correct ? asObject(source.correctOptionIdsByBlank) : asObject(source.answer);
  }
  if (!correct && Object.keys(source).length === 0) return { status: 'empty', pairs: [] };
  if (Object.keys(answers).length === 0) return correct ? { status: 'invalid', pairs: [] } : { status: 'empty', pairs: [] };
  if (Object.keys(answers).some((id) => !blanks.textById.has(id)) || Object.entries(answers).some(([id, answer]) => !blanks.optionIndexes.get(id)?.has(answer))) {
    return { status: 'invalid', pairs: [] };
  }
  return {
    status: 'resolved',
    pairs: blanks.ids.filter((id) => Object.hasOwn(answers, id)).map((id) => ({
      leftText: blanks.textById.get(id),
      rightText: blanks.optionIndexes.get(id).get(answers[id]),
    })),
  };
}

function indexIdTextCollection(value) {
  if (!Array.isArray(value) || value.length === 0) return { status: 'invalid' };
  const ids = [];
  const textById = new Map();
  for (const entry of value) {
    const item = asObject(entry);
    const id = typeof item.id === 'string' ? item.id : '';
    const text = typeof item.text === 'string' ? item.text.trim() : '';
    if (!id || !text || textById.has(id)) return { status: 'invalid' };
    ids.push(id);
    textById.set(id, text);
  }
  return { status: 'resolved', ids, textById };
}

function indexBlankCollection(value) {
  if (!Array.isArray(value) || value.length === 0) return { status: 'invalid' };
  const ids = [];
  const textById = new Map();
  const optionIndexes = new Map();
  for (const entry of value) {
    const blank = asObject(entry);
    const id = typeof blank.id === 'string' ? blank.id : '';
    const text = typeof blank.label === 'string' ? blank.label.trim() : '';
    const options = indexIdTextCollection(blank.options);
    if (!id || !text || textById.has(id) || options.status !== 'resolved') return { status: 'invalid' };
    ids.push(id); textById.set(id, text); optionIndexes.set(id, options);
  }
  return { status: 'resolved', ids, textById, optionIndexes };
}

function indexLegacyDropdownBlanks(value) {
  if (!Array.isArray(value) || value.length === 0) return { status: 'invalid' };
  const ids = [];
  const textById = new Map();
  const optionIndexes = new Map();
  for (const [index, entry] of value.entries()) {
    const blank = asObject(entry);
    const id = typeof blank.id === 'string' && blank.id ? blank.id : '';
    if (!id || textById.has(id) || !Array.isArray(blank.options) || blank.options.length === 0) return { status: 'invalid' };
    const options = new Map();
    for (const optionEntry of blank.options) {
      const option = asObject(optionEntry);
      const optionId = typeof optionEntry === 'string' ? optionEntry : option.id;
      const optionText = typeof optionEntry === 'string' ? optionEntry.trim() : typeof option.text === 'string' ? option.text.trim() : '';
      if (typeof optionId !== 'string' || !optionId || !optionText || options.has(optionId)) return { status: 'invalid' };
      options.set(optionId, optionText);
    }
    ids.push(id);
    textById.set(id, typeof blank.label === 'string' && blank.label.trim() ? blank.label.trim() : `Blank ${index + 1}`);
    optionIndexes.set(id, options);
  }
  return { status: 'resolved', ids, textById, optionIndexes };
}

function resolveQuestionType(question, explicitType) {
  return String(explicitType ?? question.type ?? question.interactionVersion ?? '').toLowerCase();
}

function readCorrectOptionIds(value, questionType) {
  const source = asObject(value);
  const keys = questionType === 'single-choice' ? CORRECT_SINGLE_KEYS : CORRECT_MULTIPLE_KEYS;
  const key = keys.find((candidate) => Object.hasOwn(source, candidate));
  if (!key) return { status: 'invalid', texts: [] };
  return normalizeIds(source[key], questionType);
}

function readResponseOptionIds(value, questionType) {
  const source = asObject(value);
  if (!Object.hasOwn(source, 'answer')) {
    return Object.keys(source).length === 0
      ? { status: 'empty', texts: [] }
      : { status: 'invalid', texts: [] };
  }
  return normalizeIds(source.answer, questionType);
}

function normalizeIds(value, questionType) {
  const ids = questionType === 'single-choice'
    ? [value]
    : Array.isArray(value) ? value : [];

  if (ids.length === 0 || ids.some((id) => typeof id !== 'string' || !id)) {
    return { status: 'invalid', texts: [] };
  }

  return { status: 'resolved', ids, texts: [] };
}

function createPbqDisplayContract(presentation, type) {
  const tasks = isPlainObject(presentation.tasks) ? presentation.tasks : {};
  const assets = isPlainObject(presentation.assets) ? presentation.assets : {};
  const style = String(tasks.interactionStyle ?? presentation.interactionStyle ?? '');
  const answerOptions = indexPbqOptions(tasks.answerOptions, ['label']);
  if (answerOptions.status === 'invalid') return { status: 'invalid' };

  const targets = createPbqTargetIndex();
  let targetStatus = 'resolved';
  const addTargets = (items, options = {}) => {
    if (targetStatus === 'invalid') return;
    targetStatus = addPbqTargets(targets, items, options).status;
  };

  if (style === 'interactive-topology') {
    addTargets(tasks.commandEvidenceTargets, { allowIdOnlyOptions: true, fixedOptions: [{ id: 'inspected' }] });
    addTargets(tasks.evidenceItems, { allowIdOnlyOptions: true, fixedOptions: [{ id: 'selected' }], globalOptions: tasks.selectionOptions });
    addTargets(tasks.decisionTargets ?? tasks.ruleFields ?? tasks.configurationTargets);
  } else if (style === 'workspace') {
    targetStatus = addWorkspaceTargets(targets, tasks.workspace).status;
  } else if (style === 'practical-sections') {
    targetStatus = addPracticalTargets(targets, tasks.sections).status;
  } else if (type === 'pbq-multi-host-terminal') {
    addTargets(tasks.commandEvidenceTargets, { allowIdOnlyOptions: true, fixedOptions: [{ id: 'inspected' }] });
    addTargets(tasks.decisionTargets);
  } else if (type === 'pbq-firewall') {
    addTargets(tasks.ruleFields);
  } else if (style === 'investigation-review') {
    addTargets(tasks.evidenceItems, { allowIdOnlyOptions: true, fixedOptions: [{ id: 'selected' }], globalOptions: tasks.selectionOptions });
    addTargets(tasks.decisionTargets ?? tasks.configurationTargets, { globalOptions: tasks.decisionOptions });
  } else if (type === 'pbq-config-panel') {
    addTargets(tasks.configurationTargets, { globalOptions: tasks.permissionOptions });
  } else if (type === 'pbq-hotspot' && tasks.evidenceItems !== undefined) {
    addTargets(tasks.evidenceItems, { allowIdOnlyOptions: true, fixedOptions: [{ id: 'selected' }], globalOptions: tasks.selectionOptions });
  } else if (type === 'pbq-drag-drop-match') {
    addTargets(tasks.matchTargets, { globalOptions: tasks.mitigationOptions });
  } else if (type === 'pbq-network-diagram' || type === 'pbq-hotspot') {
    addTargets(
      tasks.classificationTargets ?? tasks.controlPlacementTargets ?? assets.networkNodes,
      { globalOptions: tasks.classificationOptions ?? tasks.controlOptions },
    );
  }
  if (targetStatus === 'invalid') return { status: 'invalid' };

  const orderItems = type === 'pbq-ordering'
    ? indexPbqOptions(tasks.items, ['text'])
    : emptyPbqIndex();
  if (orderItems.status === 'invalid') return { status: 'invalid' };

  const commands = createPbqCommandIndex(presentation, type, style);
  if (commands.status === 'invalid') return { status: 'invalid' };

  const hasInteraction = answerOptions.ids.length > 0 || targets.ids.length > 0 ||
    orderItems.ids.length > 0 || commands.ids.length > 0;
  return {
    status: 'resolved',
    answerOptions,
    targets,
    orderItems,
    commands,
    hasInteraction,
  };
}

function readReleasedPbqResponse(value) {
  if (value === null || value === undefined) return { status: 'empty' };
  if (!isPlainObject(value)) return { status: 'invalid' };
  const keys = Object.keys(value);
  if (keys.length === 0) return { status: 'empty' };
  const allowed = new Set(['selectedAnswer', 'selectedAnswers', 'selectedOrder', 'executedCommands']);
  if (keys.some((key) => !allowed.has(key))) return { status: 'invalid' };
  return { status: 'resolved', answer: value };
}

function readReleasedPbqCorrectAnswer(value) {
  if (!isPlainObject(value)) return { status: 'invalid' };
  const keys = Object.keys(value);
  if (keys.length === 0) return { status: 'empty' };
  const allowed = new Set(['expectedAnswer', 'expectedMap', 'expectedOrder', 'requiredCommandIds']);
  if (keys.some((key) => !allowed.has(key))) return { status: 'invalid' };

  const semanticKeys = ['expectedAnswer', 'expectedMap', 'expectedOrder']
    .filter((key) => Object.hasOwn(value, key));
  if (semanticKeys.length > 1) return { status: 'invalid' };

  const answer = {};
  if (Object.hasOwn(value, 'expectedAnswer')) answer.selectedAnswer = value.expectedAnswer;
  if (Object.hasOwn(value, 'expectedMap')) answer.selectedAnswers = value.expectedMap;
  if (Object.hasOwn(value, 'expectedOrder')) answer.selectedOrder = value.expectedOrder;
  if (Object.hasOwn(value, 'requiredCommandIds')) answer.executedCommands = value.requiredCommandIds;
  return { status: 'resolved', answer };
}

function isReleasedAnswerUnavailable(value) {
  return isPlainObject(value) &&
    Object.keys(value).length === 1 &&
    value.displayUnavailable === true;
}

function createPbqTargetIndex() {
  return { status: 'resolved', ids: [], textById: new Map(), optionTextByTargetId: new Map() };
}

function addPbqTargets(index, value, { allowIdOnlyOptions = false, fixedOptions, globalOptions } = {}) {
  if (value === undefined || value === null) return { status: 'resolved' };
  if (!Array.isArray(value)) return { status: 'invalid' };

  for (const entry of value) {
    if (!isPlainObject(entry)) return { status: 'invalid' };
    const id = nonEmptyString(entry.id);
    const text = firstNonEmptyString(entry, ['label', 'prompt']);
    if (!id || !text || index.textById.has(id)) return { status: 'invalid' };
    const options = indexPbqOptions(
      entry.options ?? globalOptions ?? fixedOptions,
      ['label'],
      { allowMissingText: allowIdOnlyOptions },
    );
    if (options.status !== 'resolved' || options.ids.length === 0) return { status: 'invalid' };
    index.ids.push(id);
    index.textById.set(id, text);
    index.optionTextByTargetId.set(id, options.textById);
  }
  return { status: 'resolved' };
}

function addWorkspaceTargets(index, value) {
  if (value === undefined || value === null) return { status: 'resolved' };
  if (!isPlainObject(value) || !Array.isArray(value.tabs)) return { status: 'invalid' };
  const tabIds = new Set();
  for (const tab of value.tabs) {
    if (!isPlainObject(tab)) return { status: 'invalid' };
    const tabId = nonEmptyString(tab.id);
    if (!tabId || tabIds.has(tabId)) return { status: 'invalid' };
    tabIds.add(tabId);
    const result = addPbqTargets(index, tab.decisions);
    if (result.status === 'invalid') return result;
  }
  return { status: 'resolved' };
}

function addPracticalTargets(index, value) {
  if (value === undefined || value === null) return { status: 'resolved' };
  if (!Array.isArray(value)) return { status: 'invalid' };
  const sectionIds = new Set();
  for (const section of value) {
    if (!isPlainObject(section)) return { status: 'invalid' };
    const sectionId = nonEmptyString(section.id);
    if (!sectionId || sectionIds.has(sectionId)) return { status: 'invalid' };
    sectionIds.add(sectionId);
    const result = addPbqTargets(index, section.targets);
    if (result.status === 'invalid') return result;
  }
  return { status: 'resolved' };
}

function indexPbqOptions(value, textKeys, { allowMissingText = false } = {}) {
  if (value === undefined || value === null) return emptyPbqIndex();
  if (!Array.isArray(value)) return { status: 'invalid' };
  const ids = [];
  const textById = new Map();
  for (const entry of value) {
    if (!isPlainObject(entry)) return { status: 'invalid' };
    const id = nonEmptyString(entry.id);
    const text = firstNonEmptyString(entry, textKeys);
    if (!id || (!text && !allowMissingText) || textById.has(id)) return { status: 'invalid' };
    ids.push(id);
    textById.set(id, text);
  }
  return { status: 'resolved', ids, textById };
}

function createPbqCommandIndex(presentation, type, style) {
  const index = emptyPbqIndex();
  const assets = isPlainObject(presentation.assets) ? presentation.assets : {};
  const labelSourceById = new Map();
  const labelSource = Object.freeze({ fallback: 'fallback', explicit: 'explicit' });
  const addCommand = (id, text, source = labelSource.fallback) => {
    const key = normalizePbqCommandId(id);
    const safeText = nonEmptyString(text);
    if (!key || !safeText) return false;

    if (!index.textById.has(key)) {
      index.ids.push(key);
      index.textById.set(key, safeText);
      labelSourceById.set(key, source);
      return true;
    }

    const existingSource = labelSourceById.get(key);
    const existingText = index.textById.get(key);
    if (existingSource === labelSource.explicit && source === labelSource.explicit) {
      return existingText === safeText;
    }
    if (existingSource === labelSource.fallback && source === labelSource.explicit) {
      index.textById.set(key, safeText);
      labelSourceById.set(key, source);
      return true;
    }
    if (existingSource === labelSource.explicit && source === labelSource.fallback) {
      return true;
    }
    if (normalizePbqCommandId(existingText) !== normalizePbqCommandId(safeText)) return false;
    return true;
  };
  const addRawCommands = (commands) => {
    if (commands === undefined || commands === null) return true;
    if (!Array.isArray(commands)) return false;
    return commands.every((command) => typeof command === 'string' &&
      addCommand(command, command.trim(), labelSource.fallback));
  };
  const addTools = (tools, { deriveCommandFromId = false } = {}) => {
    if (tools === undefined || tools === null) return true;
    if (!Array.isArray(tools)) return false;
    return tools.every((tool) => {
      if (!isPlainObject(tool)) return false;
      const toolId = nonEmptyString(tool.id);
      const command = nonEmptyString(
        tool.command ?? (deriveCommandFromId ? toolId.replace(/-/g, ' ') : toolId),
      );
      const explicitLabel = firstNonEmptyString(tool, ['label']);
      const label = explicitLabel || command;
      const source = explicitLabel ? labelSource.explicit : labelSource.fallback;
      return command && label && addCommand(command, label, source) &&
        (!tool.id || addCommand(tool.id, label, source));
    });
  };
  const addHost = (host) => {
    if (!isPlainObject(host)) return false;
    if (!addRawCommands(host.allowedCommands)) return false;
    if (!addTools(host.tools)) return false;
    if (host.allowedCommands === undefined && host.tools === undefined && host.commandOutputs !== undefined) {
      if (!isPlainObject(host.commandOutputs) || !Object.keys(host.commandOutputs).every((command) =>
        addCommand(command, command, labelSource.fallback))) return false;
    }
    return true;
  };

  if (type === 'pbq-terminal') {
    if (!addRawCommands(presentation.allowedCommands)) return { status: 'invalid' };
    const terminal = isPlainObject(assets.terminal) ? assets.terminal : {};
    if (presentation.allowedCommands === undefined && terminal.commandOutputs !== undefined) {
      if (!isPlainObject(terminal.commandOutputs) || !Object.keys(terminal.commandOutputs).every((command) =>
        addCommand(command, command, labelSource.fallback))) return { status: 'invalid' };
    }
  }

  if (type === 'pbq-multi-host-terminal' || style === 'interactive-topology') {
    const hosts = assets.devices ?? assets.hosts;
    if (hosts !== undefined && (!Array.isArray(hosts) || !hosts.every(addHost))) return { status: 'invalid' };
    if (style === 'interactive-topology' && assets.deviceTools !== undefined) {
      if (!isPlainObject(assets.deviceTools) ||
        !Object.values(assets.deviceTools).every((tools) => addTools(tools, { deriveCommandFromId: true }))) {
        return { status: 'invalid' };
      }
    }
  }
  return index;
}

function resolvePbqSelectedAnswers(targets, value) {
  if (!isPlainObject(value)) return { status: 'invalid', entries: [] };
  const entries = Object.entries(value);
  if (entries.length === 0) return { status: 'resolved', entries: [] };
  if (targets.ids.length === 0 || entries.some(([targetId, optionId]) =>
    !targets.textById.has(targetId) || typeof optionId !== 'string' ||
    !targets.optionTextByTargetId.get(targetId)?.has(optionId))) {
    return { status: 'invalid', entries: [] };
  }
  const selectedByTarget = new Map(entries);
  return {
    status: 'resolved',
    entries: targets.ids
      .filter((id) => selectedByTarget.has(id))
      .map((id) => ({
        label: targets.textById.get(id),
        text: targets.optionTextByTargetId.get(id).get(selectedByTarget.get(id)),
      })),
  };
}

function resolvePbqIds(index, value, { unique = false } = {}) {
  if (!Array.isArray(value)) return { status: 'invalid', texts: [] };
  if (unique && new Set(value).size !== value.length) return { status: 'invalid', texts: [] };
  if (value.some((id) => typeof id !== 'string' || !index.textById.has(id))) {
    return { status: 'invalid', texts: [] };
  }
  return { status: 'resolved', texts: value.map((id) => index.textById.get(id)) };
}

function resolvePbqSingleAnswer(index, value) {
  if (value === '') return { status: 'resolved', text: '' };
  if (typeof value !== 'string' || !index.textById.has(value)) return { status: 'invalid', text: '' };
  return { status: 'resolved', text: index.textById.get(value) };
}

function resolvePbqCommands(index, value) {
  if (!Array.isArray(value)) return { status: 'invalid', texts: [] };
  const keys = value.map(normalizePbqCommandId);
  if (keys.some((key) => !key || !index.textById.has(key))) return { status: 'invalid', texts: [] };
  return { status: 'resolved', texts: keys.map((key) => index.textById.get(key)) };
}

function emptyPbqIndex() {
  return { status: 'resolved', ids: [], textById: new Map() };
}

function pbqResult(status) {
  return { status, groups: [] };
}

function firstNonEmptyString(value, keys) {
  for (const key of keys) {
    const text = nonEmptyString(value?.[key]);
    if (text) return text;
  }
  return '';
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function normalizePbqCommandId(value) {
  return typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ').toLowerCase()
    : '';
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
