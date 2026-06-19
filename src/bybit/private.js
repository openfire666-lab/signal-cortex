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

module.exports = {
	hasKeys: () => Boolean(bybit.key && bybit.secret),
	positions: (symbol) =>
		signedGet("/v5/position/list", {
			category: bybit.category,
			...(symbol ? { symbol } : { settleCoin: "USDT" }),
		}),
	walletBalance: (accountType = "UNIFIED") =>
		signedGet("/v5/account/wallet-balance", { accountType }),
};
