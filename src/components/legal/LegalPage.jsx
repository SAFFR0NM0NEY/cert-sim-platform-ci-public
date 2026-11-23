const privacySections = [
  ['Account and profile information', `If account features are configured and you create or use an account, CertSim uses your email address and profile details such as your display name or optional full name. Membership and role information may also be used to show the areas and records available to your account.`],
  ['Certification practice attempts and results', `Eligible completed certification practice attempts are saved to your account when you are signed in and result storage is configured. Saved records may include attempt details, submitted responses, scores, pass/fail practice outcomes, domain breakdowns, and generated reports. You can view your own saved certification results from Account and retry a failed save from an eligible result page.`],
  ['Trainer and administrator visibility', `Trainers and administrators do not receive unrestricted access to every account. Current role and organisation, campus, or group scope determines which student identities, assignments, progress summaries, and saved certification results a permitted trainer or administrator can view.`],
  ['IT Direction placement results', `The IT Direction Assessment is a placement and study-guidance activity, not a certification exam. Its intake details, answer summary, pathway scores, recommendation, and guidance result may be submitted to a separate placement-results area when that service is configured. This information is not added to certification attempt history. Placement records are available only through the current scoped placement workflow for permitted reception, administrator, developer, and platform owner roles. A signed-out participant can submit a placement result for follow-up but cannot use that submission to browse placement records.`],
  ['Question and platform issue reports', `Saved issue reports require a signed-in account and are associated with that account. A platform report includes the title, category, and details you enter, together with the page route. A question report may also include exam, attempt, result, question, and question-type context so the reported item can be investigated. Report status and feedback may be visible from your account. Do not include passwords, secrets, or unnecessary personal information in report text.`],
  ['Signed-out and browser-local use', `Protected certification exams, Saved Results, My Progress, and Weak Area Practice require sign-in and the appropriate access. A browser may remember non-authoritative preferences such as the selected exam or coding language. The IT Direction Assessment is a separate guidance activity and is not a certification exam.`],
  ['Your current controls', `Signed-in users can update their profile name, view their own saved certification results, and view reports submitted from their account. Supported local attempt history can be cleared from the relevant exam dashboard. CertSim does not currently provide a general self-service data export or a browser control that immediately deletes all account data.`],
  ['Account lifecycle requests', `The Account page can submit an account deletion or deactivation request for review and show its status. Submitting that request does not itself delete the authentication user or historical saved results and reports; those require a separate authorised process and retention decision.`],
];

const termsSections = [
  ['Purpose of CertSim', `CertSim is an exam-preparation, practice, assessment, and study platform. Certification simulations and their scores are practice tools only. They are not official certification exams, official results, or guarantees of readiness or performance in another provider's exam.`],
  ['IT Direction guidance', `The IT Direction Assessment is separate from certification practice. It provides informational placement and study-path guidance, has no pass/fail result, and does not award a certification.`],
  ['Using the platform responsibly', `Provide information you are authorised to submit, keep access to your account secure, and use question and platform issue-reporting tools for genuine support or quality concerns. Do not submit passwords, secrets, harmful material, or unnecessary personal information.`],
  ['Service changes', `CertSim's available modules, features, storage behaviour, and study guidance may evolve. Check the current interface and these pages for the behaviour available in the version you are using.`],
];

export function PrivacyPage() {
  return <LegalPage eyebrow="Privacy" title="Privacy" introduction="This page explains CertSim's current product behaviour. It is not a guarantee of legal compliance." sections={privacySections} />;
}

export function TermsPage() {
  return <LegalPage eyebrow="Terms" title="Terms of use" introduction="These terms describe the current role and appropriate use of the CertSim platform." sections={termsSections} />;
}

function LegalPage({ eyebrow, introduction, sections, title }) {
  const headingId = `${eyebrow.toLowerCase()}-page-heading`;

  return (
    <section className="legal-page" aria-labelledby={headingId}>
      <header className="legal-page-header">
        <p className="eyebrow">{eyebrow}</p>
        <h1 id={headingId}>{title}</h1>
        <p>{introduction}</p>
      </header>
      <div className="legal-page-content">
        {sections.map(([sectionTitle, content]) => (
          <section key={sectionTitle}>
            <h2>{sectionTitle}</h2>
            <p>{content}</p>
          </section>
        ))}
      </div>
    </section>
  );
}
