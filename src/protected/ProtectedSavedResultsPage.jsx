import { useEffect, useMemo, useRef, useState } from 'react';
import { examRegistry, liveVisibleExamConfigs } from '../exams/examRegistry.js';
import { getAttemptHistory } from '../utils/attemptHistory.js';
import { createProtectedExamClient, getProtectedReasonMessage } from '../lib/protectedExamClient.js';
import { appendUniqueHistory } from '../lib/historyPagination.js';
import { getAttemptKindLabel, isAssessmentResult } from '../lib/attemptPurpose.js';
import { loadAllProtectedHistory, loadProtectedHistoryPage } from '../lib/protectedHistory.js';
import { selectCurrentWeakAreaProfile } from '../lib/weakAreaProfileSelection.js';
import {
  getSavedResultExamFilterOptions,
  getSavedResultExamLabel,
} from '../lib/savedResultExamIdentity.js';
import { downloadProtectedResultSummaryPdf } from '../lib/savedResultReportExport.js';
import { buildWeakAreaPracticeRequest } from '../lib/protectedPracticeRequest.js';
import { PROTECTED_LANGUAGE_PREFERENCES } from '../lib/protectedExamContract.js';
import { CODING_LANGUAGE_OPTIONS } from '../utils/codingLanguage.js';
import ReleasedReviewWorkspace from '../components/exam/ReleasedReviewWorkspace.jsx';

export default function ProtectedSavedResultsPage({ attemptId, codingLanguagePreference, onBackHome, onCodingLanguagePreferenceChange, onOpenAccount, onOpenDetail, onReturnHome, onReturnToList, session, openWeakAreaPractice = false, weakAreaPracticeExamId = '', onStartWeakAreaPractice }) {
  const client = useMemo(() => session?.access_token ? createProtectedExamClient({ accessToken: session.access_token }) : null, [session?.access_token]);
  if (attemptId) return <ProtectedResultDetail attemptId={attemptId} client={client} onBack={onReturnToList} />;
  return <ProtectedResultList client={client} codingLanguagePreference={codingLanguagePreference} onBack={onReturnHome ?? onBackHome} onCodingLanguagePreferenceChange={onCodingLanguagePreferenceChange} onOpenAccount={onOpenAccount} onOpenDetail={onOpenDetail} openWeakAreaPractice={openWeakAreaPractice} weakAreaPracticeExamId={weakAreaPracticeExamId} onStartWeakAreaPractice={onStartWeakAreaPractice} />;
}

