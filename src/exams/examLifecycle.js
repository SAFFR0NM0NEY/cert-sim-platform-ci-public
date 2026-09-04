export const EXAM_LIFECYCLES = Object.freeze({
  draft: 'draft',
  controlledBeta: 'controlledBeta',
  productionReady: 'productionReady',
  nearRetirement: 'nearRetirement',
  retired: 'retired',
  archived: 'archived',
  preview: 'preview',
});

export const EXAM_LIFECYCLE_LABELS = Object.freeze({
  [EXAM_LIFECYCLES.draft]: 'Draft',
  [EXAM_LIFECYCLES.controlledBeta]: 'Controlled beta',
  [EXAM_LIFECYCLES.productionReady]: 'Production-ready',
  [EXAM_LIFECYCLES.nearRetirement]: 'Near-retirement support',
  [EXAM_LIFECYCLES.retired]: 'Retired support',
  [EXAM_LIFECYCLES.archived]: 'Archived',
  [EXAM_LIFECYCLES.preview]: 'Preview',
});

export const LIVE_VISIBLE_EXAM_LIFECYCLES = new Set([
  EXAM_LIFECYCLES.productionReady,
  EXAM_LIFECYCLES.nearRetirement,
  EXAM_LIFECYCLES.controlledBeta,
]);

export const STARTABLE_EXAM_LIFECYCLES = new Set([
  EXAM_LIFECYCLES.productionReady,
  EXAM_LIFECYCLES.nearRetirement,
  EXAM_LIFECYCLES.controlledBeta,
]);

export function getExamLifecycle(examConfig) {
  return examConfig?.lifecycle ?? normalizeLegacyStatus(examConfig?.status);
}

export function isLiveVisibleLifecycle(lifecycle) {
  return LIVE_VISIBLE_EXAM_LIFECYCLES.has(lifecycle);
}

export function isStartableLifecycle(lifecycle) {
  return STARTABLE_EXAM_LIFECYCLES.has(lifecycle);
}

export function isDraftLifecycle(lifecycle) {
  return lifecycle === EXAM_LIFECYCLES.draft;
}

export function isProductionReadyLifecycle(lifecycle) {
  return lifecycle === EXAM_LIFECYCLES.productionReady;
}

export function getLifecycleStatusLabel(lifecycle) {
  return EXAM_LIFECYCLE_LABELS[lifecycle] ?? 'Draft';
}

export function getLifecycleStatusDescription(lifecycle) {
  if (lifecycle === EXAM_LIFECYCLES.productionReady) {
    return 'Production-ready module';
  }

  if (lifecycle === EXAM_LIFECYCLES.nearRetirement) {
    return 'Current student support module';
  }

  if (lifecycle === EXAM_LIFECYCLES.controlledBeta) {
    return 'Controlled beta module';
  }

  if (lifecycle === EXAM_LIFECYCLES.retired) {
    return 'Retired support module';
  }

  if (lifecycle === EXAM_LIFECYCLES.preview) {
    return 'Preview module';
  }

  if (lifecycle === EXAM_LIFECYCLES.archived) {
    return 'Archived module';
  }

  return 'Hidden unless draft access is enabled';
}

function normalizeLegacyStatus(status) {
  if (status === 'active') {
    return EXAM_LIFECYCLES.productionReady;
  }

  if (status === 'internalBeta') {
    return EXAM_LIFECYCLES.controlledBeta;
  }

  if (status === 'draft') {
    return EXAM_LIFECYCLES.draft;
  }

  if (Object.values(EXAM_LIFECYCLES).includes(status)) {
    return status;
  }

  return EXAM_LIFECYCLES.draft;
}
