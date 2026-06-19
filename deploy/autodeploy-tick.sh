#!/usr/bin/env bash
# Cron worker: pull origin/main and restart the service ONLY if it changed.
# Enabled once via enable-autodeploy.sh; after that every `git push` ships here.
set -euo pipefail
cd "$(dirname "$0")/.."

git fetch -q origin main || exit 0   # network blip — try again next tick
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
	git merge --ff-only origin/main
	sudo systemctl restart signal-cortex
	echo "$(date -u +%FT%TZ) deployed $(git rev-parse --short HEAD)" >> deploy/autodeploy.log
fi
