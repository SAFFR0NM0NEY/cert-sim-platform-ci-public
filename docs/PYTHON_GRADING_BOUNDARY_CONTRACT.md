# Python grading boundary contract

**TRUSTED FLOW INTEGRATED — NO PRODUCTION GRADING SERVICE OR EXECUTOR ACTIVE**

This Issue #86 R4 contract defines authenticated structural binding for
protected Python lab grading. The trusted-grading completion work adds a
generic strict grading engine and a private disabled bridge route using only
synthetic application fixtures. It contains no real protected grading
material, persists no production evidence, and does not authorize production
activation.

The governing invariant is:

> LEARNER EXECUTION OUTPUT IS NOT AUTHORITATIVE SCORE.

## Three separate authorities

1. **Hostile learner execution** receives the exact R2 workspace and bounded
   runtime request. It receives no protected material, grading key, CertSim
   identity, or backend credential.
2. **Trusted grading boundary** may consume an exact run binding, a narrowly
   materialized protected input under trusted authority, and the grading key.
   Learner-controlled code cannot read or enumerate that protected input.
3. **CertSim authoritative scoring and persistence** associates authenticated
   raw lab points with an attempt/item and retains ownership of
   finalization, scaled score, pass/fail, domain aggregation, and review
   release. The source path is disabled until separately deployed and
   configured; no browser becomes grading authority.

Running learner code does not make an execution provider a trusted grader.

## Opaque protected-material and request binding

`certsim.python-grading.binding.v1` contains exactly:

- an opaque grading-session ID;
- the opaque R2 request ID;
- `SHA-256(canonical R2 execution request)`;
- an opaque materialization ID;
- a SHA-256 digest of the selected immutable protected material;
- an opaque grading-contract version; and
- the maximum raw points authorized by that material.

The binding contains no material body. R2 canonical request serialization
includes every source path and body, entry point, runtime contract, resource
request, and request ID. File-array order remains non-semantic because R2 sorts
validated files by canonical path.

Changing learner source, a source path, the entry point, a resource ceiling, or
the request ID changes the request digest. A second partial workspace hash is
not permitted.

## Exact execution-result binding

The R2 result contract provides a deterministic canonical representation.
R4 binds:

`executionResultDigest = SHA-256(canonical normalized execution result)`

The digest covers execution ID, status, stdout, stderr, outcome, exit code, and
every diagnostic code/message. Final grading evidence requires a terminal
`finished`, `cancelled`, or `failed` result. Active `accepted` and `running`
results are rejected.

Cancellation or failure does not automatically assign zero points. A later
trusted grading policy may award explicit structural partial credit where
authorized. R4 authenticates that evidence; it does not define failure-score
policy.

## Opaque partial-credit evidence

`certsim.python-grading.evidence.v1` repeats the binding identities/digests and
adds an opaque evidence ID, opaque execution ID, execution-result digest,
earned raw points, maximum raw points, and bounded rule evidence. Each rule
contains only:

- an opaque rule ID;
- earned raw points; and
- maximum raw points.

Rule IDs are unique. Points are bounded non-negative integers, each earned
value cannot exceed its maximum, rule maxima sum to the evidence maximum, rule
earned values sum to the evidence earned value, and the evidence maximum must
equal the binding maximum. Rule order is non-semantic and canonicalization
sorts by opaque rule ID.

No rule text, test source, expected behavior, remediation, answer, rubric, or
solution is part of either contract.

## Authenticated evidence

Evidence uses a deterministic HMAC-SHA-256 envelope with:

- envelope version `certsim.python-grading.evidence-envelope.v1`;
- signature domain `certsim.python-grading.evidence-signature.v1`;
- evidence version and UTF-8 canonical-payload length in the signature frame;
  and
- timing-safe verification after strict envelope validation.

The production grading-evidence key must be distinct from the R2
execution-request key. It exists only inside trusted grading/signing
boundaries. It is never request or workspace data, never visible in the learner
environment, and never emitted through provider logs, stdout, stderr, or
diagnostics. R4 adds no production secret or environment configuration.

Request and grading signatures are separate protocols. Their domains and
envelope versions differ, so one envelope cannot substitute for the other even
when synthetic tests deliberately use identical key bytes.

## Structural verification and limits of proof

`assertAuthenticatedGradingEvidenceForExecution` verifies structurally that:

- the exact R2 request ID and digest match the binding;
- evidence repeats the binding session, request, materialization, material
  digest, grading-contract version, and maximum points;
- the result is terminal and its execution ID and computed digest match;
- rule-point sums and bounds are internally consistent; and
- the evidence signature is valid under the trusted grading key.

Success proves only authenticated structural binding under that key. It does
not prove provider isolation, protected-material secrecy, grading-rule
correctness, runtime enforcement, freshness, or one-time use.

## One-way protected-material visibility

An enabled provider/runtime is eligible for protected executable grading only if
the trusted grader can access narrowly materialized protected input while
learner-controlled code cannot read, enumerate, copy, introspect, import, log,
or exfiltrate it. Protected material must not be written into learner workspace
files or exposed through learner-visible environment, filesystem, process,
network, output, or diagnostics.

