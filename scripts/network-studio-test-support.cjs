const { AssertionError } = require("node:assert");
const { createHash } = require("node:crypto");

function bytes(value) {
  if (!(value instanceof Uint8Array))
    throw new TypeError("Binary comparison requires Buffer or Uint8Array.");
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function summary(value) {
  return {
    bytes: value.byteLength,
    sha256: createHash("sha256").update(value).digest("hex"),
  };
}

// Never pass binary payloads to an assertion reporter: a generated diff can
// consume far more memory than the files and expose their private contents.
function assertSameBytes(actual, expected, context = "Native file") {
  const left = bytes(actual);
  const right = bytes(expected);
  if (left.equals(right)) return;
  const label =
    typeof context === "string"
      ? context.slice(0, 80).replace(/\s+/g, " ")
      : "Native file";
  throw new AssertionError({
    message: label + ": binary contents differ (lengths and SHA-256 only).",
    actual: summary(left),
    expected: summary(right),
    operator: "sameBytes",
    stackStartFn: assertSameBytes,
  });
}

module.exports = { assertSameBytes };
