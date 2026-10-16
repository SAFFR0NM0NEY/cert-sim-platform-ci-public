# Issue #201 durable expiry fence v1

Documentation impact: updated. Source only; base `1b4412b10dbda906d4ef3dd5837e3a1e58e15ae3`.
All 94 earlier migrations remain immutable.

Use the existing private PostgreSQL/PostgREST authority, with a separate DBA
default-false fencing gate and separate runtime dispatch/recovery gates.
Only new explicitly fenced dispatches receive permanent version-1 records;
capability issuance, manual Run/Submit and old unfenced records do not change.

Bind dispatch/run, admission epoch, attempt/submission/item/generation, canonical
request/material digests, primary/probe request identities, materialization and
capacity. Purpose/version-bound HMAC uses a distinct expiry-v1 key. Execution
envelopes on this route also use that key: stripping fencing metadata or using
the legacy grade/execute route cannot authenticate the fenced request.

Bridge admission has one durable runner. Each leg has monotonic states:
ready -> intent -> created -> disposed; ready/unused intent may become never.
Intent is a non-expiring outstanding creator, not a lease. Record it before
Sandbox.create; record the returned immutable Sandbox ID before exec. Revocation
closes admission/unused legs but cannot erase intent. A paused creator may
resume into creation while its intent is outstanding; admission stays held.
Once that call settles with an ID, the bridge observes revocation, terminates
the ID, and records disposal instead of executing. A lost creation response
without a known settled ID remains unresolved even if a name lookup says absent.
No lock or transaction spans provider HTTP. No elapsed wait proves closure.

Fencing closure is open -> revoked -> quiescent (normal sealed success may
move directly to quiescent). Durable closed records and append-only events are
never deleted. Duplicate bridge delivery cannot acquire a second runner.
Recovery inspects the held dispatch independently of learner eligibility,
revokes it and terminates only recorded Sandbox IDs. It may release capacity
only with no outstanding intent and both legs disposed or never created.
Release is conditional on the exact held dispatch and epoch. It cannot clear
a newer slot. Recovery calls are bounded, leased for serialization and backed
off 30-300 seconds; lease expiry itself proves nothing about provider state.

Capacity recovery, result recovery and replacement are separate. Receipt loss,
permanent block, five exhausted failures, or terminal attempt status do not
prevent proven capacity recovery. They do not grant automatic regrading or
revive answering/lifecycle. Compatible verified receipts may resume an eligible
job without resetting failures; permanent/exhausted jobs remain blocked.
Old replacement policy/budget remains intact, with an additional quiescence
gate for fenced generations. Capacity recovery without evidence blocks the
original job rather than manufacturing zero or authorizing replacement.

The actual bridge verifies the existing signed evidence and commits a bounded
private receipt before acknowledging success. Replay uses its exact result and
existing evidence persistence, never code execution or score recalculation.
At most two distinct receipts (8 MiB each) retain a first receipt and a conflict;
further distinct receipts fail closed. These private proof payloads use existing
execution-result/evidence custody (including bounded output); recovery metadata
contains no source, grading material or credentials. RLS/revocation denies
browser/service table access. Fixed service-only RPCs own transitions. Private
receipts and signing/service keys are never logged or sent to the learner Sandbox.
No retention/cleanup scheduler or generic unlock/reset API is added.

Modal remains pinned at 0.10.1. Official [named Sandbox documentation](https://modal.com/docs/guide/sandboxes)
says names are reusable after termination and fromName finds only running work;
neither is a tombstone. [SDK release notes](https://modal.com/docs/sdk/js/releases)
distinguish 0.10.1 from 0.11's changed creation backend. Exact installed SDK
source is inspected for create retries, immutable-ID exec, poll and terminate.
Unknown creation/termination/store availability remains blocked. Hosted/runtime/
real-provider acceptance and separately authorized rollout remain required.

Dispatch stays within 145s/90s grading and existing resource/lease/retry limits.
Recovery is a separate action with 35s worker budget and 20s bridge operation
budget; it never starts grading in that invocation. Dispatch disabled permits
only explicitly enabled recovery of an already-issued fenced dispatch.
Missing protocol configuration fails closed. No schedule, backfill, activation,
production access, frontend/reporting or release operation is authorized here.
