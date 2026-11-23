import { isSupabaseConfigured, supabase } from './supabaseClient.js';

export const PLACEMENT_STATUSES = [
  { value: 'new', label: 'New' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'enrolled', label: 'Enrolled' },
  { value: 'not_interested', label: 'Not interested' },
  { value: 'archived', label: 'Archived' },
];

const unavailableMessage =
  'Placement result storage needs Supabase configuration.';

const signedOutMessage =
  'Sign in with a reception, scoped admin, Developer, or Platform Owner account to view placement results.';

export async function savePlacementAssessmentResult(result = {}) {
  if (!isSupabaseConfigured || !supabase) {
    return createErrorResult('supabase_not_configured', unavailableMessage);
  }

  const client = result.client ?? {};
  const { firstName, lastName } = splitClientName(
    result.clientName || client.displayName,
  );
  const contact = cleanText(result.clientContact || client.contact);
  const { data, error } = await supabase.rpc(
    'save_placement_assessment_result',
    {
      target_assessment_key: 'it-direction',
      target_intake_first_name: firstName || 'Not recorded',
      target_intake_last_name: cleanText(client.surname) || lastName,
      target_intake_contact: contact,
      target_intake_email: extractEmail(contact),
      target_result_summary: buildResultSummary(result),
      target_recommended_pathway: result.primary?.name ?? '',
      target_secondary_pathways: buildSecondaryPathways(result),
      target_pathway_scores: buildPathwayScores(result),
      target_response_summary: buildResponseSummary(result),
    },
  );

  return createServiceResult(
    normalizeSavedPlacementResult(data),
    error,
    'Your result was generated, but it could not be saved for follow-up.',
  );
}

export async function getReceptionPlacementResults() {
  const authResult = await requireSignedInPlacementDashboard();

  if (!authResult.ok) {
    return authResult;
  }

  const { data, error } = await supabase.rpc(
    'get_reception_placement_results',
  );

  return createServiceResult(
    Array.isArray(data) ? data.map(normalizePlacementResultRow) : [],
    error,
    'Could not load placement results.',
  );
}

export async function updatePlacementAssessmentResult({
  resultId,
  status,
  receptionNotes,
} = {}) {
  const authResult = await requireSignedInPlacementDashboard();

  if (!authResult.ok) {
    return authResult;
  }

  const { data, error } = await supabase.rpc(
    'update_placement_assessment_result',
    {
      target_result_id: cleanText(resultId),
      target_status: cleanText(status) || 'new',
      target_reception_notes: cleanText(receptionNotes),
    },
  );

  return createServiceResult(
    normalizePlacementResultRow(data),
    error,
    'Could not update the placement result.',
  );
}

async function requireSignedInPlacementDashboard() {
  if (!isSupabaseConfigured || !supabase) {
    return createErrorResult('supabase_not_configured', unavailableMessage);
  }

  const { data, error } = await supabase.auth.getUser();

  if (error) {
    return createErrorResult(
      'auth_error',
      'Could not confirm the signed-in account.',
      error,
    );
  }

  if (!data?.user) {
    return createErrorResult('not_signed_in', signedOutMessage);
  }

  return createOkResult(data.user);
}

function normalizeSavedPlacementResult(data) {
  const row = Array.isArray(data) ? data[0] : data;

  if (!row) {
    return null;
  }

  return {
    id: row.id ?? '',
    createdAt: row.created_at ?? '',
    message: row.message ?? 'Placement result saved for follow-up.',
  };
}

function normalizePlacementResultRow(row = {}) {
  return {
    id: row.id ?? '',
    assessmentKey: row.assessment_key ?? 'it-direction',
    profileId: row.profile_id ?? '',
    organisationId: row.organisation_id ?? '',
    campusId: row.campus_id ?? '',
    organisationName: row.organisation_name ?? '',
    campusName: row.campus_name ?? '',
    firstName: row.intake_first_name ?? '',
    lastName: row.intake_last_name ?? '',
    contact: row.intake_contact ?? '',
    email: row.intake_email ?? '',
    resultSummary: row.result_summary ?? '',
    recommendedPathway: row.recommended_pathway ?? '',
    secondaryPathways: normalizeJsonArray(row.secondary_pathways),
    pathwayScores: normalizeJsonArray(row.pathway_scores),
    responseSummary: normalizeJsonObject(row.response_summary),
    status: row.status ?? 'new',
    receptionNotes: row.reception_notes ?? '',
    reviewedBy: row.reviewed_by ?? '',
    reviewedByName: row.reviewed_by_name ?? '',
    reviewedAt: row.reviewed_at ?? '',
    createdAt: row.created_at ?? '',
    updatedAt: row.updated_at ?? '',
  };
}

function buildResultSummary(result = {}) {
  const primary = result.primary?.name ?? 'Not recorded';
  const confidence = result.confidence?.label ?? 'Not recorded';
  const readiness = result.readinessMessage ?? '';

  return [
    `Primary pathway: ${primary}`,
    `Confidence: ${confidence}`,
    readiness,
  ]
    .filter(Boolean)
    .join('\n');
}

function buildSecondaryPathways(result = {}) {
  return (result.recommendations ?? [])
    .slice(1)
    .map((pathway) => ({
      id: pathway.id,
      name: pathway.name,
      total: pathway.total,
      interest: pathway.interest,
      knowledge: pathway.knowledge,
    }));
}

function buildPathwayScores(result = {}) {
  return (result.pathwayScores ?? []).map((pathway) => ({
    id: pathway.id,
    name: pathway.name,
    total: pathway.total,
    interest: pathway.interest,
    knowledge: pathway.knowledge,
  }));
}

function buildResponseSummary(result = {}) {
  return {
    answeredCount: result.answeredCount ?? 0,
    totalItems: result.totalItems ?? 0,
    confidenceLabel: result.confidence?.label ?? '',
    explanation: result.explanation ?? '',
    interestReadinessSummary: result.interestReadinessSummary ?? '',
    readinessMessage: result.readinessMessage ?? '',
    discussionNotes: result.discussionNotes ?? [],
    resultDisclaimer: result.resultDisclaimer ?? '',
    receptionNote: result.receptionNote ?? '',
  };
}

function splitClientName(value = '') {
  const parts = cleanText(value).split(/\s+/).filter(Boolean);

  return {
    firstName: parts[0] ?? '',
    lastName: parts.slice(1).join(' '),
  };
}

function extractEmail(value = '') {
  const match = cleanText(value).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);

  return match ? match[0].toLowerCase() : '';
}

function normalizeJsonArray(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);

      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  return [];
}

function normalizeJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);

      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed
        : {};
    } catch {
      return {};
    }
  }

  return {};
}

function cleanText(value) {
  return String(value ?? '').trim();
}

function createServiceResult(data, error, fallbackMessage) {
  if (error) {
    return createErrorResult('service_error', error.message || fallbackMessage, error);
  }

  return createOkResult(data);
}

function createOkResult(data) {
  return {
    ok: true,
    data,
    error: null,
    message: '',
  };
}

function createErrorResult(reason, message, error = null) {
  return {
    ok: false,
    data: null,
    error,
    reason,
    message,
  };
}
