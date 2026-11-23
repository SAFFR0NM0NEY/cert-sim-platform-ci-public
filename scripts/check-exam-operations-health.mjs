import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stderr, stdout } from 'node:process';

import { buildExamOperationsCurrentState } from './backend-exam-publication/exam-operations-current-state.mjs';
import {
  createExamOperationsHealth,
  formatExamOperationsHealthReport,
} from './backend-exam-publication/exam-operations-health.mjs';
import { assertSanitizedExamOperationsOutput } from './backend-exam-publication/exam-operations-output-safety.mjs';
import { readProductionExamOperationsState } from './exam-operations/read-production-state.mjs';

try {
  const args = parseArgs(process.argv.slice(2));
  const rawState = await readProductionExamOperationsState(args.examKey);
  const currentBuild = buildExamOperationsCurrentState(rawState, args.examKey);
  const health = createExamOperationsHealth(currentBuild);
  const document = {
    mode: 'read-only-exam-health',
    currentState: currentBuild.snapshot,
    health,
    productionMutations: 0,
  };
  assertSanitizedExamOperationsOutput(document);
  if (args.output) {
    await writeFile(args.output, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'w',
    });
  }
  stdout.write(args.json
    ? `${JSON.stringify(document)}\n`
    : `${formatExamOperationsHealthReport(health)}\n`);
  process.exitCode = health.overallHealth === 'BLOCKED' ? 1 : 0;
} catch (error) {
  stderr.write(`${safeCliError(error)}\n`);
  process.exitCode = 1;
}

function parseArgs(values) {
  const flags = new Set(values.filter((value) => value === '--json'));
  const allowedPrefixes = new Set(['--exam-key=', '--output=']);
  if (values.some((value) => value !== '--json'
      && ![...allowedPrefixes].some((prefix) => value.startsWith(prefix)))) {
    throw new Error('EXAMOPS_ARGUMENT_INVALID');
  }
  const examKey = singleValue(values, '--exam-key=', true);
  const outputValue = singleValue(values, '--output=');
  return {
    examKey,
    output: outputValue ? path.resolve(outputValue) : null,
    json: flags.has('--json'),
  };
}

function singleValue(values, prefix, required = false) {
  const matches = values.filter((value) => value.startsWith(prefix));
  if (matches.length > 1 || (required && matches.length !== 1)) {
    throw new Error('EXAMOPS_ARGUMENT_INVALID');
  }
  const value = matches[0]?.slice(prefix.length).trim() ?? '';
  if (required && !value) throw new Error('EXAMOPS_ARGUMENT_INVALID');
  return value || null;
}

function safeCliError(error) {
  const code = typeof error?.message === 'string'
    ? error.message.match(/^[A-Z][A-Z0-9_]+/)?.[0]
    : null;
  return /^[A-Z][A-Z0-9_]{2,79}$/.test(code ?? '')
    ? code
    : 'EXAMOPS_HEALTH_FAILED';
}