function ProtectedResultList({ client, codingLanguagePreference, onBack, onCodingLanguagePreferenceChange, onOpenAccount, onOpenDetail, openWeakAreaPractice, weakAreaPracticeExamId, onStartWeakAreaPractice }) {
  const historical = useMemo(() => examRegistry.flatMap((exam) => getAttemptHistory(exam.id).records.map((record) => ({ ...record, registryExamId: exam.id }))), []);
  const examFilterOptions = useMemo(() => getSavedResultExamFilterOptions(liveVisibleExamConfigs), []);
  const [remote, setRemote] = useState({ state: 'loading', items: [], message: '', nextCursor: null, totalCount: null });
  const [range, setRange] = useState('recent');
  const [examFilter, setExamFilter] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [practiceResults, setPracticeResults] = useState([]);
  const [practiceLoading, setPracticeLoading] = useState(false);
  const [focusOpen, setFocusOpen] = useState(openWeakAreaPractice);
  const historyRequestRef = useRef(0);
  const visibleItems = range === 'recent' ? remote.items.slice(0, 10) : remote.items;
  useEffect(() => {
    const requestId = ++historyRequestRef.current;
    const controller = new AbortController();
    if (!client) return () => controller.abort();
    setRemote({ state: 'loading', items: [], message: '', nextCursor: null, totalCount: null });
    loadProtectedHistoryPage(client, { examKey: examFilter || undefined, pageSize: 20, signal: controller.signal })
      .then((page) => { if (requestId === historyRequestRef.current) setRemote({ state: page.items.length ? 'ready' : 'empty', items: page.items, totalCount: page.totalCount, nextCursor: page.nextCursor, message: page.items.length ? '' : 'No account results match this filter.' }); })
      .catch((error) => { if (!controller.signal.aborted && requestId === historyRequestRef.current) setRemote({ state: 'error', items: [], message: error.message || 'Account history could not be loaded.', nextCursor: null, totalCount: null }); });
    return () => { historyRequestRef.current += 1; controller.abort(); };
  }, [client, examFilter]);
  useEffect(() => setFocusOpen(openWeakAreaPractice), [openWeakAreaPractice]);
  useEffect(() => {
    const controller = new AbortController();
    if (!client || !focusOpen) return () => controller.abort();
    setPracticeLoading(true);
    loadAllProtectedHistory(client, { signal: controller.signal })
      .then((history) => { setPracticeResults(history.items); setPracticeLoading(false); })
      .catch(() => { if (!controller.signal.aborted) setPracticeLoading(false); });
    return () => controller.abort();
  }, [client, focusOpen]);
  async function loadMore() {
    if (!client || !remote.nextCursor || loadingMore) return;
    const requestId = historyRequestRef.current;
    setLoadingMore(true);
    try {
      const page = await loadProtectedHistoryPage(client, { cursor: remote.nextCursor, examKey: examFilter || undefined, pageSize: 20 });
      if (requestId !== historyRequestRef.current) return;
      setRemote((current) => ({ ...current, state: 'ready', items: appendUniqueHistory(current.items, page.items), totalCount: page.totalCount, nextCursor: page.nextCursor, message: '' }));
    } catch (error) {
      if (requestId === historyRequestRef.current) setRemote((current) => ({ ...current, message: error.message || 'More results could not be loaded.' }));
    } finally { if (requestId === historyRequestRef.current) setLoadingMore(false); }
  }
  if (!client) return <section className="form-panel" aria-labelledby="protected-results-heading"><p className="eyebrow">Saved Results</p><h2 id="protected-results-heading">Sign in to view Saved Results</h2><p>Your protected assessment and practice history is available after you sign in. Weak Area Practice also requires completed signed-in assessments.</p><div className="button-row wrap"><button className="primary-button" type="button" onClick={onOpenAccount}>Go to Account</button>{onBack ? <button className="secondary-button" type="button" onClick={onBack}>Return home</button> : null}</div></section>;
  return <section className="form-panel" aria-labelledby="protected-results-heading">
    <p className="eyebrow">Account history</p><h2 id="protected-results-heading">Saved Results</h2>
    <p>Assessments and practice are labelled separately. Older activity whose purpose cannot be confirmed remains visible and does not affect readiness.</p>
    <section className="saved-focus-practice">
      <div className="saved-results-header"><div><p className="eyebrow">Focus Practice</p><h3>Weak Area Practice</h3><p>Practise an automatically identified weak domain from completed assessments.</p></div><button className="secondary-button compact-button" type="button" aria-expanded={focusOpen} onClick={() => setFocusOpen((value) => !value)}>{focusOpen ? 'Hide configuration' : 'Configure practice'}</button></div>
      {focusOpen ? <ProtectedWeakAreaPractice client={client} codingLanguagePreference={codingLanguagePreference} initialExamId={weakAreaPracticeExamId} results={practiceResults} loading={practiceLoading} onCodingLanguagePreferenceChange={onCodingLanguagePreferenceChange} onStart={onStartWeakAreaPractice} /> : null}
    </section>
    <h3>Account results</h3>
    <div className="saved-attempt-toolbar no-print"><label><span>Range</span><select value={range} onChange={(event) => setRange(event.target.value)}><option value="recent">Recent results</option><option value="all">All Time</option></select></label><label><span>Exam</span><select value={examFilter} onChange={(event) => setExamFilter(event.target.value)}><option value="">All exams</option>{examFilterOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><strong>{range === 'all' ? 'All Time' : 'Recent results · latest 10'}{Number.isInteger(remote.totalCount) ? ` · ${remote.items.length} of ${remote.totalCount} loaded` : ''}</strong></div>
    {remote.state === 'loading' ? <p role="status">Loading account history…</p> : null}
    {remote.message ? <p role={remote.state === 'error' ? 'alert' : 'status'}>{remote.message}</p> : null}
    {visibleItems.length ? <ul className="history-list">{visibleItems.map((item) => <li key={item.attemptId}><button type="button" className="saved-result-item" onClick={() => onOpenDetail?.(item.attemptId)}><strong>{getSavedResultExamLabel(item.examKey)}</strong>{' '}<span>{item.percentage}% · {getAttemptKindLabel(item)} · {item.source === 'legacy_authoritative' ? 'Historical account result' : 'Saved result'} · {new Date(item.completedAt).toLocaleString()}</span></button></li>)}</ul> : null}
    {range === 'all' && remote.nextCursor ? <div className="saved-pagination"><button type="button" disabled={loadingMore} onClick={loadMore}>{loadingMore ? 'Loading more…' : 'Load more results'}</button><span>{remote.items.length} of {remote.totalCount} loaded</span></div> : null}
    <h3>Historical browser-only results</h3><p>Browser-only records remain separate from authenticated server history; they are not uploaded or combined with protected scores.</p>
    {historical.length === 0 ? <p>No browser-only results were found.</p> : <ul className="history-list">{historical.map((record) => <li key={record.id}><strong>{getSavedResultExamLabel(record.registryExamId)}</strong>{' '}<span>{record.percentage}% · Historical browser result · {new Date(record.attemptedAt).toLocaleString()}</span></li>)}</ul>}
    {onBack ? <button type="button" className="primary-button" onClick={onBack}>Return home</button> : null}
  </section>;
}

function ProtectedWeakAreaPractice({ client, codingLanguagePreference, initialExamId, loading, onCodingLanguagePreferenceChange, onStart, results }) {
  const assessments = useMemo(() => results.filter(isAssessmentResult), [results]);
  const exams = useMemo(() => examRegistry.filter((exam) => assessments.some((item) => normalizeExamKey(item.examKey) === normalizeExamKey(exam.id))), [assessments]);
  const [examId, setExamId] = useState(initialExamId);
  const [profileId, setProfileId] = useState('');
  const [domain, setDomain] = useState('');
  const [count, setCount] = useState(20);
  const [mixStrategy, setMixStrategy] = useState('balanced');
  const [includePbqs, setIncludePbqs] = useState(true);
  const [weakAreaOptions, setWeakAreaOptions] = useState({ state: 'idle', key: '', domains: [], message: '' });
  const [availability, setAvailability] = useState({ state: 'idle', value: null, message: '' });
  useEffect(() => { if (!exams.some((exam) => exam.id === examId)) setExamId(exams.find((exam) => exam.id === initialExamId)?.id ?? exams[0]?.id ?? ''); }, [examId, exams, initialExamId]);
  const examResults = useMemo(() => assessments.filter((item) => normalizeExamKey(item.examKey) === normalizeExamKey(examId)), [assessments, examId]);
  const currentExam = useMemo(() => exams.find((exam) => exam.id === examId) ?? null, [examId, exams]);
  const currentProfiles = currentExam?.strictBetaProfiles ?? [];
  const latest = examResults[0];
  useEffect(() => {
    if (!currentProfiles.some((profile) => profile.id === profileId)) {
      setProfileId(selectCurrentWeakAreaProfile(currentProfiles, latest?.profileKey));
    }
  }, [currentProfiles, latest?.profileKey, profileId]);
  const discoveryKey = examId && profileId ? `${examId}|${profileId}` : '';
  useEffect(() => {
    const controller = new AbortController();
    if (!client || !discoveryKey) {
      setWeakAreaOptions({ state: 'idle', key: '', domains: [], message: '' });
      return () => controller.abort();
    }
    setWeakAreaOptions({ state: 'loading', key: discoveryKey, domains: [], message: '' });
    client.getWeakAreaOptions(examId, profileId, { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setWeakAreaOptions({ state: 'ready', key: discoveryKey, domains: value.domains, message: '' });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setWeakAreaOptions({ state: 'error', key: discoveryKey, domains: [], message: error.message || 'Weak Area Practice is not available.' });
      });
    return () => controller.abort();
  }, [client, discoveryKey, examId, profileId]);
  const weakDomains = weakAreaOptions.key === discoveryKey && weakAreaOptions.state === 'ready'
    ? weakAreaOptions.domains
    : [];
  useEffect(() => {
    if (!weakDomains.some((item) => item.domainKey === domain)) setDomain(weakDomains[0]?.domainKey ?? '');
  }, [domain, weakDomains]);
  const practiceConfiguration = useMemo(() => {
    if (!weakDomains.some((item) => item.domainKey === domain)) return { value: null, error: null };
    try {
      return { value: buildWeakAreaPracticeRequest({ examKey: examId, profileId, domain, questionCount: count, purpose: 'weak_area', includePbqs, mixStrategy, language: codingLanguagePreference }), error: null };
    } catch (error) {
      return { value: null, error };
    }
  }, [codingLanguagePreference, count, domain, examId, includePbqs, mixStrategy, profileId, weakDomains]);
  useEffect(() => {
    const controller = new AbortController();
    if (!client || !profileId || !domain || weakAreaOptions.state !== 'ready' || weakAreaOptions.key !== discoveryKey) { setAvailability({ state: 'idle', value: null, message: '' }); return () => controller.abort(); }
    if (practiceConfiguration.error) { setAvailability({ state: 'error', value: null, message: practiceConfiguration.error.message }); return () => controller.abort(); }
    setAvailability({ state: 'loading', value: null, message: '' });
    client.getPracticeAvailability(practiceConfiguration.value, { signal: controller.signal })
      .then((value) => setAvailability({ state: 'ready', value, message: '' }))
      .catch((error) => { if (!controller.signal.aborted) setAvailability({ state: 'error', value: null, message: error.message || 'Weak Area Practice is not available.' }); });
    return () => controller.abort();
  }, [client, discoveryKey, domain, practiceConfiguration, profileId, weakAreaOptions.key, weakAreaOptions.state]);
  if (loading) return <p role="status">Reading completed assessment evidence…</p>;
  if (!exams.length) return <p role="status">{getProtectedReasonMessage('no_weak_areas')}</p>;
  return <div className="weak-area-practice-panel">
    <div className="weak-area-configuration-grid">
      <label><span>Exam</span><select value={examId} onChange={(event) => setExamId(event.target.value)}>{exams.map((exam) => <option key={exam.id} value={exam.id}>{exam.shortName}</option>)}</select></label>
      <label><span>Practice profile</span><select value={profileId} onChange={(event) => setProfileId(event.target.value)}>{currentProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
      {weakDomains.length ? <label><span>Weak domain</span><select value={domain} onChange={(event) => setDomain(event.target.value)}>{weakDomains.map((item) => <option key={item.domainKey} value={item.domainKey}>{item.domainKey} · {Math.round(item.lowestPercentage)}%</option>)}</select></label> : null}
      {weakDomains.length ? <label><span>Question count</span><select value={count} onChange={(event) => setCount(Number(event.target.value))}>{[10,20,30,40].map((value) => <option key={value} value={value}>{value}</option>)}</select></label> : null}
      {weakDomains.length ? <label><span>Question mix</span><select value={mixStrategy} onChange={(event) => setMixStrategy(event.target.value)}><option value="missed-heavy">Review Missed First</option><option value="balanced">Balanced Mix</option><option value="new-heavy">New Questions First</option></select></label> : null}
      {currentExam?.id === 'az204' ? <label><span>Language</span><select value={PROTECTED_LANGUAGE_PREFERENCES.includes(codingLanguagePreference) ? codingLanguagePreference : ''} onChange={(event) => onCodingLanguagePreferenceChange?.(event.target.value)}><option value="" disabled>Select a language</option>{CODING_LANGUAGE_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label> : null}
      {weakDomains.length ? <label className="weak-area-pbq-control"><input type="checkbox" checked={includePbqs} onChange={(event) => setIncludePbqs(event.target.checked)} /><span className="weak-area-toggle-track" aria-hidden="true" /><span className="weak-area-toggle-copy"><strong>Include PBQs</strong><small>when eligible</small></span></label> : null}
    </div>
    <p>Weak domains use earned points divided by available points from completed assigned or self-directed assessments. “First” controls priority; the backend may adjust the mix when eligible content is limited.</p>
    {weakAreaOptions.state === 'loading' ? <p role="status">Checking eligible weak areas…</p> : null}
    {weakAreaOptions.state === 'ready' && !weakDomains.length ? <p role="status">{getProtectedReasonMessage('no_weak_areas')}</p> : null}
    {weakAreaOptions.state === 'error' ? <p role="alert">{weakAreaOptions.message}</p> : null}
    {availability.state === 'loading' ? <p role="status">Checking eligible practice content…</p> : null}
    {availability.message ? <p role="alert">{availability.message}</p> : null}
    {availability.value ? <p>{availability.value.selectedCount} question{availability.value.selectedCount === 1 ? '' : 's'} selected from {availability.value.available} eligible items{availability.value.adjustedCount ? ' after a safe availability adjustment' : ''}. Completing this practice does not affect formal readiness or exam-attempt totals.</p> : null}
    <button className="primary-button" type="button" disabled={!availability.value?.selectedCount || !practiceConfiguration.value} onClick={() => onStart?.(practiceConfiguration.value)}>Start Weak Area Practice</button>
  </div>;
}

export function ProtectedResultDetail({ attemptId, client, onBack }) {
  const [detail, setDetail] = useState({ state: 'loading', value: null, message: '' });
  const [pdf, setPdf] = useState({ preparing: false, message: '', error: '' });
  const [releasedReview, setReleasedReview] = useState({ state: 'idle', value: null, message: '', open: false });
  const reviewControllerRef = useRef(null);
  useEffect(() => {
    const controller = new AbortController();
    if (!client) { setDetail({ state: 'signed-out', value: null, message: 'Sign in to open this result.' }); return () => controller.abort(); }
    client.getPrintableSummary(attemptId, { signal: controller.signal }).then((value) => setDetail({ state: 'ready', value, message: '' })).catch((error) => { if (!controller.signal.aborted) setDetail({ state: error?.code === 'attempt_not_found' ? 'denied' : 'error', value: null, message: error.message || 'This result could not be opened.' }); });
    return () => controller.abort();
  }, [attemptId, client]);
  useEffect(() => {
    setReleasedReview({ state: 'idle', value: null, message: '', open: false });
    return () => reviewControllerRef.current?.abort();
  }, [attemptId, client]);
  const value = detail.value;
  async function openReleasedReview() {
    if (releasedReview.value) {
      setReleasedReview((current) => ({ ...current, open: true, message: '' }));
      return;
    }
    if (!client) {
      setReleasedReview({ state: 'error', value: null, message: 'Sign in to open released question review.', open: false });
      return;
    }
    reviewControllerRef.current?.abort();
    const controller = new AbortController();
    reviewControllerRef.current = controller;
    setReleasedReview({ state: 'loading', value: null, message: 'Loading released review…', open: false });
    try {
      const payload = await client.getReview(attemptId, { signal: controller.signal });
      if (!controller.signal.aborted) setReleasedReview({ state: 'ready', value: payload.review, message: '', open: true });
    } catch (error) {
      if (controller.signal.aborted) return;
      setReleasedReview({
        state: 'error',
        value: null,
        message: error?.code === 'review_unavailable'
          ? 'Released question review is not available for this result.'
          : 'Released question review could not be loaded. Return to this result summary and try again.',
        open: false,
      });
    }
  }
  async function downloadPdf() {
    setPdf({ preparing: true, message: '', error: '' });
    try {
      const { filename } = await downloadProtectedResultSummaryPdf(value);
      setPdf({ preparing: false, message: `Downloaded ${filename}.`, error: '' });
    } catch {
      setPdf({ preparing: false, message: '', error: 'PDF download failed. Use Print as a fallback.' });
    }
  }
  if (releasedReview.open && releasedReview.value) {
    return <ReleasedReviewWorkspace review={releasedReview.value} onReturn={() => setReleasedReview((current) => ({ ...current, open: false }))} />;
  }
  return (
    <section className="form-panel protected-result-detail" aria-labelledby="protected-result-detail-heading">
      <p className="eyebrow">Saved Result</p>
      <h2 id="protected-result-detail-heading">Result summary</h2>
      {detail.state === 'loading' ? <p role="status">Loading result summary…</p> : null}
      {detail.message ? <p role={detail.state === 'error' ? 'alert' : 'status'}>{detail.message}</p> : null}
      {value ? (
        <>
          <dl className="exam-stats compact">
            <div><dt>Exam</dt><dd>{getSavedResultExamLabel(value.exam?.key)}</dd></div>
            <div><dt>Exam profile</dt><dd>{value.profile?.name || 'Standard profile'}</dd></div>
            <div><dt>Attempt</dt><dd>{value.source === 'legacy_authoritative' && isAssessmentResult(value) ? 'Historical exam attempt' : getAttemptKindLabel(value)}</dd></div>
            <div><dt>Score</dt><dd>{value.percentage == null ? 'Not recorded' : `${value.percentage}%`}</dd></div>
            <div><dt>Status</dt><dd>{value.passed === true ? 'Passed' : value.passed === false ? 'Needs review' : 'Not recorded'}</dd></div>
            <div><dt>Completed</dt><dd>{new Date(value.completedAt).toLocaleString()}</dd></div>
            <div><dt>Review</dt><dd>{value.reviewStatus === 'released' ? 'Released' : 'Withheld'}</dd></div>
          </dl>
          <p>Question and answer review is available only when the applicable release policy permits it.</p>
          <div className="button-row wrap no-print">
            {value.reviewStatus === 'released' ? <button className="secondary-button" disabled={releasedReview.state === 'loading'} type="button" onClick={openReleasedReview}>{releasedReview.state === 'loading' ? 'Loading released review…' : 'View released review'}</button> : null}
            <button className="secondary-button" type="button" onClick={() => window.print()}>Print result summary</button>
            <button className="secondary-button" disabled={pdf.preparing} type="button" onClick={downloadPdf}>{pdf.preparing ? 'Preparing PDF...' : 'Download PDF'}</button>
          </div>
          {releasedReview.message ? <p role={releasedReview.state === 'error' ? 'alert' : 'status'}>{releasedReview.message}</p> : null}
          {pdf.message ? <p role="status">{pdf.message}</p> : null}
          {pdf.error ? <p role="alert">{pdf.error}</p> : null}
        </>
      ) : null}
      <button type="button" className="primary-button no-print" onClick={onBack}>Back to Saved Results</button>
    </section>
  );
}

function normalizeExamKey(value) { return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ''); }
export function ExamProgressSummary() { return <p className="status-note">Protected progress is available after a server-authoritative assessment.</p>; }
