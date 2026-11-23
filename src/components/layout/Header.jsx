export default function Header({
  activeDestination = '',
  compact = false,
  onOpenAccount,
  onOpenBrowseExams,
  onOpenHome,
  onOpenPrivacy,
  onOpenTerms,
}) {
  const brand = (
    <img
      className="site-brand-wordmark"
      src="/brand/certsim-platform-wordmark-dark-display.png"
      alt={compact ? 'CertSim Platform' : ''}
    />
  );

  return (
    <header className={compact ? 'site-header compact' : 'site-header'}>
      {!compact && onOpenHome ? (
        <button
          className="site-brand-button"
          type="button"
          aria-label="CertSim Platform — Home"
          onClick={onOpenHome}
        >
          {brand}
        </button>
      ) : (
        <div className="site-brand">{brand}</div>
      )}
      {!compact ? (
        <nav className="site-header-actions" aria-label="Primary navigation">
          <HeaderNavigationButton
            active={activeDestination === 'home'}
            label="Home"
            onClick={onOpenHome}
          />
          <HeaderNavigationButton
            active={activeDestination === 'browse-exams'}
            label="Browse Exams"
            onClick={onOpenBrowseExams}
          />
          <HeaderNavigationButton
            active={activeDestination === 'account'}
            label="Account"
            onClick={onOpenAccount}
          />
          <HeaderNavigationLink
            active={activeDestination === 'privacy'}
            href="/privacy"
            label="Privacy"
            onClick={onOpenPrivacy}
          />
          <HeaderNavigationLink
            active={activeDestination === 'terms'}
            href="/terms"
            label="Terms"
            onClick={onOpenTerms}
          />
        </nav>
      ) : null}
    </header>
  );
}

function HeaderNavigationLink({ active, href, label, onClick }) {
  return (
    <a
      aria-current={active ? 'page' : undefined}
      className="secondary-button header-navigation-button"
      href={href}
      onClick={(event) => {
        event.preventDefault();
        onClick?.();
      }}
    >
      {label}
    </a>
  );
}

function HeaderNavigationButton({ active, label, onClick }) {
  return (
    <button
      aria-current={active ? 'page' : undefined}
      className="secondary-button header-navigation-button"
      type="button"
      onClick={() => onClick?.()}
    >
      {label}
    </button>
  );
}
