# signal-cortex — project rules

Fresh-data crypto signal analyzer. Pulls **live Bybit v5** data and returns a
structured brief so a model analyzes a signal against *now*, not cached prices.
Two surfaces over one engine: HTTP (`src/`) and MCP (`mcp/`).

## Hard rules

- **CommonJS, tabs (4-wide).** Matches the sibling RC-Tron / BeeIn houses.
- **Zero runtime dependencies in the core** (`src/`). The whole point is that
  the box deploy is "copy files + `node src/index.js`" — no fragile `npm install`.
  Only the optional MCP add-on (`mcp/`) may pull deps (`@modelcontextprotocol/sdk`, `zod`).
- **Read-only Bybit keys only.** This service must never place/modify orders.
  Private calls are limited to `position/list` + `wallet-balance`.
- **Secrets** (`.env`) stay in the working tree, git-ignored. Never commit keys.
- Market analysis must work with **no API key** — account data is additive.

## Layout

| Path | Role |
|---|---|
| `src/config.js` | zero-dep `.env` loader + config |
| `src/bybit/public.js` | unsigned v5 market endpoints |
| `src/bybit/private.js` | HMAC-signed read-only account endpoints |
| `src/indicators/ta.js` | EMA / RSI / MACD / ATR / swing pivots |
| `src/analyze/engine.js` | `parseSignal` + `fetchMarket` + `analyzeSignal` (the brain) |
| `src/format/brief.js` | verdict → markdown brief (what the model reads) |
| `src/http/router.js` | tiny node:http router |
| `mcp/server.mjs` | optional MCP tools wrapping the same engine |
| `deploy/` | systemd unit + Caddy snippet + box deploy script |

## Conventions

- Symbols are Bybit format: `AVAXUSDT` (base+quote, no slash).
- Indicator inputs are **oldest→newest**; Bybit klines come newest-first (reversed in `parseKlines`).
- All money/price math in absolute price units; R:R = |target−entry| / |entry−SL|.
- Every brief ends with a "not financial advice" line — keep it.

## Out of scope

- No order placement, no auto-trading. Analysis only.
- Not part of BeeIn or RC-Tron repos; it deploys *alongside* them on the box.
