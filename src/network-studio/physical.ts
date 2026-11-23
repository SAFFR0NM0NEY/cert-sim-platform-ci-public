import type {
  Device,
  PhysicalLayout,
  PhysicalLocation,
  Topology,
} from "./types.ts";
import { integer, list, object, text, unique } from "./validation.ts";
export function parsePhysical(
  value: unknown,
  devices: Device[],
): PhysicalLayout {
  const raw = object(value);
  const locations = list(raw.locations, 64).map((value) => {
    const l = object(value);
    if (!["city", "building", "closet"].includes(String(l.kind)))
      throw new Error("Unknown physical location type.");
    return {
      id: text(l.id, 80),
      name: text(l.name, 64),
      kind: l.kind as PhysicalLocation["kind"],
      parent: l.parent === null ? null : text(l.parent, 80),
    };
  });
  unique(locations.map((l) => l.id));
  for (const l of locations) {
    const parent = locations.find((p) => p.id === l.parent);
    if (
      l.kind === "city"
        ? l.parent !== null
        : !parent ||
          parent.kind !== (l.kind === "building" ? "city" : "building")
    )
      throw new Error(
        "Physical locations must follow city → building → closet hierarchy.",
      );
  }
  const placements = list(raw.placements, 128).map((value) => {
    const p = object(value),
      device = text(p.device, 80),
      location = text(p.location, 80),
      unit = integer(p.unit, 0, 42);
    if (
      !devices.some((d) => d.id === device) ||
      locations.find((l) => l.id === location)?.kind !== "closet"
    )
      throw new Error(
        "Physical placement requires an existing device and closet.",
      );
    return { device, location, unit };
  });
  if (new Set(placements.map((p) => p.device)).size !== placements.length)
    throw new Error("Each device can have only one physical placement.");
  const occupied = placements
    .filter((p) => p.unit > 0)
    .map((p) => `${p.location}/${p.unit}`);
  if (new Set(occupied).size !== occupied.length)
    throw new Error("Rack unit is already occupied in this closet.");
  return { locations, placements };
}
export function addLocation(
  t: Topology,
  name: string,
  parent: string | null,
): Topology {
  const layout = t.physical ?? { locations: [], placements: [] },
    parentLocation = layout.locations.find((l) => l.id === parent);
  if (parent !== null && !parentLocation)
    throw new Error("Parent location does not exist.");
  if (parentLocation?.kind === "closet")
    throw new Error("Closets cannot contain child locations.");
  const location: PhysicalLocation = {
    id: crypto.randomUUID(),
    name,
    parent,
    kind: !parentLocation
      ? "city"
      : parentLocation.kind === "city"
        ? "building"
        : "closet",
  };
  const next = {
    locations: [...layout.locations, location],
    placements: layout.placements,
  };
  return { ...t, physical: parsePhysical(next, t.devices) };
}
export function placeDevice(
  t: Topology,
  device: string,
  location: string,
  unit: number,
): Topology {
  const layout = t.physical ?? { locations: [], placements: [] };
  return {
    ...t,
    physical: parsePhysical(
      {
        ...layout,
        placements: [
          ...layout.placements.filter((p) => p.device !== device),
          { device, location, unit },
        ],
      },
      t.devices,
    ),
  };
}
export function removeLocation(t: Topology, id: string): Topology {
  if (!t.physical?.locations.some((l) => l.id === id))
    throw new Error("Location does not exist.");
  if (
    t.physical.locations.some((l) => l.parent === id) ||
    t.physical.placements.some((p) => p.location === id)
  )
    throw new Error("Move devices and remove child locations first.");
  return {
    ...t,
    physical: {
      ...t.physical,
      locations: t.physical.locations.filter((l) => l.id !== id),
    },
  };
}
export function setCableLength(
  t: Topology,
  id: string,
  length?: number,
): Topology {
  if (!t.links.some((l) => l.id === id))
    throw new Error("Cable does not exist.");
  if (
    length !== undefined &&
    (!Number.isFinite(length) || length < 0 || length > 1_000_000)
  )
    throw new Error("Cable length must be between 0 and 1,000,000 metres.");
  return {
    ...t,
    links: t.links.map((l) => {
      if (l.id !== id) return l;
      const next = { ...l };
      if (length === undefined) delete next.lengthMeters;
      else next.lengthMeters = length;
      return next;
    }),
  };
}
