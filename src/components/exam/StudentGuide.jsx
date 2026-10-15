export default function StudentGuide({ exam }) {
  const providerList =
    exam.vendor === 'Microsoft'
      ? 'Microsoft, Pearson VUE, or an official exam provider'
      : `${exam.vendor} or an official exam provider`;
  const attemptHistoryEnabled = exam.supportedFeatures?.attemptHistory === true;

  return (
    <section
      className="student-guide-panel no-print"
      aria-labelledby="student-guide-heading"
    >
      <div className="student-guide-header">
        <div>
          <p className="eyebrow">Student guide</p>
          <h3 id="student-guide-heading">How to Use CertSim</h3>
        </div>
        <p>
          Use CertSim as a strict practice tool for identifying weak domains,
          reviewing explanations, and planning focused revision.
        </p>
      </div>

      <div className="guide-section-grid">
        <GuideSection title="How to use CertSim">
          <ul>
            <li>Enter your real name and email so reports and history are identifiable.</li>
            <li>Use Study Sandbox for learning, revision, and checking explanations.</li>
            <li>Use Targeted Domain Practice to fix weak domains one domain at a time.</li>
            {getTimedAttemptGuideItems(exam).map((item) => (
              <li key={item}>{item}</li>
            ))}
            <li>Use fullscreen mode where possible to reduce distractions.</li>
            <li>Answer every question before submitting.</li>
            <li>Flag questions you are unsure about.</li>
            <li>Read explanations and remediation after submitting.</li>
            <li>
              Open the Study Report, then choose Print Report or Download PDF.
            </li>
            <li>
              {attemptHistoryEnabled
                ? 'Use Attempt History to track strict exam attempts, not sandbox or targeted practice.'
                : 'This module does not keep browser-only Attempt History; eligible marked attempts remain available in Saved Results when signed in.'}
            </li>
            <li>Use Report Question if a question seems unclear, incorrect, or confusing.</li>
          </ul>
        </GuideSection>

        {exam.guideNotes?.length > 0 && (
          <GuideSection title={`${exam.shortName} notes`}>
            <ul>
              {exam.guideNotes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </GuideSection>
        )}

        <GuideSection title="Important exam note">
          <p>
            CertSim is an unofficial practice simulator for {exam.shortName}.
            It is not {providerList}.
          </p>
          <p>
            CertSim scores are intentionally strict practice scores and should
            be used to identify weak domains and track improvement, not as an
            exact prediction of your official {exam.vendor} exam result.
          </p>
          <p>
            Pass threshold used in CertSim: {exam.passingScore}/
            {exam.scoreScale?.max ?? 1000}. {exam.scoreLabel}.
          </p>
          {exam.statusLabel === 'Production-ready' &&
            exam.statusDescription === 'Trainer validation pending' && (
              <p>Trainer validation pending.</p>
            )}
          {exam.lifecycleNotice && (
            <p className="lifecycle-notice">{exam.lifecycleNotice}</p>
          )}
        </GuideSection>

        <GuideSection title="Case study behavior">
          <ul>
            <li>Normal questions are shown first.</li>
            <li>Case study sections appear near the end.</li>
            <li>
              Once you enter the case study section, you cannot return to the
              normal questions.
            </li>
            <li>Read the scenario carefully before answering related questions.</li>
            <li>Scenario and information pages are not scored.</li>
          </ul>
        </GuideSection>

        <GuideSection title="Reports, history, and privacy">
          <ul>
            <li>Study reports are generated locally in the browser.</li>
            {attemptHistoryEnabled ? (
              <>
                <li>Attempt history is saved only in the current browser and device.</li>
                <li>History is not synced or uploaded.</li>
                <li>Clearing browser data or using another device can remove or hide local history.</li>
              </>
            ) : (
              <li>
                This module does not keep browser-only Attempt History. Signed-in
                Saved Results are separate from local browser activity.
              </li>
            )}
            <li>Feedback reports are copied by the student and are not automatically saved or sent yet.</li>
          </ul>
        </GuideSection>

        <GuideSection title="How to prepare for a rewrite">
          <ul>
            <li>Start with domains below 70%.</li>
            <li>Compare recent attempts in Attempt History.</li>
            <li>Use Targeted Domain Practice for repeated weak domains.</li>
            <li>Focus on repeated weak domains first.</li>
            <li>Print the study report and revise the explanations and remediation.</li>
            <li>
              Do not only chase a pass mark. Focus on understanding why answers
              are correct.
            </li>
          </ul>
        </GuideSection>
      </div>
    </section>
  );
}

function getTimedAttemptGuideItems(exam) {
  if (exam.id === 'security-plus-sy0-701') {
    return [
      'Choose Compact Practice for a shorter timed PBQ-first attempt.',
      'Choose Full Practice for the full timed PBQ-first attempt.',
    ];
  }

  if (exam.id === 'az400') {
    return [
      'Choose Full Exam with Case Studies and Labs for the sectioned timed flow.',
      'Use Standard Full Mock or Realistic Random for standard-question timed practice.',
    ];
  }

  return [
    'Choose Full Mock Exam for a full pressure practice attempt.',
    'Choose Realistic Random Exam for a more varied practice experience.',
  ];
}

function GuideSection({ title, children }) {
  return (
    <details className="guide-section">
      <summary>{title}</summary>
      <div className="guide-section-content">
        {children}
      </div>
    </details>
  );
}
