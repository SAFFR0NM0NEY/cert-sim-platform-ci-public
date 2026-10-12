const MARGIN = 14;
const FOOTER_Y = 284;
const LINE_HEIGHT = 5.2;

export async function downloadItDirectionResultPdf(result) {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const width = doc.internal.pageSize.getWidth() - MARGIN * 2;
  let y = MARGIN;
  const add = (value, { size = 9.5, style = 'normal', gap = 2 } = {}) => {
    const text = cleanText(value);
    if (!text) return;
    doc.setFont('helvetica', style);
    doc.setFontSize(size);
    const lines = doc.splitTextToSize(text, width);
    if (y + lines.length * LINE_HEIGHT > FOOTER_Y) {
      doc.addPage();
      y = MARGIN;
    }
    doc.text(lines, MARGIN, y);
    y += lines.length * LINE_HEIGHT + gap;
  };
  const fact = (label, value) => add(`${label}: ${value || 'Not recorded'}`);
  const section = (title) => add(title, { size: 13, style: 'bold', gap: 2 });

  add('CertSim Platform', { size: 18, style: 'bold', gap: 1 });
  add('IT Direction Assessment Result', { size: 12, style: 'bold', gap: 4 });
  section('Assessment Summary');
  fact('Assessment', result.assessmentTitle ?? 'IT Direction Assessment');
  fact('Client/student name', result.clientName ?? result.client?.displayName ?? result.studentName ?? result.student?.name);
  fact('Optional contact', result.clientContact ?? result.client?.contact);
  fact('Completed', formatDateTime(result.completedAt));
  fact('Confidence', result.confidence?.label);
  fact('Items answered', `${result.answeredCount ?? 0}/${result.totalItems ?? 0}`);
  fact('Primary path', result.primary?.name);
  fact('Secondary path', result.secondary?.name);
  fact('Third path', result.third?.name ?? 'Not shown');
  section('Why This Path Fits');
  [result.explanation, result.interestReadinessSummary, result.readinessMessage, result.guidanceNote].forEach((value) => add(value));
  section('Recommended Pathways');
  (result.recommendations ?? []).forEach((item, index) => add(`- ${index + 1}. ${item.name}: ${item.description} Starting direction: ${item.courseDirection}`));
  section('Reception Discussion Notes');
  (result.discussionNotes ?? []).forEach((item) => add(`- ${item}`));
  add(result.receptionNote ?? 'Reception can use this result as a conversation starter before advising on study options.');
  section('Pathway Scores');
  (result.pathwayScores ?? []).forEach((item) => add(`- ${item.name}: interest ${item.interest}, knowledge ${item.knowledge}, total ${item.total}`));
  section('Guidance Disclaimer');
  add(result.resultDisclaimer ?? 'This browser-only guidance result is not a pass/fail assessment, career guarantee, or certification result.');
  const filename = `CertSim-IT-Direction-Result-${formatDateStamp(result.completedAt)}.pdf`;
  doc.save(filename);
  return { filename };
}

export async function downloadExamResultPdf() {
  throw new Error('protected_report_unavailable');
}

function formatDateTime(value) {
  const date = new Date(value ?? '');
  return Number.isNaN(date.getTime()) ? 'Not recorded' : date.toLocaleString();
}
function formatDateStamp(value) {
  const date = new Date(value ?? Date.now());
  return (Number.isNaN(date.getTime()) ? new Date() : date).toISOString().slice(0, 10);
}
function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}
