"use strict";

// Validates the engine end-to-end against the LIVE Bybit public API.
// Run: node test/smoke.js  [SYMBOL]
const engine = require("../src/analyze/engine");
const brief = require("../src/format/brief");

(async () => {
	const symbol = (process.argv[2] || "AVAXUSDT").toUpperCase();

	console.log("─── parseSignal ───");
	const parsed = engine.parseSignal(`
		SIGNAL ID: #2161
		COIN: $AVAX/USDT (2-5x)
		Direction: LONG
		ENTRY: 6.700 - 6.750
		TARGETS: 7.050 - 7.350 - 7.750 - 8.250 - 8.750 - 9.250 - 9.850 - 10.500
		STOP LOSS: 6.150
	`);
	console.log(JSON.stringify(parsed));

	console.log(`\n─── snapshot ${symbol} ───`);
	const m = await engine.fetchMarket(symbol);
	console.log(brief.snapshotBrief(m));

	console.log(`\n─── analyze (using parsed signal, symbol ${symbol}) ───`);
	const a = await engine.analyzeSignal({ ...parsed, symbol });
	console.log(brief.analysisBrief(a));
})().catch((e) => { console.error("SMOKE FAILED:", e); process.exit(1); });
