#!/usr/bin/env bash
set -euo pipefail
export ISSUE201_RESUMABLE_PYTHON_TESTS=true
export ISSUE201_PYTHON_EXPIRY_TESTS=true
node --experimental-transform-types scripts/test-issue201-python-worker-unit.mjs
exec bash scripts/run-issue201-worker-disposable.sh
