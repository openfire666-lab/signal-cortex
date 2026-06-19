"use strict";

// The core: pull FRESH Bybit data and turn a signal into a structured verdict.
// Everything the model needs to judge a signal lives on the returned object.
const ta = require("../indicators/ta");
const pub = require("../bybit/public");
const priv = require("../bybit/private");

const TF = [
	{ key: "15m", interval: "15" },
	{ key: "1h", interval: "60" },
	{ key: "4h", interval: "240" },
	{ key: "1d", interval: "D" },
];

// ── parsing helpers ────────────────────────────────────────────────────────
function nums(s) {
	// No leading minus: prices/leverage are always positive, and "-" is used as a
	// range separator ("6.70-6.75", "2-5x") — a sign here would negate the 2nd value.
	return s == null ? [] : (String(s).match(/\d+(?:\.\d+)?/g) || []).map(Number);
}

function normalizeRange(e) {
	if (e == null) return [NaN, NaN];
	const a = Array.isArray(e) ? e.map(Number) : nums(e);
	if (!a.length) return [NaN, NaN];
	return [Math.min(...a), Math.max(...a)];
}

function normalizeLev(l) {
	if (l == null) return null;
	const a = Array.isArray(l) ? l.map(Number) : nums(l);
	if (!a.length) return null;
	return { min: Math.min(...a), max: Math.max(...a) };
}

function parseKlines(result) {
	// Bybit list is newest-first: [start, open, high, low, close, volume, turnover]
	const rows = (result.list || []).slice().reverse();
	return {
		highs: rows.map((r) => +r[2]),
		lows: rows.map((r) => +r[3]),
		closes: rows.map((r) => +r[4]),
		volumes: rows.map((r) => +r[5]),
	};
}

// Parse a pasted "Binance Killers"-style signal block.
function parseSignal(text) {
	const T = String(text || "");
	const line = (label) => {
		const m = new RegExp(label + "\\s*:?\\s*([^\\n\\r]+)", "i").exec(T);
		return m ? m[1].trim() : null;
	};
	const coinLine = line("COIN") || T;
	const coin = /\$?([A-Za-z0-9]{2,15})\s*\/?\s*(USDT|USDC|USD)?/.exec(coinLine);
	const base = coin ? coin[1].toUpperCase() : null;
	const quote = (coin && coin[2] ? coin[2] : "USDT").toUpperCase();
	const dir = /\b(LONG|SHORT)\b/i.exec(line("Direction") || T);
	const levM = /(\d+)\s*-\s*(\d+)\s*x|(\d+)\s*x/i.exec(coinLine);
	return {
		symbol: base ? base + quote : null,
		direction: dir ? dir[1].toLowerCase() : "long",
		entry: nums(line("ENTRY")),
		targets: nums(line("TARGETS") || line("TARGET")),
		stopLoss: nums(line("STOP\\s*LOSS") || line("SL"))[0] ?? null,
		leverage: levM ? (levM[1] ? [levM[1], levM[2]] : [levM[3]]) : null,
		raw: T,
	};
}

// ── market snapshot (no signal) ────────────────────────────────────────────
function trendOf(k) {
	const { closes, highs, lows } = k;
	const price = closes[closes.length - 1];
	const ema20 = ta.ema(closes, 20);
	const ema50 = ta.ema(closes, 50);
	const ema200 = ta.ema(closes, 200);
	let dir = "neutral";
	if (ema20 && ema50) {
		if (price > ema50 && ema20 > ema50) dir = "up";
		else if (price < ema50 && ema20 < ema50) dir = "down";
	}
	return {
		price, ema20, ema50, ema200,
		rsi: ta.rsi(closes, 14),
		atr: ta.atr(highs, lows, closes, 14),
		macd: ta.macd(closes),
		dir,
	};
}

async function fetchMarket(symbol) {
	const [ticker, ...klineResults] = await Promise.all([
		pub.tickers(symbol),
		...TF.map((t) => pub.kline(symbol, t.interval, 300)),
	]);
	const t0 = (ticker.list && ticker.list[0]) || {};
	const price = +t0.lastPrice;
	const tfs = TF.map((t, i) => ({ key: t.key, ...trendOf(parseKlines(klineResults[i])) }));

	const h4 = parseKlines(klineResults[TF.findIndex((t) => t.key === "4h")]);
	const sw = ta.swings(h4.highs, h4.lows, 3, 3);
	const resistances = [...new Set(sw.swingHighs.filter((v) => v > price))].sort((a, b) => a - b).slice(0, 4);
	const supports = [...new Set(sw.swingLows.filter((v) => v < price))].sort((a, b) => b - a).slice(0, 4);

	return {
		symbol,
		price,
		chg24: t0.price24hPcnt != null ? +t0.price24hPcnt * 100 : null,
		funding: t0.fundingRate != null ? +t0.fundingRate : null,
		oi: t0.openInterest != null ? +t0.openInterest : null,
		high24: t0.highPrice24h != null ? +t0.highPrice24h : null,
		low24: t0.lowPrice24h != null ? +t0.lowPrice24h : null,
		trend: tfs,
		supports,
		resistances,
	};
}

