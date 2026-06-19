# signal-cortex

Fresh-data crypto **signal analyzer**. You get a signal (pair + LONG/SHORT +
entry/targets/SL); this service pulls **live Bybit v5 data** and hands the model
a current, structured brief — so analysis is based on *now*, not a stale cached
price.

Built for the mobile workflow: paste a signal to Claude, it calls this service,
fresh numbers come back. Zero-dependency core — deploy is copy-files + `node`.

## Why

A signal that reads "LONG entry 6.70–6.75" looks like a dip-buy. But if the coin
is actually at **6.06 and falling**, it's a +11% breakout chase against a
downtrend. The model can't see that from cached knowledge. This service can:

```
# Signal check — AVAXUSDT LONG (2-5x)
**Now 6.06** · 24h -8.73% · funding -0.0122%/8h · OI 6,021,924
**Setup:** BREAKOUT CHASE — needs a rally to fill
**Trigger:** entry 6.725 is +10.97% from price.
**Trend** — 0 TF with the trade, 4 against:  (15m/1h/4h/1d all DOWN)
**R:R** — 7.05 = 0.57R · 7.35 = 1.09R · ...
**⚠ Flags**
- Entry is +11.0% from price — needs an 11% move before it triggers.
- Fights the trend: 4 timeframes against vs 0 with.
- First target is sub-1R (0.57R).
```

## Quick start

```bash
cp .env.example .env          # set AUTH_TOKEN; Bybit keys optional
node src/index.js             # http on :8090
node test/smoke.js AVAXUSDT   # validate against live Bybit
```

## HTTP API

Market analysis needs **no Bybit key**. Account data needs a **read-only** key.

| Route | What |
|---|---|
| `GET /health` | liveness |
| `GET /snapshot/:symbol` | fresh market snapshot (trend, levels, funding, OI) |
| `GET /analyze?...` | analyze a signal from query params |
| `POST /analyze` | analyze from JSON `{symbol,direction,entry,targets,stopLoss,leverage}` or `{text:"<pasted signal>"}` |
| `POST /parse` | preview how a pasted signal parses |

**Auth:** public market/signal analysis is **open-read** (no token), so URLs
carry no secret and Claude's web fetcher works freely. Only `&account=1` (your
live Bybit position/balance) requires `?key=<AUTH_TOKEN>` or a Bearer header.
Default response is markdown; add `?format=json` for the raw object.

**Mobile-friendly GET** (paste this URL to Claude; it fetches fresh data):

```
https://signals.rc-tron.com/analyze?sym=AVAXUSDT&dir=long&entry=6.70-6.75&tp=7.05,7.35,7.75&sl=6.15&lev=2-5
```

Add `&account=1&key=<AUTH_TOKEN>` to include your live Bybit position/balance.

**Paste a whole signal block:**

```bash
curl -s https://<host>/analyze?key=TOKEN -X POST \
  -H 'Content-Type: text/plain' \
  --data 'COIN: $AVAX/USDT (2-5x)
Direction: LONG
ENTRY: 6.70 - 6.75
TARGETS: 7.05 - 7.35 - 7.75
STOP LOSS: 6.15'
```

## Telegram bot (Phase 3)

Forward (or paste) a signal to your bot → it replies with fresh Bybit analysis.
Zero-dependency long-polling, reuses the engine.

1. Create a bot with **@BotFather**, copy the token.
2. On the box: set `TELEGRAM_BOT_TOKEN` (and optionally `TELEGRAM_ALLOWED_CHATS`) in `.env`.
3. Enable the service:
   ```bash
   sudo cp deploy/signal-cortex-bot.service /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now signal-cortex-bot
   ```
4. DM or forward a signal block to the bot. `/start` prints usage.

## MCP surface (optional, Phase 2)

Exposes the engine as native Claude Code tools (`market_snapshot`,
`analyze_signal`) so the model calls them directly instead of fetching a URL.
The same engine → same fresh data, quality score, account-aware flags.

```bash
npm i                          # installs the optional MCP deps (sdk + zod)
```

Register with Claude Code, either:
- copy [mcp/config.example.json](mcp/config.example.json) → `.mcp.json` at the repo root, or
- `claude mcp add signal-cortex -- node mcp/server.mjs`

The server reads Bybit keys from `.env`, so `analyze_signal` can include your
live position too. Run standalone with `npm run mcp`.

## Deploy (RC-Tron box, 192.168.0.2)

1. Put the repo at `/home/kaspars/signal-cortex`, create `.env`.
2. `sudo cp deploy/signal-cortex.service /etc/systemd/system/ && sudo systemctl enable --now signal-cortex`
3. Add `deploy/Caddyfile.snippet` to `/etc/caddy/Caddyfile` (pick your subdomain on the RC-Tron domain, point DNS at the box), `sudo systemctl reload caddy`.
4. Redeploys: `bash deploy/deploy.sh`.

## Security

- Use a **read-only** Bybit API key — this service never places orders.
- Always set `AUTH_TOKEN` before exposing publicly.
- Not financial advice. The brief is decision *support*; verify before acting.
