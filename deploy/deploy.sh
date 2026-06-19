#!/usr/bin/env bash
# Box-side deploy. Run on 192.168.0.2 after pushing to the repo's remote.
set -euo pipefail
cd /home/kaspars/signal-cortex
git pull --ff-only
# Core has no dependencies; only install if the optional MCP add-on is present.
[ -f node_modules/.package-lock.json ] && npm ci --omit=dev || true
sudo systemctl restart signal-cortex
echo "--- status ---"
systemctl --no-pager status signal-cortex | head -n 8
