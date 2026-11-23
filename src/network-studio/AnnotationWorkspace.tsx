import { useRef, useState, useId } from "react";
import type { PointerEvent } from "react";
import type { Annotation, AnnotationKind, Topology } from "./types.ts";
import { moveAnnotation, newAnnotation, putAnnotation } from "./annotations.ts";
import "./annotations.css";
type Shared = {
  topology: Topology;
  selected: string;
  onSelect: (id: string) => void;
  onCommit: (t: Topology) => unknown;
};
export type DrawingTool = "select" | AnnotationKind;
export function AnnotationControls({
  topology,
  selected,
  onSelect,
  onCommit,
  tool,
  onTool,
}: Shared & { tool: DrawingTool; onTool: (tool: DrawingTool) => void }) {
  const [error, setError] = useState("");
  const a = topology.annotations?.find((n) => n.id === selected);
  function add() {
    try {
      const next = newAnnotation(tool === "select" ? "note" : tool);
      if (onCommit(putAnnotation(topology, next)) !== false) {
        onSelect(next.id);
        onTool("select");
      }
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Annotation rejected.");
    }
  }
  return (
    <section className="ns-annotation-controls" aria-label="Drawing controls">
      <div
        className="ns-drawing-tools"
        role="group"
        aria-label="Annotation tools"
      >
        {(["select", "note", "line", "rectangle", "ellipse"] as const).map(
          (k) => (
            <button
              key={k}
              className="ns-button"
              aria-pressed={tool === k}
              onClick={() => onTool(k)}
            >
              {k === "select" ? "Move" : k[0].toUpperCase() + k.slice(1)}
            </button>
          ),
        )}
        <button className="ns-button" onClick={add}>
          Add {tool === "select" ? "note" : tool}
        </button>
      </div>
      <p>
        Choose a shape and drag on the canvas, or use Add. Move with a drag or
        arrow keys; edit size below.
      </p>
      <label>
        Selected annotation
        <select
          aria-label="Selected annotation"
          value={a?.id ?? ""}
          onChange={(e) => {
            onSelect(e.target.value);
            onTool("select");
          }}
        >
          <option value="">Choose an annotation</option>
          {topology.annotations?.map((n, i) => (
            <option key={n.id} value={n.id}>
              {i + 1}. {n.kind}
              {n.text ? `: ${n.text.slice(0, 35)}` : ""}
            </option>
          ))}
        </select>
      </label>
      {a && (
        <AnnotationEditor
          key={JSON.stringify(a)}
          annotation={a}
          onSave={(next) => {
            try {
              onCommit(putAnnotation(topology, next));
              setError("");
            } catch (e) {
              setError(e instanceof Error ? e.message : "Annotation rejected.");
            }
          }}
          onDelete={() =>
            onCommit({
              ...topology,
              annotations: topology.annotations?.filter((n) => n.id !== a.id),
            })
          }
          onRaise={() =>
            onCommit({
              ...topology,
              annotations: [
                ...(topology.annotations ?? []).filter((n) => n.id !== a.id),
                a,
              ],
            })
          }
        />
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
function AnnotationEditor({
  annotation: a,
  onSave,
  onDelete,
  onRaise,
}: {
  annotation: Annotation;
  onSave: (a: Annotation) => void;
  onDelete: () => void;
  onRaise: () => void;
}) {
  const [draft, setDraft] = useState(a);
  return (
    <form
      className="ns-annotation-editor"
      aria-label="Annotation editor"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(draft);
      }}
    >
      {a.kind === "note" && (
        <label className="ns-note-text">
          Note text
          <textarea
            aria-label="Note text"
            maxLength={2048}
            value={draft.text}
            onChange={(e) => setDraft({ ...draft, text: e.target.value })}
          />
        </label>
      )}
      {(["x", "y", "x2", "y2"] as const).map((key) => (
        <label key={key}>
          {key.toUpperCase()}
          <input
            aria-label={`Annotation ${key}`}
            required
            type="number"
            min="0"
            max={key.includes("x") ? 1120 : 710}
            step="1"
            value={draft[key]}
            onChange={(e) =>
              setDraft({ ...draft, [key]: e.target.valueAsNumber })
            }
          />
        </label>
      ))}
      <label>
        Color
        <input
          type="color"
          value={draft.color}
          onChange={(e) => setDraft({ ...draft, color: e.target.value })}
        />
      </label>
      {a.kind !== "line" && (
        <>
          <label className="ns-fill-toggle">
            <input
              type="checkbox"
              checked={draft.fill !== "none"}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  fill: e.target.checked ? "#172b46" : "none",
                })
              }
            />
            Fill
          </label>
          {draft.fill !== "none" && (
            <label>
              Fill color
              <input
                type="color"
                value={draft.fill}
                onChange={(e) => setDraft({ ...draft, fill: e.target.value })}
              />
            </label>
          )}
        </>
      )}
      {a.kind === "note" && (
        <label>
          Text size
          <input
            required
            type="number"
            min="10"
            max="40"
            value={draft.fontSize}
            onChange={(e) =>
              setDraft({ ...draft, fontSize: e.target.valueAsNumber })
            }
          />
        </label>
      )}
      <button className="ns-button ns-primary" type="submit">
        Apply annotation
      </button>
      <button className="ns-button" type="button" onClick={onRaise}>
        Bring to front
      </button>
      <button className="ns-button" type="button" onClick={onDelete}>
        Remove annotation
      </button>
    </form>
  );
}
const bound = (n: number, max: number) =>
  Math.round(Math.max(0, Math.min(max, n)));
