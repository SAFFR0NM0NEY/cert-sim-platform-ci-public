import { isSupabaseConfigured, supabase } from './supabaseClient.js';

const RESULT_STORAGE_TABLES = {
  examCatalog: 'exam_catalog',
  examAttempts: 'exam_attempts',
  examResponses: 'exam_responses',
  examResults: 'exam_results',
  examReports: 'exam_reports',
  questionReports: 'question_reports',
};

const unavailableResult = {
  ok: false,
  reason: 'supabase_not_configured',
  message: 'Online result storage is not configured for this environment yet.',
};

const signedOutResult = {
  ok: false,
  reason: 'not_signed_in',
  message: 'Sign in before using online result storage.',
};

export async function getExamCatalogEntry(examKey) {
  const authResult = await requireAuthenticatedUser();

  if (!authResult.ok) {
    return authResult;
  }

  const { data, error } = await supabase
    .from(RESULT_STORAGE_TABLES.examCatalog)
    .select('id,exam_key,slug,title,vendor,lifecycle,exam_type,source_type,current_version,status,metadata')
    .eq('exam_key', examKey)
    .maybeSingle();

  return createStorageResult(data, error, 'Could not read the exam catalog entry.');
}

export async function createExamAttempt(attemptPayload = {}) {
  const authResult = await requireAuthenticatedUser();

  if (!authResult.ok) {
    return authResult;
  }

  const row = {
    ...attemptPayload,
    user_id: authResult.user.id,
  };
  const { data, error } = await supabase
    .from(RESULT_STORAGE_TABLES.examAttempts)
    .insert(row)
    .select()
    .single();

  return createStorageResult(data, error, 'Could not create the online attempt record.');
}

export async function saveExamResponses(attemptId, responses = []) {
  const authResult = await requireAuthenticatedUser();

  if (!authResult.ok) {
    return authResult;
  }

  if (!attemptId) {
    return createValidationError('missing_attempt_id', 'Attempt ID is required before saving responses.');
  }

  const rows = responses.map((response) => ({
    ...response,
    attempt_id: attemptId,
  }));

  if (rows.length === 0) {
    return {
      ok: true,
      data: [],
    };
  }

  const { data, error } = await supabase
    .from(RESULT_STORAGE_TABLES.examResponses)
    .insert(rows)
    .select();

  return createStorageResult(data ?? [], error, 'Could not save online response records.');
}

export async function saveExamResult(resultPayload = {}) {
  const authResult = await requireAuthenticatedUser();

  if (!authResult.ok) {
    return authResult;
  }

  const row = {
    ...resultPayload,
    user_id: authResult.user.id,
  };
  const { data, error } = await supabase
    .from(RESULT_STORAGE_TABLES.examResults)
    .insert(row)
    .select()
    .single();

  return createStorageResult(data, error, 'Could not save the online result record.');
}

export async function saveExamReport(reportPayload = {}) {
  const authResult = await requireAuthenticatedUser();

  if (!authResult.ok) {
    return authResult;
  }

  const row = {
    ...reportPayload,
    user_id: authResult.user.id,
  };
  const { data, error } = await supabase
    .from(RESULT_STORAGE_TABLES.examReports)
    .insert(row)
    .select()
    .single();

  return createStorageResult(data, error, 'Could not save the online report record.');
}

export async function submitAttemptStorage(storagePayload = {}) {
  const attemptResult = await createExamAttempt(storagePayload.attempt);

  if (!attemptResult.ok) {
    return attemptResult;
  }

  const attemptId = attemptResult.data.id;
  const responsesResult = await saveExamResponses(attemptId, storagePayload.responses ?? []);

  if (!responsesResult.ok) {
    return responsesResult;
  }

  const resultPayload = storagePayload.result
    ? {
        ...storagePayload.result,
        attempt_id: attemptId,
      }
    : null;
  const reportPayload = storagePayload.report
    ? {
        ...storagePayload.report,
        attempt_id: attemptId,
      }
    : null;
  const result = resultPayload ? await saveExamResult(resultPayload) : { ok: true, data: null };

  if (!result.ok) {
    return result;
  }

  const report = reportPayload ? await saveExamReport(reportPayload) : { ok: true, data: null };

  if (!report.ok) {
    return report;
  }

  return {
    ok: true,
    data: {
      attempt: attemptResult.data,
      responses: responsesResult.data,
      result: result.data,
      report: report.data,
    },
  };
}

export async function createQuestionReport(reportPayload = {}) {
  const authResult = await requireAuthenticatedUser();

  if (!authResult.ok) {
    return authResult;
  }

  const row = {
    ...reportPayload,
    user_id: authResult.user.id,
  };
  const { data, error } = await supabase
    .from(RESULT_STORAGE_TABLES.questionReports)
    .insert(row)
    .select(`
      id,
      exam_key,
      exam_title,
      question_id,
      question_type,
      report_type,
      title,
      message,
      status,
      priority,
      reporter_feedback,
      route_path,
      attempt_id,
      result_id,
      created_at,
      updated_at,
      resolved_at
    `)
    .single();

  return createStorageResult(data, error, 'Could not create the online question report.');
}

async function requireAuthenticatedUser() {
  if (!isSupabaseConfigured || !supabase) {
    return { ...unavailableResult };
  }

  const { data, error } = await supabase.auth.getUser();
  const user = data?.user ?? null;

  if (error) {
    return createSupabaseError(error, 'Could not read the current account.');
  }

  if (!user) {
    return { ...signedOutResult };
  }

  return {
    ok: true,
    user,
  };
}

function createStorageResult(data, error, fallbackMessage) {
  if (error) {
    return createSupabaseError(error, fallbackMessage);
  }

  return {
    ok: true,
    data,
  };
}

function createSupabaseError(error, fallbackMessage) {
  return {
    ok: false,
    reason: 'supabase_error',
    message: error?.message || fallbackMessage,
    errorCode: error?.code,
  };
}

function createValidationError(reason, message) {
  return {
    ok: false,
    reason,
    message,
  };
}
