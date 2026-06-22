"use strict";

// Bybit v5 PRIVATE endpoints — HMAC-signed. Read-only key is enough.
// Signature: HMAC_SHA256(timestamp + apiKey + recvWindow + queryString, secret)
const crypto = require("crypto");
const { bybit } = require("../config");

function sign(timestamp, payload) {
	const pre = timestamp + bybit.key + bybit.recvWindow + payload;
	return crypto.createHmac("sha256", bybit.secret).update(pre).digest("hex");
}

async function signedGet(pathname, params = {}) {
	if (!bybit.key || !bybit.secret) {
		throw new Error("Bybit API key/secret not configured (set BYBIT_API_KEY / BYBIT_API_SECRET).");
	}
	const qs = new URLSearchParams(params).toString();
	const timestamp = Date.now().toString();
	const url = `${bybit.base}${pathname}${qs ? "?" + qs : ""}`;
	const res = await fetch(url, {
		headers: {
			"X-BAPI-API-KEY": bybit.key,
			"X-BAPI-TIMESTAMP": timestamp,
			"X-BAPI-RECV-WINDOW": bybit.recvWindow,
			"X-BAPI-SIGN": sign(timestamp, qs),
		},
	});
	const json = await res.json();
	if (json.retCode !== 0) {
		throw new Error(`Bybit ${pathname} retCode=${json.retCode} ${json.retMsg}`);
	}
	return json.result;
}

// Signed POST — needs the Unified Trading "Trade" permission. Only used to CANCEL
// resting orders (this service never PLACES orders).
async function signedPost(pathname, body = {}) {
	if (!bybit.key || !bybit.secret) {
		throw new Error("Bybit API key/secret not configured.");
	}
	const json = JSON.stringify(body);
	const timestamp = Date.now().toString();
	const res = await fetch(`${bybit.base}${pathname}`, {
		method: "POST",
		headers: {
			"X-BAPI-API-KEY": bybit.key,
			"X-BAPI-TIMESTAMP": timestamp,
			"X-BAPI-RECV-WINDOW": bybit.recvWindow,
			"X-BAPI-SIGN": sign(timestamp, json),
			"Content-Type": "application/json",
		},
		body: json,
	});
	const j = await res.json();
	if (j.retCode !== 0) {
		throw new Error(`Bybit ${pathname} retCode=${j.retCode} ${j.retMsg}`);
	}
	return j.result;
}

module.exports = {
	hasKeys: () => Boolean(bybit.key && bybit.secret),
	positions: (symbol) =>
		signedGet("/v5/position/list", {
			category: bybit.category,
			...(symbol ? { symbol } : { settleCoin: "USDT" }),
		}),
	// Open (resting/active) orders — needs the "Orders" read permission.
	openOrders: (symbol) =>
		signedGet("/v5/order/realtime", {
			category: bybit.category,
			...(symbol ? { symbol } : { settleCoin: "USDT" }),
		}),
	walletBalance: (accountType = "UNIFIED") =>
		signedGet("/v5/account/wallet-balance", { accountType }),
	// Recent closed trades with realized PnL.
	closedPnl: (limit = 30) =>
		signedGet("/v5/position/closed-pnl", { category: bybit.category, limit }),
	// Cancel one resting order — needs the Trade permission.
	cancelOrder: (symbol, orderId) =>
		signedPost("/v5/order/cancel", { category: bybit.category, symbol, orderId }),
};
