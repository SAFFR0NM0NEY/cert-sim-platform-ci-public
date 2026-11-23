import type { PduScenario, Topology } from "./types.ts";
import { list, object, text, unique } from "./validation.ts";
export const DEFAULT_SCENARIO_ID = "default";
export const MAX_SCENARIOS = 32;
export function scenariosFor(t: Topology): PduScenario[] {
  return (
    t.scenarios ?? [
      { id: DEFAULT_SCENARIO_ID, name: "Scenario 0", description: "" },
    ]
  );
}
export function activePdus(t: Topology) {
  return (t.pdus ?? []).filter(
    (p) =>
      (p.scenario ?? DEFAULT_SCENARIO_ID) ===
      (t.activeScenario ?? DEFAULT_SCENARIO_ID),
  );
}
export function parseScenarios(value: unknown): PduScenario[] {
  const entries = list(value, MAX_SCENARIOS).map((raw) => {
    const s = object(raw);
    return {
      id: text(s.id, 80),
      name: text(s.name, 48),
      description: text(s.description, 300, true),
    };
  });
  unique(entries.map((s) => s.id));
  unique(entries.map((s) => s.name.trim().toLowerCase()));
  if (!entries.some((s) => s.id === DEFAULT_SCENARIO_ID))
    throw Error("The default scenario is missing.");
  return entries;
}
export function removeScenario(t: Topology, id: string): Topology {
  if (id === DEFAULT_SCENARIO_ID || !scenariosFor(t).some((s) => s.id === id))
    return t;
  return {
    ...t,
    scenarios: scenariosFor(t).filter((s) => s.id !== id),
    pdus: (t.pdus ?? []).filter((p) => p.scenario !== id),
    activeScenario:
      t.activeScenario === id ? DEFAULT_SCENARIO_ID : t.activeScenario,
  };
}
