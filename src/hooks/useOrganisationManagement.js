import { useCallback, useEffect, useState } from 'react';

import useCurrentIdentity from './useCurrentIdentity.js';
import {
  createCampus as createCampusRecord,
  createGroup as createGroupRecord,
  createMembership as createMembershipRecord,
  createOrganisation as createOrganisationRecord,
  getOrganisationManagementSnapshot,
  removeMembershipRole as removeMembershipRoleRecord,
  updateMembershipStatus as updateMembershipStatusRecord,
} from '../lib/organisationManagementService.js';
import {
  updateManagedProfileDisplayName,
  updateManagedProfileStatus,
} from '../lib/profileService.js';

const emptySnapshot = {
  organisations: [],
  campuses: [],
  groups: [],
  profiles: [],
  memberships: [],
};

export default function useOrganisationManagement() {
  const identity = useCurrentIdentity();
  const [snapshot, setSnapshot] = useState(emptySnapshot);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    if (identity.loading) {
      return { ok: false, reason: 'identity_loading' };
    }

    if (!identity.isSupabaseConfigured || !identity.isAuthenticated) {
      setSnapshot(emptySnapshot);
      setError('');
      return { ok: false, reason: 'not_ready' };
    }

    setLoading(true);
    const result = await getOrganisationManagementSnapshot();

    if (result.ok) {
      setSnapshot(result.data ?? emptySnapshot);
      setError('');
    } else {
      setSnapshot(emptySnapshot);
      setError(result.message);
    }

    setLoading(false);
    return result;
  }, [
    identity.isAuthenticated,
    identity.isSupabaseConfigured,
    identity.loading,
  ]);

  useEffect(() => {
    refresh();
  }, [refresh, identity.isPlatformOwner]);

  const runMutation = useCallback(
    async (action) => {
      const result = await action();

      if (result.ok) {
        await refresh();
      } else {
        setError(result.message);
      }

      return result;
    },
    [refresh],
  );

  const createOrganisation = useCallback(
    (payload) => runMutation(() => createOrganisationRecord(payload)),
    [runMutation],
  );
  const createCampus = useCallback(
    (payload) => runMutation(() => createCampusRecord(payload)),
    [runMutation],
  );
  const createGroup = useCallback(
    (payload) => runMutation(() => createGroupRecord(payload)),
    [runMutation],
  );
  const createMembership = useCallback(
    (payload) => runMutation(() => createMembershipRecord(payload)),
    [runMutation],
  );
  const updateMembershipStatus = useCallback(
    (membershipId, status) =>
      runMutation(() => updateMembershipStatusRecord(membershipId, status)),
    [runMutation],
  );
  const removeMembershipRole = useCallback(
    (membershipId) =>
      runMutation(() => removeMembershipRoleRecord(membershipId)),
    [runMutation],
  );
  const updateProfileDisplayName = useCallback(
    (payload) => runMutation(() => updateManagedProfileDisplayName(payload)),
    [runMutation],
  );
  const updateProfileStatus = useCallback(
    (payload) => runMutation(() => updateManagedProfileStatus(payload)),
    [runMutation],
  );

  return {
    ...identity,
    snapshot,
    organisations: snapshot.organisations,
    campuses: snapshot.campuses,
    groups: snapshot.groups,
    profiles: snapshot.profiles,
    memberships: snapshot.memberships,
    loading: identity.loading || loading,
    managementLoading: loading,
    error,
    refresh,
    createOrganisation,
    createCampus,
    createGroup,
    createMembership,
    removeMembershipRole,
    updateMembershipStatus,
    updateProfileDisplayName,
    updateProfileStatus,
  };
}
