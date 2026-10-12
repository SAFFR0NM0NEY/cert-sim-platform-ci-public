import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const migrationsDirectory = path.join(projectRoot, 'supabase', 'migrations');
const expectedMigrationName = '20260101000013_protected_exam_delivery_foundation.sql';
const expectedMigrationPath = path.join(migrationsDirectory, expectedMigrationName);

const expectedTypes = [
  'package_publication_status',
  'publication_run_status',
  'attempt_status',
  'review_release_status',
];

const expectedTables = [
  'package_versions',
  'package_profiles',
  'package_questions',
  'package_question_protected_content',
  'publication_runs',
  'pilot_gates',
  'pilot_access',
  'attempts',
  'attempt_items',
  'attempt_item_protected_content',
  'attempt_responses',
  'attempt_results',
  'review_snapshots',
];

const expectedFunctions = [
  'guard_package_version_immutability',
  'guard_package_child_mutation',
  'guard_attempt_identity_and_lifecycle',
  'guard_attempt_response_mutation',
  'reject_immutable_row_mutation',
  'guard_review_release',
];

const expectedConstraints = [
  'package_versions_exam_key_nonempty',
  'package_versions_source_commit_sha_check',
  'package_versions_validation_hash_check',
  'package_versions_package_hash_check',
  'package_versions_lifecycle_timestamps_check',
  'package_versions_exam_version_unique',
  'package_versions_package_hash_unique',
  'package_question_protected_question_fk',
  'pilot_access_user_exam_unique',
  'attempts_package_profile_fk',
  'attempts_expiry_order_check',
  'attempts_lifecycle_timestamps_check',
  'attempts_owner_request_unique',
  'attempt_items_attempt_version_fk',
  'attempt_items_package_question_fk',
  'attempt_items_attempt_number_unique',
  'attempt_items_attempt_question_unique',
  'attempt_item_protected_item_fk',
  'attempt_responses_item_fk',
  'attempt_responses_attempt_item_unique',
  'attempt_results_score_bounds_check',
  'attempt_results_percentage_check',
  'attempt_results_server_authoritative_check',
  'review_snapshots_release_state_check',
];

const expectedIndexes = [
  'package_versions_supersedes_idx',
  'package_versions_publication_selection_idx',
  'publication_runs_package_version_idx',
  'publication_runs_actor_user_idx',
  'package_question_protected_version_idx',
  'pilot_access_exam_key_idx',
  'pilot_access_exam_user_idx',
  'attempts_owner_status_idx',
  'attempts_package_version_idx',
  'attempts_package_profile_idx',
  'attempts_active_expiry_idx',
  'attempt_items_package_question_idx',
  'attempt_item_protected_attempt_idx',
];

const errors = [];
const migrationNames = (await readdir(migrationsDirectory))
  .filter((name) => name.endsWith('.sql'));
const protectedMigrationNames = migrationNames.filter(
  (name) => name === expectedMigrationName || /protected.*exam.*delivery.*foundation/i.test(name),
);

if (protectedMigrationNames.length !== 1 || protectedMigrationNames[0] !== expectedMigrationName) {
  errors.push(
    `Expected exactly one protected-delivery migration named ${expectedMigrationName}; found: ${protectedMigrationNames.join(', ') || 'none'}.`,
  );
}

let sql = '';

try {
  sql = await readFile(expectedMigrationPath, 'utf8');
} catch (error) {
  errors.push(`Cannot read ${expectedMigrationName}: ${error.message}`);
}

assertMatch(
  /create\s+schema\s+if\s+not\s+exists\s+exam_delivery\s*;/i,
  'The private exam_delivery schema is not created.',
);

for (const typeName of expectedTypes) {
  assertMatch(
    new RegExp(`create\\s+type\\s+exam_delivery\\.${typeName}\\s+as\\s+enum`, 'i'),
    `Missing expected exam_delivery.${typeName} enum.`,
  );
  assertMatch(
    new RegExp(`revoke\\s+usage\\s+on\\s+type\\s+exam_delivery\\.${typeName}[\\s\\S]*?from\\s+public,\\s*anon,\\s*authenticated,\\s*service_role\\s*;`, 'i'),
    `Missing explicit browser/server-role type-usage revoke for ${typeName}.`,
  );
}