function estimateLiq(entry, lev, dir) {
	if (!lev || !entry) return null;
	const m = 1 / lev;
	return dir === "long" ? entry * (1 - m) : entry * (1 + m);
}

async function maybeAccount(symbol, want) {
	if (!want || !priv.hasKeys()) return null;
	const out = {};
	try {
		const p = await priv.positions(symbol);
		out.positions = (p.list || []).filter((x) => +x.size > 0).map((x) => ({
			side: x.side, size: +x.size, entry: +x.avgPrice,
			leverage: +x.leverage, unrealised: +x.unrealisedPnl, liq: +x.liqPrice,
		}));
	} catch (e) { out.positionsError = e.message; }
	try {
		const w = await priv.walletBalance();
		const acct = (w.list && w.list[0]) || {};
		out.wallet = { equity: +acct.totalEquity, available: +acct.totalAvailableBalance };
	} catch (e) { out.walletError = e.message; }
	return out;
}

// ── full signal analysis ───────────────────────────────────────────────────
async function analyzeSignal(input) {
	const symbol = input.symbol;
	if (!symbol) throw new Error("symbol is required (e.g. AVAXUSDT)");
	const direction = (input.direction || "long").toLowerCase();
	const entry = normalizeRange(input.entry);
	const entryMid = (entry[0] + entry[1]) / 2;
	const targets = (Array.isArray(input.targets) ? input.targets : nums(input.targets)).map(Number);
	const sl = Number(input.stopLoss);
	const lev = normalizeLev(input.leverage);

	const m = await fetchMarket(symbol);
	const price = m.price;

	// entry classification vs live price
	const inZone = price >= entry[0] && price <= entry[1];
	const distPct = ((entryMid - price) / price) * 100;
	let setup;
	if (inZone) setup = "AT MARKET — price is in the entry zone right now";
	else if (direction === "long") setup = entryMid < price
		? "DIP-BUY — needs a pullback to fill"
		: "BREAKOUT CHASE — needs a rally to fill";
	else setup = entryMid > price
		? "FADE — needs a bounce to fill the short"
		: "BREAKDOWN — needs a drop to fill";

	// risk math
	const risk = Math.abs(entryMid - sl);
	const rr = targets.filter((t) => !isNaN(t)).map((tp) => ({
		tp, rr: risk ? +(Math.abs(tp - entryMid) / risk).toFixed(2) : null,
	}));
	const h1 = m.trend.find((t) => t.key === "1h");
	const slAtr = h1 && h1.atr ? +(risk / h1.atr).toFixed(2) : null;
	const liq = estimateLiq(entryMid, lev ? lev.max : null, direction);

	// trend agreement
	const want = direction === "long" ? "up" : "down";
	const agree = m.trend.filter((t) => t.dir === want).length;
	const against = m.trend.filter((t) => t.dir !== "neutral" && t.dir !== want).length;

	// flags — the stuff that quietly sinks a signal
	const flags = [];
	if (!inZone && Math.abs(distPct) > 2) {
		flags.push(`Entry is ${distPct > 0 ? "+" : ""}${distPct.toFixed(1)}% from price — needs a ${Math.abs(distPct).toFixed(1)}% move before it even triggers.`);
	}
	if (against > agree) flags.push(`Fights the trend: ${against} timeframe(s) against the trade vs ${agree} with it.`);
	if (slAtr != null && slAtr < 1) flags.push(`Stop is tight: ${slAtr}× the 1h ATR — easily wicked out by noise.`);
	if (direction === "long" && m.funding != null && m.funding > 0.0005) {
		flags.push(`Funding +${(m.funding * 100).toFixed(4)}% — longs crowded and paying to hold.`);
	}
	if (direction === "short" && m.funding != null && m.funding < -0.0005) {
		flags.push(`Funding ${(m.funding * 100).toFixed(4)}% — shorts crowded and paying to hold.`);
	}
	if (rr.length && rr[0].rr != null && rr[0].rr < 1) {
		flags.push(`First target is sub-1R (${rr[0].rr}R) — poor reward vs the stop.`);
	}

	return {
		symbol, direction, leverage: lev, price,
		chg24: m.chg24, funding: m.funding, oi: m.oi, high24: m.high24, low24: m.low24,
		entry, entryMid, targets, stopLoss: sl,
		inZone, distPct, setup,
		risk, rr, slAtr, liq,
		trend: m.trend.map((t) => ({ key: t.key, dir: t.dir, rsi: t.rsi, ema50: t.ema50, ema200: t.ema200 })),
		agree, against, supports: m.supports, resistances: m.resistances,
		account: await maybeAccount(symbol, input.includeAccount),
		flags,
		fetchedAt: new Date().toISOString(),
	};
}

module.exports = { parseSignal, fetchMarket, analyzeSignal, TF };
