import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const mode = process.argv[2] === 'maintenance' ? 'maintenance' : 'protected';
const outputRoot = path.join(root, 'dist', mode);
const files = await walk(outputRoot);
assert.ok(files.length > 0, 'Protected build output is missing');
assert.equal(files.some((file) => /\.map$/i.test(file)), false, 'Protected source maps are prohibited');

const forbiddenNames = [
  'az204questionbank', 'az400questionbank', 'ai901questionbank',
  'sy0701questionbank', 'az400pbqdemolabs', 'az400casestudyblocks',
  'feedbackhelpers',
  'reviewhelpers', 'scoreexam', 'private vault', 'cert-sim-protected-content',
  'service_role',
];
const sentinelIds = [
  'sy0701-operations-expansion-012',
  'az204-compute-001',
  'ai901-generative-001',
  'az400-build-release-001',
];
const forbiddenStructures = [
  /["']correctAnswers?["']\s*:/i,
  /["'](?:scoringRules|scoringKeys|expectedAnswers?|acceptedAnswers?)["']\s*:/i,
  /["'](?:explanation|remediation)["']\s*:\s*["'`]/i,
  /sb_secret_[A-Za-z0-9_-]{20,}/,
];

let totalBytes = 0;
for (const file of files) {
  const info = await stat(file);
  totalBytes += info.size;
  if (info.size === 0 || isBinary(file)) continue;
  const content = await readFile(file, 'utf8');
  const normalized = content.toLowerCase();
  for (const marker of [...forbiddenNames, ...sentinelIds]) {
    assert.equal(normalized.includes(marker.toLowerCase()), false, `Protected custody marker detected (${fingerprint(marker)})`);
  }
  for (const structure of forbiddenStructures) {
    assert.equal(structure.test(content), false, `Protected scoring/review structure detected in ${path.relative(outputRoot, file)}`);
  }
}

if (mode === 'maintenance') {
  const text = (await Promise.all(files.filter((file) => !isBinary(file)).map((file) => readFile(file, 'utf8')))).join('\n');
  assert.ok(text.includes('CertSim is currently undergoing scheduled maintenance while we upgrade protected exam delivery'), 'maintenance boundary message is missing');
  assert.ok(text.includes('Platform Owner Access'), 'maintenance owner access action is missing');
  assert.ok(text.includes('Maintenance-safe shell'), 'maintenance-safe owner shell is missing');
  for (const prohibited of ['Continue anyway', 'Open site', 'Start protected attempt', 'Start exam']) {
    assert.equal(text.includes(prohibited), false, `maintenance bypass marker detected: ${prohibited}`);
  }
}

assert.ok(totalBytes < 8_000_000, 'Protected build exceeds the bounded custody size');
console.log(JSON.stringify({
  ok: true,
  mode,
  filesInspected: files.length,
  sourceMaps: 0,
  sentinelFingerprints: sentinelIds.map(fingerprint),
  totalBytes,
}));

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  }));
  return nested.flat();
}
function isBinary(file) { return /\.(png|jpe?g|gif|webp|ico|woff2?)$/i.test(file); }
function fingerprint(value) { return createHash('sha256').update(value).digest('hex').slice(0, 12); }
