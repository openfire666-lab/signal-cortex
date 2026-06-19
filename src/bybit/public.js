"use strict";

// Bybit v5 PUBLIC market endpoints — no API key required.
// Docs: https://bybit-exchange.github.io/docs/v5/market/
const { bybit } = require("../config");

async function get(pathname, params) {
	const qs = new URLSearchParams({ category: bybit.category, ...params }).toString();
	const url = `${bybit.base}${pathname}?${qs}`;
	const res = await fetch(url, { headers: { "Content-Type": "application/json" } });
	const json = await res.json();
	if (json.retCode !== 0) {
		throw new Error(`Bybit ${pathname} retCode=${json.retCode} ${json.retMsg}`);
	}
	return json.result;
}

module.exports = {
	// kline interval: 1 3 5 15 30 60 120 240 360 720 D W M
	tickers: (symbol) => get("/v5/market/tickers", { symbol }),
	kline: (symbol, interval, limit = 200) => get("/v5/market/kline", { symbol, interval, limit }),
	orderbook: (symbol, limit = 50) => get("/v5/market/orderbook", { symbol, limit }),
	openInterest: (symbol, intervalTime = "1h", limit = 24) =>
		get("/v5/market/open-interest", { symbol, intervalTime, limit }),
	fundingHistory: (symbol, limit = 8) => get("/v5/market/funding/history", { symbol, limit }),
	// Long/short account ratio (crowd positioning). period: 5min 15min 30min 1h 4h 1d
	accountRatio: (symbol, period = "1h", limit = 12) =>
		get("/v5/market/account-ratio", { symbol, period, limit }),
};
