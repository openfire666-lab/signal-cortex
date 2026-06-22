"use strict";

// Phase 3 — Telegram bot. Forward/paste a signal → fresh Bybit analysis (quality
// score + your live position). /watch a signal to get pinged at its entry zone.
// Order monitor: pings you when an open Bybit order nears its price or fills.
// Zero-dependency long-polling; reuses the HTTP engine.
const { telegram, monitor } = require("../src/config");
const engine = require("../src/analyze/engine");
const brief = require("../src/format/brief");
const pub = require("../src/bybit/public");
const priv = require("../src/bybit/private");
const store = require("./watches");
const orderState = require("./state");

const API = `https://api.telegram.org/bot${telegram.token}`;
let watches = store.load();
const lastSignal = new Map(); // chatId -> last parsed signal (for /watch)

async function call(method, params) {
	const res = await fetch(`${API}/${method}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(params),
	});
	return res.json();
}

function allowed(chatId) {
	if (!telegram.allowedChats.length) return true; // open if no allowlist set
	return telegram.allowedChats.includes(String(chatId));
}

function plain(md) {
	return md.replace(/\*\*/g, "").replace(/^#+ /gm, "");
}

async function reply(chatId, text) {
	await call("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true });
}

// Account/order alerts go to the allow-listed owner chats (never to randoms).
async function notify(text) {
	for (const id of telegram.allowedChats) await reply(id, text);
}

async function priceOf(sym, cache) {
	if (cache && cache[sym] != null) return cache[sym];
	let p = NaN;
	try { const t = await pub.tickers(sym); p = +(t.list && t.list[0] ? t.list[0].lastPrice : NaN); } catch { /* ignore */ }
	if (cache) cache[sym] = p;
	return p;
}

// ── /watch ──────────────────────────────────────────────────────────────────
function entryOf(s) {
	return (Array.isArray(s.entry) ? s.entry : []).map(Number).filter((n) => !isNaN(n));
}

async function addWatch(chatId) {
	const s = lastSignal.get(chatId);
	if (!s || !s.symbol) return reply(chatId, "Forward or paste a signal first, then send /watch.");
	const entry = entryOf(s);
	if (!entry.length) return reply(chatId, "That signal has no entry zone to watch.");
	if (watches.filter((w) => w.chatId === chatId).length >= 25) {
		return reply(chatId, "Watch limit reached (25). Send /unwatch to clear.");
	}
	watches.push({
		chatId, symbol: s.symbol, direction: s.direction, entry,
		targets: s.targets, stopLoss: s.stopLoss, leverage: s.leverage, created: Date.now(),
	});
	store.save(watches);
	return reply(chatId, `👁 Watching ${s.symbol} ${String(s.direction).toUpperCase()} — I'll ping you when price reaches ${Math.min(...entry)}–${Math.max(...entry)}.`);
}

function listWatches(chatId) {
	const mine = watches.filter((w) => w.chatId === chatId);
	if (!mine.length) return reply(chatId, "No active watches.");
	return reply(chatId, "👁 Watches:\n" +
		mine.map((w, i) => `${i + 1}. ${w.symbol} ${String(w.direction).toUpperCase()} @ ${Math.min(...w.entry)}–${Math.max(...w.entry)}`).join("\n") +
		"\n\nSend /unwatch to clear all.");
}

function clearWatches(chatId) {
	const before = watches.length;
	watches = watches.filter((w) => w.chatId !== chatId);
	store.save(watches);
	return reply(chatId, `Cleared ${before - watches.length} watch(es).`);
}

// ── account commands ─────────────────────────────────────────────────────────
async function showPositions(chatId) {
	if (!priv.hasKeys()) return reply(chatId, "No Bybit key configured.");
	try {
		const r = await priv.positions();
		const ps = (r.list || []).filter((x) => +x.size > 0);
		if (!ps.length) return reply(chatId, "No open positions.");
		const cache = {};
		const lines = await Promise.all(ps.map(async (p) => {
			const price = await priceOf(p.symbol, cache);
			const liq = +p.liqPrice;
			const liqTxt = (price && liq) ? `, liq ${p.liqPrice} (${(Math.abs(price - liq) / price * 100).toFixed(1)}% away)` : `, liq ${p.liqPrice}`;
			return `• ${p.symbol} ${p.side === "Buy" ? "LONG" : "SHORT"} ${p.size} @ ${p.avgPrice} · ${p.leverage}x · uPnL ${p.unrealisedPnl}${liqTxt}`;
		}));
		return reply(chatId, "📊 Positions:\n" + lines.join("\n"));
	} catch (e) { return reply(chatId, `⚠ ${e.message}`); }
}

async function showOrders(chatId) {
	if (!priv.hasKeys()) return reply(chatId, "No Bybit key configured.");
	try {
		const r = await priv.openOrders();
		const os = r.list || [];
		if (!os.length) return reply(chatId, "No open orders.");
		const cache = {};
		const lines = await Promise.all(os.map(async (o) => {
			const price = await priceOf(o.symbol, cache);
			const op = +o.price;
			const dist = (price && op) ? ` · now ${price} (${(Math.abs(price - op) / op * 100).toFixed(2)}% away)` : "";
			return `• ${o.symbol} ${o.side} ${o.qty} @ ${o.price} [${o.orderStatus}]${dist}`;
		}));
		return reply(chatId, "🧾 Open orders:\n" + lines.join("\n"));
	} catch (e) { return reply(chatId, `⚠ ${e.message}`); }
}

// ── message handler ──────────────────────────────────────────────────────────
async function handle(msg) {
	const chatId = msg.chat && msg.chat.id;
	if (!chatId) return;
	const text = msg.text || msg.caption || "";
	console.log(`msg from chat ${chatId} (${msg.chat.username || msg.chat.first_name || "?"})`);

	if (/^\/id\b/.test(text)) {
		return reply(chatId, `chat id: ${chatId}\nAdd it to TELEGRAM_ALLOWED_CHATS to lock the bot to you.`);
	}
	if (!allowed(chatId)) return;

	if (/^\/(start|help)/.test(text)) {
		return reply(chatId,
			"Forward me a signal (COIN / Direction / ENTRY / TARGETS / STOP LOSS) and I'll analyze it " +
			"against fresh Bybit data — quality score + your live position.\n\n" +
			"Commands:\n" +
			"/watch — ping me when the last signal's price reaches its entry zone\n" +
			"/watches · /unwatch — list / clear watches\n" +
			"/pos — your open positions (live PnL, liq distance)\n" +
			"/orders — your resting orders (distance to price)\n\n" +
			"I also auto-ping you when an order nears its price or fills.");
	}
	if (/^\/watches\b/.test(text)) return listWatches(chatId);
	if (/^\/(unwatch|clear)\b/.test(text)) return clearWatches(chatId);
	if (/^\/watch\b/.test(text)) return addWatch(chatId);
	if (/^\/pos\b/.test(text)) return showPositions(chatId);
	if (/^\/orders\b/.test(text)) return showOrders(chatId);

	const parsed = engine.parseSignal(text);
	if (!parsed.symbol) return; // not a signal — stay quiet
	lastSignal.set(chatId, parsed);

	try {
		const includeAccount = telegram.allowedChats.length > 0;
		const a = await engine.analyzeSignal({ ...parsed, includeAccount });
		let out = plain(brief.analysisBrief(a));
		if (!a.inZone) out += "\n\n👁 Send /watch to be pinged when price reaches the entry zone.";
		await reply(chatId, out);
	} catch (e) {
		await reply(chatId, `⚠ ${e.message}`);
	}
}

// ── watch checker — entry-zone alerts for /watch'd signals ────────────────────
async function checkWatches() {
	if (!watches.length) return;
	const keep = [];
	for (const w of watches) {
		try {
			const price = await priceOf(w.symbol);
			if (isNaN(price)) { keep.push(w); continue; }
			const lo = Math.min(...w.entry), hi = Math.max(...w.entry);
			const buf = hi * 0.003;
			if (price >= lo - buf && price <= hi + buf) {
				const a = await engine.analyzeSignal({
					symbol: w.symbol, direction: w.direction, entry: w.entry,
					targets: w.targets, stopLoss: w.stopLoss, leverage: w.leverage,
					includeAccount: telegram.allowedChats.length > 0,
				});
				await reply(w.chatId, `🔔 ENTRY ZONE — ${w.symbol} now ${price}\n\n` + plain(brief.analysisBrief(a)));
			} else {
				keep.push(w);
			}
		} catch (e) {
			keep.push(w);
			console.error("watch:", w.symbol, e.message);
		}
	}
	if (keep.length !== watches.length) { watches = keep; store.save(watches); }
}

// ── order monitor — approach + fill alerts on your real Bybit orders ──────────
async function checkOrders() {
	if (!priv.hasKeys() || !telegram.allowedChats.length) return;
	let open, positions;
	try { open = (await priv.openOrders()).list || []; }
	catch (e) { console.error("openOrders:", e.message); return; }
	try { positions = ((await priv.positions()).list || []).filter((x) => +x.size > 0); }
	catch { positions = []; }

	const st = orderState.load();
	const prev = st.orders || {};
	const cur = {};
	const cache = {};
	const near = new Set(st.near || []);

	for (const o of open) {
		cur[o.orderId] = { symbol: o.symbol, side: o.side, price: +o.price, qty: +o.qty };
		const op = +o.price;
		const price = await priceOf(o.symbol, cache);
		if (op && !isNaN(price)) {
			const dist = Math.abs(price - op) / op * 100;
			if (dist <= monitor.orderNearPct && !near.has(o.orderId)) {
				await notify(`⏳ ${o.symbol} ${o.side} order @ ${op} is close — price ${price} (${dist.toFixed(2)}% away).`);
				near.add(o.orderId);
			}
		}
	}

	// Orders that were open last tick but are gone now → filled or cancelled.
	for (const id of Object.keys(prev)) {
		if (cur[id]) continue;
		const o = prev[id];
		const pos = positions.find((p) => p.symbol === o.symbol);
		if (pos) {
			await notify(`✅ ${o.symbol} ${o.side} order @ ${o.price} is gone — you now hold ${pos.side === "Buy" ? "LONG" : "SHORT"} ${pos.size} @ ${pos.avgPrice} (liq ${pos.liqPrice}). Likely filled.`);
		} else {
			await notify(`✖ ${o.symbol} ${o.side} order @ ${o.price} is no longer resting (cancelled, or filled & already closed).`);
		}
		near.delete(id);
	}

	orderState.save({ orders: cur, near: [...near].filter((id) => cur[id]) });
}

async function main() {
	if (!telegram.token) {
		console.error("TELEGRAM_BOT_TOKEN not set — bot disabled.");
		process.exit(1);
	}
	const me = await call("getMe");
	console.log(`telegram bot polling as @${me.result ? me.result.username : "?"} (${watches.length} watch(es) loaded)`);
	const tick = () => {
		checkWatches().catch((e) => console.error("checkWatches:", e.message));
		checkOrders().catch((e) => console.error("checkOrders:", e.message));
	};
	tick();                         // prime state + immediate near-alerts
	setInterval(tick, 90000);

	let offset = 0;
	for (;;) {
		try {
			const r = await call("getUpdates", { offset, timeout: 30, allowed_updates: ["message"] });
			if (r.ok) {
				for (const u of r.result) {
					offset = u.update_id + 1;
					if (u.message) await handle(u.message).catch((e) => console.error("handle:", e.message));
				}
			}
		} catch (e) {
			console.error("poll:", e.message);
			await new Promise((r) => setTimeout(r, 3000));
		}
	}
}

main();
