"use strict";

// Phase 3 — Telegram bot. Forward/paste a signal → fresh Bybit analysis (quality
// score + your live position). /watch a signal to get pinged when price reaches
// the entry zone. Zero-dependency long-polling; reuses the HTTP engine.
const { telegram } = require("../src/config");
const engine = require("../src/analyze/engine");
const brief = require("../src/format/brief");
const pub = require("../src/bybit/public");
const store = require("./watches");

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

// Telegram's markdown parsers are brittle — send clean plain text.
function plain(md) {
	return md.replace(/\*\*/g, "").replace(/^#+ /gm, "");
}

async function reply(chatId, text) {
	await call("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true });
}

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

async function handle(msg) {
	const chatId = msg.chat && msg.chat.id;
	if (!chatId) return;
	const text = msg.text || msg.caption || "";
	console.log(`msg from chat ${chatId} (${msg.chat.username || msg.chat.first_name || "?"})`);

	// /id always answers — even if not allow-listed — so you can discover your id.
	if (/^\/id\b/.test(text)) {
		return reply(chatId, `chat id: ${chatId}\nAdd it to TELEGRAM_ALLOWED_CHATS to lock the bot to you.`);
	}

	if (!allowed(chatId)) return;

	if (/^\/(start|help)/.test(text)) {
		return reply(chatId,
			"Forward me a signal (COIN / Direction / ENTRY / TARGETS / STOP LOSS) and I'll analyze it " +
			"against fresh Bybit data — with a quality score and your live position.\n\n" +
			"Commands:\n" +
			"/watch — ping me when the last signal's price reaches its entry zone\n" +
			"/watches — list active watches\n" +
			"/unwatch — clear all watches\n\n" +
			"Quick form:  AVAXUSDT long 6.70-6.75 tp 7.05,7.35 sl 6.15");
	}
	if (/^\/watches\b/.test(text)) return listWatches(chatId);
	if (/^\/(unwatch|clear)\b/.test(text)) return clearWatches(chatId);
	if (/^\/watch\b/.test(text)) return addWatch(chatId);

	const parsed = engine.parseSignal(text);
	if (!parsed.symbol) return; // not a signal — stay quiet
	lastSignal.set(chatId, parsed);

	try {
		// Include live account/position only when the bot is locked to known chats.
		const includeAccount = telegram.allowedChats.length > 0;
		const a = await engine.analyzeSignal({ ...parsed, includeAccount });
		let out = plain(brief.analysisBrief(a));
		if (!a.inZone) out += "\n\n👁 Send /watch to be pinged when price reaches the entry zone.";
		await reply(chatId, out);
	} catch (e) {
		await reply(chatId, `⚠ ${e.message}`);
	}
}

// Every ~90s: check each watch; alert + re-analyze when price reaches its zone.
async function checkWatches() {
	if (!watches.length) return;
	const keep = [];
	for (const w of watches) {
		try {
			const t = await pub.tickers(w.symbol);
			const price = +(t.list && t.list[0] ? t.list[0].lastPrice : NaN);
			if (isNaN(price)) { keep.push(w); continue; }
			const lo = Math.min(...w.entry), hi = Math.max(...w.entry);
			const buf = hi * 0.003; // ~0.3% so a near-miss between checks still fires
			if (price >= lo - buf && price <= hi + buf) {
				const a = await engine.analyzeSignal({
					symbol: w.symbol, direction: w.direction, entry: w.entry,
					targets: w.targets, stopLoss: w.stopLoss, leverage: w.leverage,
					includeAccount: telegram.allowedChats.length > 0,
				});
				await reply(w.chatId, `🔔 ENTRY ZONE — ${w.symbol} now ${price}\n\n` + plain(brief.analysisBrief(a)));
				// one-shot: drop after alerting
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

async function main() {
	if (!telegram.token) {
		console.error("TELEGRAM_BOT_TOKEN not set — bot disabled.");
		process.exit(1);
	}
	const me = await call("getMe");
	console.log(`telegram bot polling as @${me.result ? me.result.username : "?"} (${watches.length} watch(es) loaded)`);
	setInterval(() => checkWatches().catch((e) => console.error("checkWatches:", e.message)), 90000);

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
