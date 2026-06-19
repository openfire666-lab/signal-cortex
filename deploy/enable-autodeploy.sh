#!/usr/bin/env bash
# ONE-TIME setup so the box auto-deploys signal-cortex on every git push.
# After this, pushing to origin/main ships to the box within ~2 min — no SSH.
# Run on the box:  cd ~/signal-cortex && bash deploy/enable-autodeploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=$(pwd)

# 1) Passwordless restart for ONLY this one service (mirrors beein-server's rule).
echo "kaspars ALL=(root) NOPASSWD: /usr/bin/systemctl restart signal-cortex" \
	| sudo tee /etc/sudoers.d/signal-cortex >/dev/null
sudo chmod 440 /etc/sudoers.d/signal-cortex
sudo visudo -c -f /etc/sudoers.d/signal-cortex   # validate; fails loudly if wrong

chmod +x deploy/autodeploy-tick.sh

# 2) Cron every 2 minutes (idempotent — replaces any prior entry).
( crontab -l 2>/dev/null | grep -v 'autodeploy-tick.sh' ; \
  echo "*/2 * * * * $REPO/deploy/autodeploy-tick.sh >/dev/null 2>&1" ) | crontab -

echo "✓ auto-deploy enabled — pushes to origin/main ship within ~2 min."
echo "  log:    tail -f $REPO/deploy/autodeploy.log"
echo "  disable: crontab -e  (remove the autodeploy-tick line)"
