export const TOP_LEVEL_SCREENS = [
  'home',
  'browse-exams',
  'account',
  'saved-results',
  'admin-organisations',
  'trainer-dashboard',
  'developer-dashboard',
  'reception-placement',
  'it-direction-intro',
  'privacy',
  'terms',
];

export const CONTEXTUAL_SCREENS = [
  'exam-dashboard',
  'student',
  'join',
  'account-assignments',
  'account-progress',
  'account-reports',
  'saved-result-detail',
  'admin-organisation-detail',
  'admin-campus-detail',
  'admin-group-detail',
  'trainer-assignment-detail',
  'trainer-student-detail',
  'developer-report-detail',
  'strict-unavailable',
  'not-found',
];

export const FOCUSED_ATTEMPT_SCREENS = [
  'exam',
  'sandbox',
  'targeted-practice',
  'pbq-preview',
  'case-study-preview',
  'it-direction-runner',
];

export const COMPLETION_SCREENS = [
  'results',
  'review',
  'it-direction-results',
];

export function isFocusedAttemptScreen(screen) {
  return FOCUSED_ATTEMPT_SCREENS.includes(screen);
}

export function getActiveHeaderDestination(screen) {
  if (screen === 'home') {
    return 'home';
  }

  if (['browse-exams', 'exam-dashboard', 'strict-unavailable', 'not-found'].includes(screen)) {
    return 'browse-exams';
  }

  if (screen === 'privacy' || screen === 'terms') {
    return screen;
  }

  if (
    screen === 'account' ||
    screen === 'join' ||
    screen.startsWith('account-') ||
    screen.startsWith('saved-result') ||
    screen.startsWith('admin-') ||
    screen.startsWith('trainer-') ||
    screen.startsWith('developer-') ||
    screen === 'reception-placement'
  ) {
    return 'account';
  }

  return '';
}
