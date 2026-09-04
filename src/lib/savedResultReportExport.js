import {
  createSavedResultSummaryText,
  formatSavedRawPercentage,
  formatSavedResponseCount,
  formatSavedResultDate,
  formatSavedResultMode,
  formatSavedResultScore,
  formatSavedResultStatus,
  getSavedResultBreakdownRows,
  getSavedResultDomainRows,
  getSavedResultWeakAreaRows,
} from './savedResultFormatters.js';

const PAGE = {
  marginX: 14,
  marginY: 14,
  footerY: 284,
  lineHeight: 5.2,
};

export async function downloadSavedResultSummaryPdf(result = {}) {
  const filename = buildSavedResultFileName(result);
  const writer = await createPdfWriter();
  const domainRows = getSavedResultDomainRows(result);
  const weakAreaRows = getSavedResultWeakAreaRows(result);
  const pbqRows = getSavedResultBreakdownRows(result.pbqBreakdown, 'PBQ');
  const caseStudyRows = getSavedResultBreakdownRows(
    result.caseStudyBreakdown,
    'Case study',
  );

  writer.addTitle('CertSim Platform', 'Saved Result Summary');
  writer.addSection('Saved Attempt Details');
  writer.addFacts([
    ['Exam', result.examTitle ?? 'Not recorded'],
    ['Exam key', result.examKey ?? 'Not recorded'],
    ['Mode/Profile', formatSavedResultMode(result)],
    ['Submitted', formatSavedResultDate(result.submittedAt)],
    ['Report title', result.reportTitle || 'Not recorded'],
    ['Saved responses', formatSavedResponseCount(result.responseCount)],
  ]);

  writer.addSection('Score Summary');
  writer.addFacts([
    ['Score', formatSavedResultScore(result)],
    ['Raw percentage', formatSavedRawPercentage(result)],
    ['Result', formatSavedResultStatus(result)],
  ]);

  writer.addSection('Domain Breakdown');
  writer.addBullets(
    domainRows.map((domain) => `${domain.domain}: ${domain.score}, ${domain.percentage}`),
    'No domain breakdown was stored for this saved result.',
  );

  writer.addSection('Weak Areas');
  writer.addBullets(
    weakAreaRows.map((area) =>
      `${area.label}${area.detail ? `: ${area.detail}` : ''}`,
    ),
    'No stored weak areas below the configured threshold.',
  );

  if (pbqRows.length > 0) {
    writer.addSection('PBQ Breakdown');
    writer.addBullets(
      pbqRows.map((row) =>
        `${row.label}: ${[row.status, row.score].filter(Boolean).join(', ')}`,
      ),
    );
  }

  if (caseStudyRows.length > 0) {
    writer.addSection('Case-Study Breakdown');
    writer.addBullets(
      caseStudyRows.map((row) =>
        `${row.label}: ${[row.status, row.score].filter(Boolean).join(', ')}`,
      ),
    );
  }

  writer.addSection('Saved Summary Text');
  writer.addParagraph(createSavedResultSummaryText(result));
  writer.addSection('Practice Disclaimer');
  writer.addParagraph(
    'Saved history is student self-history only. CertSim practice scores are strict study estimates and are not official certification score predictions.',
  );

  writer.save(filename);
  return { filename };
}

async function createPdfWriter() {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const usableWidth = doc.internal.pageSize.getWidth() - PAGE.marginX * 2;
  let y = PAGE.marginY;

  function ensureSpace(requiredHeight = PAGE.lineHeight * 2) {
    if (y + requiredHeight <= PAGE.footerY) {
      return;
    }

    doc.addPage();
    y = PAGE.marginY;
  }

  function addWrappedText(text, options = {}) {
    const {
      fontSize = 10,
      fontStyle = 'normal',
      indent = 0,
      gapAfter = 2,
    } = options;
    const safeText = cleanText(text);

    if (!safeText) {
      return;
    }

    doc.setFont('helvetica', fontStyle);
    doc.setFontSize(fontSize);

    const lines = doc.splitTextToSize(safeText, usableWidth - indent);
    ensureSpace(lines.length * PAGE.lineHeight + gapAfter);
    doc.text(lines, PAGE.marginX + indent, y);
    y += lines.length * PAGE.lineHeight + gapAfter;
  }

  return {
    addTitle(title, subtitle) {
      doc.setTextColor(15, 23, 42);
      addWrappedText(title, { fontSize: 18, fontStyle: 'bold', gapAfter: 1 });
      addWrappedText(subtitle, { fontSize: 12, fontStyle: 'bold', gapAfter: 4 });
      doc.setDrawColor(96, 165, 250);
      doc.line(PAGE.marginX, y, PAGE.marginX + usableWidth, y);
      y += 5;
    },

    addSection(title) {
      ensureSpace(PAGE.lineHeight * 3);
      y += 1;
      addWrappedText(title, { fontSize: 13, fontStyle: 'bold', gapAfter: 2 });
    },

    addParagraph(text) {
      addWrappedText(text, { fontSize: 9.5, gapAfter: 3 });
    },

    addFacts(facts) {
      facts.forEach(([label, value]) => {
        addWrappedText(`${label}: ${formatValue(value)}`, {
          fontSize: 9.5,
          gapAfter: 1.5,
        });
      });
      y += 1.5;
    },

    addBullets(items, emptyMessage = 'None recorded.') {
      const safeItems = (items ?? []).filter(Boolean);

      if (safeItems.length === 0) {
        addWrappedText(emptyMessage, { fontSize: 9.5, gapAfter: 3 });
        return;
      }

      safeItems.forEach((item) => {
        addWrappedText(`- ${item}`, {
          fontSize: 9.2,
          indent: 2,
          gapAfter: 1.2,
        });
      });
      y += 1.5;
    },

    save(filename) {
      doc.save(filename);
    },
  };
}

function buildSavedResultFileName(result) {
  const examPart = sanitizeFilePart(result.examKey || result.examTitle || 'Result');
  const datePart = formatDateStamp(result.submittedAt || result.savedAt);

  return `CertSim-${examPart}-Saved-Result-${datePart}.pdf`;
}

function formatDateStamp(value) {
  const date = new Date(value ?? Date.now());

  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }

  return date.toISOString().slice(0, 10);
}

function formatValue(value) {
  if (value === null || value === undefined || value === '') {
    return 'Not recorded';
  }

  return cleanText(value);
}

function cleanText(value) {
  if (Array.isArray(value)) {
    return value.map(cleanText).join(', ');
  }

  if (typeof value === 'object' && value !== null) {
    return JSON.stringify(value);
  }

  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/[â€“â€”]/g, '-')
    .replace(/[â€œâ€]/g, '"')
    .replace(/[â€˜â€™]/g, "'")
    .trim();
}

function sanitizeFilePart(value) {
  return String(value ?? '')
    .replace(/\+/g, 'Plus')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}
