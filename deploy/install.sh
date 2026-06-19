#!/usr/bin/env bash
# First-time box install for signal-cortex. SAFE on the shared box (no pkill;
# Caddyfile is backed up + validated before reload, so a bad edit can't drop
# api.beein.lv). Run on the box:
#   git clone https://github.com/openfire666-lab/signal-cortex.git ~/signal-cortex
#   cd ~/signal-cortex && bash deploy/install.sh
set -euo pipefail
cd "$(dirname "$0")/.."

# 1) .env with a generated AUTH_TOKEN (no Bybit key — market-analysis only for now)
if [ ! -f .env ]; then
	cp .env.example .env
	TK=$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)
	sed -i "s|^AUTH_TOKEN=.*|AUTH_TOKEN=$TK|" .env
	echo "• created .env with a generated AUTH_TOKEN"
fi

# 2) systemd service — patch ExecStart to this box's actual node path
NODE=$(command -v node)
sudo cp deploy/signal-cortex.service /etc/systemd/system/signal-cortex.service
sudo sed -i "s|^ExecStart=.*|ExecStart=$NODE src/index.js|" /etc/systemd/system/signal-cortex.service
sudo systemctl daemon-reload
sudo systemctl enable --now signal-cortex
sleep 1
echo -n "• local health: "; curl -s localhost:8090/health; echo

# 3) Caddy block — box :443 is Cloudflare-only, so this needs a CF Origin cert
#    (see deploy/Caddyfile.snippet). Won't add a cert-less block that can't serve.
CERT=/etc/caddy/certs/rc-tron-cert.pem
KEY=/etc/caddy/certs/rc-tron-key.pem
if grep -q 'signals\.rc-tron\.com' /etc/caddy/Caddyfile; then
	echo "• Caddy already has a signals.rc-tron.com block"
elif [ -f "$CERT" ] && [ -f "$KEY" ]; then
	sudo cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak.$(date +%s)"
	printf '\nsignals.rc-tron.com {\n\ttls %s %s\n\treverse_proxy 127.0.0.1:8090\n}\n' "$CERT" "$KEY" | sudo tee -a /etc/caddy/Caddyfile >/dev/null
	sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && sudo systemctl reload caddy
	echo "• added signals.rc-tron.com Caddy block (CF Origin cert) + reloaded"
else
	echo "!! No Cloudflare Origin cert at $CERT — Caddy block NOT added."
	echo "   1) CF (rc-tron.com) -> SSL/TLS -> Origin Server -> Create Certificate (rc-tron.com, *.rc-tron.com)"
	echo "   2) save cert/key to $CERT and $KEY (chmod 600 the key)"
	echo "   3) add the block from deploy/Caddyfile.snippet, then:"
	echo "      sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && sudo systemctl reload caddy"
	echo "   4) CF DNS: set 'signals' to Proxied (orange cloud); SSL mode = Full (Strict)"
fi

echo
echo "DONE (service on :8090)."
echo "  AUTH_TOKEN: $(grep '^AUTH_TOKEN=' .env | cut -d= -f2-)"
echo "  test:  curl https://signals.rc-tron.com/health"
