import MyAssignmentsPanel from './MyAssignmentsPanel.jsx';

export default function MyAssignmentsPage({
  onBackHome,
  onBrowseExams,
  onOpenAccount,
} = {}) {
  return (
    <section className="account-page" aria-labelledby="assignments-page-heading">
      <div className="account-page-header">
        <div>
          <p className="eyebrow">CertSim Account</p>
          <h2 id="assignments-page-heading">My Assigned Exams</h2>
          <p className="saved-results-page-intro">
            Review assignment reminders from trainers or Platform Owners. These
            records help track progress, but they do not restrict open exam
            access yet.
          </p>
        </div>
        <div className="button-row wrap">
          <button className="secondary-button" type="button" onClick={onOpenAccount}>
            Back to Account
          </button>
        </div>
      </div>

      <section className="account-page-grid single">
        <MyAssignmentsPanel />
      </section>
    </section>
  );
}
