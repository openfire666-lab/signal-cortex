"use strict";

// Phase 4 — channel reader (GramJS userbot). Reads new posts AS YOU, distinguishes
// fresh ENTRY signals from target/stop "summary" updates, keeps a list of OPEN
// signals (for the bot's /alert wizard), and pushes fresh signals to your bot DM.
// Read-only — never trades. Needs npm install + TELEGRAM_SESSION + BK_CHANNEL.
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const { userbot, telegram } = require("../src/config");
const engine = require("../src/analyze/engine");
const brief = require("../src/format/brief");
const sigStore = require("./signals");

const BOT_API = `https://api.telegram.org/bot${telegram.token}`;
let openSignals = sigStore.load();

const plain = (md) => md.replace(/\*\*/g, "").replace(/^#+ /gm, "");

async function notify(text) {
	for (const id of telegram.allowedChats) {
		await fetch(`${BOT_API}/sendMessage`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chat_id: id, text, disable_web_page_preview: true }),
		}).catch((e) => console.error("notify:", e.message));
	}
}

function classify(text) {
	const id = (text.match(/SIGNAL ID:\s*#?(\d+)/i) || [])[1] || null;
	const hasEntry = /ENTRY:\s*[\d.]/i.test(text);
	const isUpdate = /Target\s*\d+\s*:.*✅/i.test(text)
		|| /STOP\s*LOSS:.*(🚫|Loss)/i.test(text)
		|| /\b(Profit|Loss)\s*\(/i.test(text);
	return { id, hasEntry, isUpdate };
}

function addOpen(sig) {
	openSignals = openSignals.filter((s) => s.id !== sig.id && s.symbol !== sig.symbol);
	openSignals.unshift({ ...sig, ts: Date.now() });
	openSignals = openSignals.slice(0, 12);
	sigStore.save(openSignals);
}

function closeOpen(id, symbol) {
	const before = openSignals.length;
	openSignals = openSignals.filter((s) => !((id && s.id === id) || (symbol && s.symbol === symbol)));
	if (openSignals.length !== before) sigStore.save(openSignals);
}

// Process one channel message. doNotify=false during startup backfill.
async function ingest(text, doNotify) {
	if (!text) return;
	const { id, hasEntry, isUpdate } = classify(text);
	const parsed = engine.parseSignal(text);

	if (hasEntry && parsed.symbol) {
		addOpen({ id, symbol: parsed.symbol, direction: parsed.direction, entry: parsed.entry, targets: parsed.targets, sl: parsed.stopLoss });
		if (doNotify) {
			const a = await engine.analyzeSignal({ ...parsed, includeAccount: telegram.allowedChats.length > 0 });
			await notify(`📡 ${userbot.channel || "VIP"} — ${parsed.symbol} ${String(parsed.direction).toUpperCase()}\n\n` + plain(brief.analysisBrief(a)));
		}
		return;
	}

	if (isUpdate && parsed.symbol) {
		closeOpen(id, parsed.symbol);
		if (doNotify) {
			const hits = (text.match(/Target\s*\d+\s*:[^✅]*✅/gi) || []).length;
			const pnl = (text.match(/([\d.]+%\s*(?:Profit|Loss))/i) || [])[1] || "";
			const stopped = /STOP\s*LOSS:.*🚫/i.test(text);
			await notify(`📕 ${parsed.symbol} update — ${stopped ? "stopped out. " : hits ? hits + " target(s) hit. " : ""}${pnl}`.trim());
		}
		return;
	}
}

(async () => {
	if (!userbot.apiId || !userbot.session) {
		console.error("userbot not configured — need TELEGRAM_API_ID/HASH/SESSION (run userbot-login.js).");
		process.exit(1);
	}
	if (!telegram.token || !telegram.allowedChats.length) {
		console.error("Need TELEGRAM_BOT_TOKEN + TELEGRAM_ALLOWED_CHATS to push the analysis to you.");
		process.exit(1);
	}
	const client = new TelegramClient(new StringSession(userbot.session), userbot.apiId, userbot.apiHash, { connectionRetries: 5 });
	await client.connect();
	const me = await client.getMe();
	try { await client.getDialogs({ limit: 200 }); } catch (e) { console.error("getDialogs:", e.message); }
	const ch = /^-?\d+$/.test(userbot.channel) ? Number(userbot.channel) : userbot.channel;

	// Backfill recent open signals (no notify) so the wizard has options at once.
	try {
		const ms = await client.getMessages(ch, { limit: 40 });
		for (const m of ms.slice().reverse()) await ingest((m && m.message) || "", false).catch(() => {});
		console.log(`backfill: ${openSignals.length} open signals`);
	} catch (e) { console.error("backfill:", e.message); }

	const filter = userbot.channel ? { chats: [ch] } : {};
	client.addEventHandler(
		(e) => ingest((e.message && (e.message.message || e.message.text)) || "", true).catch((err) => console.error("ingest:", err.message)),
		new NewMessage(filter),
	);
	console.log(`userbot connected as ${me.username || me.firstName}; reading ${userbot.channel || "ALL chats"} → bot DM`);
})().catch((e) => { console.error(e); process.exit(1); });
