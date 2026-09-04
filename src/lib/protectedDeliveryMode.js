export const DELIVERY_MODES = Object.freeze({
  maintenance: 'maintenance',
  protected: 'protected',
});

const VALID_MODES = new Set(Object.values(DELIVERY_MODES));

export function parseProtectedDeliveryMode(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return VALID_MODES.has(normalized) ? normalized : DELIVERY_MODES.protected;
}

export const protectedDeliveryMode = parseProtectedDeliveryMode(
  import.meta.env?.VITE_CERTSIM_EXAM_DELIVERY_MODE,
);

export function canStartExamInDeliveryMode(mode = protectedDeliveryMode) {
  return parseProtectedDeliveryMode(mode) !== DELIVERY_MODES.maintenance;
}
