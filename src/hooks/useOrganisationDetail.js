import { useCallback, useEffect, useState } from 'react';

import useCurrentIdentity from './useCurrentIdentity.js';
import {
  getCampusDetailSnapshot,
  getGroupDetailSnapshot,
  getOrganisationDetailSnapshot,
  updateCampus as updateCampusRecord,
  updateGroup as updateGroupRecord,
  updateOrganisation as updateOrganisationRecord,
} from '../lib/organisationManagementService.js';

const emptySnapshots = {
  campus: {
    campus: null,
    groups: [],
    memberships: [],
  },
  group: {
    assignments: [],
    group: null,
    savedResults: [],
    students: [],
  },
  organisation: {
    campuses: [],
    groups: [],
    memberships: [],
    organisation: null,
  },
};

const snapshotLoaders = {
  campus: getCampusDetailSnapshot,
  group: getGroupDetailSnapshot,
  organisation: getOrganisationDetailSnapshot,
};

const updateActions = {
  campus: updateCampusRecord,
  group: updateGroupRecord,
  organisation: updateOrganisationRecord,
};

export default function useOrganisationDetail(detailType, detailId) {
  const identity = useCurrentIdentity();
  const [snapshot, setSnapshot] = useState(
    emptySnapshots[detailType] ?? {},
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    if (identity.loading) {
      return { ok: false, reason: 'identity_loading' };
    }

    if (!identity.isSupabaseConfigured || !identity.isAuthenticated) {
      setSnapshot(emptySnapshots[detailType] ?? {});
      setError('');
      return { ok: false, reason: 'not_ready' };
    }

    const loader = snapshotLoaders[detailType];

    if (!loader || !detailId) {
      setSnapshot(emptySnapshots[detailType] ?? {});
      setError('Choose a valid scoped management record.');
      return { ok: false, reason: 'invalid_payload' };
    }

    setLoading(true);
    const result = await loader(detailId);

    if (result.ok) {
      setSnapshot(result.data ?? emptySnapshots[detailType] ?? {});
      setError('');
    } else {
      setSnapshot(emptySnapshots[detailType] ?? {});
      setError(result.message);
    }

    setLoading(false);
    return result;
  }, [
    detailId,
    detailType,
    identity.isAuthenticated,
    identity.isSupabaseConfigured,
    identity.loading,
  ]);

  useEffect(() => {
    refresh();
  }, [refresh, identity.primaryRole]);

  const updateDetail = useCallback(
    async (payload) => {
      const updateAction = updateActions[detailType];

      if (!updateAction || !detailId) {
        return {
          ok: false,
          reason: 'invalid_payload',
          message: 'Choose a valid scoped management record.',
        };
      }

      const result = await updateAction(detailId, payload);

      if (result.ok) {
        await refresh();
      } else {
        setError(result.message);
      }

      return result;
    },
    [detailId, detailType, refresh],
  );

  return {
    ...identity,
    snapshot,
    loading: identity.loading || loading,
    detailLoading: loading,
    error,
    refresh,
    updateDetail,
  };
}
