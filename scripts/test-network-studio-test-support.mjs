import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertSameBytes } from "./network-studio-test-support.cjs";

test("binary comparisons check exact bytes, empty inputs and sliced views", () => {
  assertSameBytes(Buffer.from([0, 127, 255]), new Uint8Array([0, 127, 255]));
  assertSameBytes(Buffer.alloc(0), new Uint8Array());
  const storage = new Uint8Array([99, 1, 2, 3, 77]);
  assertSameBytes(storage.subarray(1, 4), Buffer.from([1, 2, 3]));
  assert.throws(() =>
    assertSameBytes(storage.subarray(1, 4), Buffer.from([1, 2, 4])),
  );
  assert.throws(() =>
    assertSameBytes(Buffer.from([1, 2]), Buffer.from([1, 2, 0])),
  );
});

test("binary failures retain only bounded metadata, never file contents", () => {
  const actual = Buffer.from("private sample content");
  const expected = Buffer.from("different sample contents");
  assert.throws(
    () => assertSameBytes(actual, expected, "X".repeat(10000)),
    (error) => {
      assert.equal(error.code, "ERR_ASSERTION");
      assert.equal(error.actual.bytes, actual.length);
      assert.equal(error.expected.bytes, expected.length);
      assert.match(error.actual.sha256, /^[a-f0-9]{64}$/);
      assert.notEqual(error.actual.sha256, error.expected.sha256);
      assert.ok(error.message.length < 160);
      const report = JSON.stringify(error);
      assert.ok(report.length < 700);
      assert.ok(!report.includes("sample content"));
      assert.equal(Buffer.isBuffer(error.actual), false);
      return true;
    },
  );
});

test("binary comparison rejects invalid inputs without rendering them", () => {
  const invalid = {
    toString() {
      throw Error("Do not inspect payloads");
    },
  };
  assert.throws(() => assertSameBytes(invalid, Buffer.alloc(0)), TypeError);
  assert.throws(() => assertSameBytes(Buffer.alloc(0), "text"), TypeError);
});

test("large binary mismatch exits promptly with a small diagnostic under a limited heap", () => {
  const helper = fileURLToPath(
    new URL("./network-studio-test-support.cjs", import.meta.url),
  );
  const script = [
    "const {assertSameBytes}=require(process.argv[1]);",
    "const left=Buffer.alloc(8*1024*1024,65);",
    "const right=Buffer.from(left);right[right.length-1]=66;",
    "assertSameBytes(left,right,'Large synthetic native file');",
  ].join("\n");
  const result = spawnSync(
    process.execPath,
    ["--max-old-space-size=64", "-e", script, helper],
    {
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 8192,
      windowsHide: true,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.signal, null);
  assert.ok(result.stdout.length + result.stderr.length < 4096);
  assert.match(result.stderr, /binary contents differ/);
  assert.match(result.stderr, /8388608/);
  assert.ok(!result.stderr.includes("AAAAAAAA"));
});
