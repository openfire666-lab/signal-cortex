"use strict";

// Phase 4 — channel reader (GramJS userbot). Reads new posts in the configured
// channel AS YOU (you're a member), parses signals, analyzes them against fresh
// Bybit data, and pushes the brief to your bot DM. Read-only — never trades.
// Needs: npm install + a TELEGRAM_SESSION from userbot-login.js + BK_CHANNEL.
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const { userbot, telegram } = require("../src/config");
const engine = require("../src/analyze/engine");
const brief = require("../src/format/brief");

const BOT_API = `https://api.telegram.org/bot${telegram.token}`;

function plain(md) {
	return md.replace(/\*\*/g, "").replace(/^#+ /gm, "");
}

async function notify(text) {
	for (const id of telegram.allowedChats) {
		await fetch(`${BOT_API}/sendMessage`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chat_id: id, text, disable_web_page_preview: true }),
		}).catch((e) => console.error("notify:", e.message));
	}
}

async function onMessage(event) {
	const m = event.message;
	const text = (m && (m.message || m.text)) || "";
	if (!text) return;
	const parsed = engine.parseSignal(text);
	if (!parsed.symbol) return; // not a signal — ignore channel chatter
	console.log(`signal from channel: ${parsed.symbol} ${parsed.direction}`);
	try {
		const a = await engine.analyzeSignal({ ...parsed, includeAccount: telegram.allowedChats.length > 0 });
		await notify(`📡 ${userbot.channel || "channel"} — ${parsed.symbol} ${String(parsed.direction).toUpperCase()}\n\n` + plain(brief.analysisBrief(a)));
	} catch (e) {
		await notify(`📡 ${parsed.symbol}: ⚠ ${e.message}`);
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
	// Load dialogs so a private channel (by numeric id, no @username) resolves
	// from cache — GramJS needs the access hash, which dialogs populate.
	try { await client.getDialogs({ limit: 200 }); } catch (e) { console.error("getDialogs:", e.message); }
	const ch = /^-?\d+$/.test(userbot.channel) ? Number(userbot.channel) : userbot.channel;
	const filter = userbot.channel ? { chats: [ch] } : {};
	client.addEventHandler((e) => onMessage(e).catch((err) => console.error("onMessage:", err.message)), new NewMessage(filter));
	console.log(`userbot connected as ${me.username || me.firstName}; reading ${userbot.channel || "ALL chats"} → bot DM`);
})().catch((e) => { console.error(e); process.exit(1); });
