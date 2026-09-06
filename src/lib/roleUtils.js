export const ROLE_LABELS = {
  platform_owner: 'Platform Owner',
  developer: 'Developer',
  college_admin: 'College Admin',
  campus_admin: 'Campus Admin',
  trainer: 'Trainer',
  reception: 'Reception',
  student: 'Student',
  individual_user: 'Individual User',
};

export const ROLE_PRIORITY = [
  'platform_owner',
  'developer',
  'college_admin',
  'campus_admin',
  'trainer',
  'reception',
  'student',
  'individual_user',
];

export function getRoleLabel(role) {
  return ROLE_LABELS[role] ?? formatUnknownRole(role);
}

export function getPrimaryRole(memberships = [], fallbackRole = '') {
  const activeRoles = new Set(
    memberships
      .filter((membership) => membership?.status === 'active')
      .map((membership) => membership.role)
      .filter(Boolean),
  );

  const primaryRole = ROLE_PRIORITY.find((role) => activeRoles.has(role));

  return primaryRole ?? fallbackRole ?? '';
}

export function isPlatformOwnerRole(role) {
  return role === 'platform_owner';
}

export function isDeveloperRole(role) {
  return role === 'developer';
}

export function hasActiveMembershipRole(memberships = [], allowedRoles = []) {
  const allowedRoleSet = new Set(allowedRoles);

  return memberships.some(
    (membership) =>
      allowedRoleSet.has(membership?.role) && membership?.status === 'active',
  );
}

export function hasDeveloperDashboardAccess(identity = {}) {
  return (
    Boolean(identity?.isPlatformOwner) ||
    hasActiveMembershipRole(identity?.memberships, ['developer'])
  );
}

export function hasScopedPerformanceDashboardAccess(identity = {}) {
  return (
    Boolean(identity?.isPlatformOwner) ||
    hasActiveMembershipRole(identity?.memberships, [
      'developer',
      'college_admin',
      'campus_admin',
      'trainer',
    ])
  );
}

export function hasReceptionPlacementDashboardAccess(identity = {}) {
  return (
    Boolean(identity?.isPlatformOwner) ||
    hasActiveMembershipRole(identity?.memberships, [
      'developer',
      'college_admin',
      'campus_admin',
      'reception',
    ])
  );
}

export function formatMembershipLabel(membership) {
  if (!membership) {
    return '';
  }

  const roleLabel = getRoleLabel(membership.role);
  const scopeParts = [
    membership.organisation?.name,
    membership.campus?.name,
    membership.group?.name,
  ].filter(Boolean);

  return scopeParts.length > 0
    ? `${roleLabel} - ${scopeParts.join(' / ')}`
    : roleLabel;
}

function formatUnknownRole(role) {
  if (!role) {
    return 'Unassigned role';
  }

  return String(role)
    .split('_')
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}
