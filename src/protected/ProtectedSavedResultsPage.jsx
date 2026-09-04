import { useEffect, useMemo, useRef, useState } from 'react';
import { examRegistry } from '../exams/examRegistry.js';
import { getAttemptHistory } from '../utils/attemptHistory.js';
import { createProtectedExamClient } from '../lib/protectedExamClient.js';
import { appendUniqueHistory } from '../lib/historyPagination.js';
import { getAttemptKindLabel, isAssessmentResult } from '../lib/attemptPurpose.js';
import { loadAllProtectedHistory, loadProtectedHistoryPage } from '../lib/protectedHistory.js';
import { aggregateWeakDomains } from '../lib/learnerAnalytics.js';
import { selectCurrentWeakAreaProfile } from '../lib/weakAreaProfileSelection.js';

export default function ProtectedSavedResultsPage({ attemptId, onBackHome, onOpenAccount, onOpenDetail, onReturnHome, onReturnToList, session, openWeakAreaPractice = false, weakAreaPracticeExamId = '', onStartWeakAreaPractice }) {
  const client = useMemo(() => session?.access_token ? createProtectedExamClient({ accessToken: session.access_token }) : null, [session?.access_token]);
  if (attemptId) return <ProtectedResultDetail attemptId={attemptId} client={client} onBack={onReturnToList} />;
  return <ProtectedResultList client={client} onBack={onReturnHome ?? onBackHome} onOpenAccount={onOpenAccount} onOpenDetail={onOpenDetail} openWeakAreaPractice={openWeakAreaPractice} weakAreaPracticeExamId={weakAreaPracticeExamId} onStartWeakAreaPractice={onStartWeakAreaPractice} />;
}

function ProtectedResultList({ client, onBack, onOpenAccount, onOpenDetail, openWeakAreaPractice, weakAreaPracticeExamId, onStartWeakAreaPractice }) {
  const historical = useMemo(() => examRegistry.flatMap((exam) => getAttemptHistory(exam.id).records.map((record) => ({ ...record, registryTitle: exam.title }))), []);
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
      {focusOpen ? <ProtectedWeakAreaPractice client={client} initialExamId={weakAreaPracticeExamId} results={practiceResults} loading={practiceLoading} onStart={onStartWeakAreaPractice} /> : null}
    </section>
    <h3>Account results</h3>
    <div className="saved-attempt-toolbar no-print"><label><span>Range</span><select value={range} onChange={(event) => setRange(event.target.value)}><option value="recent">Recent results</option><option value="all">All Time</option></select></label><label><span>Exam</span><select value={examFilter} onChange={(event) => setExamFilter(event.target.value)}><option value="">All exams</option>{examRegistry.map((exam) => <option key={exam.id} value={exam.id}>{exam.shortName}</option>)}</select></label><strong>{range === 'all' ? 'All Time' : 'Recent results · latest 10'}{Number.isInteger(remote.totalCount) ? ` · ${remote.items.length} of ${remote.totalCount} loaded` : ''}</strong></div>
    {remote.state === 'loading' ? <p role="status">Loading account history…</p> : null}
    {remote.message ? <p role={remote.state === 'error' ? 'alert' : 'status'}>{remote.message}</p> : null}
    {visibleItems.length ? <ul className="history-list">{visibleItems.map((item) => <li key={item.attemptId}><button type="button" className="saved-result-item" onClick={() => onOpenDetail?.(item.attemptId)}><strong>{getExamDisplayName(item.examKey)}</strong>{' '}<span>{item.percentage}% · {getAttemptKindLabel(item)} · {item.source === 'legacy_authoritative' ? 'Historical account result' : 'Saved result'} · {new Date(item.completedAt).toLocaleString()}</span></button></li>)}</ul> : null}
    {range === 'all' && remote.nextCursor ? <div className="saved-pagination"><button type="button" disabled={loadingMore} onClick={loadMore}>{loadingMore ? 'Loading more…' : 'Load more results'}</button><span>{remote.items.length} of {remote.totalCount} loaded</span></div> : null}
    <h3>Historical browser-only results</h3><p>Browser-only records remain separate from authenticated server history; they are not uploaded or combined with protected scores.</p>
    {historical.length === 0 ? <p>No browser-only results were found.</p> : <ul className="history-list">{historical.map((record) => <li key={record.id}><strong>{record.registryTitle}</strong>{' '}<span>{record.percentage}% · {new Date(record.attemptedAt).toLocaleString()}</span></li>)}</ul>}
    {onBack ? <button type="button" className="primary-button" onClick={onBack}>Return home</button> : null}
  </section>;
}

