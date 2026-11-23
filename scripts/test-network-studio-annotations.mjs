import assert from "node:assert/strict";
import { test } from "node:test";
import {
  newAnnotation,
  putAnnotation,
  moveAnnotation,
  parseAnnotations,
} from "../src/network-studio/annotations.ts";
import { exampleTopology } from "../src/network-studio/model.ts";
import {
  parseTopology,
  serializeTopology,
} from "../src/network-studio/persistence.ts";
import { ping } from "../src/network-studio/engine.ts";
test("notes/shapes round-trip without changing forwarding or retaining unknown fields", () => {
  let t = exampleTopology();
  const original = ping(t, t.devices[0].id, "192.168.10.20");
  for (const kind of ["note", "line", "rectangle", "ellipse"])
    t = putAnnotation(t, {
      ...newAnnotation(kind),
      text: "<script>inert</script>\nVLAN 10",
    });
  const wire = JSON.parse(serializeTopology(t));
  wire.annotations[0].onclick = "injected";
  const copy = parseTopology(JSON.stringify(wire));
  assert.equal(copy.annotations.length, 4);
  assert.equal("onclick" in copy.annotations[0], false);
  assert.equal(copy.annotations[0].text, "<script>inert</script>\nVLAN 10");
  assert.deepEqual(ping(copy, copy.devices[0].id, "192.168.10.20"), original);
});
test("annotation imports reject unsupported styles, geometry, duplicate IDs and resource excess", () => {
  const a = newAnnotation("rectangle");
  for (const patch of [
    { kind: "html" },
    { x: NaN },
    { x2: 1121 },
    { y: -1 },
    { y2: 1.5 },
    { fontSize: 41 },
    { color: "url(x)" },
    { fill: "red" },
    { text: "x".repeat(2049) },
    { text: "\u0000" },
  ])
    assert.throws(() => parseAnnotations([{ ...a, ...patch }]));
  assert.throws(() => parseAnnotations([a, a]));
  assert.throws(() =>
    parseAnnotations(
      Array.from({ length: 257 }, (_, i) => ({ ...a, id: String(i) })),
    ),
  );
  assert.equal(
    parseAnnotations([{ ...a, text: "line one\nline two" }])[0].text,
    "line one\nline two",
  );
});
test("movement keeps reverse-direction shapes together within the logical canvas", () => {
  const a = { ...newAnnotation("line"), x: 1000, x2: 100, y: 700, y2: 10 };
  assert.deepEqual(moveAnnotation(a, 1000, -1000), {
    ...a,
    x: 1120,
    x2: 220,
    y: 690,
    y2: 0,
  });
  const t = exampleTopology(),
    one = putAnnotation(t, a),
    two = putAnnotation(one, moveAnnotation(a, -10, 0));
  assert.equal(one.annotations[0].x, 1000);
  assert.equal(two.annotations.length, 1);
  assert.equal(two.annotations[0].x, 990);
  assert.equal(t.annotations, undefined);
});
test("optional annotations preserve older files and malformed annotations reject the whole import", () => {
  const t = exampleTopology(),
    json = serializeTopology(t);
  assert.equal(parseTopology(json).annotations, undefined);
  const wire = JSON.parse(json);
  wire.annotations = [
    { ...newAnnotation("note"), fill: "url(https://example.invalid)" },
  ];
  assert.throws(() => parseTopology(JSON.stringify(wire)));
  assert.equal(serializeTopology(t), json);
  let full = t;
  for (let i = 0; i < 256; i++)
    full = putAnnotation(full, newAnnotation("note"));
  assert.throws(() => putAnnotation(full, newAnnotation("note")));
  assert.equal(full.annotations.length, 256);
});
