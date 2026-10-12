import { useCallback, useEffect, useRef, useState } from 'react';

import useCurrentIdentity from './useCurrentIdentity.js';
import {
  createBulkGroupInvites,
  createGroupAccessCode,
  createOnboardingInvite,
  disableGroupAccessCode,
  listOnboardingRecords,
  revokeOnboardingInvite,
} from '../lib/onboardingService.js';

const emptyRecords = {
  accessCodes: [],
  invites: [],
};

export default function useOnboarding({
  scopeType,
  organisationId = '',
  campusId = '',
  groupId = '',
  enabled = true,
} = {}) {
  const identity = useCurrentIdentity();
  const scopeKey = [
    scopeType,
    organisationId,
    campusId,
    groupId,
    enabled ? 'enabled' : 'disabled',
  ].join(':');
  const latestScopeKeyRef = useRef(scopeKey);
  latestScopeKeyRef.current = scopeKey;
  const [records, setRecords] = useState(emptyRecords);
  const [loadingRecords, setLoadingRecords] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    const requestScopeKey = scopeKey;

    if (!enabled || identity.loading) {
      return { ok: false, reason: 'not_ready' };
    }

    if (!identity.isSupabaseConfigured || !identity.isAuthenticated) {
      setRecords(emptyRecords);
      setError('');
      return { ok: false, reason: 'not_ready' };
    }

    setLoadingRecords(true);
    const result = await listOnboardingRecords({
      scopeType,
      organisationId,
      campusId,
      groupId,
    });

    if (latestScopeKeyRef.current !== requestScopeKey) {
      setLoadingRecords(false);
      return { ok: false, reason: 'stale_scope' };
    }

    if (result.ok) {
      setRecords(result.data ?? emptyRecords);
      setError('');
    } else {
      setRecords(emptyRecords);
      setError(result.message);
    }

    setLoadingRecords(false);
    return result;
  }, [
    campusId,
    enabled,
    groupId,
    identity.isAuthenticated,
    identity.isSupabaseConfigured,
    identity.loading,
    organisationId,
    scopeKey,
    scopeType,
  ]);

  useEffect(() => {
    refresh();
  }, [refresh, identity.primaryRole]);

  useEffect(() => {
    setRecords(emptyRecords);
    setError('');
  }, [scopeKey]);

  const createInvite = useCallback(
    async (payload) => runMutation(
      () => createOnboardingInvite(payload),
      refresh,
    ),
    [refresh],
  );

  const revokeInvite = useCallback(
    async (inviteId) => runMutation(
      () => revokeOnboardingInvite(inviteId),
      refresh,
    ),
    [refresh],
  );

  const createAccessCode = useCallback(
    async (payload) => runMutation(
      () => createGroupAccessCode(payload),
      refresh,
    ),
    [refresh],
  );

  const disableAccessCode = useCallback(
    async (codeId) => runMutation(
      () => disableGroupAccessCode(codeId),
      refresh,
    ),
    [refresh],
  );

  const createBulkInvites = useCallback(
    async (payload) => runMutation(
      () => createBulkGroupInvites(payload),
      refresh,
    ),
    [refresh],
  );

  return {
    ...identity,
    accessCodes: records.accessCodes,
    invites: records.invites,
    loading: identity.loading || loadingRecords,
    onboardingLoading: loadingRecords,
    error,
    refresh,
    createInvite,
    revokeInvite,
    createAccessCode,
    disableAccessCode,
    createBulkInvites,
  };
}

async function runMutation(action, refresh) {
  const result = await action();

  if (result.ok) {
    await refresh();
  }

  return result;
}
