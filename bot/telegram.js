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
const alertStore = require("./alerts");
const orderState = require("./state");
const sigStore = require("./signals");

const API = `https://api.telegram.org/bot${telegram.token}`;
let watches = store.load();
let alerts = alertStore.load();
alerts.forEach((a) => { if (!a.id) a.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6); });
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

async function reply(chatId, text, markup) {
	const body = { chat_id: chatId, text, disable_web_page_preview: true };
	if (markup) body.reply_markup = markup;
	await call("sendMessage", body);
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

// ── /alert — price triggers (virtual orders; no funds frozen) ─────────────────
function fmtEntry(e) {
	const a = (e || []).filter((x) => x != null);
	if (!a.length) return "";
	const lo = Math.min(...a), hi = Math.max(...a);
	return lo === hi ? String(lo) : `${lo}-${hi}`;
}

function alertRows(chatId) {
	const mine = alerts.filter((a) => a.chatId === chatId);
	const rows = mine.map((a) => [{ text: `❌ ${a.symbol}${a.side ? " " + a.side.toUpperCase() : ""} @ ${a.target}`, callback_data: `al_rm_${a.id}` }]);
	rows.push([{ text: "➕ New alert", callback_data: "al_add" }]);
	return { mine, rows };
}

function alertMenu(chatId) {
	const { mine, rows } = alertRows(chatId);
	const text = mine.length
		? "📋 Your price alerts — I ping you to place (fill) the order when price hits. No funds frozen. Tap ❌ to remove:"
		: "No price alerts yet. Tap ➕ to add one (e.g. XLMUSDT 0.205 long).";
	return reply(chatId, text, { inline_keyboard: rows });
}

async function createAlert(chatId, argstr) {
	const m = String(argstr).match(/(?:([A-Za-z]{2,15}USDT|[A-Za-z]{2,15})\s+)?(\d*\.?\d+)\s*(long|short)?/i);
	if (!m || !m[2]) return reply(chatId, "Send: SYMBOL PRICE [long|short] — e.g. XLMUSDT 0.205 long");
	let symbol = m[1] ? m[1].toUpperCase() : null;
	const last = lastSignal.get(chatId);
	if (!symbol && last) symbol = last.symbol;
	if (!symbol) return reply(chatId, "Which symbol? e.g. XLMUSDT 0.205");
	if (!/USDT$/.test(symbol)) symbol += "USDT";
	const target = parseFloat(m[2]);
	const side = m[3] ? m[3].toLowerCase() : (last && last.symbol === symbol ? last.direction : null);
	const price = await priceOf(symbol);
	if (isNaN(price)) return reply(chatId, `Couldn't fetch ${symbol} — check the symbol.`);
	if (alerts.filter((a) => a.chatId === chatId).length >= 50) return reply(chatId, "Alert limit reached (50). /unalert to clear.");
	const waitFor = price > target ? "drop" : "rise";
	const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
	alerts.push({ id, chatId, symbol, target, side, waitFor, created: Date.now() });
	alertStore.save(alerts);
	const away = (Math.abs(price - target) / price * 100).toFixed(2);
	return reply(chatId, `📝 Alert set: ${symbol}${side ? " " + side.toUpperCase() : ""} @ ${target} — now ${price} (${away}% away). I'll ping you when it hits. No funds frozen.`);
}

async function onCallback(cb) {
	const chatId = cb.message && cb.message.chat && cb.message.chat.id;
	const mid = cb.message && cb.message.message_id;
	const data = cb.data || "";
	const ack = (text) => call("answerCallbackQuery", { callback_query_id: cb.id, ...(text ? { text } : {}) });
	if (!chatId || !allowed(chatId)) return ack();

	// ➕ New alert → pick a recent OPEN signal (tap-only), or type manually.
	if (data === "al_add") {
		await ack();
		const sigs = sigStore.load();
		const rows = sigs.slice(0, 8).map((s) => [{
			text: `${s.symbol} ${String(s.direction).toUpperCase()}${s.entry && s.entry.length ? " " + fmtEntry(s.entry) : ""}`,
			callback_data: `al_sig_${s.id || s.symbol}`,
		}]);
		rows.push([{ text: "✏️ Type manually", callback_data: "al_man" }]);
		return call("editMessageText", {
			chat_id: chatId, message_id: mid,
			text: sigs.length ? "Pick a recent signal, then a price — or type manually:" : "No recent signals cached yet. Type manually:",
			reply_markup: { inline_keyboard: rows },
		});
	}

	if (data === "al_man") {
		await ack();
		return reply(chatId, "Send: SYMBOL PRICE [long|short]\ne.g.  XLMUSDT 0.205 long", { force_reply: true });
	}

	// Picked a signal → choose a fill price (its entry prices, or custom).
	if (data.startsWith("al_sig_")) {
		await ack();
		const key = data.slice(7);
		const s = sigStore.load().find((x) => (x.id || x.symbol) === key);
		if (!s) return reply(chatId, "That signal expired — type /alert SYMBOL PRICE.");
		const prices = [...new Set((s.entry || []).filter((p) => p != null))];
		const rows = prices.map((p) => [{ text: `@ ${p}`, callback_data: `al_set_${key}_${p}` }]);
		rows.push([{ text: "✏️ Custom price", callback_data: `al_cust_${key}` }]);
		return call("editMessageText", {
			chat_id: chatId, message_id: mid,
			text: `${s.symbol} ${String(s.direction).toUpperCase()} — pick your fill price:`,
			reply_markup: { inline_keyboard: rows },
		});
	}

	// Picked a price → set the alert (symbol + direction from the signal).
	if (data.startsWith("al_set_")) {
		const rest = data.slice(7);
		const u = rest.lastIndexOf("_");
		const key = rest.slice(0, u), price = rest.slice(u + 1);
		const s = sigStore.load().find((x) => (x.id || x.symbol) === key);
		await ack("Setting…");
		if (!s) return reply(chatId, "That signal expired — type /alert SYMBOL PRICE.");
		return createAlert(chatId, `${s.symbol} ${price} ${s.direction}`);
	}

	if (data.startsWith("al_cust_")) {
		await ack();
		const key = data.slice(8);
		const s = sigStore.load().find((x) => (x.id || x.symbol) === key);
		if (!s) return reply(chatId, "That signal expired — type /alert SYMBOL PRICE.");
		return reply(chatId, `Price for ${s.symbol} ${String(s.direction).toUpperCase()}:`, { force_reply: true });
	}

	if (data.startsWith("al_rm_")) {
		const id = data.slice(6);
		const before = alerts.length;
		alerts = alerts.filter((a) => !(a.chatId === chatId && a.id === id));
		if (alerts.length !== before) alertStore.save(alerts);
		await ack("Removed");
		const { mine, rows } = alertRows(chatId);
		return call("editMessageText", {
			chat_id: chatId, message_id: mid,
			text: mine.length ? "📋 Your price alerts. Tap ❌ to remove:" : "No price alerts. Tap ➕ to add one.",
			reply_markup: { inline_keyboard: rows },
		});
	}

	// ✖ Cancel a real Bybit order (needs the Trade permission on the key).
	if (data.startsWith("ocx_")) {
		const orderId = data.slice(4);
		try {
			const r = await priv.openOrders();
			const o = (r.list || []).find((x) => x.orderId === orderId);
			if (!o) { await ack("Already gone"); }
			else { await priv.cancelOrder(o.symbol, orderId); await ack(`Cancelled ${o.symbol}`); }
			const { text, reply_markup } = await buildOrders();
			return call("editMessageText", { chat_id: chatId, message_id: mid, text, reply_markup: reply_markup || undefined });
		} catch (e) {
			await ack("Failed");
			return reply(chatId, `⚠ cancel failed: ${e.message}`);
		}
	}

	return ack();
}

function clearAlerts(chatId) {
	const before = alerts.length;
	alerts = alerts.filter((a) => a.chatId !== chatId);
	alertStore.save(alerts);
	return reply(chatId, `Cleared ${before - alerts.length} alert(s).`);
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

async function buildOrders() {
	const r = await priv.openOrders();
	const os = r.list || [];
	if (!os.length) return { text: "No open orders.", reply_markup: null };
	const cache = {};
	const lines = [];
	const kb = [];
	for (const o of os) {
		const price = await priceOf(o.symbol, cache);
		const op = +o.price;
		const dist = (price && op) ? ` · now ${price} (${(Math.abs(price - op) / op * 100).toFixed(2)}% away)` : "";
		lines.push(`• ${o.symbol} ${o.side} ${o.qty} @ ${o.price} [${o.orderStatus}]${dist}`);
		kb.push([{ text: `✖ Cancel ${o.symbol} ${o.side} @ ${o.price}`, callback_data: `ocx_${o.orderId}` }]);
	}
	return { text: "🧾 Open orders — tap ✖ to cancel (frees the margin):\n" + lines.join("\n"), reply_markup: { inline_keyboard: kb } };
}

async function showOrders(chatId) {
	if (!priv.hasKeys()) return reply(chatId, "No Bybit key configured.");
	try {
		const { text, reply_markup } = await buildOrders();
		return reply(chatId, text, reply_markup || undefined);
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

	// Replies to the alert force-reply prompts → create the alert.
	if (msg.reply_to_message) {
		const rt = msg.reply_to_message.text || "";
		if (/^Send: SYMBOL PRICE/.test(rt)) return createAlert(chatId, text);
		const pm = rt.match(/^Price for ([A-Z0-9]+) (LONG|SHORT)/i);
		if (pm) return createAlert(chatId, `${pm[1]} ${text} ${pm[2]}`);
	}

	if (/^\/(start|help)/.test(text)) {
		return reply(chatId,
			"Forward me a signal (COIN / Direction / ENTRY / TARGETS / STOP LOSS) and I'll analyze it " +
			"against fresh Bybit data — quality score + your live position.\n\n" +
			"Commands:\n" +
			"/watch — ping me when the last signal's price reaches its entry zone\n" +
			"/alert — menu of your price alerts (➕ add / ❌ remove). Or: /alert XLMUSDT 0.205 long\n" +
			"/watches · /unwatch — watches   ·   /unalert — clear alerts\n" +
			"/pos — your open positions (live PnL, liq distance)\n" +
			"/orders — your resting orders (distance to price)\n\n" +
			"I also auto-ping you when an order nears its price or fills.");
	}
	if (/^\/watches\b/.test(text)) return listWatches(chatId);
	if (/^\/(unwatch|clear)\b/.test(text)) return clearWatches(chatId);
	if (/^\/watch\b/.test(text)) return addWatch(chatId);
	if (/^\/alerts\b/.test(text)) return alertMenu(chatId);
	if (/^\/unalert\b/.test(text)) return clearAlerts(chatId);
	if (/^\/alert\b/.test(text)) {
		const rest = text.replace(/^\/alert\s*/i, "").trim();
		return rest ? createAlert(chatId, rest) : alertMenu(chatId);
	}
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

// ── price-alert checker — ping when a target (virtual order) price is reached ──
async function checkAlerts() {
	if (!alerts.length) return;
	const keep = [];
	const cache = {};
	for (const al of alerts) {
		try {
			const price = await priceOf(al.symbol, cache);
			if (isNaN(price)) { keep.push(al); continue; }
			const hit = al.waitFor === "drop" ? price <= al.target : price >= al.target;
			if (!hit) { keep.push(al); continue; }
			let msg = `🔔 ${al.symbol} reached ${al.target} — now ${price}.${al.side ? ` Your ${al.side.toUpperCase()} entry is live.` : ""} Place your order now (no funds were frozen).`;
			try {
				const mk = await engine.fetchMarket(al.symbol);
				msg += `\n24h ${mk.chg24 != null ? (mk.chg24 > 0 ? "+" : "") + mk.chg24.toFixed(2) + "%" : "—"} · funding ${mk.funding != null ? (mk.funding * 100).toFixed(4) + "%" : "—"}`;
			} catch { /* snapshot optional */ }
			const url = `https://www.bybit.com/trade/usdt/${al.symbol}`;
			await reply(al.chatId, msg, { inline_keyboard: [[{ text: `📈 Open ${al.symbol} on Bybit`, url }]] });
		} catch (e) {
			keep.push(al);
			console.error("alert:", al.symbol, e.message);
		}
	}
	if (keep.length !== alerts.length) { alerts = keep; alertStore.save(alerts); }
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
		checkAlerts().catch((e) => console.error("checkAlerts:", e.message));
		checkOrders().catch((e) => console.error("checkOrders:", e.message));
	};
	tick();                         // prime state + immediate near-alerts
	setInterval(tick, 90000);

	let offset = 0;
	for (;;) {
		try {
			const r = await call("getUpdates", { offset, timeout: 30, allowed_updates: ["message", "callback_query"] });
			if (r.ok) {
				for (const u of r.result) {
					offset = u.update_id + 1;
					if (u.message) await handle(u.message).catch((e) => console.error("handle:", e.message));
					else if (u.callback_query) await onCallback(u.callback_query).catch((e) => console.error("callback:", e.message));
				}
			}
		} catch (e) {
			console.error("poll:", e.message);
			await new Promise((r) => setTimeout(r, 3000));
		}
	}
}

main();
