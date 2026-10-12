const BASIC_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidBasicEmail(email) {
  return BASIC_EMAIL_PATTERN.test(email.trim());
}
