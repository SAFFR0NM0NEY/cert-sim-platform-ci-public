#!/usr/bin/env bash
set -euo pipefail
npm --prefix services/python-executor-modal ci --ignore-scripts --prefer-offline
npm --prefix services/python-executor-modal test
export ISSUE201_FENCED_PYTHON_TESTS=true
exec bash scripts/run-issue201-resumable-python-disposable.sh