If that one-way boundary cannot be demonstrated:

> PROVIDER IS INELIGIBLE FOR PROTECTED GRADING.

The mechanism is provider-dependent. R8.1 selected Modal and supplied
`R8_REAL_PROVIDER_EVIDENCE`; R4 remains provider-neutral verification code.

## Raw output and generic CertSim scoring

Stdout, stderr, process outcome, and exit code are bound inputs, not scoring
rules. Changing any of them changes the result digest and invalidates evidence
for the old result. Only explicit authenticated rule-point evidence contributes
raw trusted lab points.

R4 does not produce a final exam percentage, scaled score, pass/fail decision,
domain aggregate, review snapshot, or released answer. Existing generic
CertSim server authority retains immutable package/attempt snapshots,
scorer-version dispatch, canonical response hashing, result finalization, and
withheld/released review policy.

## Compiled trusted grader

`certsim-python-trusted-grading-v1` uses exact-key, per-family definitions for
nine runtime families and AST, AST-negative, and TOKEN structural families.
Unknown or missing keys, malformed typed observations, duplicate rule IDs,
point-bound violations, and incomplete point totals are rejected. AST and
token evaluation occurs in a trusted Python worker that parses but never
executes learner source.

Runtime expected observations remain in the trusted service. Before the
single per-task probe workspace is sent to the learner Sandbox, expected
observations, opaque rule IDs, and points are stripped. The Sandbox returns
strictly normalized bounded observations; comparison and opaque point
accumulation occur outside it. A timeout, non-terminal result, malformed
observation, or missing probe result is indeterminate and fails closed rather
than silently awarding zero.

## Replay and persistence boundary

R5 durable replay authority gives opaque `gradingSessionId`,
`materializationId`, and `evidenceId` unique storage identities. A
materialization is bound to one run and the canonical R4 execution-request
digest over the complete R2 request, not the orchestration request digest used
for internal run identity. Evidence is bound by composite foreign keys to that
materialization, the same R4 execution-request digest, the exact terminal
result digest, grading-contract version, and maximum raw points. A run,
materialization, grading session, or evidence ID cannot be reused for
conflicting authoritative evidence.

The internal persistence hook accepts only opaque digests and bounded raw/rule
points. It accepts no signature or key and has no browser grant. Fixed
service-role wrappers expose preparation, one-time materialization, and
evidence persistence to protected Edge. Edge verifies R4 before persistence;
the database binds the exact frozen workspace, request/result/material
digests, contract version, and point capacity. Exact retries return the prior
success and conflicting retries fail. Cryptographic validity and durable
uniqueness are complementary: neither substitutes for the other.

A frozen submission remains the sole logical submission across provider
failure. Verified evidence for completed items is reused. A failed or
cancelled generation may be followed by a monotonically numbered generation
for the same item, but an active generation must first be reconciled by
terminating both deterministic provider executions and durably recording its
terminal disposal-confirmed result. Protected Edge permits at most one such
replacement pass in one submit request. Database result uniqueness and the
submission-ID binding prevent duplicate scoring or a duplicate final result.
Ordinary learner submission may not create a new session after natural
expiry, but expiry does not invalidate a session frozen before the deadline.
The separate, default-disabled [Python expiry authority](ISSUE201_PYTHON_EXPIRY_AUTHORITY.md)
permits fixed trusted database operations for explicitly capable future
attempts. It does not extend learner continuation. The separate default-disabled
[resumable Python worker](ISSUE201_PYTHON_EXPIRY_WORKER.md) connects the same
production request builder and R4 verifier to those fixed trusted operations.
Verified receipts may survive owner loss against their immutable run; they give
no stale owner dispatch or finalization authority. Replacement requires settled
transport, confirmed primary/probe disposal and a durable one-replacement budget.

## Submission completeness semantics

The absence of a saved executable workspace is an explicit unanswered state,
not a grading failure. It contributes zero earned points, contributes the
task's full protected `maximumRawPoints` to the denominator, does not increase
`answeredCount`, and does not create a trusted-grading run. The presence of a
saved workspace crosses the grading boundary: submission freezes its exact
revision and hash and requires valid compiled material, a bound trusted run,
verified evidence, and matching point capacity. Any missing or inconsistent
workspace-backed evidence remains `grading_incomplete` or a narrower stable
binding/material error and cannot be converted to zero.

Released executable review is deliberately narrower than ordinary answer
review. It carries the safe presentation plus `Correct`, `Partial`,
`Incorrect`, or `Unanswered` and earned/maximum points. Learner source,
responses, correct/model answers, explanations, remediation, hidden tests,
rules, keys, and internal identifiers are not released by that DTO.

## Phase boundary

R4 remains the digest, signature, and structural verification authority. R5
owns durable workspace, run, evidence, and replay association. All 49 private
tasks and 423 rules compile exactly; the two TOKEN rules require semantic
vocabulary in a real comment immediately before the anchored statement in the
same lexical block. The application source now enforces preparation freeze,
bounded execution, R4 verification, persistence-before-generic-scoring,
fail-closed incomplete evidence, and protected review redaction. Production
deployment, secrets, package publication/activation, student execution, and
live acceptance remain ungranted.