function ProtectedWeakAreaPractice({ client, initialExamId, loading, onStart, results }) {
  const assessments = useMemo(() => results.filter(isAssessmentResult), [results]);
  const exams = useMemo(() => examRegistry.filter((exam) => assessments.some((item) => normalizeExamKey(item.examKey) === normalizeExamKey(exam.id))), [assessments]);
  const [examId, setExamId] = useState(initialExamId);
  const [profileId, setProfileId] = useState('');
  const [domain, setDomain] = useState('');
  const [count, setCount] = useState(20);
  const [mixStrategy, setMixStrategy] = useState('balanced');
  const [includePbqs, setIncludePbqs] = useState(true);
  const [availability, setAvailability] = useState({ state: 'idle', value: null, message: '' });
  useEffect(() => { if (!exams.some((exam) => exam.id === examId)) setExamId(exams.find((exam) => exam.id === initialExamId)?.id ?? exams[0]?.id ?? ''); }, [examId, exams, initialExamId]);
  const examResults = useMemo(() => assessments.filter((item) => normalizeExamKey(item.examKey) === normalizeExamKey(examId)), [assessments, examId]);
  const currentExam = useMemo(() => exams.find((exam) => exam.id === examId) ?? null, [examId, exams]);
  const currentProfiles = currentExam?.strictBetaProfiles ?? [];
  const weakDomains = useMemo(() => aggregateWeakDomains(examResults), [examResults]);
  useEffect(() => { if (!weakDomains.some((item) => item.id === domain)) setDomain(weakDomains[0]?.id ?? ''); }, [domain, weakDomains]);
  const latest = examResults[0];
  useEffect(() => {
    if (!currentProfiles.some((profile) => profile.id === profileId)) {
      setProfileId(selectCurrentWeakAreaProfile(currentProfiles, latest?.profileKey));
    }
  }, [currentProfiles, latest?.profileKey, profileId]);
  useEffect(() => {
    const controller = new AbortController();
    if (!client || !profileId || !domain) { setAvailability({ state: 'idle', value: null, message: '' }); return () => controller.abort(); }
    setAvailability({ state: 'loading', value: null, message: '' });
    client.getPracticeAvailability({ examKey: examId, profileId, purpose: 'weak_area', domain, count, includePbqs, mixStrategy }, { signal: controller.signal })
      .then((value) => setAvailability({ state: 'ready', value, message: '' }))
      .catch((error) => { if (!controller.signal.aborted) setAvailability({ state: 'error', value: null, message: error.message || 'Weak Area Practice is not available.' }); });
    return () => controller.abort();
  }, [client, count, domain, examId, includePbqs, mixStrategy, profileId]);
  if (loading) return <p role="status">Reading completed assessment evidence…</p>;
  if (!exams.length) return <p>No eligible completed assessments are available yet. Practice and unclassified historical activity do not create readiness evidence.</p>;
  if (!weakDomains.length) return <p>No domain is currently below the 70% weak-area threshold for the selected exam.</p>;
  return <div className="weak-area-practice-panel">
    <div className="weak-area-configuration-grid">
      <label><span>Exam</span><select value={examId} onChange={(event) => setExamId(event.target.value)}>{exams.map((exam) => <option key={exam.id} value={exam.id}>{exam.shortName}</option>)}</select></label>
      <label><span>Practice profile</span><select value={profileId} onChange={(event) => setProfileId(event.target.value)}>{currentProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
      <label><span>Weak domain</span><select value={domain} onChange={(event) => setDomain(event.target.value)}>{weakDomains.map((item) => <option key={item.id} value={item.id}>{item.label} · {Math.round(item.percentage)}%</option>)}</select></label>
      <label><span>Question count</span><select value={count} onChange={(event) => setCount(Number(event.target.value))}>{[10,20,30,40].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
      <label><span>Question mix</span><select value={mixStrategy} onChange={(event) => setMixStrategy(event.target.value)}><option value="missed-heavy">Review Missed First</option><option value="balanced">Balanced Mix</option><option value="new-heavy">New Questions First</option></select></label>
      <label className="weak-area-pbq-control"><input type="checkbox" checked={includePbqs} onChange={(event) => setIncludePbqs(event.target.checked)} /><span className="weak-area-toggle-track" aria-hidden="true" /><span className="weak-area-toggle-copy"><strong>Include PBQs</strong><small>when eligible</small></span></label>
    </div>
    <p>Weak domains use earned points divided by available points from completed assigned or self-directed assessments. “First” controls priority; the backend may adjust the mix when eligible content is limited.</p>
    {availability.state === 'loading' ? <p role="status">Checking eligible practice content…</p> : null}
    {availability.message ? <p role="alert">{availability.message}</p> : null}
    {availability.value ? <p>{availability.value.selectedCount} question{availability.value.selectedCount === 1 ? '' : 's'} selected from {availability.value.available} eligible items{availability.value.adjustedCount ? ' after a safe availability adjustment' : ''}. Completing this practice does not affect formal readiness or exam-attempt totals.</p> : null}
    <button className="primary-button" type="button" disabled={!availability.value?.selectedCount} onClick={() => onStart?.({ examKey: examId, profileId, domain, questionCount: count, includePbqs, mixStrategy })}>Start Weak Area Practice</button>
  </div>;
}

function ProtectedResultDetail({ attemptId, client, onBack }) {
  const [detail, setDetail] = useState({ state: 'loading', value: null, message: '' });
  useEffect(() => {
    const controller = new AbortController();
    if (!client) { setDetail({ state: 'signed-out', value: null, message: 'Sign in to open this result.' }); return () => controller.abort(); }
    client.getPrintableSummary(attemptId, { signal: controller.signal }).then((value) => setDetail({ state: 'ready', value, message: '' })).catch((error) => { if (!controller.signal.aborted) setDetail({ state: error?.code === 'attempt_not_found' ? 'denied' : 'error', value: null, message: error.message || 'This result could not be opened.' }); });
    return () => controller.abort();
  }, [attemptId, client]);
  const value = detail.value;
  return <section className="form-panel protected-result-detail" aria-labelledby="protected-result-detail-heading"><p className="eyebrow">Saved Result</p><h2 id="protected-result-detail-heading">Result summary</h2>{detail.state === 'loading' ? <p role="status">Loading result summary…</p> : null}{detail.message ? <p role={detail.state === 'error' ? 'alert' : 'status'}>{detail.message}</p> : null}{value ? <><dl className="exam-stats compact"><div><dt>Exam</dt><dd>{getExamDisplayName(value.exam?.key)}</dd></div><div><dt>Exam profile</dt><dd>{value.profile?.name || 'Standard profile'}</dd></div><div><dt>Attempt</dt><dd>{value.source === 'legacy_authoritative' && isAssessmentResult(value) ? 'Historical exam attempt' : getAttemptKindLabel(value)}</dd></div><div><dt>Score</dt><dd>{value.percentage == null ? 'Not recorded' : `${value.percentage}%`}</dd></div><div><dt>Status</dt><dd>{value.passed === true ? 'Passed' : value.passed === false ? 'Needs review' : 'Not recorded'}</dd></div><div><dt>Completed</dt><dd>{new Date(value.completedAt).toLocaleString()}</dd></div><div><dt>Review</dt><dd>{value.reviewStatus === 'released' ? 'Released' : 'Withheld'}</dd></div></dl><p>Question and answer review is available only when the applicable release policy permits it.</p><button className="secondary-button no-print" type="button" onClick={() => window.print()}>Print result summary</button></> : null}<button type="button" className="primary-button no-print" onClick={onBack}>Back to Saved Results</button></section>;
}

function normalizeExamKey(value) { return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ''); }
function getExamDisplayName(value) { const normalized = normalizeExamKey(value); return examRegistry.find((exam) => normalizeExamKey(exam.id) === normalized)?.name ?? 'Certification exam'; }
export function ExamProgressSummary() { return <p className="status-note">Protected progress is available after a server-authoritative assessment.</p>; }
