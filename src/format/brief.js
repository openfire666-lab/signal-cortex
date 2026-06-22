"use strict";

// Render verdict objects as a dense markdown brief — optimised for a model to
// read and reason over, while still being human-skimmable.
const { trade } = require("../config");

function num(n, d = 4) {
	if (n == null || isNaN(n)) return "—";
	return (+n).toLocaleString("en-US", { maximumFractionDigits: d });
}
function pct(n, d = 2) {
	if (n == null || isNaN(n)) return "—";
	return `${n > 0 ? "+" : ""}${(+n).toFixed(d)}%`;
}
function fund(f) {
	return f == null ? "—" : `${(f * 100).toFixed(4)}%/8h`;
}

function trendRows(trend) {
	return trend.map((t) =>
		`- **${t.key}**: ${String(t.dir).toUpperCase()} · RSI ${t.rsi != null ? t.rsi.toFixed(0) : "—"} · EMA50 ${num(t.ema50)} · EMA200 ${num(t.ema200)}`,
	).join("\n");
}

function snapshotBrief(m) {
	return [
		`# ${m.symbol} — market snapshot`,
		``,
		`**Price ${num(m.price)}** · 24h ${pct(m.chg24)} (H ${num(m.high24)} / L ${num(m.low24)}) · funding ${fund(m.funding)} · OI ${num(m.oi, 0)}`,
		``,
		`**Trend**`,
		trendRows(m.trend),
		``,
		`**Levels (4h swings)** — resistance ${m.resistances.map((x) => num(x)).join(" / ") || "—"} · support ${m.supports.map((x) => num(x)).join(" / ") || "—"}`,
		``,
		`_Fresh from Bybit ${new Date().toISOString()}. Not financial advice._`,
	].join("\n");
}

function accountBlock(acc) {
	if (!acc) return [];
	const L = [`**Your account**`];
	if (acc.positionsError) L.push(`- positions: error (${acc.positionsError})`);
	else if (!acc.positions || !acc.positions.length) L.push(`- no open position on this symbol`);
	else for (const p of acc.positions) {
		L.push(`- ${p.side} ${num(p.size, 4)} @ ${num(p.entry)} · ${p.leverage}x · uPnL ${num(p.unrealised, 2)} · liq ${num(p.liq)}`);
	}
	if (acc.wallet) L.push(`- wallet equity ${num(acc.wallet.equity, 2)} · available ${num(acc.wallet.available, 2)}`);
	L.push("");
	return L;
}

function analysisBrief(a) {
	const lev = a.leverage ? `(${a.leverage.min}-${a.leverage.max}x)` : "";
	const L = [
		`# Signal check — ${a.symbol} ${a.direction.toUpperCase()} ${lev}`.trim(),
		``,
	];
	if (a.score != null) {
		L.push(`**Quality: ${a.score}/100 (${a.scoreLabel})**  —  trend ${a.scoreParts.trend}/35 · R:R ${a.scoreParts.reward}/25 · entry ${a.scoreParts.exec}/20 · funding ${a.scoreParts.funding}/10 · stop ${a.scoreParts.stop}/10`, ``);
	}
	L.push(
		`**Now ${num(a.price)}** · 24h ${pct(a.chg24)} · funding ${fund(a.funding)} · OI ${num(a.oi, 0)}`,
		`**Setup:** ${a.setup}`,
	);
	if (!a.inZone) {
		L.push(`**Trigger:** entry ${num(a.entryMid)} (${num(a.entry[0])}–${num(a.entry[1])}) is ${pct(a.distPct)} from price.`);
	}
	L.push(``, `**Trend** — ${a.agree} TF with the trade, ${a.against} against:`, trendRows(a.trend), ``);
	L.push(`**Levels (4h)** — resistance ${a.resistances.map((x) => num(x)).join(" / ") || "—"} · support ${a.supports.map((x) => num(x)).join(" / ") || "—"}`);
	L.push(``);
	L.push(`**Risk** — SL ${num(a.stopLoss)} = ${num(a.risk)} from entry${a.slAtr != null ? ` (${a.slAtr}× 1h ATR)` : ""}. Liq est ~${num(a.liq)}${a.leverage ? ` @ ${a.leverage.max}x` : ""}.`);
	L.push(`**R:R** — ${a.rr.map((r) => `${num(r.tp)} = ${r.rr != null ? r.rr + "R" : "—"}`).join(" · ") || "—"}`);
	if (a.account && a.account.wallet && a.account.wallet.equity && a.risk) {
		const eq = a.account.wallet.equity;
		const units = (eq * trade.riskPct / 100) / a.risk;
		L.push(`**Size for ${trade.riskPct}% risk** (eq ${num(eq, 2)}) — ~${num(units, 2)} units (~$${num(units * a.entryMid, 2)} notional)`);
	}
	L.push(``);
	L.push(...accountBlock(a.account));
	if (a.flags.length) {
		L.push(`**⚠ Flags**`);
		for (const f of a.flags) L.push(`- ${f}`);
		L.push(``);
	}
	L.push(`_Fresh from Bybit ${a.fetchedAt}. Not financial advice — verify before acting._`);
	return L.join("\n");
}

module.exports = { snapshotBrief, analysisBrief };
