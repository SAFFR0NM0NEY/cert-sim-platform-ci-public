#!/usr/bin/env bash
set -euo pipefail
# The existing pinned runner retains worker/foundation/manual/Python regressions
# and cleanup. This flag adds only the isolated database authority driver.
export ISSUE201_PYTHON_EXPIRY_TESTS=true
exec bash scripts/run-issue201-worker-disposable.sh
