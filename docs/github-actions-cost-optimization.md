# GitHub Actions cost and validation routing

CertSim keeps three independently runnable validation families. Pull requests
use path filters to run only families affected by their changes; maintainers can
run any skipped family from the Actions page with `workflow_dispatch` before a
production rollout.

## Trigger matrix

| Change class | Frontend | Database | Edge |
| --- | --- | --- | --- |
| `src/**`, routed browser tests, frontend validators, Vite/build inputs, `package.json` | Yes | No | No |
| `package-lock.json` | Yes | Yes | No |
| Database migrations, pgTAP, DB integration/publication scripts, `supabase/config.toml` | Only when a shared validator/config input applies | Yes | Only `supabase/config.toml` |
| `supabase/functions/certsim-protected-exam/**` or its Edge validator | No | No | Yes |
| Edge disposable-project preparation helper | No | Yes | Yes |
| A workflow file | That workflow | That workflow | That workflow |

`package-lock.json` triggers Database because its Node integration runners use
`@supabase/supabase-js`. A script-only `package.json` change does not alter those
resolved dependencies. Edge uses Deno, direct Node scripts, and the pinned
Supabase CLI; it does not install repository npm dependencies.

## Database isolation

The Database workflow uses one hosted runner but five sequential Supabase
projects: baseline, foundation, operations, publication, and assignment. Each
project is prepared in its own `$RUNNER_TEMP` directory, started separately,
tested against its own migration subset, and stopped before the next starts.
The final cleanup guard attempts to stop every project after success or failure.
This retains database-state isolation while sharing checkout, Node/npm setup,
the pinned Supabase CLI cache, and downloaded Docker images.

## Concurrency

Frontend, Database, and Edge use workflow-specific groups keyed by pull-request
number, falling back to the Git ref for push/manual runs. A newer commit cancels
an older run for the same PR without cancelling a different PR.

## Expected hosted-minute use

The PR #61 baseline was approximately 58 rounded hosted minutes: Frontend 8,
Edge 9, and five Database jobs totalling 41.

| PR type | Before | After (estimate) |
| --- | ---: | ---: |
| Frontend only | 8 jobs / ~58 min | 1 job / ~8 min |
| Edge only | 2 jobs / ~9 min | 2 jobs / ~4–6 min |
| Migration only | 5 jobs / ~41 min | 1 job / ~15–25 min |
| Mixed protected delivery | 8 jobs / ~58 min | 4 jobs / ~27–39 min |
| Three rapid frontend pushes | up to ~24 min | ~8–12 min as superseded runs cancel |

Actual duration varies with runner and container-image cache availability. The
frontend-only reduction target is about 86% (`58` to `8` rounded minutes).

## Manual full gate

Before protected production deployment, manually dispatch all three workflows
at the exact candidate ref:

1. Frontend feature validation
2. Backend exam-delivery database validation
3. Backend exam-delivery Edge validation

Path-filtered PR results are not a substitute for this deliberate full gate.

## Optional self-hosted phase

A future dedicated runner could retain Docker images and the pinned Supabase CLI
between disposable Database and Edge integration runs. It would need isolated
ephemeral work directories, container/resource cleanup, concurrency controls,
regular patching, monitoring, restricted repository access, and protected
secrets. Never execute untrusted public-fork pull-request code on a privileged
self-hosted runner. No runner is registered or enabled by this change.
