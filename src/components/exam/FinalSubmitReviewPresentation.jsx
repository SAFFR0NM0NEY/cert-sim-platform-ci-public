export default function FinalSubmitReviewPresentation({
  examName,
  facts = [],
  hasOpenItems,
  hasPbqs,
  incompletePbqCount,
  items,
  onReturnToExam,
  onSubmitFinal,
  showCaseStudyLockWarning = false,
  summary,
}) {
  return <div className="modal-backdrop" role="presentation"><section className="modal final-submit-modal" role="dialog" aria-modal="true" aria-labelledby="final-submit-heading">
    <div className="final-submit-header"><div><p className="eyebrow">Final review</p><h2 id="final-submit-heading">Review before submitting</h2><p>Submitting will end this attempt. You will not be able to change answers afterward.</p></div><button className="text-button" type="button" onClick={onReturnToExam}>Return to Exam</button></div>
    <dl className="final-submit-meta"><Fact label="Exam" value={examName} />{facts.map((fact) => <Fact key={fact.label} label={fact.label} value={fact.value} />)}</dl>
    <dl className="final-submit-summary-grid"><Fact label="Total scored items" value={summary.total} /><Fact label="Answered" value={summary.answered} /><Fact label="Unanswered" value={summary.unanswered} /><Fact label="Flagged" value={summary.flagged} /><Fact label="Incomplete" value={summary.incomplete} />{hasPbqs && <Fact label="Incomplete PBQs" value={incompletePbqCount} />}</dl>
    {hasOpenItems && <section className="final-submit-warning" aria-label="Open item warning"><h3>Items need attention</h3><p>You can return to any available item below before final submission.</p>{incompletePbqCount > 0 && <p>Some PBQ tasks are incomplete. You can return to complete them or submit anyway.</p>}{showCaseStudyLockWarning && <p>Normal questions are locked because you are already in the case study section.</p>}</section>}
    <section className="final-submit-items" aria-labelledby="final-submit-items-heading"><h3 id="final-submit-items-heading">Item summary</h3><div className="final-submit-item-grid">{items.map((item) => <button className={['final-submit-item', item.answerState, item.flagged ? 'flagged' : '', item.locked ? 'locked' : ''].filter(Boolean).join(' ')} disabled={item.locked} key={item.id} type="button" onClick={item.onNavigate}><span className="final-submit-item-number">Item {item.number}</span><strong>{item.status}</strong><span>{item.kind}</span>{item.locked && <small>Locked</small>}</button>)}</div></section>
    <div className="modal-actions final-submit-actions"><button className="secondary-button" type="button" onClick={onReturnToExam}>Return to Exam</button><button className="primary-button" type="button" onClick={onSubmitFinal}>Submit Final Attempt</button></div>
  </section></div>;
}

function Fact({ label, value }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}
