# CertSim production runbook

This is the authoritative production operating contract. It describes gates;
it does not grant permission to mutate production. Every rollout needs explicit
phase authority, an exact reviewed SHA, sanitized evidence, and a stop condition.

## Production authority

- Source authority: private reviewed `main`
- Public URL: `https://certsimplatform.com`
- Cloudflare Pages project: `certsimplatform`
- Protected Edge boundary: `certsim-protected-exam`

A public mirror, feature branch, deployment artifact without provenance, or old
production commit is not source authority.

## Common preflight

Before any rollout, fetch `origin/main`, verify the expected 40-character SHA,
confirm local `main`, confirm `HEAD == origin/main == expected SHA`, and require
a clean worktree. Record current remote state and the approved stop/containment
plan. Stop on drift, unexpected pending work, active-attempt safety conflicts,
or ambiguous state.

Never place credentials or learner/protected payloads in commands, reports, or
screenshots. Browser-safe production configuration contains only expected
public client values; secret-bearing values remain in approved secret stores.

## Protected frontend deployment

Use the guarded wrapper from clean private `main`. Run its non-mutating preflight
first:

```powershell
node scripts/deploy-protected-production.mjs --expected-sha=<reviewed-40-character-sha> --confirm=DEPLOY_PROTECTED_PRODUCTION --check-only
```

The wrapper validates branch, private origin, exact local/remote SHA, clean tree,
browser-safe production environment, and Cloudflare project. Only an explicit
deployment phase may omit `--check-only`:

```powershell
node scripts/deploy-protected-production.mjs --expected-sha=<reviewed-40-character-sha> --confirm=DEPLOY_PROTECTED_PRODUCTION
```

Validate the deployment, canonical domain, source attribution, and protected
custody. A normal push is not a deployment.

## Maintenance deployment

Site-wide maintenance is appropriate when identity/custody, cross-user
visibility, lifecycle ambiguity, incompatible DB/frontend contracts, or
protected backend health makes normal operation unsafe. Build and validate the
maintenance artifact from the current reviewed SHA, then use the manual
Cloudflare workflow with `delivery_mode=maintenance` and that exact SHA. Do not
supply the protected confirmation for maintenance.

After an incompatible database contract advances, never restore an old
protected frontend. Keep current-SHA maintenance active and fix forward to a
compatible reviewed source.

Full-site maintenance is currently a coarse fallback. A future operational
objective is selective feature-level maintenance/kill switches for isolated
failures: Study Sandbox, practice, assignments, an individual exam, PBQ
functionality, or protected delivery. Until separately designed and reviewed,
do not simulate selective containment with ad hoc client logic.

## Database migrations

1. Verify source, linked project, current migration history/hashes, production
   safety state, and compatibility assumptions without mutation.
2. Run the supported linked dry run and capture the exact pending migration set.
3. Require the pending set to equal the approved set; stop on additions,
   omissions, altered history, or hash mismatch.
4. Recheck time-sensitive safety conditions immediately before the push.
5. Apply once in the controlled database phase, then verify history, contract,
   preservation, access isolation, and regression evidence.

Never repair or rewrite production migration history merely to make a push
succeed. If a command times out or returns an ambiguous outcome, determine
whether the migration committed before retrying. Preserve checked-in migration
files and hashes.

## Edge deployment

Deploy `certsim-protected-exam` only from the exact reviewed source in an
explicit Edge phase. Confirm repository configuration retains `verify_jwt=true`.
After deployment, verify the reported function version/status, authenticated
contract behavior, and unauthenticated rejection. Do not treat a successful CLI
upload alone as acceptance.

## Rollback and fix-forward

Choose containment based on compatibility, not convenience. Before an
incompatible DB change, the last reviewed protected artifact may be a valid
rollback candidate. After the boundary advances, use current-SHA maintenance
and a forward correction. Never reintroduce browser-bank delivery, protected
content in the frontend, or an old frontend that cannot honor the current DB
contract.

## Live validation and closure

For `live-validation-required` issues, validate the named behavior at
`https://certsimplatform.com` under the intended role and route. Confirm both
success and relevant rejection/isolation behavior. Jean's browser acceptance is
required before closure; automation does not replace it.

## Incident evidence

Record source SHA, migration/Edge/frontend attribution, commands at a sanitized
level, contract assertions, timestamps where operationally necessary, and
containment decisions. Never include learner identity, learner answers,
commercial question/answer content, database passwords, service-role
credentials, JWT signing secrets, access tokens, or Cloudflare credentials.

## Python expiry fencing rollout boundary

The default-disabled [fencing/recovery protocol](ISSUE201_PYTHON_FENCING_RECOVERY.md)
is source only. Deployment must separately gate database authority, bridge protocol/key
configuration, worker dispatch and cleanup flags, then enabled hosted/provider acceptance.
A held creation intent without conclusive settlement retains global admission. Never
force-clear it, infer containment from a name/lease, or reset an exhausted attempt.
Closed generation records have no deletion policy or cleanup scheduler in this slice.
