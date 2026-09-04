export function formatSavedResultDate(value) {
  const date = value ? new Date(value) : null;

  if (!date || Number.isNaN(date.getTime())) {
    return 'Date not recorded';
  }

  return date.toLocaleString([], {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function formatSavedResultScore(result = {}) {
  const scaledScore = toNumber(result.scaledScore);
  const rawPercentage = toNumber(result.rawPercentage);

  if (Number.isFinite(scaledScore) && Number.isFinite(rawPercentage)) {
    return `${scaledScore} (${Math.round(rawPercentage)}%)`;
  }

  if (Number.isFinite(scaledScore)) {
    return String(scaledScore);
  }

  if (Number.isFinite(rawPercentage)) {
    return `${Math.round(rawPercentage)}%`;
  }

  return 'Score not recorded';
}

export function formatSavedRawPercentage(result = {}) {
  const rawPercentage = toNumber(result.rawPercentage);

  return Number.isFinite(rawPercentage)
    ? `${Math.round(rawPercentage)}%`
    : 'Raw percentage not recorded';
}

export function formatSavedResultStatus(result = {}) {
  if (result.passed === true) {
    return 'Passed';
  }

  if (result.passed === false) {
    return 'Did not pass';
  }

  return 'Pass/fail not recorded';
}

export function formatSavedResultMode(result = {}) {
  const parts = [result.modeLabel, result.profileLabel]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);

  return [...new Set(parts)].join(' - ') || 'Mode not recorded';
}

export function formatSavedResponseCount(count) {
  const value = Number(count);

  if (!Number.isFinite(value)) {
    return 'Response count not recorded';
  }

  return `${value} saved response${value === 1 ? '' : 's'}`;
}

export function formatSavedDuration(seconds) {
  const value = Number(seconds);

  if (!Number.isFinite(value) || value < 0) {
    return 'Duration not recorded';
  }

  const minutes = Math.floor(value / 60);
  const remainingSeconds = value % 60;

  if (minutes === 0) {
    return `${remainingSeconds} sec`;
  }

  return `${minutes} min ${remainingSeconds} sec`;
}

export function getSavedResultDomainRows(result = {}) {
  const breakdown = result.domainBreakdown ?? result.resultSnapshot?.domainBreakdown;
  const rows = getDomainItems(breakdown);

  if (rows.length === 0) {
    return [];
  }

  return rows
    .filter((domain) => domain?.domainLabel || domain?.domain)
    .map((domain) => ({
      domain: domain.domainLabel ?? domain.domain,
      percentage: Number.isFinite(Number(domain.percentage))
        ? `${Math.round(Number(domain.percentage))}%`
        : 'Not recorded',
      score:
        domain.earnedPoints !== undefined && domain.maxPoints !== undefined
          ? `${domain.earnedPoints}/${domain.maxPoints}`
          : `${domain.correct ?? '-'} / ${domain.total ?? '-'}`,
    }));
}

export function getSavedResultWeakAreaRows(result = {}) {
  if (Array.isArray(result.weakAreas) && result.weakAreas.length > 0) {
    return result.weakAreas
      .map((area) => {
        if (typeof area === 'string') {
          return {
            label: area,
            detail: '',
          };
        }

        return {
          label: area.domainLabel ?? area.domain ?? area.label ?? area.name ?? '',
          detail:
            Number.isFinite(Number(area.percentage))
              ? `${Math.round(Number(area.percentage))}%`
              : area.detail ?? '',
        };
      })
      .filter((area) => area.label);
  }

  return getSavedResultDomainRows(result)
    .filter((domain) => {
      const percentage = Number.parseInt(domain.percentage, 10);
      return Number.isFinite(percentage) && percentage < 70;
    })
    .map((domain) => ({
      label: domain.domain,
      detail: domain.percentage,
    }));
}

export function getSavedResultDomainMissingMessage(result = {}) {
  const breakdown = result.domainBreakdown ?? result.resultSnapshot?.domainBreakdown;

  return breakdown?.missingReason ||
    'Legacy saved result: domain breakdown was not stored for this attempt. Newer eligible saved results include domain breakdowns when available.';
}

export function getSavedResultBreakdownRows(breakdown = {}, fallbackLabel = 'Item') {
  if (!breakdown || typeof breakdown !== 'object' || Array.isArray(breakdown)) {
    return [];
  }

  if (Array.isArray(breakdown.items)) {
    return breakdown.items.map((item, index) => ({
      label: item.questionId ?? item.id ?? `${fallbackLabel} ${index + 1}`,
      status: item.status ?? item.result ?? '',
      score: formatBreakdownScore(item),
    }));
  }

  return Object.entries(breakdown)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => ({
      label: formatObjectKey(key),
      status: typeof value === 'object' ? value.status ?? value.result ?? '' : String(value),
      score: typeof value === 'object' ? formatBreakdownScore(value) : '',
    }));
}

export function createSavedResultSummaryText(result = {}) {
  const weakAreas = getSavedResultWeakAreaRows(result);

  return [
    'CertSim Saved Result Summary',
    `Exam: ${result.examTitle ?? 'Not recorded'}`,
    `Exam key: ${result.examKey ?? 'Not recorded'}`,
    `Mode/Profile: ${formatSavedResultMode(result)}`,
    `Submitted: ${formatSavedResultDate(result.submittedAt)}`,
    `Score: ${formatSavedResultScore(result)}`,
    `Raw percentage: ${formatSavedRawPercentage(result)}`,
    `Result: ${formatSavedResultStatus(result)}`,
    `Saved responses: ${formatSavedResponseCount(result.responseCount)}`,
    `Report: ${result.reportTitle || 'Not recorded'}`,
    weakAreas.length > 0
      ? `Weak areas: ${weakAreas.map((area) => `${area.label}${area.detail ? ` (${area.detail})` : ''}`).join(', ')}`
      : 'Weak areas: None recorded',
    'Note: Saved history is student self-history only and is not an official score prediction.',
  ].join('\n');
}

function formatBreakdownScore(item = {}) {
  if (item.earnedPoints !== undefined && item.maxPoints !== undefined) {
    return `${item.earnedPoints}/${item.maxPoints}`;
  }

  if (item.correct !== undefined && item.total !== undefined) {
    return `${item.correct}/${item.total}`;
  }

  if (item.percentage !== undefined) {
    return `${Math.round(Number(item.percentage))}%`;
  }

  return '';
}

function getDomainItems(breakdown) {
  if (Array.isArray(breakdown)) {
    return breakdown;
  }

  if (!breakdown || typeof breakdown !== 'object') {
    return [];
  }

  if (Array.isArray(breakdown.items)) {
    return breakdown.items;
  }

  return Object.entries(breakdown)
    .filter(([key]) => !['kind', 'source', 'summary', 'missingReason', 'byDomain'].includes(key))
    .map(([domain, value]) =>
      value && typeof value === 'object'
        ? {
            domain,
            ...value,
          }
        : {
            domain,
            percentage: value,
          },
    );
}

function formatObjectKey(value) {
  return String(value)
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function toNumber(value) {
  const number = Number(value);

  return Number.isFinite(number) ? number : NaN;
}
