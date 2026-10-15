# Python execution orchestration contract

**INTEGRATION IMPLEMENTED — PRODUCTION DISABLED**

Issue #86 R5 and the current-tail integration migration provide durable
server-side state for the approved Modal executor. The path remains disabled
by default and does not publish an executable exam, expose protected grading
material, or authorize production activation.

## Workspace authority

Each workspace belongs to one immutable protected attempt item whose
presentation declares `executable-python-lab-v1`. The existing attempt owner,
account, entitlement, package/profile activation, and continuation lifecycle
remain authoritative.

A save supplies an optimistic revision and stable request ID. The database
canonicalizes a bounded one-to-sixteen-file `.py` workspace, sorts files by
path, computes a SHA-256 hash over the complete source workspace, writes an
immutable revision, and advances the current revision atomically. Repeating
the same logical operation returns its original result; request-ID rebinding
and stale revisions fail with stable conflicts. No owner ID comes from a
learner payload.

## Durable run identity and lifecycle

A future run has two deliberately separate digest bindings. Its orchestration
request digest is an internal deterministic SHA-256 identity over the
attempt/item, exact workspace revision and hash, and stable execution request
ID. Its execution request digest is the R4 SHA-256 digest over the complete
canonical R2 execution request, including all source paths and bodies, entry
point, runtime contract, limits, and request ID. The latter remains null while
the run is only `authorized`; a later trusted materialization step must assign
it before the run can become executable. Both digests are immutable once
assigned, and the orchestration digest can never substitute for the execution
digest in protected grading.

States are finite: `authorized`, `queued`, `running`, `cancel_requested`,
`completed`, `failed`, and `cancelled`. At most one active run may exist for an
item. Terminal result bindings are immutable while disposal may move through
bounded pending, confirmed, and failed reconciliation states.

The protected run endpoint authenticates and authorizes the actor, reads the
current saved workspace, generates the R2 request identity, fixes runtime and
resource limits, signs the canonical request, and idempotently begins one
durable run before transport. A repeated client request returns the original
run without a second provider call. Status and cancel contracts expose run ID,
state, terminal outcome, bounded learner stdout/stderr and exit code,
cancellation time, disposal state, and timestamps; provider identifiers and
internal digests are not client DTO fields.

## Grading replay and scoring boundary

Materialization and evidence records use unique grading-session,
materialization, evidence, and run identities. Composite bindings require the
same canonical R4 execution request digest, terminal result digest,
protected-material digest, grading-contract version, and authorized maximum
raw points. They never use the internal orchestration request digest. Evidence
stores only bounded opaque rule IDs and earned/maximum raw points—never test
source, answers, expected output, rubric text, remediation, signatures, or
keys.

Browsers cannot execute the evidence persistence hook or any grading service
wrapper. The service role can use fixed preparation, materialization, and
evidence wrappers only. At the R4 cryptographic boundary, protected Edge verifies
the R4 HMAC and every binding
field before calling the evidence wrapper; the database then enforces exact
idempotent replay and rejects conflicting reuse. R5 does not duplicate or
weaken R4 HMAC verification.

Python-specific evidence never calculates a final result. The generic CertSim
scorer remains authoritative for raw attempt aggregation, percentages, scaled
score, pass/fail, domain summaries, result persistence, and review release. An
executable item with no saved workspace is intentionally `Unanswered`: it earns
zero, retains its full authoritative maximum in the denominator, and does not
block submit. Once a workspace exists, exact trusted evidence is mandatory;
missing or invalid evidence fails with `grading_incomplete` and never becomes a
silent zero.

Final submission claims one immutable submission ID, freezes each executable
item's current workspace revision and hash, and rejects later workspace
mutation. An exact pre-freeze save retry remains idempotent. A failed or
cancelled terminal grading generation may be retried with a new generation;
verified evidence, result creation, and same-submission retries remain unique.
The generic response hash includes the final workspace revision and hash.

