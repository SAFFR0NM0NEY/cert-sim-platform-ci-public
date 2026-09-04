export default function LegacyFeatureUnavailable({ onExit, onRestart, onReturnHome }) {
  const leave = onExit ?? onRestart ?? onReturnHome;
  return (
    <section className="form-panel" aria-labelledby="protected-feature-unavailable-heading">
      <p className="eyebrow">Protected delivery</p>
      <h2 id="protected-feature-unavailable-heading">This study feature is temporarily unavailable</h2>
      <p>
        CertSim will not fall back to browser question banks. Use an available
        protected exam assignment, or return after this feature has a protected
        server-authoritative replacement.
      </p>
      {leave && <button className="primary-button" type="button" onClick={leave}>Return</button>}
    </section>
  );
}

export function ExamProgressSummary() {
  return null;
}

export function createWeakAreaPracticeAttempt() {
  throw new Error('legacy_practice_unavailable');
}

export function generateExamAttempt() {
  throw new Error('legacy_generation_unavailable');
}

export function generateAz400SectionedAttempt() {
  throw new Error('legacy_generation_unavailable');
}

export function generateSecurityPlusStrictBetaAttempt() {
  throw new Error('legacy_generation_unavailable');
}

export function validateQuestionBank() {
  return [];
}
