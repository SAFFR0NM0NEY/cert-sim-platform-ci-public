# Issue #201 resumable Python expiry worker

Implementation decision; base `54a0bf9faf42ce0fc3457b0dc6c3084413c5bb5e`.
Documentation impact: updated. Source only, default disabled; no rollout.

Use a separate internal empty-POST service-authenticated entry point. Runtime
and DBA dispatch gates are independent of enrolment and the non-Python worker.
One invocation performs one generation action, or finishes an evidenced attempt.
Indexed keyset discovery examines at most 64 capability records, with attempt
locks before processing/admission locks. No caller-selected attempt/task IDs.
Each scan cycle freezes its upper deadline, then wraps after exhaustion. New
arrivals cannot indefinitely postpone revisiting locked or deferred older rows.
An empty scan may return idle while advancing/wrapping this durable cursor;
subsequent bounded invocations resume it without a caller selecting an attempt.

The total invocation budget is 145 seconds, including HTTP validation. Database
operations have 4-second transport/3-second worker SQL deadlines. Grading remains
capped at 90 seconds. Reserve
35 seconds for parallel primary/probe cancellation (15 seconds), evidence
persistence and safe return; do not start dispatch without 125 seconds left.
Materialization requires 133 seconds left, allowing two 4-second preflight
operations before that transport threshold. The settled-failure cleanup path
has four database operations plus parallel cancellation: at most 31 seconds
of bounded waits within the 35-second reserve.
All provider calls occur outside SQL transactions. Fixed limits cannot be
expanded by HTTP parameters.

A version-1 Python-only processing lease lasts 30 seconds, renews every 10
seconds, and cannot extend beyond 150 seconds from claim. Renewal requires the
same unexpired token and cannot revive an expired owner. Fencing epochs are
separate from failure counts and task generations. Healthy yields do not use
the foundation's five failure generations. Five genuine recovery failures and
finite backoff block further automatic recovery. No counter reset/decrement.

One durable admission slot permits at most one Python expiry grading dispatch
across overlapping invocations. It survives lease expiry: an unknown provider
execution is not stopped merely because its DB owner expired. A late verified
receipt may be retained against the exact immutable run without giving its
stale sender permission to dispatch, replace or finalize the attempt.

Dispatch uses the existing production request builder, signing and evidence
verifier. Materialization must return claimed:true; claimed:false never sends
another grading request. Replay reconstructs the same digest from frozen input.
Active standalone learner Runs and manual submission generations are deferred
without spending failure retries, rather than cancelled or
silently taken over. Untouched tasks stay unanswered with their full denominator.

Replacement requires a settled original HTTP transport acknowledged by its
still-live original dispatch owner, terminal/confirmed disposal of primary and
probe, no verified evidence, a live current owner and dispatch gates. At most
one worker replacement per frozen task is durable across invocations; inherited
manual history is preserved. Reconciliation and replacement dispatch never
occur in the same invocation.
Only an observed unusable/error response establishes replacement settlement.
A successful response resolves through its verified durable receipt. If SQL
cannot retain that receipt, restart leaves the success recovery-blocked rather
than silently regrading a task whose useful evidence may have been lost.

The existing bridge has no durable anti-replay tombstone or request-fencing
protocol. Cancellation's NotFound response cannot exclude a delayed old grade
request creating a sandbox later. Therefore lost/unknown transports, crashes
between materialization and transport, and ownership loss before transport
settlement remain explicitly recovery-blocked; they cannot release admission
or authorize replacement solely from cancellation. No exactly-once provider
guarantee is claimed. Valid late grading evidence can resolve its own immutable
run; conflicting terminal records are retained for recovery, never overwritten.

Disabling dispatch prevents new grading/replacement; cleanup for a previously
issued dispatch may still reconcile that same run. Abandon/void never revives.
No cron, queue, self-invocation, frontend/reporting change or provider redesign.
Loopback simulated-bridge integration will be reported separately from live
provider availability and classroom-load reliability.
