const PROHIBITED_KEYS = new Set([
  'actorid',
  'answer',
  'answerkey',
  'answers',
  'assignmenttarget',
  'assignmenttargetid',
  'attemptid',
  'correctanswer',
  'correctanswers',
  'email',
  'emails',
  'formid',
  'formkey',
  'formmemberid',
  'formmemberids',
  'gradingmaterial',
  'hiddentest',
  'hiddentests',
  'learnerid',
  'memberid',
  'modelsolution',
  'option',
  'optionid',
  'optionids',
  'options',
  'ownerid',
  'packageprofileid',
  'packageversionid',
  'privateauthoringmetadata',
  'privatestate',
  'prompt',
  'questionid',
  'questionids',
  'questiontext',
  'responsepayload',
  'rubric',
  'scoringkey',
  'scoringkeys',
  'scoringrules',
  'stem',
  'studentuserid',
  'userid',
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function assertSanitizedExamOperationsOutput(value) {
  walk(value, '$');
  return true;
}

function walk(value, path) {
  if (typeof value === 'string') {
    if (UUID_PATTERN.test(value) || EMAIL_PATTERN.test(value)) {
      throw new Error(`EXAMOPS_SENSITIVE_VALUE_REJECTED [${path}]`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walk(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;

  for (const [key, entry] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (PROHIBITED_KEYS.has(normalized)) {
      throw new Error(`EXAMOPS_PROTECTED_FIELD_REJECTED [${path}.${key}]`);
    }
    walk(entry, `${path}.${key}`);
  }
}
