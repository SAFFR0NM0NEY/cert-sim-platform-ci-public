import { useState } from 'react';
import { SECURITY_PLUS_BETA_FEEDBACK_NOTE } from '../../lib/examFeedbackMessages.js';
import { CODING_LANGUAGE_OPTIONS } from '../../utils/codingLanguage.js';
import { isValidBasicEmail } from '../../utils/validation.js';

const initialForm = {
  name: '',
  email: '',
  campusCompany: '',
};

export default function StudentDetails({
  accountStudent = null,
  actionDisabled = false,
  actionLabel = 'Start exam',
  codingLanguagePreference,
  exam,
  languageLocked = false,
  statusMessage = '',
  supplementalContent = null,
  selectedMode,
  selectedProfile,
  onCodingLanguagePreferenceChange,
  onBack,
  onStartExam,
  protectedDelivery = false,
  showPrimaryAction = true,
}) {
  const [form, setForm] = useState(initialForm);
  const [submitted, setSubmitted] = useState(false);
  const [touchedFields, setTouchedFields] = useState({});

  const nameIsValid = form.name.trim().length > 0;
  const emailIsValid = isValidBasicEmail(form.email);
  const formIsValid = nameIsValid && emailIsValid;
  const usesSpecialTimedProfile = Boolean(
    selectedProfile.generationType || selectedProfile.status === 'draft-beta',
  );
  const isSecurityPlusProductionReady =
    exam.id === 'security-plus-sy0-701' &&
    exam.statusLabel === 'Production-ready';
  const isAz400ProductionReady =
    exam.id === 'az400' && exam.statusLabel === 'Production-ready';
  const betaFeedbackNote =
    exam.id === 'security-plus-sy0-701' && !isSecurityPlusProductionReady
      ? SECURITY_PLUS_BETA_FEEDBACK_NOTE
      : '';

  function updateField(field, value) {
    setForm((currentForm) => ({
      ...currentForm,
      [field]: value,
    }));
  }

  function touchField(field) {
    setTouchedFields((currentFields) => ({
      ...currentFields,
      [field]: true,
    }));
  }

  function handleSubmit(event) {
    event.preventDefault();
    setSubmitted(true);

    if (accountStudent) {
      onStartExam(accountStudent);
      return;
    }

    if (!formIsValid) {
      return;
    }

    onStartExam({
      name: form.name.trim(),
      email: form.email.trim(),
      campusCompany: form.campusCompany.trim(),
    });
  }

  return (
    <section className="details-screen" aria-labelledby="student-details-heading">
      <button className="text-button" type="button" onClick={onBack}>
        Back to dashboard
      </button>

      <form className="form-panel" onSubmit={handleSubmit} noValidate>
        <p className="eyebrow">{exam.name}</p>
        <h2 id="student-details-heading">{accountStudent ? 'Exam details' : 'Student details'}</h2>
        {accountStudent?.name && (
          <p className="account-student-name">Learner: <strong>{accountStudent.name}</strong></p>
        )}
        <section className="selected-profile-panel" aria-label="Selected exam profile">
          <p className="eyebrow">{selectedMode.name}</p>
          <h3>{selectedProfile.name}</h3>
          <p>{selectedProfile.description}</p>
          {exam.lifecycleNotice && (
            <p className="lifecycle-notice">{exam.lifecycleNotice}</p>
          )}
          <dl className="profile-facts">
            <div>
              <dt>Scored questions</dt>
              <dd>{selectedProfile.totalScoredQuestions}</dd>
            </div>
            <div>
              <dt>Standard scored questions</dt>
              <dd>{formatStandardQuestionSummary(selectedProfile)}</dd>
            </div>
            {selectedProfile.caseStudyCount ? (
              <div>
                <dt>Case studies</dt>
                <dd>{formatCaseStudySummary(selectedProfile)}</dd>
              </div>
            ) : null}
            {selectedProfile.pbqCount ? (
              <div>
                <dt>PBQs</dt>
                <dd>{formatPbqPlacement(selectedProfile)}</dd>
              </div>
            ) : selectedProfile.caseStudyCount ? null : (
              <div>
                <dt>Case studies</dt>
                <dd>
                  {formatCaseStudyCount(
                    selectedProfile.longCaseStudyCount,
                    selectedProfile.shortCaseStudyCount,
                  )}
                </dd>
              </div>
            )}
            <div>
              <dt>Timer</dt>
              <dd>{selectedProfile.timeLimitMinutes} min</dd>
            </div>
          </dl>
          <p className="profile-note">
            {protectedDelivery
              ? 'Question selection, ordering, timing, answer saving, and scoring are managed securely for this attempt.'
              : selectedProfile.profileNote
              ? selectedProfile.profileNote
              : usesSpecialTimedProfile && isSecurityPlusProductionReady
              ? `${exam.shortName} PBQ-first practice front-loads PBQs before standard questions. Scores are strict CertSim estimates, not official ${exam.vendor} score predictions.`
              : usesSpecialTimedProfile && selectedProfile.sectionOrder === 'case-standard-pbq'
              ? `${exam.shortName} sectioned full exam starts with case studies, continues with standard questions, and ends with workspace labs. Scores are strict CertSim estimates, not official ${exam.vendor} score predictions.`
              : usesSpecialTimedProfile
              ? `Controlled beta only. ${exam.shortName} content, scoring, and exam flow are not final and are not an official ${exam.vendor} score prediction.`
              : selectedMode.id === 'realistic-random'
              ? 'This realistic attempt profile was selected randomly during setup and remains fixed once you start. Restarting from Home can create a different profile.'
              : 'This fixed full mock format keeps the existing 60-question structure.'}
          </p>
          {(usesSpecialTimedProfile || protectedDelivery) && (
            <section
              className="strict-start-instructions"
              aria-label={
                protectedDelivery
                  ? 'Protected exam attempt instructions'
                  : isSecurityPlusProductionReady
                  ? 'PBQ-first practice attempt instructions'
                  : isAz400ProductionReady
                    ? 'Sectioned full exam practice instructions'
                  : 'Strict beta attempt instructions'
              }
            >
              <h4>Before you start</h4>
              <p>
                {selectedProfile.sectionOrder === 'case-standard-pbq'
                  ? 'This attempt contains case studies first, standard questions after, and workspace labs at the end.'
                  : selectedProfile.pbqCount
                    ? 'This attempt contains front-loaded PBQs followed by standard questions.'
                    : protectedDelivery
                      ? 'This attempt uses standard questions.'
                      : 'This controlled-beta compact attempt uses standard questions only.'}{' '}
                Use Flag for Review to mark items you want
                to revisit. Answers are saved as you move between
                questions. Submit only when you are ready to end the attempt.
              </p>
              <p>
                {protectedDelivery
                  ? 'Your answers are saved securely as you move through the attempt. Refreshes and technical interruptions recover the same attempt while its original server timer continues. Choosing End attempt forfeits it after confirmation.'
                  : isSecurityPlusProductionReady
                  ? `${exam.shortName} is Production-ready. Trainer validation is pending, and this is not an official ${exam.vendor} score prediction.`
                  : isAz400ProductionReady
                    ? `${exam.shortName} is Production-ready for strict CertSim practice use. Trainer validation pending, and this is not an official ${exam.vendor} score prediction.`
                    : `${exam.shortName} is Controlled beta. Content, scoring, reports, and exam flow are being tested. This is not an official ${exam.vendor} score prediction.`}
              </p>
              {betaFeedbackNote && <p>{betaFeedbackNote}</p>}
            </section>
          )}
        </section>

        {codingLanguagePreference && (
          <section
            className="coding-language-panel"
            aria-labelledby="coding-language-start-heading"
          >
            <div>
              <p className="eyebrow">Code questions</p>
              <h3 id="coding-language-start-heading">Coding language</h3>
              <p>
                Choose the coding language used for AZ-204 code questions.
                Non-code questions are unchanged.
              </p>
              <p>
                Mixed randomly uses available C# or Python variants per
                question for this attempt.
              </p>
            </div>
            <div className="coding-language-options">
              {CODING_LANGUAGE_OPTIONS.map((option) => (
                <label className="coding-language-option" key={option.id}>
                  <input
                    checked={codingLanguagePreference === option.id}
                    disabled={languageLocked}
                    name="coding-language"
                    onChange={() => onCodingLanguagePreferenceChange(option.id)}
                    type="radio"
                    value={option.id}
                  />
                  <span>
                    <strong>{option.label}</strong>
                    <small>{option.description}</small>
                  </span>
                </label>
              ))}
            </div>
          </section>
        )}

        {statusMessage && <p className="status-note" role="status">{statusMessage}</p>}
        {supplementalContent}

        {!accountStudent && <><label htmlFor="student-name">Student name</label>
        <input
          id="student-name"
          type="text"
          value={form.name}
          onChange={(event) => updateField('name', event.target.value)}
          onBlur={() => touchField('name')}
          autoComplete="name"
        />
        {(submitted || touchedFields.name) && !nameIsValid && (
          <p className="field-error">Student name is required.</p>
        )}

        <label htmlFor="student-email">Student email</label>
        <input
          id="student-email"
          type="email"
          value={form.email}
          onChange={(event) => updateField('email', event.target.value)}
          onBlur={() => touchField('email')}
          autoComplete="email"
        />
        {(submitted || touchedFields.email || form.email.length > 0) &&
          !emailIsValid && (
            <p className="field-error">
              Enter a valid email address, such as name@example.com.
            </p>
          )}

        <label htmlFor="campus-company">Campus or company</label>
        <input
          id="campus-company"
          type="text"
          value={form.campusCompany}
          onChange={(event) => updateField('campusCompany', event.target.value)}
          placeholder="Optional"
        />

        </>}

        {showPrimaryAction && (
          <button className="primary-button" type="submit" disabled={actionDisabled || (!accountStudent && !formIsValid)}>
            {actionLabel}
          </button>
        )}
      </form>
    </section>
  );
}

function formatCaseStudyCount(longCount, shortCount) {
  const parts = [];

  if (longCount > 0) {
    parts.push(`${longCount} long`);
  }

  if (shortCount > 0) {
    parts.push(`${shortCount} short`);
  }

  return parts.length > 0 ? parts.join(', ') : 'None';
}

function formatCaseStudySummary(profile) {
  const count = profile.caseStudyCount ?? 0;
  const scored = profile.caseStudyQuestionCount ?? 0;
  return `${count} case ${count === 1 ? 'study' : 'studies'} / ${scored} scored case questions`;
}

function formatPbqPlacement(profile) {
  const count = profile.pbqCount ?? 0;

  if (profile.pbqPlacement === 'end') {
    return `${count} at end`;
  }

  if (profile.pbqPlacement === 'front-loaded') {
    return `${count} front-loaded`;
  }

  return String(count);
}

function formatStandardQuestionSummary(profile) {
  if (profile.sectionOrder === 'case-standard-pbq') {
    return 'Remaining scored items';
  }

  return (
    profile.standardQuestionCount ??
    profile.mcqCount ??
    profile.normalScoredQuestionCount ??
    'Remaining scored items'
  );
}
