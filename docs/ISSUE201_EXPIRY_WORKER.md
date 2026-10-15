# Issue #201 disabled bounded expiry worker

Relates to #201. Base `328c8082b88c281c55dae3b638aadeddf6ae16f3`.
Documentation impact: updated. Source only; no deployment or activation.

The separate worker accepts an empty POST with the trusted service credential
on `apikey`. It compares SHA-256 credential digests without trusting decoded
JWT roles or browser owner privileges. Function-local `verify_jwt=false` permits
this internal arrangement; the existing learner function retains true. See
the official [service authentication convention](https://supabase.com/docs/guides/functions/auth).
The existing legacy service-role credential is used; no credential or dependency
is added. Only bounded counts/outcomes leave the handler, with no result or token logs.

Execution requires both `CERTSIM_EXPIRY_WORKER_ENABLED=true` and a private DBA
database gate, initially false. Missing/invalid configuration fails closed.
Enrolment remains separately disabled. Browser/staff/service roles cannot set
either database gate. There is no cron, self-invocation or deployment hook.

Discovery examines at most 64 indexed immutable authority entries per call,
ordered by deadline and ID with a persisted keyset cursor. Attempt rows are
locked with SKIP LOCKED before processing rows. Decisive deadline, lifecycle,
lease, generation, result and timed-contract checks run under the attempt lock.
Every executable-containing attempt is excluded based on actual frozen items,
including untouched tasks. Cursor advancement skips locked/ineligible records;
a wrap returns empty and the next invocation resumes at the start. Concurrent
cursor writers may revisit rows: attempt locks and leases provide authority.
There is no full attempts scan or backlog aggregate.

An invocation claims at most five items sequentially, immediately before each
finish. Its 110-second budget reserves 31 seconds before another claim:
6 seconds claim transport, 18 finish, 6 reconciliation. SQL statement timeouts
are 5/15/5 seconds with 1-second lock timeouts. Leases remain 30 seconds and
generations capped at five. Each item finishes in its own transaction using
foundation scoring, immutable manual identity and atomic result/review/history
projections. Effective deadline/freeze time remains separate from processing time.

Matching-token reconciliation first recognizes an already committed compatible
result; otherwise it releases only its live claim and defers by
30/60/120/240/300 seconds. Crashes leave leases to expire. Stale workers cannot
release newer claims. Data/contract/integrity errors remain blocked; exhaustion
remains pending, never zero-scored or completed. No immediate same-item retry,
generic repair or abandoned-attempt revival exists.

Shutdown prevents new discovery claims without erasing pending records or
evidence. Already started bounded operations may finish with their existing
token; unfinished claims reconcile or expire. Delivery is retryable with
idempotent completion, not guaranteed exactly-once invocation.

`scripts/run-issue201-worker-disposable.sh` uses a fresh hosted runner and CLI
2.114.0, upgrades 89/90/91, replays 92 migrations, retains foundation and manual
Lab regressions, tests actual Edge/PostgREST transport and cleans up on success
and failure. Synthetic deadlines shorten only at creation; the central test
uses normal start/save and waits for server expiry without learner Submit.

Automatic Python expiry, pending UI/history/reporting, scheduling, reporting
timezone and rollout remain separate. No historical enrolment or production
migration application is authorized by this source PR.
# Python worker boundary

Executable items remain excluded from this worker. The independent, disabled
Python expiry entry point and its durable admission and reconciliation policy
are documented in [ISSUE201_PYTHON_EXPIRY_WORKER.md](ISSUE201_PYTHON_EXPIRY_WORKER.md).