The learner runner separates initial preparation from same-submission
recovery. Initial submission flushes the current Python workspace and ordinary
responses before dispatch. Once dispatch begins, the runner locks editing,
Run, saves, navigation saves, practice checking, and lifecycle actions. The
four bounded grading outcomes `grading_failed`, `grading_incomplete`,
`grading_reconciliation_required`, and `submission_in_progress` retain the
same attempt, authenticated-user, and submission-ID binding and expose an
explicit in-place continuation action. Continuation calls the existing Submit
contract directly; it does not flush or resave work. A separate Check result
action uses only the existing authoritative result endpoint. Exhausted bounded
network, timeout, or generic 5xx result reads retain the locked binding and an
explicit result-check action. They do not independently authorize Submit; an
ambiguous or successful Submit followed by an unavailable lookup is
result-check-only unless a prior four-code grading outcome already established
same-submission retry authority. Meaningful application denials are not made
retryable merely by their HTTP status. All other errors remain fail-closed,
including grading material/binding errors, submission conflict, lifecycle
denial, access denial, result-integrity failure, and exhausted authentication
recovery.

The submission ID remains memory-only. Token refresh preserves it, but a cold
reload, remount, account change, or attempt change cannot derive or replace an
original ID. In-place recovery therefore requires the current runner to remain
mounted. Server-backed cold-remount recovery would require a separately
reviewed contract and is not implied by this client behavior.

## Public service boundary

The separate [Python expiry authority](ISSUE201_PYTHON_EXPIRY_AUTHORITY.md)
defines disabled, future-only trusted preparation and completion. Its
post-deadline sessions use real creation timestamps and remain ineligible for
ordinary learner continuation. The non-executable expiry worker still excludes
Labs. The independent default-disabled
[resumable Python worker](ISSUE201_PYTHON_EXPIRY_WORKER.md) reuses these request,
signing, verification and cancellation helpers, with one generation action per
invocation, a renewable Python-only ownership lease and durable single-dispatch
admission. Ambiguous transport retains admission and blocks replacement.

The existing protected Edge function owns six fixed operations: workspace
read, workspace save, run request, latest current-revision learner run, run
status, and cancel. The latest-run contract excludes submission-grading runs
and returns only the same bounded learner DTO as run status. JWT actor identity
is derived server-side, request keys and byte sizes are allowlisted, database
tables have RLS with no browser policies, and direct table access is revoked.
Only fixed wrappers are executable by the service role.

## Learner workspace integration

R6 renders `executable-python-lab-v1` only from the protected item
presentation DTO. The allowlisted presentation supplies learner-visible task
text, instructions, starter `.py` files, entry point, and allowed filenames;
it supplies no tests, expected output, grading rules, model solution, material
digest, or key.

The browser restores the latest server workspace and then the newest learner
run bound to that exact current revision. An older-revision result is never
shown; saving a newer revision immediately suppresses the prior result until
that revision is run. The UI labels restored output with its revision. The
learner edits one bounded file at a time in a local CodeMirror 6 Python editor
with line numbers, syntax highlighting, active-line and bracket support, and
keyboard indentation. The editor makes no CDN, telemetry, AI, or formatting
request and preserves source text exactly. The browser never stores
source as an ordinary answer response. Source saves use the server revision and a stable
request ID. Navigation, Save & exit, discard
preflight, expiration submission, and final submission flush the current lab
workspace through the same server-authoritative save operation. A revision
conflict preserves local edits while the authoritative server revision is
fetched, then requires an explicit learner recovery choice.

Run first saves any dirty workspace and then requests execution for that exact
revision. While the private feature flag is absent, `executor_disabled` is
shown as availability with no fabricated output. When enabled, the editor is
locked during the bounded synchronous request and the simple console displays
only the learner program's stdout, stderr, outcome, and exit code. Source is
retained on every execution failure. Provider identifiers, internal digests,
and grading feedback are not displayed. Released executable review renders
only question number, generic task label, result state, and earned/maximum
points; it does not render workspace source, a model answer, hidden material,
or an empty “Correct answer” field.

Provider isolation and the one-way trusted-grader boundary have real R8
evidence. The private authoring inventory now compiles all 49 tasks and all 423
rules exactly, including the two resolved TOKEN comment rules. Protected
grading material is carried only in the existing protected scoring snapshot.
The source implements protected materialization, bounded final-submit grading,
R4 verification, trusted R5 evidence persistence, and generic result scoring.
Package publication, database/Edge deployment, production secrets, activation,
student execution, and live acceptance remain separate release gates.
