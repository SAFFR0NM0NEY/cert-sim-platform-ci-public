import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createProtectedResultSummaryPdfArtifact } from '../src/lib/savedResultReportExport.js';

const savedPage = await readFile(new URL('../src/protected/ProtectedSavedResultsPage.jsx', import.meta.url), 'utf8');
const runner = await readFile(new URL('../src/components/exam/ProtectedExamRunner.jsx', import.meta.url), 'utf8');
const client = await readFile(new URL('../src/lib/protectedExamClient.js', import.meta.url), 'utf8');
const mapper = await readFile(new URL('../supabase/functions/certsim-protected-exam/responses.ts', import.meta.url), 'utf8');

for (const source of [savedPage, runner]) {
  assert.match(source, /downloadProtectedResultSummaryPdf/);
  assert.match(source, /Download PDF/);
  assert.match(source, /Preparing PDF/);
  assert.match(source, /PDF download failed/);
}
assert.match(savedPage, /Print result summary/);
assert.match(client, /getPrintableSummary:.*print-summary/);
assert.match(mapper, /mapPrintSummary[\s\S]*domainSummary[\s\S]*reviewStatus[\s\S]*source/);

for (const examKey of ['ai901', 'az204', 'securityplussy0701', 'az400', 'sc200']) {
  for (const reviewStatus of ['released', 'withheld']) {
    const artifact = await createProtectedResultSummaryPdfArtifact({
      exam: { key: examKey, version: examKey === 'sc200' ? '1.1.0' : '1.0.0' },
      profile: { key: `${examKey}-full`, name: 'Full' },
      purpose: 'self_directed_exam', completedAt: '2026-09-08T08:00:00.000Z',
      score: 17.5, percentage: 87.5, passed: true,
      domainSummary: { implementation: { domainLabel: 'Implementation', earnedPoints: 7.5, maxPoints: 10, percentage: 75 } },
      completionStatus: 'completed', serverAuthoritative: true, reviewStatus, source: 'protected',
      questionText: 'SECRET_QUESTION_TEXT', correctAnswer: 'SECRET_CORRECT_ANSWER',
      learnerAnswer: 'SECRET_LEARNER_ANSWER', explanation: 'SECRET_EXPLANATION',
      scoringKey: 'SECRET_SCORING_KEY', optionIds: ['SECRET_OPTION_ID'],
      presentationSnapshot: { value: 'SECRET_PRESENTATION_SNAPSHOT' },
    });
    assert.equal(new TextDecoder().decode(artifact.bytes.slice(0, 5)), '%PDF-');
    assert.ok(artifact.bytes.byteLength > 1500);
    assert.match(artifact.filename, /^CertSim-[A-Za-z0-9-]+-Saved-Result-2026-09-08\.pdf$/);
    const binary = Buffer.from(artifact.bytes).toString('latin1');
    assert.match(binary, new RegExp(`Exam key: ${examKey}`));
    assert.match(binary, /Authoritative Score Summary/);
    assert.match(binary, /Percentage: 87\.5%/);
    assert.doesNotMatch(binary, /SECRET_(?:QUESTION|CORRECT|LEARNER|EXPLANATION|SCORING|OPTION|PRESENTATION)/);
  }
}
await assert.rejects(createProtectedResultSummaryPdfArtifact({ source: 'protected', serverAuthoritative: false }), /untrusted_protected_result_summary/);
const historical = await createProtectedResultSummaryPdfArtifact({
  exam: { key: 'az204', version: 'legacy' }, profile: { key: 'legacy', name: 'Legacy' },
  purpose: 'self_directed_exam', completedAt: '2025-01-02T08:00:00.000Z', score: 42,
  percentage: 70, passed: false, domainSummary: {}, completionStatus: 'submitted',
  serverAuthoritative: false, reviewStatus: 'withheld', source: 'legacy_authoritative',
});
assert.equal(new TextDecoder().decode(historical.bytes.slice(0, 5)), '%PDF-');
assert.match(Buffer.from(historical.bytes).toString('latin1'), /No domain breakdown recorded/);
console.log('Issue #102 protected result PDF validation passed.');
