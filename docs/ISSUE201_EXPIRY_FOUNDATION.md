# Issue #201 disabled expiry-finalization database foundation

Source implementation only; not deployed or activated. Relates to #201.
Documentation impact: updated.

This document records the migration-91 foundation boundary. The subsequent
[disabled bounded worker](ISSUE201_EXPIRY_WORKER.md) adds discovery and internal
transport in a separate forward migration; it does not activate this foundation.

Base: `181229f399cd11da6762dc02bd8b48bf5c3b5e3a`. Historical diagnosis:
PR #204, `b5662c6264f584123d2eae41979c6de1fa973af7`,
`docs/ISSUE201_TIMED_EXPIRY_DIAGNOSIS_AND_DESIGN.md`. That diagnosis is retained
unchanged on its reference branch. PRs #205/#206 changed browser recovery and
Edge diagnostics, not the diagnosed SQL lifecycle; those files are untouched.

## Implemented boundary

One forward migration adds private, RLS-protected authority, binding,
processing, and event tables. Authority freezes the attempt's owner, purpose,
deadline, package/profile/form/cycle, runtime/scorer, assignment attribution,
language and configuration, plus its existing continuation/release contract
and immutable profile selection configuration. Authority and submission
bindings are immutable; events append only. Processing state is mutable, with
constrained transitions, 30-second token leases and at most five generations.

Activation is false by default. A DBA-only operation controls enrolment of
future package-v2 timed formal attempts; legacy packages stay non-enrolled.
No enrolment RPC accepts an existing attempt;
no backfill, sweep, worker or schedule exists. Browser/staff roles and service
cannot activate or mutate the private tables. Service can claim, retry and
finalize a fixed enrolled attempt; it cannot supply a score or alter authority.
Synthetic disposable tests alone exercise activation in this phase.

Enrolled operations take the attempt row lock before legacy submission/item
locks and processing locks. The guarded deadline decision uses
`clock_timestamp()` after the row lock: equality is late. Request arrival and
statement/transaction start are not acceptance times. A save accepted before
the deadline retains its lock through commit: if it commits after the deadline,
the waiting finalizer sees and scores that accepted work. Rollback contributes
no work. A save waiting until after the deadline is rejected. Unsent browser
edits cannot be recovered. The actual processing timestamp is separate from
the binding's effective deadline or timely manual freeze instant (timestamptz).

Timely manual preparation binds its existing submission identity. Expiry claim
does not preassign an identity. Finalization reuses a manual binding or creates
one expiry binding under the same lock. Existing compatible results are replayed;
conflicting manual identities fail. Token/generation fencing denies stale
lease holders; interrupted transactions roll back all scoring, review, public
projections and lifecycle changes. Retries reconcile an ambiguous committed
result instead of duplicating it. Completion reason remains manual or expiry.

Non-executable finalization reuses the established migration-61 scoring,
partial-credit, unanswered denominator and compatibility projection rules with
the frozen selection contract. Review release follows the frozen policy. It
does not consult today's profile defaults to reconstruct historical authority.
Lazy formal expiry skips enrolled rows, preserving their pending finalization;
non-enrolled reconciliation and ordinary lifecycle functions retain legacy paths.
Deliberate abandon, void, terminal result and practice-idle semantics remain distinct.

Enrolment uses an initially deferred constraint trigger at creation-transaction
completion. It reads the completed attempt row after the existing normal start
path runs `materialize_attempt_items` and `allocate_canonical_form`; it does not
freeze the INSERT event's incomplete form/cycle. Canonical profiles require a
server-assigned form/cycle and complete item materialization before authority
can commit. The attempt, items, continuation, expiry authority and audit commit
atomically. Form/cycle remain protected by the unchanged identity guard after
freezing; forcing the constraint early fails closed rather than freezing nulls.

Manual executable submission preserves the existing workspace distinction:
untouched tasks use established unanswered-item scoring and its denominator;
saved workspaces require the frozen submission session and correctly bound
verified grading evidence through the existing trusted path. A terminal run
without evidence remains incomplete. An entirely unanswered Lab can submit
without manufacturing grading jobs or evidence; normal preparation retains
its existing submission session. Automatic executable expiry remains
unsupported/pending regardless of saved workspaces; this correction adds no
provider behavior or expiry grading.

## Explicit limits and later gates

Every attempt containing an executable item is unsupported/pending for this
finalizer, even without a saved workspace. This is deliberately narrower than
the proposed design: no provider invocation, no zero-score shortcut, no new
post-expiry session. Existing manual Python sessions and identities are retained.
Python No-Lab qualifies only when its actual items are non-executable. Ordinary
Python grading/recovery remains on the existing trusted path.

The subsequent [Python expiry authority](ISSUE201_PYTHON_EXPIRY_AUTHORITY.md)
adds a separate future-only capability and fixed trusted database operations.
It does not change the worker's executable exclusion or activate either path.

The [disabled resumable Python worker](ISSUE201_PYTHON_EXPIRY_WORKER.md) adds
bounded discovery and trusted transport without changing foundation generation
counters or the non-executable worker. Scheduling, pending UI/history, reporting
queries and rollout remain later slices. Reporting-day
timezone remains undecided; this slice stores only authoritative instants.
No platform timezone is chosen. Activation/deployment require separate review
and production gates; migration alone changes no existing attempt.

## Validation

Run `node scripts/test-issue201-expiry-foundation.mjs` with a disposable
loopback `SUPABASE_DB_URL` and psql. It fails without real PostgreSQL and never
reports skipped integration as passed. Fixtures are synthetic; output contains
only assertion labels/counters, not protected content, workspaces or credentials.
Hosted evidence must replay the full chain with CLI 2.114.0, upgrade from 89
and 90, prove earlier hashes unchanged, and run two-session races, leases,
rollback, security and relevant existing lifecycle/scoring/history regressions.
Evidence is valid only for its exact final private SHA and candidate manifest.
Actual executed results and failed runs belong in the PR evidence report.

The focused source-review test uses normal public database start, save, prepare,
submit and fixed trusted evidence entry points with synthetic fixtures. Hosted
validation replays the hash-verified pre-review migration in an isolated copy
to reproduce both failures, then replays the corrected migration for passing
checks, creation rollback, identity immutability, mixed/untouched Lab scoring,
evidence rejection and the existing foundation/regression suites. The original
90 migrations are never edited. Correction-specific SHAs and execution results
are recorded in PR #207, separately from the pre-review green checkpoint.
