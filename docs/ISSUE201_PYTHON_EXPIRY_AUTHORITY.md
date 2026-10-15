# Issue #201 Python expiry authority

Relates to #201. Documentation impact: updated.
Base: `ecc2d027773a655dcd75483e3dbfa4a82e7e5293`.
Source implementation and synthetic disposable validation only. No rollout.

## Implementation decision

Use an additional immutable version-1 capability referencing the finalized
migration-91 authority, rather than changing immutable continuation records.
Issue it only from a deferred attempt-creation trigger, after normal canonical
initialization, and only when the independent DBA gate and expiry enrolment
gate are enabled. Neither worker activation nor old enrolment grants it.
There is no existing-attempt enrolment operation or backfill.

Preparation takes the existing attempt lock and validates a current processing
lease. Preserve a timely manual session and its evidence; otherwise allocate
one real post-deadline session with a server-generated submission identity.
Atomically freeze the complete executable inventory, including absent
workspaces, immutable task/material bindings, actual preparation time, and the
separate deadline-effective answer cutoff. Replays read the committed freeze
and never create a replacement execution generation.

Reuse trusted materialization, terminal execution persistence, verified evidence
and generic scoring/projection rules. Keep learner continuation authorization
unchanged: a post-expiry session does not satisfy its pre-expiry-session rule.
No fake timestamps, learner JWT, deadline extension, or caller trusted flag.
The private scorer retains the existing algorithm/projections and uses the
frozen selection authority plus a real clock read after the attempt lock for
processing timestamps. The ordinary manual scorer is unchanged.

The existing worker continues to exclude executable attempts. The SQL lease
is an authority for bounded database calls, not a provider-call time budget.
External execution must happen outside transactions. Later worker integration
must design bounded resource/lease policy before dispatching a 90-second task
or a seven-task submission; ordinary task progress must not consume seven
attempt-level failure generations.

## Interface for later worker integration

Service-only PostgREST operations are `certsim_service_claim_python_expiry`
(fixed attempt), `certsim_service_prepare_python_expiry` (attempt/token),
`certsim_service_read_python_expiry_task` (attempt/token/item/run),
`certsim_service_materialize_python_expiry` (attempt/token/item/run/request
digest), and `certsim_service_complete_python_expiry` (attempt/token).
Anonymous and authenticated callers, including Platform Owner sessions, have
no grant. The service role cannot activate the gate or mutate private tables.

Preparation returns immutable submission/item/run/materialization/grading-session
references, saved revision/hash or explicit unanswered state, material digest,
point capacity, actual preparation time and effective cutoff. These references
survive process restart; they are internal, never learner DTOs. The frozen-task
read returns one saved revision and its attempt-frozen protected grading input,
request identity, persisted resource limits and any already-bound execution
digest. It derives owner/submission authority server-side and validates the
capability, lifecycle, current lease, preparation, item/run association, saved
revision/hash and frozen scoring/material bindings under the attempt lock.
It never reads a current package default or substitutes a newer workspace.
No anonymous, learner, trainer or owner-browser session can use this operation;
the service still has no direct private-table read authority.

The required sequence is claim, prepare, read one frozen task, build the actual
request with `pythonExecutionContract.createRequest`, compute the canonical
`createExecutionRequestDigest`, then materialize with that digest. A workspace
hash or orchestration digest cannot replace the complete request digest.
Reading inputs does not assign a digest, change execution state, create a run,
materialization, result or provider request, renew the lease, or consume a
generation. Materialization remains the separate execution-start claim and
retains immutable digest binding. Its existing payload response is compatible.
Existing fixed terminal/disposal and verified-evidence
operations persist completion. The existing verifier must authenticate evidence
before that persistence hook is called outside synthetic fixtures.

Preparation reports existing evidence as `graded`, absent workspaces as
`unanswered`, and otherwise the actual execution/disposal state. `ready` is a
progress hint; completion independently validates the complete evidence set
and frozen material/capacity. Pending/failed/terminal-without-evidence states
never imply a zero answer. Replayed preparation never replaces a generation,
including terminal generations without evidence. Reconciliation must precede
any future explicit replacement authorization; this interface grants none.

After a process restart before materialization, repeat preparation and frozen
reads and construct the same request from persisted inputs. After a lost
materialization response, exact digest replay returns `claimed: false`.
Running-task reads allow reconstruction and comparison with the stored digest;
they do not authorize redispatch. Reconciliation/replacement policy remains
deferred. Callers must never print private task responses or place them in
learner DTOs, public evidence or diagnostic summaries.

Each mutating bounded call rechecks current lease/token after the shared
attempt lock. `stale_lease` grants no mutation; a later claim preserves the
same freeze and runs. Compatible committed completion replays safely even
after lease expiry. Claims retain the existing five-generation ceiling and
30-second duration. This is not a heartbeat or long-running provider policy.

Run `bash scripts/run-issue201-python-expiry-disposable.sh` on an isolated
runner with the existing CLI 2.114.0 method. It retains earlier regression
suites, full replay and upgrades 89/90/91/92. The synthetic seven-task driver
runs first, then a reset restores pristine disabled state for retained suites.
No PostgreSQL/HTTP test is skipped as passed.

The isolated consumer process receives only the loopback service connection,
attempt reference and lease token. It imports the existing request builder and
canonical digest/material contracts, never fixture state, seed files, DBA
credentials or revoked cores. Distinct saved workspaces/revisions exercise
pre-materialization restart, lost-response replay, running reconstruction,
stored digest equality, immutable binding and no-side-effect reads. The prior
257 assertions remain valid for their original head and fixture scope; this
consumer adds the previously missing request-construction evidence. The
`ISSUE201_FROZEN_REPRO_ONLY=true` harness mode records the missing-input failure
on the unchanged pre-correction migration, without a placeholder digest or a
provider call. It is not a production/provider failure claim.

## Validation interpretation

SQL fixtures prove durable binding, lifecycle and transaction behavior.
Existing verifier tests separately prove signature/envelope validation.
Synthetic evidence persistence is not cryptographic verification and neither
layer proves live provider availability. Real provider calls are excluded.
# Disabled resumable worker follow-on

The separate default-disabled Python worker is specified in
[ISSUE201_PYTHON_EXPIRY_WORKER.md](ISSUE201_PYTHON_EXPIRY_WORKER.md).
Its versioned ownership lease does not change the foundation failure ceiling,
frozen-input read contract, learner authority or non-executable worker.
