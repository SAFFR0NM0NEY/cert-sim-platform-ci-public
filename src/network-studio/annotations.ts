import type { Annotation, AnnotationKind, Topology } from "./types.ts";
import { integer, list, object, text, unique } from "./validation.ts";
export const MAX_ANNOTATIONS = 256;
export function parseAnnotations(value: unknown): Annotation[] {
  const result = list(value, MAX_ANNOTATIONS).map((entry): Annotation => {
    const a = object(entry);
    if (!["note", "line", "rectangle", "ellipse"].includes(String(a.kind)))
      throw new Error("Unsupported annotation kind.");
    const color = a.color,
      fill = a.fill;
    if (
      typeof color !== "string" ||
      typeof fill !== "string" ||
      !/^#[0-9a-f]{6}$/i.test(color) ||
      (fill !== "none" && !/^#[0-9a-f]{6}$/i.test(fill))
    )
      throw new Error(
        "Annotation colors must be six-digit hex colors or no fill.",
      );
    if (
      typeof a.text !== "string" ||
      a.text.length > 2048 ||
      /[\u0000-\u0008\u000b-\u001f]/.test(a.text)
    )
      throw new Error("Annotation text must be at most 2048 characters.");
    return {
      id: text(a.id, 80),
      kind: a.kind as AnnotationKind,
      x: integer(a.x, 0, 1120),
      y: integer(a.y, 0, 710),
      x2: integer(a.x2, 0, 1120),
      y2: integer(a.y2, 0, 710),
      text: a.text,
      color,
      fill,
      fontSize: integer(a.fontSize, 10, 40),
    };
  });
  unique(result.map((a) => a.id));
  return result;
}
export function newAnnotation(
  kind: AnnotationKind,
  x = 100,
  y = 100,
): Annotation {
  return {
    id: crypto.randomUUID(),
    kind,
    x,
    y,
    x2: Math.min(1120, x + 220),
    y2: Math.min(710, y + 100),
    text: kind === "note" ? "New note" : "",
    color: "#38bdf8",
    fill: "none",
    fontSize: 18,
  };
}
export function putAnnotation(t: Topology, a: Annotation): Topology {
  const current = t.annotations ?? [];
  const next = current.some((n) => n.id === a.id)
    ? current.map((n) => (n.id === a.id ? a : n))
    : [...current, a];
  return { ...t, annotations: parseAnnotations(next) };
}
export function moveAnnotation(
  a: Annotation,
  dx: number,
  dy: number,
): Annotation {
  dx = Math.round(
    Math.max(-Math.min(a.x, a.x2), Math.min(1120 - Math.max(a.x, a.x2), dx)),
  );
  dy = Math.round(
    Math.max(-Math.min(a.y, a.y2), Math.min(710 - Math.max(a.y, a.y2), dy)),
  );
  return { ...a, x: a.x + dx, y: a.y + dy, x2: a.x2 + dx, y2: a.y2 + dy };
}