export function AnnotationLayer({
  topology,
  selected,
  onSelect,
  onCommit,
  enabled,
  tool,
  onTool,
  onError,
}: Shared & {
  enabled: boolean;
  tool: DrawingTool;
  onTool: (tool: DrawingTool) => void;
  onError: (error: string) => void;
}) {
  const [draft, setDraft] = useState<Annotation | null>(null);
  const origin = useRef<{
    a: Annotation;
    x: number;
    y: number;
    drawing: boolean;
  } | null>(null);
  function point(e: PointerEvent<SVGSVGElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    return {
      x: bound(((e.clientX - box.left) * 1120) / box.width, 1120),
      y: bound(((e.clientY - box.top) * 710) / box.height, 710),
    };
  }
  function begin(e: PointerEvent<SVGSVGElement>) {
    if (!enabled || e.button !== 0) return;
    const p = point(e),
      id = (e.target as Element)
        .closest("[data-annotation]")
        ?.getAttribute("data-annotation");
    const existing = topology.annotations?.find((a) => a.id === id);
    if (tool === "select" && !existing) {
      onSelect("");
      return;
    }
    const a = tool === "select" ? existing! : newAnnotation(tool, p.x, p.y);
    onSelect(a.id);
    origin.current = { a, x: p.x, y: p.y, drawing: tool !== "select" };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDraft(a);
  }
  function preview(e: PointerEvent<SVGSVGElement>) {
    const o = origin.current;
    if (!o) return null;
    const p = point(e);
    return o.drawing
      ? o.a.kind === "note"
        ? o.a
        : { ...o.a, x2: p.x, y2: p.y }
      : moveAnnotation(o.a, p.x - o.x, p.y - o.y);
  }
  function end(e: PointerEvent<SVGSVGElement>) {
    const o = origin.current,
      next = preview(e);
    origin.current = null;
    setDraft(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
    if (!o || !next) return;
    try {
      if (JSON.stringify(next) !== JSON.stringify(o.a) || o.drawing) {
        if (onCommit(putAnnotation(topology, next)) !== false) onTool("select");
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : "Annotation rejected.");
    }
  }
  const items = (topology.annotations ?? []).map((a) =>
    draft?.id === a.id ? draft : a,
  );
  if (draft && !items.some((a) => a.id === draft.id)) items.push(draft);
  return (
    <svg
      className={`ns-annotation-layer ${enabled ? "editing" : ""}`}
      width="1120"
      height="710"
      viewBox="0 0 1120 710"
      aria-label="Canvas annotations"
      onPointerDown={begin}
      onPointerMove={(e) => setDraft(preview(e))}
      onPointerUp={end}
      onPointerCancel={() => {
        origin.current = null;
        setDraft(null);
      }}
    >
      {items.map((a, i) => (
        <g
          key={a.id}
          data-annotation={a.id}
          role={enabled ? "button" : undefined}
          tabIndex={enabled ? 0 : undefined}
          aria-label={`Annotation ${i + 1}: ${a.kind}${a.text ? ` ${a.text}` : ""}`}
          aria-pressed={enabled ? selected === a.id : undefined}
          onFocus={() => enabled && onSelect(a.id)}
          onKeyDown={(e) => {
            if (!enabled) return;
            const delta: Record<string, [number, number]> = {
              ArrowLeft: [-10, 0],
              ArrowRight: [10, 0],
              ArrowUp: [0, -10],
              ArrowDown: [0, 10],
            };
            if (delta[e.key]) {
              e.preventDefault();
              onCommit(
                putAnnotation(topology, moveAnnotation(a, ...delta[e.key])),
              );
            }
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onSelect(a.id);
              onTool("select");
            }
          }}
        >
          <AnnotationShape a={a} />
          {enabled && selected === a.id && (
            <rect
              className="ns-annotation-selection"
              x={Math.min(a.x, a.x2) - 4}
              y={Math.min(a.y, a.y2) - 4}
              width={Math.max(8, Math.abs(a.x2 - a.x)) + 8}
              height={Math.max(8, Math.abs(a.y2 - a.y)) + 8}
            />
          )}
        </g>
      ))}
    </svg>
  );
}
function AnnotationShape({ a }: { a: Annotation }) {
  const clip = useId(),
    x = Math.min(a.x, a.x2),
    y = Math.min(a.y, a.y2),
    w = Math.max(1, Math.abs(a.x2 - a.x)),
    h = Math.max(1, Math.abs(a.y2 - a.y));
  if (a.kind === "line")
    return (
      <>
        <line
          x1={a.x}
          y1={a.y}
          x2={a.x2}
          y2={a.y2}
          stroke={a.color}
          strokeWidth="2"
        />
        <line
          className="ns-annotation-hit"
          x1={a.x}
          y1={a.y}
          x2={a.x2}
          y2={a.y2}
        />
      </>
    );
  if (a.kind === "ellipse")
    return (
      <ellipse
        cx={x + w / 2}
        cy={y + h / 2}
        rx={w / 2}
        ry={h / 2}
        stroke={a.color}
        strokeWidth="2"
        fill={a.fill}
        className="ns-annotation-shape"
      />
    );
  if (a.kind === "rectangle")
    return (
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        stroke={a.color}
        strokeWidth="2"
        fill={a.fill}
        className="ns-annotation-shape"
      />
    );
  const chars = Math.max(1, Math.floor((w - 12) / (a.fontSize * 0.65))),
    lines = a.text
      .split("\n")
      .flatMap((line) => line.match(new RegExp(`.{1,${chars}}`, "gu")) ?? [""]);
  return (
    <>
      <defs>
        <clipPath id={clip}>
          <rect x={x} y={y} width={w} height={h} />
        </clipPath>
      </defs>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        fill={a.fill === "none" ? "transparent" : a.fill}
        className="ns-annotation-shape"
      />
      <text
        x={x + 6}
        y={y + a.fontSize + 4}
        fill={a.color}
        fontSize={a.fontSize}
        clipPath={`url(#${clip})`}
        pointerEvents="none"
      >
        {lines.map((line, i) => (
          <tspan key={i} x={x + 6} dy={i === 0 ? 0 : a.fontSize * 1.3}>
            {line}
          </tspan>
        ))}
      </text>
    </>
  );
}
