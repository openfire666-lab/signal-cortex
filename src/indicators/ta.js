"use strict";

// Small, dependency-free technical-analysis kit. All inputs are oldest→newest.

function sma(values, period) {
	if (values.length < period) return null;
	let sum = 0;
	for (let i = values.length - period; i < values.length; i++) sum += values[i];
	return sum / period;
}

function emaSeries(values, period) {
	if (values.length < period) return [];
	const k = 2 / (period + 1);
	const out = new Array(values.length).fill(null);
	let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
	out[period - 1] = prev;
	for (let i = period; i < values.length; i++) {
		prev = values[i] * k + prev * (1 - k);
		out[i] = prev;
	}
	return out;
}

function ema(values, period) {
	const s = emaSeries(values, period);
	return s.length ? s[s.length - 1] : null;
}

// Wilder's RSI.
function rsi(closes, period = 14) {
	if (closes.length < period + 1) return null;
	let gain = 0, loss = 0;
	for (let i = 1; i <= period; i++) {
		const d = closes[i] - closes[i - 1];
		if (d >= 0) gain += d; else loss -= d;
	}
	let avgGain = gain / period, avgLoss = loss / period;
	for (let i = period + 1; i < closes.length; i++) {
		const d = closes[i] - closes[i - 1];
		avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
		avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
	}
	if (avgLoss === 0) return 100;
	return 100 - 100 / (1 + avgGain / avgLoss);
}

function macd(closes, fast = 12, slow = 26, signalP = 9) {
	if (closes.length < slow + signalP) return null;
	const fastE = emaSeries(closes, fast);
	const slowE = emaSeries(closes, slow);
	const macdLine = [];
	for (let i = slow - 1; i < closes.length; i++) macdLine.push(fastE[i] - slowE[i]);
	const signalE = emaSeries(macdLine, signalP);
	const macdVal = macdLine[macdLine.length - 1];
	const signalVal = signalE[signalE.length - 1];
	return { macd: macdVal, signal: signalVal, hist: macdVal - signalVal };
}

// Wilder's ATR (absolute price units).
function atr(highs, lows, closes, period = 14) {
	if (closes.length < period + 1) return null;
	const trs = [];
	for (let i = 1; i < closes.length; i++) {
		trs.push(Math.max(
			highs[i] - lows[i],
			Math.abs(highs[i] - closes[i - 1]),
			Math.abs(lows[i] - closes[i - 1]),
		));
	}
	let a = trs.slice(0, period).reduce((x, y) => x + y, 0) / period;
	for (let i = period; i < trs.length; i++) a = (a * (period - 1) + trs[i]) / period;
	return a;
}

// Pivot swing highs/lows. left/right = bars of confirmation either side.
function swings(highs, lows, left = 3, right = 3) {
	const swingHighs = [], swingLows = [];
	for (let i = left; i < highs.length - right; i++) {
		let isHigh = true, isLow = true;
		for (let j = i - left; j <= i + right; j++) {
			if (j === i) continue;
			if (highs[j] >= highs[i]) isHigh = false;
			if (lows[j] <= lows[i]) isLow = false;
		}
		if (isHigh) swingHighs.push(highs[i]);
		if (isLow) swingLows.push(lows[i]);
	}
	return { swingHighs, swingLows };
}

module.exports = { sma, ema, emaSeries, rsi, macd, atr, swings };
