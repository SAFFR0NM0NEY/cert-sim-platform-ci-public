import { useCallback, useEffect, useState } from 'react';

import useCurrentIdentity from './useCurrentIdentity.js';
import {
  getReceptionPlacementResults,
  updatePlacementAssessmentResult,
} from '../lib/placementResultService.js';

const emptySnapshot = {
  results: [],
  totals: {
    total: 0,
    new: 0,
    contacted: 0,
    scheduled: 0,
    enrolled: 0,
    notInterested: 0,
    archived: 0,
  },
};

export default function useReceptionPlacementResults() {
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
    const result = await getReceptionPlacementResults();

    if (result.ok) {
      setSnapshot(createSnapshot(result.data ?? []));
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
  }, [refresh, identity.isPlatformOwner, identity.primaryRole]);

  const updateResult = useCallback(
    async (payload) => {
      const result = await updatePlacementAssessmentResult(payload);

      if (result.ok) {
        await refresh();
      } else {
        setError(result.message);
      }

      return result;
    },
    [refresh],
  );

  return {
    ...identity,
    results: snapshot.results,
    totals: snapshot.totals,
    loading: identity.loading || loading,
    dashboardLoading: loading,
    error,
    refresh,
    updateResult,
  };
}

function createSnapshot(results) {
  const totals = {
    total: results.length,
    new: 0,
    contacted: 0,
    scheduled: 0,
    enrolled: 0,
    notInterested: 0,
    archived: 0,
  };

  results.forEach((result) => {
    if (result.status === 'not_interested') {
      totals.notInterested += 1;
      return;
    }

    if (Object.prototype.hasOwnProperty.call(totals, result.status)) {
      totals[result.status] += 1;
    }
  });

  return {
    results,
    totals,
  };
}