for (const tableName of expectedTables) {
  assertMatch(
    new RegExp(`create\\s+table\\s+exam_delivery\\.${tableName}\\s*\\(`, 'i'),
    `Missing expected exam_delivery.${tableName} table.`,
  );
  assertMatch(
    new RegExp(`alter\\s+table\\s+exam_delivery\\.${tableName}\\s+enable\\s+row\\s+level\\s+security\\s*;`, 'i'),
    `RLS is not enabled on exam_delivery.${tableName}.`,
  );
}

for (const constraintName of expectedConstraints) {
  assertMatch(
    new RegExp(`constraint\\s+${constraintName}\\b`, 'i'),
    `Missing required constraint ${constraintName}.`,
  );
}

for (const indexName of expectedIndexes) {
  assertMatch(
    new RegExp(`create\\s+index\\s+${indexName}\\b`, 'i'),
    `Missing required foreign-key/security-path index ${indexName}.`,
  );
}

assertMatch(
  /revoke\s+all\s+on\s+schema\s+exam_delivery\s+from\s+public,\s*anon,\s*authenticated,\s*service_role\s*;/i,
  'Schema usage/create privileges are not explicitly revoked from browser and service roles.',
);

for (const objectKind of ['tables', 'sequences']) {
  assertMatch(
    new RegExp(`alter\\s+default\\s+privileges\\s+for\\s+role\\s+postgres\\s+in\\s+schema\\s+exam_delivery[\\s\\S]*?revoke\\s+all\\s+on\\s+${objectKind}\\s+from\\s+public,\\s*anon,\\s*authenticated,\\s*service_role\\s*;`, 'i'),
    `Safe default privileges are missing for future ${objectKind}.`,
  );
}

assertMatch(
  /alter\s+default\s+privileges\s+for\s+role\s+postgres\s+in\s+schema\s+exam_delivery[\s\S]*?revoke\s+execute\s+on\s+functions\s+from\s+public,\s*anon,\s*authenticated,\s*service_role\s*;/i,
  'Safe default function privileges are missing.',
);
assertMatch(
  /alter\s+default\s+privileges\s+for\s+role\s+postgres\s+in\s+schema\s+exam_delivery[\s\S]*?revoke\s+usage\s+on\s+types\s+from\s+public,\s*anon,\s*authenticated,\s*service_role\s*;/i,
  'Safe default type privileges are missing.',
);

for (const objectKind of ['tables', 'sequences']) {
  assertMatch(
    new RegExp(`revoke\\s+all\\s+on\\s+all\\s+${objectKind}\\s+in\\s+schema\\s+exam_delivery\\s+from\\s+public,\\s*anon,\\s*authenticated,\\s*service_role\\s*;`, 'i'),
    `Explicit revoke is missing for all existing ${objectKind}.`,
  );
}
assertMatch(
  /revoke\s+execute\s+on\s+all\s+functions\s+in\s+schema\s+exam_delivery\s+from\s+public,\s*anon,\s*authenticated,\s*service_role\s*;/i,
  'Explicit execution revoke is missing for private functions.',
);

