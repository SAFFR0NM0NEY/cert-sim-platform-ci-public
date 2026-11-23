import type { NetworkRuntime } from "./networkRuntime.ts";
/** Pure link-state read. BPDU reception is processed only at simulation boundaries. */
export const bpduGuardDown = (
  r: NetworkRuntime,
  device: string,
  port: string,
): boolean =>
  !!r.bpduPorts?.some(
    (s) => s.device === device && s.port === port && s.shutdownAt !== undefined,
  );
