"use strict";

// One-off end-to-end test: pull recent posts from BK_CHANNEL, find the latest
// parseable signal, analyze it, and push to the bot DM (prefixed 🧪 TEST).
// Confirms read → parse → analyze → DM without waiting for a new post.
//   node bot/userbot-test.js
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { userbot, telegram } = require("../src/config");
const engine = require("../src/analyze/engine");
const brief = require("../src/format/brief");

const BOT_API = `https://api.telegram.org/bot${telegram.token}`;
const plain = (md) => md.replace(/\*\*/g, "").replace(/^#+ /gm, "");

async function notify(text) {
	for (const id of telegram.allowedChats) {
		await fetch(`${BOT_API}/sendMessage`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chat_id: id, text, disable_web_page_preview: true }),
		});
	}
}

(async () => {
	const client = new TelegramClient(new StringSession(userbot.session), userbot.apiId, userbot.apiHash, { connectionRetries: 5 });
	await client.connect();
	await client.getDialogs({ limit: 200 });
	const ch = /^-?\d+$/.test(userbot.channel) ? Number(userbot.channel) : userbot.channel;
	const msgs = await client.getMessages(ch, { limit: 30 });
	console.log(`fetched ${msgs.length} messages from ${userbot.channel}`);

	let found = null;
	for (const m of msgs) {
		const text = (m && (m.message || m.text)) || "";
		const parsed = engine.parseSignal(text);
		if (parsed.symbol) { found = parsed; break; }
	}
	if (!found) {
		console.log("No parseable signal in the last 30 messages.");
		await client.disconnect();
		process.exit(0);
	}

	console.log(`testing signal: ${found.symbol} ${found.direction}`);
	const a = await engine.analyzeSignal({ ...found, includeAccount: telegram.allowedChats.length > 0 });
	await notify(`🧪 TEST (last VIP signal) — ${found.symbol} ${String(found.direction).toUpperCase()}\n\n` + plain(brief.analysisBrief(a)));
	console.log("pushed to bot DM ✓");
	await client.disconnect();
	process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