if (/\bcreate\s+(?:or\s+replace\s+)?(?:table|view|materialized\s+view|function)\s+public\./i.test(sql)) {
  errors.push('Protected-delivery objects must not be created in public.');
}
if (/^\s*grant\s+all\b/im.test(sql)) {
  errors.push('GRANT ALL is prohibited.');
}
if (/^\s*grant\s+[^;]+\s+to\s+(?:anon|authenticated)\b/im.test(sql)) {
  errors.push('Direct object grants to anon or authenticated are prohibited.');
}
if (/^\s*grant\s+[^;]+\s+to\s+service_role\b/im.test(sql)) {
  errors.push('Phase 17B grants no private-schema privileges to service_role.');
}
if (/\bcreate\s+policy\b/i.test(sql)) {
  errors.push('Phase 17B must remain default-deny and create no RLS policies.');
}
if (/\bauth\.role\s*\(/i.test(sql)) {
  errors.push('auth.role() authorization is prohibited.');
}
if (/\braw_user_meta_data\b/i.test(sql)) {
  errors.push('raw_user_meta_data authorization is prohibited.');
}
if (/\bsecurity\s+definer\b/i.test(sql)) {
  errors.push('No SECURITY DEFINER helper is approved for Phase 17B.');
}

for (const functionName of expectedFunctions) {
  const block = getFunctionBlock(functionName);

  if (!block) {
    errors.push(`Missing internal trigger helper ${functionName}.`);
    continue;
  }
  if (!/security\s+invoker/i.test(block)) {
    errors.push(`${functionName} must be SECURITY INVOKER.`);
  }
  if (!/set\s+search_path\s*=\s*''/i.test(block)) {
    errors.push(`${functionName} must use an empty fixed search_path.`);
  }
  const relationSql = block.replace(/\bdistinct\s+from\b/gi, 'distinct_from');

  if (/\b(?:from|join|update|delete\s+from)\s+(?!exam_delivery\.)[a-z_][a-z0-9_]*/i.test(relationSql)) {
    errors.push(`${functionName} contains an unqualified relation reference.`);
  }
}

const createdFunctions = [
  ...sql.matchAll(/create\s+function\s+exam_delivery\.([a-z0-9_]+)\s*\(/gi),
].map((match) => match[1]);
const unexpectedFunctions = createdFunctions.filter(
  (name) => !expectedFunctions.includes(name),
);

if (unexpectedFunctions.length > 0) {
  errors.push(`Unexpected operational/RPC functions found: ${unexpectedFunctions.join(', ')}.`);
}

for (const operationalName of [
  'create_attempt',
  'save_responses',
  'finalize_attempt',
  'release_review',
  'publish_package',
]) {
  if (createdFunctions.includes(operationalName)) {
    errors.push(`Operational RPC ${operationalName} is prohibited in Phase 17B.`);
  }
}

const packageQuestionBlock = getTableBlock('package_questions');

if (!packageQuestionBlock) {
  errors.push('Cannot verify safe package-question presentation separation.');
} else if (/correct_answer|scoring_payload|review_payload|explanation|remediation|authoring_metadata/i.test(packageQuestionBlock)) {
  errors.push('Safe package_questions contains protected answer/review fields.');
}

const attemptItemBlock = getTableBlock('attempt_items');

if (!attemptItemBlock) {
  errors.push('Cannot verify safe attempt-item presentation separation.');
} else if (/correct_answer|scoring_snapshot|review_snapshot|explanation|remediation/i.test(attemptItemBlock)) {
  errors.push('Safe attempt_items contains protected scoring/review fields.');
}

assertMatch(
  /insert\s+into\s+exam_delivery\.pilot_gates\s*\(\s*exam_key\s*,\s*enabled\s*\)\s*values\s*\(\s*'ai-901'\s*,\s*false\s*\)\s*;/i,
  'The minimal AI-901 gate must be seeded explicitly disabled.',
);

const insertTargets = [
  ...sql.matchAll(/\binsert\s+into\s+([a-z_][a-z0-9_.]*)/gi),
].map((match) => match[1].toLowerCase());

if (insertTargets.some((target) => target !== 'exam_delivery.pilot_gates')) {
  errors.push(`Unexpected seeded data targets: ${insertTargets.join(', ')}.`);
}
if (/insert\s+into\s+exam_delivery\.pilot_access/i.test(sql)) {
  errors.push('The pilot allowlist must begin empty.');
}
if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i.test(sql)) {
  errors.push('The migration must not seed or hardcode a real user UUID.');
}
if (/insert\s+into\s+exam_delivery\.(?:package_|attempt|review_|publication_)/i.test(sql)) {
  errors.push('No package, question, attempt, result, review, or publication data may be seeded.');
}

if (errors.length > 0) {
  console.error('Protected exam-delivery schema validation failed:');
  errors.forEach((error) => console.error(`  - ${error}`));
  process.exit(1);
}

console.log(`PASS Protected exam-delivery schema (${expectedMigrationName})`);
console.log(`  ${expectedTypes.length} enums, ${expectedTables.length} tables, ${expectedFunctions.length} internal trigger helpers`);
console.log('  Static migration validation only; no database or hosted RLS execution was performed.');

function assertMatch(pattern, message) {
  if (!pattern.test(sql)) {
    errors.push(message);
  }
}

function getTableBlock(tableName) {
  const match = sql.match(
    new RegExp(`create\\s+table\\s+exam_delivery\\.${tableName}\\s*\\(([\\s\\S]*?)\\n\\);`, 'i'),
  );

  return match?.[1] ?? '';
}

function getFunctionBlock(functionName) {
  const match = sql.match(
    new RegExp(`create\\s+function\\s+exam_delivery\\.${functionName}\\s*\\([\\s\\S]*?\\$\\$\\s*;`, 'i'),
  );

  return match?.[0] ?? '';
}
